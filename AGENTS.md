# HoloGram — Agent 项目手册

> 生成：2026-06-18 · 更新：2026-08-17（按 main HEAD 与实测基线校准；agent-core-convergence Phase 0-6 已并入 main）
> 本文件是项目级静态注入文档：Codex 读 `AGENTS.md`，Claude Code 读 `CLAUDE.md`，内置 HoloGram Agent 把 `CLAUDE.md` 注入 system prompt。
> **编码规则不是本文件的正文，而是 `CONVENTIONS.md` + `INVARIANTS.md`；本文件负责让规则真正被执行。**

## 0. 开工前强制加载（不可跳过）

1. 先读根目录 `CONVENTIONS.md`（当前编码约定，以代码现状为准）。
2. 涉及 `src-ui/src/ui/**`、`src-ui/src/agent/**` 或 Rust 接缝时，读 `INVARIANTS.md`（已炸过的雷）。
3. 规则优先级：`docs/adr/project-constitution.md`（四条架构约定）> `INVARIANTS.md` > `CONVENTIONS.md` > 本文件 > 历史 plan/handoff。
4. 改高 fan-in 文件前先问图（内置 Agent：`graph(preflight|impact)`；外部 MCP：`preflight_check` / `trace_impact`）。
5. 规则与代码现状冲突时：以代码为准，更新规则文档，不要盲改；无法判断就停下来问用户。

## 1. 一句话

把代码库变成可对话的 3D 依赖星图，并内置多 Agent 编码工作台——用确定性的图查询替代 LLM 逐文件猜源码。

## 2. 目录结构（当前实际）

```
HoloGram/
├── engine/            Rust 分析引擎（27 静态 tree-sitter 语法；35 默认 MCP 工具 / 36 schema）
├── src-tauri/         Tauri 2 桌面壳（rpc.rs 单一 IPC 入口 + 权限沙箱 + 命令实现）
├── src-ui/            TypeScript 前端（React 19 + Three.js + Monaco + Zustand 5）
│   ├── src/app/       新观测台壳（单 React 根；新 UI 落这里）
│   ├── src/ui/        星图 scene + 领域 stores + 旧 React 岛
│   └── src/agent/     Agent 运行时、工具层、多 Agent、goal/plan
├── docs/              架构/ADR/交接/研究；archive/ 是历史，勿作现状依据
├── assets/            图标、UI 原型
├── grammars/          tree-sitter 动态语法产物（Kotlin/Markdown/TOML）
├── CLAUDE.md          内置 Agent 系统提示 + Claude Code 项目指令
├── AGENTS.md          本文件（Codex/OpenAI 静态注入）
├── CONVENTIONS.md     编码约定（开工前必读）
├── INVARIANTS.md      踩碎必炸的雷（改动前必读）
├── CONTEXT.md         应用级统一词汇（kind/status 重载字段带簇前缀）
└── ARCHITECTURE.md    系统架构总览
```

> `tests/` 根目录已不存在（旧 Python 测试已随引擎 Rust 化移除），不要以旧文档里的 `tests/` 路径为准。

### `.hologram/` 运行时目录

```
.hologram/
├── agents/{agentId}/             Agent 会话槽 + inbox.json（JsonMessageStore）
├── taskboard/{sessionId}.json    会话级 TaskBoard
├── discoveries/{sessionId}.json  会话级 DiscoveryBoard
├── goals/{id}/                   Goal 状态（goal.json/session.json/index.json）
├── permissions.json              项目级权限规则
├── hologram.db + FTS5            图存储/全文索引
├── baseline.json                 约束基线
├── audit.jsonl                   审计日志
├── vectors.slots.json / vectors.usearch   语义向量索引
└── logs/                         运行日志
```

## 3. 数据流

```mermaid
flowchart LR
  UI[src-ui React + Agent] -->|typedRpc invoke| Tauri[src-tauri rpc.rs]
  Tauri -->|TCP 127.0.0.1:9777| Engine[engine/]
  Engine -->|tree-sitter| AST[27 语言 AST]
  Engine -->|GraphStore| DB[(.hologram/hologram.db + FTS5)]
  MCP[Cursor / Claude Code] -->|stdio serve| Engine
```

## 4. 引擎能力与工具面（2026-08-17 实测）

