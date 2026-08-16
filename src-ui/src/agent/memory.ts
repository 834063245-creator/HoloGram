// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent 持久化记忆系统 — 对标 Claude Code MEMORY.md
// 项目记忆: .hologram/memory/*.md + MEMORY.md 索引
// 全局记忆: ~/.hologram/global_memory/*.md + MEMORY.md 索引
// 跨会话、跨 session tab 共享。全局记忆跨所有项目共享。
//
// 记忆置信度体系 (inspired by 初痕 MemoryDirective):
//   fact       — 用户明确要求，过去的确定结论。仅作提醒，不替代代码和约束决策
//   reference  — Agent 发现或用户提过的参考信息（默认级别）
//   background — 用于调整回复风格和语气，不需要在回复中提及
//   suppressed — 不给 LLM 看到
//   Agent 自己主动存的记忆最高只能给 reference。fact 级别只有用户通过 /remember 明确要求时才能使用。

import { z } from 'zod';
import { typedRpc } from '../rpc-contract';
import { getWorkspaceEpoch, isCurrentEpoch } from '../workspace-scope';
import type { AuraRecord } from './aura-memory';
import { auraCount, auraInit, auraRecall, auraShutdown, auraStore } from './aura-memory';
import type { Tool } from './tool';
import { defineTool } from './tools/define-tool';

// ── Fact 保存授权（自消费哨兵） ──
// /remember 命令设置此标志；下一次 hologram_memory_save 会消费它。
// Agent 无法调用 authorizeFactSave() — 只有 chat.ts 的 /remember 处理器可以。
let _factAuthorized = false;
/** 由 /remember 处理器在发送保存提示给 Agent 之前调用。 */
export function authorizeFactSave(): void {
  _factAuthorized = true;
}
/** 消费授权。每次 /remember 仅返回一次 true。 */
function consumeFactAuthorization(): boolean {
  const was = _factAuthorized;
  _factAuthorized = false;
  return was;
}

// ── 类型 ──

type Confidence = 'fact' | 'reference' | 'background' | 'suppressed';

/** 从 MEMORY.md 索引解析的条目 */
export interface MemoryEntry {
  name: string; // kebab-case slug，如 "user-prefers-concise"
  title: string; // 显示标题，如 "用户偏好简洁回复"
  file: string; // 文件名（含 .md 扩展名）
  description: string; // 索引中的一行摘要
}

/** 完整记忆，含已解析的 frontmatter + 正文 */
export interface MemoryFile {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  confidence: Confidence;
  hit_count: number;
  content: string; // 仅正文（不含 frontmatter）
  raw: string; // 完整文件文本（用于重写时更新元数据）
}

// ── MemoryManager ──

export class MemoryManager {
  private _projectDirReady = false;
  private _globalDirReady = false;
  private _auraReady = false;
  private _auraInitPromise: Promise<void> | null = null;
  private globalDirPath: string | null = null;

  /** 记忆保存后触发（由 workspace 接线 — 扇出到
   *  UI 总线和活跃 Agent 的 notifyMemorySaved）。 */
  onSaved?: (info: { name: string; description?: string; confidence?: string; scope?: string }) => void;

  /** @param projectPath 项目根目录
   *  @param globalPath  全局记忆目录（可选），不传则不启用全局记忆 */
  constructor(
    private projectPath: string,
    globalPath?: string,
  ) {
    this.globalDirPath = globalPath || null;
  }

  /** AuraSDK 语义检索是否已初始化。 */
  get auraReady(): boolean {
    return this._auraReady;
  }

