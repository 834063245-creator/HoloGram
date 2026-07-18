# HoloGram 前端视觉深化方案（P7 系列 · 全面视觉重构）

> 制定：2026-07-19 · 状态：待施工 · 施工分支：`feature/observatory-visual`
> **本方案是此 feature 的唯一事实来源。** 前置阅读：`docs/agents/frontend-refactor-handoff.md`（架构与契约）+ `prototype/observatory-concept.html`（视觉标准，gitignored 本地文件）。
> 交接惯例：每阶段一个干净 commit（中文 conventional commits），门禁全绿才入库。

## 〇、现状基线（截至 `5a93920`）

P0–P6 已在 main 完成：单 React 壳 + 无头聊天核心 + 六面板收编 + StarGraph 拆解 + 旧 CSS 三大件退役（7300→四文件）+ P6 表面中和（352 处蓝色字面量退场、聊天/面板圆角玻璃化、氛围层 #vig/#grain）。

**当前差距**：外壳（chrome/面板容器/聊天框）已是原型语言，但**内容层**——消息流、面板内部、浮层菜单、表单、FileViewer——仍是「中和后的旧 HUD」：结构对、细节不对。本 feature 把内容层补齐到原型水准。

## 一、目标 / 非目标

**目标**：除星图本体外，全部 UI 表面对齐 `prototype/observatory-concept.html` 的视觉语言。

**非目标（明确不做）**：
- 星图本体（WebGL 节点/边/辉光/标签/网格的配色与参数）——单独课题，不在本 feature
- 布局结构变化（beacon 底部居中定位、dock 左右分侧等已定格局不动）
- 交互/行为变化（延续零行为变化原则：类契约、id、DOM 结构、JS 逻辑不动，只改表面与纯装饰性 JSX）
- 表盘/黄道椭圆（用户已否决，见 handoff 坑 #11）
- `chat-session.ts`/`chat-stream.ts`/`part-mutator.ts`/`execution-state.ts`（铁律 #3）

## 二、设计规范（施工时逐字遵守；全部出自原型）

### 2.1 色彩纪律

| 角色 | 取值 | 用途 |
|---|---|---|
| 边框 | `--obs-line` / `--obs-line-soft` | 一切分隔线与描边；禁用有色边框 |
| 表面 | `--obs-glass` / `--obs-glass-hi` | 一切浮层卡片 |
| 文字 | `--obs-text` / `-2` / `-3` | 主/次/弱三级 |
| **黄铜** `--obs-brass(-hi/-dim)` | 仅：聚焦态、Agent 身份、active 选中、签名元素（品牌 mark、发送键、聚焦名、行内代码） |
| **蓝** `--obs-blue` | 仅：链接、info 点缀 |
| 语义 `--obs-pass/warn/fail` | 仅：状态 dot/chip/校验结果 |
| hover | `rgba(160,180,220,0.08)`（列表行 `0.045`） | 唯一 hover 背景 |
| 选中 | `--obs-brass-dim` 底 + 2px brass 左边条 | 原型 rail-btn.on / p-row.active 模式 |

禁止：彩色辉光阴影、渐变按钮、大面积有色底、旧 signal 蓝系任何色值回潮。

### 2.2 字体分层

- **Fraunces（--obs-font-serif）**：仅展示时刻——品牌名、Welcome、聚焦名（italic）、大数字（摘要卡 .big）、对话标题
- **JetBrains Mono（--obs-font-mono）**：数据/标签/时间戳/按钮/kbd/表头；大写小标签 letter-spacing 0.2–0.3em
- **Noto Sans SC（--obs-font-body）**：正文/消息/表单

### 2.3 圆角 / 阴影 / 间距

- 圆角阶梯：chip 4 · 按钮 7 · 工具卡 9 · 输入 10 · 气泡 11（不对称 `11px 11px 3px 11px`）· 面板/卡 12 · 大浮层 14 · 胶囊 999
- 阴影：浮层 `0 24px 80px rgba(0,0,0,0.45~0.55)`；禁彩色阴影
- 面板头：`padding: 11px 13px 10px` + 底部 `line-soft`；标题 mono 10px / 0.24em / uppercase
- 列表行：`padding: 8px 13px` + 底部 `line-soft`，末行无边

### 2.4 组件配方（原型出处）

- **工具卡**：`border: 1px line; border-left: 2px brass; background: rgba(201,162,92,0.05); radius 9`；头部 mono 11px brass-hi；参数块 `rgba(0,0,0,0.25)` 底 radius 6
- **权限卡**：`border: 1px rgba(216,162,74,0.35); background: rgba(216,162,74,0.06); radius 11`；标题 warn 色；命令块 mono `rgba(0,0,0,0.3)` 底；按钮 mini-btn（primary = brass 边 + brass-dim 底）
- **用户气泡**：`rgba(125,179,232,0.1)` 底 + `rgba(125,179,232,0.2)` 边 + 不对称圆角（P6 已做）
- **Agent 气泡**：无盒感纯文字流；行内代码 brass-hi on `rgba(201,162,92,0.1)`（P6 已做）
- **摘要卡 sum-card**：1px line + radius 10 + `rgba(99,178,125,0.05)` 底；serif 21px 大数字；meter 3px 渐变条
- **chip**：mono 9.5px + 1px line + radius 4；fail/warn/pass 用对应淡色边底
- **dot**：6px 圆点，语义色
- **行内代码（meta 中）**：mono 10.5px 蓝色 `rgba(125,179,232,0.09)` 底 radius 4

