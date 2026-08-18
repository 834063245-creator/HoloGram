# INVARIANTS.md — 踩碎必炸的规则

这些不是"代码风格建议"，是**已经炸过的地雷**。如果你写的代码违反了其中任何一条，之前修过的 bug 会立刻复活。每条规则都附了之前修复它的 commit，不是假设——是历史。

修改 `src-ui/src/ui/` 和 `src-ui/src/agent/` 下的任何文件之前，先看这份清单。

---

## 1. 状态隔离：全局变量 = 跨面板串流

**文件**: `messages-store.ts`, `session-store.ts`, `panel-store.ts`, `input-store.ts`

```
⚠️ 不要在模块顶层（函数外）加任何 let/const 变量。

正确：getXxxStore(id) → Map 里取对应面板的 store 实例
错误：const globalCache = []  ← 所有面板共享，必串

每个 store 文件都有这个模式：
  const stores = new Map<string, StoreApi>()
  export function getXxxStore(id?: string): StoreApi { ... }

新加的状态必须走这个 Map，不然就是全局共享状态。
```

**炸过**: 1f7fc04, f85b017, f005e09, f1d49af, c927dd2, 8b59f68

---

## 2. 流式写入：写 session 缓存，不写 active messages

**文件**: `chat-stream.ts:95-150`（`_resolveStreamingTarget` 函数）

```
⚠️ streaming 输出必须写到 sessionMessageModels[targetSid]，不是 ctx.getMessages()。

targetSid 通过 sessionStreamingIds 反查（哪个 session 拥有这个 assistant），
不是通过 activeIdx（当前激活的是哪个 tab）。

如果写到 active tab 的 messages：用户在 streaming 时切 tab，streaming 内容丢失，
激活 session 的消息列表被污染。
```

**炸过**: c927dd2, f005e09, f1d49af, 1f7fc04

---

## 3. streamingAssistantId：不要清空它

**文件**: `messages-store.ts`（`streamingAssistantId` 字段），`session-store.ts`（`sessionStreamingIds` 字段）

```
⚠️ session 切换/创建时，不要清空 streamingAssistantId 或 sessionStreamingIds。

streaming 是跨 session 的长期操作。切换 tab 不应该中断它。
如果切换时清空了，streaming 就变成了孤儿——内容无处可去，
或者落入错误的 session。
```

**炸过**: 6d7717d

---

## 4. EventBus：prefix clear 不能删父级 handler

**文件**: `events.ts:117-130`（`EventBus.clear()` 方法）

```
⚠️ bus.clear() 只能删除匹配当前 prefix 的事件。
bus.clear() 在无 prefix 的根 bus 上调用才能清全部。

如果 prefix 子 bus 的 clear() 删除了根 bus 的 handler，
所有其他子 bus 的监听器也会丢失。
```

**炸过**: 3a0dbb4

---

## 5. 子 Agent 渲染：不要直接 new 独立 DOM 元素

**文件**: 任何使用 SubAgentPart 的代码

```
⚠️ 子 Agent 的输出必须通过 SubAgentPart.parts 数组和数据模型，
由 ChatMessagesPanel（React）统一渲染。
不要单独创建 DOM 元素或绕过消息模型直接操作 DOM。

绕过消息模型 → React 不知道有新内容 → UI 不更新 → 手动操作 DOM → 内存泄漏 + 渲染错乱。
```

**炸过**: 0477f62, 1cf9118, c04f718

---

## 6. 手写协议必须配协议级测试（LSP 帧解析）

**文件**: `engine/src/lsp_manager.rs`（`read_one_message` 帧解析）

```
⚠️ LSP 客户端是手写的（stdio JSON-RPC 帧协议），不是现成库。
Rust 生态有 lsp-server crate（tower-lsp 家族）专治这个，但本项目自研了。

自研可以，但代价是每个协议坑都得自己踩一遍：
- 服务器一次 write 会粘连多条消息（帧+帧）
- JSON body 内可能含 \n，用 read_line 读 header 会行边界错位
- 结果：body 读进帧头（"Content-Length: N\r\n\r\n{...}"）→ parse 错误
  → 工具 fallback → 误判"LSP 不响应"，绕了四五轮才找到真根因

守则：
1. 手写协议类代码必须配协议级测试（模拟服务器发粘连帧/异常帧）
2. 帧边界处理必须按字节流扫描定界符，不能用 read_line
3. 解析失败时把原始字节带进错误消息（raw=...），否则没法诊断
4. 教训：当"服务器不响应"反复出现，先怀疑客户端读帧，别信表象
```

