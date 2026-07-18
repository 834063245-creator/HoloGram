# HoloGram 前端「观测台」重构 — Handoff

> 交接时间：2026-07-19 · 上一棒：P0 → P4 已完成并全部入库
> **接手方式**：新窗口先读本文件 + `src-ui/src/app/README.md`，然后按「下一步精确清单」执行。
> 本文件取代会话内的计划文件，是重构的唯一事实来源。设计原型：`prototype/observatory-concept.html`（gitignored，本地参考）。

## 一、已完成（7 个 commit，全部在 main）

| Commit | 阶段 | 内容 |
|---|---|---|
| `baaf5b4` | P0 地基 | React 19.2.7 对齐（此前 react18+types19 撒谎）；字体 fontsource 自托管删 Google CDN；`src/app/` 骨架 + `tokens.css`（--obs-* token） |
| `726f2f6` | P1 壳 | 单 React 根 `<App/>`：CommandBar/StatusBar/DockRail/CommandPalette(Ctrl+K)/ShortcutsOverlay；`shell-store`（zustand）+ `actions` 注册表 + `bridge-adapters`（bus→store）；main.ts 1035→~840 行；index.html 瘦身为 #app-root+#graph+#welcome；graph.ts updateStatus 改写 store |
| `f2acd6e` | 修复 | 窗口拖拽：`.cb-bar` 补 `-webkit-app-region: drag`（按钮/输入 no-drag） |
| `1e6a08f` | P2′-2a 聊天 | 无头 `ChatCore`（chat-core.ts）+ 观测信标视图 `ChatBeacon`；删 ui/chat.ts、chat-dom.ts、chat-anim.ts；`chat-session/chat-stream/part-mutator/execution-state` 逻辑**零改动** |
| `c0a169a` | P2′-2b 内联 | 六个 React Controller 包装类删除，组件直接挂 ChatBeacon 树；core `register*` 改收组件 ref 句柄（Messages 收 `MessagesApi{bump}`）；AtAutocomplete 的 navigate/select/open 从 DOM-scraping 重写为状态驱动（顺带修掉选中后弹层滞留、紧接 Enter 误选二次）；PromptShelf 卸载时取消挂起 Promise；`chat-session/chat-stream` 零改动 |
| `350845d` | P3 六面板收编 | `app/panels/`（panel-def 注册表 + DockPanel + FileTranslatorPortal）；`ui/dock-store`（开合+projectPath+checkResult 事实源）/ `dock-config`（依赖注入槽）/ `overlay-store`（portal 目标）三件套；六面板 + ContextMenu + FileTranslator 全部去 Controller 进单树（FileTranslator 经 createPortal 保 FileViewer 挂载点）；删五个 wrapper；`Workspace.open/setupAgent/runCheck/doGraphUpdate` 摘掉 checkPanel 形参；app-shell 剥掉面板注册表，shell-store 删 panels 快照；CheckPanel 清 gate/resize 死代码 + 畸形结果渲染加固（冒烟抓到的单树崩溃）；Settings 同 id 嵌套消除；`chat-session/chat-stream` 零改动 |
| `6e3a6e1` | P4 星图拆解 | `graph.ts` 3651→~770 行 facade（持全量共享字段 + 公开 API 委托）；八个新模块沿 GraphFold host 反查接缝抽出：`graph-types`/`graph-node-renderer`/`graph-edge-renderer`/`graph-labels`/`graph-highlight`（清单外第 8 个：高亮+滤镜+lens+trail）/`graph-interaction-controller`/`graph-focus-controller`/`graph-scene-lifecycle`/`graph-diff-overlay`；材质工厂去重用 graph-shaders 既有导出（逐字节一致），删死 import；`tests/ui/layout-golden.test.ts` 固定种子图钉死 layout3D 坐标；公开调用面零改动，graph.test.ts 无需改（vi.mock 按注册表拦截与 importer 无关） |

## 二、当前架构快照

