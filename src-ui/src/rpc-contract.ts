// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// RPC 契约 — 前后端 IPC 的单一类型事实源（前端侧投影）。
//
// 后端唯一权威源：src-tauri/src/rpc.rs（方法总数与分区以生成表为准——
// docs/agents/frontend-rpc-contract.md，gen-rpc-contract-md.cjs 同步生成）。
// 本文件的 RpcContract 是
// typedRpc 可见的 UI 子集；Agent 工具调用走 agent/tool.ts 的 agentInvoke 动态分发。
// 维护纪律：后端加/改方法 → 同步更新本文件 RpcContract；
// docs/agents/frontend-rpc-contract.md 由 scripts/gen-rpc-contract-md.cjs
// 从 rpc.rs 生成，勿手改。
//
// 约定：
// - 参数键一律写 snake_case（与 Rust 端一致）；bridge.rpc() 对已是
//   snake_case 的键是直通，对 camelCase 键会自动转换，但契约内统一 snake_case。
// - result（rpc Value 化第二步，2026-08-22）：
//     `// JSON`  = JSON 形态。Rust 出口（rpc.rs rpc_result_shape 表）已把表内
//                 命令展开为真结构化 Value，typedJsonRpc 直接透传；表外 JSON
//                 命令仍返 JSON 字符串，typedJsonRpc 双形态兼容（string 走 parse）。
//     `// text`  = 纯文本（文件内容、base64、git stdout、错误信息等）。
// - 新增前端一律用 typedRpc / typedListen，接线错误在编译期暴露；JSON 命令
//   用 typedJsonRpc（双形态 shim 在那里）。

import { z } from 'zod';

// biome-ignore lint/style/noRestrictedImports: 唯二受权的裸 rpc/listen 出口之一（另一个是 tool.ts 的 agentInvoke 动态分发豁免）
import { listen, rpc } from './bridge';

// ─────────────────────────────────────────────────────────────
// 方法契约
// ─────────────────────────────────────────────────────────────

// （AgentCtx 公共参数接口随 hologram_* 引擎 RPC 全量退役删除，2026-09-09——
// 唯一消费方是引擎调度方法面。）

/** git_cap 能力口 action（R3-c git 域收口）——退役前 builtin.git 16 工具名
 *  一一位（与历史精确规则寻址名 plugin:builtin.git.<action> 同构）。 */
export type GitCapAction =
  | 'git_status'
  | 'git_diff_unstaged'
  | 'git_diff_staged'
  | 'git_log'
  | 'git_stage'
  | 'git_stage_all'
  | 'git_commit'
  | 'git_push'
  | 'git_pull'
  | 'git_init'
  | 'git_checkout'
  | 'git_create_branch'
  | 'git_stash_push'
  | 'git_stash_pop'
  | 'git_discard'
  | 'git_blame';

/** process_cap 能力口 action（R3-d shell 域收口）——退役前 builtin.shell 7 工具名
 *  一一位（与历史精确规则寻址名 plugin:builtin.shell.<action> 同构）。 */
export type ProcessCapAction =
  | 'exec_command'
  | 'office_exec'
  | 'bash_output'
  | 'bash_kill'
  | 'bash_wait'
  | 'shell_env'
  | 'background_activity'
  | 'drain_bg_notifications';

/** browser_cap 能力口 action（R4 browser 域收口）——退役前 builtin.browser 37
 *  工具名一一位（D4-1：action 化，git_cap 同构）。各 action 参数形状的真源 =
 *  agent/tools/browser.ts 的 BROWSER_CAP_SCHEMA（zod 转录，工具面 camelCase），
 *  能力口收顶层 snake（11 键映射 BROWSER_CAP_SNAKE_KEYS）。 */
export type BrowserCapAction =
  | 'browser_launch'
  | 'browser_connect'
  | 'browser_sessions'
  | 'browser_switch_session'
  | 'browser_cookies'
  | 'browser_kill'
  | 'browser_targets'
  | 'browser_discover'
  | 'browser_attach'
  | 'browser_inspect'
  | 'browser_report'
  | 'browser_snapshot'
  | 'browser_content'
  | 'browser_console'
  | 'browser_network'
  | 'browser_network_detail'
  | 'browser_network_har'
  | 'browser_screenshot'
  | 'browser_viewport'
  | 'browser_audit'
  | 'browser_click'
  | 'browser_type'
  | 'browser_press'
  | 'browser_hover'
  | 'browser_dialog'
  | 'browser_upload'
  | 'browser_new_tab'
  | 'browser_close_tab'
  | 'browser_scroll'
  | 'browser_navigate'
  | 'browser_back'
  | 'browser_forward'
  | 'browser_reload'
  | 'browser_select'
  | 'browser_wait'
  | 'browser_eval'
  | 'browser_status';

/** uia_cap 能力口 action（R4 browser 域收口）——退役前 builtin.uia 17 工具名
 *  一一位（D4-1：action 化，git_cap 同构）。各 action 参数形状的真源 =
 *  agent/tools/browser.ts 的 UIA_CAP_SCHEMA（zod 转录；desktop 面键本就
 *  snake_case，无映射）。 */
export type UiaCapAction =
  | 'desktop_probe'
  | 'desktop_screenshot'
  | 'desktop_uia_tree'
  | 'desktop_uia_find'
  | 'desktop_uia_read'
  | 'desktop_uia_wait'
  | 'desktop_uia_click'
  | 'desktop_uia_right_click'
  | 'desktop_uia_type'
  | 'desktop_uia_scroll'
  | 'desktop_uia_select'
  | 'desktop_uia_expand'
  | 'desktop_uia_keys'
  | 'desktop_uia_activate'
  | 'desktop_uia_window_shot'
  | 'desktop_audit'
  | 'desktop_status';

export interface RpcContract {
  // ── 应用层：数据上下文（L1）────────────────────────────
  // （workspace-session-ownership-rework 2026-08-27：session_attach/detach/
  //  focus 三命令退役——会话只在所属工作区内打开，引擎决议只看活动工作区，
  //  无需会话绑定/焦点投影。）
  /** 数据上下文清单（诊断）。 */
  context_list: {
    params: Record<string, never>;
    result: string; // JSON
  };

  // ── Git ──────────────────────────────────────────────────
  // （git_status / git_diff_unstaged / git_diff_staged / git_log / git_stage /
  //   git_stage_all / git_commit / git_push / git_pull / git_init / git_checkout /
  //   git_create_branch / git_stash_push / git_stash_pop / git_discard / git_blame
  //   已迁内核插件 builtin.git（P2-3）→ 又随 git 域收口（2026-09-05，R3-c）
  //   换 git_cap 能力口直呼——builtin.git 信封退役，契约见下方 git_cap。内部
  //   直呼统一经下方 kernelGitCall 助手。）

