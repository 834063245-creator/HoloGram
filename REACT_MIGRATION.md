# React 迁移计划

> 目标：30 文件 520 处手写 DOM → React 组件树 + Zustand 状态层
> Three.js WebGL canvas 层不动

## 最终 React 树

```
<App>                              ← 新建 App.tsx, React root
├── <Toolbar />                    ← main.ts 按钮区
│   ├── btnOpen, btnReanalyze, searchInput
│   ├── btnFold, btnResetCam
│   ├── btnCheck(badge), btnDiff
│   ├── btnTimeline, btnConstraints, btnDataflow
│   ├── btnSettings
│   └── winCtrls (min/max/close)
├── <StarGraph />                  ← ⚫ 不动, Three.js imperative
├── <Welcome />                    ← ⚫ 不动
├── <DockTabs />                   ← 左右 dock tabs
├── <TimelinePanel />              ← ✅ 已 React
├── <HotspotsPanel />              ← 待切
├── <CheckPanel />                 ← 待切
├── <ConstraintsPanel />           ← 待切
├── <DataflowPanel />              ← 待切
├── <SettingsPanel />              ← 待切
├── <ChatPanel>
│   ├── <ChatHeader />             ← chat-dom.ts
│   ├── <SessionTabs />            ← chat-session.ts
│   ├── <StatusBar />              ← chat-dom.ts
│   ├── <ChatMessages />           ← ✅ 已 React
│   ├── <ToolsView />              ← chat-dom.ts
│   ├── <ContextView />            ← chat-dom.ts
│   ├── <ChatInput />              ← chat-dom.ts
│   ├── <PromptShelf />            ← ✅ 已 React
│   ├── <SlashPanel />             ← ✅ 已 React
│   └── <HistoryPanel />           ← chat-dom.ts
├── <FileViewer />                 ← Monaco 壳, chrome 层切 React
├── <ContextMenu />                ← 待切
└── <StatusBar />                  ← main.ts 底部状态栏
```

## 步骤

### ✅ Step 0 — Zustand 补齐
- [x] `chat-store.ts` 加 inputText, attachedFiles, inputHistory, historyOpen, toolFilter, contextFilter
- [x] `chat.ts` 本地字段切到 store
- [x] `chat-session.ts` module-level Map 不动（DOM 引用 + agent handle，不可序列化）
- **产出**：`chat-store.ts` +16 字段 +15 action

### 🔙 Step 1 — ChatInput（已回退）
- [ ] ~~叠瓦模式不可行：新组件挂回旧 DOM → GSAP 冲突 + @/slash 失灵~~
- [ ] ~~教训：chat 面板 1700 行 + 5 个辅助文件深度耦合，不能逐个拆~~
- ~~**产出**：ChatInput.tsx（已删除），chat.ts 已恢复~~

### Step 2 — ChatHeader
- [ ] 新建 `ChatHeader.tsx`：标题栏 + panel tabs（对话/工具/上下文）+ 新建/历史按钮
- [ ] `chat-dom.ts` header 段 → React
- **产出**：`chat-dom.ts` -50 行

### Step 3 — StatusBar + SessionTabs
- [ ] 新建 `StatusBar.tsx`：状态点 + 模型名 + token 计数
- [ ] 新建 `SessionTabs.tsx`：session 标签切换/关闭
- [ ] `chat-dom.ts` status bar + `chat-session.ts` renderSessionTabs → React
- **产出**：`chat-dom.ts` -30 行

### Step 4 — ToolsView + ContextView  
- [ ] 新建 `ToolsView.tsx`：工具列表 + 搜索过滤 + 开关
- [ ] 新建 `ContextView.tsx`：上下文展示
- [ ] `chat-dom.ts` renderToolsView/renderContextView → React
- **产出**：`chat-dom.ts` -50 行

### Step 5 — HistoryPanel + 收尾
- [ ] 新建 `HistoryPanel.tsx`：会话历史列表
- [ ] `chat-dom.ts` history 段 → React
- [ ] **删除 `chat-dom.ts`**（931 行）
- [ ] 清理由此产生的 dead code
- **产出**：chat 系统全部 React 化

### Step 6 — SettingsPanel
- [ ] `settings-panel.ts` → React（4 个 tab：Provider / Agent / 显示 / 语言依赖）
- **产出**：~700 行 vanilla → React

### Step 7 — CheckPanel
- [ ] `check.ts` → React
- **产出**：~650 行 vanilla → React

### Step 8 — ConstraintsPanel
- [ ] `constraints.ts` → React
- **产出**：~440 行 vanilla → React

### Step 9 — HotspotsPanel
- [ ] `hotspots.ts` → React
- **产出**：~230 行 vanilla → React

### Step 10 — DataflowPanel
- [ ] `dataflow-panel.ts` → React
- **产出**：~620 行 vanilla → React

### Step 11 — App 壳
- [ ] 新建 `App.tsx`：React root + Toolbar + DockTabs + keyboard shortcuts
- [ ] `main.ts` 缩减为 mount + Three.js init（从 887 行 → ~100 行）
- **产出**：main.ts 瘦身

### Step 12 — Cleanup
- [ ] 删 `chat-dom.ts`
- [ ] 清 bus 频道（`agent:event`、`check:result` 等）
- [ ] 删无人引用的 export
- [ ] 跑 `npm run build` + `cargo tauri build` 确认

## 不动

- `graph.ts` / `graph-scene.ts` / `graph-fold.ts` — Three.js imperative canvas
- `graph-textures.ts` / `graph-ui.ts` — 图渲染辅助
- `agent.ts` / `retry.ts` — 无 UI
- `icons.ts` — SVG 生成

## 进度

| 步骤 | 状态 | 删除 vanilla 行数 |
|------|------|-------------------|
| Step 0 | ✅ | 0（只加 store 字段） |
| Step 1 | 🔙 已回退 | 0 |
| Step 2 | ⬜ | ~50 |
| Step 3 | ⬜ | ~30 |
| Step 4 | ⬜ | ~50 |
| Step 5 | ⬜ | ~931 (chat-dom.ts 全删) |
| Step 6 | ⬜ | ~700 |
| Step 7 | ⬜ | ~650 |
| Step 8 | ⬜ | ~440 |
| Step 9 | ⬜ | ~230 |
| Step 10 | ⬜ | ~620 |
| Step 11 | ⬜ | ~780 |
| Step 12 | ⬜ | — |
