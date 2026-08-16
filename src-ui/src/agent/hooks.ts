// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Hooks —— Agent 调工具时自动注入图上下文
//
// 两层架构：
//   1. PreflightHook（pre-tool）：edit_file / write_file 之前 → ⚠️ 警告注入结果顶部
//   2. GraphContextHook（post-tool）：read_file / search_content / glob / list_directory / trace_dataflow / search_symbols / inspect_symbol / git_diff / run_shell 之后 → 📊 符号概览注入结果顶部
//
// 设计约束：
//   - 注入内容 < 800 字符，避免膨胀 token
//   - 结果接近 32KB 上限时跳过注入
//   - Hook 崩溃静默降级，绝不影响工具结果
//   - preflight 基于内存 fileIndex，零延迟（< 0.1ms）

// ── Hook 接口 ──

import type { Disposer } from './lifecycle';

export interface Hook {
  name: string;
  shouldEnrich(toolName: string, args: Record<string, unknown>): boolean;
  enrich(toolName: string, args: Record<string, unknown>, result: string): Promise<string>;
}

// ── HookRegistry ──

export class HookRegistry {
  private hooks: Hook[] = [];

  /** 注册 hook 并返回所有权清理器（Phase 1 disposer 契约）。幂等。 */
  register(hook: Hook): Disposer {
    this.hooks.push(hook);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const i = this.hooks.indexOf(hook);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  async apply(toolName: string, args: Record<string, unknown>, result: string): Promise<string> {
    let enriched = result;
    for (const hook of this.hooks) {
      try {
        if (hook.shouldEnrich(toolName, args)) {
          enriched = await hook.enrich(toolName, args, enriched);
        }
      } catch (e) {
        // Hook 崩溃静默降级
        console.error(`[HookRegistry] hook "${hook.name}" failed:`, e);
      }
    }
    return enriched;
  }
}

// ── Preflight Hook（pre-tool）──
// 在 edit_file / write_file 执行前，用内存 fileIndex 即时计算影响面，
// 返回 ⚠️ 警告字符串注入到工具结果顶部。Agent 无法忽略。

export interface PreflightHook {
  name: string;
  /** 哪些工具触发预检 */
  shouldCheck(toolName: string, args: Record<string, unknown>): boolean;
  /** 返回警告字符串（注入结果顶部），或 null 表示无风险 */
  check(toolName: string, args: Record<string, unknown>): string | null;
}

export class PreflightHookRegistry {
  private hooks: PreflightHook[] = [];