  /** 初始化 AuraSDK 语义检索引擎。
   *  在项目根目录的 .hologram/aura-brain/ 下创建或打开 brain。
   *  可安全多次调用 — 后续调用为空操作。 */
  async initAura(): Promise<void> {
    if (this._auraReady) return;
    if (this._auraInitPromise) return this._auraInitPromise;
    this._auraInitPromise = (async () => {
      try {
        // ponytail: 原生 Aura 是全局单例 — 初始化新 brain 前先关闭旧的（工作区切换）
        try {
          await auraShutdown();
        } catch {
          /* 尚未初始化，无妨 */
        }
        const brainPath = this.projectPath.replace(/\\/g, '/') + '/.hologram/aura-brain';
        // 代际防护：initAura 在途期间可能已切换工作区 —
        // 过期后这个 brain 属于旧项目，初始化结果直接丢弃并关闭，防跨项目串味。
        const epoch = getWorkspaceEpoch();
        const result = await auraInit(brainPath);
        if (!isCurrentEpoch(epoch)) {
          await auraShutdown();
          return;
        }
        this._auraReady = true;
        console.log(`[aura] initialized — ${result.record_count} records at ${result.path}`);
      } catch (e) {
        console.warn('[aura] init failed (semantic recall disabled):', e);
      } finally {
        this._auraInitPromise = null;
      }
    })();
    return this._auraInitPromise;
  }

  /** 对自然语言查询执行 AuraSDK 语义检索。
   *  返回评分记录，过滤掉源记忆已删除的记录。Aura 不可用时优雅降级为空数组。 */
  async auraSemanticRecall(query: string, topK: number = 20): Promise<AuraRecord[]> {
    if (!this._auraReady) return [];
    try {
      const records = await auraRecall(query, topK);
      return await this._filterOrphaned(records);
    } catch (e) {
      console.warn('[aura] recall failed:', e);
      return [];
    }
  }

  /** 发起一次空查询以预加载 SDR 索引到内存。
   *  在启动阶段调用以避免首条用户消息的冷启动延迟。
   *  若 initAura() 仍在进行中则先等待完成，再预热。 */
  prewarmAura(): void {
    this.initAura()
      .then(() => {
        if (this._auraReady) {
          this.auraSemanticRecall('warmup', 1).catch(() => {});
        }
      })
      .catch(() => {});
  }

