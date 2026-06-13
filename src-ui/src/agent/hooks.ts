// PreToolUse Hooks —— Agent 调工具时自动注入图上下文
//
// Agent 调 read_file / search_code / edit_file / run_shell 时，
// 在结果末尾附上依赖图数据，Agent 不用手动查 hologram 工具。
//
// 设计约束：
//   - 单条注入 < 800 字符，避免膨胀 token
//   - 结果接近 32KB 上限时跳过注入
//   - Hook 崩溃静默降级，绝不影响工具结果

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

// ── GraphContext —— 图数据查询接口 ──

export interface GraphContext {
  getNodesInFile(filePath: string): NodeBrief[];
  getImpactSummary(filePath: string): string | null;
  getSearchContext(files: string[]): string | null;
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

// ── GraphContextHook ──

const MAX_ENRICH_BYTES = 800;
const MAX_RESULT_BYTES = 30_000; // leave 2KB headroom below 32KB

export function createGraphContextHook(ctx: GraphContext): Hook {
  return {
    name: 'graph-context',

    shouldEnrich(toolName: string): boolean {
      return ['read_file_content', 'search_code', 'edit_file', 'run_shell'].includes(toolName);
    },

    async enrich(toolName: string, args: Record<string, unknown>, result: string): Promise<string> {
      // Skip if result too large or looks like an error
      if (result.length > MAX_RESULT_BYTES) return result;
      if (/^(error|Error|❌)/.test(result.trimStart())) return result;

      let snippet: string | null = null;

      switch (toolName) {
        case 'read_file_content': {
          const fp = String(args['filePath'] || args['file_path'] || '');
          if (fp) snippet = ctx.getImpactSummary(fp);
          break;
        }
        case 'search_code': {
          // Extract unique file paths from JSON result
          const files = extractFilesFromSearchResult(result);
          if (files.length > 0) snippet = ctx.getSearchContext(files.slice(0, 3));
          break;
        }
        case 'edit_file': {
          const fp = String(args['filePath'] || args['file_path'] || '');
          if (fp) snippet = ctx.getImpactSummary(fp);
          break;
        }
        case 'run_shell': {
          const cmd = String(args['command'] || '');
          if (/pytest|jest|cargo.test|npm.test|go.test|python.-m.pytest/.test(cmd)) {
            snippet = '[Hint] 测试跑完后可以用 hologram_impact 检查最近修改的波及范围。';
          }
          break;
        }
      }

      if (snippet && snippet.length > 0) {
        const block = `\n\n[GraphContext] ${snippet}`;
        // Ensure we don't exceed limit
        if (result.length + block.length <= MAX_RESULT_BYTES) {
          return result + block;
        }
      }
      return result;
    },
  };
}

// ── Helpers ──

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

// ── GraphContext 实现（基于 fileIndex） ──

export function createGraphContext(
  fileIndex: Map<string, NodeBrief[]>,
  fanIn: Map<string, number>,
  fanOut: Map<string, number>,
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

    // Top symbols by fan-in (most depended-on)
    const sorted = [...nodes].sort((a, b) => b.fanIn - a.fanIn).slice(0, 5);
    const parts = sorted.map(n =>
      `\`${n.name}\`(${n.kind || 'symbol'}) — ${n.fanIn} dependents`
    );

    return `此文件包含 ${nodes.length} 个符号。${
      sorted.length > 0 ? `被依赖最多的：${parts.join(', ')}。` : ''
    }用 hologram_neighbors(id) 查看任意符号的关联。`;
  }

  function getSearchContext(files: string[]): string | null {
    const parts: string[] = [];
    for (const fp of files) {
      const nodes = getNodesInFile(fp);
      if (nodes.length > 0) {
        const top3 = nodes.sort((a, b) => b.fanIn - a.fanIn).slice(0, 3);
        const names = top3.map(n => `\`${n.name}\``).join(', ');
        const fileName = fp.replace(/\\/g, '/').split('/').pop() || fp;
        parts.push(`${fileName}: ${names}`);
      }
    }
    if (parts.length === 0) return null;
    return `匹配文件中的关键符号 — ${parts.join(' | ')}。`;
  }

  return { getNodesInFile, getImpactSummary, getSearchContext };
}