## 三、分期清单

### P7a — 消息流内部（最大面 · 1.5 天）

对象文件：`src-ui/src/app/chat/chat.css`（追加 P7a 覆盖段）、`src-ui/src/ui/react/prompt-shelf.css`、`src-ui/src/ui/chat-utils.ts`（只改生成的 class 结构如需，尽量不动）。

1. **markdown 排版**（`.msg-markdown`）：h1–h4 层级（serif h2/h3 可选，mono 小标 h4）、p/ul/ol 间距、table 发丝线边框 + 表头 mono、blockquote 黄铜左边条 + text-2、pre 代码块 `rgba(0,0,0,0.3)` 底 radius 6（注意 P6 已有 `pre code` 守卫，别破坏高亮 token 色）。
2. **工具卡内部**（`.msg-tool-card` 已在 P6 定型外框）：`.msg-tool-header` mono brass-hi、`.tool-name`/`.msg-tool-summary` 层级、`.tool-args` 黑底参数块、`.tool-result` text-2、`.tool-done` 状态色、展开态 `.tool-expanded`。
3. **权限卡**（PromptShelf / `prompt-shelf__*`）：按配方改 warn 色调卡片 + mini-btn 按钮组（primary brass）。
4. **reasoning 块**（`.msg-reasoning*`）：折叠头 mono text-3 + 内容 text-2 发丝线左边界。
5. **sub-agent 块**（`.msg-sub-agent*`）：工具卡同族但左边条用 --obs-blue（区分层级）。
6. **diff 卡**（`.diff-*`）：`.diff-added` → pass 淡底、`.diff-removed` → fail 淡底、`.diff-header` mono、`.diff-collapsed` text-3。
7. **glob 卡**（`.glob-*`）：mono 列表 + text-2。
8. **node-link**：蓝签名小胶囊（`rgba(125,179,232,0.09)` 底 + blue 字 + radius 4），hover 加亮。
9. **流式 caret**（`.msg-streaming-text` 光标）：brass 块闪烁（原型 caret keyframes）。
10. **SlashPanel（`.sp-*`）/ AtAutocomplete（`.at-*`）**：弹层 radius 10 玻璃；item hover `rgba(160,180,220,0.08)`；active `.sp-active` → brass-dim 底 + brass 左条。
11. **ChatHint（`.chat-hint`）**：mono text-3 小字。
12. **上下文表**（`.chat-context-meter*`）：3px meter 原型化（pass/brass 渐变）。

### P7b — 六面板内部（1 天）

对象文件：`src-ui/src/app/panels/dock-panels.css`（追加 P7b 覆盖段）。

1. **统一行语言**：各面板列表行向原型 `.row` 看齐（8px 13px + line-soft 底 + hover 0.045）——check 违规行（`.check-vitem`）、热点行（`.hs-item/.hs-file-row`）、时间轴事件（`.tl-event`）、约束行（`.cs-tag/.cs-toggle`）。
2. **简报摘要卡**（`.check-summary`）：sum-card 配方——serif 大数字（pass 色 em）+ 11px 副行 + 3px meter 渐变。
3. **违规条目**：`.check-vitem` chip 化（fail chip 给 L4/环等标记），`.check-vloc` mono text-3。
4. **热度条**（`.hs-line` 或现有结构）：原型 `.heat`——3px `rgba(255,255,255,0.06)` 底 + warn→fail 渐变填充。
5. **时间轴**：`.tl-event-dot` 语义色 dot 6px、`.tl-time-divider` mono text-3、`.tl-file-chip` chip 配方。
6. **约束表单**：`.cs-toggle` 开关现代化（轨道 line-soft、圆点 brass when on）、`.cs-tag` chip 配方、`.cs-btn-save` brass primary mini-btn。
7. **数据流**：`.df-tag-*`（read/write/trigger/await）保持语义色但改淡底淡边；`.df-md-*` markdown 对齐 P7a 排版；`.df-df-table` 发丝线表格。
8. **设置表单**（`.sp-*`）：`.sp-input/.sp-select` radius 8 + line 边 + focus brass；`.sp-radio/.sp-checkbox-label` 自定义勾选（brass）；`.sp-tabs` 下划线式 tab（active brass）；`.sp-range` 滑杆黄铜；`.sp-btn-save` brass primary。

### P7c — 浮层与菜单（0.5 天）

