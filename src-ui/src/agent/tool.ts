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
          nodeId: { type: 'string', description: 'The node identifier (function/class/module name)' },
          depth: { type: 'integer', description: 'Neighbor depth (default: 1)', default: 1 },
        },
        required: ['nodeId'],
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
          nodeId: { type: 'string', description: 'The node to analyze impact for' },
          maxDepth: { type: 'integer', description: 'Maximum depth to trace (default: unlimited)', default: 0 },
        },
        required: ['nodeId'],
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
        'Rank modules by coupling depth (L1 same-module through L4 cross-boundary), fan-in count, and cycle participation. Returns a ranked list. High rank means high interconnection — well-designed hubs (auth, config, main entry points) are expected to rank high by design.',
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
            enum: ['all', 'data', 'llm'],
            description: 'Cycle filter: all=all cycles, data=data-persistent cycles, llm=LLM-involved cycles (default: all)',
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
        'Find cross-boundary edges — nodes connected across module/package boundaries through runtime mechanisms (dynamic dispatch, reflection, late binding) rather than static imports. Note: plugin systems and dependency injection frameworks produce these edges by design; they are not necessarily defects.',
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
          beforePath: {
            type: 'string',
            description: 'Path to the baseline graph JSON',
          },
          afterPath: {
            type: 'string',
            description: 'Path to the updated graph JSON (omit to compare against live analysis)',
          },
        },
        required: ['beforePath'],
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
          minSize: {
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
        'Run full constraint validation (V3) on the current project. Re-analyzes the codebase, checks against constraints, and returns results — including any violations found AND confirmation of rules that pass. Use when the user asks for a thorough project audit ("全面检查" or "跑一遍约束"). Do NOT run this for casual "check" questions; use lighter tools first.',
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
        'Project coupling overview (V3): aggregates timeline change history and coupling depth snapshot to compute a coupling density score (0-100), trends, top changed files, and most interconnected modules. Use when the user asks "项目最近怎么样？" or "最近的趋势怎么样？". Note: the score reflects coupling density, not code quality — different project stages have different normal ranges.',
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
        'Read the content of a file on disk. Returns the full text content by default. Use offset and limit to read a specific range of lines (0-indexed). Use to inspect source code files when analyzing dependencies or investigating violations.',
      parameters: () => ({
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Absolute path to the file to read',
          },
          offset: {
            type: 'integer',
            description: 'Line number to start reading from (0-indexed, default: 0)',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of lines to return (default: all lines)',
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
          nodeId: { type: 'string', description: 'The node ID or name to query history for' },
        },
        required: ['nodeId'],
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
          nodeId: { type: 'string', description: 'The node ID or name to query' },
        },
        required: ['nodeId'],
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
    {
      name: () => 'hologram_search',
      description: () =>
        'Fuzzy search for nodes by name or ID. Returns matching symbols with their IDs, types, and locations. Use this as the FIRST step when looking for a function/class/module but don\'t know its exact name or ID. Once you have the node ID, use hologram_neighbors for its dependencies.',
      parameters: () => ({
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Partial name or ID to search for (e.g. "auth", "parse", "Config")',
          },
          limit: {
            type: 'integer',
            description: 'Maximum results to return (default: 20)',
            default: 20,
          },
        },
        required: ['query'],
      }),
      readOnly: () => true,
      execute: (args) => exec('hologram_search', args),
    },
    {
      name: () => 'hologram_rename',
      description: () =>
        'Safely rename a symbol (function, class, method, variable) across the entire codebase. Uses the dependency graph to find ALL references — not text grep — so comments and string literals are never false positives. Updates all files atomically with rollback. Always run with dry_run=true first to preview changes before executing.',
      parameters: () => ({
        type: 'object',
        properties: {
          old_name: { type: 'string', description: 'Current name of the symbol to rename' },
          new_name: { type: 'string', description: 'New name for the symbol' },
          dry_run: { type: 'boolean', description: 'If true, preview changes without modifying files (default: true)', default: true },
          node_id: { type: 'string', description: 'Optional node ID for disambiguation when multiple symbols share the same name' },
        },
        required: ['old_name', 'new_name'],
      }),
      readOnly: () => false,
      execute: (args) => exec('hologram_rename', args),
    },
  ];
}

// ═══════════════════════════════════════════════════════
// MCP 动态工具工厂 — Step 1: 从 MCP tools/list 自动生成
// ═══════════════════════════════════════════════════════

