# HoloGram 前端「观测台」重构 — Handoff

> 交接时间：2026-07-18 · 上一棒：P0 → P2′-2b 已完成并全部入库
> **接手方式**：新窗口先读本文件 + `src-ui/src/app/README.md`，然后按「下一步精确清单」执行。
> 本文件取代会话内的计划文件，是重构的唯一事实来源。设计原型：`prototype/observatory-concept.html`（gitignored，本地参考）。

## 一、已完成（4 个 commit，全部在 main）

| Commit | 阶段 | 内容 |
|---|---|---|
| `baaf5b4` | P0 地基 | React 19.2.7 对齐（此前 react18+types19 撒谎）；字体 fontsource 自托管删 Google CDN；`src/app/` 骨架 + `tokens.css`（--obs-* token） |
| `726f2f6` | P1 壳 | 单 React 根 `<App/>`：CommandBar/StatusBar/DockRail/CommandPalette(Ctrl+K)/ShortcutsOverlay；`shell-store`（zustand）+ `actions` 注册表 + `bridge-adapters`（bus→store）；main.ts 1035→~840 行；index.html 瘦身为 #app-root+#graph+#welcome；graph.ts updateStatus 改写 store |
| `f2acd6e` | 修复 | 窗口拖拽：`.cb-bar` 补 `-webkit-app-region: drag`（按钮/输入 no-drag） |
| `1e6a08f` | P2′-2a 聊天 | 无头 `ChatCore`（chat-core.ts）+ 观测信标视图 `ChatBeacon`；删 ui/chat.ts、chat-dom.ts、chat-anim.ts；`chat-session/chat-stream/part-mutator/execution-state` 逻辑**零改动** |
| `c0a169a` | P2′-2b 内联 | 六个 React Controller 包装类删除，组件直接挂 ChatBeacon 树；core `register*` 改收组件 ref 句柄（Messages 收 `MessagesApi{bump}`）；AtAutocomplete 的 navigate/select/open 从 DOM-scraping 重写为状态驱动（顺带修掉选中后弹层滞留、紧接 Enter 误选二次）；PromptShelf 卸载时取消挂起 Promise；`chat-session/chat-stream` 零改动 |

## 二、当前架构快照

```
src-ui/src/
├── app/                        ← 新架构（单 React 根 + zustand）
│   ├── App.tsx                 壳：CommandBar/DockRail×2/StatusBar/CommandPalette/ShortcutsOverlay/ChatBeacon
│   ├── shell-store.ts          chrome 唯一数据源（statusText/statusLog/graphStats/violations/analyzing/panels/…）
│   ├── actions.ts              动作注册表；main.ts 注入实现，React 只认 id
│   ├── bridge-adapters.ts      bus→store 适配（目前只有 check:result）
│   ├── useGlobalKeys.ts        全局快捷键（Ctrl+K/L/D/, F R ? Esc）
│   ├── tokens.css / shell.css  --obs-* token + chrome 样式
│   ├── fonts.ts                fontsource 自托管
│   └── chat/
│       ├── chat-core.ts        无头 ChatCore：会话/流式/权限/goal 全部编排，公开 API 与旧 ChatPanel 一致
│       ├── core-instance.ts    useCoreStore（main.ts 注入 core，App 就绪后渲染 ChatBeacon）
│       ├── ChatBeacon.tsx      视图根：pill/input/panel/hud 模式机 + 内联聊天组件树（Messages/Hint/Shelf/At/Slash/Footer，ref 句柄注册进 core）
│       ├── Composer.tsx        输入框（input-store.inputText 受控）
│       ├── HistoryPanel.tsx    历史会话（portal 到 body）
│       └── beacon.css          chat.css 之上的增量覆盖（宽 640px、CSS 过渡、a11y 复位）
├── ui/                         ← 旧层（P3/P4 逐步清）
│   ├── chat-session.ts / chat-stream.ts / part-mutator.ts / message-model.ts / chat-store.ts  ★ 逻辑，勿动
│   ├── panel-store.ts          per-panel UI 状态（P2′ 加了 goalRecord/lastAgentDetail）
│   ├── react/                  React 岛（纯组件 + ref 句柄导出；2b 已删全部 Controller 包装类）
│   │   ├── ChatMessages.tsx / ChatFooter.tsx / ChatHint.tsx / PromptShelf.tsx / AtAutocomplete.tsx / SlashPanel.tsx
│   │   └── base.css / chat.css / panels.css   旧样式（聊天类契约仍生效；P5 删除）
│   ├── graph.ts (3657 行)      StarGraph 上帝类（P4 拆；updateStatus 已写 shell-store）
│   ├── graph-{scene,fx,layout,colors,fold,analysis,tooltip,ui,textures,shaders}.ts  卫星
│   └── events.ts               bus（冻结：~26 emit/22 on，仅 11 文件 import）
└── main.ts                     引导器：StarGraph + Workspace + 面板单例 + 动作注册 + createRoot(<App/>)
```

