// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// RPC 契约 — 前后端 IPC 的单一类型事实源（前端侧投影）。
//
// 后端唯一权威源：src-tauri/src/rpc.rs（当前 133 个 RPC 方法，由
// scripts/gen-rpc-contract-md.cjs 生成目录）。本文件的 RpcContract 是
// typedRpc 可见的 UI 子集；Agent 工具调用走 agent/tool.ts 的 agentInvoke 动态分发。
// 维护纪律：后端加/改方法 → 同步更新本文件 RpcContract；
// docs/agents/frontend-rpc-contract.md 由 scripts/gen-rpc-contract-md.cjs
// 从 rpc.rs 生成，勿手改。
//
// 约定：
// - 参数键一律写 snake_case（与 Rust 端一致）；bridge.rpc() 对已是
//   snake_case 的键是直通，对 camelCase 键会自动转换，但契约内统一 snake_case。
// - result 一律是 string（Rust 侧 Result<String, String>）：
//     `// JSON`  = JSON 序列化字符串（含 ok_unit 的 "null"），用 parseJson 解析；
//     `// text`  = 纯文本（文件内容、base64、错误信息等）。
// - 新增前端一律用 typedRpc / typedListen，接线错误在编译期暴露。

// biome-ignore lint/style/noRestrictedImports: 唯二受权的裸 rpc/listen 出口之一（另一个是 tool.ts 的 agentInvoke 动态分发豁免）
import { listen, rpc } from './bridge';

// ─────────────────────────────────────────────────────────────
// 方法契约
// ─────────────────────────────────────────────────────────────

/** Agent 上下文的公共可选参数（写操作需 is_agent + _agent_id 走权限路径）。 */
interface AgentCtx {
  is_agent?: boolean;
  _agent_id?: string;
  [key: string]: unknown;
}

export interface RpcContract {
  // ── Engine 调度 ──────────────────────────────────────────
  hologram_call: {
    params: { tool: string; args?: Record<string, unknown> };
    result: string; // JSON
  };
  hologram_tools_list: {
    params: Record<string, never>;
    result: string; // JSON
  };

  // ── Graph ────────────────────────────────────────────────
  load_graph_json: {
    params: { path?: string };
    result: string; // JSON
  };
  analyze_and_load: {
    params: { path: string; force?: boolean };
    result: string; // JSON
  };
  get_graph_meta: {
    params: Record<string, never>;
    result: string; // JSON
  };
  get_graph_page: {
    params: { page?: number; page_size?: number };
    result: string; // JSON
  };
  engine_impact: {
    params: { node_id: string; max_depth?: number };
    result: string; // JSON
  };

  // ── Git ──────────────────────────────────────────────────
  git_status: { params: { path: string } & AgentCtx; result: string }; // JSON
  git_diff_unstaged: { params: { path: string; file: string } & AgentCtx; result: string }; // JSON
  git_diff_staged: { params: { path: string; file: string } & AgentCtx; result: string }; // JSON
  git_stage: { params: { path: string; files: string[] } & AgentCtx; result: string }; // JSON
  git_stage_all: { params: { path: string } & AgentCtx; result: string }; // JSON
  git_commit: { params: { path: string; message: string } & AgentCtx; result: string }; // JSON
  git_push: { params: { path: string } & AgentCtx; result: string }; // JSON
  git_pull: { params: { path: string } & AgentCtx; result: string }; // JSON
  git_log: { params: { path: string; limit?: number } & AgentCtx; result: string }; // JSON
  git_init: { params: { path: string } & AgentCtx; result: string }; // JSON
  git_checkout: { params: { path: string; branch: string } & AgentCtx; result: string }; // JSON
  git_create_branch: { params: { path: string; name: string } & AgentCtx; result: string }; // JSON
  git_stash_push: { params: { path: string } & AgentCtx; result: string }; // JSON
  git_stash_pop: { params: { path: string } & AgentCtx; result: string }; // JSON
  git_discard: { params: { path: string; file: string } & AgentCtx; result: string }; // JSON
  git_blame: { params: { path: string; file: string; _agent_id?: string }; result: string }; // JSON

