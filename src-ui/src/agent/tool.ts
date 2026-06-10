// Tool 系统 — Tool 接口 + Registry 注册表 + Hologram 工具定义

import type { ToolSchema } from '../provider/types';

// ---- Tool 接口 ----

/** A Tool is one callable tool the agent can dispatch. */
export interface Tool {
  /** Machine name, e.g. "hologram_fragile" */
  name(): string;
  /** Human-readable description for the model */
  description(): string;
  /** JSON Schema for the arguments */
  parameters(): Record<string, unknown>;
  /** Whether this tool is read-only (safe to parallelize) */
  readOnly(): boolean;
  /** Execute the tool with raw JSON arguments. Returns the result string. */
  execute(args: Record<string, unknown>): Promise<string>;
}

// ---- Tool Registry ----

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(t: Tool): void {
    if (this.tools.has(t.name())) {
      throw new Error(`ToolRegistry: duplicate tool "${t.name()}"`);
    }
    this.tools.set(t.name(), t);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  schemas(): ToolSchema[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name(),
      description: t.description(),
      parameters: t.parameters(),
    }));
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }
}

// ---- Hologram 工具定义 (13 tools → Python engine) ----

/** Tool executor: invokes Tauri commands → Python engine. Override for non-Tauri env. */
export type ToolExecutor = (toolName: string, args: Record<string, unknown>) => Promise<string>;