```
src-ui/src/
├── app/                        ← 新架构（单 React 根 + zustand）
│   ├── App.tsx                 壳：CommandBar/DockRail×2/StatusBar/CommandPalette/ShortcutsOverlay/ChatBeacon/DockPanel/overlay 宿主
│   ├── shell-store.ts          chrome 唯一数据源（statusText/statusLog/graphStats/violations/analyzing/…；panels 快照已删）
│   ├── actions.ts              动作注册表；main.ts 注入实现，React 只认 id
│   ├── bridge-adapters.ts      bus→store 适配（目前只有 check:result）
│   ├── useGlobalKeys.ts        全局快捷键（Ctrl+K/L/D/, F R ? Esc）
│   ├── tokens.css / shell.css  --obs-* token + chrome 样式
│   ├── fonts.ts                fontsource 自托管
│   ├── panels/
│   │   ├── panel-def.ts        六面板注册表（id/side/title/icon/askAgent/unmountOnClose/component）
│   │   ├── DockPanel.tsx       面板容器（注册表驱动；dataflow/settings 关闭即卸载）
│   │   └── FileTranslatorPortal.tsx  FileTranslator 单树 portal 宿主
│   └── chat/
│       ├── chat-core.ts        无头 ChatCore：会话/流式/权限/goal 全部编排，公开 API 与旧 ChatPanel 一致
│       ├── core-instance.ts    useCoreStore（main.ts 注入 core，App 就绪后渲染 ChatBeacon）
│       ├── ChatBeacon.tsx      视图根：pill/input/panel/hud 模式机 + 内联聊天组件树（Messages/Hint/Shelf/At/Slash/Footer，ref 句柄注册进 core）
│       ├── Composer.tsx        输入框（input-store.inputText 受控）
│       ├── HistoryPanel.tsx    历史会话（portal 到 body）
│       └── beacon.css          chat.css 之上的增量覆盖（宽 640px、CSS 过渡、a11y 复位）
├── ui/                         ← 旧层（P4/P5 逐步清）
│   ├── chat-session.ts / chat-stream.ts / part-mutator.ts / message-model.ts / chat-store.ts  ★ 逻辑，勿动
│   ├── panel-store.ts          per-panel UI 状态（P2′ 加了 goalRecord/lastAgentDetail）
│   ├── dock-store.ts           六面板开合 + projectPath + checkResult 单一事实源（P3；替代 shell 探针+syncPanels）
│   ├── dock-config.ts          面板外部依赖注入槽（onParseQuery/starGraph/onSettingsSave；免注册竞态）
│   ├── overlay-store.ts        ContextMenu / FileTranslator 的 portal 渲染目标（P3）
│   ├── react/                  React 岛（纯组件；Controller 包装类已全部删除）
│   │   ├── ChatMessages.tsx / ChatFooter.tsx / ChatHint.tsx / PromptShelf.tsx / AtAutocomplete.tsx / SlashPanel.tsx
│   │   ├── CheckPanel.tsx / ConstraintsPanel.tsx / DataflowPanel.tsx / HotspotsPanel.tsx / TimelinePanel.tsx / SettingsPanel.tsx
│   │   ├── ContextMenu.tsx（含 ContextMenuHost）/ FileTranslatorPanel.tsx（导出 FileTranslatorApp）
│   │   └── base.css / chat.css / panels.css   旧样式（类契约仍生效；P5 删除）
│   ├── app-shell.ts            导航/高亮/queryAgent 命令（面板注册表已删）
│   ├── file-translator.ts      FileViewer 兼容 wrapper：DOM 挂载点 + 写 overlay-store（无独立 root）
│   ├── graph.ts (~770 行)      StarGraph facade（P4）：持全量共享字段 + 公开 API 委托 + fold/analysis/tooltip 契约兜底
│   ├── graph-types.ts          P4：GraphNode/GraphEdge/GraphJSON/EdgeData/CommunityData/GraphDiffJson 共享类型
│   ├── graph-node-renderer.ts  P4：core/glow GPU 缓冲写入 + buildNodes + 增量缓冲（_rebuild/_append/_sync/_markDead）
│   ├── graph-edge-renderer.ts  P4：边分组 LineSegments2 + hover 高亮边 + _rebuildEdgeData
│   ├── graph-labels.ts         P4：节点/星系标签投影（buildLabels/updateLabels）
│   ├── graph-highlight.ts      P4：文件/Agent/热点高亮 + 边/节点滤镜 + lens + trail（_fileHighlight 等状态自持有）
│   ├── graph-interaction-controller.ts  P4：hover raycast + 点击派发（setupHover/updateHover/onClick）
│   ├── graph-focus-controller.ts        P4：相机飞行/聚焦/聚焦子图（飞行状态字段留 facade 供 GraphFold 直读写）
│   ├── graph-scene-lifecycle.ts         P4：renderImpl/applyGraphDiff/渐进揭示/clearGraph/animate/resize/destroy
│   ├── graph-diff-overlay.ts   P4：变更回看着色（diffActive/diffAddedIds 等状态自持有）
│   ├── graph-{scene,fx,layout,colors,fold,analysis,tooltip,ui,textures,shaders}.ts  卫星
│   └── events.ts               bus（冻结：~26 emit/22 on，仅 11 文件 import）
└── main.ts                     引导器：StarGraph + Workspace + dock 配置槽注入 + 动作注册 + createRoot(<App/>)
```

