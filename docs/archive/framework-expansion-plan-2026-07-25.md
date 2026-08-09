# 框架路由检测扩展立项计划

> 状态：已竣工（2026-07-26 落地，见文末「落地备注」）。前置条件：修复计划 `audit-fix-plan-2026-07-25.md` 全部批次完成后启动（尤其 C1 结构体变更、D5 测试范式、D7 分发链重排必须已落地）。
> 目标：补齐两个结构性空洞——① 文件系统路由范式零覆盖（Next.js/SvelteKit）；② 生态权重高的新框架（Axum/Hono/Echo/Chi）。

## 集成契约（开工前再核对一遍，以落地后代码为准）

- 检测器二元组：`is_<fw>_candidate(&rel_path) -> bool`（文件门槛）+ `detect_<fw>_routes(file, source) -> Vec<DetectedRoute>`，放在 `engine/src/analysis/framework_routes/frameworks/<fw>.rs`。
- 注册两处：`mod.rs` 候选过滤链（:68-77）与 if-else 分发链（:104 起）；部分框架在分发处有源码内容门槛（`source.contains(...)`）。
- 注入唯一入口：`inject_routes(graph, &routes)`（mod.rs:285）；C1 落地后 `DetectedRoute` 带 framework 字段，新检测器按新结构填写。
- 测试范式：在 `mod.rs` 测试模块加 `#[cfg(test)] use frameworks::<fw>::*;` re-export（:26-49 区块）+ 用例。
- tree-sitter 语法已加载 rust/go/ts 等 18 语言，新检测器优先用 AST（参照 gin/express），行解析只在语法奇葩时降级（参照 phoenix）。

## 阶段 1：同范式检测器（便宜，每个 1 文件 + 注册 + 测试）

按生态权重排序。每个工作量约 100–200 行 + ≥4 个测试用例。

### 1.1 Axum（Rust，最高优先）

- 路由形态：`Router::new().route("/users/:id", get(handler).post(create))`、`.route_with_tsr(...)`、嵌套 `.nest("/api", sub_router)`、`Router::merge`。
- 检测要点：tree-sitter 扫 `call_expression`，方法名 `route`/`nest`；handler 取 `get(...)`/`post(...)` 等方法路由器的第一个参数；`nest` 前缀传播（可限定单级，参照 D1/D2 的前缀处理模式）。
- 内容门槛：`source.contains("axum::") || source.contains("Router::new")`。
- 参照：`gin.rs`（同为方法链 + Group 前缀）。

### 1.2 Hono（TS，高优先）

- 路由形态：`const app = new Hono(); app.get('/path', handler)`、`app.basePath('/api')`、子路由 `app.route('/sub', sub)`。
- 检测要点：与 Express 同构但**必须先修 D7**——Hono 文件现在会被 Express 分支误吞。内容门槛 `from 'hono'` / `new Hono()`，且分发顺序要排在 Express 之前或靠内容门槛互斥。
- handler 取最后一个参数（C3 修复后的 Express 语义，别复制旧 bug）。
- 参照：`express.rs`。

### 1.3 Echo（Go，中优先）

- 路由形态：`e.GET("/users/:id", handler)`、`e.Group("/api", middleware...)` 前缀。
- 内容门槛：`echo.New` / `"github.com/labstack/echo"`。
- 参照：`gin.go` 同款（`gin.rs`），注意 Echo 方法名全大写 `GET/POST`（与 Gin 相同），靠 import 路径区分。

### 1.4 Chi（Go，中低优先）

- 路由形态：`r.Get("/users/{id}", handler)`（注意是 `{id}` 不是 `:id`）、`r.Route("/api", func(r chi.Router){...})` 嵌套。
- 内容门槛：`chi.NewRouter` / `"github.com/go-chi/chi"`。
- URL 归一化：`{id}` → `:id`（与图内其他框架参数风格一致，开工时先确认现有归一化惯例）。

## 阶段 2：文件系统路由范式（新检测器类型，单独立项级工作量）

与阶段 1 本质不同：路由由**文件路径**定义，输入是 `discovered_files` 的路径列表，源码只用于补充元数据（如 API 文件里导出了哪些 HTTP 方法）。

