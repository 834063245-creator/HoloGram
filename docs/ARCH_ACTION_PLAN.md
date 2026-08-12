# 架构整治行动计划（ARCH_ACTION_PLAN）

> 来源：2026-08-12 架构审查（对照 openhanako 问题清单倒查 HoloGramHG 的结论）。
> 目标：清除会误导 Agent 的死代码与失效契约，让代码库的"可读真相"与实现一致。
> 原则：**只拆不重构**（搬移可以，改逻辑不行）；每批独立 commit；每项带验收标准。

## 批次总览

| 批次 | 主题 | 性质 | 状态 |
|---|---|---|---|
| 第一批 | 误导性死代码大扫除 | P0 | ✅ 已完成（commit 0c65b81，2026-08-12） |
| 第二批 | 契约与文档诚实化 | P0 | ✅ 已完成（commit d473d3d，2026-08-12；执行记录见下方阻塞项小节） |
| 第三批 | 整洁度（文件拆分/收敛） | P2 | ⏳ 进行中（13/12/11a 已完成；11b 中断待重做；11c/14 未动；执行记录见下方阻塞项小节） |

执行顺序：批 1 → 批 2 → 批 3。批 1+2 完成后，代码库对 Agent 的"误导面"基本清零。

---

## 第一批：误导性死代码大扫除

| # | 任务 | 动作 | 验收 |
|---|---|---|---|
| 1 | 三个 demo HTML（demo.html / pill-demo.html / toolbar-demo.html） | 移到 `prototype/` 归档（保留设计 token 参考价值） | `rg "demo\.html"` 零引用，原型目录可读 |
| 2 | `src-ui/src/ui/layout.worker.ts`（12 行，零引用） | 删除（main.ts 中清理注释证实 worker 布局路径已废弃） | 文件消失，vitest / cargo 全绿 |
| 3 | `src-ui/src/bridge/mock-data.ts`（989 行，静态 import 进生产 bundle） | 改动态 `import()`，仅非 Tauri 环境加载 | 生产 bundle 体积下降，dev 模式 mock 功能不变 |
| 4 | `gsap` + `@xterm/xterm` + 3 个 addon（package.json 零引用依赖） | 从 package.json 移除 | `rg` 零引用 + 构建通过 |
| 5 | `src-tauri/src/os_sandbox.rs` AppContainer 死代码（~150 行 Win32 FFI，never constructed） | **决策点（默认删）**：删除 AppContainer variant 及相关 FFI/常量/结构体，同步修正 ARCHITECTURE.md:112 的能力宣称（Windows 沙箱实际由 Job Object 承担）；保留 Job Object + CreateProcessW 路径 | 移除 `#[cfg_attr(windows, allow(dead_code))]`，`cargo build -D warnings` 干净 |
| 6 | 警告快照过期（short_warnings.txt / tauri_warnings.txt，2026-07-03，51 条） | 重建或删除 | 与"CI -D warnings 铁律"（ARCHITECTURE.md:674）一致，可复核 |

---

## 第二批：契约与文档诚实化

| # | 任务 | 动作 | 验收 |
|---|---|---|---|
| 7 | RPC 契约启用（**最大误导源**：typedRpc/typedListen 已写好但生产调用点为零，实际 138 处裸字符串 `rpc<string>('...')` + 手动 JSON.parse） | 分两段：a) biome 规则禁新增裸 `rpc<string>('...')` 调用；b) 存量 138 处按方法分组迁移到 `typedRpc`，每迁一组跑一次 vitest | a 立即生效；b 逐步清零；删除 rpc-contract.ts 里"纪律未被遵守"的注释 |
| 8 | 桥层默认无类型（`invoke<T = any>` / `listen<T = any>` / `rpc<T = any>`，src-ui/src/bridge.ts） | 泛型改为显式必填，由编译器逼出所有调用点的真实类型 | `tsc` 通过，桥层零默认 any |
| 9 | 文档漂移修正（ARCHITECTURE.md） | 修正过期数字：用例数（实际 engine 654 + src-tauri 273）、schema 数（实际 35）、rpc 方法数（实际 102）、bash.rs 行数、Engine"零外部依赖"措辞（改为"零外部运行时进程"）；同步 CONVENTIONS.md:116 的 unwrap 条款与第 10 项的实际状态 | 文档与代码可交叉验证 |
| 10 | 生产锁 unwrap 清理（约 85 处，集中在 lsp_manager.rs 27 / grpc_services.rs 20 / vector 13 / engine 6） | 换仓库已验证模式 `unwrap_or_else(\|e\| e.into_inner())`（先例：engine/src/graph/id.rs:135），或改用 parking_lot（引擎图核心已用） | 生产代码 `.unwrap()` 清零（测试模块除外），`cargo test` 全绿 |

