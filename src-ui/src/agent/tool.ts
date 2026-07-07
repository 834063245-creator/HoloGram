// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tool 系统 — Tool 接口 + Registry 注册表 + Hologram 工具定义

import type { Provider, ToolSchema } from '../provider/types';
import { ChunkType } from '../provider/types';
import { bus } from '../ui/events';
import { invoke } from '../bridge';

// ---- Tool 接口 ----

/** A Tool is one callable tool the agent can dispatch. */
export interface Tool {
  /** Machine name, e.g. "fragile_modules" */
  name(): string;
  /** Human-readable description for the model */
  description(): string;
  /** JSON Schema for the arguments */
  parameters(): Record<string, unknown>;
  /** Whether this tool is read-only (safe to parallelize) */
  readOnly(): boolean;
  /** Execute the tool with raw JSON arguments. Returns the result string.
   *  onProgress is an optional callback for streaming partial output during execution. */
  execute(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<string>;
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

  /** Register an alias — same implementation, different name shown to LLM.
   *  Alias also appears in schemas() so LLM can use either name. */
  alias(aliasName: string, existingName: string): void {
    const original = this.tools.get(existingName);
    if (!original) throw new Error(`ToolRegistry: cannot alias unknown tool "${existingName}"`);
    if (this.tools.has(aliasName)) return; // already exists (real tool or earlier alias)

    // Wrap to override name() — schemas() must show the alias name, not the original
    const wrapper: Tool = {
      name: () => aliasName,
      description: () => original.description(),
      parameters: () => original.parameters(),
      readOnly: () => original.readOnly(),
      execute: (args, onProgress) => original.execute(args, onProgress),
    };
    this.tools.set(aliasName, wrapper);
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

  all(): Tool[] {
    return Array.from(this.tools.values());
  }

  filterReadOnly(): Tool[] {
    return this.all().filter(t => t.readOnly());
  }

  /** Return a new ToolRegistry containing only the named tools (in given order).
   *  Missing names are skipped silently. Used to build scoped agent toolsets. */
  subset(names: string[]): ToolRegistry {
    const sub = new ToolRegistry();
    for (const n of names) {
      const t = this.tools.get(n);
      if (t) sub.register(t);
    }
    return sub;
  }
}

// ---- Hologram 图查询工具 (25 tools — 与引擎 MCP 双线对齐) ----
// 硬编码工具 = Agent 的"嘴"：描述经过 LLM 调优，告诉 Agent 什么时候用、用完了下一步调什么。
// MCP = 执行通道：长驻引擎进程 <100ms 响应，挂了自动降级 CLI。
// 两者永远对齐——引擎新增 MCP 工具必须同步在此补硬编码定义。

/** Tool executor: invokes tools via MCP (fast, persistent) or CLI (fallback).
 *  onProgress is an optional callback for streaming partial output during execution. */
export type ToolExecutor = (toolName: string, args: Record<string, unknown>, onProgress?: (chunk: string) => void) => Promise<string>;

/** Agent → backend invoke 包装。恒定注入 isAgent:true，让 Rust 命令走权限路径
 *  (require_read/require_write/git_dispatch) 而非沙箱化的 user-UI 路径。
 *  camelCase 契约: Rust 参数 `is_agent` ↔ JS key `isAgent`。
 *  旧名 `_agent` 因 Tauri 默认 camelCase 重命名永远匹配不上 → is_agent 恒 false
 *  → agent 文件操作被沙箱静默硬拒且不弹 Ask（见 tests/agent-exec.test.ts 守护）。 */
export async function agentInvoke<T = string>(name: string, args: Record<string, unknown>): Promise<T> {
  return invoke<T>(name, { ...args, isAgent: true });
}

// ═══════════════════════════════════════════════════════
// Hologram test tools — 数据驱动，仅供 test-once / test-agent
// ponytail: 生产路径从 MCP tools/list 动态加载（workspace.ts → mcpSchemaToTool）。
// 此函数存在是因为 CLI 测试脚本没有 Tauri invoke，无法调 hologram_tools_list。
// 增删引擎工具时：只改 HOLOG_TOOLS 数组，测试自动跟随。
// ═══════════════════════════════════════════════════════

interface HologToolDef { name: string; desc: string; params?: Record<string, unknown>; required?: string[]; write?: boolean }

const pp = (props: Record<string, unknown>) => ({ type: 'object', properties: props });

const HOLOG_TOOLS: HologToolDef[] = [
  { name: 'explore_deps', desc: '【首选】统一聚合查询：Flow + Blast Radius + Relationships + Source + Alerts。支持自然语言，不确定用什么工具时先调这个。',
    params: pp({ query: { type:'string', description:'自然语言查询（如 "DataRequest validate task"）' }, symbols: { type:'array', items:{ type:'string' }, description:'显式符号名列表（与 query 二选一）' }, includeSource: { type:'boolean', description:'是否返回源码（默认 true）' } }) },
  { name: 'analyze_project', desc: '重新分析项目目录，生成完整依赖图。', params: pp({ path: { type:'string', description:'项目根目录' } }), required: ['path'], write: true },
  { name: 'get_neighbors', desc: '获取节点的直接邻居（1-hop 子图）——谁依赖它、它依赖谁。', params: pp({ nodeId: { type:'string', description:'节点 ID 或名称' }, depth: { type:'integer', description:'深度（默认 1）' } }), required: ['nodeId'] },
  { name: 'trace_impact', desc: '变更波及分析：从节点出发 BFS 追踪所有下游依赖者，返回完整影响树。改代码前必调。', params: pp({ nodeId: { type:'string', description:'源节点 ID' }, maxDepth: { type:'integer', description:'最大深度（0=不限制）' } }), required: ['nodeId'] },
  { name: 'find_dep_path', desc: '查找两个节点之间的所有依赖路径，逐跳展示边类型。', params: pp({ from: { type:'string', description:'源节点 ID' }, to: { type:'string', description:'目标节点 ID' } }), required: ['from', 'to'] },
  { name: 'symbol_history', desc: '获取节点的决策历史——哪些过去的决策涉及此节点。在 workspace.ts 中 alias 到 inspect_symbol。', params: pp({ nodeId: { type:'string', description:'节点 ID' } }), required: ['nodeId'] },
  { name: 'get_community', desc: '获取节点的社区归属——它属于哪个社区、父社区、兄弟节点。用 "这个模块属于哪个组？" 时调此工具。', params: pp({ nodeId: { type:'string', description:'节点 ID 或名称' } }), required: ['nodeId'] },
  { name: 'async_edges', desc: '列出所有时序边——异步调用、触发器、计划任务。用于查异步依赖和时序耦合。', params: pp({ filter: { type:'string', enum:['all','triggers','awaits','sequences'], description:'边类型过滤（默认 all）' }, limit: { type:'integer', description:'最大返回条数（默认 100）' } }) },
  { name: 'fragile_modules', desc: 'L4 脆弱模块排行榜：按封装违规密度排序，分数越高 = 越多的时序耦合和隐藏依赖。', params: pp({ limit: { type:'integer', description:'返回前 N 个脆弱模块（默认 5）' } }) },
  { name: 'detect_cycles', desc: '检测依赖图中的数据流循环。filter: all（全部）/ data（持久数据依赖）/ llm（LLM 涉及）。', params: pp({ mode: { type:'string', enum:['all','data','llm'], description:'过滤模式（默认 all）' } }) },
  { name: 'thread_conflicts', desc: '线程 × 资源冲突矩阵——检测多写者共享变量和并发访问模式。', params: pp({ nodeId: { type:'string', description:'可选节点 ID，省略返回全局矩阵' } }) },
  { name: 'coupling_report', desc: '单模块耦合深度分布（L1-L4）：L1=导入, L2=调用/继承, L3=数据共享, L4=时序/异步。', params: pp({ module: { type:'string', description:'模块文件名或路径' } }), required: ['module'] },
  { name: 'project_timeline', desc: '查询因果审计时间线——分析运行、提交、违规等事件的按时间排序日志。', params: pp({ limit: { type:'integer', description:'最大返回条数（默认 100）' }, since: { type:'string', description:'ISO 时间戳过滤（可选）' } }) },
  { name: 'arch_blindspots', desc: '架构盲点雷达：L4 封装违规 + 无锁并发 + LLM 反馈循环。filter: all / L4 / thread / cycle。', params: pp({ filter: { type:'string', enum:['all','L4','thread','cycle'], description:'边界类型过滤（默认 all）' } }) },
  { name: 'search_symbols', desc: '模糊搜索节点名或 ID（FTS5 全文搜索）。找函数/类/模块但不知道确切名字时的第一步。', params: pp({ query: { type:'string', description:'部分名称或 ID' }, limit: { type:'integer', description:'最大结果数（默认 20）' } }), required: ['query'] },
  { name: 'explore_deps', desc: '同 explore_deps。', params: pp({}) }, // duplicate entry — kept for backward compat with old test scripts
  { name: 'graph_summary', desc: '依赖图高层概览：节点/边数、语言分布、密度指标、顶层架构一览。', params: pp({}) },
  { name: 'cluster_report', desc: '社区/聚类结构报告——按规模排序，展示自然形成的模块群。查单个节点的社区归属用 get_community。', params: pp({ minSize: { type:'integer', description:'最小社区规模（默认 3）' }, maxNodes: { type:'integer', description:'每个社区最大展示节点数（默认 20）' } }) },
  { name: 'graph_diff', desc: '对比当前依赖图与基线快照——展示新增/删除/修改的节点和边。', params: pp({ beforePath: { type:'string', description:'基线图 JSON 文件路径' } }), required: ['beforePath'] },
  { name: 'preflight_check', desc: '改前预检（V3）：输入要改的文件列表，评估波及范围、风险等级、共享变量影响、时序边信号。改代码前先跑——"这个改动安全吗？"', params: pp({ path: { type:'array', items:{ type:'string' }, description:'要改的文件路径列表' } }), required: ['path'] },
  { name: 'validate_project', desc: '完整约束校验（V3）：重新分析 + 基线对比 + 所有结构约束检查。用户说"全面检查"或"跑一遍约束"时用。', params: pp({ path: { type:'string', description:'项目根目录' } }), required: ['path'], write: true },
  { name: 'project_health', desc: '项目健康快照：密度分数（0-100）+ 趋势 + 改动最多文件 + 最互联模块。"项目最近怎么样？"或"最近的趋势怎么样？"时用。', params: pp({ path: { type:'string', description:'项目根目录' }, days: { type:'integer', description:'回溯天数（默认 30）' } }), required: ['path'] },
  { name: 'rename_symbol', desc: '安全重命名依赖图中的符号。先用 dryRun=true 预览，确认后再 dryRun=false 执行。', params: pp({ oldName: { type:'string', description:'当前符号名' }, newName: { type:'string', description:'新符号名' }, dryRun: { type:'boolean', description:'仅预览不修改（默认 true）' }, nodeId: { type:'string', description:'有同名歧义时指定节点 ID' } }), required: ['oldName','newName'], write: true },
  { name: 'engine_status', desc: '引擎状态和内存统计——加载阶段、节点/边数、存储类型、启动耗时。Agent 确认图是否就绪时用。', params: pp({}) },
  { name: 'check_boundaries', desc: '架构边界规则检查——自定义 source/target 文件匹配 + 边类型，扫描越界依赖。模块隔离验证："A 有没有偷 import B 的内部文件？"', params: pp({ rules: { type:'array', description:'规则对象数组 [{name, source, target, edge_kinds?, message?}]。source/target 支持 glob 或正则。edge_kinds 默认 ["imports"]。' }, source: { type:'string', description:'快捷模式：单条规则的 source pattern' }, target: { type:'string', description:'快捷模式：单条规则的 target pattern' }, edge_kinds: { type:'array', items:{ type:'string' }, description:'边类型过滤，默认 ["imports"]' } }) },
  { name: 'inspect_symbol', desc: '单节点完整信息——身份（name/kind/degree）+ 社区归属 + 全部出入边按类型分组。search_symbols 命中后深挖具体符号。', params: pp({ nodeId: { type:'string', description:'节点 ID 或名称' } }), required: ['nodeId'] },
  { name: 'find_unused', desc: '潜在死代码探测——零入度节点（无人引用的函数/类/文件），按出度降序排列。删代码前先跑。', params: pp({ limit: { type:'integer', description:'最大结果数（默认 20）' }, kindFilter: { type:'string', description:'逗号分隔的节点类型（默认 "function,class,file"）' } }) },
  { name: 'trace_dataflow', desc: '逐函数变量读写 + 跨函数共享状态 + 异步触发 + 调用序列。"X 在哪被写？""谁读了 Y？""哪些函数共享 Z？"', params: pp({ files: { type:'array', items:{ type:'string' }, description:'要分析的文件路径列表' } }), required: ['files'] },
  // ── LSP 引擎（4 个）──
  { name: 'resolve_call', desc: 'LSP 调用解析：给定调用表达式，返回所有可能的目标定义（多态解析）。' },
  { name: 'infer_type', desc: 'LSP 类型解析：推断表达式类型，返回类型名和定义模块。' },
  { name: 'find_implementations', desc: 'LSP 查找接口/抽象类的所有实现，返回完整继承树。' },
  { name: 'find_references', desc: 'LSP 查找符号的所有引用位置，返回文件列表和引用计数。' },
];

export function createHologramTestTools(exec: ToolExecutor): Tool[] {
  return HOLOG_TOOLS.map(d => ({
    name: () => d.name,
    description: () => d.desc,
    parameters: () => d.params || { type: 'object', properties: {} },
    readOnly: () => !d.write,
    execute: (args: Record<string, unknown>) => exec(d.name, args),
  }));
}

// ═══════════════════════════════════════════════════════
// MCP 动态工具工厂 — Step 1: 从 MCP tools/list 自动生成
// ═══════════════════════════════════════════════════════
// Coding Tools — 文件 / Shell / 搜索 / Git / Web
// ═══════════════════════════════════════════════════════

export function createCodingTools(exec: ToolExecutor, provider?: Provider): Tool[] {
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
            background: 'rgba(3, 8, 18, 0.75)', zIndex: '9999',
            backdropFilter: 'blur(8px) saturate(0.6)', WebkitBackdropFilter: 'blur(8px) saturate(0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          });
          const dialog = document.createElement('div');
          Object.assign(dialog.style, {
            background: 'var(--panel-bg, rgba(4, 12, 28, 0.92))',
            border: '1px solid var(--panel-edge, rgba(54, 82, 128, 0.28))',
            borderRadius: '14px', padding: '28px 28px 22px', maxWidth: '520px', minWidth: '340px',
            color: 'var(--starlight, #e2edff)',
            fontFamily: 'var(--font-body, "Noto Sans SC", sans-serif)',
            boxShadow: '0 24px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(54, 82, 128, 0.15) inset',
            backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
            transition: 'opacity 0.15s ease',
          });
          const hdr = document.createElement('div');
          hdr.textContent = header;
          Object.assign(hdr.style, {
            fontSize: 'calc(10px * var(--font-scale))', color: 'var(--signal, #68a8ff)', marginBottom: '12px',
            textTransform: 'uppercase', letterSpacing: '2px', fontWeight: '600',
            fontFamily: 'var(--font-hud, "Orbitron", sans-serif)',
          });
          const q = document.createElement('div');
          q.textContent = question;
          Object.assign(q.style, {
            fontSize: 'calc(14px * var(--font-scale))', marginBottom: '18px', lineHeight: '1.6',
            color: 'var(--starlight-dim, rgba(195, 218, 248, 0.85))',
          });
          dialog.appendChild(hdr); dialog.appendChild(q);
          const btnContainer = document.createElement('div');
          Object.assign(btnContainer.style, {
            display: 'flex', flexDirection: 'column', gap: '6px',
          });
          const selected = new Set<number>();
          const done = () => {
            cleanup();
            if (multiSelect) {
              const chosen = options.filter((_, i) => selected.has(i)).map(o => o.label);
              resolve(JSON.stringify({ answers: chosen }));
            }
          };
          options.forEach((opt, idx) => {
            const btn = document.createElement('button');
            btn.textContent = opt.label;
            const isSelected = selected.has(idx);
            Object.assign(btn.style, {
              display: 'block', width: '100%', padding: '10px 16px', textAlign: 'left',
              fontSize: 'calc(13px * var(--font-scale))',
              background: isSelected
                ? 'rgba(80, 140, 240, 0.12)'
                : 'rgba(255, 255, 255, 0.03)',
              border: isSelected
                ? '1px solid var(--signal-glow, rgba(80, 140, 240, 0.35))'
                : '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: '8px',
              color: isSelected ? 'var(--signal-bright, #8cc4ff)' : 'var(--starlight-dim, rgba(195, 218, 248, 0.85))',
              cursor: 'pointer',
              fontFamily: 'var(--font-body, "Noto Sans SC", sans-serif)',
              transition: 'all 0.12s ease',
            });
            btn.addEventListener('mouseenter', () => {
              btn.style.background = isSelected
                ? 'rgba(80, 140, 240, 0.18)'
                : 'rgba(255, 255, 255, 0.06)';
              btn.style.borderColor = isSelected
                ? 'var(--signal, #68a8ff)'
                : 'rgba(255, 255, 255, 0.14)';
            });
            btn.addEventListener('mouseleave', () => {
              btn.style.background = isSelected
                ? 'rgba(80, 140, 240, 0.12)'
                : 'rgba(255, 255, 255, 0.03)';
              btn.style.borderColor = isSelected
                ? 'var(--signal-glow, rgba(80, 140, 240, 0.35))'
                : 'rgba(255, 255, 255, 0.06)';
            });
            if (opt.description) {
              btn.title = opt.description;
              const desc = document.createElement('div');
              desc.textContent = opt.description;
              Object.assign(desc.style, {
                fontSize: 'calc(10px * var(--font-scale))', color: 'var(--text-muted, rgba(145, 165, 190, 0.65))',
                marginTop: '3px', fontWeight: '400',
              });
              btn.appendChild(desc);
            }
            btn.addEventListener('click', () => {
              if (multiSelect) {
                if (selected.has(idx)) { selected.delete(idx); } else { selected.add(idx); }
                const nowSelected = selected.has(idx);
                btn.style.background = nowSelected
                  ? 'rgba(80, 140, 240, 0.12)'
                  : 'rgba(255, 255, 255, 0.03)';
                btn.style.border = nowSelected
                  ? '1px solid var(--signal-glow, rgba(80, 140, 240, 0.35))'
                  : '1px solid rgba(255, 255, 255, 0.06)';
                btn.style.color = nowSelected
                  ? 'var(--signal-bright, #8cc4ff)'
                  : 'var(--starlight-dim, rgba(195, 218, 248, 0.85))';
                const existing = btnContainer.querySelector('.ask-confirm');
                if (selected.size > 0 && !existing) {
                  const confirmBtn = document.createElement('button');
                  confirmBtn.className = 'ask-confirm';
                  confirmBtn.textContent = '✓ 确认选择';
                  Object.assign(confirmBtn.style, {
                    display: 'block', width: '100%', padding: '9px', marginTop: '8px',
                    fontSize: 'calc(13px * var(--font-scale))', fontWeight: '600',
                    background: 'rgba(80, 140, 240, 0.15)',
                    border: '1px solid var(--signal-glow, rgba(80, 140, 240, 0.3))',
                    borderRadius: '8px',
                    color: 'var(--signal, #68a8ff)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-body, "Noto Sans SC", sans-serif)',
                    transition: 'all 0.12s ease',
                  });
                  confirmBtn.addEventListener('mouseenter', () => {
                    confirmBtn.style.background = 'rgba(80, 140, 240, 0.25)';
                    confirmBtn.style.borderColor = 'var(--signal, #68a8ff)';
                  });
                  confirmBtn.addEventListener('mouseleave', () => {
                    confirmBtn.style.background = 'rgba(80, 140, 240, 0.15)';
                    confirmBtn.style.borderColor = 'var(--signal-glow, rgba(80, 140, 240, 0.3))';
                  });
                  confirmBtn.addEventListener('click', done);
                  btnContainer.appendChild(confirmBtn);
                } else if (selected.size === 0 && existing) {
                  existing.remove();
                }
              } else {
                resolve(JSON.stringify({ answer: opt.label }));
                cleanup();
              }
            });
            btnContainer.appendChild(btn);
          });
          dialog.appendChild(btnContainer);
          overlay.appendChild(dialog);
          // Close on Escape or clicking outside
          const cleanup = () => {
            document.removeEventListener('keydown', escHandler);
            overlay.remove();
          };
          const escHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { resolve(JSON.stringify({ answer: null })); cleanup(); }
          };
          overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { resolve(JSON.stringify({ answer: null })); cleanup(); }
          });
          document.addEventListener('keydown', escHandler);
          document.body.appendChild(overlay);
        });
      },
    },

    // ── File Operations ──
    {
      name: () => 'read_file_content',
      description: () =>
        'Read the content of a file on disk. Returns text in cat -n format (6-digit line number + tab + content). Use offset and limit to read a specific range of lines (0-indexed). Use to inspect source code files when analyzing dependencies or investigating violations.',
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

    // ── Code Search ──
    {
      name: () => 'search_content',
      description: () =>
        'Search for a text pattern across all source files. Supports literal substring (default, case-insensitive) and regex. Returns matching lines with optional context lines, file lists, or counts. Skips binary files, hidden dirs, and build artifacts. Prefer this over run_shell grep — it is faster and respects .gitignore-style exclusions.',
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
            description: 'Set to true to interpret pattern as a regex (e.g. "function\\\\s+\\\\w+"). Default: false (literal substring)',
            default: false,
          },
          contextLines: {
            type: 'integer',
            description: 'Number of context lines before and after each match (like grep -C). Default: 0. Max: 10.',
            default: 0,
          },
          outputMode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: 'Output mode: "content" = matching lines with context, "files_with_matches" = just file paths, "count" = match counts per file. Default: content.',
            default: 'content',
          },
          showLineNumbers: { type: 'boolean', description: 'Include line numbers in output (default: true)', default: true },
          headLimit: { type: 'integer', description: 'Max results/files to return (default: 250, 0 = unlimited)', default: 250 },
          offset: { type: 'integer', description: 'Skip first N results for pagination (default: 0)', default: 0 },
          globFilter: { type: 'string', description: 'Additional glob filter on file paths (e.g. "**/*.rs", "src/**/*.ts")' },
        },
        required: ['directory', 'pattern'],
      }),
      readOnly: () => true,
      execute: (args) => exec('search_content', args),
    },

    // ── Glob ──
    {
      name: () => 'glob',
      description: () =>
        'Fast file pattern matching using glob patterns. Returns matching file paths sorted by modification time. Supports ** for recursive matching (e.g. "**/*.rs", "src/**/*.ts", "*.json"). Use this instead of run_shell to find files by name pattern — it is faster and respects .gitignore-style exclusions.',
      parameters: () => ({
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern to match file paths against (e.g. "**/*.rs", "src/**/agent*.ts", "*.json")',
          },
          path: {
            type: 'string',
            description: 'Directory to search in. Defaults to the project root.',
          },
        },
        required: ['pattern'],
      }),
      readOnly: () => true,
      execute: (args) => exec('glob', args),
    },

    // ── Shell ──
    {
      name: () => 'run_shell',
      description: () =>
        'Execute a shell command and return stdout + stderr. Default timeout 5 min (max 10 min). For long-running commands (builds, servers, watch modes), set runInBackground: true and use bash_output to check progress and bash_kill to stop. Commands run in the project directory by default. IMPORTANT: Do NOT use run_shell for file search, code search, or git operations — use glob (file patterns), search_content (text search), list_directory (directory listing), and the dedicated git_* tools (git_status, git_diff, git_stage, git_commit, git_push, git_pull, git_log, git_checkout, git_create_branch, etc.) instead. run_shell is ONLY for building and testing commands (npm test, cargo build, pytest, etc.).',
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
            description: 'Timeout in milliseconds (default: 300000 = 5 min, max: 600000 = 10 min)',
            default: 300000,
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
        const filesRaw = args.files as string | undefined;
        if (!filesRaw) return 'error: files argument is required';
        const files = filesRaw.trim();
        if (files === '.' || files === 'all') {
          return exec('git_stage_all', { path: args.path });
        }
        // Stage individual files
        const fileList = files.split(',').map(f => f.trim());
        const results: string[] = [];
        for (const f of fileList) {
          const r = await exec('git_stage', { path: args.path, files: [f] });
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
        'Search the web for documentation, solutions, or references. Returns a concise summary with source links — the search results are already read and summarized, so you can use the information directly without calling web_fetch on every link.',
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
      execute: async (args, onProgress) => {
        try {
          onProgress?.('搜索中…');
          const rawResults = await exec('web_search', args);
          if (!provider) return rawResults; // no LLM available, return raw
          onProgress?.('摘要中…');
          const summary = await summarizeSearchResults(provider, args.query as string, rawResults);
          return summary;
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

    // ── Phase 2a: File Operations (Tauri commands already exist) ──
    {
      name: () => 'delete_file',
      description: () =>
        'Delete a file or directory at the specified path. Use to clean up temporary files or remove unwanted code. DANGEROUS — cannot be undone. Verify with user if deleting important files.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file or directory to delete' },
        },
        required: ['path'],
      }),
      readOnly: () => false,
      execute: (args) => exec('delete_file_or_dir', args),
    },
    {
      name: () => 'create_directory',
      description: () =>
        'Create a new directory (and any missing parent directories). Use before writing new files into a directory that may not exist yet.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the directory to create' },
        },
        required: ['path'],
      }),
      readOnly: () => false,
      execute: (args) => exec('create_directory', args),
    },
    {
      name: () => 'move_file',
      description: () =>
        'Move or rename a file or directory. The destination path determines the new name/location.',
      parameters: () => ({
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source path' },
          to: { type: 'string', description: 'Destination path' },
        },
        required: ['from', 'to'],
      }),
      readOnly: () => false,
      execute: (args) => exec('move_file', args),
    },
    {
      name: () => 'rename_file',
      description: () =>
        'Rename a file or directory (keep it in the same parent directory). For moving to a different directory, use move_file instead.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file/directory to rename' },
          new_name: { type: 'string', description: 'New name (not path, just the name)' },
        },
        required: ['path', 'new_name'],
      }),
      readOnly: () => false,
      execute: (args) => exec('rename_file_or_dir', { filePath: args.path, newName: args.new_name }),
    },

    // ── Phase 2b: Git Operations (Tauri commands already exist) ──
    {
      name: () => 'git_init',
      description: () => 'Initialize a new git repository in the given directory.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the directory' },
        },
        required: ['path'],
      }),
      readOnly: () => false,
      execute: (args) => exec('git_init', args),
    },
    {
      name: () => 'git_checkout',
      description: () => 'Switch to a different branch. Use git_create_branch first if the branch does not exist.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the git repository' },
          branch: { type: 'string', description: 'Branch name to switch to' },
        },
        required: ['path', 'branch'],
      }),
      readOnly: () => false,
      execute: (args) => exec('git_checkout', args),
    },
    {
      name: () => 'git_create_branch',
      description: () => 'Create a new git branch from the current HEAD. Does NOT switch to it — use git_checkout after.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the git repository' },
          branch: { type: 'string', description: 'New branch name' },
        },
        required: ['path', 'branch'],
      }),
      readOnly: () => false,
      execute: (args) => exec('git_create_branch', args),
    },
    {
      name: () => 'git_discard',
      description: () => 'Discard unstaged changes to a file (git checkout -- <file>). Loses all uncommitted modifications.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the git repository' },
          file: { type: 'string', description: 'File path to discard changes for (relative to repo root)' },
        },
        required: ['path', 'file'],
      }),
      readOnly: () => false,
      execute: (args) => exec('git_discard', args),
    },
    {
      name: () => 'git_stash_push',
      description: () => 'Stash current uncommitted changes. Use before switching branches with dirty working tree.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the git repository' },
          message: { type: 'string', description: 'Optional stash message for identification' },
        },
        required: ['path'],
      }),
      readOnly: () => false,
      execute: (args) => exec('git_stash_push', args),
    },
    {
      name: () => 'git_stash_pop',
      description: () => 'Restore the most recently stashed changes. Pops the stash — the changes are applied and the stash entry is removed.',
      parameters: () => ({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the git repository' },
        },
        required: ['path'],
      }),
      readOnly: () => false,
      execute: (args) => exec('git_stash_pop', args),
    },

    // ── Phase 2c: Agent Worktree Isolation (Tauri commands already exist) ──
    {
      name: () => 'agent_isolation_create',
      description: () =>
        'Create an isolated git worktree for a sub-agent to work in. Returns the isolation path. Use before spawning a sub-agent that mutates files — prevents conflicts when multiple agents modify the same repo concurrently.',
      parameters: () => ({
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Identifier for this isolation workspace' },
        },
        required: ['agent_id'],
      }),
      readOnly: () => false,
      execute: (args) => exec('agent_isolation_create', args),
    },
    {
      name: () => 'agent_isolation_diff',
      description: () => 'Show the diff of changes made in an isolation workspace.',
      parameters: () => ({
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Isolation workspace to diff' },
        },
        required: ['agent_id'],
      }),
      readOnly: () => true,
      execute: (args) => exec('agent_isolation_diff', args),
    },
    {
      name: () => 'agent_isolation_merge',
      description: () => 'Merge changes from an isolation workspace back into the main repository.',
      parameters: () => ({
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Isolation workspace to merge' },
        },
        required: ['agent_id'],
      }),
      readOnly: () => false,
      execute: (args) => exec('agent_isolation_merge', args),
    },
    {
      name: () => 'agent_isolation_discard',
      description: () => 'Discard an isolation workspace and delete its worktree. Use when the sub-agent\'s changes are no longer needed.',
      parameters: () => ({
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Isolation workspace to discard' },
        },
        required: ['agent_id'],
      }),
      readOnly: () => false,
      execute: (args) => exec('agent_isolation_discard', args),
    },
    {
      name: () => 'agent_isolation_status',
      description: () => 'List all isolation workspaces and their current status.',
      parameters: () => ({
        type: 'object',
        properties: {},
      }),
      readOnly: () => true,
      execute: (args) => exec('agent_isolation_status', args),
    },
  ];
}