  /** 注册 preflight hook 并返回所有权清理器（Phase 1 disposer 契约）。幂等。 */
  register(hook: PreflightHook): Disposer {
    this.hooks.push(hook);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const i = this.hooks.indexOf(hook);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  /** 运行所有匹配的 hook 并聚合其警告（原来是首个匹配生效，
   *  会静默遮蔽 graph preflight 之后的每个 hook）。 */
  check(toolName: string, args: Record<string, unknown>): string | null {
    const warnings: string[] = [];
    for (const hook of this.hooks) {
      try {
        if (hook.shouldCheck(toolName, args)) {
          const warning = hook.check(toolName, args);
          if (warning) warnings.push(warning);
        }
      } catch (e) {
        console.error(`[PreflightHookRegistry] hook "${hook.name}" failed:`, e);
      }
    }
    return warnings.length > 0 ? warnings.join('\n\n') : null;
  }
}

// ── GraphContext —— 图数据查询接口 ──

/** 引擎层快照，从 hologram_call 加载（fragile_modules + project_health）。
 *  在 agent 设置后异步填充。首次 fetch 完成前为 null。 */
export interface EngineSnapshot {
  /** 脆弱度最高的模块：[file, score] */
  fragilityRanks: Array<{ file: string; score: number }>;
  /** 循环依赖总数 */
  cycleCount: number;
  /** 耦合密度得分 0-100 */
  healthScore: number;
  /** 会话基线 — 用于漂移追踪 */
  baselineFragility: Map<string, number>;
  /** 会话开始以来的漂移：正值 = 退化 */
  sessionDrift: number;
  /** LSP: 高调用次数符号的文件（前 20） */
  lspHotspots: Array<{ file: string; symbol: string; callers: number }>;
  /** LSP: 来自 resolve_call 的真实调用解析数据（按需 per-file） */
  lspCallers: Map<string, Array<{ symbol: string; count: number }>>;
  /** 合成：按类型分组的盲点标记 */
  synthesisAlerts: Array<{ type: string; count: number; detail: string }>;
  /** 向量：语义邻居映射：file -> 相似符号名 */
  semanticNeighbors: Map<string, Array<{ name: string; file: string }>>;
  /** 向量：就绪标志 */
  vectorReady: boolean;
}

export interface GraphContext {
  getNodesInFile(filePath: string): NodeBrief[];
  getImpactSummary(filePath: string): string | null;
  getSearchContext(files: string[]): string | null;
  /** 引擎快照 — 异步 fetch 完成前为 null。由 preflight hook 读取。 */
  engine: EngineSnapshot | null;
}

export interface NodeBrief {
  id: string;
  name: string;
  kind: string;
  fanIn: number;
  fanOut: number;
}

// ── 构建 file→nodes 索引 + degree map ──

export function buildFileNodeIndex(graphData: any): {
  fileIndex: Map<string, NodeBrief[]>;
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
} {
  const fileIndex = new Map<string, NodeBrief[]>();
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();

  const nodes = Array.isArray(graphData.nodes) ? graphData.nodes : Object.values(graphData.nodes || {});
  const edges = Array.isArray(graphData.edges) ? graphData.edges : Object.values(graphData.edges || {});

  // 第一遍：计算度数
  for (const e of edges) {
    const src = (e as any).source,
      tgt = (e as any).target;
    if (src && tgt) {
      fanOut.set(src, (fanOut.get(src) || 0) + 1);
      fanIn.set(tgt, (fanIn.get(tgt) || 0) + 1);
    }
  }

  // 第二遍：构建文件索引
  for (const n of nodes) {
    const loc: string = (n as any).location || '';
    let fp = loc;
    const colonIdx = loc.lastIndexOf(':');
    if (colonIdx > 1) {
      // 仅当最后一个 : 之后的部分看起来像行号时才截取
      const after = loc.slice(colonIdx + 1);
      if (/^\d+$/.test(after)) fp = loc.slice(0, colonIdx);
    }
    if (!fp) continue;
    const norm = fp.replace(/\\/g, '/').toLowerCase();
    let arr = fileIndex.get(norm);
    if (!arr) {
      arr = [];
      fileIndex.set(norm, arr);
    }
    arr.push({
      id: (n as any).id,
      name: (n as any).name,
      kind: (n as any).kind || '',
      fanIn: fanIn.get((n as any).id) || 0,
      fanOut: fanOut.get((n as any).id) || 0,
    });
  }

  return { fileIndex, fanIn, fanOut };
}

// ── buildGraphSnapshot —— 从 graphData 计算架构快照，注入 system prompt ──

export function buildGraphSnapshot(graphData: any): string {
  const nodes: any[] = Array.isArray(graphData.nodes) ? graphData.nodes : Object.values(graphData.nodes || {});
  const edges: any[] = Array.isArray(graphData.edges) ? graphData.edges : Object.values(graphData.edges || {});

  // 社区分布
  const communityMap = new Map<number, number>();
  for (const n of nodes) {
    const cid = n.community_id ?? n.communityId;
    if (cid != null) communityMap.set(cid, (communityMap.get(cid) || 0) + 1);
  }

  // 边类型分布
  const edgeTypes = new Map<string, number>();
  for (const e of edges) {
    const k = e.kind || e.edge_type || '?';
    edgeTypes.set(k, (edgeTypes.get(k) || 0) + 1);
  }

  // 高扇入节点
  const fanIn = new Map<string, number>();
  for (const e of edges) {
    if (e.target) fanIn.set(e.target, (fanIn.get(e.target) || 0) + 1);
  }
  const topFanIn = nodes
    .map((n) => ({ name: n.name || n.id, fanIn: fanIn.get(n.id) || 0 }))
    .filter((n) => n.fanIn > 0)
    .sort((a, b) => b.fanIn - a.fanIn)
    .slice(0, 5);

  // 继承边 — 去重计数
  const inheritsEdges = edges.filter((e) => (e.kind || e.edge_type) === 'inherits');
  const classCount = nodes.filter((n) => (n.kind || '').toLowerCase() === 'class').length;

  const parts: string[] = [];
  parts.push(`${nodes.length} 节点 / ${edges.length} 边`);

  // 社区
  if (communityMap.size > 0) {
    const sizes = [...communityMap.values()].sort((a, b) => b - a).slice(0, 5);
    parts.push(`${communityMap.size} 个社区（规模: ${sizes.join('/')}）`);
  }

  // 边类型
  const typeParts: string[] = [];
  for (const [k, v] of [...edgeTypes.entries()].sort((a, b) => b[1] - a[1])) {
    typeParts.push(`${k}:${v}`);
  }
  parts.push(`边: ${typeParts.join(', ')}`);

  // 类层次结构
  if (classCount > 0) {
    parts.push(`${classCount} 个类/接口, ${inheritsEdges.length} 条继承边`);
  }

  // 热点
  if (topFanIn.length > 0) {
    parts.push(`枢纽: ${topFanIn.map((n) => `\`${n.name}\`(${n.fanIn})`).join(', ')}`);
  }

  return parts.join(' | ');
}

// ── 工具元数据常量 ──
// ponytail: 新增/改名工具时，改这里就行。测试会验证这些名字在 ToolRegistry 里真实存在。

/** 触发 post-tool 图上下文注入的工具名
 *  ponytail: 'read_file' 是 alias→read_file_content，模型会吐出这个名字，必须保留 */
export const GRAPH_ENRICH_TOOLS = ['read_file_content', 'read_file', 'git_diff', 'run_shell'] as const;

/** 触发 preflight 写前影响分析的工具名
 *  ponytail: 写操作可能注册为别名，保留原始名 */
export const GRAPH_PREFLIGHT_TOOLS = [
  'edit_file',
  'write_file',
  'delete_file',
  'rename_file',
  'move_file',
  'git_discard',
  'git_checkout',
  'git_commit',
] as const;

// ═══════════════════════════════════════════════════════════
// ── GraphContextHook（post-tool，结果顶部注入）──

const MAX_ENRICH_BYTES = 800;
const MAX_RESULT_BYTES = 30_000; // leave 2KB headroom below 32KB

export function createGraphContextHook(ctx: GraphContext): Hook {
  return {
    name: 'graph-context',

    shouldEnrich(toolName: string): boolean {
      // edit_file / write_file 由 preflight hook 处理，此处不重复
      return (GRAPH_ENRICH_TOOLS as readonly string[]).includes(toolName);
    },

    async enrich(toolName: string, args: Record<string, unknown>, result: string): Promise<string> {
      // 结果过大或看起来是错误时跳过
      if (result.length > MAX_RESULT_BYTES) return result;
      if (/^(error|Error|❌)/.test(result.trimStart())) return result;

      let snippet: string | null = null;

      switch (toolName) {
        case 'read_file_content':
        case 'read_file': {
          const fp = String(args.filePath || args.file_path || '');
          if (fp) {
            snippet = ctx.getImpactSummary(fp);
            // 引擎层：脆弱度排名
            if (ctx.engine) {
              const normFp = fp.replace(/\\/g, '/').toLowerCase();
              const rankEntry = ctx.engine.fragilityRanks.find(
                (r) =>
                  r.file.replace(/\\/g, '/').toLowerCase().includes(normFp) ||
                  normFp.includes(r.file.replace(/\\/g, '/').toLowerCase()),
              );
              if (rankEntry) {
                const rank = ctx.engine.fragilityRanks.indexOf(rankEntry) + 1;
                snippet = (snippet || '') + ` 脆弱度 #${rank} (${rankEntry.score.toFixed(0)})`;
              }
            }
          }
          break;
        }
        case 'git_diff': {
          const files = extractFilesFromDiffResult(result);
          if (files.length > 0) {
            snippet = ctx.getSearchContext(files.slice(0, 3));
            // 引擎层：变更文件的脆弱度摘要
            if (ctx.engine) {
              const hot = files.filter((f) => {
                const nf = f.replace(/\\/g, '/').toLowerCase();
                return ctx.engine?.fragilityRanks.some((r) => r.file.replace(/\\/g, '/').toLowerCase().includes(nf));
              });
              if (hot.length > 0) {
                snippet = (snippet || '') + ` ⚠ ${hot.length} 个变更文件在高脆弱度排名中`;
              }
            }
          }
          break;
        }
        case 'run_shell': {
          const cmd = String(args.command || '');
          const isTest = /pytest|jest|cargo.test|npm.test|go.test|python.-m.pytest/.test(cmd);
          const isBuild = /npm.install|cargo.build|pip.install|make|cmake|npx|yarn/.test(cmd);

          if (isTest || isBuild) {
            // 归属标记：executor 在 execute 前往同一 args 对象注入的 _agent_id
            // （streaming-executor.ts）。turn-start 只消费同 Agent 的构建结果，
            // 避免 A 会话跑的结果注入 B 会话的上下文。
            const ownerId = typeof args._agent_id === 'string' ? args._agent_id : null;
            const parsed = parseBuildOutput(cmd, result);
            if (parsed) {
              cacheBuildResult(parsed, ownerId);
              snippet = parsed.outcome === 'pass' ? `✅ ${parsed.summary}` : `❌ ${parsed.summary}`;
              // 引擎层：失败时报告脆弱度上下文
              if (parsed.outcome === 'fail' && ctx.engine && ctx.engine.fragilityRanks.length > 0) {
                const top = ctx.engine.fragilityRanks[0];
                snippet += ` | 最脆弱模块: ${top.file.split('/').pop()} (${top.score.toFixed(0)})`;
              }
            } else {
              // 回退：无法识别输出格式，缓存通用结果
              // 让 agent 知道命令已运行 — 只是无法解析结果
              const label = cmd.split(' ').slice(0, 2).join(' ');
              const tail = result.slice(-200).replace(/\n/g, ' ');
              cacheBuildResult(
                { command: label, outcome: 'pass', summary: `完成 (输出未解析)`, ts: Date.now() },
                ownerId,
              );
              snippet = `⚠️ 完成，但无法解析输出格式。尾部: ${tail}`;
            }
          }
          break;
        }
      }

      if (snippet && snippet.length > 0) {
        // 强制执行承诺的注入预算 — 引擎层附加内容
        // （脆弱度/循环/LSP 热点）曾经无限增长。
        if (snippet.length > MAX_ENRICH_BYTES) {
          snippet = snippet.slice(0, MAX_ENRICH_BYTES) + '…';
        }
        // 注入到结果顶部（而非底部），Agent 第一眼就能看到
        const block = `📊 [图上下文] ${snippet}\n${'─'.repeat(40)}\n\n`;
        if (result.length + block.length <= MAX_RESULT_BYTES) {
          return block + result;
        }
      }
      return result;
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// 状态 hooks — 将自维护的项目事实注入工具结果。
// 数据来源：LSP 诊断、Git status/blame、Check/简报。
// ═══════════════════════════════════════════════════════════════