  // ── 文件系统 ─────────────────────────────────────────────
  list_directory: {
    params: { path: string; filter_ignored?: boolean } & AgentCtx;
    result: string; // JSON
  };
  list_directory_flat: {
    params: { path: string } & AgentCtx;
    result: string; // JSON
  };
  read_file_content: {
    params: { file_path: string; offset?: number; limit?: number } & AgentCtx;
    result: string; // text — 文件内容（可选行号截断）
  };
  read_memory_batch: {
    params: { paths?: string[] };
    result: string; // text
  };
  read_file_base64: {
    params: { file_path: string } & AgentCtx;
    result: string; // text — base64
  };
  write_file_content: {
    params: { file_path: string; content: string } & AgentCtx;
    result: string; // text
  };
  log_append: {
    params: { path: string; content: string; _agent_id?: string };
    result: string; // "null"
  };
  create_directory: {
    params: { path: string } & AgentCtx;
    result: string; // "null"
  };
  get_global_memory_dir: {
    params: Record<string, never>;
    result: string; // text — 目录路径
  };
  delete_file_or_dir: {
    params: { path: string } & AgentCtx;
    result: string; // "null"
  };
  rename_file_or_dir: {
    params: { file_path: string; new_name: string } & AgentCtx;
    result: string; // "null"
  };
  move_file: {
    params: { from: string; to: string } & AgentCtx;
    result: string; // "null"
  };

  // ── 搜索 ─────────────────────────────────────────────────
  search_content: {
    params: {
      directory: string;
      pattern: string;
      file_types?: string;
      max_results?: number;
      use_regex?: boolean;
      context_lines?: number;
      output_mode?: string;
      show_line_numbers?: boolean;
      head_limit?: number;
      offset?: number;
      glob_filter?: string;
    } & AgentCtx;
    result: string; // JSON
  };
  glob: {
    params: { pattern: string; path?: string } & AgentCtx;
    result: string; // JSON
  };

  // ── Web ──────────────────────────────────────────────────
  web_search: { params: { query: string; _agent_id?: string }; result: string }; // JSON
  web_fetch: { params: { url: string; _agent_id?: string }; result: string }; // JSON

  // ── Shell ────────────────────────────────────────────────
  exec_command: {
    params: {
      command: string;
      cwd?: string;
      timeout_ms?: number;
      run_in_background?: boolean;
      is_agent?: boolean;
      agent_id?: string;
      stream_tool_id?: string;
    };
    result: string; // JSON
  };
  bash_output: { params: { job_id: number }; result: string }; // JSON
  bash_kill: { params: { job_id: number; agent_id?: string }; result: string }; // JSON
  bash_wait: { params: { job_id: number; timeout_ms?: number }; result: string }; // JSON
  shell_env: { params: Record<string, never>; result: string }; // JSON
  drain_bg_notifications: { params: Record<string, never>; result: string }; // JSON

  // ── 编辑器 ───────────────────────────────────────────────
  edit_file: {
    params: { file_path: string; old_string: string; new_string: string; replace_all?: boolean } & AgentCtx;
    result: string; // text — 编辑结果/错误信息
  };

  // ── 身份认证 / 权限 ──────────────────────────────────────
  permission_ask_response: {
    params: {
      request_id: string;
      allow: boolean;
      remember?: boolean;
      rule_to_add?: string | null;
      rule_behavior?: 'allow' | 'deny' | 'ask';
    };
    result: string; // "null"
  };
  set_permission_mode: { params: { mode: string }; result: string }; // "null"
  credential_store: { params: { provider: string; key: string }; result: string }; // "null"
  credential_get: { params: { provider: string }; result: string }; // JSON
  credential_delete: { params: { provider: string }; result: string }; // "null"
  llm_proxy_port: { params: Record<string, never>; result: string }; // 端口号字符串（0=不可用）