**炸过**: 5822003（粘连帧根因修复）, 41256ba, c87f14b, e451428

---

## 7. 工具参数契约：camelCase↔snake_case 转换枢纽不能动

**文件**: `src-ui/src/bridge.ts:84`（`rpc()`），`src-ui/src/agent/tool.ts`（`agentInvoke`）

```
⚠️ rpc() 的 (/([a-z])([A-Z])/g, '$1_$2') + toLowerCase 是全工具层唯一生效的
camelCase→snake_case 转换。工具参数的完整链路是：

  schema key（LLM 可见）→ execute 读取 → rpc() 转换 → Rust 参数名

这条链任何一环改坏（改转换正则、改 schema key、"顺手统一"成 camelCase），
都是静默失败：参数对不上，工具拿不到值，且不报错。
```

**炸过**: isAgent↔is_agent 事故——旧名 `_agent` 因 Tauri 默认 camelCase 重命名永远匹配不上 Rust 的 `is_agent` → `is_agent` 恒 false → agent 文件操作被沙箱静默硬拒且不弹 Ask。谁把 `isAgent` 改回 `_agent`，守护测试立刻挂。

**守护**: `tests/agent-exec.test.ts`（isAgent 注入）、`tests/tool-param-contract.test.ts`（18 条 key 契约 + 全量工具 key 风格/歧义检测）

---

## 8. 工具定义必须走 defineTool（zod Schema-First），禁止手写 schema + as 解包

**文件**: `src-ui/src/agent/tools/define-tool.ts`（工厂），`src-ui/src/agent/tools/`（所有工具）

```
⚠️ 新增/修改工具必须用 defineTool()：一个 zod schema 同时产出
  - parameters() 的 JSON Schema（给 LLM）
  - execute 前的运行时校验（参数错 → 抛"参数校验失败"）
  - z.infer 类型（execute 参数类型化）

禁止：
  - parameters() 返回手写对象字面量
  - execute 里 as 强转 / 手写解包 / 静默兜底（x || 默认值）
```

**为什么**: 字段名契约曾靠人肉三处同步（schema key ↔ execute key ↔ Rust camelCase），出过 isAgent 静默失败事故（见第 7 条）。zod 单一来源后，schema key 就是唯一事实。

**守护**: `tests/define-tool.test.ts`（10 个工厂行为守护：JSON Schema 形状 / 校验报错 / default+coerce / meta key 透传）

---

## 9. meta key 必须 passthrough：_forceGate / _callId / _agent_id 不进 schema

**文件**: `src-ui/src/agent/tools/define-tool.ts`（内部 `.passthrough()`），`src-ui/src/agent/streaming-executor.ts`（注入）

```
⚠️ 三个 meta key 是 streaming-executor 在 execute 前注入的 schema 外参数：
  - _forceGate  架构门禁绕过（HIGH 风险写入时 LLM 传 true 才能执行）
  - _callId     子 Agent 事件关联（agent_spawn 时注入）
  - _agent_id   隔离工作树选择（告诉 Rust 用哪个 worktree）

defineTool 内部统一 .passthrough() 透传。绝不能用 .strict()——
否则门禁静默变成死路（LLM 传 _forceGate:true 被 strip 掉，HIGH 风险写入全被挡）。

_forceGate 必须保留在 schema 声明（z.boolean().optional().describe(原描述)），
LLM 才能看到并传它。_callId/_agent_id 不声明（内部注入，LLM 不该知道）。
```

**守护**: `tests/define-tool.test.ts`（meta key 透传用例）、`tests/streaming-executor-hooks.test.ts`（门禁行为）

---

## 10. JSON Schema 转换用 zod v4 内置 z.toJSONSchema，别用 zod-to-json-schema 库

**文件**: `src-ui/src/agent/tools/define-tool.ts`（`toInputJsonSchema`）

