# CONVENTIONS.md

这是 HoloGram 项目的编码约定。每个 Agent 在写代码前必须读这个文件。
这些规则不是"理想设计"，而是**代码库里已经占多数的模式**——遵守它们，别发明新的。

## 前端 (src-ui/) — TypeScript + React 18 + Zustand

### 状态管理：Zustand store，不要裸 useState

```
✅ store 模式（已有 panel-store, session-store, messages-store, input-store, chat-store 作为参考）：
   1. create<T>(() => ({ ... })) 定义 store
   2. export const stores = new Map<string, StoreApi>() — per-panel registry
   3. export function getXxxStore(id?: string) — 工厂函数
   4. export function getXxx(id?: string) — 非响应式读（.getState()）

❌ 禁止：组件内 useState 存业务状态（跨组件共享的数据）
❌ 禁止：全局 let 变量存状态
```

### 跨组件通信：EventBus，不要自己造 pub/sub

```
✅ import { bus } from '../ui/events'
✅ 新事件：在 BusEvents 接口里加一条（写在 events.ts 里）
✅ bus.emit('event:name', data) / bus.on('event:name', handler)

❌ 禁止：window.dispatchEvent / CustomEvent / 自己 new EventEmitter
```

### 文件命名

```
✅ 模块文件：kebab-case.ts     （如 chat-store.ts, message-model.ts）
✅ React 组件：PascalCase.tsx  （如 ChatMessages.tsx, TimelinePanel.tsx）
✅ 类型定义：kebab-case.ts     （如 agent-types.ts），组件相关类型放同目录
```

### 组件写法

```
✅ 函数组件 + hooks（useState, useEffect, useCallback, useMemo）
✅ 性能敏感组件用 React.memo 包裹
✅ 组件内部子组件定义在同一文件内（不要为 20 行的子组件新建文件）

// 当 React.memo 会阻止必要的重渲染时（对象引用不变但内部被 mutate），
// 不要用 memo，在代码旁加 ponytail: 注释解释原因。
// 参考：ChatMessages.tsx 里的 SubAgentBlock
```

### 聊天消息写入：单一路径（铁律）

```
聊天数据模型是原地 mutation（流式 part.text += chunk，逐 token 拷贝太贵），
而 React 靠引用比较观察变化。弥合这个矛盾是 store 的职责，不是调用方的自觉：

✅ 改完已有消息或它的某个 part 之后，必须经 store 提交：
     store.getState().touchMessage(msgId)            // 按消息 id
     store.getState().touchMessageContaining(part)   // 按 part 对象身份（跨 rebuild 存活）
   它们会换掉消息对象引用 + bump version，memo 比较器因此永远正确。

❌ 禁止：mutation 之后只调 bump() 或手动 setState({ messages: [...] })
   — 数组展开不换消息引用，memo 化的气泡会静默跳过更新
   （这就是"卡片卡死/最后一帧丢失"反复出现的根源）

新增任何消息变更入口（新事件、新生命周期钩子）：mutate, then touch。
参考：src-ui/src/ui/messages-store.ts 的 SINGLE WRITE PATH RULE 注释，
测试：src-ui/tests/chat-write-path.test.ts
```

### 导入顺序

```
1. React / 第三方库
2. 项目内模块（相对路径）

✅ import { create } from 'zustand'
✅ import type { ChatMessage } from './message-model'
   ↑ 类型导入必须用 import type，不要混在值导入里
```

### 注释和文档

```
✅ 文件头：// Copyright (c) 2026 Wenbing Jing. MIT License.
          // SPDX-License-Identifier: MIT
✅ 分区标题：// ── Section Name ──
✅ 简化标记：// ponytail: 为什么这里故意简化了
```

### 禁止事项

```
❌ 不要直接操作 DOM（document.createElement, appendChild, innerHTML）
   — 用 React 渲染。唯一例外：ChatMessages.tsx 的 linkifyNodeNames（已有 ponytail 注释）
❌ 不要引入新的状态管理库（已有 Zustand）
❌ 不要引入新的 CSS 方案（用现有 CSS 变量和类名模式）
❌ 不要改 tsconfig.json 的 strict: true
```

## 后端 (engine/) — Rust

### 模块组织

```
✅ engine/src/{domain}/mod.rs  — 每个子模块一个目录
✅ 文件命名：snake_case.rs
✅ 公开 API 从 mod.rs 重新导出
```

### 错误处理

```
✅ Result<T, anyhow::Error> 用于可能失败的操作
✅ Option<T> 用于可能缺失的值
✅ .unwrap() 只用于测试和初始化代码，业务逻辑用 ? 或 .expect("why")
```

### 注释

```
✅ //! 模块级文档（文件头）
✅ /// 公开 API 文档
✅ //  行内注释
```

## 通用规则

### 不要造轮子

```
写任何工具函数之前：
1. 先查项目内有没有现成的（grep 或 hologram_search_symbols）
2. 再查标准库
3. 再查已安装的依赖（package.json / Cargo.toml）
4. 都不行才自己写
```

### 改动最小化

```
✅ 修 bug：找到根因，在共享路径上修一次，不要在每个调用者里修
✅ 加功能：最小 diff，不要顺便重构无关代码
✅ 改一个文件就够了就不要动两个
```

### 不要加抽象

```
❌ 只有一个实现的 interface/trait — YAGNI
❌ 只有一个产品的 factory
❌ 永远不会变的值不要放 config
❌ 为了"以后可能需要"的代码
```