export function createHologramTools(exec: ToolExecutor): Tool[] {
  return [
    {
      name: () => 'hologram_analyze',
      description: () =>
        'Run a full graph analysis on a code directory. Returns the complete dependency graph as structured JSON (nodes + edges). Zero-config. Use this first to get the lay of the land.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path to analyze (defaults to current working directory)',
          },
          language: {
            type: 'string',
            enum: ['python', 'typescript', 'auto'],
            description: 'Language to analyze (default: auto-detect)',
          },
        },
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_analyze', args),
    },
    {
      name: () => 'hologram_neighbors',
      description: () =>
        'Get the neighborhood of a node in the dependency graph. Returns the node, its direct dependencies, and dependents — the 1-hop subgraph.',
      parameters: () => ({
        type: 'object',
        properties: {
          node_id: { type: 'string', description: 'The node identifier (function/class/module name)' },
          depth: { type: 'integer', description: 'Neighbor depth (default: 1)', default: 1 },
        },
        required: ['node_id'],
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_neighbors', args),
    },
    {
      name: () => 'hologram_impact',
      description: () =>
        'Map the blast radius of a change. Starting from a node, trace all downstream dependents recursively. Returns the complete impact tree.',
      parameters: () => ({
        type: 'object',
        properties: {
          node_id: { type: 'string', description: 'The node to analyze impact for' },
          max_depth: { type: 'integer', description: 'Maximum depth to trace (default: unlimited)', default: 0 },
        },
        required: ['node_id'],
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_impact', args),
    },
    {
      name: () => 'hologram_path',
      description: () =>
        'Find the shortest dependency path between two nodes. Shows how A depends on B through the chain of intermediate nodes.',
      parameters: () => ({
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source node identifier' },
          to: { type: 'string', description: 'Target node identifier' },
        },
        required: ['from', 'to'],
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_path', args),
    },
    {
      name: () => 'hologram_fragile',
      description: () =>
        'Find the most fragile modules in the codebase — those with the highest coupling depth (L4 = encapsulation violations), most incoming dependencies (high fan-in), and most data flow cycles. Returns a ranked list.',
      parameters: () => ({
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Number of top fragile modules to return (default: 10)', default: 10 },
        },
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_fragile', args),
    },
    {
      name: () => 'hologram_cycle',
      description: () =>
        'Detect data-flow cycles and strong coupling loops in the dependency graph. Returns all cycles with their coupling depth classification.',
      parameters: () => ({
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['all', 'critical'],
            description: 'Show all cycles or only critical ones (L3-L4, module-level) (default: all)',
            default: 'all',
          },
        },
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_cycle', args),
    },
    {
      name: () => 'hologram_coupling_report',
      description: () =>
        'Get a detailed coupling report for a specific module. Returns coupling depth (L1-L4), fan-in/fan-out counts, cycle participation, and fragility score.',
      parameters: () => ({
        type: 'object',
        properties: {
          module: { type: 'string', description: 'Module name to analyze' },
        },
        required: ['module'],
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_coupling_report', args),
    },
    {
      name: () => 'hologram_blindspots',
      description: () =>
        'Find boundary blindspots — nodes that bridge module/package boundaries without explicit imports, dynamic dispatch patterns, and other runtime coupling the static analyzer might miss.',
      parameters: () => ({
        type: 'object',
        properties: {
          threshold: {
            type: 'number',
            description: 'Confidence threshold for flagging (0.0-1.0, default: 0.5)',
            default: 0.5,
          },
        },
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_blindspots', args),
    },
    {
      name: () => 'hologram_thread_conflicts',
      description: () =>
        'Detect potential thread/async conflicts — shared-memory writes without synchronization, concurrent data structure access, race condition patterns.',
      parameters: () => ({
        type: 'object',
        properties: {
          severity: {
            type: 'string',
            enum: ['all', 'high', 'medium'],
            description: 'Minimum severity to report (default: high)',
            default: 'high',
          },
        },
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_thread_conflicts', args),
    },
    {
      name: () => 'hologram_timeline',
      description: () =>
        'Query the causal audit timeline (SQLite). Returns a chronological record of changes with their affected nodes and impact estimates. V2 feature.',
      parameters: () => ({
        type: 'object',
        properties: {
          since: {
            type: 'string',
            description: 'ISO timestamp filter (e.g. "2025-06-01T00:00:00Z")',
          },
          limit: { type: 'integer', description: 'Max entries (default: 50)', default: 50 },
          module: { type: 'string', description: 'Filter by module name' },
        },
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_timeline', args),
    },
    {
      name: () => 'hologram_diff',
      description: () =>
        'Diff two snapshots of the dependency graph. Returns added/removed/modified nodes and edges. Useful for understanding the impact of a change.',
      parameters: () => ({
        type: 'object',
        properties: {
          before_path: {
            type: 'string',
            description: 'Path to the baseline graph JSON',
          },
          after_path: {
            type: 'string',
            description: 'Path to the updated graph JSON (omit to compare against live analysis)',
          },
        },
        required: ['before_path'],
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_diff', args),
    },
    {
      name: () => 'hologram_community_report',
      description: () =>
        'Report on community/cluster structure in the codebase. Uses Leiden algorithm for community detection. Shows which modules naturally cluster together.',
      parameters: () => ({
        type: 'object',
        properties: {
          resolution: {
            type: 'number',
            description: 'Leiden resolution parameter (higher = more, smaller communities; default: 1.0)',
            default: 1.0,
          },
          min_size: {
            type: 'integer',
            description: 'Minimum community size to report (default: 3)',
            default: 3,
          },
        },
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_community_report', args),
    },
    {
      name: () => 'hologram_graph_summary',
      description: () =>
        'Get a high-level summary of the current dependency graph: total nodes/edges, node type distribution, edge type distribution, top-level modules, and graph density.',
      parameters: () => ({
        type: 'object',
        properties: {},
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_graph_summary', args),
    },
    {
      name: () => 'hologram_run_check',
      description: () =>
        'Run full constraint validation (V3) on the current project. Re-analyzes the codebase, generates L5-L1 signals, checks against constraints, and returns a change summary with violations grouped by severity level. Use this when the user asks "检查一下" or "有没有问题" or "跑一遍约束".',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Project root directory path (use the current project path)',
          },
        },
        required: ['path'],
      }),
      readOnly: () => false,
      execute: (args) => exec('hologram_run_check', args),
    },
    {
      name: () => 'hologram_run_preflight',
      description: () =>
        'Pre-flight check (V3): analyze what would happen if the given files change. Runs impact BFS, checks coupling depth, community cross-edges, and cycle detection. Returns risk level (low/medium/high/critical) and warnings. Use BEFORE making changes — "先看看改这里会怎样" or "这个改动安全吗？"',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Project root directory path (use the current project path)',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of file paths that would be changed',
          },
        },
        required: ['path'],
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_run_preflight', args),
    },
    {
      name: () => 'hologram_run_health',
      description: () =>
        'Project health report (V3): aggregates timeline change history and coupling depth snapshot to compute a health score (0-100), trends (coupling/cycles/change frequency), top changed files, and most fragile modules. Use when the user asks "项目健康吗？" or "最近的趋势怎么样？"',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Project root directory path (use the current project path)',
          },
          days: {
            type: 'integer',
            description: 'Number of days to look back for trends (default 30)',
          },
        },
        required: ['path'],
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_run_health', args),
    },
    {
      name: () => 'read_file_content',
      description: () =>
        'Read the content of a file on disk. Returns the full text content. Use to inspect source code files when analyzing dependencies or investigating violations.',
      parameters: () => ({
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Absolute path to the file to read',
          },
        },
        required: ['filePath'],
      }),
      readOnly: () => true,
      execute: (args) => exec('read_file_content', args),
    },
    {
      name: () => 'read_constraints',
      description: () =>
        'Read the current constraint configuration (hologram.constraints.yaml) for the project. Returns the YAML content. Use to check routing rules, thresholds, and allowlist/denylist settings.',
      parameters: () => ({
        type: 'object',
        properties: {
          projectPath: {
            type: 'string',
            description: 'Project root directory path',
          },
        },
        required: ['projectPath'],
      }),
      readOnly: () => true,
      execute: (args) => exec('read_constraints', args),
    },
    {
      name: () => 'hologram_history',
      description: () =>
        'Get the decision history for a specific node — what past changes involved this node, its dependency count (fan-in), and dependent count (fan-out). Use when asked about a node\'s change history or stability.',
      parameters: () => ({
        type: 'object',
        properties: {
          node_id: { type: 'string', description: 'The node ID or name to query history for' },
        },
        required: ['node_id'],
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_history', args),
    },
    {
      name: () => 'hologram_community',
      description: () =>
        'Get community/cluster membership for a specific node. Returns the galaxy it belongs to and its sibling nodes (other nodes in the same community). Use when asked "which group does this module belong to?" or "what modules are closely related to this one?"',
      parameters: () => ({
        type: 'object',
        properties: {
          node_id: { type: 'string', description: 'The node ID or name to query' },
        },
        required: ['node_id'],
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_community', args),
    },
    {
      name: () => 'hologram_delayed',
      description: () =>
        'List all edges with temporal/async delays in the graph. Returns realtime (0 delay) and periodic (non-zero delay) edges separately. Use when asked about async calls, scheduled tasks, or temporal coupling patterns.',
      parameters: () => ({
        type: 'object',
        properties: {},
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_delayed', {}),
    },
    {
      name: () => 'hologram_changes',
      description: () =>
        'Get the most recent change recorded in the timeline — what was changed, impact count, affected nodes, and commit hash. Use when asked "what changed last?" or "what was the last commit\'s impact?"',
      parameters: () => ({
        type: 'object',
        properties: {},
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_changes', {}),
    },
  ];
}