---

## 第三批：整洁度（顺手清）

| # | 任务 | 动作 | 状态 |
|---|---|---|---|
| 11 | 文件级拆分（纯搬移，不重构逻辑） | `src-tauri/src/utils.rs`（~2000 行/79 fn/8+ 关注点）按 bg_jobs / build_lock / ipc_guard / path_resolve 拆模块；`engine/src/tools/handlers.rs`（~2400 行）按工具域拆文件；`src-ui/src/agent/agent.ts`（2963 行）按流式循环/上下文压缩/子 Agent 拆类 | **11a ✅；11b ✅（重做完成）；11c ⏸️ 搁置（用户决定，见执行记录）** |
| 12 | 两套 markdown 渲染收敛 | 统一 react-markdown 新路径，删除 marked+DOMPurify 旧路径（src-ui/src/ui/chat-utils.ts:360、file-viewer.ts:1240） | ✅ 已完成（见阻塞项执行记录） |
| 13 | `src-ui/src/ui/graph-fold.ts` 类型分叉 | 改为 import `graph-types.ts` 的 GraphNode/EdgeData/CommunityData，删除文件内手写类型 | ✅ 已完成 |
| 14 | `any` 渐进清理（211 处） | 先清密集区：`workspace.ts`（graphData）、`ui/lsp-client.ts`、`ui/chat-session.ts`、`graph-scene-lifecycle.ts`；`noExplicitAny` 从 warn 提为 error 放在清理完成之后 | ⬜ 待执行 |

---

## 明确不碰的（禁区）

- **`src-ui/src/app/chat/chat-core.ts` 的 `_stubPanel` 等 DOM 桩**：旧命令式层（chat-session/chat-stream 约 1570 行）仍是活代码，属于行为迁移而非清理——单独立项，靠 `chat-session.test.ts`（777 行）兜底，不要混入本计划批次。
- **engine MCP 工具层 `serde_json::Value` 传参**（handlers.rs 的 `args: &Value` + `get_str` 双 key 解析）：INVARIANTS #7 已承认该代价，重构风险大于收益，不动。
- **三个 God 文件只拆不重构**：搬移可以，改逻辑不行（第 11 项约束）。

## 通用执行规则

1. 每批一个独立 commit，commit message 注明批次与任务号（如 `chore(cleanup): batch-1 remove dead demo prototypes`）。
2. 每项完成后立即跑验证：Rust 侧 `cargo test`（927 个）+ `cargo build -D warnings`；UI 侧 `vitest`（821 个）+ `tsc` + `biome check`。
3. 任何一项发现"搬不动"（有隐藏调用点/行为依赖），停下记录到本文件的"阻塞项"小节，不要绕过。
4. 改动前先 `git status` 确认工作区干净；每批独立提交，便于单独回滚。

## 阻塞项登记（待补充）

