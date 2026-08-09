# HoloGram 聊天面板渲染审计

## 一、SubAgentBlock useMemo 缺 part.version（bug）

**文件**: `src-ui/src/ui/react/ChatMessages.tsx:569`

```typescript
}, [expandedTools, toggleTool, part.parts.length, streaming, part.parts]);
//                  ↑ 缺了 part.version
```

**根因**: `subagent-sink.ts` 在每次 mutation 后 `part.version++`，但 `useMemo` 没订阅 `version`。子 agent 的工具从 `running` → `done` 时，渲染缓存不失效，UI 卡在"执行中"。

子 agent 自身完成时能正常渲染（`part.status` 变了导致 `streaming` 变化），但中间状态更新全丢。

**修复**: 加 `part.version` 到 deps 数组。

```typescript
}, [expandedTools, toggleTool, part.parts.length, streaming, part.parts, part.version]);
```

---

## 二、inline mutation 模式 + React.memo 互斥

**文件**: `ChatMessages.tsx:307` (ToolCard), `ChatMessages.tsx:450` (SubAgentBlock)

两个组件的注释都明确写了不能加 `React.memo`：

> "NOT wrapped in React.memo — part-mutator mutates ToolCallPart in-place, object reference never changes. React.memo would block re-renders."

整个渲染管道依赖**对象引用不变 + 父组件强制重渲染**来推送状态变更。当前可行是因为父组件没被 memo，但如果未来有人加 `React.memo` 优化性能，工具卡片动画会静默死亡。没有 lint 规则保护这个合约。

**对策**: 在 `ChatMessages.tsx` 顶部加注释约定这两个组件永远不能加 `React.memo`，或在 `part-mutator.ts` 改为返回新对象（immutable 模式）而非 in-place mutation。

---

## 三、工具分组逻辑重复

`AssistantBubble`（行 682-707）和 `SubAgentBlock`（行 493-568）有近乎相同的逻辑：扫描 `parts`，合并连续的 `tool` parts，用 `ToolSummary` + `ToolCard` 渲染。

**建议**: 提取为 `ToolGroupRenderer` 组件，删 ~60 行重复代码。

---

## 四、splitStreamingBlocks O(n²)

**文件**: `ChatMessages.tsx:147-178`

流式渲染时每次收到新文本，`splitStreamingBlocks` 从后往前扫描整个 `text` 找 `\n\n`。对于长响应（几千字）有 `useMemo` 保护只在 text 变化时重算，不算 bug，但加个行数上限（如只扫描末尾 5000 字符）会更安全。

---

## 五、linkifyNodeNames DOM mutation 旁路 React

**文件**: `ChatMessages.tsx:74-106`

markdown 渲染完成后，用 `useEffect` + `TreeWalker` 直接替换 DOM 节点（backtick 模式 → 可点击 span）。React 不知道这些 DOM 变更，reconciliation 时会无视。如果消息列表重新 mount，链接就丢了。功能正常，但放在 React 体系里是旁路操作。

**建议**: 改为在 markdown 渲染前预处理文本（字符串替换），或改为 `react-markdown` 的 custom component。