  // ── Agent 隔离（worktree）────────────────────────────────
  agent_isolation_create: { params: { agent_id: string }; result: string }; // JSON
  agent_isolation_diff: { params: { agent_id: string }; result: string }; // JSON
  agent_isolation_merge: { params: { agent_id: string }; result: string }; // JSON
  agent_isolation_discard: { params: { agent_id: string }; result: string }; // JSON
  agent_isolation_status: { params: Record<string, never>; result: string }; // JSON
  agent_isolation_force_purge: { params: { agent_id: string }; result: string }; // JSON

  // ── 外部服务 ─────────────────────────────────────────────
  start_mcp_server: { params: { project_root: string }; result: string }; // text
  stop_mcp_server: { params: Record<string, never>; result: string }; // text
  start_unity: { params: Record<string, never>; result: string }; // text
  stop_unity: { params: Record<string, never>; result: string }; // text
  unity_status: { params: Record<string, never>; result: string }; // text
  sandbox_status: { params: Record<string, never>; result: string }; // text

  // ── Hologram 遗留命令 ────────────────────────────────────
  hologram_run_check: { params: { path?: string }; result: string }; // JSON
  hologram_record_event: {
    params: { event_type: string; file?: string; summary: string };
    result: string; // "null"（fire-and-forget）
  };
  get_full_graph: { params: Record<string, never>; result: string }; // JSON — 大图慎用，优先分页

  // ── 工作区 ───────────────────────────────────────────────
  workspace_activate: { params: { path: string }; result: string }; // "null"
  workspace_deactivate: { params: Record<string, never>; result: string }; // "null"
  workspace_start_watcher: { params: Record<string, never>; result: string }; // "null"

  // ── 会话持久化 ───────────────────────────────────────────
  session_append: {
    params: { path: string; session_id: string; message: Record<string, unknown> };
    result: string; // "null"
  };
  agent_session_append: {
    params: { project_path: string; agent_id: string; messages: Record<string, unknown>[]; rewrite?: boolean };
    result: string; // "null"
  };

  // ── 约束 ─────────────────────────────────────────────────
  read_constraints: { params: { project_path: string }; result: string }; // JSON
  write_constraints: { params: { project_path: string; content: string }; result: string }; // "null"

  // ── 数据流 ───────────────────────────────────────────────
  dataflow_save: {
    params: { query: string; content?: string; explore_result?: string; dataflow_result?: string };
    result: string; // text
  };
  dataflow_query: { params: { trace_id?: string; list?: boolean }; result: string }; // JSON
  dataflow_delete: { params: { trace_id: string }; result: string }; // text

  // ── Aura 记忆 ────────────────────────────────────────────
  aura_init: { params: { brain_path: string }; result: string }; // text
  aura_recall: { params: { query: string; top_k?: number }; result: string }; // JSON
  aura_recall_text: { params: { query: string; token_budget?: number }; result: string }; // text
  aura_store: {
    params: { content: string; level?: number; tags?: string; namespace?: string };
    result: string; // text
  };
  aura_count: { params: Record<string, never>; result: string }; // text — 数字字符串
  aura_maintenance: { params: Record<string, never>; result: string }; // "null"
  aura_shutdown: { params: Record<string, never>; result: string }; // "null"

  // ── PTY ──────────────────────────────────────────────────
  pty_spawn: {
    params: { cwd: string; shell?: string; cols: number; rows: number };
    result: string; // text — session id
  };
  pty_write: { params: { session_id: number; data: string }; result: string }; // "null"
  pty_resize: { params: { session_id: number; cols: number; rows: number }; result: string }; // "null"
  pty_kill: { params: { session_id: number }; result: string }; // "null"