聊天数据流：Agent → `eventSink` → prefixed bus(`p:{panelId}:agent:event`) → `Stream.renderEvent` → **per-session zustand msg stores** → React 订阅渲染。视图与逻辑之间只隔 store。

## 三、铁律（违反即返工）

1. **不碰 `ui/graph-layout.ts` / `gpu-layout.ts` 的任何参数**（AGENTS.md 锁定）。
2. **bus 冻结**：`app/` 新代码不 import `ui/events.ts`（chrome 走 store；chat-core 是编排层可豁免，因为它替代的旧 chat.ts 本就是 bus 参与者）。新事件一律进 store。
3. `chat-session.ts`/`chat-stream.ts`/`part-mutator.ts`/`execution-state.ts` 不改——改了就说明越界了。
4. **门禁每期必过**：`cd src-ui && npm run build`、`npx vitest run`（324 个）、`npx biome ci src/app`（必须零问题；存量代码有 288 个历史 error 是**既有基线**，不要顺手修）。
5. biome 会重排 import 顺序——编辑后跑 `npx biome check --write <改动文件>`。
6. `src-tauri/*` 的工作区改动是用户自己的，**不要 commit**。
7. 每阶段一个干净 commit，消息风格参照 `git log`（中文 conventional commits）。

## 四、下一步精确清单

### P2′-2c — 已并入 2a 完成 ✅

权限卡链路（`permission-ask` → `showPermissionCard` → enqueuePerm → PromptShelf）与 GoalStrip（panel-store.goalRecord）均已组件化。**剩手测**：权限卡 Enter=允许/Esc=拒绝（注意：Ctrl+Y 只是 tooltip 文本，旧版就没实现 handler，别当 bug 修——要补也是独立需求）；goal 暂停/恢复/取消。

### P3 — 六面板收编（估 2–3 天）

定义 `app/panels/panel-def.ts`：`{ id, side, title, icon, component, askAgent? }`，DockRail/DockPanel 读注册表。逐面板注意：

- **Check**（ui/check.ts + react/CheckPanel.tsx）：数据 push（main/Workspace.runCheck → `checkPanel.update(result)`）+ 自取 rpc；wrapper 删除后由 shell-store 或注册回调接 update。
- **Constraints**（ui/constraints.ts）：`.get()` 单例，main.ts 多处直调（load/toggle/isOpen/close）——调用点全改 action。
- **Dataflow**（ui/dataflow-panel.ts）：main.ts 注入了 `onParseQuery`（NL→symbol 的 Agent 兜底），迁移时把该闭包挪进 panel-def。
- **Hotspots**（ui/hotspots.ts）：持有 starGraph（`setGraph`），点行 → `shell.navigateToFile` + 高亮。
- **Timeline**（react/TimelinePanel.tsx）：唯一无 wrapper 的（main.ts 直接用其 Controller）；听 `timeline:refresh`，发 `check:history`。
- **Settings**（ui/settings-panel.ts）：`.get()` 单例 + `setOnSave`（main.ts:756 的 agent 重建链）。
- **FileTranslator**：由 FileViewer 构造（file-viewer.ts:142），保持其挂载点，只去独立 root。
- **ContextMenu**：portal 懒 root，收进单树 portal。

### P4 — StarGraph 拆解（估 2–3 天，零视觉变化）

1. **先写** `tests/ui/layout-golden.test.ts`：固定种子图 → `layout3D()` 坐标快照，钉死布局。
2. 沿现有接缝抽模块（facade 保留全部公开 API，调用方零改动）：scene-lifecycle / node-renderer / edge-renderer / label-system / interaction-controller / focus-controller / diff-overlay。
3. 外部调用面（必须保住）：`render/focusNode/resize/toggleFold/resetCamera/isFolded/isInsideGalaxy/exitGalaxy/clearAgentHighlight/highlightFile/highlightFolder/clearFileHighlight/showDiff/clearDiff/hasGraph/getNodeNames/showAgentTrail/hideAgentTrail/highlightHotspots/clearHotspots`（调用方：main.ts、workspace.ts、agent-visualizer.ts、HotspotsPanel）。
4. `tests/ui/graph.test.ts` mock 了全部 three.js——拆分后 import 路径变了，同步更新。

### P5 — 视觉识别落地（估 2 天）

