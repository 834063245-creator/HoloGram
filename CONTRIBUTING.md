# Contributing

感谢你对 HoloGram 的兴趣！

HoloGram 是一个 **Rust 分析引擎 + Tauri 2 桌面壳 + TypeScript/React 前端** 的项目。开工前请先读根目录 [`CONVENTIONS.md`](CONVENTIONS.md) 与 [`INVARIANTS.md`](INVARIANTS.md)，并按 [`AGENTS.md`](AGENTS.md) 的开工清单执行。

## 行为准则

- 保持友善和专业
- 对新人耐心
- 建设性批评

## 如何贡献

### 报告 Bug

1. 在 [Issues](https://github.com/834063245-creator/HoloGram/issues) 搜索是否已有相同报告
2. 使用 Bug Report 模板
3. 提供：
   - 操作系统和版本
   - HoloGram 版本
   - 最小复现步骤
   - 实际行为 vs 预期行为

### 功能请求

开 Issue 前先在 Discussions 讨论。大的功能请求最好先确认方向。

### Pull Request 流程

1. Fork 仓库
2. 创建 feature 分支：`git checkout -b feature/your-feature`
3. 写代码（先读 `CONVENTIONS.md`，照抄现有模式；改高 fan-in 文件前先跑图工具的 preflight/impact）
4. **引擎改动**：
   ```bash
   cd engine && cargo test
   ```
5. **前端改动**：
   ```bash
   cd src-ui && npm run build        # tsc --noEmit + vite build
   cd src-ui && npx vitest run       # 逻辑/契约测试
   cd src-ui && npx biome check --write <改动文件>
   ```
   > 全仓 biome 501 errors / 338 warnings 是存量基线：不要顺手大修，只保证改动文件零新增。
6. **Tauri 壳改动**：
   ```bash
   cd src-tauri && cargo test        # 权限/生命周期/隔离等
   # 快验：cd src-tauri && cargo check
   ```
7. **桌面发布验证**（涉及打包/发布时）：
   ```bash
   cd src-tauri && cargo tauri build
   ```
   不要用 `cargo build --release` 代替。
8. Commit 遵循 [Conventional Commits](https://www.conventionalcommits.org/)：
   ```
   feat(engine): ...
   fix(ui): ...
   chore(ci): ...
   docs(readme): ...
   ```
9. 推送并发起 PR

### 项目结构

```
engine/               Rust 分析引擎（可独立 serve 为 MCP server）
├── src/
│   ├── graph/        图模型、合并、diff、resolver、句柄化 NodeId/EdgeId
│   ├── adapter/      27 种 tree-sitter 语言适配（18 种专用 .scm 结构查询）
│   ├── analysis/     耦合/数据流/循环/盲点/explore/flows/框架路由
│   ├── community/    Leiden/Louvain 社区检测
│   ├── pipeline/     发现/解析/并行合并流水线
│   ├── routing/      约束校验与变更路由
│   ├── storage/      MemoryIndex(CSR) + SQLite/FTS5 + GraphStore + 增量更新
│   ├── vector/       MiniLM ONNX 语义向量 + usearch
│   ├── tools/        MCP 工具注册表（35 schema，默认暴露 34）
│   ├── mcp.rs        MCP JSON-RPC 服务
│   └── lsp_manager.rs 原生 LSP 子进程管理
└── queries/          各语言结构/数据流 .scm 查询

src-tauri/            Rust / Tauri 2 桌面壳
├── src/
│   ├── rpc.rs        单一 IPC 入口（133 个方法）
│   ├── commands/     命令实现（graph/git/filesystem/shell/search/web/…）
│   ├── permissions/  权限引擎
│   ├── tools/        Tool trait（Read/Edit/Bash/Git/WebFetch）
│   ├── lifecycle.rs  ResourceLedger + 9 个 LifecycleService
│   └── utils/        IPC 护栏 / 锁降级 / 路径解析
└── tauri.conf.json

src-ui/               TypeScript 前端（React 19 + Zustand 5 + Three.js + Monaco）
├── src/
│   ├── app/          新观测台壳（单 React 根；新 UI 落这里）
│   ├── ui/           星图 scene + 领域 stores + React 组件
│   ├── agent/        Agent 运行时、领域工具、多 Agent、goal/plan
│   └── provider/     LLM Provider 抽象 + 模型目录
└── tests/            vitest + jsdom（1018 用例）
```

### 技术栈

| 层 | 技术 |
|---|---|
| 分析引擎 | Rust · tree-sitter（27 静态语法 + 动态加载）· rayon · parking_lot |
| 存储引擎 | MemoryIndex (CSR) · SQLite + FTS5 · GraphStore · 语义向量（ONNX/usearch） |
| 桌面壳 | Rust · Tauri 2 · portable-pty · worktree 隔离 |
| 前端 | TypeScript strict · React 19 · Zustand 5 · Three.js · Monaco · Vite · zod 4 |
| 工具链 | cargo test · vitest · tsc/vite · Biome |
| 测试基线 | engine 698 · src-tauri 309 · 前端 1018（2026-08-16 实测） |

### 需要帮助？

- 阅读 [README](README.md)
- 文档总索引：[docs/README.md](docs/README.md)
- 查看 [GitHub Discussions](https://github.com/834063245-creator/HoloGram/discussions)
- `docs/MULTI_AGENT_ROADMAP.md` 与 `docs/plans/` 是当前工作台

---

**HoloGram 用自己分析自己。** 跑一次 `cd engine && cargo run -- run analyze_project .`，你就能看到自己的贡献在依赖图里怎么连上整个项目。