/** MCP tools/list 返回的 schema 格式（inputSchema 而非 parameters）。 */
interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * 从 MCP Server 的工具列表动态创建 Tool 对象。
 * 老硬编码 createHologramTools() 保留作 CLI fallback。
 */
export function createHologramToolsFromSchemas(schemas: McpToolSchema[], exec: ToolExecutor): Tool[] {
  return schemas.map((schema) => ({
    name: () => schema.name,
    description: () => schema.description,
    parameters: () => schema.inputSchema,
    readOnly: () => true,
    execute: (args: Record<string, unknown>) => exec(schema.name, args),
  }));
}

// ═══════════════════════════════════════════════════════
// Coding Tools — 文件 / Shell / 搜索 / Git / Web
// ═══════════════════════════════════════════════════════

export function createCodingTools(exec: ToolExecutor): Tool[] {
  return [
    // ── User Interaction ──
    {
      name: () => 'ask_user',
      description: () =>
        'Ask the user a question when you need clarification or confirmation before proceeding. Use when the request is ambiguous, you need to choose between approaches, or you need approval for a destructive action. Returns the user\'s answer.',
      parameters: () => ({
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to ask the user. Be specific about what you need to know.',
          },
          header: {
            type: 'string',
            description: 'Short label (max 12 chars) shown as a tag, e.g. "Confirm", "Approach", "File"',
          },
          options: {
            type: 'array',
            description: '2-4 predefined choices the user can pick from. Each option has a label and optional description.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Display text (1-5 words)' },
                description: { type: 'string', description: 'Explanation of what this option means' },
              },
              required: ['label', 'description'],
            },
          },
          multiSelect: {
            type: 'boolean',
            description: 'Set to true to allow selecting multiple options (default: false)',
            default: false,
          },
        },
        required: ['question', 'header', 'options'],
      }),
      readOnly: () => true,
      execute: async (args) => {
        const question = args.question as string;
        const header = args.header as string;
        const options = (args.options || []) as { label: string; description: string }[];
        const multiSelect = args.multiSelect === true;
        // Use a Promise to wait for user interaction
        return new Promise((resolve) => {
          const overlay = document.createElement('div');
          Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
            background: 'rgba(0,0,0,0.6)', zIndex: '9999',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          });
          const dialog = document.createElement('div');
          Object.assign(dialog.style, {
            background: 'var(--panel-bg, rgba(6,12,24,0.97))',
            border: '1px solid var(--panel-edge, rgba(54,82,128,0.35))',
            borderRadius: '12px', padding: '24px', maxWidth: '520px', minWidth: '320px',
            color: 'var(--starlight, #e2edff)', fontFamily: 'var(--font-mono, monospace)',
            boxShadow: '0 16px 64px rgba(0,0,0,0.5)',
          });
          const hdr = document.createElement('div');
          hdr.textContent = header;
          Object.assign(hdr.style, {
            fontSize: '11px', color: 'var(--signal, #68a8ff)', marginBottom: '8px',
            textTransform: 'uppercase', letterSpacing: '1px', fontWeight: '600',
          });
          const q = document.createElement('div');
          q.textContent = question;
          Object.assign(q.style, { fontSize: '14px', marginBottom: '16px', lineHeight: '1.5' });
          dialog.appendChild(hdr); dialog.appendChild(q);
          const btnContainer = document.createElement('div');
          Object.assign(btnContainer.style, {
            display: 'flex', flexDirection: 'column', gap: '6px',
          });
          const selected = new Set<number>();
          const done = () => {
            overlay.remove();
            if (multiSelect) {
              const chosen = options.filter((_, i) => selected.has(i)).map(o => o.label);
              resolve(JSON.stringify({ answers: chosen }));
            }
          };
          options.forEach((opt, idx) => {
            const btn = document.createElement('button');
            btn.textContent = opt.label;
            Object.assign(btn.style, {
              display: 'block', width: '100%', padding: '8px 14px', textAlign: 'left',
              fontSize: '13px', background: selected.has(idx) ? 'rgba(80,140,240,0.15)' : 'rgba(255,255,255,0.04)',
              border: selected.has(idx) ? '1px solid var(--signal, #68a8ff)' : '1px solid rgba(255,255,255,0.08)',
              borderRadius: '6px', color: 'var(--starlight-dim, #c9d1d9)', cursor: 'pointer',
            });
            if (opt.description) {
              btn.title = opt.description;
              const desc = document.createElement('div');
              desc.textContent = opt.description;
              Object.assign(desc.style, { fontSize: '10px', color: 'var(--text-muted, #6b7d90)', marginTop: '2px' });
              btn.appendChild(desc);
            }
            btn.addEventListener('click', () => {
              if (multiSelect) {
                if (selected.has(idx)) { selected.delete(idx); } else { selected.add(idx); }
                btn.style.background = selected.has(idx) ? 'rgba(80,140,240,0.15)' : 'rgba(255,255,255,0.04)';
                btn.style.border = selected.has(idx) ? '1px solid var(--signal, #68a8ff)' : '1px solid rgba(255,255,255,0.08)';
                // Show a "Confirm" button if any selected
                const existing = btnContainer.querySelector('.ask-confirm');
                if (selected.size > 0 && !existing) {
                  const confirmBtn = document.createElement('button');
                  confirmBtn.className = 'ask-confirm';
                  confirmBtn.textContent = '确认选择';
                  Object.assign(confirmBtn.style, {
                    display: 'block', width: '100%', padding: '8px', marginTop: '6px',
                    fontSize: '13px', fontWeight: '600',
                    background: 'var(--signal, #68a8ff)', color: '#fff',
                    border: 'none', borderRadius: '6px', cursor: 'pointer',
                  });
                  confirmBtn.addEventListener('click', done);
                  btnContainer.appendChild(confirmBtn);
                } else if (selected.size === 0 && existing) {
                  existing.remove();
                }
              } else {
                resolve(JSON.stringify({ answer: opt.label }));
                overlay.remove();
              }
            });
            btnContainer.appendChild(btn);
          });
          dialog.appendChild(btnContainer);
          overlay.appendChild(dialog);
          // Close on Escape or clicking outside
          overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { resolve(JSON.stringify({ answer: null })); overlay.remove(); }
          });
          document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape') { resolve(JSON.stringify({ answer: null })); overlay.remove(); document.removeEventListener('keydown', escHandler); }
          });
          document.body.appendChild(overlay);
        });
      },
    },

    // ── File Operations ──
    {
      name: () => 'write_file',
      description: () =>
        'Create or overwrite a file with the given content. Creates parent directories if needed. Use to write new files or modify existing ones.',
      parameters: () => ({
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Absolute path to the file to create or overwrite',
          },
          content: {
            type: 'string',
            description: 'Full file content to write',
          },
        },
        required: ['filePath', 'content'],
      }),
      readOnly: () => false,
      execute: (args) => exec('write_file_content', args),
    },
    {
      name: () => 'edit_file',
      description: () =>
        'Perform exact string replacement in a file. The old_string must match exactly (including indentation and whitespace) and must be unique in the file (unless replace_all is true). This is the preferred way to modify code — safer and cheaper than rewriting the entire file.',
      parameters: () => ({
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Absolute path to the file to modify',
          },
          oldString: {
            type: 'string',
            description: 'The exact text to find and replace (must match the file exactly, including whitespace)',
          },
          newString: {
            type: 'string',
            description: 'The text to replace it with (must be different from oldString)',
          },
          replaceAll: {
            type: 'boolean',
            description: 'Replace all occurrences instead of just the first (default: false). Use when the old_string appears multiple times.',
            default: false,
          },
        },
        required: ['filePath', 'oldString', 'newString'],
      }),
      readOnly: () => false,
      execute: (args) => exec('edit_file', {
        filePath: args.filePath,
        oldString: args.oldString,
        newString: args.newString,
        replaceAll: args.replaceAll,
      }),
    },
    {
      name: () => 'list_directory',
      description: () =>
        'List files and subdirectories in a directory (recursive up to 4 levels deep). Returns name, path, type (file/dir), and size for each entry.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the directory to list',
          },
        },
        required: ['path'],
      }),
      readOnly: () => true,
      execute: (args) => exec('list_directory', args),
    },

    // ── Code Search ──
    {
      name: () => 'search_code',
      description: () =>
        'Search for a pattern across all source files in a directory. Returns matching files with line numbers and content. Supports both literal substring (default, case-insensitive) and regex (set useRegex: true). Skips binary files, hidden dirs, and build artifacts.',
      parameters: () => ({
        type: 'object',
        properties: {
          directory: {
            type: 'string',
            description: 'Absolute path to the directory to search in',
          },
          pattern: {
            type: 'string',
            description: 'Text or regex pattern to search for (case-insensitive)',
          },
          fileTypes: {
            type: 'string',
            description: 'Optional comma-separated file extensions to filter (e.g. ".ts,.py,.rs")',
          },
          maxResults: {
            type: 'integer',
            description: 'Maximum number of results to return (default: 50, max: 200)',
            default: 50,
          },
          useRegex: {
            type: 'boolean',
            description: 'Set to true to interpret pattern as a regex (e.g. "function\\s+\\w+"). Default: false (literal substring)',
            default: false,
          },
        },
        required: ['directory', 'pattern'],
      }),
      readOnly: () => true,
      execute: (args) => exec('search_code', args),
    },

    // ── Shell ──
    {
      name: () => 'run_shell',
      description: () =>
        'Execute a shell command and return stdout + stderr. Default timeout 2 min. For long-running commands (builds, servers, watch modes), set runInBackground: true and use bash_output to check progress and bash_kill to stop. Commands run in the project directory by default.',
      parameters: () => ({
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to run (e.g. "npm test", "cargo build", "pytest -x")',
          },
          cwd: {
            type: 'string',
            description: 'Optional working directory for the command. Defaults to the HoloGram project root.',
          },
          timeoutMs: {
            type: 'integer',
            description: 'Timeout in milliseconds (default: 120000 = 2 min, max: 600000 = 10 min)',
            default: 120000,
          },
          runInBackground: {
            type: 'boolean',
            description: 'Set to true to run in background (returns job ID immediately). Use bash_output(id) to check progress, bash_kill(id) to stop.',
            default: false,
          },
        },
        required: ['command'],
      }),
      readOnly: () => false,
      execute: (args) => exec('exec_command', args),
    },

    // ── Shell: Background job management ──
    {
      name: () => 'bash_output',
      description: () =>
        'Check the output of a background shell job. Returns accumulated stdout/stderr and whether the job is still running or has completed.',
      parameters: () => ({
        type: 'object',
        properties: {
          jobId: {
            type: 'integer',
            description: 'The job ID returned by run_shell with runInBackground: true',
          },
        },
        required: ['jobId'],
      }),
      readOnly: () => true,
      execute: (args) => exec('bash_output', { jobId: args.jobId }),
    },
    {
      name: () => 'bash_kill',
      description: () =>
        'Kill a running background shell job and return any accumulated output.',
      parameters: () => ({
        type: 'object',
        properties: {
          jobId: {
            type: 'integer',
            description: 'The job ID returned by run_shell with runInBackground: true',
          },
        },
        required: ['jobId'],
      }),
      readOnly: () => false,
      execute: (args) => exec('bash_kill', { jobId: args.jobId }),
    },

    // ── Git ──
    {
      name: () => 'git_status',
      description: () =>
        'Get the current git status — branch name, ahead/behind count, and list of changed files with their status (modified, added, deleted, untracked).',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the git repository root',
          },
        },
        required: ['path'],
      }),
      readOnly: () => true,
      execute: (args) => exec('git_status', args),
    },
    {
      name: () => 'git_diff',
      description: () =>
        'Show the git diff for changed files. Returns unified diff output. Use to review changes before committing.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the git repository root',
          },
          file: {
            type: 'string',
            description: 'Optional: specific file to diff. If omitted, shows all unstaged changes.',
            default: '.',
          },
          staged: {
            type: 'boolean',
            description: 'Set to true to show staged changes instead of unstaged',
            default: false,
          },
        },
        required: ['path'],
      }),
      readOnly: () => true,
      execute: async (args) => {
        const staged = args.staged === true;
        return exec(staged ? 'git_diff_staged' : 'git_diff_unstaged', {
          path: args.path,
          file: args.file || '.',
        });
      },
    },
    {
      name: () => 'git_log',
      description: () =>
        'Show recent git commit history. Returns structured JSON with commit hash, message, author, and date for each commit.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the git repository root',
          },
          count: {
            type: 'integer',
            description: 'Number of recent commits to show (default: 10)',
            default: 10,
          },
        },
        required: ['path'],
      }),
      readOnly: () => true,
      execute: (args) => exec('git_log', { path: args.path, count: args.count || 10 }),
    },
    {
      name: () => 'git_stage',
      description: () =>
        'Stage files for commit. Use before git_commit to add changes to the staging area.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the git repository root',
          },
          files: {
            type: 'string',
            description: 'File path(s) to stage, separated by commas. Use "." to stage all.',
          },
        },
        required: ['path', 'files'],
      }),
      readOnly: () => false,
      execute: async (args) => {
        const files = (args.files as string).trim();
        if (files === '.' || files === 'all') {
          return exec('git_stage_all', { path: args.path });
        }
        // Stage individual files
        const fileList = files.split(',').map(f => f.trim());
        const results: string[] = [];
        for (const f of fileList) {
          const r = await exec('git_stage', { path: args.path, file: f });
          results.push(r);
        }
        return results.join('\n');
      },
    },
    {
      name: () => 'git_commit',
      description: () =>
        'Commit staged changes with a message. Files must be staged first with git_stage. Returns the commit hash.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the git repository root',
          },
          message: {
            type: 'string',
            description: 'Commit message (conventional commits format recommended)',
          },
        },
        required: ['path', 'message'],
      }),
      readOnly: () => false,
      execute: (args) => exec('git_commit', { path: args.path, message: args.message }),
    },
    {
      name: () => 'git_push',
      description: () =>
        'Push committed changes to the remote repository.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the git repository root',
          },
        },
        required: ['path'],
      }),
      readOnly: () => false,
      execute: (args) => exec('git_push', { path: args.path }),
    },
    {
      name: () => 'git_pull',
      description: () =>
        'Pull latest changes from the remote repository (fast-forward only, no merge conflicts).',
      parameters: () => ({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the git repository root',
          },
        },
        required: ['path'],
      }),
      readOnly: () => false,
      execute: (args) => exec('git_pull', { path: args.path }),
    },

    // ── Web Search ──
    {
      name: () => 'web_search',
      description: () =>
        'Search the web for documentation, solutions, or references. Returns page titles, URLs, and snippets. Use to look up library docs, error messages, or API references.',
      parameters: () => ({
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
          },
        },
        required: ['query'],
      }),
      readOnly: () => true,
      execute: async (args) => {
        const query = encodeURIComponent(args.query as string);
        try {
          const resp = await fetch(
            `https://html.duckduckgo.com/html/?q=${query}`,
            { headers: { 'User-Agent': 'HoloGram/1.0' } },
          );
          const html = await resp.text();
          // Extract result links and snippets from DuckDuckGo HTML
          const results: { title: string; url: string; snippet: string }[] = [];
          const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
          const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
          let linkMatch;
          const links: { title: string; url: string }[] = [];
          while ((linkMatch = linkRe.exec(html)) !== null && links.length < 15) {
            links.push({ url: linkMatch[1], title: linkMatch[2].replace(/<[^>]*>/g, '').trim() });
          }
          let snippetIdx = 0;
          let snippetMatch;
          while ((snippetMatch = snippetRe.exec(html)) !== null && snippetIdx < links.length) {
            const snippet = snippetMatch[1].replace(/<[^>]*>/g, '').trim();
            results.push({ ...links[snippetIdx], snippet });
            snippetIdx++;
          }
          // If no structured results, return raw link extraction fallback
          if (results.length === 0) {
            const fallbackRe = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
            let m;
            while ((m = fallbackRe.exec(html)) !== null && results.length < 10) {
              const title = m[2].replace(/<[^>]*>/g, '').trim();
              if (title.length > 5) {
                results.push({ title, url: m[1], snippet: '' });
              }
            }
          }
          return JSON.stringify({ query: args.query, results: results.slice(0, 10) });
        } catch (e: any) {
          return JSON.stringify({ error: `web_search failed: ${e.message || e}` });
        }
      },
    },

    // ── Web Fetch ──
    {
      name: () => 'web_fetch',
      description: () =>
        'Fetch a URL and return its text content. HTML pages are reduced to readable text (scripts, styles, tags stripped). JSON / plain text / markdown pass through verbatim. Use to read documentation, API responses, or source files hosted on the web. 15s timeout, 1 MiB max.',
      parameters: () => ({
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch (HTTPS or HTTP only)',
          },
        },
        required: ['url'],
      }),
      readOnly: () => true,
      execute: (args) => exec('web_fetch', args),
    },
  ];
}
