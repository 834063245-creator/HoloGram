# 前端 RPC 契约（生成物）

> 由 `scripts/gen-rpc-contract-md.cjs` 从 `src-tauri/src/rpc.rs` 生成 — 勿手改。
> 生成时间：2026-08-12T04:59:47.700Z
> 方法总数：89（rpc.rs 头注释声称 103 为过期数字，以此表为准）

前端类型化入口：`src-ui/src/rpc-contract.ts`（`typedRpc` / `typedListen`，编译期接线检查）。

约定：参数键一律 snake_case；返回均为字符串，`JSON 字符串` 类需 `JSON.parse`（`null` 为 unit 返回）。


## Engine 调度

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `hologram_call` | tool | args | 字符串 |
| `hologram_tools_list` | — | — | 字符串 |
## Graph

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `load_graph_json` | — | path | 字符串 |
| `analyze_and_load` | path | force | 字符串 |
| `get_graph_meta` | — | — | 字符串 |
| `get_graph_page` | — | page, page_size | 字符串 |
| `engine_impact` | node_id | max_depth | 字符串 |

## Git

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `git_status` | path | is_agent, _agent_id | 字符串 |
| `git_diff_unstaged` | path, file | is_agent, _agent_id | 字符串 |
| `git_diff_staged` | path, file | is_agent, _agent_id | 字符串 |
| `git_stage` | path, files | is_agent, _agent_id | 字符串 |
| `git_stage_all` | path | is_agent, _agent_id | 字符串 |
| `git_commit` | path, message | is_agent, _agent_id | 字符串 |
| `git_push` | path | is_agent, _agent_id | 字符串 |
| `git_pull` | path | is_agent, _agent_id | 字符串 |
| `git_log` | path | limit, is_agent, _agent_id | 字符串 |
| `git_init` | path | is_agent, _agent_id | 字符串 |
| `git_checkout` | path, branch | is_agent, _agent_id | 字符串 |
| `git_create_branch` | path, name | is_agent, _agent_id | 字符串 |
| `git_stash_push` | path | is_agent, _agent_id | 字符串 |
| `git_stash_pop` | path | is_agent, _agent_id | 字符串 |
| `git_discard` | path, file | is_agent, _agent_id | 字符串 |
| `git_blame` | path, file | _agent_id | 字符串 |

## 文件系统

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `list_directory` | path | is_agent, filter_ignored, _agent_id | JSON 字符串 |
| `list_directory_flat` | path | is_agent, _agent_id | JSON 字符串 |
| `read_file_content` | file_path | offset, limit, is_agent, _agent_id | 字符串 |
| `read_memory_batch` | — | paths | 字符串 |
| `write_file_content` | file_path, content | is_agent, _agent_id | 字符串 |
| `log_append` | path, content | _agent_id | `null`（unit） |
| `create_directory` | path | is_agent, _agent_id | `null`（unit） |
| `get_global_memory_dir` | — | — | 字符串 |
| `delete_file_or_dir` | path | is_agent, _agent_id | `null`（unit） |
| `rename_file_or_dir` | file_path, new_name | is_agent, _agent_id | `null`（unit） |
| `move_file` | from, to | is_agent, _agent_id | `null`（unit） |

## 搜索

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `search_content` | directory, pattern | file_types, max_results, use_regex, context_lines, output_mode, show_line_numbers, head_limit, offset, glob_filter, is_agent, _agent_id | 字符串 |
| `glob` | pattern | path, is_agent, _agent_id | 字符串 |

## Web

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `web_search` | query | _agent_id | 字符串 |
| `web_fetch` | url | _agent_id | 字符串 |

## Shell

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `exec_command` | command | cwd, timeout_ms, run_in_background, is_agent, _agent_id, agent_id, stream_tool_id | 字符串 |
| `bash_output` | job_id | — | 字符串 |
| `bash_kill` | job_id | agent_id | 字符串 |
| `bash_wait` | job_id | timeout_ms | 字符串 |
| `shell_env` | — | — | 字符串 |
| `drain_bg_notifications` | — | — | 字符串 |