  // ── 文件系统 ─────────────────────────────────────────────
  // （fs 工具域已收敛到 fs_cap 能力口直呼——2026-09-04 fs 域收口，builtin.fs
  //   信封退役。内部 I/O 统一经下方 fsCapCall 一族助手，is_agent=false 用户路径。）
  get_last_project: {
    params: Record<string, never>;
    result: string; // JSON — 最近工作区路径 "path"/null（冷启动恢复信号）
  };
  workspace_list: {
    params: Record<string, never>;
    result: string; // JSON — 已知工作区清单（注册表 + 各工作区会话计数/dir_exists，含空工作区）
  };
  workspace_rename: { params: { path: string; name: string }; result: string }; // "null"
  workspace_toggle_pin: { params: { path: string; pinned: boolean }; result: string }; // "null"
  workspace_remove: { params: { path: string }; result: string }; // "null" — 删除该工作区全部会话 + 解除登记（删除失败报错且不解除登记）
  /** 新建工作区目录：~/Documents/兰台/<名字>，返回归一化路径。只建目录不登记（登记随后续 activate）。 */
  workspace_create_dir: { params: { name: string }; result: string }; // JSON — 归一化路径字符串

  // ── 能力口（R2 试点，kernel-capability-r2-search-pilot.md）──────────
  // search_cap：search 全文扫描能力口（fs 能力族变体，v3 §4）——不经 tool_call
  // 信封 / PluginRegistry。R2-d(2) 收窄：口只做纯扫描返回**统一原始命中集**
  // {pattern, scanned_files, budget_truncated, files:[{file, match_count,
  // matches:[{line, content, context}]}]}
  // ——三形态组装/分页/行号显示归 TS 编排层（agent/tools/search-assembly.ts）。
  // （可选 vector_hits/vector_backend 语义召回尾键已随图谱全量退役删除，
  //  2026-09-09——向量边车原经引擎 transport，壳内零引擎接线后不再出现。）
  // 收窄键：max_matches（总命中上限，content 形态行级断）/ max_files（命中文件
  // 上限，files/count 形态文件级断——触顶置 budget_truncated）/ collect_lines
  // （携带命中行与上下文邻居，仅 content）。参数键 = 顶层 snake_case
  // （bridge.rpc() 会把 camelCase 转 snake——工具 execute 侧必须先把 schema 的
  // camelCase 参数映射为 snake_case 再直呼；R2-a 曾直接摊 camelCase 导致可选
  // 参数全被转换吞掉，键位修复见 manifest-tools searchCapTool）。is_agent/
  // agent_id 显式传（Agent 过 require_read 闸 / UI 只解析；resolve_read_dispatch
  // 需要 agent_id 做 worktree 前向映射）。
  search_cap: {
    params: {
      directory: string;
      pattern: string;
      file_types?: string;
      max_matches?: number;
      max_files?: number;
      use_regex?: boolean;
      context_lines?: number;
      collect_lines?: boolean;
      glob_filter?: string;
      is_agent?: boolean;
      agent_id?: string | null;
    };
    result: string; // JSON — 统一原始命中集（组装归 TS search-assembly.ts）
  };

  // ── 能力口（R3-a + 收口，kernel-capability-c3-design.md）──────────
  // fs_cap：fs 能力族直呼入口（read/list/list_flat/glob/write/delete/rename/
  // create_dir/append/read_base64/write_base64/memory_batch/global_memory_dir/
  // stat/open_with_system）
  // ——不经 tool_call 信封 / PluginRegistry / PluginToolAdapter。参数键顶层
  // snake_case（bridge.rpc() 转换幂等）；is_agent/agent_id 显式传（Agent 过
  // resolve_*_dispatch 闸 / UI 只解析）。编排（缺省/输出格式）归 TS。
  // stat（P2）：只给 {path,size,is_dir}——查看器面据此**在读取前**拦超限档
  // （此前只能整份读回来再判，大文件会把 payload 推进 IPC）。
  // open_with_system（P2 · B5）：交系统默认程序打开（ShellExecuteW）；**只开用户
  // 通道**（is_agent=true 口内即拒）。
  fs_cap: {
    params: {
      action:
        | 'read'
        | 'list'
        | 'list_flat'
        | 'glob'
        | 'write'
        | 'delete'
        | 'rename'
        | 'create_dir'
        | 'append'
        | 'truncate'
        | 'read_base64'
        | 'write_base64'
        | 'memory_batch'
        | 'global_memory_dir'
        | 'stat'
        | 'open_with_system';
      path?: string;
      from?: string;
      to?: string;
      file_path?: string;
      pattern?: string;
      dir?: string;
      content?: string;
      offset?: number;
      limit?: number;
      line_numbers?: boolean;
      filter_ignored?: boolean;
      paths?: string[];
      workspace_root?: string;
      /** append 的 durable 变体（append + fsync，返回即已落盘）——会话事件日志写面。 */
      durable?: boolean;
      /** truncate 的目标字节偏移（断尾修复——扫描器给的 committedBytes）。 */
      truncate_to?: number;
      is_agent?: boolean;
      agent_id?: string | null;
    };
    result: string; // JSON — read={path,content} / read_base64={path,base64} / list|list_flat={entries} / glob={pattern,count,truncated,results} / stat={path,size,is_dir} / open_with_system={path} / memory_batch=Record<path,content|null> / 写类（write|write_base64|create_dir|rename|delete）={path}
  };

  // ── 能力口（R3-c，kernel-capability-c3-design.md §8）──────────
  // git_cap：git 能力族直呼入口（builtin.git 插件随 git 域收口退役）——不经
  // tool_call 信封 / PluginRegistry / PluginToolAdapter。action = 退役前
  // builtin.git 工具名（GitCapAction）；repo_path 必填；porcelain 解析归 TS
  // （agent/git-porcelain.ts）。口内闸：Agent 路径 Read 家族（只读五动作）/
  // Git 家族两段闸（subcommand 位）；is_agent/agent_id 显式传（用户路径只解析）。
  git_cap: {
    params: {
      action: GitCapAction;
      repo_path: string;
      file?: string;
      files?: string[];
      message?: string;
      branch?: string;
      count?: number;
      is_agent?: boolean;
      agent_id?: string | null;
    };
    result: string; // text — run_git stdout（git_status 失败回空串；diff/blame 口内 32K 截断）
  };

