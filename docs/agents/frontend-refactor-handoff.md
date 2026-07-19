# HoloGram 前端「观测台」重构 — Handoff

> 交接时间：2026-07-19 · 上一棒：P0 → P6 已完成并全部入库
> **接手方式**：新窗口先读本文件 + `src-ui/src/app/README.md`。
> **下一棒**：视觉深化 P7 系列 —— P7g/P7a 已入 main；下一棒 P7b 六面板内部。按 `docs/agents/visual-deepening-plan.md` 施工（唯一事实来源）。
> 本文件取代会话内的计划文件，是重构的唯一事实来源。设计原型：`prototype/observatory-concept.html`（gitignored，本地参考）。

## 一、已完成（9 个 commit，全部在 main）

| Commit | 阶段 | 内容 |
|---|---|---|
| `baaf5b4` | P0 地基 | React 19.2.7 对齐（此前 react18+types19 撒谎）；字体 fontsource 自托管删 Google CDN；`src/app/` 骨架 + `tokens.css`（--obs-* token） |
| `726f2f6` | P1 壳 | 单 React 根 `<App/>`：CommandBar/StatusBar/DockRail/CommandPalette(Ctrl+K)/ShortcutsOverlay；`shell-store`（zustand）+ `actions` 注册表 + `bridge-adapters`（bus→store）；main.ts 1035→~840 行；index.html 瘦身为 #app-root+#graph+#welcome；graph.ts updateStatus 改写 store |
| `f2acd6e` | 修复 | 窗口拖拽：`.cb-bar` 补 `-webkit-app-region: drag`（按钮/输入 no-drag） |
| `1e6a08f` | P2′-2a 聊天 | 无头 `ChatCore`（chat-core.ts）+ 观测信标视图 `ChatBeacon`；删 ui/chat.ts、chat-dom.ts、chat-anim.ts；`chat-session/chat-stream/part-mutator/execution-state` 逻辑**零改动** |
| `c0a169a` | P2′-2b 内联 | 六个 React Controller 包装类删除，组件直接挂 ChatBeacon 树；core `register*` 改收组件 ref 句柄（Messages 收 `MessagesApi{bump}`）；AtAutocomplete 的 navigate/select/open 从 DOM-scraping 重写为状态驱动（顺带修掉选中后弹层滞留、紧接 Enter 误选二次）；PromptShelf 卸载时取消挂起 Promise；`chat-session/chat-stream` 零改动 |
| `350845d` | P3 六面板收编 | `app/panels/`（panel-def 注册表 + DockPanel + FileTranslatorPortal）；`ui/dock-store`（开合+projectPath+checkResult 事实源）/ `dock-config`（依赖注入槽）/ `overlay-store`（portal 目标）三件套；六面板 + ContextMenu + FileTranslator 全部去 Controller 进单树（FileTranslator 经 createPortal 保 FileViewer 挂载点）；删五个 wrapper；`Workspace.open/setupAgent/runCheck/doGraphUpdate` 摘掉 checkPanel 形参；app-shell 剥掉面板注册表，shell-store 删 panels 快照；CheckPanel 清 gate/resize 死代码 + 畸形结果渲染加固（冒烟抓到的单树崩溃）；Settings 同 id 嵌套消除；`chat-session/chat-stream` 零改动 |
| `6e3a6e1` | P4 星图拆解 | `graph.ts` 3651→~770 行 facade（持全量共享字段 + 公开 API 委托）；八个新模块沿 GraphFold host 反查接缝抽出：`graph-types`/`graph-node-renderer`/`graph-edge-renderer`/`graph-labels`/`graph-highlight`（清单外第 8 个：高亮+滤镜+lens+trail）/`graph-interaction-controller`/`graph-focus-controller`/`graph-scene-lifecycle`/`graph-diff-overlay`；材质工厂去重用 graph-shaders 既有导出（逐字节一致），删死 import；`tests/ui/layout-golden.test.ts` 固定种子图钉死 layout3D 坐标；公开调用面零改动，graph.test.ts 无需改（vi.mock 按注册表拦截与 importer 无关） |
| `2455111` | P5 视觉识别 | 旧 CSS 三大件（7321 行）按活 selector 集（487 个）抽取为 `app/foundation.css`/`graph-chrome.css`/`chat/chat.css`（并入 beacon.css）/`panels/dock-panels.css`，旧变量全量映射 --obs-*（含 9 个 TS/TSX 内联样式与 prompt-shelf/file-translator.css）；Orbitron 退役（fonts.ts+package.json，--font-hud→--obs-font-mono）；index.html 删 #space/#scanlines/#vignette；Welcome/图例/聚焦横幅按原型重写为玻璃胶囊；图例单源化（facade 委托 graph-ui.buildLegend，消除 P4 双拷贝分叉）；顺带修 #welcome 永不显示（旧 CSS 默认 none 无 .on 写入者）与 #graph 定位 38→46px 对齐；biome.json overrides 对四个迁移 CSS 关 noDescendingSpecificity/noImportantStyles；`chat-session/chat-stream` 零改动 |
| `5570feb` | P6 视觉深化 | **样式搬家 ≠ 视觉落地**——P5 是等价迁移，本期才改外观：352 处蓝色字面量规则化中和（深色线框→rgba(148,166,205,a×0.62)、浅色文字→--obs-text/-2）；P5 的 3D 刻度盘删除（用户确认不好看，屏幕空间方案亦放弃）；#vig 暗角 + #grain 颗粒氛围层回加（原型同款，z150）；聊天面板圆角玻璃 + 衬线标题 + 黄铜 code/工具卡/输入聚焦（beacon 布局不变）；简报/约束/时间轴/热点面板浮动化（rail+8、12px 圆角、软阴影，隐藏态位移同步修正）；去 corner-brackets 三处；tooltip/detail-card 圆角玻璃 |

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
│   ├── foundation.css          P5：reset/body/滚动条/#graph 容器/.hidden/Welcome（原型重写）
│   ├── graph-chrome.css        P5：图例/聚焦横幅/tooltip/detail-card/星系标签/corner-brackets/file-viewer/hg-icon
│   ├── fonts.ts                fontsource 自托管（Orbitron 已退役：Fraunces/JetBrains Mono/Noto Sans+Serif SC）
│   ├── panels/
│   │   ├── panel-def.ts        六面板注册表（id/side/title/icon/askAgent/unmountOnClose/component）
│   │   ├── DockPanel.tsx       面板容器（注册表驱动；dataflow/settings 关闭即卸载）
│   │   ├── dock-panels.css     P5：六面板样式（panels.css + chat.css 的 check-* 抽取合并）
│   │   └── FileTranslatorPortal.tsx  FileTranslator 单树 portal 宿主
│   └── chat/
│       ├── chat-core.ts        无头 ChatCore：会话/流式/权限/goal 全部编排，公开 API 与旧 ChatPanel 一致
│       ├── core-instance.ts    useCoreStore（main.ts 注入 core，App 就绪后渲染 ChatBeacon）
│       ├── ChatBeacon.tsx      视图根：pill/input/panel/hud 模式机 + 内联聊天组件树（Messages/Hint/Shelf/At/Slash/Footer，ref 句柄注册进 core）
│       ├── chat.css            P5：聊天全树样式（ui/react/chat.css + beacon.css 合并，变量映射 --obs-*）
│       ├── Composer.tsx        输入框（input-store.inputText 受控）
│       ├── HistoryPanel.tsx    历史会话（portal 到 body）
│       └── （beacon.css 已并入 chat.css）
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
│   │   └── prompt-shelf.css（组件内；base.css/chat.css/panels.css 已于 P5 删除）
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
│   ├── graph-ui.ts             图例/聚焦横幅 DOM 工厂（P5 起为 facade 唯一来源）
│   ├── graph-{fx,layout,colors,fold,analysis,tooltip,textures,shaders}.ts  卫星
│   ├── graph-scene.ts          卫星（P5 曾加 3D 刻度盘，P6 经用户确认删除，不再做表盘）
│   └── events.ts               bus（冻结：~26 emit/22 on，仅 11 文件 import）
└── main.ts                     引导器：StarGraph + Workspace + dock 配置槽注入 + 动作注册 + createRoot(<App/>)
```

聊天数据流：Agent → `eventSink` → prefixed bus(`p:{panelId}:agent:event`) → `Stream.renderEvent` → **per-session zustand msg stores** → React 订阅渲染。视图与逻辑之间只隔 store。

面板数据流：main/workspace → `useDockStore.getState()`（setCheckResult/openPanel/setProjectPath）→ 面板组件订阅渲染；`Workspace.open/setupAgent/runCheck/doGraphUpdate` 均已摘掉 checkPanel 形参。五个旧 wrapper（check/constraints/dataflow-panel/hotspots/settings-panel.ts）已删。

## 三、铁律（违反即返工）

1. **不碰 `ui/graph-layout.ts` / `gpu-layout.ts` 的任何参数**（AGENTS.md 锁定）。
2. **bus 冻结**：`app/` 新代码不 import `ui/events.ts`（chrome 走 store；chat-core 是编排层可豁免，因为它替代的旧 chat.ts 本就是 bus 参与者）。新事件一律进 store。
3. `chat-session.ts`/`chat-stream.ts`/`part-mutator.ts`/`execution-state.ts` 不改——改了就说明越界了。
4. **门禁每期必过**：`cd src-ui && npm run build`、`npx vitest run`（330 个）、`npx biome ci src/app`（必须零问题；存量代码有 288 个历史 error 是**既有基线**，不要顺手修）。
5. biome 会重排 import 顺序——编辑后跑 `npx biome check --write <改动文件>`。
6. `src-tauri/*` 的工作区改动是用户自己的，**不要 commit**。
7. 每阶段一个干净 commit，消息风格参照 `git log`（中文 conventional commits）。
8. **样式只写 `--obs-*`**（tokens.css）；`--font-scale` 是唯一保留的非 obs 变量（fontScale 运行时注入）。四个迁移 CSS（foundation/graph-chrome/chat/dock-panels）在 biome.json overrides 里关了 `noDescendingSpecificity`/`noImportantStyles`——存量类契约原样保留，新增样式不要依赖这两个豁免。

## 四、下一步精确清单

### P7a — 已完成 ✅（已入 main）

- chat.css 追加 P7a 覆盖段（12 项全）：markdown（h2/h3 serif、h4 mono 大写小标、blockquote 黄铜左边条、表格发丝线 + 表头 mono、pre 黑底 radius 6）、工具卡内部（header mono brass-hi、tool-args 黑底 chip、msg-tool-badge 状态 chip——badge-ok/fail/running 此前**无样式裸奔**、tool-done 弱化 0.75）、reasoning（toggle text-3 去深底、内容发丝线左边界）、sub-agent（蓝左边条卡，与黄铜工具卡区分层级）、diff（pass/fail 淡色边底，色值出原型 chip）、glob（mono 化 + truncated text-3）、node-link（蓝胶囊去下划线）、流式 caret（"▍"字符 → 原型 brass 块 cursor-blink 0.9s steps(2)）、Slash/At 弹层（radius 10 + hover 0.08 + active brass-dim+左条）、ChatHint（mono text-3）、上下文 meter（3px + pass/brass 渐变）。
- prompt-shelf.css 追加权限卡覆盖段：`:has(.prompt-shelf__perm-btns)` 作用域——warn 淡边淡底卡（danger 换 fail）、tag/工具名 warn 色、命令块 mono 黑底、按钮 mini-btn 化（允许本次 = primary 黄铜，会话允许/拒绝 = 默认，去掉旧绿/蓝/红三色大按钮）。
- 视觉验证：CDP 注入合成富文本消息（mock 无真实消息流），markdown/工具卡/reasoning/sub-agent/diff/glob/node-link/权限卡逐项截图核对过；caret 用 computedStyle 证 brass 块 + blink。
- **留真机**：真实 agent 消息流观感、权限卡 Enter/Esc（矩阵 ⚠ 项）。

### P7g — 已完成 ✅（已入 main）

- 信标模式动效 = **WAAPI 单轨驱动**（用户授权重构，FLIP+定时清场补丁方案已废）：ChatBeacon 订阅 panel-store，同步段量起点（宽/高/圆角/transform/opacity 五通道，含在飞动画接管值），rAF 里 React 已提交新模式类、CSS 无几何过渡故类切换即终态，直接量终点，`el.animate(from→to, 280ms)`；不写内联样式、无清场定时器——fill:none 结束天然落回 CSS 终态。连切：subscribe 与 rAF 双点 cancel，同帧多次切换只留最新一条动画。CSS 端 `.chat-panel{transition:none}`（覆写 P2′ 版，防双轨；pill 类自身 transition 特异性更高不受影响）。
- 内容区进入淡入 `@keyframes p7g-content-in`（旧 GSAP fadeContentIn 的 CSS 版，open/input 模式内容元素 0.22s/0.06s 延迟）。
- **进 pill 位置跳变**（真机反馈×2）：① pill 规则 transition 含 transform 与 WAAPI 双轨——补间期挂 `.chat-morphing` 类摘除（done 回调带身份校验，cancel 事件异步）；② React 外事件（graph 点击/键盘/Esc）的提交在 MessageChannel 任务里，帧边界可能先于提交——rAF 量到旧类 `from===to` 早退、动画未建致瞬跳，改为 rAF 重试等类翻牌（`tryStart(3)`，最多等 3 帧）。
- `.chat-panel.chat-open` 补 `min-height: 320px`。
- **escLayer 补 constraints**（用户真机反馈 Esc 无响应）——链序：galaxy→timeline→hotspots→check→**constraints**→chat→FV→highlight。
- 核对无误不改码三项：#grain 维持 z150（原型 z40 本就盖 chrome，截图顶栏文字无摩尔纹）；`.msg-bubble.assistant` padding 0 即原型 `.msg.agent .bubble` 无内边距语言（工具卡与文字同左缘）；浮动面板无弹层被子 overflow 裁切（df-grip 内缩 right/bottom:0，Settings 用原生 select）。
- 清死选择器 `.chat-panel.chat-pill .corner-brackets`（ChatBeacon JSX 本无此节点）。
- **CDP 补测（第二轮，合成事件全过）**：六面板开合 + 同侧 rail 让位/回位正常；Esc 链逐层实测（timeline/hotspots/check/chat 各分支均关闭正确）；Ctrl+K/?/Ctrl+L/Ctrl+, 全通；resize 真拖拽夹取精确（上极限 913px=70vh、下极限 180px、中间值线性），真拖拽后切模式内联残留全清；mock 简报自动展开复证（坑 #7）。
- **两个观察（现状契约非回归，未动）**：① ~~constraints~~/dataflow/settings 不在 escLayer 链（constraints 已按用户反馈补入；dataflow/settings 维持现状）；② 输入框聚焦时 Esc 走 Composer 自身（panel→input），blur 后 input 态 Esc 不进 pill（`isOpen()=panel||hud` 语义）——均与旧版一致。
- **留真机**：消息流内容态（reasoning/工具卡左缘对齐观感）mock 无法触发；四态切换补间流畅度；走查矩阵 ⚠ 项（权限卡/goal/星图/历史 active/碰撞/Welcome/悬停）。
- 合成事件注意：window 派发的事件不进 React 根容器，Composer 等组件级 handler 测不到——测组件级按键要把事件派发到具体元素上（K6 曾因此误判）。

### P2′-2c — 已并入 2a 完成 ✅

权限卡链路（`permission-ask` → `showPermissionCard` → enqueuePerm → PromptShelf）与 GoalStrip（panel-store.goalRecord）均已组件化。**剩手测**：权限卡 Enter=允许/Esc=拒绝（注意：Ctrl+Y 只是 tooltip 文本，旧版就没实现 handler，别当 bug 修——要补也是独立需求）；goal 暂停/恢复/取消。

### P3 — 已完成 ✅（六面板收编进 DockPanel，见上方架构快照与契约速查）

### P4 — 已完成 ✅（StarGraph 拆解为 facade + 八模块，见上方架构快照与契约速查）

- golden 钉板先行：`tests/ui/layout-golden.test.ts`（6 用例，layout3D 坐标快照；spiralGalaxies 的 Math.random 不在 layout3D 调用链上，链路全确定，逐位可复现）。
- 外部调用面逐项保住（render/focusNode/resize/toggleFold/resetCamera/isFolded/isInsideGalaxy/exitGalaxy/clearAgentHighlight/highlightFile/highlightFolder/clearFileHighlight/showDiff/clearDiff/hasGraph/getNodeNames/showAgentTrail/hideAgentTrail/highlightHotspots/clearHotspots），main.ts/workspace.ts/agent-visualizer.ts/HotspotsPanel 零改动。
- graph.test.ts 无需同步：vi.mock 按模块注册表拦截、与 importer 无关——330/330 通过即为证明。
- 比清单多一个模块 `graph-highlight`（文件/Agent/热点高亮 + 滤镜 + lens + trail 天然一簇，留 facade 会重新鼓包）。

### P5 — 已完成 ✅（`2455111`，见上方架构快照与契约速查）

- 迁移方法：`scripts/css-usage-survey.cjs`（活 selector 交叉比对：487 活 / 215 死）+ `scripts/css-extract.cjs`（抽取 + 变量映射 + keyframes 引用扫描），一次性脚本已入库溯源。
- 变量映射表：starlight→obs-text、text-muted/dim→obs-text-2、text-faint→obs-text-3、signal→obs-blue、sol→obs-brass、nebula→字面量 #a088e0、anomaly-*→obs-fail/warn/pass、font-hud→obs-font-mono、toolbar-h→obs-bar-h（38→46px，顺带对齐新 chrome）、status-h→obs-status-h；`--font-scale` 保留进 tokens.css。
- 无头 CDP 走查（`scripts/cdp-shot.cjs`，无头 Chrome + Runtime.evaluate 点击 + 截图）：shell/信标三态（pill→input→panel）/简报/时间轴/数据流/约束/图例胶囊/P6 圆角浮动面板全部视觉核对过。
- **剩手测（真机）**：Welcome 首屏（mock 有缓存工作区无法触发，样式是原型直译）、聚焦横幅（fb-name/fb-meta 胶囊，需真机 F 聚焦看）、focus 飞行、fold 钻取、diff 着色、watcher 增量、权限卡/goal、chat-history-entry-wrap.active（P2′ 遗留）、tooltip/detail-card 悬停。

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

# CDP 交互截图（P5 走查工具，可点击/求值后截图 —— 能看信标三态、面板开合）：
node scripts/cdp-shot.cjs /tmp/out '[{"js":"...document.querySelector(...).click()..."},{"wait":1200},{"shot":"name"}]'
```

## 六、已知坑（都是确认过的，别再查）

1. `biome ci` 全仓库基线 = 288 errors/686 warnings（2026-07-18 快照，stash 验证为存量）——只保证 `src/app` 零新增。
2. `chat-history-entry-wrap.active` 的样式是我 P2′ 新写的，未经真机视觉核对——真机走查时看一眼。
3. 聊天 `progressSink`/`sink` 两个 getter 无消费者，为兼容旧契约保留。
4. chat-session ctx 的 `panel/sessionTabs/tabBar` 是**分离桩元素**（吸收 DOM 写入，不可见）——这是故意的兼容桥，别当垃圾删。
5. 浏览器 mock 下 `mock-data.ts` 有未实现命令的 warn（sandbox_status/workspace_activate），无害。
6. ~~index.html 上古未闭合 `<style>`~~ —— P5 已清。
7. mock 未实现 `hologram_run_check`（走兜底返回 `{mock:true,…}` 畸形结果）——dev mock 下简报面板会展开且内容显示 "undefined 文件"，是 mock 缺口非回归（真机引擎返回完整 CheckResult）。P3 已给 CheckPanel 渲染加 `|| []` 兜底防单树崩溃。
8. Windows 上 Edit 工具会把文件写成 CRLF，而仓库工作树惯例是 LF（`.gitattributes` 只钉二进制）——改完跑 `sed -i 's/\r$//' <改动文件>`，否则 biome format 会报差异。
9. P4 后 facade 上的 `_gaussRand` 是死代码（原样保留，零行为变化原则）；facade 的 15 个契约委托方法（`_setCore*`/`_setGlow*`/`getNodeBaseScale`/`enterFocusSubgraph`/`exitFocusSubgraph`/`_findNodeIndexByName`/`clearAgentHighlight`/`highlightNodeNames`）是 fold/analysis/tooltip 的运行时依赖，**不可删**。
10. P5 迁移副作用零残留已验证：全库 grep 无旧变量（--starlight/--panel-bg/--signal/--sol/--nebula/--font-hud 等）——**不要再引入旧变量名**；ContextMenu 内联样式引的是 --obs-*（原 --starlight fallback 已换）。
11. ~~刻度盘~~ —— P5 的 3D 版经用户确认不好看已删，屏幕空间 SVG 版讨论后也放弃。**别再复活表盘/黄道椭圆**，除非用户明确要求。
12. `#welcome` 现在默认 `display:flex` + `.hidden` 切换（P5 修复：旧 CSS 默认 none 且无 .on 写入者导致永不显示）；index.html 初始带 `class="hidden"` 防 FOUC，main.ts 决策后 remove/add。
13. 无头 Chrome（`--headless --disable-gpu`）CSS 补间帧被节流：rAF 回调延迟到泵帧时才跑、`transitionend` 同理——CDP 验证动画要看**最终落定态**（定时清场后无内联残留、终点尺寸正确），别测中间态；合成点击不移动焦点（activeElement 停留 textarea 会触发 isEditing 吞键假象），测键盘链前先显式 blur。
14. `TimelinePanel.tsx` 的 `.corner-brackets`（含 `.cb-bottom` 两 span）是 P5 迁移遗留的**无样式死 JSX**——全库无对应 CSS 规则，不可见也无裁切问题；清理归 P7b 时间轴期，别在别的期顺手删（类契约原则按期走）。
15. `core.autocrlf=true`：`git checkout/switch/merge` 会把改动文件以 CRLF 写回工作树，biome format 立刻报全文件 CR——**checkout/merge 后对受影响文件重跑 `sed -i 's/\r$//'`**（或至少跑 `npx biome ci src/app` 自查）。git diff 因 autocrlf 归一化不可见此差异，只能靠 biome 抓。

## 七、契约速查（省得重读代码）

**ChatCore 公开 API**（main.ts/workspace.ts 契约面）：`panelId`、`eventSink`、`setAgent/getAgent`、`setAgentFactory`、`setToolSchemas`、`setOnOpenSettings/setOnTrailToggle`（视图侧用 fireOpenSettings/fireTrailToggle）、`setStarGraph`、`setProjectPath`、`toggle/open/close/isOpen/summonPanel/collapseToInput/collapseToPill/expandToInput/fadeToHud/restoreFromHud`、`ask(q)`、`showPermissionCard(tool,reason,subject,danger?)`、`switchSession/closeSession/createNewSession`、`saveActiveSession/scheduleAutoSave/autoRestoreLastSession`、`listSavedSessions/loadSessionFromDisk/deleteSessionFile`、`toggleHistory/closeHistory`、`runGoalResume/cancelGoal`、`sendMessage/abort`、`onExecChange(cb)/execBusy`、`register{Composer,PromptShelf,Slash,At,Footer,Messages}`（收组件 ref 句柄；Messages 收 `MessagesApi{bump}`）、消息回调 `copyText/navigateToNode/editUserMessage/resendUserMessage/retryAssistant`、`handleAtInput/applyAtSelect/atOpen/atNavigate/atSelect`、`handleSlashInput/slashVisible/slashNavigate/slashSelect/hideSlash/executeCommand`、`openFilePicker/handleFileDrop/removeAttachedFile`、`_exec`（workspace 以 `chatPanel['_exec']` 取用——字段名必须保留）。

**Store 地图**：`shell-store`（chrome）· `panel-store`（面板内 UI：mode/tabs/tools/tokens/focus/goalRecord…）· `messages-store`（per-panel 与 per-session `${storeId}:${sid}` 消息）· `session-store`（会话元数据/activeIdx/tokens）· `input-store`（文本/附件/历史/草稿）· `chat-store`（四者注册表 + msgStoreFor）· `dock-store`（六面板开合 + projectPath + checkResult）· `overlay-store`（ContextMenu/FileTranslator portal 目标）。

**StarGraph 模块地图（P4）**：facade 持全量共享字段，各模块以 `this as unknown as XxxHost` 反查（与 GraphFold/GraphAnalysis/GraphTooltip 同模式）。自有状态的模块：diff-overlay（diffActive/diffAddedIds/diffRemovedIds/diffModifiedIds）、highlight（_fileHighlight/_fileHighlightIndices/_fileOpacityOriginal/_agentHighlightIndices/_hotspotFiles/_trailLine）、focus（focusSubgraphSaved\* 三件/_resettingCamera/_savedFocus\*）、lifecycle（_layoutAbort/_diagMsg/_reveal\*/_bloomFar/_bloomHysteresis/idle 计件）。`_lensActive/_trailActive/_edgeTypeFilter/_nodeKindFilter` 留 facade（TooltipHost/clearGraph/buildLegend 共享）。兄弟互调走 host 上的模块引用（如 lifecycle→_nodes/_edges/_focus，edge-renderer→_focus._buildFocusSubgraphEdges）。