import {
  buildPreReadBlock,
  cacheBuildResult,
  type DiagnosticsSource,
  formatDiagnostics,
  invalidateBlameEntry,
  refreshGitBlame,
} from './state-inject';

const _MAX_STATE_BYTES = 600;

/** Pre-read hook — agent 读文件时注入诊断 + blame。
 *  diagSource 由 workspace 注入（UI 拥有 LSP 客户端）。 */
export function createStateReadHook(projectPath: string, diagSource: DiagnosticsSource): Hook {
  return {
    name: 'state-read',
    shouldEnrich(toolName) {
      return toolName === 'read_file_content';
    },
    async enrich(_toolName, args, result) {
      const filePath = String(args.filePath || args.file_path || '');
      if (!filePath) return result;

      // 发后即忘：为下次刷新 blame
      refreshGitBlame(projectPath, filePath).catch(() => {});

      const block = buildPreReadBlock(filePath, diagSource);
      if (!block) return result;

      const full = `📋 [状态] ${block}\n${'─'.repeat(40)}\n\n`;
      if (result.length + full.length <= MAX_RESULT_BYTES) {
        return full + result;
      }
      return result;
    },
  };
}

/** Preflight hook — 编辑文件前添加诊断上下文。 */
export function createStatePreflightHook(diagSource: DiagnosticsSource): PreflightHook {
  return {
    name: 'state-preflight',
    shouldCheck(toolName) {
      // 工具名必须与注册表（coding.ts）匹配：edit_file / write_file。
      // （'write_file_content' 从未存在过 — 此 hook 在修复前是死代码。）
      return ['edit_file', 'write_file'].includes(toolName);
    },
    check(_toolName, args) {
      const filePath = String(args.filePath || args.file_path || '');
      if (!filePath) return null;
      // 文件即将被改 — blame 缓存即刻失效，下次 pre-read 重新拉取。
      // （edit 最终被门禁拦下也只是多一次无害的重新拉取。）
      invalidateBlameEntry(filePath);
      return formatDiagnostics(filePath, diagSource);
    },
  };
}