```
⚠️ 用 zod v4 内置 z.toJSONSchema(schema, { target: 'draft-7', io: 'input' })。

不要引入 zod-to-json-schema 第三方库——3.25.x 只支持 zod v3，
与项目的 zod v4 不兼容：转换结果输出全空（只有 $schema，properties 全丢），
且不报错，排查半天才发现是版本不匹配。

io: 'input' 视图必须保留：让 defaulted 字段不进 required，
避免"同时声明 default 又 required"的矛盾（LLM 看到必填但可不填 → 校验混乱）。
```

**炸过**: 本次迁移初踩坑（zod-to-json-schema 输出全空，改为内置 API 后正常）

---

## 11. IPC 响应必须设尺寸护栏；用户级数据文件是排查盲区

**文件**: `src-tauri/src/credential.rs`（凭据读写）、`src-tauri/src/commands/graph.rs` / `hologram.rs`（大响应命令）、`src-ui/src/settings.ts`（restoreSecrets）、`src-tauri/src/utils.rs`（guard_ipc_size）

```
⚠️ 1. 任何经 IPC 的命令响应必须有尺寸护栏（guard_ipc_size 128MB / truncate_output 32K），
   禁止无界响应。256MB 响应进 custom protocol → 返回空（"Unexpected end of JSON input"）
   → tauri 回退 postMessage → 响应丢失 → 前端 await 永久挂起 → 页面假死
   → GPU 进程重启即死 → ~150s browser 致命退出 → 白屏。

⚠️ 2. 写入用户级数据文件（%APPDATA% 等，非项目 .hologram）的输入必须校验长度/类型
   （store 拒绝 >4096 字符 key），防毒化源头；读路径必须容忍毒化数据
   （丢弃超长条目 + 自动隔离备份重建），不能把"文件已毒化"变成"每次启动必崩"。

⚠️ 3. 排查纪律：当崩溃"与代码版本无关 × 与 WebView2 版本无关 × 对照 app 稳定"时，
   先检查用户级数据文件（credentials.enc 等）——它是既不在代码也不在环境的第三类变量。
   2026-08-08 白屏事故：credentials.enc 被双重 JSON 编码循环毒化至 256MB，
   所有代码版本 × 所有 WebView2 版本全崩（同一毒值进入每条 IPC 路径）；
   tauri-min/rpc_stub 稳定只是因为毒值从未进入它们的 IPC。
   排查 4 小时未查 credentials.enc 文件本身——看一眼文件大小就破案。
```

**炸过**: 1085e75（凭据毒化自毁根治——白屏根因修复）, d18033e（guard_ipc_size 128MB 护栏）, 46a744c（hologram_call async+spawn_blocking）, 0b472c8（null 复活根治）

**守护**: credential.rs 2 个新回归测试（读写长度护栏）、d18033e 5 个测试（截断 head/tail/多字节/护栏放行/护栏拒绝）

---

## 12. 工作区级资源必须登记进 fiber；跨工作区 fire-and-forget 必带 epoch 校验

**文件**: `src-ui/src/workspace.ts`（Workspace._fiber — cordis fiber）、`src-ui/src/workspace-scope.ts`（epoch）、`src-ui/src/agent/lifecycle.ts`（DisposerBag — setupAgent 有序组引擎）

```
⚠️ INVARIANT：工作区存活的全局/跨作用域资源，必须以 effect 登记进 Workspace fiber
   （获取点就地 this._fiber.ctx.effect(() => disposer, 'label')；setupAgent 的有序拆除组
   打包为 DisposerBag 作单个 effect — 组内「先拆 runtime 再清缓存」等串行逆序契约不变）。
   deactivate/forceClearState 只调 fiber.dispose() + bumpWorkspaceEpoch()，
   绝不靠人肉枚举清理。（cordis-migration P1：_bag → fiber，fiber unload 是并发的，
   顺序依赖必须进有序组，不许拆成平级 effect。）

⚠️ INVARIANT：跨工作区的 fire-and-forget 写共享态（async resolve 后写 store / 表 / 缓存），
   入口必须 getWorkspaceEpoch() 记下、resolve 后 isCurrentEpoch() 校验，过期即丢弃。
   （epoch 不随 fiber 化消失：fiber 管所有权，epoch 管逃逸所有权的在途回调 —
   冻结文件 chat-session.ts 等仍是消费方，cordis-migration P4 统一收口。）

✅ 正确：获取点就地 effect 登记（顺序敏感组用 teardown bag）；在途写前 isCurrentEpoch(epoch)
❌ 错误：模块级 let 存跨工作区全局态 + 切换靠手写清理清单 + 在途 resolve 不校验代际
```

