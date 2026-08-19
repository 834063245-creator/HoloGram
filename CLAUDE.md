# CLAUDE.md — HoloGram 项目规范

> 本文件由 AgentRuntime 在创建每个会话时读入 system prompt（`src-ui/src/agent/runtime/runtime.ts`），
> 对 Claude Code 直接生效；Codex 读 `AGENTS.md`，而 `AGENTS.md` 强制加载同一套规则。

## 规则优先级

`docs/adr/project-constitution.md` > `INVARIANTS.md` > `CONVENTIONS.md` > 本文件 > 历史 plan/handoff。
有冲突时以左边为准；无法判断就停下来问用户。

## 开工顺序（不可跳过）

1. **动任何代码前，先读根目录 `CONVENTIONS.md` 和 `INVARIANTS.md`。** 没读不要改文件。
2. 修改 `src-ui/src/ui/**` 或 `src-ui/src/agent/**` 前，逐条核对 INVARIANTS，并 grep 目标文件的 `⚠️ INVARIANT` 注释。
3. 改高 fan-in 文件前先查图影响面：内置工具用 `graph(preflight)` / `graph(impact)`；外部 MCP 用 `preflight_check` / `trace_impact`。
4. 在代码库里找做同类事的文件，复制它的模式。不要发明新的状态、通信、工具定义或错误处理方式。

## 硬约束

- **四条架构约定**（最高）：类型边界 / 单一权威源 / 异步纪律 / 错误不静默。详见 `docs/adr/project-constitution.md`；新代码违反即返工。
- **前端**：React 19 + Zustand 5。跨组件业务状态走 zustand store（面板级走 `createScopedStore` 注册表）；事件总线已归零（`ui/events.ts` 已删除，禁复活——不要 window.dispatchEvent / CustomEvent / 自建 EventEmitter）。分层终态：store 一律 `src/state/`、星图一律 `src/scene/`、`src/ui/` 残余 = chat 编排域核心 + 旧层命令式基础设施（见 `src/ui/README.md`）；新组件落 `src/app/**`。聊天消息原地 mutate 后必须 `touchMessage` / `touchMessageContaining`。
- **RPC**：前端调后端一律 `typedRpc` / `typedListen`（`src-ui/src/rpc-contract.ts`）；参数键 snake_case。新增后端方法同步 `src-tauri/src/rpc.rs` + `RpcContract`，生成文档用 `scripts/gen-rpc-contract-md.cjs`。受权文件之外裸 `rpc` 会被 biome 拦截。
- **工具**：模型工具必须 `defineTool` + zod v4；领域动作变更同步 `DOMAIN_SPECS` / `collectHiddenToolNames()` / 测试。禁止手写 schema、execute 里 `as` 强拆、用 `.strict()`。
- **Agent 运行时**（agent-core-convergence 立规）：新增模型工具/hook 走 `agent/blueprint.ts` capability 表，不改 `AgentConfig`（冻结 31 字段）；capability 表序 = 工具面字节契约（前缀缓存 + effective 快照依赖）；teardown 走 `ctx.effect`，不做进 capability。session 变异只走 `_appendMessage` / `_replaceSession` / `_retractSessionRange` 三入口；改工具折叠同步 `session-log.ts` 的 `derivePayload`。以上全部门禁化：`npm run verify:convergence` 失败即返工。
- **Rust**：生产代码零裸 `.unwrap()`（测试模块除外）。锁中毒用 `lock_or_recover` / `read_or_recover` / `write_or_recover`（src-tauri），engine 用 `unwrap_or_else(|e| e.into_inner())`。失败必须可见，写入/持久化错误不得静默吞。
- **Windows 路径**：拆 `location` 的 `文件:行` 只拆最后一个冒号（`rsplit_once(':')`），不要吃掉 drive letter。
- **不改的**：`graph-layout.ts` / `gpu-layout.ts` 的布局参数、`.github/workflows/ci.yml`、Python 引擎路径（已退役，不要恢复）。
- **产品输出纪律**：应用的程序层只呈现图数据，不替用户推断 bug 根因/解释因果。这条限制的是你写进产品 UI/工具输出的内容；你排查问题时照常推理，结论写在回复/计划/代码注释里。

## 验证门禁（不过不交付、不 commit）

| 改动 | 命令 |
|---|---|
| 前端 | `cd src-ui && npm run build`（tsc --noEmit + vite build） |
| 前端逻辑 | `cd src-ui && npx vitest run` |
| 前端格式 | `cd src-ui && npx biome check --write <改动文件>`（全仓 588 errors/335 warnings 是存量基线，只保证自己零新增） |
| Agent 运行时 | `cd src-ui && npm run verify:convergence`（T0 静态 + 8 baseline 对拍；record 永不上 CI，baseline 变更走 change request 审批） |
| 引擎 | `cd engine && cargo test`（快验 `cargo build`） |
| 壳 | `cd src-tauri && cargo check`；权限/锁/IPC/命令改动跑 `cargo test` |
| 桌面打包 | `cd src-tauri && cargo tauri build`（会自动先跑前端构建；根目录 `build.cmd` 是 Windows 包装） |

禁止用 `cargo build --release` 代替桌面发布验证。当前实测基线：engine 697 tests（696 passed / 1 ignored）· src-tauri 343 tests（bin 全绿）· 前端 1254 passed / 1 skipped（共 1255，124 文件；2026-08-18 cordis-migration P0-P4 后）。

## 项目快照

- **定位**：把代码库解析成可对话的依赖星图，并内置多 Agent 编码工作台。桌面应用 = Tauri 2 + Rust 引擎 + TypeScript/React 19 + Three.js + Monaco。
- **工具层**：内置 Agent 可见领域工具 `fs / shell / git / search / web / agent / task / memory / browser / desktop / graph / ops / lsp` + `ask_user / Skill / wait / plan`。旧工具名（`run_shell`、`write_file`、`git_*`、`search_symbols` 等）已淘汰，模型调用会被重定向。
- **图优先**：`graph(symbols/impact/preflight/...)` 是改代码前的工作流入口，grep 只做兜底。
- **现状文档**：先查 `docs/README.md`（文档索引）；项目手册 `AGENTS.md`、架构 `ARCHITECTURE.md`、词汇 `CONTEXT.md`、多 Agent 工作台 `docs/MULTI_AGENT_ROADMAP.md`。`docs/archive/` 是历史，勿作现状。