// ── 辅助函数 ──

// ── 构建/测试输出解析器 ──
/** 将构建或测试命令的 stdout/stderr 解析为结构化结果。 */
function parseBuildOutput(
  cmd: string,
  output: string,
): { command: string; outcome: 'pass' | 'fail'; summary: string; ts: number } | null {
  const label = cmd.split(' ').slice(0, 2).join(' '); // "cargo build", "npm test"
  const ts = Date.now();

  // Cargo build
  if (/cargo\s+build/.test(cmd)) {
    const errors = (output.match(/^error(\[|:)/gm) || []).length;
    if (errors > 0) return { command: label, outcome: 'fail', summary: `${errors} errors`, ts };
    if (/Finished\s+dev/.test(output) || /Finished\s+release/.test(output))
      return { command: label, outcome: 'pass', summary: '编译通过', ts };
    return null;
  }

  // Cargo test
  if (/cargo\s+test/.test(cmd)) {
    const failures = output.match(/failures:/);
    if (failures) {
      const m = output.match(/(\d+)\s+failed/);
      return { command: label, outcome: 'fail', summary: m ? `${m[1]} failed` : '有失败', ts };
    }
    const m = output.match(/test result: ok(?:\.\s+(\d+)\s+passed)?/);
    if (m) return { command: label, outcome: 'pass', summary: m[1] ? `${m[1]} passed` : '全部通过', ts };
    return null;
  }

  // npm test / jest
  if (/npm\s+(test|run\s+test)|jest|npx\s+jest/.test(cmd)) {
    const failures = output.match(/(\d+)\s+failing/);
    if (failures) return { command: label, outcome: 'fail', summary: `${failures[1]} failing`, ts };
    const m = output.match(/Tests:\s+(\d+)\s+passed/);
    if (m) return { command: label, outcome: 'pass', summary: `${m[1]} passed`, ts };
    return null;
  }

  // pytest
  if (/pytest|python\s+-m\s+pytest/.test(cmd)) {
    const failed = output.match(/(\d+)\s+failed/);
    if (failed && parseInt(failed[1], 10) > 0)
      return { command: label, outcome: 'fail', summary: `${failed[1]} failed`, ts };
    const passed = output.match(/(\d+)\s+passed/);
    if (passed) return { command: label, outcome: 'pass', summary: `${passed[1]} passed`, ts };
    return null;
  }

  // 通用构建（make, cmake, npm install, pip, yarn）
  if (/make|cmake|npm\s+install|pip\s+install|npx|yarn/.test(cmd)) {
    const errors = (output.match(/^error(\[|:)/gm) || []).length + (output.match(/\bERROR\b/g) || []).length;
    if (errors > 0) return { command: label, outcome: 'fail', summary: `${errors} errors`, ts };
    const warnings = (output.match(/\bwarning\b/gi) || []).length;
    if (/^(npm |yarn )/.test(cmd) && output.includes('added'))
      return { command: label, outcome: 'pass', summary: '安装完成', ts };
    if (warnings > 0) return { command: label, outcome: 'pass', summary: `完成 (${warnings} warnings)`, ts };
    return { command: label, outcome: 'pass', summary: '完成', ts };
  }

  return null;
}

// ── git_diff → 变更文件提取 ──

function extractFilesFromDiffResult(result: string): string[] {
  const files = new Set<string>();
  const lines = result.split('\n');
  for (const line of lines) {
    const match = line.match(/^\+\+\+ [ab]\/(.+)/);
    if (match) files.add(match[1]);
    if (files.size >= 5) break;
  }
  return [...files];
}

// ── GraphContext 实现（基于 fileIndex） ──

export function createGraphContext(
  fileIndex: Map<string, NodeBrief[]>,
  _fanIn: Map<string, number>,
  _fanOut: Map<string, number>,
  engine: EngineSnapshot | null = null,
): GraphContext {
  function norm(fp: string): string {
    return fp.replace(/\\/g, '/').toLowerCase();
  }

  function getNodesInFile(filePath: string): NodeBrief[] {
    return fileIndex.get(norm(filePath)) || [];
  }

  function getImpactSummary(filePath: string): string | null {
    const nodes = getNodesInFile(filePath);
    if (nodes.length === 0) return null;

    // 下游：谁依赖此文件的符号
    const downstream = [...nodes]
      .filter((n) => n.fanIn > 0)
      .sort((a, b) => b.fanIn - a.fanIn)
      .slice(0, 5);
    // 上游：此文件的符号依赖什么
    const upstream = [...nodes]
      .filter((n) => n.fanOut > 0)
      .sort((a, b) => b.fanOut - a.fanOut)
      .slice(0, 3);

    let summary = `此文件 ${nodes.length} 个符号。`;
    if (downstream.length > 0) {
      summary += ` 下游依赖: ${downstream.map((n) => `\`${n.name}\`(${n.fanIn})`).join(', ')}。`;
    }
    if (upstream.length > 0) {
      summary += ` | 依赖上游: ${upstream.map((n) => `\`${n.name}\`(${n.fanOut})`).join(', ')}。`;
    }
    return summary;
  }

  function getSearchContext(files: string[]): string | null {
    const parts: string[] = [];
    let totalFanIn = 0;
    let totalFanOut = 0;
    for (const fp of files) {
      const nodes = getNodesInFile(fp);
      if (nodes.length > 0) {
        const fi = nodes.reduce((s, n) => s + n.fanIn, 0);
        const fo = nodes.reduce((s, n) => s + n.fanOut, 0);
        totalFanIn += fi;
        totalFanOut += fo;
        const fileName = fp.replace(/\\/g, '/').split('/').pop() || fp;
        const deps: string[] = [];
        if (fi > 0) deps.push(`${fi}↓`);
        if (fo > 0) deps.push(`${fo}↑`);
        const top3 = nodes.sort((a, b) => b.fanIn - a.fanIn).slice(0, 3);
        const names = top3.map((n) => `\`${n.name}\``).join(', ');
        parts.push(`${fileName}: ${nodes.length}符号${deps.length > 0 ? ` [${deps.join(' ')}]` : ''} — ${names}`);
      }
    }
    if (parts.length === 0) return null;
    let summary = `匹配文件 — ${parts.join(' | ')}。`;
    if (files.length >= 2) {
      summary += ` ${files.length} 个文件, 扇入合计 ${totalFanIn}, 扇出合计 ${totalFanOut}。`;
      if (totalFanIn >= 10 || totalFanOut >= 10) {
        summary += ` 跨文件耦合较高。`;
      }
    }
    return summary;
  }

  return { engine, getNodesInFile, getImpactSummary, getSearchContext };
}