  // ── 能力口（R3-d，kernel-capability-c3-design.md §8/§9）──────────
  // process_cap：process 能力族直呼入口（builtin.shell 插件随 shell 域收口
  // 退役）——不经 tool_call 信封 / PluginRegistry / PluginToolAdapter。action =
  // 退役前 builtin.shell 7 工具名（ProcessCapAction）；口内闸 = fg/bg 双检查
  // 不对称（Bash 家族命令串规则面）；粘性 cwd 归 TS（cwd 显式 + sticky_cwd
  // 候选——盘上不存在时口内跳过自愈）。capture_cwd=true 时口内按方言包装命令，
  // 粘性 marker 字节原样流经 shell:output 事件/结果——TS 截流/提交/回显。
  // 事件形状零改：shell:output / shell:done 双事件 + started 回
  // {streamId, job_id, resolvedCwd}（见 EventContract）。
  process_cap: {
    params: {
      action: ProcessCapAction;
      command?: string;
      cwd?: string;
      sticky_cwd?: string;
      timeout_ms?: number;
      run_in_background?: boolean;
      stream_tool_id?: string;
      interpreter?: string;
      capture_cwd?: boolean;
      /** office_exec 专用载荷（2026-09-15 R3）：officecli 的 argv + 声明的目标文件。
       *  **不接受自由命令行串**——命令由 Rust 侧拼装（动词白名单 + OfficeTool 门禁），
       *  officecli 的 DOM 路径 / JSON 载荷因此不再被 bash::check 误判成"项目外路径"。 */
      office?: {
        argv: string[];
        targets?: { path: string; write?: boolean }[];
      };
      job_id?: number;
      wait_timeout_ms?: number;
      is_agent?: boolean;
      agent_id?: string | null;
      owner_id?: string | null;
    };
    result: string; // text — stdout 文本 / started JSON（含粘性 marker 字节，TS 截流）/ job 输出
  };

  // ── 能力口（R4，kernel-capability-d4-handle-design.md）──────────
  // browser_cap：browser 句柄域直呼入口（builtin.browser 插件随 browser 域
  // 收口退役）——不经 tool_call 信封 / PluginRegistry / PluginToolAdapter。
  // action = 退役前 builtin.browser 37 工具名（BrowserCapAction）；各 action
  // 参数形状真源 = BROWSER_CAP_SCHEMA（zod），口收顶层 snake（11 键映射）。
  // 口内闸：BrowserTool 无条件过闸（多层语义 + click/type_sensitive 二次
  // Ask——Rust 强制层）；target="self" 只读路由在口内。返回文本（TS 工具层
  // 做 truncate/结构化错误整形）。
  browser_cap: {
    params: {
      action: BrowserCapAction;
      is_agent?: boolean;
      agent_id?: string | null;
      // 各 action 参数（顶层 snake；形状按 action 见 BROWSER_CAP_SCHEMA）
      [key: string]: unknown;
    };
    result: string; // text — 37 action 全文本直通（浏览器会话状态/快照/操作反馈）
  };

  // ── 能力口（R4，kernel-capability-d4-handle-design.md）──────────
  // uia_cap：desktop 句柄域直呼入口（builtin.uia 插件随 browser 域收口退役）
  // ——不经 tool_call 信封 / PluginRegistry / PluginToolAdapter。action =
  // 退役前 builtin.uia 17 工具名（UiaCapAction）；各 action 参数形状真源 =
  // UIA_CAP_SCHEMA（zod，键本就 snake_case 无映射）。口内闸：DesktopTool
  // 无条件过闸（六层语义）+ resolve→classify→grant→lease 全链（INVARIANTS
  // #13：COM 只活 worker 线程、物理输入必经租约）。返回文本（world-diff/
  // 审计报表直通）。
  uia_cap: {
    params: {
      action: UiaCapAction;
      is_agent?: boolean;
      agent_id?: string | null;
      // 各 action 参数（顶层 snake；形状按 action 见 UIA_CAP_SCHEMA）
      [key: string]: unknown;
    };
    result: string; // text — 17 action 全文本直通（树/控件读写/world-diff/审计）
  };

  // ── 能力口（R4-4 小面清偿，kernel-capability-d4-handle-design.md）──────
  // web_cap/pty_cap/lsp_cap：三族直呼入口（对应 builtin.* 插件退役）——
  // 不经 tool_call 信封 / PluginRegistry / PluginToolAdapter。
  // 均 Text：web search = JSON 字符串 / fetch = 网页文本；pty spawn = 会话 id；
  // lsp request = JSON 字符串（kernelLspRequest parseJson）。web 口内
  // WebFetchTool 无条件过闸（域名规则 + SSRF 逐跳复查）；pty/lsp 原语义
  // Passthrough；pty-output / lsp-message 事件通道零改（manager 内部 emit）。
  // （constraints_cap 随图谱全量退役删除，2026-09-09——hologram.constraints.yaml
  //  读写仅服务引擎 run_check，兰台侧已无消费方。）
  web_cap: {
    params: {
      action: 'web_search' | 'web_fetch';
      query?: string;
      max_results?: number;
      url?: string;
      is_agent?: boolean;
      agent_id?: string | null;
      [key: string]: unknown;
    };
    result: string; // text — search JSON / fetch 网页文本
  };
  pty_cap: {
    params: {
      action: 'pty_spawn' | 'pty_write' | 'pty_resize' | 'pty_kill';
      cwd?: string;
      shell?: string;
      cols?: number;
      rows?: number;
      session_id?: number;
      data?: string;
      is_agent?: boolean;
      agent_id?: string | null;
      [key: string]: unknown;
    };
    result: string; // text — 会话 id / "null"
  };
  lsp_cap: {
    params: {
      action: 'lsp_start' | 'lsp_request' | 'lsp_stop';
      language?: string;
      root_uri?: string;
      session_id?: number;
      method?: string;
      params?: Record<string, unknown>;
      is_agent?: boolean;
      agent_id?: string | null;
      [key: string]: unknown;
    };
    result: string; // text — 会话 id / JSON 字符串 / "null"
  };
  editor_cap: {
    params: {
      action: 'edit_file';
      file_path?: string;
      old_string?: string;
      new_string?: string;
      replace_all?: boolean;
      is_agent?: boolean;
      agent_id?: string | null;
      // _forceGate/_agent_id 等 meta 键原样透传（INVARIANTS #9）
      [key: string]: unknown;
    };
    result: string; // text — diff 快照
  };

  // ── Shell（retired）────────────────────────────────────────
  // （exec_command / bash_output / bash_kill / bash_wait / shell_env /
  //   background_activity / drain_bg_notifications 已随 shell 域收口
  //   （2026-09-05，R3-d）换 process_cap 能力口直呼——builtin.shell 信封退役，
  //   契约见上方 process_cap。内部直呼统一经下方 kernelProcessCall 助手；
  //   shell:output / shell:done 事件双通道原样保留（§4.3 裁决）。）

  // ── 编辑器 ───────────────────────────────────────────────
  // （edit_file 已随 R4-4b（2026-09-05）换 editor_cap 能力口直呼——builtin.editor
  //   退役，契约见上方 editor_cap。信封面已随 R5 脚手架拆除。）

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

