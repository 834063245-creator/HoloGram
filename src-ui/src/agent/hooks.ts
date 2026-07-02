// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Hooks —— Agent 调工具时自动注入图上下文
//
// 两层架构：
//   1. PreflightHook（pre-tool）：edit_file / write_file 之前 → ⚠️ 警告注入结果顶部
//   2. GraphContextHook（post-tool）：read_file / search_code 之后 → 📊 符号概览注入结果顶部
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

// ── GraphContextHook（post-tool，结果顶部注入）──

const MAX_ENRICH_BYTES = 800;
const MAX_RESULT_BYTES = 30_000; // leave 2KB headroom below 32KB

export function createGraphContextHook(ctx: GraphContext): Hook {
  return {
    name: 'graph-context',

    shouldEnrich(toolName: string): boolean {
      // edit_file / write_file 由 preflight hook 处理，此处不重复
      return ['read_file_content', 'read_file', 'search_code', 'run_shell'].includes(toolName);
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
            // If file has functions, suggest dataflow trace
            const nodes = ctx.getNodesInFile(fp);
            const hasFuncs = nodes.some(n => n.kind === 'function' || n.kind === 'method');
            if (hasFuncs && snippet) {
              snippet += ' 共享变量/异步链 → hologram_dataflow 追踪。';
            }
          }
          break;
        }
        case 'search_code': {
          const files = extractFilesFromSearchResult(result);
          if (files.length > 0) snippet = ctx.getSearchContext(files.slice(0, 3));
          break;
        }
        case 'run_shell': {
          const cmd = String(args['command'] || '');
          if (/pytest|jest|cargo.test|npm.test|go.test|python.-m.pytest/.test(cmd)) {
            snippet = '🧪 测试完成后建议: 1) hologram_run_check 查看简报 2) hologram_impact 检查变更波及范围';
          }
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
      `\`${n.name}\`(${n.kind || 'symbol'}) — ${n.fanIn} downstream`
    );

    let summary = `此文件 ${nodes.length} 个符号。${
      sorted.length > 0 ? `被依赖最多：${parts.join(', ')}。` : ''
    }`;
    if (sorted.length > 0) {
      summary += ` → 要看 \`${sorted[0].name}\` 的依赖链，调 hologram_explore "${sorted[0].name}"`;
    }
    return summary;
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

// ── GraphPreflightHook —— 写操作前自动影响分析 ──
//
// edit_file / write_file 触发时，用内存 fileIndex 即时评估：
//   1. 该文件有多少符号被外部依赖
//   2. 被依赖最多的 top 5 符号
//   3. 风险等级（LOW / MEDIUM / HIGH）
//   4. 引导 Agent 调 hologram_impact 深挖（MEDIUM+ 时）
//
// 耗时 < 0.1ms，数据全在内存，不额外调 MCP。

export function createGraphPreflightHook(ctx: GraphContext): PreflightHook {
  return {
    name: 'graph-preflight',

    shouldCheck(toolName: string): boolean {
      return ['edit_file', 'write_file', 'write_file_content',
              'delete_file_or_dir', 'rename_file_or_dir', 'move_file'].includes(toolName);
    },

    check(toolName: string, args: Record<string, unknown>): string | null {
      const fp = String(args['filePath'] || args['file_path'] || '');
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

      const lines = [
        `⚠️ [自动影响分析] 即将修改 \`${fileName}\``,
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
        lines.push(`│  → 修改前建议调 hologram_impact "${topName}" 查看完整波及范围`);
      }

      return lines.join('\n');
    },
  };
}