// ponytail: single-turn LLM call to summarise search results, same pattern as Agent.summarizeRegion.
// No tools, low temp — factual summary with source links preserved.
async function summarizeSearchResults(provider: Provider, query: string, rawResults: string): Promise<string> {
  const prompt = `Summarise the following web search results for the query "${query}".

Return format:
1. One-line conclusion (bold)
2. Key findings (bullet points, each with source URL as markdown link)
3. If results are irrelevant or empty, say so honestly

Rules:
- Keep it concise — the user will read this as a tool output, not a chat response
- Preserve all source URLs as markdown links: [Title](URL)
- Don't add information not present in the results
- Reply in the same language as the query

Raw search results:
${rawResults}`;

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 20_000);

  try {
    const gen = provider.stream(ac.signal, {
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      temperature: 0.3,
      max_tokens: 0,
    });

    const parts: string[] = [];
    for await (const chunk of gen) {
      if (chunk.type === ChunkType.Text && chunk.text) parts.push(chunk.text);
      if (chunk.type === ChunkType.Error) throw chunk.err!;
    }
    return parts.join('').trim() || rawResults;
  } catch {
    return rawResults; // fallback: return raw results if LLM call fails
  } finally {
    clearTimeout(timeout);
  }
}

// ═══════════════════════════════════════════════════════════════
// Sub-Agent Tool — spawn a child Agent for parallel / delegated work
// ═══════════════════════════════════════════════════════════════