  // ── OAuth 订阅平面（Phase 3C，provider-refactor 方案乙）─────────
  /** 发起 device-code 流程。返回 DeviceFlowStart JSON：
   *  { verification_uri, user_code, device_auth_id, interval, expires_at }。 */
  oauth_start: { params: { provider: string }; result: string }; // JSON
  /** 轮询一拍：grant JSON（授权完成 + 已落库）| "null"（未批准，稍后继续）。 */
  oauth_poll: {
    params: { provider: string; device_auth_id: string; user_code: string };
    result: string;
  }; // JSON | "null"
  /** 已存 grant 账号清单（仅元数据：provider/account_id/expires_at/scope）。 */
  oauth_accounts: { params: { provider: string }; result: string }; // JSON array
  /** 取指定/最近账号完整 grant（进程内请求装配；过期自动刷新）。
   *  无已登录账号 → 报 OAUTH_NO_GRANT。 */
  oauth_access: {
    params: { provider: string; account_id?: string | null };
    result: string;
  }; // grant JSON
  /** 登出：删除 (provider, account_id) 的 grant。 */
  oauth_logout: { params: { provider: string; account_id: string }; result: string }; // "null"
  /** 刷新 token 续期并回写 grant。返回 grant JSON。 */
  oauth_refresh: { params: { provider: string; account_id: string }; result: string }; // JSON
  /** 系统浏览器打开 URL（OAuth 授权页等）。 */
  open_external: { params: { url: string }; result: string }; // "null"
  llm_proxy_port: { params: Record<string, never>; result: string }; // 端口号字符串（0=不可用）
  /** 前端日志级别的壳侧提示（日志可观测性批 3）= `LANTAI_LOG_LEVEL` 环境变量。
   *  认得出（debug/info/warn/error，大小写与空白容错）才回规范名；**未设 / 认不出
   *  / 通道不通一律回空串** ⇒ 前端回落 `localStorage['lantai.log.level']` → 默认
   *  `info`。写成"提示"而不是"设定"是刻意的：级别真源在前端进程内（logger.ts），
   *  本 RPC 只是把壳看得见的那只旋钮递过去。 */
  log_level_hint: { params: Record<string, never>; result: string };

  // ── 插件安装通道（S4-3）─────────────────────────────────
  /** 安装插件：source_kind = registry（name/version?/registry?）|
   *  tarball（location = URL 或本地 .tgz 路径）| local_dir（location =
   *  本地目录——复制进 plugins 根）。expect_name 可选校验 manifest.name。
   *  force = true 跳过版本守卫（平台化 P3：同名重装默认比较 manifest.version
   *  ——升级原子换装，同版本/降级拒绝）。返回安装的插件目录名。
   *  生效时机：重启（Phase 4 改运行时生效）。 */
  plugin_install: {
    params: {
      source_kind: 'registry' | 'tarball' | 'local_dir';
      name?: string;
      version?: string;
      registry?: string;
      location?: string;
      expect_name?: string;
      force?: boolean;
    };
    result: string; // 插件名（JSON 字符串）
  };
  /** 卸载插件（删目录；幂等）。生效时机：重启。 */
  plugin_uninstall: { params: { name: string }; result: string }; // "null"
  /** 启用/禁用插件（plugins.json 读改写）。生效时机：重启。 */
  plugin_set_enabled: { params: { name: string; enabled: boolean }; result: string }; // "null"
  /** 插件目录绝对路径（S4-4 乙机器桥：manifest mcpServers 的 stdio command
   *  相对插件目录解析）。名字围栏同 uninstall；目录不存在 = 错误。 */
  plugin_dir: { params: { name: string }; result: string }; // 绝对路径
  /** 随包图谱引擎信息（engine-bundled-mcp-distribution，2026-09-16）：探测
   *  安装目录里的 `hologram-engine.exe`（多候选：env `LANTAI_ENGINE_EXE` →
   *  宿主 exe 同级 → 上一级 → 仓库 target/）。**纯只读探测，不启动进程**——
   *  接线在 TS 侧 `plugins/bundled-engine.ts`，走 MCP 受治进程通道。
   *  `path: null` = 未找到（走「引擎不可用」降级，非错误）。
   *  ⚠ 形态：`// JSON`（2026-09-24 补标注）——此前未标且未进 rpc.rs 的
   *  rpc_result_shape 表 ⇒ 出口按 Text 直通字符串，消费面读属性恒 false
   *  （设置页开关置灰「拨不开」，见 tests/bundled-engine-probe-shape.test.ts）。 */
  engine_bundled_info: {
    params: Record<string, never>;
    result: { path: string | null; dir: string | null; available: boolean }; // JSON
  };
  /** 组合目录（P-1 authoring 环境，2026-09-14）：返回 `~/.lantai/composition/`
   *  绝对路径并按需创建（root + presets/，幂等，不动已有内容）；`open: true`
   *  时用系统文件管理器打开。路径只来自服务端计算，无调用方路径参数。 */
  composition_dir: { params: { open?: boolean }; result: string }; // 绝对路径
  /** provider 配置文件目录（2026-09-24 配方改文件批）：返回
   *  `~/.lantai/providers.yml` 所在目录的绝对路径并按需创建（幂等，不动已有内容）；
   *  `open: true` 时用系统文件管理器打开。路径只来自服务端计算，无调用方路径参数
   *  （与 composition_dir 同一条安全纪律）。前端据此拼 `providers.yml`
   *  （文件名前端持有——打开目录给人看的是目录，不是文件）。 */
  providers_dir: { params: { open?: boolean }; result: string }; // 绝对路径

  // ── 插件数据目录（app shell 四件套 · 件 B，S1）─────────────
  // manifest.dataDir 插件的专属数据地盘：装载期 loader 调 ensure 分配（幂等），
  // 宿主桥 fs 面（window.__lantai_plugin_host__.fs）读写列删，卸载回收是
  // plugin_uninstall 内钩（数据挪 .trash，不在本段）。路径锁死
  // <dataRoot>/<插件名>/（Rust commands/plugin_data.rs 双围栏 + canonicalize
  // 前缀——越界/junction 逃逸拒绝）。
  plugin_data_ensure: { params: { name: string }; result: string }; // JSON — {path}
  plugin_data_list: { params: { name: string; path?: string }; result: string }; // JSON — {entries:[{name,is_dir,size}]}
  plugin_data_read: { params: { name: string; path: string }; result: string }; // text — 文件内容（UTF-8）
  plugin_data_write: { params: { name: string; path: string; content: string }; result: string }; // "null"
  plugin_data_delete: { params: { name: string; path: string }; result: string }; // "null"

  // ── Agent 隔离（worktree）────────────────────────────────
  agent_isolation_create: { params: { agent_id: string }; result: string }; // JSON
  agent_isolation_diff: { params: { agent_id: string }; result: string }; // JSON
  agent_isolation_merge: { params: { agent_id: string }; result: string }; // JSON
  agent_isolation_discard: { params: { agent_id: string }; result: string }; // JSON
  agent_isolation_status: { params: Record<string, never>; result: string }; // JSON
  agent_isolation_force_purge: { params: { agent_id: string }; result: string }; // JSON