- 新组件样式全走 `--obs-*`；`base.css/chat.css/panels.css`（7300 行）随旧代码退役删除（注意 beacon.css 目前依赖 chat.css 类契约——先搬后删）。
- Orbitron 退役；刻度盘+黄道椭圆进 WebGL（graph-scene.ts 扩展）；删 index.html 的 #space/#scanlines/#vignette。
- Welcome/图例/聚焦横幅按原型重写；更新 `.cursor/rules/hologram-frontend.mdc` 与根 `AGENTS.md`。

## 五、验证方法

```bash
cd src-ui
npm run build          # tsc --noEmit + vite build
npx vitest run         # 必须 324/324（含 chat-session/chat-stream-leak/subagent-sink 三个聊天测试）
npx biome ci src/app   # src/app 必须零问题

# 无头实机验证（mock 模式已能完整启动，P2′ 修的 listen 守卫）：
npx vite --port 1420 --strictPort   # 起 dev server
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless --disable-gpu \
  --window-size=2560,1400 --virtual-time-budget=15000 \
  --screenshot=/tmp/shot.png "http://localhost:1420/"
# 控制台错误排查：加 --enable-logging=stderr --v=0 然后 grep CONSOLE
# headless WebGL 渲染偏暗属正常；信标/面板/chrome 可见即可
```

## 六、已知坑（都是确认过的，别再查）

1. `biome ci` 全仓库基线 = 288 errors/686 warnings（2026-07-18 快照，stash 验证为存量）——只保证 `src/app` 零新增。
2. `chat-history-entry-wrap.active` 的样式是我 P2′ 新写的，未经真机视觉核对——P5 走查时看一眼。
3. 聊天 `progressSink`/`sink` 两个 getter 无消费者，为兼容旧契约保留；删不删随 P3 清理。
4. chat-session ctx 的 `panel/sessionTabs/tabBar` 是**分离桩元素**（吸收 DOM 写入，不可见）——这是故意的兼容桥，别当垃圾删。
5. 浏览器 mock 下 `mock-data.ts` 有未实现命令的 warn（sandbox_status/workspace_activate），无害。
6. index.html 里有个上古未闭合 `<style>` 空标签——P5 重写 index.html 时顺手清。

## 七、契约速查（省得重读代码）

**ChatCore 公开 API**（main.ts/workspace.ts 契约面）：`panelId`、`eventSink`、`setAgent/getAgent`、`setAgentFactory`、`setToolSchemas`、`setOnOpenSettings/setOnTrailToggle`（视图侧用 fireOpenSettings/fireTrailToggle）、`setStarGraph`、`setProjectPath`、`toggle/open/close/isOpen/summonPanel/collapseToInput/collapseToPill/expandToInput/fadeToHud/restoreFromHud`、`ask(q)`、`showPermissionCard(tool,reason,subject,danger?)`、`switchSession/closeSession/createNewSession`、`saveActiveSession/scheduleAutoSave/autoRestoreLastSession`、`listSavedSessions/loadSessionFromDisk/deleteSessionFile`、`toggleHistory/closeHistory`、`runGoalResume/cancelGoal`、`sendMessage/abort`、`onExecChange(cb)/execBusy`、`register{Composer,PromptShelf,Slash,At,Footer,Messages}`（收组件 ref 句柄；Messages 收 `MessagesApi{bump}`）、消息回调 `copyText/navigateToNode/editUserMessage/resendUserMessage/retryAssistant`、`handleAtInput/applyAtSelect/atOpen/atNavigate/atSelect`、`handleSlashInput/slashVisible/slashNavigate/slashSelect/hideSlash/executeCommand`、`openFilePicker/handleFileDrop/removeAttachedFile`、`_exec`（workspace 以 `chatPanel['_exec']` 取用——字段名必须保留）。

**Store 地图**：`shell-store`（chrome）· `panel-store`（面板内 UI：mode/tabs/tools/tokens/focus/goalRecord…）· `messages-store`（per-panel 与 per-session `${storeId}:${sid}` 消息）· `session-store`（会话元数据/activeIdx/tokens）· `input-store`（文本/附件/历史/草稿）· `chat-store`（四者注册表 + msgStoreFor）。

**bus 高频事件**：`workspace:switched`、`graph:rendered`、`graph:node-clicked`、`check:result/history`、`chat:turn-done`、`agent:diag/event/progress`、`goal:state`、`highlight:file|folder|clear`、`navigate:file`、`prompt:ask`、`timeline:refresh`。最大生产者 workspace.ts，最大消费者（旧 chat.ts 位置）现在是 chat-core。
