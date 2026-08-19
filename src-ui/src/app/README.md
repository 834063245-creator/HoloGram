# src/app — 观测台壳（P0–P7 已竣工，旧 `ui/` 层逐步退休中）

> **当前约定以本 README 与根目录 `CONVENTIONS.md` / `INVARIANTS.md` 为准；**
> `docs/archive/frontend-refactor-handoff.md` 是阶段施工史（数字已过期，按下方实测门禁走）。

## 分期落点与状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | `fonts.ts`（自托管字体）、`tokens.css`（观测台 token） | ✅ `baaf5b4` |
| P1 | `App.tsx` 组件树、`shell-store.ts`、`bridge-adapters.ts`、`actions.ts`、`useGlobalKeys.ts`、`shell.css` | ✅ `726f2f6` |
| P2′-2a | `chat/chat-core.ts`（无头核心）、`chat/ChatBeacon.tsx` 等信标视图、`panel-store` 扩展 | ✅ `1e6a08f` |
| P2′-2b | 六个 React 控制器内联为组件，删 Controller 包装 | ✅ `c0a169a` |
| P3 | `panels/`（panel-def + DockPanel + FileTranslatorPortal）、`ui/dock-store`/`dock-config`/`overlay-store`、六面板收编 | ✅ `350845d` |
| P4 | `ui/graph.ts` 拆解（facade 保 API，golden 测试先行） | ✅ `6e3a6e1` |
| P5 | 视觉识别收尾（删旧 CSS 三大件、Orbitron 退役、星图氛围） | ✅ `2455111` |
| P6 | 视觉深化（蓝色中和、聊天/面板表面原型化、氛围层） | ✅ `5570feb` |
| P7 | 全面视觉重构（P7g 动效修复 + P7a–f 消息流/面板/浮层/FileViewer/chrome/清扫） | ✅ 见 `docs/archive/visual-deepening-plan.md` |

## 约定

- 本目录新代码**不 import** `ui/events.ts`（bus 冻结于 11 事件：`agent:diag` / `agent:tool-done` / `prompt:ask` / `goal:state` / `chat:turn-done` / `check:result` / `graph:*` / `highlight:file` / `navigate:file` / `workspace:switched`——生产消费两端都在旧层编排侧或豁免层；新 chrome 需要的总线信号经 `bridge-adapters.ts` 集中转写进 store；chat-core 是编排层，豁免）；UI 状态一律走 zustand store。
- ✅ `ui/react/` 岛层已退休（2026-08-19，计划见 `docs/plans/ui-react-island-retirement-plan.md`）：原 32 文件全部迁入本目录（聊天件 `chat/`、面板+settings `panels/`、chrome TimelineHUD/BackgroundActivity/ContextMenu 根级）；终态守护 `tests/ui-react-retirement.test.ts`。
- 样式只使用 `tokens.css` 的 `--obs-*` 变量；`base.css`/`chat.css`/`panels.css` 已删除（P5），样式现分布：`foundation.css` / `shell.css` / `graph-chrome.css` / `chat/chat.css` / `panels/dock-panels/*.css`（按面板拆分，main.ts 按原级联顺序导入）。
- 不碰 `ui/graph-layout.ts` 的任何布局参数。
- 门禁：`npm run build` + `npx vitest run`（2026-08-16 实测 1014 passed / 4 skipped）。
- 格式：改动文件跑 `npx biome check --write <改动文件>`；全仓 501 errors / 338 warnings、`src/app` 14 errors 是当前存量基线，只保证改动文件零新增，不要顺手清历史问题。