  // ── 外部服务 ─────────────────────────────────────────────
  sandbox_status: { params: Record<string, never>; result: string }; // JSON — {degraded,reason}（Value 化：Rust 出口已展开）

  // ── 工作区 ───────────────────────────────────────────────
  workspace_activate: {
    params: { path: string };
    result: string;
  }; // "null"
  workspace_deactivate: { params: Record<string, never>; result: string }; // "null"

  // ── 会话持久化 ───────────────────────────────────────────
  // （workspace-session-ownership-rework 2026-08-27：chat 会话 NDJSON
  //  session_append 已拆——只写不读孤儿退役；唯一保留路径 = 工作区会话根
  //  全量快照（saveActiveSession/saveSessionById）。agent 侧
  //  session-log.ndjson 是另一条保留路径，见 agent_session_append。）
  agent_session_append: {
    params: { project_path: string; agent_id: string; messages: Record<string, unknown>[]; rewrite?: boolean };
    result: string; // "null"
  };

  // （read_constraints / write_constraints 已随 R4-4（2026-09-05）换 constraints_cap
  //   能力口直呼——builtin.constraints 退役。constraints_cap 本身随图谱全量
  //   退役删除（2026-09-09）——hologram.constraints.yaml 读写仅服务引擎 run_check，
  //   兰台侧已无消费方。）

  // （dataflow_save / dataflow_query / dataflow_delete 已随图谱全量退役删除
  //   （2026-09-09，dataflow_delete 前于 2026-09-08 首删）——engine-domain
  //   插件与 .lantai/dataflow 壳侧存储一并退役。）

  // （pty_spawn/write/resize/kill 已随 R4-4 小面清偿换 pty_cap 能力口直呼
  //   信封消费，kernel-plugin-runtime P2-6；pty-output 事件行仍在本文件 EventContract。）

  // （lsp_start/request/stop 已随 R4-4 小面清偿换 lsp_cap 能力口直呼
  //   信封消费（kernelLspCall），lsp-message 事件行仍在本文件 EventContract，
  //   kernel-plugin-runtime P2-6。）

  // （background_activity 已随 shell 域收口（R3-d）换 process_cap 直呼——状态栏
  //   HUD 消费点经 kernelProcessCall('background_activity')；当前无生产消费点
  //   （HUD 面），action 留口内备用。
  //   browser_audit 已随 R4 换 browser_cap 能力口直呼（浏览器域模型族工具消费），
  //   无 typedRpc 直呼点，RpcContract 行随 RPC 分支退役。）

  // ── MCP / ACP stdio 桥 ────────────────────────────────────
  protocol_bridge_spawn: {
    params: {
      id: string;
      command: string;
      args?: string[];
      /** env 追加注入（app shell S2）：受治进程的宿主寻址面——键值对追加进
       *  子进程环境（继承不替换）；LANTAI_PLUGIN_DATA_DIR = 插件数据目录。 */
      env?: Record<string, string>;
    };
    result: string;
  };
  protocol_bridge_write: {
    params: { id: string; line: string };
    result: string;
  };
  protocol_bridge_kill: {
    params: {
      id: string;
      /** 停止原因（#2 可观测性）：宿主侧具名原因（idle-timeout / window-closed /
       *  plugin-unloaded / activation-released / startup-failed）——Rust 落
       *  `.lantai/logs/bridge.log`，让「进程为什么没的」有持久证据。 */
      reason?: string;
    };
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
  /** LSP 消息 */
  'lsp-message': { session_id: number; message: unknown };
  /** 前台 shell 输出流 */
  'shell:output': { streamId: string; kind: 'stdout' | 'stderr'; chunk: string };
  /** 前台 shell 结束 */
  'shell:done': { streamId: string; exitCode: number; error?: string };
  /** PTY 输出（src-tauri 发射；旧前端未监听，新前端用 PTY 时需要） */
  'pty-output': { session_id: number; data: string };
  /** MCP/ACP stdio 桥 stdout 行 */
  'protocol-bridge:output': { id: string; line: string };
  /** MCP/ACP stdio 桥子进程退出（code = 真实退出码，null = 无码/被终结） */
  'protocol-bridge:exit': { id: string; code: number | null };
  /** 后台任务有新通知（完成/停滞）— utils/bg_jobs.rs 监视线程发射；
   *  owner = 发起该 job 的 agent id，null 表示用户/UI 发起（不投给任何 agent）。
   *  前端监听后排干该 owner 的通知并经 MessageBus systemNotify 唤醒 idle agent。 */
  'bg:note': { jobId: number; owner: string | null };
  /** 组合层热重载（S4-2，src-tauri composition_watcher.rs 发射）：根级
   *  roster.patch.yml 变更（"modified" | "removed"）→ 前端 patch-loader
   *  重跑 reload → composition-store 更新（新 Agent 装配即用新组合；
   *  在途会话不动——创建时点冻结语义）。 */
  'composition:changed': string;
  /** provider 配置文件热重载（2026-09-24 配方改文件批，src-tauri
   *  providers_watcher.rs 发射）：`~/.lantai/providers.yml` 变更
   *  （"modified" | "removed"）→ 前端 providers-store 重读 → 投影换新
   *  → 广播（UI 重读 + 逐会话重解析）。人/agent 手改文件即时生效的那一半。 */
  'providers:changed': string;
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

/** 带超时的类型化调用——只给「每步都会经过、且失败可安全跳过」的
 *  best-effort 调用兜底（如 loop 顶部的 drain_bg_notifications / plan
 *  提醒读取）。Tauri invoke 本身无超时语义：Rust 侧卡死或回包丢失时，
 *  无界 await 会让 run() 永不 settle（UI 永卡运行态的挂起源之一）。
 *  不要 blanket 化——bash 等长任务工具调用没有超时才是正确语义。
 *  超时后底层 invoke 仍可能在途：调用方须保证超时分支的跳过是安全的。 */
export async function typedRpcWithTimeout<M extends RpcMethodName>(
  method: M,
  params: RpcParamsOf<M>,
  timeoutMs: number,
): Promise<RpcResultOf<M>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      typedRpc(method, params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`rpc ${method} 超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 解析 Rust 返回的 JSON 字符串（ok_json 类方法）。"null" 会解析为 null。 */
export function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

/** JSON 返回命令的类型化调用（rpc Value 化两步 + 边界运行时校验层，2026-09-01）：
 *  parse 收进本函数（调用点不手写双重编码）；result 形状经 rpcResultSchemas
 *  safeParse，违形即 throw（错误信息带方法名 + zod issue 摘要，宪法四）。
 *  method 收紧为已收编命令集（keyof typeof rpcResultSchemas）——新调用未入表
 *  命令 = 编译错，签名即守卫；`// text` 命令继续 typedRpc 直通。
 *  双形态兼容（Value 化第二步）：JsonValue 形态命令在 Rust 出口已展开为真
 *  结构化 Value，直接校验；浏览器 mock / 表外形态仍返 JSON 字符串，parse
 *  慢路径后同样校验。校验规整后返回新对象——同引用透传属性退役。 */
export async function typedJsonRpc<M extends keyof typeof rpcResultSchemas>(
  method: M,
  params?: RpcParamsOf<M>,
): Promise<RpcSchemaResultOf<M>> {
  const raw = await rpc<unknown>(method, params ?? {});
  const value: unknown = typeof raw === 'string' ? parseJson(raw) : raw;
  const parsed = rpcResultSchemas[method].safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`rpc ${String(method)}: 返回形状违反契约 — ${issues}`);
  }
  return parsed.data as RpcSchemaResultOf<M>;
}

// ─────────────────────────────────────────────────────────────
// 运行时契约：JSON 命令 result 形状（rpc 边界运行时校验层，2026-09-01）
// ─────────────────────────────────────────────────────────────

/** DirEntry 递归形状（Rust utils::DirEntry 序列化同形——children 键恒在，
 *  无子为 null；truncated 截断旗标偶现）。list_directory / list_directory_flat 共用。 */
export type DirEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  children: DirEntry[] | null;
  truncated?: boolean;
};