  /** 过滤掉源记忆文件已不存在的 Aura 记录。
   *  没有 [memory:NAME] 标记的记录（迁移前）予以保留。 */
  private async _filterOrphaned(records: AuraRecord[]): Promise<AuraRecord[]> {
    if (records.length === 0) return records;
    // 收集所有范围内活跃记忆名称（含 .md 扩展名用于直接查找）
    const active = new Set<string>();
    for (const scope of this.scopes()) {
      try {
        const entries = await this.list(scope);
        for (const e of entries) active.add(e.name + '.md');
      } catch {
        /* 范围尚未就绪 */
      }
    }
    if (active.size === 0) return records; // 无法验证，全部保留
    const markerRe = /^\[memory:([^\]]+)\]/;
    return records.filter((r) => {
      const m = r.content.match(markerRe);
      if (!m) return true; // 无标记 → 迁移前记录，保留
      return active.has(m[1] + '.md');
    });
  }

  /** 获取 Aura 记录数量。 */
  async auraRecordCount(): Promise<number> {
    if (!this._auraReady) return 0;
    try {
      return await auraCount();
    } catch {
      return 0;
    }
  }

  private get projectDir(): string {
    return this.projectPath.replace(/\\/g, '/') + '/.hologram/memory';
  }

  /** 解析指定范围的工作目录。 */
  private dirFor(scope: 'project' | 'global'): string {
    if (scope === 'global') {
      if (!this.globalDirPath) throw new Error('全局记忆未启用');
      return this.globalDirPath;
    }
    return this.projectDir;
  }

  /** 返回所有范围（全局优先，若已启用）。 */
  public scopes(): Array<'project' | 'global'> {
    const s: Array<'project' | 'global'> = [];
    if (this.globalDirPath) s.push('global');
    s.push('project');
    return s;
  }

  private indexPath(scope: 'project' | 'global' = 'project'): string {
    return this.dirFor(scope) + '/MEMORY.md';
  }

  private filePath(name: string, scope: 'project' | 'global' = 'project'): string {
    return this.dirFor(scope) + '/' + name + '.md';
  }

  /** 确保读取前 .hologram/memory/ 存在。修复冷启动时
   *  sandbox 拒绝从不存在的父目录读取的问题。 */
  private async ensureDir(scope: 'project' | 'global' = 'project'): Promise<void> {
    if (scope === 'project' && this._projectDirReady) return;
    if (scope === 'global' && this._globalDirReady) return;
    try {
      await typedRpc('create_directory', { path: this.dirFor(scope) });
    } catch {
      // 目录可能已存在或创建不可用 — 安全继续
    }
    if (scope === 'project') this._projectDirReady = true;
    else this._globalDirReady = true;
  }

  // ── Prompt 区段缓存 ──

  private _promptSectionCache: string | null = null;
  private _promptSectionCacheTime = 0;

  // ── 索引 ──

  /** 加载指定范围的 MEMORY.md 原始文本。 */
  async loadIndexText(scope: 'project' | 'global' = 'project'): Promise<string> {
    await this.ensureDir(scope);
    try {
      const numbered = await typedRpc('read_file_content', { file_path: this.indexPath(scope) });
      // read_file_content 返回 cat -n 格式（含行号）；去除行号。
      return numbered.replace(/^\s*\d+\t/gm, '');
    } catch {
      return '';
    }
  }

  /** 将 MEMORY.md 解析为结构化条目（指定范围）。 */
  async list(scope: 'project' | 'global' = 'project'): Promise<MemoryEntry[]> {
    const text = await this.loadIndexText(scope);
    if (!text.trim()) return [];

    const entries: MemoryEntry[] = [];
    const re = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s+[—–-]\s+(.+)$/gm;
    for (const m of text.matchAll(re)) {
      entries.push({
        title: m[1],
        file: m[2],
        name: m[2].replace(/\.md$/, ''),
        description: m[3],
      });
    }
    return entries;
  }

  /** 构建紧凑的索引行（用于添加到 MEMORY.md）。 */
  static formatIndexEntry(entry: MemoryEntry): string {
    return `- [${entry.title}](${entry.file}) — ${entry.description}`;
  }

  // ── 读取 ──

  /** 按名称读取完整记忆文件（不含 .md）。未找到则返回 null。
   *  设置 incrementHit 以追踪回想频率。 */
  async read(name: string, scope: 'project' | 'global' = 'project', incrementHit = false): Promise<MemoryFile | null> {
    await this.ensureDir(scope);
    try {
      const raw = await typedRpc('read_file_content', { file_path: this.filePath(name, scope) });
      const mf = parseFrontmatter(raw);

      if (incrementHit) {
        mf.hit_count = (mf.hit_count || 0) + 1;
        mf.raw = rebuildRaw(mf);
        typedRpc('write_file_content', {
          file_path: this.filePath(name, scope),
          content: mf.raw,
        }).catch((e: unknown) => {
          console.warn(`[memory] hit_count write failed for "${name}":`, e);
        });
      }

      return mf;
    } catch {
      return null;
    }
  }

  // ── Prompt 区段 — 加载到 system prompt ──

  /** 从两个范围加载所有非 suppressed 的记忆并格式化为 system prompt 区段。
   *  全局记忆先加载，项目记忆覆盖（同名时项目优先）。
   *  当记忆数量超过阈值时，应用图感知相关性过滤
   *  只保留最相关的记忆（fact 级别始终包含）。
   *  缓存 5 秒以支持快速会话创建。 */
  async loadPromptSection(graphNodes?: string[]): Promise<string> {
    const now = Date.now();
    if (this._promptSectionCache && now - this._promptSectionCacheTime < 5000) {
      return this._promptSectionCache;
    }

    // 从所有范围收集（全局优先，项目覆盖）。
    // 多条目时使用批量读取以避免 N 次 IPC 往返。
    const allByName = new Map<string, { mf: MemoryFile; scope: string }>();
    for (const scope of this.scopes()) {
      const entries = await this.list(scope);
      if (entries.length === 0) continue;

      // 收集文件路径用于批量读取
      const filePaths = entries.map((e) => this.filePath(e.name, scope));
      let batchResults: Record<string, string | null> = {};

      if (filePaths.length > 1) {
        try {
          const raw = await typedRpc('read_memory_batch', { paths: filePaths });
          batchResults = JSON.parse(raw);
        } catch {
          // 降级为逐个读取
        }
      }

      for (const entry of entries) {
        let mf: MemoryFile | null = null;
        const fp = this.filePath(entry.name, scope);

        if (batchResults[fp] !== undefined) {
          // 使用批量读取结果
          const content = batchResults[fp];
          mf = content !== null ? parseFrontmatter(content) : null;
        } else {
          // 降级为逐个读取
          mf = await this.read(entry.name, scope);
        }

        if (mf && mf.confidence !== 'suppressed') {
          if (!allByName.has(entry.name)) {
            allByName.set(entry.name, { mf, scope });
          }
          // 项目范围覆盖全局（同名）
          if (scope === 'project') {
            allByName.set(entry.name, { mf, scope: 'project' });
          }
        }
      }
    }

    if (allByName.size === 0) {
      const section = '暂无已保存的记忆。用户说"记住..."时保存，说"忘了..."时删除。';
      this._promptSectionCache = section;
      this._promptSectionCacheTime = now;
      return section;
    }

    // ── 图感知相关性过滤 ──
    // 当记忆超过 10 条时，按与当前图节点的相关性排序。
    // fact 级别始终包含；reference/background 竞争剩余名额。
    const MEMORY_LIMIT = 10;
    const allItems = [...allByName.values()];
    const facts = allItems.filter((i) => i.mf.confidence === 'fact');
    const others = allItems.filter((i) => i.mf.confidence !== 'fact');

    let itemsToLoad = allItems;
    if (allItems.length > MEMORY_LIMIT && graphNodes && graphNodes.length > 0) {
      // 对每条非 fact 记忆按与图节点的相关性评分
      const gn = graphNodes ?? [];
      const scored = others.map((item) => ({
        item,
        score: scoreMemoryRelevance(item.mf, gn),
      }));
      scored.sort((a, b) => b.score - a.score);

      // 取前 (MEMORY_LIMIT - facts.length) 条 reference/background + 全部 fact
      const refLimit = Math.max(0, MEMORY_LIMIT - facts.length);
      const topRefs = scored.slice(0, refLimit).map((s) => s.item);
      itemsToLoad = [...facts, ...topRefs];

      // 如果有记忆被过滤掉，记录一下
      const dropped = allItems.length - itemsToLoad.length;
      if (dropped > 0) {
        // ponytail: 静默过滤 — 下方的区段注释已说明
        void dropped;
      }
    }

    // 按置信度分组
    const byConfidence: Record<Confidence, Array<{ mf: MemoryFile; scope: string }>> = {
      fact: [],
      reference: [],
      background: [],
      suppressed: [],
    };

    for (const item of itemsToLoad) {
      const c = item.mf.confidence || 'reference';
      if (c === 'suppressed') continue;
      byConfidence[c].push(item);
    }

    const parts: string[] = [];

    if (itemsToLoad.length < allItems.length && allItems.length > MEMORY_LIMIT) {
      parts.push(`> 📌 记忆库共 ${allItems.length} 条，已按当前图上下文过滤显示 ${itemsToLoad.length} 条最相关的。`);
    }

    if (byConfidence.fact.length > 0) {
      parts.push('### 🔒 铁律 (fact)\n用户明确要求的规则。仅作提醒——Agent 仍需基于代码和约束做决策:\n');
      for (const { mf, scope } of byConfidence.fact) {
        parts.push(formatMemoryLine(mf, scope));
      }
    }

    if (byConfidence.reference.length > 0) {
      parts.push('### 📋 参考 (reference)\nAgent 发现或用户提过的信息。可以参考，引用时带核实语气:\n');
      for (const { mf, scope } of byConfidence.reference) {
        parts.push(formatMemoryLine(mf, scope));
      }
    }

    if (byConfidence.background.length > 0) {
      parts.push('### 🎨 背景 (background)\n用于调整回复风格和语气，不需要在回复中提及:\n');
      for (const { mf, scope } of byConfidence.background) {
        parts.push(formatMemoryLine(mf, scope));
      }
    }

    const section = parts.length > 0 ? parts.join('\n') : '暂无已保存的记忆。';
    this._promptSectionCache = section;
    this._promptSectionCacheTime = now;
    return section;
  }

  // ── 写入 ──

  /** 保存记忆（创建或更新）。同时更新 MEMORY.md 索引。
   *  更新时保留已有的 hit_count。置信度默认为 'reference'。 */
  async save(
    name: string,
    description: string,
    type: 'user' | 'feedback' | 'project' | 'reference',
    content: string,
    confidence: Confidence = 'reference',
    scope: 'project' | 'global' = 'project',
  ): Promise<void> {
    let hitCount = 0;
    const existing = await this.read(name, scope);
    if (existing) {
      hitCount = existing.hit_count || 0;
    }

    const mf: MemoryFile = {
      name,
      description,
      type,
      confidence,
      hit_count: hitCount,
      content,
      raw: '',
    };
    const frontmatter = rebuildRaw(mf);

    await typedRpc('write_file_content', {
      file_path: this.filePath(name, scope),
      content: frontmatter,
    });

    const title = description.length > 40 ? description.slice(0, 39) + '…' : description;
    await this.upsertIndex(title, name + '.md', description, scope);

    // 双写到 AuraSDK 用于语义检索
    if (this._auraReady) {
      const tagList = [type, confidence, scope];
      // ponytail: 以 [memory:NAME] 标记为前缀，使 recall 能检测孤儿记录
      auraStore(`[memory:${name}] ${description}\n\n${content}`, 0, tagList, scope).catch((e: unknown) => {
        console.warn('[aura] dual-write failed:', e);
      });
    }

    this._promptSectionCache = null;
  }

  /** 按名称删除记忆。删除成功返回 true，未找到返回 false。 */
  async delete(name: string, scope: 'project' | 'global' = 'project'): Promise<boolean> {
    let index = await this.loadIndexText(scope);
    if (!index.trim()) return false;

    const pattern = new RegExp(`^\\s*-\\s*\\[[^\\]]*\\]\\(${escapeRegExp(name)}\\.md\\)\\s+[—–-]\\s+.+$\\n?`, 'm');
    if (!pattern.test(index)) return false;

    index = index
      .replace(pattern, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (index) index += '\n';

    await typedRpc('write_file_content', {
      file_path: this.indexPath(scope),
      content: index,
    });

    try {
      await typedRpc('write_file_content', {
        file_path: this.filePath(name, scope),
        content: JSON.stringify({ deleted: true }),
      });
    } catch (e) {
      console.warn(`[memory] failed to delete file for "${name}":`, e);
    }

    this._promptSectionCache = null;
    return true;
  }

  private async upsertIndex(
    title: string,
    file: string,
    description: string,
    scope: 'project' | 'global' = 'project',
  ): Promise<void> {
    let index = await this.loadIndexText(scope);
    const newLine = `- [${title}](${file}) — ${description}`;

    const pattern = new RegExp(
      `^\\s*-\\s*\\[[^\\]]*\\]\\(${escapeRegExp(file.replace(/\.md$/, ''))}\\.md\\)\\s+[—–-]\\s+.+$`,
      'm',
    );
    if (pattern.test(index)) {
      index = index.replace(pattern, newLine);
    } else {
      index = index.trimEnd();
      if (index) index += '\n';
      index += newLine + '\n';
    }

    await typedRpc('write_file_content', {
      file_path: this.indexPath(scope),
      content: index,
    });
  }
}