- **任务 5（2026-08-12 执行记录，非阻塞）**：os_sandbox.rs 的 AppContainer 代码早已在 f39b438（refactor(sandbox): remove AppContainer）整体移除，现存 `#[cfg_attr(windows, allow(dead_code))]` 标注属于跨平台专属代码（retry_spawn / is_transient_spawn_error 等仅 mac/linux 路径使用），**不能移除**，否则 Windows 下 -D warnings 会失败。本次仅修正 ARCHITECTURE.md:112 + :560 的过期能力宣称。
- **任务 6（2026-08-12 执行记录，非阻塞）**：两个快照未入 git、零引用，且 CI 已强制 `RUSTFLAGS: -D warnings`（.github/workflows/ci.yml:37/64），快照功能被 CI 铁律取代 → 选择删除而非重建。
- **任务 7+8（2026-08-12 执行记录）**：26 个文件 138 处 rpc 调用全部迁移 typedRpc（另加 main.ts/workspace.ts 的 6 处 listen → typedListen、SettingsPanel 1 处 invoke('rpc') 直调修正）；参数键随契约强制 snake_case；biome `style/noRestrictedImports` 禁 `./bridge`/`../bridge`/`../../bridge` 的 `rpc` 具名导入（rpc-contract.ts / tool.ts 两处受权出口带 biome-ignore 注释）；bridge.ts 的 invoke/listen/rpc 泛型默认值已移除（注：TS 对无推断泛型静默回退 unknown，编译器并不会"逼出"类型——真正的执行链是 biome 禁令 + 契约类型）。附带修正：EventContract['permission-ask'].suggestions.behavior 收紧为字面量联合；4 个测试文件的 mock 键同步 snake_case。已知未处理：lsp-client.ts 的 lsp_request 结果按对象消费（Rust 侧返回 JSON 字符串，潜在 parse 缺失）——属 LSP 功能专项，未在本批改行为。
- **任务 9（2026-08-12 执行记录）**：实测数字与计划预估有出入，按实测修正：rpc.rs 分支 101（计划说 102，计划准）、engine schema 35 默认暴露 34（原文档 34/33）、engine 测试 658（lib 630+bin 27+integration 1）、src-tauri 259（245+14）、bash.rs 1237 行（原 1314）。同时修正 engine/src/mcp.rs:9 过时注释。
- **任务 10（2026-08-12 执行记录）**：生产 unwrap 实际 **182 处**（计划预估 85 处仅为锁+密集区，实测为 2.1 倍），已全量清零：锁 unwrap 60 处 → `unwrap_or_else(|e| e.into_inner())`（std PoisonError，先例 id.rs:124）、静态/动态正则 ~30 处 → expect / unwrap_or_else panic、捕获组 ~30 处 → expect、misc ~30 处 → expect 或降级（react/parser/policy_check 的 checked-unwrap 改 let-else，逻辑等价）、stress.rs 28 处 → expect。测试模块内 unwrap 按验收保留。验证：engine 629+27+1、src-tauri 245+14 全绿，src-tauri `cargo build -D warnings` 零警告。CONVENTIONS.md:116 条款已同步为"生产代码 .unwrap() 清零 + 锁降级模式"。

---

## 第三批执行记录（2026-08-12 ~ 2026-08-13）

- **任务 13（已完成）**：graph-fold.ts 删除手写 `GraphNode/EdgeData/CommunityData`（与 graph-types.ts 同构），改 `import type`。`npx tsc --noEmit` 通过。
- **任务 12（已完成，含计划外修正）**：**新路径并未完全接管**——ChatMessages.tsx:409 工具结果仍走 `dangerouslySetInnerHTML` + `formatToolResult`（marked 默认分支），file-viewer 的 .md 预览也是活代码。收敛方式：
  - `formatToolResult` 返回 `ToolResultRender = {kind:'html';html} | {kind:'markdown';text}`；特殊分支（JSON 美化/diff/bash/glob/dataflow 卡片）保持 HTML 结构，默认分支改为 `{kind:'markdown', text}`（原 marked+DOMPurify 语义由 react-markdown 安全默认取代，raw HTML 不再注入）
  - ChatMessages.tsx 新增 `ToolResultView` 分叉：html → dangerouslySetInnerHTML；markdown → ReactMarkdown（remarkGfm + MarkdownCode）
  - **file-viewer.ts → file-viewer.tsx（git mv，全库仅 main.ts:53 一处动态 import 引用）**；`renderMarkdownPreview` 改用 `createRoot` + 新组件 `react/MarkdownFilePreview.tsx`（hljs 高亮 data-highlighted 保护）；`renderImagePreview` 前置 `unmountMarkdownPreview()`（React 根不能与 innerHTML 混用）
  - 依赖：package.json 删 `marked`/`dompurify`/`overrides`（package-lock 残留仅 monaco-editor 传递依赖，合法）；7 个测试文件的 `vi.mock('marked'/'dompurify')` 全删，tool-semantics/audit-fixes-render 断言改 `.html` 分叉
  - 验证：tsc ✓、vitest 78 passed + 1 skipped ✓、biome 无新增 error（存量 any/a11y warn 归任务 14）
