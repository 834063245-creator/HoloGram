# CONVENTIONS.md — HoloGram 编码约定

> 最后校准：2026-08-16（逐条对照源码与实测门禁）。
> 所有写代码的 Agent（内置 Agent / Claude Code / Codex / Cursor）在动文件前必须先读本文件；
> `CLAUDE.md` 与 `AGENTS.md` 强制执行这一条。本文件只写仓库里**已经占多数**的模式，不是理想设计。

## 规则优先级

1. `docs/adr/project-constitution.md` — 四条架构约定（类型边界 / 单一权威源 / 异步纪律 / 错误不静默）。新代码违反即打回。
2. `INVARIANTS.md` — 已经炸过的雷。修改 `src-ui/src/ui/**`、`src-ui/src/agent/**`、Rust 接缝前逐条核对。
3. 本文件。
4. 历史 plan / handoff / `docs/archive/**` — 只是记录，不是现状；与代码冲突以代码为准。

## 0. 开工顺序（每次任务）

1. **先问图，再动手**：定位符号/影响面走图工具。内置 Agent 用 `graph(symbols|impact|preflight|...)`；外部 MCP 客户端用 `explore_deps` / `search_symbols` / `trace_impact` / `preflight_check`。grep 是图查不到时的兜底。
2. **读雷区**：涉及 `src-ui/src/ui/**` 或 `src-ui/src/agent/**` 时，先读 `INVARIANTS.md` 相关条目，并 grep 目标文件里的 `⚠️ INVARIANT` 注释。
3. **先抄再写**：在仓库里找做同类事的文件，复制它的模式；不要发明新的通信、状态、工具定义或错误处理方式。
4. **最小 diff**：修 bug 在共享根因上修一次；加功能不顺手重构；一个文件能解决就不动两个。
5. **过门禁**：按下方第 3 节跑验证，不通过不交付、不 commit。

## 1. 前端 `src-ui/`（TypeScript strict + React 19 + Zustand 5 + Vite + Biome 2 + zod 4）

### 1.1 分层

- `src-ui/src/app/` — 新观测台壳：单 React 根、chrome、面板注册表、聊天视图。新 UI 功能优先落这里。
- `src-ui/src/ui/` — 旧层 + 领域逻辑：星图 scene、事件总线、领域 stores、React 岛组件。没有迁移计划时，修改它要沿用该目录现有模式。
- **冻结文件**：`ui/chat-session.ts`、`ui/chat-stream.ts`、`ui/part-mutator.ts`、`agent/execution-state.ts` — 聊天/流式执行的核心状态机，不是局部需求不要改。
- `src-ui/src/agent/` — Agent 运行时、工具、多 Agent、目标/计划/记忆。

### 1.2 状态管理：Zustand，不要模块级变量

```
✅ 面板级（多面板/多会话）store：
   1. create<S>(() => ({ ... })) 定义 store
   2. createScopedStore('__hologram_xxx_stores__', createImpl) 建注册表（src-ui/src/ui/scoped-store.ts）
   3. export const getXxxStore = scoped.getStore — 按 storeId 取实例
   4. 非响应式读走 getXxxStore(id).getState()
   参考：messages-store.ts / session-store.ts / panel-store.ts / input-store.ts，聚合入口 chat-store.ts

✅ app 级单例（一个应用只有一份）：
   app/shell-store.ts（chrome 状态）、ui/dock-store.ts（面板开合/简报）、ui/overlay-store.ts（portal 宿主）

✅ 组件内部瞬态 UI 状态（菜单开合、输入焦点等）用 useState；跨组件共享的业务状态进 store

❌ 禁止：模块顶层 let/const 存业务状态（跨面板串流已炸 6+ 次，见 INVARIANTS #1）
❌ 禁止：引入 Zustand 之外的状态库
```

### 1.3 跨组件通信：新状态走 store，EventBus 是冻结存量

```
✅ app/** 新代码：UI 状态走 zustand store，不要 import ui/events.ts
✅ Agent ↔ Agent：agent/message-bus.ts（有界 inbox + ack + 背压），不是 ui/events.ts
✅ 存量旧组件继续用 ui/events.ts 的既有事件；events.ts 的 BusEvents 不再新增事件

❌ 禁止：window.dispatchEvent / CustomEvent / 自己 new EventEmitter
```

### 1.4 聊天消息写入：mutate, then touch（铁律）