// ── Frontmatter 解析 ──

function parseFrontmatter(raw: string): MemoryFile {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    return {
      name: 'unknown',
      description: '',
      type: 'reference',
      confidence: 'reference',
      hit_count: 0,
      content: raw,
      raw,
    };
  }

  const fm = fmMatch[1];
  const body = fmMatch[2].trim();

  const name = (fm.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || 'unknown';
  const desc = (fm.match(/^description:\s*(.+)$/m) || [])[1]?.trim() || '';
  // ponytail: 同时接受缩进格式（在 metadata: 下）和顶层格式
  const typeRaw = (fm.match(/^\s*type:\s*(.+)$/m) || [])[1]?.trim() || 'reference';
  const type = (['user', 'feedback', 'project', 'reference'] as const).includes(typeRaw as any)
    ? (typeRaw as MemoryFile['type'])
    : 'reference';
  const confRaw = (fm.match(/^\s*confidence:\s*(.+)$/m) || [])[1]?.trim() || 'reference';
  const confidence = (['fact', 'reference', 'background', 'suppressed'] as const).includes(confRaw as any)
    ? (confRaw as Confidence)
    : 'reference';
  const hitCountRaw = (fm.match(/^\s*hit_count:\s*(\d+)$/m) || [])[1];
  const hit_count = hitCountRaw ? parseInt(hitCountRaw, 10) : 0;

  return { name, description: desc, type, confidence, hit_count, content: body, raw };
}