**Dock 面板操作面**（main.ts/actions/workspace 都用 `useDockStore.getState()`）：`openPanel/closePanel/togglePanel/isOpen(id)`、`setProjectPath(p)`、`setCheckResult(r)`（cacheCheckResult + 失败自动展开）、`showCheckHistory(r)`。外部依赖经 `ui/dock-config`：`setDataflowQueryParser`（NL→symbol Agent 兜底）、`setDockStarGraph`、`setOnSettingsSave`（main.ts 的 agent 重建链）。

**bus 高频事件**：`workspace:switched`、`graph:rendered`、`graph:node-clicked`、`check:result/history`、`chat:turn-done`、`agent:diag/event/progress`、`goal:state`、`highlight:file|folder|clear`、`navigate:file`、`prompt:ask`、`timeline:refresh`。最大生产者 workspace.ts，最大消费者（旧 chat.ts 位置）现在是 chat-core。

**样式文件地图（P5）**：`tokens.css`（--obs-* + --font-scale）→ `foundation.css`（reset/body/滚动条/#graph/#graph-labels/.hidden/Welcome）→ `graph-chrome.css`（#graph-legend/#graph-focus-banner/.fb-name/.fb-meta/#graph-tooltip .tt-*/#detail-card .dc-*/.galaxy-label/.galaxy-flash-label/.corner-brackets/.cb-bottom/#file-viewer/.fv-*/.hg-icon）→ `shell.css`（chrome）→ `chat/chat.css`（聊天全树 + goal-strip + 历史面板 + chat-utils 的 diff-\*/glob-\*）→ `panels/dock-panels.css`（check-\*/cs-\*/df-\*/hs-\*/sp-\*/tl-\* + 面板根 id 定位）。组件内：`ui/react/prompt-shelf.css`、`ui/file-translator.css`。main.ts 按此序 import。

**星图氛围契约（P6）**：无表盘（见坑 #11）；氛围层 = index.html 的 #vig（暗角 z3）+ #grain（颗粒 z150 mix-blend overlay，shell 上浮层下）。图例 DOM/ 唯一来源是 `graph-ui.buildLegend`（facade `buildLegend()` 委托，传 setEdgeTypeFilter/setNodeKindFilter + 两个 getter；**别再造第二份图例 markup**——P4 遗留的 facade 私有拷贝就是这么分叉的）。聚焦横幅 markup 在 graph-focus-controller.enterFocusSubgraph 与 facade _langHandler 两处（`.fb-name` 黄铜衬线斜体 + `.fb-meta` mono，改动需同步）。
