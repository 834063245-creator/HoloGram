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

import type { Agent } from './agent';

// ── Hook 接口 ──

export interface Hook {
  name: string;
  shouldEnrich(toolName: string, args: Record<string, unknown>): boolean;
  enrich(toolName: string, args: Record<string, unknown>, result: string): Promise<string>;
}

// ── HookRegistry ──

export class HookRegistry {
  private hooks: Hook[] = [];

  register(hook: Hook): void {
    this.hooks.push(hook);
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

  register(hook: PreflightHook): void {
    this.hooks.push(hook);
  }

  check(toolName: string, args: Record<string, unknown>): string | null {
    for (const hook of this.hooks) {
      try {
        if (hook.shouldCheck(toolName, args)) {
          const warning = hook.check(toolName, args);
          if (warning) return warning;
        }
      } catch (e) {
        console.error(`[PreflightHookRegistry] hook "${hook.name}" failed:`, e);
      }
    }
    return null;
  }
}

// ── GraphContext —— 图数据查询接口 ──

/** Engine-level snapshot loaded from hologram_call (fragile_modules + project_health).
 *  Populated asynchronously after agent setup. Null until first fetch completes. */
export interface EngineSnapshot {
  /** Top fragile modules: [file, score] */
  fragilityRanks: Array<{ file: string; score: number }>;
  /** Total cycle count */
  cycleCount: number;
  /** Coupling density score 0-100 */
  healthScore: number;
  /** Session baseline — drift tracking */
  baselineFragility: Map<string, number>;
  /** Drift since session start: positive = degraded */
  sessionDrift: number;
  /** LSP: files with high-call-count symbols (top 20) */
  lspHotspots: Array<{ file: string; symbol: string; callers: number }>;
  /** Synthesis: blindspot markers grouped by type */
  synthesisAlerts: Array<{ type: string; count: number; detail: string }>;
  /** Vector: top symbol names for semantic neighbor lookup (deferred) */
  vectorReady: boolean;
}

export interface GraphContext {
  getNodesInFile(filePath: string): NodeBrief[];
  getImpactSummary(filePath: string): string | null;
  getSearchContext(files: string[]): string | null;
  /** Engine snapshot — null until async fetch completes. Read by preflight hook. */
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

  const nodes = Array.isArray(graphData.nodes)
    ? graphData.nodes
    : Object.values(graphData.nodes || {});
  const edges = Array.isArray(graphData.edges)
    ? graphData.edges
    : Object.values(graphData.edges || {});

  // Pass 1: count degrees
  for (const e of edges) {
    const src = (e as any).source, tgt = (e as any).target;
    if (src && tgt) {
      fanOut.set(src, (fanOut.get(src) || 0) + 1);
      fanIn.set(tgt, (fanIn.get(tgt) || 0) + 1);
    }
  }