const dirEntrySchema: z.ZodType<DirEntry> = z.lazy(() =>
  z
    .object({
      name: z.string(),
      path: z.string(),
      is_dir: z.boolean(),
      children: z.nullable(z.array(dirEntrySchema)),
      truncated: z.boolean().optional(),
    })
    .passthrough(),
);

/** list_directory / list_directory_flat 信封化后的返回形状校验（导出供
 *  rpc-result-schemas.test.ts 四态守护——旧 rpcResultSchemas 行已随 RPC 退役）。 */
export const dirEntryArraySchema = z.array(dirEntrySchema);

// ─────────────────────────────────────────────────────────────
// fs 能力口直呼便捷封装（kernel-capability-c3-design.md fs 域收口）
// ─────────────────────────────────────────────────────────────
// 内部持久化 I/O（canvas / 会话卷 / 记忆 / 技能 / 日志 / 渲染资产）的统一
// 出口：fs_cap 能力口直呼（builtin.fs 信封已退役——2026-09-04 fs 域收口）。
// 参数键 = fs_cap 顶层 snake_case（bridge.rpc() 转换幂等）；调用方一律用户
// 路径（is_agent=false 显式传——resolve_*_dispatch 只解析不过 Ask）。
// 返回 = 双形态（2026-09-05 会话列表回归修复）：fs_cap 是 JsonValue 形态
// 命令——真实 Tauri 运行时 Rust 出口已展开为真结构化 Value（对象）；浏览器
// mock / 测试 mock 返 JSON 字符串。各 helper 自行解包取字段时必须先判形态
// （typeof raw === 'string' 才允许 parseJson），禁止对返回值直接 JSON.parse
// （结构化对象会被 String() 成 "[object Object]" 再炸——712fda8d/8bce6ffb
// 窗口内会话卷读取全链路静默 null 的根因；回归钉 tests/fs-cap-dual-shape.test.ts）。

/** fs_cap 能力口直呼（双形态，见上）。is_agent=false = 用户路径。 */
function fsCapCall(params: RpcParamsOf<'fs_cap'>): Promise<unknown> {
  return typedRpc('fs_cap', params);
}

/** fs_cap read 统一：缺省原文（line_numbers=false）；opts.lineNumbers=true →
 *  cat -n 行号格式（2026-09 工具缺陷报告 Bug 1 拍板：行号 opt-in，payload
 *  不默认混入装饰前缀）。返回解析后的实际文件文本。 */
async function fsCapReadText(
  filePath: string,
  opts?: { lineNumbers?: boolean; offset?: number; limit?: number },
): Promise<string> {
  const raw = await fsCapCall({
    action: 'read',
    file_path: filePath,
    line_numbers: opts?.lineNumbers === true,
    ...(opts?.offset !== undefined ? { offset: opts.offset } : {}),
    ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    is_agent: false,
  });
  if (raw !== null && typeof raw === 'object') {
    // 结构化 Value（真实运行时）：{path, content} 信封取 content。
    const content = (raw as { content?: unknown }).content;
    return typeof content === 'string' ? content : '';
  }
  // 字符串形态（mock）：{content} 信封取 content；非 JSON / 无 content 字段
  // （异常文本、原文直通 mock）——原文直通。
  try {
    const parsed = parseJson<{ path?: string; content?: unknown }>(raw as string);
    if (typeof parsed.content === 'string') return parsed.content;
  } catch {
    // 非 JSON——直通
  }
  return raw as string;
}

/** 文本读（offset/limit 行号分页；lineNumbers=true 返回 cat -n 行号格式）。 */
export function kernelReadFile(
  filePath: string,
  opts?: { lineNumbers?: boolean; offset?: number; limit?: number },
): Promise<string> {
  return fsCapReadText(filePath, opts);
}

/** 全量原文读（canvas / 会话卷等 JSON 消费面的惯用形）。 */
export function kernelReadFileRaw(filePath: string): Promise<string> {
  return fsCapReadText(filePath);
}

/** fs_cap 写类 action 返回解析：取 {path} 的 path；非 JSON/无 path（测试 mock
 *  旧文案等）直通 raw——消费端多为 await 丢弃返回，容错直通等价。 */
function fsCapPathOf(raw: unknown): string {
  if (raw !== null && typeof raw === 'object') {
    const p = (raw as { path?: unknown }).path;
    return typeof p === 'string' ? p : '';
  }
  try {
    const parsed = parseJson<{ path?: unknown }>(raw as string);
    if (typeof parsed.path === 'string') return parsed.path;
  } catch {
    // 非 JSON——直通
  }
  return raw as string;
}

/** 原子写入（父目录自动创建；fs_cap write 返回解析后路径）。 */
export async function kernelWriteFile(filePath: string, content: string): Promise<string> {
  const raw = await fsCapCall({ action: 'write', file_path: filePath, content, is_agent: false });
  return fsCapPathOf(raw);
}

/** 创建目录（含父目录）。 */
export async function kernelCreateDirectory(path: string): Promise<string> {
  const raw = await fsCapCall({ action: 'create_dir', path, is_agent: false });
  return fsCapPathOf(raw);
}

/** 删除文件或目录树（不可逆）。 */
export async function kernelDeleteFile(path: string): Promise<string> {
  const raw = await fsCapCall({ action: 'delete', path, is_agent: false });
  return fsCapPathOf(raw);
}

/** 日志追加（fs_cap append——resolve_write_dispatch 用户路径只解析；旧
 *  builtin.fs log_append 的 EditTool sync 检查对 .lantai 内部写本放行，
 *  语义等价：UI 写 .lantai/logs 不受规则拦）。 */
