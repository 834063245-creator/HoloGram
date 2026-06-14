# 你的任务：逐文件审计 src-ui/src/

按下面的清单顺序，一次处理一个文件。每处理完一个，把它的 `- [ ]` 改成 `- [x]`。

## 每个文件做两件事

（TypeScript 编译器已经替你挡掉了类型错误和拼写错误——不用查那些。只查逻辑漏写。）

**1. 编译和 lint**

```bash
cd src-ui && npx tsc --noEmit && npx eslint <文件路径>
```

有红线就修。TypeScript 不会让你带着类型错误跑。

**2. 读代码找逻辑漏写**

前端和 Python 不一样，烂的地方也不同。重点查这五种：

- **状态没同步** — 一个地方改了 state，另一个依赖它的 state 没跟着更新
- **异步没处理失败** — `fetch` / `async` 调用没有 `catch`，或者 `catch` 了但什么都不干
- **条件分支缺胳膊** — `if` 有了 `else` 没有，或者 switch 缺了 default
- **事件监听没解绑** — `addEventListener` 没有对应的 `removeEventListener`，组件销毁后内存泄漏
- **空值炸渲染** — 数据是 `null` / `undefined` / 空数组时，`.map()` 或属性访问直接崩

找到之后修掉。如果有对应的测试文件就用 `npx vitest run` 跑一遍确认。

**每改完一个文件，必须跑：**

```bash
cd src-ui && npx tsc --noEmit
```

编译过了才能勾掉，继续下一个。

---

## 清单

### agent/ — Agent 核心逻辑

- [ ] `src-ui/src/agent/agent.ts`
- [ ] `src-ui/src/agent/hooks.ts`
- [ ] `src-ui/src/agent/memory.ts`
- [ ] `src-ui/src/agent/permission.ts`
- [ ] `src-ui/src/agent/tool.ts`

### provider/ — LLM 对接

- [ ] `src-ui/src/provider/anthropic.ts`
- [ ] `src-ui/src/provider/openai.ts`
- [ ] `src-ui/src/provider/types.ts`

### ui/ — 界面组件（大头，21 个）

- [ ] `src-ui/src/ui/agent-lens.ts`
- [ ] `src-ui/src/ui/agent-visualizer.ts`
- [ ] `src-ui/src/ui/chat.ts`
- [ ] `src-ui/src/ui/check.ts`
- [ ] `src-ui/src/ui/conflict.ts`
- [ ] `src-ui/src/ui/constraints.ts`
- [ ] `src-ui/src/ui/context-menu.ts`
- [ ] `src-ui/src/ui/debug.ts`
- [ ] `src-ui/src/ui/events.ts`
- [ ] `src-ui/src/ui/file-tree.ts`
- [ ] `src-ui/src/ui/file-viewer.ts`
- [ ] `src-ui/src/ui/git-panel.ts`
- [ ] `src-ui/src/ui/gpu-layout.ts`
- [ ] `src-ui/src/ui/graph-interaction.ts`
- [ ] `src-ui/src/ui/graph.ts`
- [ ] `src-ui/src/ui/hotspots.ts`
- [ ] `src-ui/src/ui/icons.ts`
- [ ] `src-ui/src/ui/layout.worker.ts`
- [ ] `src-ui/src/ui/lsp-client.ts`
- [ ] `src-ui/src/ui/settings-panel.ts`
- [ ] `src-ui/src/ui/terminal.ts`
- [ ] `src-ui/src/ui/timeline.ts`

### 顶层

- [ ] `src-ui/src/bridge.ts`
- [ ] `src-ui/src/i18n.ts`
- [ ] `src-ui/src/main.ts`
- [ ] `src-ui/src/mock-data.ts`
- [ ] `src-ui/src/settings.ts`

---

## 完成后

```bash
cd src-ui && npx tsc --noEmit && npm run build
```

编译 + 构建全过，收工。