- **任务 11a（已完成）**：utils.rs 2001 行 → `utils/` 目录 + 主体 606 行 + `pub use` 转发（`crate::utils::*` 调用点零改动）。子模块：bg_jobs / build_lock / ipc_guard / path_resolve / graph_io。附带修正：LOG_GUARD 留主体；BUILD_LOCK_TESTS 移 build_lock.rs 并 `#[cfg(test)] pub(crate)`（跨 tests mod 共享串行锁，避免私有项/死代码告警）；`build_lock_released_on_remove_job` 测试移入 bg_jobs.rs tests（BgJob 私有字段跨模块不可访问）。验证：`cargo build -D warnings` ✓、cargo test 245+14 全绿 ✓。
- **任务 11b（已完成，2026-08-13 重做）**：handlers.rs（2417 行）按工具域切成 9 文件 + mod.rs 转发（graph / analysis / preflight / search / overview / rename / audit / resolve / flows）。切分由子 Agent 按已验证行号区间机械执行（逐字搬移 + 首行/末行回读验证），use 块由主 Agent 按 `cargo build` 警告逐文件修剪。跨文件可见性：graph::strip_loc_suffix、resolve::LspCheck / lsp_has_real_reference → `pub(crate)`（audit/flows 引用）；flows 测试模块补 `handler_explore` 显式导入；lsp_manager.rs 测试内未使用的 `Write` 导入顺手清理。验证：`cargo build -D warnings` ✓、cargo test 629+27+1 全绿 ✓（commit 8b7e9cc）。附 Windows/PowerShell 切片经验（不再重做，仅存档）：Set-Content/`>` 会写坏 UTF-8（用 .NET WriteAllText + UTF8Encoding）；负索引数组切片回绕（用 ArrayList 并验证首行）；`git show` 经 PS 重定向行数失真（用 checkout 恢复 + 字节数对比）。
- **任务 14（部分完成，2026-08-13）**：子 Agent 完成非 agent 区 any 清零（36 文件：workspace 15 / lsp-client 13 / chat-session 11 / graph-scene-lifecycle 10 / DataflowPanel 15 / main 7 / bridge 3 及 19 个 graph/react/provider 文件），`biome.json` 的 noExplicitAny 已翻 `error`（tests override 保持 off）；主 Agent 修复其遗留的 20 处 tsc 错误（含补删 file-viewer.ts 残留旧文件——上批 git mv 只进了 create，delete 从未入 commit）。验证：tsc 零错误 ✓、vitest 927+1 全绿 ✓（commit 0feb956）。**未完成**：`src/agent/` 52 处 any（11c 范围）；`biome lint src` 剩余 259 errors 为存量基线（a11y 系 ~100 / dangerouslySetInnerHtml 65 / noArrayIndexKey 12 / noConstantCondition 8 等），其中 agent 区 54 处 any 随 11c 清零，其余 a11y 系为新工程不在本批范围。
- **任务 11c（⏸️ 搁置，2026-08-13 用户决定）**：agent.ts（2963 行）拆分未执行。执行受平台缺陷阻碍（详见 docs/agents/platform-bugs-2026-08-13.md）；用户决定先修 14 遗留、11c 搁置待后续。
- **第三批验收现状（2026-08-13）**：13/12/11a/11b 完成 ✅；14 部分完成 ⏳；11c 搁置 ⏸️。总验收（cargo 双绿 + vitest + tsc + biome 全绿）未达成，卡点 = 11c 的 agent 区 any + biome 存量基线（a11y 系）。执行期间发现的平台缺陷另行登记：docs/agents/platform-bugs-2026-08-13.md。