export type SubAgentSpawner = (
  description: string,
  prompt: string,
  onProgress?: (chunk: string) => void,
  mode?: 'fork' | 'fresh',
) => Promise<{ text: string; err?: string }>;

export function createSubAgentTool(
  spawner: SubAgentSpawner,
  pool?: import('./coordinator').SubAgentPool,
): Tool {
  return {
    name: () => 'agent_spawn',
    description: () =>
      'Spawn a sub-agent with full tool access to handle a focused task. Omit subagent_type to fork (inherit parent context — DEFAULT, recommended). Set subagent_type to "fresh" for a clean-slate agent with no parent context. ⚠️ RULES: (1) You MUST verify your work — run cargo check / cargo test / npm run build before stopping. Do not pause or stop on first failure; fix → compile → repeat until zero errors. (2) Every edit_file call must be followed by verification.',
    parameters: () => ({
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Short label for the sub-agent task (3-5 words, used in progress display)',
        },
        prompt: {
          type: 'string',
          description: 'The task for the sub-agent to perform. Be specific about what to find or analyze.',
        },
        subagent_type: {
          type: 'string',
          description: 'Omit to fork (inherit full context — DEFAULT). Set to "fresh" for a clean-slate sub-agent with no parent context.',
        },
      },
      required: ['description', 'prompt'],
    }),
    readOnly: () => false,
    execute: async (args, onProgress) => {
      const description = (args['description'] as string) || '子任务';
      const prompt = (args['prompt'] as string) || '';
      const subagentType = args['subagent_type'] as string | undefined;
      if (!prompt) return '(agent_spawn: prompt is required)';
      const mode = subagentType ? 'fresh' : 'fork';
      const callId = (args['_callId'] as string) || `sub_${Date.now()}`;

      // G2: async spawn via pool — fire-and-forget, parent doesn't block
      if (pool) {
        const id = pool.spawn(
          description,
          async (onMsg) => {
            const result = await spawner(description, prompt, onMsg, mode);
            return result;
          },
          (chunk) => {
            onProgress?.(chunk);
            bus.emit('agent:sub-progress', { parentToolId: callId, text: chunk });
          },
        );
        bus.emit('agent:sub-spawn', { id: callId, description, prompt, mode });
        return JSON.stringify({
          task_id: id,
          status: 'started',
          message: `子Agent已启动: ${description}。结果将通过 task-notification 返回。`,
        });
      }

      // Fallback: synchronous spawn (legacy behavior, no pool)
      const startTime = performance.now();
      let stepCount = 0;
      bus.emit('agent:sub-spawn', { id: callId, description, prompt, mode });

      const wrappedProgress = (chunk: string) => {
        stepCount++;
        onProgress?.(chunk);
        bus.emit('agent:sub-progress', { parentToolId: callId, text: chunk });
      };

      const result = await spawner(description, prompt, wrappedProgress, mode);
      const elapsed = Math.round(performance.now() - startTime);

      bus.emit('agent:sub-done', {
        parentToolId: callId,
        summary: {
          description,
          steps: stepCount,
          elapsedMs: elapsed,
          hasError: !!result.err,
        },
      });

      if (result.err) return `[子 Agent 错误] ${result.err}`;
      return result.text;
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// agent_message — send follow-up instructions to a running sub-agent
// ═══════════════════════════════════════════════════════════════

export function createAgentMessageTool(pool?: import('./coordinator').SubAgentPool): Tool {
  return {
    name: () => 'agent_message',
    description: () =>
      '向运行中的子Agent发送后续指令。子Agent保留之前加载的上下文。仅对通过 agent_spawn 启动的异步子Agent有效。',
    parameters: () => ({
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: '子Agent ID，由 agent_spawn 返回的 task_id',
        },
        message: {
          type: 'string',
          description: '后续指令或问题',
        },
      },
      required: ['to', 'message'],
    }),
    readOnly: () => false,
    execute: async (args) => {
      if (!pool) return 'agent_message 不可用：未启用异步子Agent池。';
      const to = args['to'] as string;
      const message = args['message'] as string;
      if (!to || !message) return '需要 to 和 message 参数。';
      const ok = pool.sendMessage(to, message);
      return ok ? '消息已发送' : '子Agent未找到或已结束';
    },
  };
}