```
聊天数据模型原地 mutation（流式 part.text += chunk，逐 token 拷贝太贵），
React 靠引用比较观察变化。store 是唯一提交口：

✅ 原地改完已有消息或 part 后：
     getMessagesStore(`${panelId}:${sessionId}`).getState().touchMessage(msgId)
     getMessagesStore(...).getState().touchMessageContaining(part)
✅ 新增任何消息变更入口（新事件、新生命周期钩子）：mutate → touch

❌ 禁止：mutation 后只调 bump() 或手动 setState({ messages: [...] })
   — 数组展开不换消息引用，memo 化的气泡会静默跳过更新

参考：ui/messages-store.ts 的 SINGLE WRITE PATH RULE；守护：tests/chat-write-path.test.ts
```

### 1.5 RPC：typedRpc / typedListen，契约单一

```
✅ 前端调后端：src-ui/src/rpc-contract.ts 的 typedRpc / typedListen（RpcContract / EventContract 编译期约束）
✅ 参数键一律 snake_case；返回一律 string：JSON 类用 parseJson()，文本直接读
✅ 后端新增方法：src-tauri/src/rpc.rs 加 match 分支 → 前端需要则同步 RpcContract；
   契约文档 docs/agents/frontend-rpc-contract.md 由 scripts/gen-rpc-contract-md.cjs 生成，勿手改
✅ bridge.ts 的 invoke<T> / listen<T> / rpc<T> 泛型必填

❌ 禁止：在 rpc-contract.ts 和 agent/tool.ts（agentInvoke 动态分发）之外 import { rpc } 裸调
   — biome style/noRestrictedImports 会直接拦截
```

### 1.6 模型工具：defineTool + zod v4，schema 是唯一事实源

```
✅ 新增/修改模型可见工具必须走 src-ui/src/agent/tools/define-tool.ts：
   一个 zod schema 同时产出 JSON Schema（z.toJSONSchema draft-7 + io:'input'）、
   运行时参数校验、z.infer 类型化 execute 参数
✅ 工具内部统一 .passthrough()：_forceGate 在 schema 里声明（LLM 要看得见）；
   _callId / _agent_id 不声明（executor 内部注入）
✅ execute 必须全量透传 args，禁止重建参数对象（fork 子 Agent 的 _agent_id 会丢）

❌ 禁止：手写 parameters() 对象字面量、execute 里 as 强转/静默兜底（x || 默认值）
❌ 禁止：把 defineTool 换成 .strict()（meta key 会被 strip，门禁静默变死路）
❌ 禁止：引入 zod-to-json-schema（只支持 zod v3，与项目 zod v4 不兼容）

领域工具（fs/shell/git/search/web/agent/task/memory/browser/desktop/graph/ops/lsp）：
✅ 新动作同步 tools/domains.ts 的 DOMAIN_SPECS（动作→旧工具名）+ collectHiddenToolNames()
✅ 旧工具名只允许 hide + retireRedirect，模型路径不得重新暴露旧名
```

### 1.7 文件命名与 import

```
✅ 模块/类型文件：kebab-case.ts   （chat-store.ts、message-model.ts、rpc-contract.ts）
✅ React 组件：PascalCase.tsx      （ChatMessages.tsx、DockPanel.tsx、SettingsPanel.tsx）
✅ 测试：tests/<feature>.test.ts（或 .test.tsx）
✅ 新文件头两行：
   // Copyright (c) 2026 Wenbing Jing. MIT License.
   // SPDX-License-Identifier: MIT
✅ import 先第三方后项目内；类型导入用 import type，不与值导入混写
✅ Biome 是唯一格式权威：2 空格、宽 120、单引号、分号、trailing comma；
   编辑后跑 npx biome check --write <改动文件>
```

### 1.8 组件、DOM 与样式

```
✅ 函数组件 + hooks（React 19）；性能敏感组件用 React.memo
✅ 20 行以内子组件定义在同一文件；不要为小零件建新文件
✅ memo 会阻止必要重渲染（对象引用不变但内部被 mutate）时不用 memo，并加 // ponytail: 注释

DOM 所有权按层划分，不要跨层抢 DOM：
✅ app/ 与 ui/react/ 的 UI 经 React 渲染；portal 目标由 overlay-store 管理
✅ 星图 scene/overlay（ui/graph*.ts）、Monaco 宿主（ui/file-viewer.tsx）、
   file-translator wrapper 是现有 imperative-DOM 所有者；修改它们沿用其内部模式
❌ 新的 React UI 组件不要 document.createElement / appendChild / innerHTML 自建游离 DOM
   确有必要时：把 DOM 操作封在对应所有者模块内，加 // ponytail: 说明原因

样式：
✅ app/ 新样式只用 tokens.css 的 --obs-* 变量（--font-scale 是唯一例外）
✅ 面板样式落在 src-ui/src/app/panels/dock-panels/ 对应文件
❌ 不引入新 CSS 方案/框架；不新增 !important / 降级特异性豁免，除非面板样式同源迁移
❌ 不要改 tsconfig.json 的 strict: true
```

