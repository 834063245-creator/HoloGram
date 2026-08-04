# CLAUDE.md

## 用户

外行 vibe coder，不看代码，交互质感对标 Blender。用产品思维理解他的话，别逐字执行。回答简洁，猜比追问好。说"炸了""卡成狗"= 主动排查，别问复现步骤。

## 硬约束（不遵守必出 bug）

- **构建**：必须 `cargo tauri build`，不能只 `cargo build --release`。前端改完先 `cd src-ui && npm run build`
- **Rust 改完**：先 `cd engine && cargo build`，再 `cargo tauri build`（`tauri dev` 自动 spawn engine）
- **Windows 路径**：`location` 用 `\`，提取文件用 `rsplit(":", 1)` 避免吃 drive letter
- **枚举兼容**：`from_json()` 后 type 变字符串，同时处理 enum 和 str
- **程序层不做**：不解释、不推断、不声称找到 bug 根源 — 只呈现数据
- **改代码前先查依赖**：MCP `hologram_*` 工具能直接给答案，别用 grep 猜
- **先抄再写**：在代码库里找到做类似事情的文件，复制它的模式。不要引入新的通信方式（用 bus.emit，不要 window.dispatchEvent），不要引入新的状态管理方式（用 Zustand store factory + Map registry，不要模块级变量）。不确定怎么写 → `Grep` 现有代码找参考 → 照着抄
- **改完验证**：前端改完跑 `cd src-ui && npm run build`，Rust 改完跑 `cd engine && cargo build`，过了再 commit
- **不要改 CI**：`.github/workflows/ci.yml` 只做编译+测试，不动它

## 项目

代码依赖拓扑图生成器。Tauri 2 + Rust 引擎 + Three.js 3D 星图。Python 引擎 `src_python/` 已退役，所有活跃代码走 `engine/`。

架构与路线图见 `docs/`（MULTI_AGENT_ROADMAP.md 为多 Agent 工作台）。

## Agent skills

### Issue tracker

GitHub Issues on `834063245-creator/HoloGram`，外部 PRs 纳入 triage 队列。详见 `docs/agents/issue-tracker.md`。

### Triage labels

默认标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

Single-context — 根目录 `CONTEXT.md` + `docs/adr/`。详见 `docs/agents/domain.md`。