**炸过**: 本家族已炸 N 次 —— chat store ×6（INVARIANTS #1）、cache-store（`176f4873`）、LSP diagnosticsCache / 会话表（H1/H2）、runCheck 在途写 dock（H4）、forceClearState 漏 disposeAll（H3）、autoRestore/autoSave 旧项目串写（H5）、Aura init 竞态（M3）、agent panel 2s 轮询旧 runtime（M1）。

**守护**: `tests/workspace-lifecycle.test.ts`（T0：forceClearState/disposeAll/fiber）、`tests/workspace-scope.test.ts`（epoch 语义 + fiber 标签 T0）、`tests/workspace-fiber.test.ts`（P1 运行时：effect 释放/quiescence/停注册）、`tests/lsp-diagnostics.test.ts` / `tests/lsp-session.test.ts`（LSP 在途）、`tests/chat-epoch-guard.test.ts`（会话 epoch 外科手术）

**落地**: 本族全部拆雷 Commit 序列 —— `d4a800e6`（H3）、`1926cf73`（H4）、`f0f38731`（H1）、`e29f072e`（workspace-scope 原语）、`e4abde23`（获取点登记制）、`ede255d1`（H2）、`462b2ea1`（H5+中危#5）。

---

## 13. 物理输入注入必须经 DesktopInputLease；UIA COM 只活在专用线程

**文件**: `src-tauri/src/uia/grants.rs`（输入租约）、`src-tauri/src/uia/com.rs`（phys 模块）、`src-tauri/src/uia/worker.rs`（专用线程）

```
⚠️ INVARIANT：一切真实输入注入（SetCursorPos / SendInput 鼠标键盘 / 剪贴板写入 /
   SetForegroundWindow 抢前台）必须先 acquire_input_lease 成功才能执行。
   pattern 类动作（Invoke/SetValue/Select/Expand/Scroll）不需要租约也不抢焦点——
   这是 desktop 工具面不骚扰用户物理桌面的根基。

⚠️ INVARIANT：IUIAutomationElement 等 COM 对象绝不跨线程——只存活在 hologram-uia
   专用线程内（worker.rs 调度）；跨线程传 COM 指针 = apartment 违规 + Send 不满足，
   编译期就该拦住。新增 UIA 能力一律走 worker request 通道。

⚠️ 权限配对纪律：物理输入路径的 allow_coords/allow_physical/allow_wheel 参数由
   rpc 层（desktop_uia_write 分类后）传入——com.rs 不得自作主张走物理兜底，
   否则「pattern 失败静默变坐标点击」= 绕过权限分层的静默提权。

✅ 正确：rpc 分类 → DesktopTool{action:"uia_physical"} Ask → acquire_input_lease → phys::click
❌ 错误：com.rs 里 pattern 拿不到就直接 SendInput；或绕过租约在 tokio 线程直接调 Win32
```

**炸过**: 无（2026-08-19 立规于 computer-use 改造，防患于未然——多 Agent 并发抢光标/
错窗口静默点击是 UIA 自动化的经典事故形态）。

**守护**: `uia/grants.rs::input_lease_serializes_and_reports_holder`（双任务竞争 +
LEASE_BUSY 持有者上报）、`tools/mod.rs::desktop_permission_matrix`（uia_physical 必须
Ask）、`uia/com.rs` NO_PATTERN 错误（未授权物理路径明确报错而非静默兜底）。

---

## 使用方式

每个 Agent prompt 模板里加一行：
```
在修改任何文件之前，先读本仓库根目录 INVARIANTS.md 并 grep 该文件里的 ⚠️ INVARIANT 注释，不要违反。
CLAUDE.md / AGENTS.md 已强制先加载本文件。
```