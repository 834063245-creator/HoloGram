# src/app — 观测台壳（P0–P7 已竣工；ui/ 拆分已收口：store→state/、星图→scene/）

> **当前约定以本 README 与根目录 `CONVENTIONS.md` / `INVARIANTS.md` 为准；**
> `docs/archive/frontend-refactor-handoff.md` 是阶段施工史（数字已过期，按下方实测门禁走）。

## 分期落点与状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | `fonts.ts`（自托管字体）、`tokens.css`（观测台 token） | ✅ `baaf5b4` |
| P1 | `App.tsx` 组件树、`shell-store.ts`、`bridge-adapters.ts`、`actions.ts`、`useGlobalKeys.ts`、`shell.css` | ✅ `726f2f6` |
| P2′-2a | `chat/chat-core.ts`（无头核心）、`chat/ChatBeacon.tsx` 等信标视图、`panel-store` 扩展 | ✅ `1e6a08f` |
| P2′-2b | 六个 React 控制器内联为组件，删 Controller 包装 | ✅ `c0a169a` |
| P3 | `panels/`（panel-def + DockPanel + FileTranslatorPortal）、`dock-store`/`dock-config`/`overlay-store`（2026-08-19 P2 起已迁 `src/state/`）、六面板收编 | ✅ `350845d` |
| P4 | `graph.ts` 拆解（facade 保 API，golden 测试先行；2026-08-19 P2 起本体迁 `src/scene/`，`ui/graph.ts` 留 3 行 re-export shim） | ✅ `6e3a6e1` |
| P5 | 视觉识别收尾（删旧 CSS 三大件、Orbitron 退役、星图氛围） | ✅ `2455111` |
| P6 | 视觉深化（蓝色中和、聊天/面板表面原型化、氛围层） | ✅ `5570feb` |
| P7 | 全面视觉重构（P7g 动效修复 + P7a–f 消息流/面板/浮层/FileViewer/chrome/清扫） | ✅ 见 `docs/archive/visual-deepening-plan.md` |

## 约定

- 事件总线已归零（2026-08-19 `docs/plans/eventbus-zero-and-ui-split-plan.md` P0-P3 竣工）：`ui/events.ts` 与 `bridge-adapters.ts` 均已删除，原 11 事件全迁 zustand 信号 store（`src/state/` 六信号 store + agent-panel-store 扩展）；UI 状态一律走 zustand store，禁 window.dispatchEvent / CustomEvent / 自建 EventEmitter。
- ✅ `ui/react/` 岛层已退休（2026-08-19，计划见 `docs/plans/ui-react-island-retirement-plan.md`）：原 32 文件全部迁入本目录（聊天件 `chat/`、面板+settings `panels/`、chrome TimelineHUD/BackgroundActivity/ContextMenu 根级）；终态守护 `tests/ui-react-retirement.test.ts`。
- 样式只使用 `tokens.css` 的 `--obs-*` 变量；`base.css`/`chat.css`/`panels.css` 已删除（P5），样式现分布：`foundation.css` / `shell.css` / `graph-chrome.css` / `chat/chat.css` / `panels/dock-panels/*.css`（按面板拆分，main.ts 按原级联顺序导入）。
- 不碰 `scene/graph-layout.ts` / `scene/gpu-layout.ts` 的任何布局参数。
- 门禁：`npm run build` + `npx vitest run`（2026-08-16 实测 1014 passed / 4 skipped）。
- 格式：改动文件跑 `npx biome check --write <改动文件>`；全仓 501 errors / 338 warnings、`src/app` 14 errors 是当前存量基线，只保证改动文件零新增，不要顺手清历史问题。
