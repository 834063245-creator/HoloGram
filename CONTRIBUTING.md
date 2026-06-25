# Contributing

感谢你对 HoloGram 的兴趣！

HoloGram 是一个 **Rust 分析引擎 + Tauri 2 桌面壳 + TypeScript/Three.js 3D 前端** 的项目。贡献前请先读下面的指南。

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
3. 写代码
4. **Rust 引擎改动必须跑测试**：
   ```bash
   cd engine && cargo test
   ```
5. **前端改动必须通过类型检查**：
   ```bash
   cd src-ui && npx tsc --noEmit
   ```
6. **Tauri 层改动必须通过编译检查**：
   ```bash
   cargo check --manifest-path src-tauri/Cargo.toml
   ```
7. Commit 遵循 [Conventional Commits](https://www.conventionalcommits.org/)：
   ```
   feat(engine): ...
   fix(ui): ...
   chore(ci): ...
   docs(readme): ...
   ```
8. 推送并发起 PR

### 项目结构

```
engine/         Rust 分析引擎（代码分析逻辑全在这里）
├── src/
│   ├── graph/        图模型、合并、diff、resolver
│   ├── adapter/      tree-sitter 多语言适配器
│   ├── analysis/     深层诊断（耦合/数据流/线程/盲区/explore）
│   ├── pipeline/     分析流水线（发现/解析/编排）
│   ├── community/    社区检测（Louvain）
│   ├── routing/      变更路由和约束校验
│   ├── storage/      存储引擎（MemoryIndex/SqliteDb/GraphStore）
│   └── mcp.rs        MCP Server（25 个工具）

src-ui/src/     TypeScript 前端
├── agent/      Agent 工具、hooks、内存、权限
├── provider/   LLM 接口适配（Anthropic / OpenAI）
├── ui/         3D 星图、聊天、终端、Git 面板...
└── main.ts     应用入口

src-tauri/      Rust / Tauri 2 桌面壳
├── src/        Rust 桥接层（Tauri commands + EngineClient）
├── Cargo.toml
└── tauri.conf.json
```

### 技术栈

| 层 | 技术 |
|---|---|
| 分析引擎 | Rust · tree-sitter (18 语言) · rayon 并行 · parking_lot |
| 存储引擎 | MemoryIndex (邻接表) · SQLite+FTS5 · GraphStore (RwLock) |
| 桌面壳 | Rust · Tauri 2 |
| 前端 | TypeScript · Vite · Three.js · Monaco · xterm.js · GSAP |
| 测试 | cargo test (Rust 275+) · tsc (TypeScript) |

### 需要帮助？

- 阅读 [README](README.md)
- 查看 [GitHub Discussions](https://github.com/834063245-creator/HoloGram/discussions)
- [PROJECT.md](PROJECT.md) 是项目全景真相源

---

**HoloGram 用自己分析自己。** 跑一遍 `hologram_analyze`，你就能看到自己的贡献在依赖图里怎么连上整个项目。
