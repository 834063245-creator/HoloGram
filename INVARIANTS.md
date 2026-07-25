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

## 使用方式

每个 Agent prompt 模板里加一行：
```
在修改任何文件之前，先 grep 该文件里的 ⚠️ INVARIANT 注释，不要违反。
如果代码库里没有 INVARIANT 标记的文件，也要遵守 D:\HoloGramHG\INVARIANTS.md。
```
