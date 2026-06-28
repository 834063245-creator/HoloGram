// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent 持久化记忆系统 — 对标 Claude Code MEMORY.md
// 存储位置: .hologram/memory/*.md + MEMORY.md 索引
// 跨会话、跨 session tab 共享
//
// 记忆置信度体系 (inspired by 初痕 MemoryDirective):
//   fact       — 用户明确要求，过去的确定结论。仅作提醒，不替代代码和约束决策
//   reference  — Agent 发现或用户提过的参考信息（默认级别）
//   background — 用于调整回复风格和语气，不需要在回复中提及
//   suppressed — 不给 LLM 看到
//   Agent 自己主动存的记忆最高只能给 reference。fact 级别只有用户通过 /remember 明确要求时才能使用。

import { invoke } from '../bridge';
import type { Tool } from './tool';

// ── Types ──

type Confidence = 'fact' | 'reference' | 'background' | 'suppressed';

/** Parsed entry from MEMORY.md index */
export interface MemoryEntry {
  name: string;       // kebab-case slug, e.g. "user-prefers-concise"
  title: string;      // display title, e.g. "用户偏好简洁回复"
  file: string;       // file name with .md extension
  description: string; // one-line hook from index
}

/** Full memory with parsed frontmatter + body */
export interface MemoryFile {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  confidence: Confidence;
  hit_count: number;
  content: string;    // body only (without frontmatter)
  raw: string;        // full file text (for rewriting with updated metadata)
}

// ── MemoryManager ──

export class MemoryManager {
  private _dirReady = false;

  constructor(private projectPath: string) {}

  private get dir(): string {
    return this.projectPath.replace(/\\/g, '/') + '/.hologram/memory';
  }

  private indexPath(): string {
    return this.dir + '/MEMORY.md';
  }

  private filePath(name: string): string {
    return this.dir + '/' + name + '.md';
  }

  /** Ensure .hologram/memory/ exists before any read. Fixes cold-start where
   *  sandbox denies reads from non-existent parent directories. */
  private async ensureDir(): Promise<void> {
    if (this._dirReady) return;
    try {
      await invoke('create_directory', { path: this.dir });
    } catch {
      // Directory may already exist or create is not available — safe to continue
    }
    this._dirReady = true;
  }

  // ── Prompt section cache ──

  private _promptSectionCache: string | null = null;
  private _promptSectionCacheTime = 0;

  // ── Index ──

  /** Load the raw MEMORY.md text. */
  async loadIndexText(): Promise<string> {
    await this.ensureDir();
    try {
      return await invoke<string>('read_file_content', { filePath: this.indexPath() });
    } catch {
      return '';
    }
  }