- **语言**：27 种 tree-sitter 语法静态链接；18 族适配器有专用结构查询（`.scm`，`engine/queries/` 共 38 个查询文件），其余静态语言走通用兜底；JSON 语法在代码中禁用（数据文件不解析）；Kotlin / Markdown / TOML 动态加载。
- **引擎 MCP 工具**：36 个 schema，默认激活 35 个（`symbol_history` 为 legacy 不默认激活；`HOLOGRAM_MCP_TOOLS=*` 放开全量）。外部 MCP 客户端（Cursor/Claude Code）仍见细粒度工具名。
- **内置 Agent 领域工具**（模型可见）：`fs / shell / git / search / web / agent / task / memory / browser / desktop / graph / ops / lsp` + 常驻 `ask_user / Skill / wait / enter_plan_mode / exit_plan_mode`。
  - `graph`：symbols / neighbors / impact / preflight / cycles / coupling / fragile / flows / dataflow 等 24 个只读动作——**改代码前先问图**。
  - `ops`：analyze / validate / health / status / timeline / rename / import_scip。
  - `lsp`：resolve_call / infer_type / implementations / references。
  - 旧细粒度名（`search_symbols`、`run_shell`、`write_file`、`git_*`、`agent_spawn` 等）保留但 `hide()`；模型调用会被 `retireRedirect` 拦截并给 `[已淘汰]` 重定向。内部代码/测试仍可直接用旧名。

## 5. 快速操作（Agent 视角）

| 任务 | 命令/工具 |
|---|---|
| 探索代码结构 | 内置 `graph(symbols|explore|neighbors)`；外部 MCP `explore_deps` / `search_symbols` |
| 改文件前影响面 | 内置 `graph(action:'preflight', path:[...])`；外部 MCP `preflight_check` |
| 高风险模块 | `graph(fragile)` / `graph(cycles)` / `graph(blindspots)` |
| 改引擎 | `cd engine && cargo test`（快验 `cargo build`） |
| 改前端 | `cd src-ui && npm run build` + `npx vitest run` |
| 改壳 | `cd src-tauri && cargo test`（快验 `cargo check`） |
| 桌面打包 | `cd src-tauri && cargo tauri build`（自动先跑前端构建） |
| 前端格式 | `cd src-ui && npx biome check --write <改动文件>` |

## 6. 前端分层铁律（详情见 CONVENTIONS.md）

- `src/app/` 新代码**不新增** `import .../ui/events`；UI 状态走 zustand store。`ui/events.ts` 是冻结的旧总线（存量 ~20 个 import），不再新增 BusEvents 事件。
- 面板级状态用 `createScopedStore` 注册表（`messages/session/panel/input` 四件套 + `chat-store` 聚合）；app 级单例用 `shell-store / dock-store / overlay-store`。
- 聊天消息原地 mutate 后必须 `touchMessage / touchMessageContaining`——裸 `bump()` 或展开数组会静默卡 UI（`INVARIANTS #1/#2/#3`）。
- 冻结文件：`ui/chat-session.ts`、`ui/chat-stream.ts`、`ui/part-mutator.ts`、`agent/execution-state.ts`。
- 样式只写 `--obs-*` token；不引入新 CSS 方案；DOM 所有权按层划分（React UI 不自建游离 DOM，星图 scene / Monaco 宿主是既有 imperative-DOM 所有者）。
- 工作区级资源两原语（2026-08-17 立规，详情 CONVENTIONS.md §1.10 + INVARIANTS #12）：**获取必须登记进 `Workspace._bag`（`agent/lifecycle.ts` DisposerBag）**；**跨工作区 fire-and-forget 写共享态必须 `getWorkspaceEpoch()/isCurrentEpoch()` 校验**。deactivate/forceClearState 只调 `_bag.dispose()` + `bumpWorkspaceEpoch()`。

## 7. RPC 与工具契约（详情见 CONVENTIONS.md + INVARIANTS #7-#10）

- 前端一律 `typedRpc / typedListen`（`src-ui/src/rpc-contract.ts`），参数键 snake_case，返回 string（JSON 用 `parseJson`）。裸 `rpc` 只允许两个受权出口：`rpc-contract.ts` 与 `agent/tool.ts`，biome 禁新增。
- 新增模型工具必须 `defineTool` + zod v4：一个 schema 产出 JSON Schema / 运行时校验 / 类型化参数。内部 `.passthrough()` 透传 meta key；`_forceGate` 要声明、`_callId/_agent_id` 不声明。
- 工具 execute 必须全量透传 args——重建参数对象会丢掉 `_agent_id`，fork 子 Agent 会直写主仓（2026-08-13 事故）。
- 新增领域动作同步 `tools/domains.ts` 的 `DOMAIN_SPECS` + `collectHiddenToolNames()` + 对应测试 + 本文件。
- Agent 装配（Phase 6 立规）：新增模型工具/hook 走 `agent/blueprint.ts` 的 capability 表，不改 `AgentConfig`（冻结 31 字段）；capability 表序 = 工具面字节契约（前缀缓存 + effective 快照依赖此序）；capability 只做组合，teardown 走 `ctx.effect`。
- session 变异（Phase 5 立规）：只走 `_appendMessage / _replaceSession / _retractSessionRange` 三入口（spec AST 白名单 + gate 计数双层门禁）；改工具折叠逻辑必须同步 `session-log.ts` 的 `derivePayload`。
- 改 `src-ui/src/agent/**` 必过 `npm run verify:convergence`（T0 静态 + 8 baseline 对拍）；record 永不上 CI，baseline 变更走 `docs/plans/agent-core-convergence/baseline-change-request.md` 审批。
- 新增 RPC：`src-tauri/src/rpc.rs` 分支 + 前端 `RpcContract`；`docs/agents/frontend-rpc-contract.md` 由 `scripts/gen-rpc-contract-md.cjs` 生成，勿手改。

