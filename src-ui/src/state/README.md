# src/state — zustand 状态层

> 2026-08-19 总线归零（P1 创建本目录）+ ui/ 拆分（P2 迁入 11 领域 store）后的状态层新家，17 文件。

## 分簇

| 簇 | 文件 |
|---|---|
| 注册表原语 | `scoped-store.ts`（`createScopedStore`——面板级 store 都经它建注册表） |
| 领域 store（面板级，scoped） | `messages-store.ts` `session-store.ts` `panel-store.ts` `input-store.ts`（聚合入口 `ui/chat-store.ts`） |
| app 级单例 | `dock-store.ts`（面板开合/简报）`overlay-store.ts`（portal 宿主）`timeline-store.ts` `dataflow-store.ts` `agent-config-store.ts` |
| 信号 store（总线退役产物，P1） | `turn-done-store.ts` `goal-store.ts` `chat-context-store.ts` `scene-signal-store.ts` `ask-store.ts` `workspace-switch-store.ts` |
| 注入槽 | `dock-config.ts`（面板外部依赖注入槽：DataflowQueryParser / dockStarGraph，main.ts 启动写入） |

## 契约

- 新 zustand store（含信号 store）**一律落本目录**，不要落 `ui/`。
- 面板级走 `createScopedStore` 注册表；app 级单例直接 `create`。
- 信号 store 消费端若跨工作区 fire-and-forget，照 INVARIANTS #12 epoch 守卫。
- 跨组件通信规则见 CONVENTIONS §1.3（总线已退役，禁自建事件机制）。