  // ── LSP ──────────────────────────────────────────────────
  lsp_start: { params: { language: string; root_uri: string }; result: string }; // text — session id
  lsp_request: {
    params: { session_id: number; method: string; params?: Record<string, unknown> };
    result: string; // JSON
  };
  lsp_stop: { params: { session_id: number }; result: string }; // "null"

  // ── 浏览器审计 / 后台活动（UI 展示层）────────────────────
  // Agent 工具走 agentInvoke 动态分发；UI 组件只读查询用本条目。
  browser_audit: {
    params: { agent?: string; limit?: number };
    result: string; // JSON — { count, entries: string[] }（entries 为审计 JSON 字符串）
  };
  background_activity: {
    params: Record<string, never>;
    result: string; // JSON — { shells: BgJobSnapshot[], browsers: BrowserActivity[] }
  };

  // ── MCP / ACP stdio 桥 ────────────────────────────────────
  protocol_bridge_spawn: {
    params: { id: string; command: string; args?: string[] };
    result: string;
  };
  protocol_bridge_write: {
    params: { id: string; line: string };
    result: string;
  };
  protocol_bridge_kill: {
    params: { id: string };
    result: string;
  };
}

// ─────────────────────────────────────────────────────────────
// 事件契约（Rust 侧 app.emit，前端 listen）
// ─────────────────────────────────────────────────────────────

export interface EventContract {
  /** 权限请求弹窗（响应走 rpc permission_ask_response） */
  'permission-ask': {
    requestId: string;
    tool: string;
    path: string;
    reason: string;
    danger: string;
    agentId: string;
    suggestions: { rule: string; behavior: 'allow' | 'deny' | 'ask' }[];
  };
  /** Unity 外部进程事件 */
  'unity-event': { event: string; payload: string };
  /** analyze_and_load 进度 */
  'analyze-progress': { current: number; total: number; file: string };
  /** analyze_and_load 心跳 */
  'analyze-heartbeat': { label: string; elapsed: string };
  /** analyze_and_load 阶段切换 */
  'analyze-phase': { phase: string; message: string };
  /** LSP 消息 */
  'lsp-message': { session_id: number; message: unknown };
  /** 前台 shell 输出流 */
  'shell:output': { streamId: string; chunk: string };
  /** 前台 shell 结束 */
  'shell:done': { streamId: string; exitCode: number; error?: string };
  /** 图变更摘要（workspace.rs 发射，分析完成后触发前端重载分页图） */
  'graph-updated': string;
  /** PTY 输出（src-tauri 发射；旧前端未监听，新前端用 PTY 时需要） */
  'pty-output': { session_id: number; data: string };
  /** MCP/ACP stdio 桥 stdout 行 */
  'protocol-bridge:output': { id: string; line: string };
  /** MCP/ACP stdio 桥子进程退出 */
  'protocol-bridge:exit': { id: string };
}

// ─────────────────────────────────────────────────────────────
// 类型化调用层
// ─────────────────────────────────────────────────────────────

export type RpcMethodName = keyof RpcContract;
export type RpcParamsOf<M extends RpcMethodName> = RpcContract[M]['params'];
export type RpcResultOf<M extends RpcMethodName> = RpcContract[M]['result'];

/** 方法名/参数在编译期受 RpcContract 约束的 rpc 调用。 */
export async function typedRpc<M extends RpcMethodName>(method: M, params: RpcParamsOf<M>): Promise<RpcResultOf<M>> {
  return rpc<RpcResultOf<M>>(method, params);
}

/** 解析 Rust 返回的 JSON 字符串（ok_json 类方法）。"null" 会解析为 null。 */
export function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

export type EventName = keyof EventContract;

/** 事件名/payload 受 EventContract 约束的 listen。 */
export async function typedListen<E extends EventName>(
  event: E,
  handler: (payload: EventContract[E]) => void,
): Promise<() => void> {
  return listen<EventContract[E]>(event, (e) => handler(e.payload));
}