## 8. 多 Agent 并发纪律（事故报告：docs/agents/platform-bugs-2026-08-13.md）

- 子 Agent 注册表必须 `convergeRegistry(subTools)` 重建领域工具；克隆来的 `fs/shell` 闭包绑父注册表，不重建会绕过所有权包装、构建禁令、plan 只读。
- 文件所有权（`file-ownership.ts`）覆盖 fresh 与隔离降级的 fork；claim 键斜杠归一。
- merge 据实三原则：无产出不报 ✅；清理失败 ≠ 合并失败；冲突保留 worktree（diff 有 32KB 截断，worktree 是全量现场）。`agent(merge)` 进程内串行。
- `edit_file` 并发安全在 Rust 临界区（`editor.rs checked_write_atomic`：进程级锁 + fail-closed 重读校验）；TS 侧不得假设「返回成功 = 落盘」之外的时序。
- TTL 清理不得销毁无记录的工作：discard 前抓 diff 回 board，抓不到保留现场并通知父 Agent。
- 模型可见子 Agent ID `sub-{timestamp}-{random}`；worktree ID `agent-{timestamp}-{random}`；池内部 ID 不暴露给模型。

## 9. Goal / Plan 模式要点

- `/goal`：`goal-manager.ts` 驱动 `Agent._goalLoop`；状态在 `.hologram/goals/{id}/`，与普通聊天槽隔离；完成靠 `goal_report` 工具，`[GOAL_COMPLETE]` 只是旧会话 fallback。
- Plan 模式：工具 schema 跨模式恒定（保护 DeepSeek 前缀缓存）；写约束由 `planGate` 在执行层拦截。只读动作放行，fs write/edit 计划文件豁免，agent spawn 豁免；plan 中 spawn 的子 Agent 静态只读（`planRegistry()`）。

## 10. 验证基线（2026-08-17 实测，数字会漂移，以重新实测为准）

| 层 | 命令 | 基线 |
|---|---|---|
| 引擎 | `cd engine && cargo test` | 697 tests（lib 669 + bin 27 + doc 1；696 passed / 1 ignored） |
| 壳 | `cd src-tauri && cargo test` | 322 tests（bin 308 + 集成 14，全绿；pwsh 冒烟在无 pwsh 7 的环境自动跳过） |
| 前端 | `cd src-ui && npx vitest run` | 1200 passed / 1 skipped（116 文件，共 1201） |
| 前端构建 | `cd src-ui && npm run build` | tsc --noEmit + vite build 全绿 |
| Agent 运行时 | `cd src-ui && npm run verify:convergence` | exit 0（T0 静态 + 全部 phase specs 对拍 8 baseline） |
| 前端格式 | `cd src-ui && npx biome ci .` | 588 errors / 335 warnings 是存量基线，不要顺手清；改动文件零新增 |
| 打包 | `cd src-tauri && cargo tauri build` | 发布构建；不要用 `cargo build --release` 代替 |

CI 只做编译 + 测试；`.github/workflows/ci.yml` 不可修改。

## 11. 不要做的事

- 不要恢复 Python 引擎路径（`src_python/` 已退役，`tests/` 已移除）。
- 不要改 `graph-layout.ts` / `gpu-layout.ts` 的布局参数（除非用户明确要求）。
- 不要在应用程序层「推断 bug 根源 / 解释因果」——产品只呈现图数据；编码 Agent 的排查推理不受此限制。
- 不要用 `cargo build --release` 代替 `cargo tauri build`。
- 不要动 `.github/workflows/ci.yml`。
- 不要把与任务无关的未提交改动混进 commit；用户工作区改动要单独确认。

## 12. 文档地图（只信这些是现状）

| 文档 | 作用 |
|---|---|
| `CONVENTIONS.md` / `INVARIANTS.md` | 编码规则 + 雷区（开工前必读） |
| `docs/adr/project-constitution.md` | 四条最高架构约定 |
| `docs/landmine-map.md` | 已知技术债/雷区拆弹状态 |
| `docs/README.md` | 文档总索引（先看这个） |
| `ARCHITECTURE.md` / `README.md` | 架构总览 / 使用与构建 |
| `CONTEXT.md` | 应用级词汇（`kind`/`status` 带簇前缀） |
| `docs/MULTI_AGENT_ROADMAP.md` | 多 Agent 路线图与已落地能力 |
| `docs/plans/README.md` | 进行中的计划/实验（状态表） |
| `docs/agents/frontend-rpc-contract.md` | RPC 契约生成物（勿手改） |
| `docs/archive/README.md` | 归档说明与历史目录 |