### 2.1 通用设计

- 新模块 `frameworks/fs_routing.rs`（或每个框架一文件，视体量定）。
- 纯路径→路由映射 + 可选源码扫描（仅 `route.ts`/`+server.ts` 类 API 文件，正则扫 `export (async )?function (GET|POST|PUT|DELETE|PATCH)` 即可，不必上 tree-sitter）。
- **分发顺序要求**：文件路由分支必须排在 Express 之前——Next.js 的 `app/**/route.ts` 文件名含 "route"，会被 `express.rs:8-14` 的文件名门槛抢先匹配。D7 重排分发链时预留这个位置。
- 节点/边语义：页面路由 handler = 模块路径（链到文件节点）；API 路由每个导出方法一条边。method 字段页面填 `GET`，API 按导出方法填。

### 2.2 Next.js（App Router + Pages Router，约 400–600 行 + 测试）

- App Router：`app/**/page.{tsx,ts,jsx,js}` → 页面路由；`app/**/route.{ts,js}` → API。
  - `[id]` → `:id`；`[...slug]` → `*`（catch-all）；`[[...slug]]` → 可选 catch-all（标注为 `*` 即可）。
  - 路由组 `(group)/` 段省略；平行路由 `@slot/` 段省略。
  - 拦截路由 `(.)`/`(..)`/`(...)`：**降级处理**——按普通段映射并在文档注明不支持精确语义（属已知限制，不追求一步到位）。
  - 排除：`layout/loading/error/template/default/middleware` 等非路由保留文件名。
- Pages Router（可选，工作量 +30%）：`pages/**` → 路由；`pages/api/**` → API；排除 `_app`/`_document`/`_middleware`。
- 候选门槛：路径含 `app/**/page.*` 或 `app/**/route.*`（Pages Router 则 `pages/**`）。

### 2.3 SvelteKit（约 300–400 行 + 测试）

- `src/routes/**/+page.svelte` → 页面；`src/routes/**/+server.ts` → API（导出方法同上）。
- 参数：`[id]` → `:id`；`[...rest]` → `*`；`[[lang]]` 可选参数 → `:lang`；`(group)` 组省略。
- 排除：`+layout*`/`+error`/`+loading` 等非路由文件。

## 测试标准（与 D5 对齐）

- 每个新检测器 ≥4 用例：正向检出、非目标文件不误报、动态段/前缀（或组）映射、边界（空文件/无路由文件）。
- 阶段 2 另加：route group 省略、catch-all、保留文件名排除、与 Express 分支的分发互斥用例（防 D7 回归）。

## 验收

- 对一个 Next.js fixture 项目与 Axum/Hono fixture 项目跑 `detect_framework_routes`，路由数与预期清单一致，framework 字段正确（C1 语义）。
- `cd engine && cargo test --lib` 全绿；新增 fixture 放 `engine/fixtures/`（遵现有目录惯例）。

## 不做（本期范围外）

- Nuxt / Remix / Astro 文件路由（范式同 2.1，后续照抄扩展）。
- 拦截路由精确语义、`parallel routes` 的 slot 关系建模。
- 前端组件级数据加载函数（`loader`/`load`）与路由的联动分析——那是数据流图的活，另行评估。

---

## 搭车项：子 Agent 可观测性增补（与路由无关，随本计划执行）

> 来历：审计修复计划 A2（agent_kill）的延伸。修复计划动工时未纳入，插单于此，本计划开工时一并交付，避免遗忘。
> 背景：子 Agent 卡死时主 Agent 只能看到「在跑/完成」，无法区分「慢」与「死」，kill 决策是盲杀。

- **位置**：`src-ui/src/agent/tools/subagent.ts`（`agent_list` 工具）、`src-ui/src/agent/coordinator.ts`（`PendingAgent` 已持有运行状态，信息现成）
- **修复**：`agent_list` 返回值对每个运行中子 Agent 增加三字段——当前正在执行的工具调用（无则 null）、该调用已等待时长、最后事件时间戳。
- **验收**：`agent_list` 输出可辨识「推进中」与「疑似卡死」（某工具等待超阈值）两种状态；配合 A2 的 `agent_kill` 形成「看得见 → 杀得准」闭环。
- **回归**：`tests/subagent-sink.test.ts` + 新增状态字段用例。