export async function kernelLogAppend(path: string, content: string): Promise<string> {
  const raw = await fsCapCall({ action: 'append', path, content, is_agent: false });
  return fsCapPathOf(raw);
}

/** 追加 + fsync（durable 变体，2026-09-15 会话事件日志换轨）——**返回即已落盘**
 *  （Rust 侧 `confined_fs::append_text_durable`：write_all + sync_all，失败回滚到
 *  写入前 size 再抛，防重试产生重复/缺号）。检查点「排空队列」正是建立在这个
 *  语义上：flush 之后磁盘上就是完整前缀。 */
export async function kernelAppendFileDurable(path: string, content: string): Promise<string> {
  const raw = await fsCapCall({ action: 'append', path, content, durable: true, is_agent: false });
  return fsCapPathOf(raw);
}

/** 截断到指定字节偏移并 fsync（断尾修复原语）。 */
export async function kernelTruncateFile(path: string, offset: number): Promise<string> {
  const raw = await fsCapCall({ action: 'truncate', path, truncate_to: offset, is_agent: false });
  return fsCapPathOf(raw);
}

/** 全局记忆目录路径。 */
export async function kernelGlobalMemoryDir(): Promise<string> {
  const raw = await fsCapCall({ action: 'global_memory_dir', is_agent: false });
  return fsCapPathOf(raw);
}

/** list_directory 的 JSON 形状版（递归树/截断旗标同 dirEntrySchema 契约）。
 *  兼容双形状：fs_cap 真返回 {entries} 包装；测试 mock / 旧形态直返裸数组
 *  （mock 模拟 list_directory 返回 DirEntry[]）。 */
export async function kernelListDirectory(path: string, filterIgnored?: boolean): Promise<DirEntry[]> {
  const raw = await fsCapCall({ action: 'list', path, filter_ignored: filterIgnored ?? true, is_agent: false });
  const parsed = dirEntryArraySchema.safeParse(listPayloadOf(raw));
  if (!parsed.success) {
    throw new Error(`kernelListDirectory: 返回形状违反契约 — ${parsed.error.issues[0]?.message ?? ''}`);
  }
  return parsed.data;
}

/** list_directory_flat 的 JSON 形状版（非递归单层）。兼容双形状同 list。 */
export async function kernelListDirectoryFlat(path: string): Promise<DirEntry[]> {
  const raw = await fsCapCall({ action: 'list_flat', path, is_agent: false });
  const parsed = dirEntryArraySchema.safeParse(listPayloadOf(raw));
  if (!parsed.success) {
    throw new Error(`kernelListDirectoryFlat: 返回形状违反契约 — ${parsed.error.issues[0]?.message ?? ''}`);
  }
  return parsed.data;
}

/** list action 返回载荷提取：{entries} 包装取 entries；裸数组（测试 mock /
 *  旧形态）直用。双形态兼容同 fsCapPayloadOf；非 JSON 字符串返回 null
 *  （调用方 zod 校验兜错）。 */
function listPayloadOf(raw: unknown): unknown {
  const unwrap = (parsed: unknown): unknown => {
    if (Array.isArray(parsed)) return parsed;
    if (parsed !== null && typeof parsed === 'object') {
      return (parsed as { entries?: unknown }).entries ?? null;
    }
    return null;
  };
  if (typeof raw !== 'string') return unwrap(raw);
  try {
    return unwrap(parseJson<unknown>(raw));
  } catch {
    return null;
  }
}

/** read_memory_batch 的 JSON 形状版（.lantai 内多文件批量读）。 */
export async function kernelReadMemoryBatch(paths: string[]): Promise<Record<string, string | null>> {
  const raw = await fsCapCall({ action: 'memory_batch', paths, is_agent: false });
  const payload = raw !== null && typeof raw === 'object' ? raw : parseJson<unknown>(raw as string);
  const parsed = z.record(z.string(), z.nullable(z.string())).safeParse(payload);
  if (!parsed.success) {
    throw new Error(`kernelReadMemoryBatch: 返回形状违反契约 — ${parsed.error.issues[0]?.message ?? ''}`);
  }
  return parsed.data;
}

/** 媒体渲染二进制读（read_file_base64——renderer 消费，8MiB 源上限）。 */
export async function kernelReadFileBase64(filePath: string): Promise<string> {
  const raw = await fsCapCall({ action: 'read_base64', file_path: filePath, is_agent: false });
  if (raw !== null && typeof raw === 'object') {
    const b64 = (raw as { base64?: unknown }).base64;
    return typeof b64 === 'string' ? b64 : '';
  }
  try {
    const parsed = parseJson<{ base64?: string }>(raw as string);
    if (typeof parsed.base64 === 'string') return parsed.base64;
  } catch {
    // 非 JSON——直通
  }
  return raw as string;
}

/** 附图字节写（fs_cap write_base64——image-intake 消费，multimodal-image-plan
 *  D-13；用户路径 is_agent=false）。content 键承载 base64；返回解析后真实路径
 *  （双形态：结构化对象直取 / JSON 字符串慢路径 parse）。 */
export async function kernelWriteFileBase64(filePath: string, base64: string): Promise<string> {
  const raw = await fsCapCall({ action: 'write_base64', file_path: filePath, content: base64, is_agent: false });
  const payload = typeof raw === 'string' ? parseJson<{ path?: string }>(raw) : (raw as { path?: string });
  const path = typeof payload === 'object' && payload !== null ? payload.path : undefined;
  if (typeof path === 'string' && path !== '') return path;
  throw new Error('kernelWriteFileBase64: 返回形状违反契约（缺 path）');
}

// ── git_cap 直呼便捷封装（git 域收口，kernel-capability-c3-design.md R3-c）──
// 内部消费方（state-inject 的 git_status 状态栏 / git_blame 行级归属缓存）
// 的统一出口：git_cap 能力口直呼（tool_call 信封寻址 builtin.git 随插件退役）。
// 返回 run_git stdout 文本（porcelain 解析归 agent/git-porcelain.ts）。

/** git 域能力口调用（用户路径 is_agent=false——口内只解析零弹窗）。
 *  action = 退役前 builtin.git 工具名；args 说 git_cap 顶层契约语言
 *  （repo_path/file/file/message/branch/count）。 */
export function kernelGitCall(
  action: GitCapAction,
  args: Omit<RpcParamsOf<'git_cap'>, 'action' | 'is_agent'>,
): Promise<string> {
  return typedRpc('git_cap', { ...args, action, is_agent: false });
}

// ── process_cap 直呼便捷封装（shell 域收口，kernel-capability-c3-design.md R3-d）──
// 内部消费方（runtime 的 shell_env 注入、workspace/default-loop 的
// drain_bg_notifications、状态栏 HUD background_activity）的统一出口：
// process_cap 能力口直呼（tool_call 信封寻址 builtin.shell 随插件退役）。
// args 说 process_cap 顶层契约语言（snake_case；_owner_id 等 meta 原样透传）。

