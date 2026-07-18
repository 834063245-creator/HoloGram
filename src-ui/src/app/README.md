# src/app — 观测台壳（重构进行中）

> **唯一事实来源：`docs/frontend-refactor-handoff.md`**（阶段进度、铁律、下一步清单、契约速查）。

## 分期落点与状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | `fonts.ts`（自托管字体）、`tokens.css`（观测台 token） | ✅ `baaf5b4` |
| P1 | `App.tsx` 组件树、`shell-store.ts`、`bridge-adapters.ts`、`actions.ts`、`useGlobalKeys.ts`、`shell.css` | ✅ `726f2f6` |
| P2′-2a | `chat/chat-core.ts`（无头核心）、`chat/ChatBeacon.tsx` 等信标视图、`panel-store` 扩展 | ✅ `1e6a08f` |
| P2′-2b | 六个 React 控制器内联为组件，删 Controller 包装 | ⬜ 下一棒 |
| P3 | `panels/panel-def.ts` + 六面板收编 | ⬜ |
| P4 | `ui/graph.ts` 拆解（facade 保 API，golden 测试先行） | ⬜ |
| P5 | 视觉识别收尾（删旧 CSS 三大件、Orbitron 退役、星图氛围） | ⬜ |

## 约定

- 本目录新代码**不 import** `ui/events.ts`（bus 冻结，仅作引擎/图事件传输；chat-core 是编排层，豁免）；UI 状态一律走 zustand store。
- 样式只使用 `tokens.css` 的 `--obs-*` 变量；不再追加到 `base.css`/`chat.css`/`panels.css`。
- 不碰 `ui/graph-layout.ts` 的任何布局参数。
- 门禁：`npm run build` + `npx vitest run`（324）+ `npx biome ci src/app`（零问题）。
