# src/app — 观测台壳（重构进行中）

> 前端重构方案见会话计划（HoloGram 前端重构方案 —「观测台」）。
> 本目录是「单 React 根 + zustand 状态层 + 统一 dock/命令面板」新架构的落点。

## 分期落点

| 阶段 | 内容 |
|---|---|
| P0 | `fonts.ts`（自托管字体）、`tokens.css`（观测台 token） |
| P1 | `App.tsx` 组件树、`shell-store.ts`、`bridge-adapters.ts`、`actions.ts`、`useGlobalKeys.ts` |
| P2 | `chat/ChatDock.tsx`（全高右侧 dock） |
| P3 | `panels/panel-def.ts` + 六面板收编 |
| P5 | 视觉识别收尾 |

## 约定

- 本目录新代码**不 import** `ui/events.ts`（bus 冻结，仅作引擎/图事件传输）；UI 状态一律走 zustand store。
- 样式只使用 `tokens.css` 的 `--obs-*` 变量；不再追加到 `base.css`/`chat.css`/`panels.css`。
- 不碰 `ui/graph-layout.ts` 的任何布局参数。