聊天数据流：Agent → `eventSink` → prefixed bus(`p:{panelId}:agent:event`) → `Stream.renderEvent` → **per-session zustand msg stores** → React 订阅渲染。视图与逻辑之间只隔 store。

面板数据流：main/workspace → `useDockStore.getState()`（setCheckResult/openPanel/setProjectPath）→ 面板组件订阅渲染；`Workspace.open/setupAgent/runCheck/doGraphUpdate` 均已摘掉 checkPanel 形参。五个旧 wrapper（check/constraints/dataflow-panel/hotspots/settings-panel.ts）已删。

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

### P3 — 已完成 ✅（六面板收编进 DockPanel，见上方架构快照与契约速查）

### P4 — 已完成 ✅（StarGraph 拆解为 facade + 八模块，见上方架构快照与契约速查）

- golden 钉板先行：`tests/ui/layout-golden.test.ts`（6 用例，layout3D 坐标快照；spiralGalaxies 的 Math.random 不在 layout3D 调用链上，链路全确定，逐位可复现）。
- 外部调用面逐项保住（render/focusNode/resize/toggleFold/resetCamera/isFolded/isInsideGalaxy/exitGalaxy/clearAgentHighlight/highlightFile/highlightFolder/clearFileHighlight/showDiff/clearDiff/hasGraph/getNodeNames/showAgentTrail/hideAgentTrail/highlightHotspots/clearHotspots），main.ts/workspace.ts/agent-visualizer.ts/HotspotsPanel 零改动。
- graph.test.ts 无需同步：vi.mock 按模块注册表拦截、与 importer 无关——330/330 通过即为证明。
- 比清单多一个模块 `graph-highlight`（文件/Agent/热点高亮 + 滤镜 + lens + trail 天然一簇，留 facade 会重新鼓包）。
- **剩手测**：真机视觉核对（focus 飞行、fold 钻取、diff 着色、watcher 增量更新）——单测 mock 掉 three.js 覆盖不到视觉，P5 走查一并看。

### P5 — 视觉识别落地（估 2 天）

- 新组件样式全走 `--obs-*`；`base.css/chat.css/panels.css`（7300 行）随旧代码退役删除（注意 beacon.css 目前依赖 chat.css 类契约——先搬后删）。
- Orbitron 退役；刻度盘+黄道椭圆进 WebGL（graph-scene.ts 扩展）；删 index.html 的 #space/#scanlines/#vignette。
- Welcome/图例/聚焦横幅按原型重写；更新 `.cursor/rules/hologram-frontend.mdc` 与根 `AGENTS.md`。

## 五、验证方法