  /** Parse MEMORY.md into structured entries. */
  async list(): Promise<MemoryEntry[]> {
    const text = await this.loadIndexText();
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

  /** Build a compact index line (for adding to MEMORY.md). */
  static formatIndexEntry(entry: MemoryEntry): string {
    return `- [${entry.title}](${entry.file}) — ${entry.description}`;
  }

  // ── Read ──

  /** Read a full memory file by name (without .md). Returns null if not found.
   *  Set incrementHit to track recall frequency. */
  async read(name: string, incrementHit = false): Promise<MemoryFile | null> {
    await this.ensureDir();
    try {
      const raw = await invoke<string>('read_file_content', { filePath: this.filePath(name) });
      const mf = parseFrontmatter(raw);

      if (incrementHit) {
        mf.hit_count = (mf.hit_count || 0) + 1;
        mf.raw = rebuildRaw(mf);
        // Fire-and-forget: don't let hit_count write failure destroy the read
        invoke('write_file_content', {
          filePath: this.filePath(name),
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

  // ── Prompt section — loaded into system prompt ──

  /** Load all non-suppressed memories and format as system prompt section.
   *  Cached for 5 seconds for rapid session creation. */
  async loadPromptSection(): Promise<string> {
    const now = Date.now();
    if (this._promptSectionCache && (now - this._promptSectionCacheTime) < 5000) {
      return this._promptSectionCache;
    }

    const entries = await this.list();
    if (entries.length === 0) {
      const section =
        '暂无已保存的记忆。用户说"记住..."时保存，说"忘了..."时删除。';
      this._promptSectionCache = section;
      this._promptSectionCacheTime = now;
      return section;
    }

    // Group by confidence
    const byConfidence: Record<Confidence, MemoryFile[]> = {
      fact: [],
      reference: [],
      background: [],
      suppressed: [],
    };

    for (const entry of entries) {
      const mf = await this.read(entry.name);
      if (!mf) continue;
      const c = mf.confidence || 'reference';
      if (c === 'suppressed') continue;
      byConfidence[c].push(mf);
    }

    const parts: string[] = [];

    // Fact group — 铁律，但只是提醒
    if (byConfidence.fact.length > 0) {
      parts.push('### 🔒 铁律 (fact)\n用户明确要求的规则。仅作提醒——Agent 仍需基于代码和约束做决策:\n');
      for (const m of byConfidence.fact) {
        parts.push(formatMemoryLine(m));
      }
    }

    // Reference group — 默认级别
    if (byConfidence.reference.length > 0) {
      parts.push('### 📋 参考 (reference)\nAgent 发现或用户提过的信息。可以参考，引用时带核实语气:\n');
      for (const m of byConfidence.reference) {
        parts.push(formatMemoryLine(m));
      }
    }

    // Background group — 风格/语气
    if (byConfidence.background.length > 0) {
      parts.push('### 🎨 背景 (background)\n用于调整回复风格和语气，不需要在回复中提及:\n');
      for (const m of byConfidence.background) {
        parts.push(formatMemoryLine(m));
      }
    }

    const section = parts.length > 0 ? parts.join('\n') : '暂无已保存的记忆。';
    this._promptSectionCache = section;
    this._promptSectionCacheTime = now;
    return section;
  }

  // ── Write ──

  /** Save a memory (creates or updates). Also updates MEMORY.md index.
   *  Preserves existing hit_count on update. Confidence defaults to 'reference'. */
  async save(
    name: string,
    description: string,
    type: 'user' | 'feedback' | 'project' | 'reference',
    content: string,
    confidence: Confidence = 'reference',
  ): Promise<void> {
    // Preserve hit_count if updating existing memory
    let hitCount = 0;
    const existing = await this.read(name);
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

    // Write the memory file
    await invoke('write_file_content', {
      filePath: this.filePath(name),
      content: frontmatter,
    });

    // Use the description as the title in the index
    const title = description.length > 40 ? description.slice(0, 39) + '…' : description;

    // Update MEMORY.md index
    await this.upsertIndex(title, name + '.md', description);

    // Bust prompt section cache
    this._promptSectionCache = null;
  }

  // ── Delete ──

  /** Delete a memory by name. Returns true if deleted, false if not found. */
  async delete(name: string): Promise<boolean> {
    let index = await this.loadIndexText();
    if (!index.trim()) return false;

    // Remove matching line from index
    const pattern = new RegExp(
      `^\\s*-\\s*\\[[^\\]]*\\]\\(${escapeRegExp(name)}\\.md\\)\\s+[—–-]\\s+.+$\\n?`,
      'm',
    );
    if (!pattern.test(index)) return false;

    index = index.replace(pattern, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (index) index += '\n';

    await invoke('write_file_content', {
      filePath: this.indexPath(),
      content: index,
    });

    // Also delete/overwrite the actual .md file (not just delist from index)
    try {
      await invoke('write_file_content', {
        filePath: this.filePath(name),
        content: JSON.stringify({ deleted: true }),
      });
    } catch (e) {
      console.warn(`[memory] failed to delete file for "${name}":`, e);
    }

    // Bust prompt section cache
    this._promptSectionCache = null;

    return true;
  }

  // ── Internal ──

  /** Insert or update a line in MEMORY.md. */
  private async upsertIndex(title: string, file: string, description: string): Promise<void> {
    let index = await this.loadIndexText();
    const newLine = `- [${title}](${file}) — ${description}`;

    // Try to replace existing line for same file
    const pattern = new RegExp(
      `^\\s*-\\s*\\[[^\\]]*\\]\\(${escapeRegExp(file.replace(/\.md$/, ''))}\\.md\\)\\s+[—–-]\\s+.+$`,
      'm',
    );
    if (pattern.test(index)) {
      index = index.replace(pattern, newLine);
    } else {
      // Append
      index = index.trimEnd();
      if (index) index += '\n';
      index += newLine + '\n';
    }

    await invoke('write_file_content', {
      filePath: this.indexPath(),
      content: index,
    });
  }
}

// ── Frontmatter ──

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
  const typeRaw = (fm.match(/^\s+type:\s*(.+)$/m) || [])[1]?.trim() || 'reference';
  const type = (
    ['user', 'feedback', 'project', 'reference'] as const
  ).includes(typeRaw as any) ? (typeRaw as MemoryFile['type']) : 'reference';
  const confRaw = (fm.match(/^\s+confidence:\s*(.+)$/m) || [])[1]?.trim() || 'reference';
  const confidence = (
    ['fact', 'reference', 'background', 'suppressed'] as const
  ).includes(confRaw as any) ? (confRaw as Confidence) : 'reference';
  const hitCountRaw = (fm.match(/^\s+hit_count:\s*(\d+)$/m) || [])[1];
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

// ── Helpers ──

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function formatMemoryLine(m: MemoryFile): string {
  const body = m.content.length > 120 ? m.content.slice(0, 119) + '…' : m.content;
  return `- **${m.description}** — ${body}`;
}

// ── Agent Tools ──

/** Create Agent tools for memory operations. All operate on the given MemoryManager. */
export function createMemoryTools(mm: MemoryManager): Tool[] {
  return [
    {
      name: () => 'hologram_memory_list',
      description: () =>
        '列出所有已保存的记忆及其置信度。保存新记忆前，先调用此工具检查是否已有类似记忆——已有则用 hologram_memory_save 更新而非新建。',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => true,
      execute: async () => {
        const entries = await mm.list();
        if (entries.length === 0) return '暂无已保存的记忆。';

        // Load full info for each entry to get confidence
        const lines: string[] = [];
        for (const e of entries) {
          const mf = await mm.read(e.name);
          const conf = mf?.confidence || 'reference';
          const confTag = {
            fact: '[fact]',
            reference: '[ref]',
            background: '[bg]',
            suppressed: '[sup]',
          }[conf];
          const hit = mf?.hit_count ? ` · 回想${mf.hit_count}次` : '';
          lines.push(`- ${confTag} **${e.title}** (\`${e.name}\`)${hit} — ${e.description}`);
        }
        return lines.join('\n');
      },
    },
    {
      name: () => 'hologram_memory_read',
      description: () =>
        '读取一条已保存记忆的完整内容。需要回忆具体事实、用户偏好或过往决策时使用。每次读取会记录回想次数。',
      parameters: () => ({
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '记忆名称（不含 .md 扩展名），从 hologram_memory_list 获取',
          },
        },
        required: ['name'],
      }),
      readOnly: () => true,
      execute: async (args) => {
        const name = args.name as string;
        const mf = await mm.read(name, true); // incrementHit
        if (!mf) return `未找到记忆 "${name}"。用 hologram_memory_list 查看所有记忆。`;
        const confLabels: Record<Confidence, string> = {
          fact: '🔒 铁律 — 用户明确要求。仅作提醒，不替代代码决策',
          reference: '📋 参考 — 可以参考，引用时带核实语气',
          background: '🎨 背景 — 用于调整风格，无需在回复中提及',
          suppressed: '🚫 已抑制',
        };
        return [
          `## ${mf.description || mf.name}`,
          `类型: ${mf.type}`,
          `置信度: ${confLabels[mf.confidence] || mf.confidence}`,
          `回想次数: ${mf.hit_count}`,
          '',
          mf.content,
        ].join('\n');
      },
    },
    {
      name: () => 'hologram_memory_save',
      description: () =>
        '保存或更新一条记忆。保守使用——只记代码库查不到且未来会话忘了会出错的东西。\n\n'
        + '置信度级别:\n'
        + '- reference (默认) — Agent 自己发现的信息最高只能给此级别\n'
        + '- fact — 仅用户通过 /remember 命令明确要求时才能使用\n'
        + '- background — 仅影响风格/语气\n'
        + '- suppressed — 已废弃，不再给 LLM 看到\n\n'
        + '先 hologram_memory_list 检查是否已有类似记忆——已有则更新而非新建。',
      parameters: () => ({
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '简短的 kebab-case 名称（只含小写字母数字和连字符），如 "user-prefers-concise"',
          },
          description: {
            type: 'string',
            description: '一句话摘要，用于快速判断是否相关',
          },
          type: {
            type: 'string',
            enum: ['user', 'feedback', 'project', 'reference'],
            description: '记忆类型: user=用户画像, feedback=用户反馈/要求, project=项目决策/进展, reference=外部参考',
          },
          confidence: {
            type: 'string',
            enum: ['fact', 'reference', 'background', 'suppressed'],
            description: '置信度。Agent 自己最高只能给 reference。fact 只有用户明确要求时才能用。默认: reference',
          },
          content: {
            type: 'string',
            description: '记忆正文。对于 feedback/project 类型，应包含 **Why:** 和 **How to apply:** 段落。',
          },
        },
        required: ['name', 'description', 'type', 'content'],
      }),
      readOnly: () => false,
      execute: async (args) => {
        const type = args.type as string;
        if (!['user', 'feedback', 'project', 'reference'].includes(type)) {
          return `错误: type 必须是 user/feedback/project/reference，收到了 "${type}"`;
        }
        let confidence = (args.confidence as Confidence) || 'reference';
        if (!['fact', 'reference', 'background', 'suppressed'].includes(confidence)) {
          confidence = 'reference';
        }
        // Enforce: Agent cannot self-elevate to fact — auto-downgrade to reference
        let factDowngraded = false;
        if (confidence === 'fact') {
          confidence = 'reference';
          factDowngraded = true;
        }
        await mm.save(
          args.name as string,
          args.description as string,
          type as MemoryFile['type'],
          args.content as string,
          confidence,
        );
        const downgradeNote = factDowngraded
          ? ' (注意: fact 级别需用户授权，已自动降为 reference)'
          : '';
        return `已保存记忆 "${args.name}" (${confidence})。${downgradeNote}`;
      },
    },
    {
      name: () => 'hologram_memory_delete',
      description: () =>
        '删除一条已保存的记忆。当用户要求忘记某条信息，或某条记忆已过时/错误时使用。',
      parameters: () => ({
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '要删除的记忆名称（不含 .md 扩展名）',
          },
        },
        required: ['name'],
      }),
      readOnly: () => false,
      execute: async (args) => {
        const name = args.name as string;
        const ok = await mm.delete(name);
        return ok
          ? `已删除记忆 "${name}"。`
          : `未找到记忆 "${name}"，可能已被删除。用 hologram_memory_list 查看当前记忆列表。`;
      },
    },
  ];
}
