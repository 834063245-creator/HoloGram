# src/ui — chat 编排域核心 + 旧层命令式基础设施

> 定位一句话（eventbus-zero-and-ui-split-plan §3.3）：本目录是**chat 编排域核心 + 旧层命令式基础设施**，
> 不是杂物间。2026-08-19 总线归零 + ui/ 拆分（P0-P3）后的终态残余，25 文件，只减不增
> （守护 `tests/eventbus-zero-and-ui-split.test.ts`，COMPLETE=true）。

## 目录契约

- **新 zustand store 一律落 `src/state/`**，不要落这里。
- **新星图/Three.js 文件一律落 `src/scene/`**，不要落这里。
- **新 React 组件一律落 `src/app/`**，不要落这里。
- 本目录文件**不改名**（拆分计划 D8：名字 churn 无功能收益）。

## 文件分簇

| 簇 | 文件 | 说明 |
|---|---|---|
| 冻结（禁改） | `chat-session.ts` `chat-stream.ts` `part-mutator.ts` | chat 编排域核心；`agent/execution-state.ts`（在 agent/）同列 |
| chat 编排域 | `chat-store.ts`（聚合入口）`chat-utils.ts` `message-model.ts` `message-height.ts` `tool-semantics.ts` `agent-panel-store.ts` | 面板级 store 四件套在 `src/state/`（scoped/messages/session/panel/input），聚合编排在此 |
| 命令式基础设施 | `app-shell.ts` `runtime-adapter.ts` `lsp-client.ts` `command-registry.ts` `context-menu.ts` `agent-visualizer.ts` `subagent-sink.ts` `pretext-cache.ts` `resize-zones.ts` `debug.ts` `icons.ts` | imperative-DOM/旧层宿主；LspService 是子系统服务化样板 |
| 文件查看器 | `file-viewer.tsx` `markdown-file-preview.tsx` `file-translator.ts` `file-translator.css` | Monaco 宿主 + 翻译 portal（css 是本目录唯一 CSS，被 app/panels/FileTranslatorPanel side-effect import） |
| 位置兼容 shim | `graph.ts` | ≤3 行 re-export `src/scene/graph.ts`——冻结文件 chat-stream 的 type import 走此层，**不要往里加代码** |

## 依赖方向

`state/`（store）← `ui/`（编排消费 store）→ `scene/`（星图本体经 shim 或直接 import）。
`ui/` 引用 `state/`、`scene/`、`i18n`、`app/shell-store` 均为既定方向；反向（state/scene import ui/）仅限
`message-model` `icons` `debug` `app-shell` 这类旧层锚点（见各文件 import）。