```bash
cd src-ui
npm run build          # tsc --noEmit + vite build
npx vitest run         # 必须 330/330（324 旧基线 + layout-golden 6 个布局钉板；含 chat-session/chat-stream-leak/subagent-sink 三个聊天测试）
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
7. mock 未实现 `hologram_run_check`（走兜底返回 `{mock:true,…}` 畸形结果）——dev mock 下简报面板会展开且内容显示 "undefined 文件"，是 mock 缺口非回归（真机引擎返回完整 CheckResult）。P3 已给 CheckPanel 渲染加 `|| []` 兜底防单树崩溃。
8. Windows 上 Edit 工具会把文件写成 CRLF，而仓库工作树惯例是 LF（`.gitattributes` 只钉二进制）——改完跑 `sed -i 's/\r$//' <改动文件>`，否则 biome format 会报差异。
9. P4 后 facade 上的 `_gaussRand` 是死代码（原样保留，零行为变化原则）；facade 的 15 个契约委托方法（`_setCore*`/`_setGlow*`/`getNodeBaseScale`/`enterFocusSubgraph`/`exitFocusSubgraph`/`_findNodeIndexByName`/`clearAgentHighlight`/`highlightNodeNames`）是 fold/analysis/tooltip 的运行时依赖，**不可删**。

## 七、契约速查（省得重读代码）

**ChatCore 公开 API**（main.ts/workspace.ts 契约面）：`panelId`、`eventSink`、`setAgent/getAgent`、`setAgentFactory`、`setToolSchemas`、`setOnOpenSettings/setOnTrailToggle`（视图侧用 fireOpenSettings/fireTrailToggle）、`setStarGraph`、`setProjectPath`、`toggle/open/close/isOpen/summonPanel/collapseToInput/collapseToPill/expandToInput/fadeToHud/restoreFromHud`、`ask(q)`、`showPermissionCard(tool,reason,subject,danger?)`、`switchSession/closeSession/createNewSession`、`saveActiveSession/scheduleAutoSave/autoRestoreLastSession`、`listSavedSessions/loadSessionFromDisk/deleteSessionFile`、`toggleHistory/closeHistory`、`runGoalResume/cancelGoal`、`sendMessage/abort`、`onExecChange(cb)/execBusy`、`register{Composer,PromptShelf,Slash,At,Footer,Messages}`（收组件 ref 句柄；Messages 收 `MessagesApi{bump}`）、消息回调 `copyText/navigateToNode/editUserMessage/resendUserMessage/retryAssistant`、`handleAtInput/applyAtSelect/atOpen/atNavigate/atSelect`、`handleSlashInput/slashVisible/slashNavigate/slashSelect/hideSlash/executeCommand`、`openFilePicker/handleFileDrop/removeAttachedFile`、`_exec`（workspace 以 `chatPanel['_exec']` 取用——字段名必须保留）。

**Store 地图**：`shell-store`（chrome）· `panel-store`（面板内 UI：mode/tabs/tools/tokens/focus/goalRecord…）· `messages-store`（per-panel 与 per-session `${storeId}:${sid}` 消息）· `session-store`（会话元数据/activeIdx/tokens）· `input-store`（文本/附件/历史/草稿）· `chat-store`（四者注册表 + msgStoreFor）· `dock-store`（六面板开合 + projectPath + checkResult）· `overlay-store`（ContextMenu/FileTranslator portal 目标）。

**StarGraph 模块地图（P4）**：facade 持全量共享字段，各模块以 `this as unknown as XxxHost` 反查（与 GraphFold/GraphAnalysis/GraphTooltip 同模式）。自有状态的模块：diff-overlay（diffActive/diffAddedIds/diffRemovedIds/diffModifiedIds）、highlight（_fileHighlight/_fileHighlightIndices/_fileOpacityOriginal/_agentHighlightIndices/_hotspotFiles/_trailLine）、focus（focusSubgraphSaved\* 三件/_resettingCamera/_savedFocus\*）、lifecycle（_layoutAbort/_diagMsg/_reveal\*/_bloomFar/_bloomHysteresis/idle 计件）。`_lensActive/_trailActive/_edgeTypeFilter/_nodeKindFilter` 留 facade（TooltipHost/clearGraph/buildLegend 共享）。兄弟互调走 host 上的模块引用（如 lifecycle→_nodes/_edges/_focus，edge-renderer→_focus._buildFocusSubgraphEdges）。

**Dock 面板操作面**（main.ts/actions/workspace 都用 `useDockStore.getState()`）：`openPanel/closePanel/togglePanel/isOpen(id)`、`setProjectPath(p)`、`setCheckResult(r)`（cacheCheckResult + 失败自动展开）、`showCheckHistory(r)`。外部依赖经 `ui/dock-config`：`setDataflowQueryParser`（NL→symbol Agent 兜底）、`setDockStarGraph`、`setOnSettingsSave`（main.ts 的 agent 重建链）。

**bus 高频事件**：`workspace:switched`、`graph:rendered`、`graph:node-clicked`、`check:result/history`、`chat:turn-done`、`agent:diag/event/progress`、`goal:state`、`highlight:file|folder|clear`、`navigate:file`、`prompt:ask`、`timeline:refresh`。最大生产者 workspace.ts，最大消费者（旧 chat.ts 位置）现在是 chat-core。