## 2. 后端 Rust（`engine/` + `src-tauri/`）

### 2.1 模块组织

```
✅ 多文件领域：engine/src/{domain}/mod.rs + snake_case 子模块，领域公开 API 优先从 mod.rs 重导出
   现状：graph / adapter / analysis / community / pipeline / routing / storage /
         engine / tools / scip_bridge / vector
✅ 单文件横切模块：engine/src/mcp.rs、lsp_manager.rs、logging.rs、path_utils.rs、stress.rs
✅ src-tauri 侧：RPC 单一入口 src-tauri/src/rpc.rs；命令实现在 src-tauri/src/commands/；
   锁/护栏等共享代码在 src-tauri/src/utils/ 子模块
✅ 文件命名 snake_case.rs
```

### 2.2 错误处理

```
✅ 公开边界 Result<T, String>（引擎当前事实标准；项目没有引入 anyhow）
✅ 可缺失值 Option<T>；可恢复失败用 ? 传播
✅ 生产代码零裸 .unwrap()（测试模块除外；2026-08-12 达成，新代码不得回潮）
✅ 锁中毒降级：
   engine 域   lock().unwrap_or_else(|e| e.into_inner())（先例 engine/src/graph/id.rs）
   src-tauri 域 lock_or_recover / read_or_recover / write_or_recover
              （定义在 src-tauri/src/utils/ipc_guard.rs）
✅ 静态不变量用 .expect("为什么这里不可能失败")，如静态正则/捕获组/初始化
✅ 失败必须可见：解析/读写失败不得用 None/默认值冒充成功；
   真正的 best-effort 副产物（timeline 记录、窗口标题等）可以丢弃，
   但写入/持久化类错误必须传播或 warn，不得静默吞
```

### 2.3 异步与 IPC

```
✅ tokio worker 只跑异步；文件 IO/加解密/子进程等待/引擎调用进 spawn_blocking
✅ 锁内不 await、不阻塞 IO；持锁只做内存操作
✅ 新增 IPC 响应必须有尺寸护栏：guard_ipc_size / truncate_output（32K，shell 全量走 spill）
✅ 用户级数据文件写入校验长度/类型，读取容忍毒化数据（见 INVARIANTS #11）
✅ 跨层数据禁止 Result<String, String> 传 JSON 再让对面 parse；序列化只在边界单点
   （历史遗留按 docs/landmine-map.md 拆除，新代码不得新增）
```

## 3. 验证门禁与基线（2026-08-16 实测）

| 改了什么 | 必须过 | 实测基线 |
|---|---|---|
| 前端 | `cd src-ui && npm run build` | tsc --noEmit + vite build 全绿 |
| 前端逻辑 | `cd src-ui && npx vitest run` | 1014 passed / 4 skipped（92 文件） |
| 前端格式 | `npx biome check --write <改动文件>` | 全仓 501 errors/338 warnings 是存量基线，只保证不新增 |
| 引擎 | `cd engine && cargo test` | 698 tests（lib 670 + bin 27 + doc 1） |
| 壳 | `cd src-tauri && cargo test` | 309 tests（bin 295 + 集成 14） |
| 桌面打包 | `cd src-tauri && cargo tauri build` | 会先跑前端构建；禁止用 `cargo build --release` 代替 |

- CI（`.github/workflows/ci.yml`）只做编译 + 测试。**不要修改 CI。**
- `npx biome ci src/app` 当前不是零（存量 14 errors），不要顺手清历史问题；改动文件自己零新增。
- 修 INVARIANTS/landmine-map 里的雷，必须配回归测试，一颗雷一个 commit。

## 4. 文档维护

- 工具/RPC/领域动作清单变化时：更新 `tools/domains.ts` → 本文件 → `AGENTS.md` → `docs/README.md` 索引 → 生成类文档（如 frontend-rpc-contract.md）。
- 已竣工的 plan/handoff 应移入 `docs/archive/` 或加「历史」横幅，不要继续以现状口吻保留过期数字。
- 规则与代码现状冲突时：停下来确认，以代码为准，并更新规则文档；不确定就问用户。