function rebuildRaw(mf: MemoryFile): string {
  return [
    '---',
    `name: ${mf.name}`,
    `description: ${mf.description}`,
    'metadata:',
    `  type: ${mf.type}`,
    `  confidence: ${mf.confidence}`,
    `  hit_count: ${mf.hit_count}`,
    '---',
    '',
    mf.content,
  ].join('\n');
}

// ── 辅助函数 ──

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function formatMemoryLine(m: MemoryFile, scope?: string): string {
  const body = m.content.length > 120 ? m.content.slice(0, 119) + '…' : m.content;
  const tag = scope === 'global' ? ' [全局]' : '';
  return `- **${m.description}**${tag} — ${body}`;
}

/** 评估记忆与当前图上下文的相关性。
 *  分数越高 = 越可能与用户正在做的事相关。
 *  ponytail: 对图节点名做简单子串匹配 — 无需 LLM 调用。 */
function scoreMemoryRelevance(mf: MemoryFile, graphNodes: string[]): number {
  let score = 0;
  const haystack = (mf.description + ' ' + mf.content + ' ' + mf.name).toLowerCase();

  for (const node of graphNodes) {
    const lower = node.toLowerCase();
    // 节点名精确匹配记忆内容
    if (haystack.includes(lower)) {
      score += 3;
      // 文件名部分匹配（/ 或 \ 后的最后一段）→ 更强信号
      const filePart = lower.split(/[/\\]/).pop() || '';
      if (filePart && filePart !== lower && haystack.includes(filePart)) {
        score += 2;
      }
    } else {
      // 部分词匹配
      const parts = lower.split(/[/\\:.#_-]/);
      for (const part of parts) {
        if (part.length > 2 && haystack.includes(part)) {
          score += 1;
        }
      }
    }
  }

  // 加权: 最近被回想的记忆可能更相关
  score += Math.min(mf.hit_count, 5);

  return score;
}

// ── Agent 工具 ──

/** 创建记忆操作的 Agent 工具。所有工具都基于指定的 MemoryManager。 */
export function createMemoryTools(mm: MemoryManager): Tool[] {
  return [
    defineTool({
      name: 'hologram_memory_list',
      description:
        '列出所有已保存的记忆及其置信度和所属范围（项目/全局）。保存新记忆前，先调用此工具检查是否已有类似记忆——已有则用 hologram_memory_save 更新而非新建。',
      schema: z.object({}),
      readOnly: true,
      execute: async () => {
        const sections: string[] = [];
        // 先显示全局，再显示项目
        const allScopes = mm.scopes?.() || ['project'];
        for (const scope of allScopes) {
          const entries = await mm.list(scope);
          if (entries.length === 0) continue;
          const label = scope === 'global' ? '🌐 全局记忆' : '📁 项目记忆';
          sections.push(`### ${label}`);
          for (const e of entries) {
            const mf = await mm.read(e.name, scope);
            const conf = mf?.confidence || 'reference';
            const confTag = { fact: '[fact]', reference: '[ref]', background: '[bg]', suppressed: '[sup]' }[conf];
            const hit = mf?.hit_count ? ` · 回想${mf.hit_count}次` : '';
            sections.push(`- ${confTag} **${e.title}** (\`${e.name}\`)${hit} — ${e.description}`);
          }
        }
        return sections.length > 0 ? sections.join('\n') : '暂无已保存的记忆。';
      },
    }),
    defineTool({
      name: 'hologram_memory_read',
      description: '读取一条已保存记忆的完整内容。需要回忆具体事实、用户偏好或过往决策时使用。每次读取会记录回想次数。',
      schema: z.object({
        name: z.string().describe('记忆名称（不含 .md 扩展名），从 hologram_memory_list 获取'),
        scope: z
          .enum(['project', 'global'])
          .optional()
          .describe('记忆范围。project=当前项目，global=跨所有项目共享。默认从 list 中看到的范围推断。'),
      }),
      readOnly: true,
      execute: async (args) => {
        const name = args.name;
        const scope = args.scope || 'project';
        const mf = await mm.read(name, scope, true);
        if (!mf) return `未找到记忆 "${name}"。用 hologram_memory_list 查看所有记忆。`;
        const confLabels: Record<Confidence, string> = {
          fact: '🔒 铁律 — 用户明确要求。仅作提醒，不替代代码决策',
          reference: '📋 参考 — 可以参考，引用时带核实语气',
          background: '🎨 背景 — 用于调整风格，无需在回复中提及',
          suppressed: '🚫 已抑制',
        };
        const scopeLabel = scope === 'global' ? ' [全局]' : ' [项目]';
        return [
          `## ${mf.description || mf.name}${scopeLabel}`,
          `类型: ${mf.type}`,
          `置信度: ${confLabels[mf.confidence] || mf.confidence}`,
          `回想次数: ${mf.hit_count}`,
          '',
          mf.content,
        ].join('\n');
      },
    }),
    defineTool({
      name: 'hologram_memory_search',
      description:
        '语义搜索记忆库（AuraSDK SDR 引擎）。用自然语言描述你想要的上下文，返回最相关的记忆文本。\n' +
        '适合：不确定是否有相关记忆时先搜一下、需要跨记忆关联信息、当前问题需要历史决策上下文。\n' +
        '注意：搜索结果基于语义相似度，不一定精确匹配关键词。空结果 = 确实没有相关记忆。',
      schema: z.object({
        query: z
          .string()
          .describe(
            '自然语言查询，描述你需要什么信息。例如："用户之前对 UI 布局的偏好"、"为什么选了 React 而不是 Vue"',
          ),
        topK: z.coerce.number().optional().describe('返回条数上限（默认 10）。'),
      }),
      readOnly: true,
      execute: async (args) => {
        const query = args.query;
        const topK = args.topK || 10;
        const records = await mm.auraSemanticRecall(query, topK);
        if (records.length === 0) {
          const count = await mm.auraRecordCount();
          return count > 0
            ? `未找到与 "${query}" 语义相关的记忆（记忆库共 ${count} 条）。尝试换一种表述。`
            : '记忆库为空。用 hologram_memory_save 存一条记忆后即可语义搜索。';
        }
        const lines = records.map((r) => {
          const tagStr = r.tags?.length ? ` [${r.tags.join(', ')}]` : '';
          const scoreStr = ` (相关度: ${(r.score * 100).toFixed(0)}%)`;
          return `-${tagStr}${scoreStr}\n  ${r.content.slice(0, 300)}`;
        });
        return `### 语义搜索: "${query}"\n找到 ${records.length} 条相关记忆:\n\n${lines.join('\n\n')}`;
      },
    }),
    defineTool({
      name: 'hologram_memory_save',
      description:
        '保存或更新一条记忆。保守使用——只记代码库查不到且未来会话忘了会出错的东西。\n\n' +
        '置信度级别:\n' +
        '- reference (默认) — Agent 自己发现的信息最高只能给此级别\n' +
        '- fact — 仅用户通过 /remember 命令明确要求时才能使用\n' +
        '- background — 仅影响风格/语气\n' +
        '- suppressed — 已废弃，不再给 LLM 看到\n\n' +
        '记忆范围 (scope):\n' +
        '- project (默认) — 仅当前项目可见，适合架构决策、项目约定\n' +
        '- global — 跨所有项目可见，适合用户偏好、编码风格、个性\n\n' +
        '先 hologram_memory_list 检查是否已有类似记忆——已有则更新而非新建。',
      schema: z.object({
        name: z.string().describe('简短的 kebab-case 名称（只含小写字母数字和连字符），如 "user-prefers-concise"'),
        description: z.string().describe('一句话摘要，用于快速判断是否相关'),
        type: z
          .enum(['user', 'feedback', 'project', 'reference'])
          .describe('记忆类型: user=用户画像, feedback=用户反馈/要求, project=项目决策/进展, reference=外部参考'),
        confidence: z
          .enum(['fact', 'reference', 'background', 'suppressed'])
          .optional()
          .describe('置信度。Agent 自己最高只能给 reference。fact 只有用户明确要求时才能用。默认: reference'),
        content: z
          .string()
          .describe('记忆正文。对于 feedback/project 类型，应包含 **Why:** 和 **How to apply:** 段落。'),
        scope: z
          .enum(['project', 'global'])
          .optional()
          .describe(
            '记忆范围。project=仅当前项目，global=跨所有项目共享。用户偏好/编码风格 → global；架构决策/项目约定 → project。默认: project',
          ),
      }),
      execute: async (args) => {
        let confidence = args.confidence || 'reference';
        let factDowngraded = false;
        const authorized = consumeFactAuthorization();
        if (confidence === 'fact') {
          if (authorized) {
            // /remember 已授权 — fact 通过
          } else {
            confidence = 'reference';
            factDowngraded = true;
          }
        }
        const scope = args.scope || 'project';
        await mm.save(args.name, args.description, args.type, args.content, confidence, scope);
        // H1: 通知 workspace 以扇出（UI 总线 + 活跃 Agent 注入）
        mm.onSaved?.({
          name: args.name,
          description: args.description,
          confidence,
          scope,
        });
        const downgradeNote = factDowngraded ? ' (注意: fact 级别需用户授权，已自动降为 reference)' : '';
        const scopeNote = scope === 'global' ? ' [全局]' : '';
        return `已保存记忆 "${args.name}" (${confidence})${scopeNote}。${downgradeNote}`;
      },
    }),
    defineTool({
      name: 'hologram_memory_delete',
      description: '删除一条已保存的记忆。当用户要求忘记某条信息，或某条记忆已过时/错误时使用。',
      schema: z.object({
        name: z.string().describe('要删除的记忆名称（不含 .md 扩展名）'),
        scope: z.enum(['project', 'global']).optional().describe('记忆范围。默认: project'),
      }),
      execute: async (args) => {
        const name = args.name;
        const scope = args.scope || 'project';
        const ok = await mm.delete(name, scope);
        return ok
          ? `已删除记忆 "${name}"。`
          : `未找到记忆 "${name}"，可能已被删除。用 hologram_memory_list 查看当前记忆列表。`;
      },
    }),
  ];
}