  // Pass 2: build file index
  for (const n of nodes) {
    const loc: string = (n as any).location || '';
    let fp = loc;
    const colonIdx = loc.lastIndexOf(':');
    if (colonIdx > 1) {
      // Only strip if the part after last : looks like a line number
      const after = loc.slice(colonIdx + 1);
      if (/^\d+$/.test(after)) fp = loc.slice(0, colonIdx);
    }
    if (!fp) continue;
    const norm = fp.replace(/\\/g, '/').toLowerCase();
    let arr = fileIndex.get(norm);
    if (!arr) { arr = []; fileIndex.set(norm, arr); }
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
  const nodes: any[] = Array.isArray(graphData.nodes)
    ? graphData.nodes
    : Object.values(graphData.nodes || {});
  const edges: any[] = Array.isArray(graphData.edges)
    ? graphData.edges
    : Object.values(graphData.edges || {});

  // Community distribution
  const communityMap = new Map<number, number>();
  for (const n of nodes) {
    const cid = n.community_id ?? n.communityId;
    if (cid != null) communityMap.set(cid, (communityMap.get(cid) || 0) + 1);
  }

  // Edge type breakdown
  const edgeTypes = new Map<string, number>();
  for (const e of edges) {
    const k = (e.kind || e.edge_type || '?');
    edgeTypes.set(k, (edgeTypes.get(k) || 0) + 1);
  }

  // Top fan-in nodes
  const fanIn = new Map<string, number>();
  for (const e of edges) {
    if (e.target) fanIn.set(e.target, (fanIn.get(e.target) || 0) + 1);
  }
  const topFanIn = nodes
    .map(n => ({ name: n.name || n.id, fanIn: fanIn.get(n.id) || 0 }))
    .filter(n => n.fanIn > 0)
    .sort((a, b) => b.fanIn - a.fanIn)
    .slice(0, 5);

  // Inherits edges — count distinct
  const inheritsEdges = edges.filter(e => (e.kind || e.edge_type) === 'inherits');
  const classCount = nodes.filter(n => (n.kind || '').toLowerCase() === 'class').length;

  const parts: string[] = [];
  parts.push(`${nodes.length} 节点 / ${edges.length} 边`);

  // Communities
  if (communityMap.size > 0) {
    const sizes = [...communityMap.values()].sort((a, b) => b - a).slice(0, 5);
    parts.push(`${communityMap.size} 个社区（规模: ${sizes.join('/')}）`);
  }

  // Edge types
  const typeParts: string[] = [];
  for (const [k, v] of [...edgeTypes.entries()].sort((a, b) => b[1] - a[1])) {
    typeParts.push(`${k}:${v}`);
  }
  parts.push(`边: ${typeParts.join(', ')}`);

  // Class hierarchy
  if (classCount > 0) {
    parts.push(`${classCount} 个类/接口, ${inheritsEdges.length} 条继承边`);
  }

  // Hotspots
  if (topFanIn.length > 0) {
    parts.push(`枢纽: ${topFanIn.map(n => `\`${n.name}\`(${n.fanIn})`).join(', ')}`);
  }

  return parts.join(' | ');
}

// ── 工具元数据常量 ──
// ponytail: 新增/改名工具时，改这里就行。测试会验证这些名字在 ToolRegistry 里真实存在。

/** 触发 post-tool 图上下文注入的工具名
 *  ponytail: 'read_file' 是 alias→read_file_content，模型会吐出这个名字，必须保留 */
export const GRAPH_ENRICH_TOOLS = [
  'read_file_content', 'read_file',
  'search_content', 'glob', 'list_directory',
  'trace_dataflow', 'search_symbols', 'inspect_symbol', 'git_diff', 'run_shell',
  'resolve_call', 'infer_type',
  'find_implementations', 'find_references',
] as const;

/** 触发 preflight 写前影响分析的工具名
 *  ponytail: 写操作可能注册为别名，保留原始名 */
export const GRAPH_PREFLIGHT_TOOLS = [
  'edit_file', 'write_file',
  'delete_file', 'rename_file', 'move_file',
  'git_discard', 'git_checkout', 'git_commit',
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
      // Skip if result too large or looks like an error
      if (result.length > MAX_RESULT_BYTES) return result;
      if (/^(error|Error|❌)/.test(result.trimStart())) return result;

      let snippet: string | null = null;

      switch (toolName) {
        case 'read_file_content':
        case 'read_file': {
          const fp = String(args['filePath'] || args['file_path'] || '');
          if (fp) {
            snippet = ctx.getImpactSummary(fp);
            const nodes = ctx.getNodesInFile(fp);
            const hasFuncs = nodes.some(n => n.kind === 'function' || n.kind === 'method');
            if (hasFuncs && snippet) {
              snippet += ' 共享变量/异步链 → trace_dataflow 追踪。';
            }
            // Engine-layer: fragility rank
            if (ctx.engine) {
              const normFp = fp.replace(/\\/g, '/').toLowerCase();
              const rankEntry = ctx.engine.fragilityRanks.find(r =>
                r.file.replace(/\\/g, '/').toLowerCase().includes(normFp) ||
                normFp.includes(r.file.replace(/\\/g, '/').toLowerCase())
              );
              if (rankEntry) {
                const rank = ctx.engine.fragilityRanks.indexOf(rankEntry) + 1;
                snippet = (snippet || '') + ` 脆弱度 #${rank} (${rankEntry.score.toFixed(0)}) → 改前调 trace_impact`;
              }
            }
          }
          break;
        }
        case 'search_content': {
          // Extract symbol names from matched lines, cross-reference with fileIndex
          const graphSymbols = extractGraphSymbolsFromSearch(result, (fp: string) => ctx.getNodesInFile(fp));
          if (graphSymbols.length > 0) {
            const parts = graphSymbols.map(s => {
              const info: string[] = [];
              if (s.fanIn > 0) info.push(`↓${s.fanIn}`);
              if (s.fanOut > 0) info.push(`↑${s.fanOut}`);
              return `\`${s.name}\`${info.length > 0 ? ` (${info.join(' ')})` : ''}`;
            });
            const highImpact = graphSymbols.filter(s => s.fanIn >= 5);
            snippet = `图谱命中: ${parts.join(', ')}。`;
            if (highImpact.length > 0) {
              snippet += ` → \`${highImpact[0].name}\` 下游多, 调 trace_impact 看波及`;
            }
          } else {
            const files = extractFilesFromSearchResult(result);
            if (files.length > 0) {
              snippet = ctx.getSearchContext(files.slice(0, 3));
              // Engine-layer: flag if any match is a high-fragility file
              if (ctx.engine) {
                const hot = files.filter(f => {
                  const nf = f.replace(/\\/g, '/').toLowerCase();
                  return ctx.engine!.fragilityRanks.some(r =>
                    r.file.replace(/\\/g, '/').toLowerCase().includes(nf)
                  );
                });
                if (hot.length > 0) {
                  snippet = (snippet || '') + ` ⚠ 其中 ${hot.length} 个文件在高脆弱度排名中 → 谨慎修改`;
                }
              }
            }
          }
          break;
        }
        case 'glob': {
          const files = extractFilesFromGlobResult(result);
          if (files.length > 0) snippet = ctx.getSearchContext(files.slice(0, 3));
          break;
        }
        case 'list_directory': {
          const files = extractSourceFilesFromDirList(result);
          if (files.length > 0) snippet = ctx.getSearchContext(files.slice(0, 3));
          break;
        }
        case 'trace_dataflow': {
          const vars = extractSharedVarsFromDataflow(result);
          if (vars.length > 0) {
            snippet = `共享变量: ${vars.map(v => `\`${v}\``).join(', ')}。→ 用 trace_impact 追踪下游影响`;
          }
          break;
        }
        case 'search_symbols': {
          const nodes = extractNodesFromSearchResult(result);
          if (nodes.length > 0) {
            const names = nodes.map(n => `\`${n.name}\``).join(', ');
            snippet = `命中 ${nodes.length} 个节点（${names}${nodes.length > 3 ? '…' : ''}）。→ 调 get_neighbors 查看依赖`;
          }
          break;
        }
        case 'inspect_symbol': {
          try {
            const parsed = JSON.parse(result);
            if (parsed.community) {
              snippet = `社区归属: ${parsed.community}。→ 调 get_community 查看同社区节点`;
            }
          } catch {}
          break;
        }
        case 'git_diff': {
          const files = extractFilesFromDiffResult(result);
          if (files.length > 0) snippet = ctx.getSearchContext(files.slice(0, 3));
          break;
        }
        case 'run_shell': {
          const cmd = String(args['command'] || '');
          const isTest = /pytest|jest|cargo.test|npm.test|go.test|python.-m.pytest/.test(cmd);
          const isBuild = /npm.install|cargo.build|pip.install|make|cmake|npx|yarn/.test(cmd);

          if (isTest || isBuild) {
            const parsed = parseBuildOutput(cmd, result);
            if (parsed) {
              cacheBuildResult(parsed);
              snippet = parsed.outcome === 'pass'
                ? `✅ ${parsed.summary}`
                : `❌ ${parsed.summary}`;
            } else {
              // Fallback: output format not recognized, cache a generic result
              // so the agent knows the command ran — just can't parse the outcome
              const label = cmd.split(' ').slice(0, 2).join(' ');
              const tail = result.slice(-200).replace(/\n/g, ' ');
              cacheBuildResult({ command: label, outcome: 'pass', summary: `完成 (输出未解析)`, ts: Date.now() });
              snippet = `⚠️ 完成，但无法解析输出格式。尾部: ${tail}`;
            }
          }
          break;
        }
        // ── LSP tools: inject graph context from resolution results ──
        case 'resolve_call': {
          try {
            const parsed = JSON.parse(result);
            if (parsed.resolved && Array.isArray(parsed.resolved) && parsed.resolved.length > 0) {
              const top = parsed.resolved.slice(0, 3);
              const names = top.map((r: any) => `\`${r.callee_qn}\``).join(', ');
              snippet = `解析到 ${parsed.resolved.length} 个调用目标: ${names}${parsed.resolved.length > 3 ? '…' : ''}。`;
              // Check graph for callee impact
              const fp = String(args['file_path'] || '');
              if (fp && parsed.resolved[0].callee_qn) {
                snippet += ` → 调 trace_impact "${parsed.resolved[0].callee_qn}" 看下游`;
              }
            }
          } catch {}
          break;
        }
        case 'infer_type': {
          try {
            const parsed = JSON.parse(result);
            if (parsed.type_name) {
              snippet = `类型: \`${parsed.type_name}\`${parsed.def_module ? ` (${parsed.def_module})` : ''}。→ 调 search_symbols 找同类型相关的符号`;
            }
          } catch {}
          break;
        }
        case 'find_implementations': {
          try {
            const parsed = JSON.parse(result);
            const impls = parsed.implementations;
            if (impls && Array.isArray(impls) && impls.length > 0) {
              const count = impls.length;
              const names = impls.slice(0, 3).map((i: any) => `\`${i.name || i.qualified_name || '?'}\``).join(', ');
              snippet = `找到 ${count} 个实现: ${names}${count > 3 ? '…' : ''}。→ 调 get_neighbors 查看完整继承树`;
            }
          } catch {}
          break;
        }
        case 'find_references': {
          try {
            const parsed = JSON.parse(result);
            const refs = parsed.references;
            if (refs && Array.isArray(refs) && refs.length > 0) {
              const count = refs.length;
              // Extract unique files from references
              const refFiles = new Set<string>();
              for (const r of refs) {
                if (r.file) refFiles.add(r.file);
                if (refFiles.size >= 5) break;
              }
              snippet = `找到 ${count} 个引用，分布在 ${refFiles.size} 个文件中。`;
              if (refFiles.size >= 3) {
                snippet += ` 跨文件影响面大 → 调 trace_impact 评估变更风险`;
              }
            }
          } catch {}
          break;
        }
      }

      if (snippet && snippet.length > 0) {
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
// State hooks — inject self-maintaining project facts into tool results.
// Data sources: LSP diagnostics, Git status/blame, Check/briefing.
// ═══════════════════════════════════════════════════════════════

import {
  buildPreReadBlock,
  formatDiagnostics,
  refreshGitBlame,
  refreshGitStatus,
  cacheBuildResult,
} from './state-inject';

const MAX_STATE_BYTES = 600;

/** Pre-read hook — injects diagnostics + blame when agent reads a file. */
export function createStateReadHook(projectPath: string): Hook {
  return {
    name: 'state-read',
    shouldEnrich(toolName) {
      return toolName === 'read_file_content';
    },
    async enrich(_toolName, args, result) {
      const filePath = (args.file_path as string) || '';
      if (!filePath) return result;

      // Fire-and-forget: refresh blame for next time
      refreshGitBlame(projectPath, filePath).catch(() => {});

      const block = buildPreReadBlock(filePath);
      if (!block) return result;

      const full = `📋 [状态] ${block}\n${'─'.repeat(40)}\n\n`;
      if (result.length + full.length <= MAX_RESULT_BYTES) {
        return full + result;
      }
      return result;
    },
  };
}

/** Preflight hook — adds diagnostics context before editing a file. */
export function createStatePreflightHook(): PreflightHook {
  return {
    name: 'state-preflight',
    shouldCheck(toolName) {
      return ['edit_file', 'write_file_content'].includes(toolName);
    },
    check(_toolName, args) {
      const filePath = (args.file_path as string) || '';
      if (!filePath) return null;
      return formatDiagnostics(filePath);
    },
  };
}

// ── Helpers ──

// ── Build/test output parser ──

/** Parse stdout/stderr from a build or test command into a structured result. */
function parseBuildOutput(cmd: string, output: string): { command: string; outcome: 'pass' | 'fail'; summary: string; ts: number } | null {
  const label = cmd.split(' ').slice(0, 2).join(' '); // "cargo build", "npm test"
  const ts = Date.now();

  // Cargo build
  if (/cargo\s+build/.test(cmd)) {
    const errors = (output.match(/^error(\[|:)/gm) || []).length;
    if (errors > 0) return { command: label, outcome: 'fail', summary: `${errors} errors`, ts };
    if (/Finished\s+dev/.test(output) || /Finished\s+release/.test(output)) return { command: label, outcome: 'pass', summary: '编译通过', ts };
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
    if (failed && parseInt(failed[1]) > 0) return { command: label, outcome: 'fail', summary: `${failed[1]} failed`, ts };
    const passed = output.match(/(\d+)\s+passed/);
    if (passed) return { command: label, outcome: 'pass', summary: `${passed[1]} passed`, ts };
    return null;
  }

  // Generic build (make, cmake, npm install, pip, yarn)
  if (/make|cmake|npm\s+install|pip\s+install|npx|yarn/.test(cmd)) {
    const errors = (output.match(/^error(\[|:)/gm) || []).length + (output.match(/\bERROR\b/g) || []).length;
    if (errors > 0) return { command: label, outcome: 'fail', summary: `${errors} errors`, ts };
    const warnings = (output.match(/\bwarning\b/gi) || []).length;
    if (/^(npm |yarn )/.test(cmd) && output.includes('added')) return { command: label, outcome: 'pass', summary: '安装完成', ts };
    if (warnings > 0) return { command: label, outcome: 'pass', summary: `完成 (${warnings} warnings)`, ts };
    return { command: label, outcome: 'pass', summary: '完成', ts };
  }

  return null;
}

// ── search_content → 图谱符号交叉匹配 ──

interface SearchGraphSymbol {
  name: string;
  fanIn: number;
  fanOut: number;
  file: string;
}

/** Extract identifier-like words from a line of code. */
function extractIdentifiers(text: string): string[] {
  const m = text.match(/\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g);
  if (!m) return [];
  return [...new Set(m)];
}

/** Cross-reference search_content matches with fileIndex: which matched
 *  identifiers are known graph symbols? Returns top 5 matches sorted by fanIn. */
function extractGraphSymbolsFromSearch(
  result: string,
  getNodes: (fp: string) => NodeBrief[],
): SearchGraphSymbol[] {
  try {
    const parsed = JSON.parse(result);
    const matches = parsed.matches || parsed.results || [];
    if (!Array.isArray(matches)) return [];

    const seen = new Set<string>();
    const symbols: SearchGraphSymbol[] = [];

    for (const m of matches) {
      const file = m.file || '';
      if (!file) continue;

      // Extract identifiers from matched content
      const content = m.match_content || m.content || m.line || '';
      const idents = extractIdentifiers(content);

      // Get symbols in this file from the in-memory fileIndex
      const fileNodes = getNodes(file);
      if (fileNodes.length === 0) continue;

      // Cross-reference: which identifiers are actual graph symbols?
      for (const n of fileNodes) {
        if (idents.includes(n.name) && !seen.has(n.name)) {
          seen.add(n.name);
          symbols.push({ name: n.name, fanIn: n.fanIn, fanOut: n.fanOut, file });
          if (symbols.length >= 5) {
            symbols.sort((a, b) => b.fanIn - a.fanIn);
            return symbols;
          }
        }
      }
    }
    symbols.sort((a, b) => b.fanIn - a.fanIn);
    return symbols.slice(0, 5);
  } catch {
    return [];
  }
}

function extractFilesFromSearchResult(result: string): string[] {
  try {
    const parsed = JSON.parse(result);
    if (parsed.matches && Array.isArray(parsed.matches)) {
      const files = new Set<string>();
      for (const m of parsed.matches) {
        if (m.file) files.add(m.file);
        if (files.size >= 5) break;
      }
      return [...files];
    }
  } catch { /* not JSON, ignore */ }
  return [];
}

// ── 辅助解析函数（供 GraphContextHook enrich 使用）──

function extractFilesFromGlobResult(result: string): string[] {
  const lines = result.split('\n').map(l => l.trim()).filter(Boolean);
  // glob 输出格式：每行一个文件路径
  return lines.filter(l => /\.(ts|rs|py|js|tsx|jsx|go|java|cpp|c|h|hpp)$/i.test(l)).slice(0, 5);
}

function extractSourceFilesFromDirList(result: string): string[] {
  const files: string[] = [];
  const lines = result.split('\n');
  for (const line of lines) {
    const pathMatch = line.match(/path:\s*(\S+)/i);
    const typeMatch = line.match(/type:\s*file/i);
    if (pathMatch && typeMatch) {
      const fp = pathMatch[1];
      if (/\.(ts|rs|py|js|tsx|jsx|go|java|cpp|c|h|hpp)$/i.test(fp)) {
        files.push(fp);
        if (files.length >= 5) break;
      }
    }
  }
  return files;
}

function extractSharedVarsFromDataflow(result: string): string[] {
  try {
    const parsed = JSON.parse(result);
    if (parsed.shared_state && Array.isArray(parsed.shared_state)) {
      return parsed.shared_state.map((s: any) => s.var || '').filter(Boolean).slice(0, 5);
    }
  } catch {}
  return [];
}

function extractNodesFromSearchResult(result: string): { name: string }[] {
  try {
    const parsed = JSON.parse(result);
    const arr = parsed.results || parsed.matches || [];
    if (Array.isArray(arr)) {
      return arr.map((r: any) => ({ name: r.name || r.id || '' })).filter(n => n.name).slice(0, 5);
    }
  } catch {}
  return [];
}

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
  fanIn: Map<string, number>,
  fanOut: Map<string, number>,
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

    // Downstream: who depends on this file's symbols
    const downstream = [...nodes]
      .filter(n => n.fanIn > 0)
      .sort((a, b) => b.fanIn - a.fanIn)
      .slice(0, 5);
    // Upstream: what this file's symbols depend on
    const upstream = [...nodes]
      .filter(n => n.fanOut > 0)
      .sort((a, b) => b.fanOut - a.fanOut)
      .slice(0, 3);

    let summary = `此文件 ${nodes.length} 个符号。`;
    if (downstream.length > 0) {
      summary += ` 下游依赖: ${downstream.map(n => `\`${n.name}\`(${n.fanIn})`).join(', ')}。`;
    }
    if (upstream.length > 0) {
      summary += ` | 依赖上游: ${upstream.map(n => `\`${n.name}\`(${n.fanOut})`).join(', ')}。`;
    }
    if (downstream.length > 0) {
      summary += ` → 改 \`${downstream[0].name}\` 前调 trace_impact`;
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
        const names = top3.map(n => `\`${n.name}\``).join(', ');
        parts.push(`${fileName}: ${nodes.length}符号${deps.length > 0 ? ` [${deps.join(' ')}]` : ''} — ${names}`);
      }
    }
    if (parts.length === 0) return null;
    let summary = `匹配文件 — ${parts.join(' | ')}。`;
    if (files.length >= 2) {
      summary += ` ${files.length} 个文件, 扇入合计 ${totalFanIn}, 扇出合计 ${totalFanOut}。`;
      if (totalFanIn >= 10 || totalFanOut >= 10) {
        summary += ` → 跨文件耦合较高, 调 explore_deps 追踪文件间依赖`;
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
        const branch = String(args['branch'] || '');
        return [
          `⚠️ [切换分支] 即将切换到 \`${branch}\`。`,
          `│  切换前请确认当前工作区已提交或暂存，避免丢失未保存的修改。`,
          `│  → 先用 git_status 确认状态，必要时 git_stash_push 暂存。`,
        ].join('\n');
      }

      // ── git_commit: 无具体文件，通用警告 ──
      if (toolName === 'git_commit') {
        return [
          `⚠️ [提交] 即将创建提交。`,
          `│  → 先用 git_diff --staged 确认暂存区变更。`,
          `│  → 若涉及核心模块，建议调 trace_impact 检查波及范围后再推送。`,
        ].join('\n');
      }

      // ── git_discard: 拼接 repo 根 + 相对路径 ──
      let fp: string;
      if (toolName === 'git_discard') {
        const repoPath = String(args['path'] || '');
        const file = String(args['file'] || '');
        fp = repoPath ? `${repoPath.replace(/\\/g, '/')}/${file}` : file;
      } else {
        fp = String(args['filePath'] || args['file_path'] || '');
      }

      if (!fp) return null;

      const nodes = ctx.getNodesInFile(fp);
      if (nodes.length === 0) return null;

      const totalFanIn = nodes.reduce((sum, n) => sum + n.fanIn, 0);
      const topSymbols = [...nodes]
        .filter(n => n.fanIn > 0)
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

      if (riskLevel.trim() !== 'LOW') {
        const topName = topSymbols[0].name;
        lines.push(`│  → ${verb}前建议调 trace_impact "${topName}" 查看完整波及范围`);
      }

      // ── Engine-layer data: fragility rank, cycles, session drift ──
      if (ctx.engine) {
        const eng = ctx.engine;
        const normFp = fp.replace(/\\/g, '/').toLowerCase();
        const rankEntry = eng.fragilityRanks.find(r =>
          r.file.replace(/\\/g, '/').toLowerCase().includes(normFp) ||
          normFp.includes(r.file.replace(/\\/g, '/').toLowerCase())
        );
        if (rankEntry || eng.cycleCount > 0 || eng.sessionDrift > 0) {
          lines.push(`│`);
          lines.push(`│  ── 引擎层数据 ──`);
          if (rankEntry) {
            lines.push(`│  脆弱度排名: #${eng.fragilityRanks.indexOf(rankEntry) + 1} (${rankEntry.score.toFixed(0)})`);
          }
          if (eng.cycleCount > 0) {
            lines.push(`│  项目循环依赖: ${eng.cycleCount} 个`);
          }
          if (eng.sessionDrift > 0) {
            const driftPct = (eng.sessionDrift * 100).toFixed(1);
            lines.push(`│  会话累积退化: +${driftPct}%`);
            if (eng.sessionDrift > 0.1) {
              riskLevel = 'HIGH   ';
              lines.push(`│  ⚠ 累积退化超过 10%，门禁升级为 HIGH`);
            }
          }
          lines.push(`│  耦合健康度: ${eng.healthScore}/100`);

          // ── LSP hotspots ──
          if (eng.lspHotspots.length > 0) {
            const fileHit = eng.lspHotspots.filter(h =>
              h.file.replace(/\\/g, '/').toLowerCase().includes(normFp) ||
              normFp.includes(h.file.replace(/\\/g, '/').toLowerCase())
            );
            if (fileHit.length > 0) {
              lines.push(`│  LSP 调用热点:`);
              for (const h of fileHit.slice(0, 3)) {
                lines.push(`│  • ${h.symbol} — ~${h.callers} 调用者`);
              }
            }
          }

          // ── Synthesis alerts ──
          if (eng.synthesisAlerts.length > 0) {
            lines.push(`│  合成引擎: ${eng.synthesisAlerts.map(a => `${a.type}(${a.count})`).join(', ')}`);
          }
        }
      }

      return lines.join('\n');
    },
  };
}