---

## 落地备注（2026-07-26）

**交付清单**

- 阶段 1：`frameworks/axum.rs`、`hono.rs`、`echo.rs`、`chi.rs`（全部 tree-sitter AST；basePath/Group/Route/inline-nest 单级前缀传播）+ 分发注册（hono 在 express 前、echo/chi 在 gin 前、axum 在 actix 前，门槛均内联在分支条件里）+ 24 个测试 + `fixtures/framework_routes_p1`（14 路由集成验收）。
- 阶段 2：`frameworks/nextjs.rs`、`sveltekit.rs`（纯路径映射 + API 文件导出方法扫描），在 `detect_framework_routes` 顶部新增独立扫描块（先于 Express 分支，D7 排序要求）+ 12 个测试 + `fixtures/framework_routes_nextjs`（8 路由）与 `fixtures/framework_routes_sveltekit`（6 路由）集成验收。
- 搭车项：`src-ui/src/agent/subagent-activity.ts`（事件旁路追踪）+ `agent_status` 工具（注册于 agent-builder.ts），13 个新测试。

**与计划的偏差（以落地代码为准）**

1. `agent_list` 改名 **`agent_status`**——`agent_list` 已被 `tools/communication.ts` 的拓扑工具占用；且 `PendingAgent` 并无现成运行状态（计划假设过时），实现改为在子 Agent 事件流上开旁路（`wrapSubAgentSink`）。
2. Chi **不做** `{id}`→`:id` 归一化——核对现有惯例（FastAPI 保留 `{user_id}`、Gin 保留 `:id`）为「保留框架原生风格」。
3. Next.js 额外支持 `src/app/**`（主流目录布局，同一匹配路径）；Pages Router 未做（计划标注可选项）。
4. 拦截路由降级实现：剥掉 `(.)`/`(..)`/`(...)` 标记后按普通段映射（代码注释注明为已知限制）。
5. 搭车修复（验收前置）：`test_cancel_token_stops_pipeline` 与 `test_reanalyze_cancels_running_analysis` 的线程调度竞态——盲 sleep 改为等待 `cancel_token` 发布，与路由无关但挡住「cargo test --lib 全绿」验收。

**验收结果**

- `cd engine && cargo test --lib`：516 passed / 0 failed，连续两遍。
- `cd src-ui && npx tsc --noEmit`：0 错误；子 Agent 相关 63 测试全过（全套件仅 `audit-fixes-render` 一例预存 UI 计时 flake，单跑即过）。
- 三个 fixture 集成测试断言路由总数、分框架计数（`properties["framework"]`）与分发互斥（hono 不被 express 吞、echo/chi 不被 gin 吞、route.ts 归属 nextjs）。

**复审轮（2026-07-26，两路独立评审 + 修复）**

两路对抗性评审结论均为 SHIP-WITH-FIXES，发现项已全部修复：

- 引擎 10 项：F1 fs 路由文件从逐文件检测循环排除（Next+Hono 混用会双重注入，评审抓到的最大问题）；F2 fs 路由 file 字段统一为绝对路径；F3 hono 链式 basePath 不再污染语句级前缀；F4 SvelteKit `[id=integer]` 匹配器剥离；F5 API 文件支持 `export const GET: Type =` 类型标注；F6 Echo 支持 `var g = e.Group(...)`；F7 actix 分发门槛加内容检查（不再吞 Rocket，预存 bug 顺手修）；N1-N3 陈旧注释/测试去重/API 路由行号定位。
- src-ui 5 项：B1 幻觉工具名不发 ToolResult 导致 agent_status 误报卡死（会诱导错杀，评审抓到的最大问题）；B2 增加「120s 无事件」次级卡死信号（覆盖并发批下的单槽盲区）；B3 时长钳制；B4 补 tee 接线集成测试 + 时间戳发散断言；B5 reanalyze 测试 deadline 未命中时显式断言失败。
- 终验：`cargo test --lib` 521 passed；`npx tsc --noEmit` 0 错误；`npm test` 656/656 全过。
