import { describe, expect, it } from 'vitest';
import { GRAPH_ENRICH_TOOLS, GRAPH_PREFLIGHT_TOOLS } from '../src/agent/hooks';
import type { ToolExecutor } from '../src/agent/tool';
import { createCodingTools, ToolRegistry } from '../src/agent/tool';

// ── 单一事实来源：工具名交叉验证 ──
// 任何人在 tool.ts 里改了名字，或在 hooks.ts 里加了名字但没注册工具，
// 测试直接炸。不再靠脑子记。

/** 从 createCodingTools 提取所有工具名 */
function extractCodingToolNames(): Set<string> {
  const exec: ToolExecutor = async () => '';
  const tools = createCodingTools(exec);
  return new Set(tools.map((t) => t.name()));
}

/** 已知的 hologram 引擎工具名（hologram_tools_list 动态返回的） */
const HOLOGRAM_TOOL_NAMES = new Set([
  'explore_deps',
  'analyze_project',
  'get_neighbors',
  'trace_impact',
  'find_dep_path',
  'fragile_modules',
  'detect_cycles',
  'coupling_report',
  'arch_blindspots',
  'thread_conflicts',
  'project_timeline',
  'graph_diff',
  'cluster_report',
  'graph_summary',
  'validate_project',
  'preflight_check',
  'project_health',
  'get_community',
  'async_edges',
  'search_symbols',
  'inspect_symbol',
  'find_unused',
  'trace_dataflow',
  'resolve_call',
  'infer_type',
  'find_implementations',
  'find_references',
  'rename_symbol',
  'engine_status',
  'check_boundaries',
  // memory tools
  'hologram_memory_list',
  'hologram_memory_read',
  'hologram_memory_save',
  'hologram_memory_delete',
  'hologram_memory_search',
  // task tools
  'hologram_task_create',
  'hologram_task_update',
  'hologram_task_list',
  // dataflow tools
  'dataflow_save',
  'dataflow_query',
  // agent tools
  'agent_spawn',
]);

/** 工具别名 — 模型可能吐出这些名字，ToolRegistry alias 会解析到实际工具 */
const ALIAS_NAMES = new Set([
  'read_file', // alias→read_file_content
  'symbol_history', // alias→inspect_symbol
]);

// ═══════════════════════════════════════════════════════
// 正向验证：每个 hook 常量里的名字，在工具注册表中真实存在
// ═══════════════════════════════════════════════════════

describe('tool name consistency — hooks vs registry', () => {
  const codingNames = extractCodingToolNames();
  const allNames = new Set([...codingNames, ...HOLOGRAM_TOOL_NAMES, ...ALIAS_NAMES]);

  it('GRAPH_ENRICH_TOOLS: 每个名字在 ToolRegistry 中真实存在', () => {
    const missing: string[] = [];
    for (const name of GRAPH_ENRICH_TOOLS) {
      if (!allNames.has(name)) missing.push(name);
    }
    if (missing.length > 0) {
      // 列出去掉的后缀，可能是 typo 或忘记注册
      const suggestions = missing.map((m) => {
        const near = [...allNames].filter((n) => n.includes(m.slice(-6)) || m.includes(n.slice(-6)));
        return `  "${m}" → 不存在。相近: ${near.slice(0, 3).join(', ') || '无'}`;
      });
      expect.fail(
        `以下 hook 常量中的工具名在 ToolRegistry 中不存在：\n${suggestions.join('\n')}\n` +
          '→ 改 hooks.ts 的 GRAPH_ENRICH_TOOLS，或在 tool.ts 注册同名工具。',
      );
    }
  });

  it('GRAPH_PREFLIGHT_TOOLS: 每个名字在 ToolRegistry 中真实存在', () => {
    const missing: string[] = [];
    for (const name of GRAPH_PREFLIGHT_TOOLS) {
      if (!allNames.has(name)) missing.push(name);
    }
    if (missing.length > 0) {
      const suggestions = missing.map((m) => {
        const near = [...allNames].filter((n) => n.includes(m.slice(-6)) || m.includes(n.slice(-6)));
        return `  "${m}" → 不存在。相近: ${near.slice(0, 3).join(', ') || '无'}`;
      });
      expect.fail(
        `以下 hook 常量中的工具名在 ToolRegistry 中不存在：\n${suggestions.join('\n')}\n` +
          '→ 改 hooks.ts 的 GRAPH_PREFLIGHT_TOOLS，或在 tool.ts 注册同名工具。',
      );
    }
  });

  // ═══════════════════════════════════════════════════════
  // 反向验证：注册为写的工具，preflight 名单里必须有
  // ═══════════════════════════════════════════════════════

  it('coding 写工具全部在 GRAPH_PREFLIGHT_TOOLS 中', () => {
    const writeTools = [
      'write_file',
      'edit_file',
      'delete_file',
      'rename_file',
      'move_file',
      'git_discard',
      'git_checkout',
      'git_commit',
    ];
    const preflightSet = new Set(GRAPH_PREFLIGHT_TOOLS);
    const missing = writeTools.filter((t) => !preflightSet.has(t));
    if (missing.length > 0) {
      expect.fail(
        `写工具 "${missing.join('", "')}" 不在 GRAPH_PREFLIGHT_TOOLS 中。\n` +
          '→ 新增写工具时必须也加到 hooks.ts 的 GRAPH_PREFLIGHT_TOOLS。',
      );
    }
  });

  // ═══════════════════════════════════════════════════════
  // 合理性验证：没有死名字（在常量中但不可能被触发的）
  // ═══════════════════════════════════════════════════════

  it('GRAPH_ENRICH_TOOLS 中没有重复', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const name of GRAPH_ENRICH_TOOLS) {
      if (seen.has(name)) dupes.push(name);
      seen.add(name);
    }
    expect(dupes).toEqual([]);
  });

  it('GRAPH_PREFLIGHT_TOOLS 中没有重复', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const name of GRAPH_PREFLIGHT_TOOLS) {
      if (seen.has(name)) dupes.push(name);
      seen.add(name);
    }
    expect(dupes).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════
// 常量导出完整性验证
// ═══════════════════════════════════════════════════════

describe('hook constants are exported and non-empty', () => {
  it('GRAPH_ENRICH_TOOLS 非空', () => {
    expect(GRAPH_ENRICH_TOOLS.length).toBeGreaterThan(0);
  });

  it('GRAPH_PREFLIGHT_TOOLS 非空', () => {
    expect(GRAPH_PREFLIGHT_TOOLS.length).toBeGreaterThan(0);
  });
});