## 编辑器

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `edit_file` | file_path, old_string, new_string | replace_all, is_agent, _agent_id | 字符串 |

## 身份认证 / 权限

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `permission_ask_response` | request_id, allow | remember, rule_to_add, rule_behavior | 字符串 |
| `set_permission_mode` | mode | — | `null`（unit） |
| `credential_store` | provider, key | — | `null`（unit） |
| `credential_get` | provider | — | JSON 字符串 |
| `credential_delete` | provider | — | `null`（unit） |

## Agent 隔离（worktree）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `agent_isolation_create` | agent_id | — | 字符串 |
| `agent_isolation_diff` | agent_id | — | 字符串 |
| `agent_isolation_merge` | agent_id | — | 字符串 |
| `agent_isolation_discard` | agent_id | — | 字符串 |
| `agent_isolation_status` | — | — | 字符串 |
| `agent_isolation_force_purge` | agent_id | — | 字符串 |

## 外部服务

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `start_mcp_server` | project_root | — | 字符串 |
| `stop_mcp_server` | — | — | 字符串 |
| `start_unity` | — | — | 字符串 |
| `stop_unity` | — | — | 字符串 |
| `unity_status` | — | — | 字符串 |
| `sandbox_status` | — | — | 字符串 |

## Hologram 遗留命令

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `hologram_run_check` | — | path | 字符串 |
| `hologram_record_event` | event_type, summary | file | `null`（unit） |
| `get_full_graph` | — | — | 字符串 |

## 工作区

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `workspace_activate` | path | — | `null`（unit） |
| `workspace_deactivate` | — | — | `null`（unit） |
| `workspace_start_watcher` | — | — | `null`（unit） |

## 会话持久化

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `session_append` | path, session_id, message | — | 字符串 |
| `agent_session_append` | project_path, agent_id, messages | rewrite | 字符串 |

## 约束

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `read_constraints` | project_path | — | 字符串 |
| `write_constraints` | project_path, content | — | `null`（unit） |

## 数据流

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `dataflow_save` | query | content, explore_result, dataflow_result | 字符串 |
| `dataflow_query` | — | trace_id, list | 字符串 |
| `dataflow_delete` | trace_id | — | 字符串 |

## Aura 记忆

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `aura_init` | brain_path | — | 字符串 |
| `aura_recall` | query | top_k | 字符串 |
| `aura_recall_text` | query | token_budget | 字符串 |
| `aura_store` | content | tags, namespace, level | 字符串 |
| `aura_count` | — | — | 字符串 |
| `aura_maintenance` | — | — | `null`（unit） |
| `aura_shutdown` | — | — | `null`（unit） |

## PTY

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `pty_spawn` | cwd, cols, rows | shell | 字符串 |
| `pty_write` | data, session_id | — | `null`（unit） |
| `pty_resize` | cols, rows, session_id | — | `null`（unit） |
| `pty_kill` | session_id | — | `null`（unit） |

## LSP

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `lsp_start` | language, root_uri | — | 字符串 |
| `lsp_request` | method, session_id | params | JSON 字符串 |
| `lsp_stop` | session_id | — | `null`（unit） |

## 事件（Rust 侧 emit → 前端 listen）

payload 类型见 `src-ui/src/rpc-contract.ts` 的 `EventContract`（前端类型化入口 `typedListen`）。

| 事件名 | 发射源 |
|--------|--------|
| `analyze-heartbeat` | src-tauri/src/utils.rs |
| `analyze-phase` | src-tauri/src/utils.rs |
| `analyze-progress` | src-tauri/src/utils.rs |
| `graph-updated` | src-tauri/src/workspace.rs |
| `lsp-message` | src-tauri/src/lsp_manager.rs |
| `permission-ask` | src-tauri/src/utils.rs |
| `pty-output` | src-tauri/src/pty_manager.rs |
| `shell:done` | src-tauri/src/commands/shell.rs |
| `shell:output` | src-tauri/src/commands/shell.rs |
| `unity-event` | src-tauri/src/commands/external.rs |

> `goal:state` 等事件为前端内部 EventBus（非 IPC），不走 listen。