/** process 能力口调用（用户路径 is_agent=false——口内只解析零弹窗）。
 *  action = 退役前 builtin.shell 工具名。 */
export function kernelProcessCall(
  action: ProcessCapAction,
  args: Omit<RpcParamsOf<'process_cap'>, 'action' | 'is_agent'> = {},
): Promise<string> {
  return typedRpc('process_cap', { ...args, action, is_agent: false });
}

// ── pty 直呼便捷封装（R4-4 小面清偿：builtin.pty 退役换 pty_cap 直呼）──
// PTY 会话（旧 rpc.rs PTY 分区）：pty-output 事件仍在 EventContract；
// UI/内部消费方经本封装直呼（tool 名 = pty_cap action，一位）。

/** pty 域通用直呼。 */
export function kernelPtyCall(tool: string, args: Record<string, unknown>): Promise<string> {
  return typedRpc('pty_cap', {
    ...args,
    action: tool as 'pty_spawn' | 'pty_write' | 'pty_resize' | 'pty_kill',
    is_agent: false,
  });
}

// ── lsp 直呼便捷封装（R4-4 小面清偿：builtin.lsp 退役换 lsp_cap 直呼）──
// LSP 会话（ui/lsp-client.ts 消费）：lsp-message 事件仍在 EventContract。
// lsp_request 返回 JSON 字符串——调用方 parseJson 后消费（直呼统一 text
// 形态）。

/** lsp 域通用直呼（text 形态结果直通；JSON 形态调用方自行 parseJson）。 */
export function kernelLspCall(tool: string, args: Record<string, unknown>): Promise<string> {
  return typedRpc('lsp_cap', { ...args, action: tool as 'lsp_start' | 'lsp_request' | 'lsp_stop', is_agent: false });
}

/** lsp_request 信封调用 + JSON 解析（旧 rpc lsp_request 是 JsonValue 形态，Rust
 *  出口自动展开成对象——信封统一 text 形态后调用方 parseJson 恢复同语义）。 */
export async function kernelLspRequest<T = unknown>(args: {
  session_id: number;
  method: string;
  params?: Record<string, unknown>;
}): Promise<T> {
  return parseJson<T>(await kernelLspCall('lsp_request', args));
}

/** 运行时契约：`// JSON` 注释命令的 result 形状，与上方 RpcContract 的
 *  `// JSON` 注释同源维护（后端加/改方法 → 同步本表；schema 是 result 注释的
 *  运行时投影）。键集 = 已收编命令集；未登记的 `// JSON` 命令 = 当前无
 *  typedJsonRpc 调用点，未来首个调用者出现时签名强制入表。`// text` 禁入。
 *  形状档：全检 = 字段级 zod；粗检 = z.unknown()（载荷随工具/体量不可控，
 *  内容契约归 define-tool 工具面或消费方）。
 *  字段可选性以 Rust Ok 路径真实形状为准（rpc.rs rpc_result_shape 表 + 命令
 *  实现/结构体定义双源核对，2026-09-01 实测；object 一律 passthrough——
 *  边界管形状对错，不做字段集冻结，Rust 加字段不炸前端）。 */
export const rpcResultSchemas = {
  get_last_project: z.nullable(z.string()),
  workspace_list: z.array(
    z
      .object({
        path: z.string(),
        name: z.nullable(z.string()),
        last_opened_at: z.string(),
        pinned: z.boolean(),
        session_count: z.number(),
        latest_saved_at: z.nullable(z.string()),
        dir_exists: z.boolean(),
      })
      .passthrough(),
  ),
  // plugin_data_*（app shell 件 B，S1）：ensure={path}；list={entries:[…]}。
  plugin_data_ensure: z.object({ path: z.string() }).passthrough(),
  plugin_data_list: z
    .object({
      entries: z.array(z.object({ name: z.string(), is_dir: z.boolean(), size: z.number() }).passthrough()),
    })
    .passthrough(),
  // 随包图谱引擎探测（2026-09-24 补收编）：恒 JSON 对象；三字段可空（未找到 =
  // path/dir 为 null、available false，非错误）。收编后消费面走 typedJsonRpc ⇒
  // 双形态兼容（Rust 出口已展开 / 表外仍字符串）+ 违形即 throw（不再静默读成 false）。
  engine_bundled_info: z
    .object({
      path: z.nullable(z.string()),
      dir: z.nullable(z.string()),
      available: z.boolean(),
    })
    .passthrough(),
  sandbox_status: z
    .object({
      available: z.boolean(),
      degraded: z.boolean(),
      reason: z.string(),
    })
    .passthrough(),
  // （shell_env 已随 shell 域收口（R3-d）换 process_cap 直呼——runtime 经
  //   kernelProcessCall + parseJson 消费，Text 形态无 rpcResultSchemas 收编面。
  //   git_status 已随 git 域收口（R3-c）换 git_cap 直呼——state-inject 经
  //   kernelGitCall + git-porcelain.ts 解析 stdout，无 rpcResultSchemas 收编面。）
} satisfies Partial<Record<RpcMethodName, z.ZodType>>;

/** 已收编命令的 result 类型（schema 推导——调用点不再手写泛型）。 */
export type RpcSchemaResultOf<M extends keyof typeof rpcResultSchemas> = z.infer<(typeof rpcResultSchemas)[M]>;

/** workspace_list 元素（Rust WorkspaceSummary 同形）。 */
export type WorkspaceSummary = RpcSchemaResultOf<'workspace_list'>[number];

/** workspace_list 短期缓存（P1-2，2026-09-02）：SessionsHome 挂载拉一次、
 *  切区/首页重进又拉一次——TTL 内复用同一次结果；过期/写操作
 *  （rename/pin/remove）由调用方显式失效（clearWorkspaceListCache）。
 *  只缓存成功结果。 */
const WORKSPACE_LIST_TTL_MS = 10_000;
let _wsListCache: { at: number; data: WorkspaceSummary[] } | null = null;

export function clearWorkspaceListCache(): void {
  _wsListCache = null;
}

/** 带短期缓存的 workspace_list——读方一律走此入口。 */
export async function workspaceListCached(): Promise<WorkspaceSummary[]> {
  if (_wsListCache && Date.now() - _wsListCache.at < WORKSPACE_LIST_TTL_MS) {
    return _wsListCache.data;
  }
  const data = await typedJsonRpc('workspace_list', {});
  _wsListCache = { at: Date.now(), data };
  return data;
}

export type EventName = keyof EventContract;

/** 事件名/payload 受 EventContract 约束的 listen。 */
export async function typedListen<E extends EventName>(
  event: E,
  handler: (payload: EventContract[E]) => void,
): Promise<() => void> {
  return listen<EventContract[E]>(event, (e) => handler(e.payload));
}