1. **ContextMenu**（`ui/react/ContextMenu.tsx` 内联样式）：玻璃底 + radius 10 + 项 radius 7 + hover 0.08 + 分隔线 line-soft（内联样式改值，不改结构）。
2. **HistoryPanel**（`.chat-history-*`）：entry hover 0.08、`.active` brass 左边条、del 按钮 text-3→hover fail。
3. **CommandPalette**（`app/shell.css` .pal-*）：对照原型 `#palette`——输入行黄铜 ❯ prompt、`.p-row.active` brass-dim + 左条、foot mono text-3。
4. **ShortcutsOverlay**（.sx-*）：原型 `#shortx`——h3 serif 17px、sub mono brass 0.26em、sx-row 发丝线底边 + kbd 统一。
5. **FileTranslatorPortal / overlay-store 宿主**：确认 portal 浮层圆角阴影统一。

### P7d — FileViewer 与文件翻译器（0.5 天）

1. `ui/file-viewer.ts` 内联样式：titlebar/面包屑/窗口按钮按原型 win-ctrl 语言（hover 0.08、close hover fail 淡底）；容器 12px 圆角玻璃；Monaco 容器边框 line-soft。
2. `ui/file-translator.css`：表面过一遍（圆角/发丝线/语义色纪律），fv-* 类契约不动。

### P7e — chrome 细节对齐（0.5 天）

1. **CommandBar**：brand 增加 mono 8px 0.32em 黄铜 sub（OBSERVATORY）如原型；`.cb-btn.on` 态 brass-hi；搜索框 = 原型 palette-trigger（mono text-3 + hover brass 边）。
2. **StatusBar**：遥测值 text-2、agent 名黄铜、pulse 点 pass 发光（原型 #status）。
3. **kbd 全局统一**：mono 10px text-3 + line 边 + radius 4。
4. **DockRail**：`.dr-btn.on` 已有黄铜？对照 rail-btn.on（brass-dim 底 + 左 2px 黄铜条）补齐。

### P7f — 一致性清扫（0.5 天）

1. 全库 rgba 扫描（复用 P6 规则脚本）：`b>=90 && b>r*1.45 && b>g*1.15` 的蓝色残留、以及 `rgba(25,45,80,·)`/`rgba(10,18,36,·)` 类暗蓝底 → 中性。
2. 字距规范：mono 大写标签统一 0.2–0.3em；正文不设 letter-spacing。
3. z-index/圆角/阴影抽查（浮层家族一致性）。
4. 更新 `.cursor/rules/hologram-frontend.mdc`、`src-ui/src/app/README.md`、handoff。

## 四、每期通用流程（DoD）

1. **分支**：`git checkout -b feature/observatory-visual`（首期建，后续期复用）；每期一个 commit，用户确认一批合一批回 main。
2. **门禁**：`cd src-ui && npm run build` + `npx vitest run`（330）+ `npx biome ci src/app`（零问题）。编辑后跑 `npx biome check --write <改动文件>`；Windows 上改完跑 `sed -i 's/\r$//' <文件>`。
3. **视觉验证**：起 dev（`npx vite --port 1420 --strictPort`）+ `node scripts/cdp-shot.cjs` 截图对照原型同部位；聊天消息态无法 headless 触发时，至少截空态框架 + 真机复查写进 commit。
4. **commit**：中文 conventional commits（`refactor(ui): 观测台 P7x — …`），消息写清表面项清单 + 门禁结果。
5. **文档**：每期结束更新 handoff（进度表 + 新坑）与本文件状态行。

## 五、契约与坑（违反即返工）

1. handoff「三、铁律」全部继承（布局参数锁、bus 冻结、聊天逻辑四文件不动、门禁、biome 重排、src-tauri 不 commit）。
2. **只改表面**：类名/id/DOM 结构/TS 逻辑不动；允许增删纯装饰性 JSX（如 P6 删 corner-brackets）；允许在 CSS 末尾追加覆盖段（同选择器后写优先），不重排存量规则。
3. **不要回潮**：禁引入旧 signal 蓝（68a8ff/8cc4ff/60,100,180 系）、禁旧变量名（--starlight/--panel-bg/--signal/--sol/--font-hud…）、禁彩色辉光。
4. P6 已做的不要再改：聊天面板壳/用户气泡/Agent 气泡/工具卡外框/图例/聚焦横幅/Welcome/面板浮动几何。
5. `prompt-shelf.css`/`file-translator.css` 是组件内文件，改完同样过门禁。
6. mock 缺口：headless 下简报内容 "undefined 文件"（mock 非回归）；消息流内容态需真机验收。
7. graph.test.ts / layout-golden.test.ts 不许动（本 feature 不碰 three.js）。
8. `--font-scale` 保留：所有 `calc(Npx * var(--font-scale))` 写法延续。

## 六、状态跟踪

| 阶段 | 内容 | 状态 | Commit |
|---|---|---|---|
| P7a | 消息流内部 | ⬜ | — |
| P7b | 六面板内部 | ⬜ | — |
| P7c | 浮层与菜单 | ⬜ | — |
| P7d | FileViewer/翻译器 | ⬜ | — |
| P7e | chrome 细节 | ⬜ | — |
| P7f | 一致性清扫 | ⬜ | — |
