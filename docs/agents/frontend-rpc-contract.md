# 前端 RPC 契约（生成物）

> 由 `scripts/gen-rpc-contract-md.cjs` 从 `src-tauri/src/rpc.rs` 生成 — 勿手改。
> 生成时间：2026-10-12T15:12:07.675Z
> 方法总数：57（rpc.rs 头注释为历史数字，以此表为准）

前端类型化入口：`src-ui/src/rpc-contract.ts`（`typedRpc` / `typedListen`，编译期接线检查）。

约定：参数键一律 snake_case；返回均为字符串，`JSON 字符串` 类需 `JSON.parse`（`null` 为 unit 返回）。


## 应用层：数据上下文（L1）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `context_list` | — | — | 字符串 |

## Engine 调度

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `search_cap` | directory, pattern | is_agent, agent_id, _agent_id, file_types, use_regex, collect_lines, glob_filter, max_matches, max_files, context_lines | 字符串 |

## Graph

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `fs_cap` | action | is_agent, agent_id, _agent_id, path, from, to, file_path, pattern, dir, content, line_numbers, filter_ignored, workspace_root, durable, paths, truncate_to | 字符串 |

## 能力口（search_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `git_cap` | action, repo_path | is_agent, agent_id, _agent_id, file, message, branch, files, count | 字符串 |

## 能力口（fs_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `process_cap` | action | is_agent, agent_id, _agent_id, owner_id, _owner_id, command, cwd, sticky_cwd, run_in_background, stream_tool_id, interpreter, capture_cwd, timeout_ms, office, job_id, wait_timeout_ms | 字符串 |

## 能力口（git_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `browser_cap` | action | is_agent, agent_id, _agent_id | 字符串 |

## 能力口（process_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `uia_cap` | action | is_agent, agent_id, _agent_id | 字符串 |

## 能力口（browser_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `web_cap` | action | is_agent, agent_id, _agent_id | 字符串 |
| `pty_cap` | action | is_agent, agent_id, _agent_id | 字符串 |
| `lsp_cap` | action | is_agent, agent_id, _agent_id | 字符串 |

## 能力口（uia_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `editor_cap` | action | is_agent, agent_id, _agent_id | 字符串 |

## 能力口（web_cap / constraints_cap / pty_cap / lsp_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `protocol_bridge_spawn` | id, command, args | env | 字符串 |
| `protocol_bridge_write` | id, line | — | 字符串 |
| `protocol_bridge_kill` | id | reason | 字符串 |

## 能力口（editor_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `permission_ask_response` | request_id, allow | remember, rule_to_add, rule_behavior | `null`（unit） |
| `set_permission_mode` | mode | — | `null`（unit） |
| `credential_store` | provider, key | — | `null`（unit） |
| `credential_get` | provider | — | JSON 字符串 |
| `credential_delete` | provider | — | `null`（unit） |

## MCP / ACP stdio 桥

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `oauth_start` | provider | — | JSON 字符串 |
| `oauth_poll` | provider, device_auth_id, user_code | — | JSON 字符串 |
| `oauth_accounts` | provider | — | JSON 字符串 |
| `oauth_access` | provider | account_id | JSON 字符串 |
| `oauth_logout` | provider, account_id | — | `null`（unit） |
| `oauth_refresh` | provider, account_id | — | JSON 字符串 |
| `open_external` | url | — | `null`（unit） |
| `llm_proxy_port` | — | — | 字符串 |
| `log_level_hint` | — | — | 字符串 |
| `log_rotate` | path | — | JSON 字符串 |

## 身份认证 / 权限

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `plugin_install` | — | expect_name, force | JSON 字符串 |
| `plugin_uninstall` | name | — | `null`（unit） |
| `plugin_dir` | name | — | JSON 字符串 |
| `engine_bundled_info` | — | — | JSON 字符串 |
| `plugin_set_enabled` | name, enabled | — | `null`（unit） |
| `composition_dir` | — | open | 字符串 |
| `providers_dir` | — | open | 字符串 |

## OAuth 订阅平面

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `plugin_data_ensure` | name | — | JSON 字符串 |
| `plugin_data_list` | name | path | JSON 字符串 |
| `plugin_data_read` | name, path | — | 字符串 |
| `plugin_data_write` | name, path, content | — | `null`（unit） |
| `plugin_data_delete` | name, path | — | `null`（unit） |

## 插件安装通道

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `agent_isolation_create` | agent_id | — | 字符串 |
| `agent_isolation_diff` | agent_id | — | 字符串 |
| `agent_isolation_merge` | agent_id | — | 字符串 |
| `agent_isolation_discard` | agent_id | — | 字符串 |
| `agent_isolation_status` | — | — | 字符串 |
| `agent_isolation_force_purge` | agent_id | — | 字符串 |

## 插件数据目录

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `sandbox_status` | — | — | 字符串 |

## Agent 隔离（worktree）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `workspace_activate` | path | — | `null`（unit） |
| `workspace_deactivate` | — | — | `null`（unit） |
| `get_last_project` | — | — | JSON 字符串 |
| `workspace_list` | — | — | JSON 字符串 |
| `workspace_rename` | path, name | — | `null`（unit） |
| `workspace_toggle_pin` | path | — | `null`（unit） |
| `workspace_remove` | path | — | `null`（unit） |
| `workspace_create_dir` | name | — | JSON 字符串 |

## 外部服务

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `agent_session_append` | project_path, agent_id | — | `null`（unit） |

## 事件（Rust 侧 emit → 前端 listen）

payload 类型见 `src-ui/src/rpc-contract.ts` 的 `EventContract`（前端类型化入口 `typedListen`）。

| 事件名 | 发射源 |
|--------|--------|
| `bg:note` | src-tauri/src/utils/bg_jobs.rs |
| `composition:changed` | src-tauri/src/composition_watcher.rs |
| `lsp-message` | src-tauri/src/lsp_manager.rs |
| `permission-ask` | src-tauri/src/utils/path_resolve.rs |
| `protocol-bridge:exit` | src-tauri/src/commands/protocol_bridge.rs |
| `protocol-bridge:output` | src-tauri/src/commands/protocol_bridge.rs |
| `providers:changed` | src-tauri/src/providers_watcher.rs |
| `pty-output` | src-tauri/src/pty_manager.rs |
| `shell:done` | src-tauri/src/commands/process_cap.rs |
| `shell:output` | src-tauri/src/commands/process_cap.rs |

> `goal:state` 等事件为前端内部 EventBus（非 IPC），不走 listen。