// ── GraphPreflightHook —— 写操作前自动影响分析 ──
//
// edit_file / write_file 触发时，用内存 fileIndex 即时评估：
//   1. 该文件有多少符号被外部依赖
//   2. 被依赖最多的 top 5 符号
//   3. 风险等级（LOW / MEDIUM / HIGH）
//   4. 引导 Agent 调 trace_impact 深挖（MEDIUM+ 时）
//
// 耗时 < 0.1ms，数据全在内存，不额外调 MCP。

export function createGraphPreflightHook(ctx: GraphContext): PreflightHook {
  return {
    name: 'graph-preflight',

    shouldCheck(toolName: string): boolean {
      return (GRAPH_PREFLIGHT_TOOLS as readonly string[]).includes(toolName);
    },

    check(toolName: string, args: Record<string, unknown>): string | null {
      // ── git_checkout: 无具体文件，通用警告 ──
      if (toolName === 'git_checkout') {
        const branch = String(args.branch || '');
        return [
          `⚠️ [切换分支] 即将切换到 \`${branch}\`。`,
          `│  切换前请确认当前工作区已提交或暂存，避免丢失未保存的修改。`,
        ].join('\n');
      }

      // ── git_commit: 无具体文件，通用警告 ──
      if (toolName === 'git_commit') {
        return [`⚠️ [提交] 即将创建提交。`].join('\n');
      }

      // ── git_discard: 拼接 repo 根 + 相对路径 ──
      let fp: string;
      if (toolName === 'git_discard') {
        const repoPath = String(args.path || '');
        const file = String(args.file || '');
        fp = repoPath ? `${repoPath.replace(/\\/g, '/')}/${file}` : file;
      } else {
        fp = String(args.filePath || args.file_path || '');
      }

      if (!fp) return null;

      const nodes = ctx.getNodesInFile(fp);
      if (nodes.length === 0) return null;

      const totalFanIn = nodes.reduce((sum, n) => sum + n.fanIn, 0);
      const topSymbols = [...nodes]
        .filter((n) => n.fanIn > 0)
        .sort((a, b) => b.fanIn - a.fanIn)
        .slice(0, 5);

      // 全是内部符号（fanIn = 0）→ 无外部影响，不打扰
      if (topSymbols.length === 0) return null;

      const maxFanIn = topSymbols[0].fanIn;
      let riskLevel: string;
      if (maxFanIn >= 10 || totalFanIn >= 50) riskLevel = 'HIGH   ';
      else if (maxFanIn >= 5 || totalFanIn >= 20) riskLevel = 'MEDIUM ';
      else riskLevel = 'LOW    ';

      const fileName = fp.replace(/\\/g, '/').split('/').pop() || fp;
      const verb = toolName === 'git_discard' ? '丢弃修改' : '修改';

      const lines = [
        `⚠️ [自动影响分析] 即将${verb} \`${fileName}\``,
        `│  文件内 ${nodes.length} 个符号，${totalFanIn} 个外部依赖者。`,
      ];

      if (topSymbols.length > 0) {
        lines.push(`│`);
        lines.push(`│  被依赖最多的符号:`);
        for (const s of topSymbols) {
          lines.push(`│  • \`${s.name}\` — ${s.fanIn} 个下游`);
        }
      }

      lines.push(`│`);
      lines.push(`│  风险等级: ${riskLevel}`);

      // ── 引擎层数据：紧凑标签式摘要（原来是 6 个区块，约 20 行）──
      if (ctx.engine) {
        const eng = ctx.engine;
        const normFp = fp.replace(/\\/g, '/').toLowerCase();
        const rankEntry = eng.fragilityRanks.find(
          (r) =>
            r.file.replace(/\\/g, '/').toLowerCase().includes(normFp) ||
            normFp.includes(r.file.replace(/\\/g, '/').toLowerCase()),
        );
        if (rankEntry || eng.cycleCount > 0 || eng.sessionDrift > 0) {
          // 第 1 行：脆弱度 + 循环 + 漂移 + 健康度
          const tags: string[] = [];
          if (rankEntry) tags.push(`脆弱#${eng.fragilityRanks.indexOf(rankEntry) + 1}(${rankEntry.score.toFixed(0)})`);
          if (eng.cycleCount > 0) tags.push(`循环×${eng.cycleCount}`);
          if (eng.sessionDrift > 0) {
            const driftPct = (eng.sessionDrift * 100).toFixed(1);
            tags.push(`退化+${driftPct}%`);
            if (eng.sessionDrift > 0.1) {
              riskLevel = 'HIGH   ';
            }
          }
          tags.push(`健康${eng.healthScore}/100`);
          lines.push(`│  引擎: ${tags.join(' ')}`);

          // 第 2 行：LSP 热点 + 调用者 + 语义邻居 + 合成（如有）
          const lspParts: string[] = [];
          const fileHit = eng.lspHotspots.filter(
            (h) =>
              h.file.replace(/\\/g, '/').toLowerCase().includes(normFp) ||
              normFp.includes(h.file.replace(/\\/g, '/').toLowerCase()),
          );
          if (fileHit.length > 0) {
            lspParts.push(
              fileHit
                .slice(0, 3)
                .map((h) => `${h.symbol}(${h.callers}↓)`)
                .join(','),
            );
          }
          if (eng.lspCallers.size > 0) {
            const callerEntries =
              eng.lspCallers.get(normFp) ||
              [...eng.lspCallers.entries()].find(([k]) => k.replace(/\\/g, '/').toLowerCase().includes(normFp))?.[1];
            if (callerEntries && callerEntries.length > 0) {
              lspParts.push(
                callerEntries
                  .slice(0, 3)
                  .map((c) => `${c.symbol}(${c.count}↓)`)
                  .join(','),
              );
            }
          }
          if (eng.semanticNeighbors.size > 0) {
            const neighbors =
              eng.semanticNeighbors.get(normFp) ||
              [...eng.semanticNeighbors.entries()].find(([k]) =>
                k.replace(/\\/g, '/').toLowerCase().includes(normFp),
              )?.[1];
            if (neighbors && neighbors.length > 0) {
              lspParts.push(
                `邻居:${neighbors
                  .slice(0, 5)
                  .map((n) => n.name)
                  .join(',')}`,
              );
            }
          }
          if (eng.synthesisAlerts.length > 0) {
            lspParts.push(`合成:${eng.synthesisAlerts.map((a) => `${a.type}(${a.count})`).join(',')}`);
          }
          if (lspParts.length > 0) {
            lines.push(`│  LSP: ${lspParts.join(' ')}`);
          }

          // 漂移严重时升级风险等级
          if (eng.sessionDrift > 0.1) {
            // 更新已推送的风险等级行
            const riskIdx = lines.findIndex((l) => l.includes('风险等级'));
            if (riskIdx >= 0) lines[riskIdx] = `│  风险等级: ${riskLevel} ⚠退化>10%`;
          }
        }
      }

      lines.push(`│  精确影响面 → preflight_check(["${fp.replace(/\\/g, '/')}"])`);
      return lines.join('\n');
    },
  };
}
