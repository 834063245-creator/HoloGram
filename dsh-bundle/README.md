# @a834063245/hologram-dsh

HoloGram 的代码依赖分析引擎 + 3D 图谱，作为 **DeepSeek Harness bundle 插件** 分发。

把代码库变成可对话的 3D 依赖星图：

- **34 个 MCP 图分析工具**（`mcp__hologram__*`）：直查依赖图，不用让 LLM 猜源码
- **3D 星图**：DSH 侧边栏「3D 星图」入口，全屏渲染项目依赖图（Three.js，同一引擎数据）
- **单一数据生命周期**：引擎一个进程双入口（MCP stdio + TCP），存量秒开 + watcher 增量更新

## 安装

前置：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 且 `dsh` 可用。

```sh
dsh plugin --profile web add @a834063245/hologram-dsh
dsh web
```

postinstall 会按平台从 GitHub Releases 下载引擎二进制（当前：**Windows x64**；Linux/macOS 支持在路上）。
重启后：

- 侧边栏底部出现「3D 星图 / 🌌」按钮 → 全屏 3D 依赖图（分析当前会话工作区）
- 34 个 `mcp__hologram__*` 工具进入 agent 工具箱：`explore_deps`、`search_symbols`、`get_neighbors`、`trace_impact`、`find_dep_path`、`inspect_symbol`、`get_community`、`cluster_report`、`fragile_modules`、`detect_cycles`、`coupling_report`、`arch_blindspots`、`analyze_project`、`graph_summary`、`validate_project`、`engine_status`、`list_flows`、`trace_dataflow`、`find_references` 等

> 引擎分析的项目根默认取 DSH 进程的 cwd（或当前会话工作区），可在 profile 的
> `cordis.patch.yml` 里覆盖 `hologram-engine` 行的 `config.projectRoot`。

## 数据生命周期

引擎以 `serve --project-root <root> --tcp` 单进程运行，MCP 工具与 3D 星图共享同一份内存图：

- **存量优先**：打开项目时从 `.hologram/`（SQLite/快照）读回已有图，源码未变即秒回
- **watcher 增量**：文件变更走增量更新，图始终新鲜
- **显式全量**：`?refresh=1`（星图地址栏）或 MCP `analyze_project` 触发全量重扫

## 这是什么（机制）

DSH 的 profile 插件机制：npm 包在 `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 即为一个 bundle。
`cordis.patch.yml` 注入两行：

| 行 id | 包 | 作用 |
|-------|----|------|
| `hologram-engine` | 本包 | 解析引擎二进制路径，提供 `hologramEngine` 服务 |
| `hologram-mcp` | `@deepseek-ai/dsh-mcp-client` | stdio 拉起 `hologram-engine serve --tcp`，注册 MCP 工具 |

同时本包在 DSH web 托管同源 `/hologram/` 路由（viewer SPA + `/hologram/api/graph` 实时图数据），
不依赖任何独立开发端口。

## 项目根覆盖示例

在 profile 的 `cordis.patch.yml`（或 `$DSH_HOME/cordis.patch.yml`）追加：

```yaml
- id: hologram-engine
  config:
    projectRoot: D:/some/project
```

## 维护边界（重要）

dsh-bundle 是 HoloGram 的**薄发布适配层**，不拥有产品资产：

- 引擎二进制：来自主仓 `engine/` 构建产物（GitHub Release 附件，install.mjs 下载）
- 3D viewer：直接构建 `src-ui/src/ui` 的渲染内核（vite alias），**不维护内核副本**
- 本包自有代码：`src/index.ts`（host glue）、`src/client/index.tsx`（sidebar entry）、`viewer/main.ts` + stubs、`cordis.patch.yml`、`scripts/install.mjs`

因此主仓改了 graph 内核，dsh-bundle 下一次构建自动拿到新内核；不需要跑 vendor 同步脚本。

## 发布流程（维护者）

1. 本地构建：`cd engine && cargo build --release` → `npm run pack:bin` → `npm run build && npm run build:client` → `cd viewer && node ../../src-ui/node_modules/vite/bin/vite.js build`
2. 打 tag `v<version>` 并 push → GitHub Actions `dsh-bundle` job 构建引擎二进制并传到 Release 附件 `hologram-engine-win32-x64.exe`
3. `npm publish`（壳包 ~200KB；postinstall 按版本号从 Release 下载二进制）

npm 包：`@a834063245/hologram-dsh`（公开）
二进制：GitHub Release 附件（`https://github.com/834063245-creator/HoloGram/releases/download/v<version>/hologram-engine-win32-x64.exe`）

## 本地开发（file: 安装）

```sh
# 1. 构建引擎 + 插件 + viewer（先装依赖：dsh-bundle 用 --ignore-scripts，避免 postinstall 拉二进制）
cd engine && cargo build --release
cd ../dsh-bundle && npm install --ignore-scripts && npm run pack:bin && npm run build && npm run build:client
cd viewer && node ../../src-ui/node_modules/vite/bin/vite.js build

# 2. 从 DSH checkout 用 file: 装到测试 profile
node --import tsx/esm apps/cli/src/bin.ts plugin --profile hologram-test add file:D:/HoloGramHG/dsh-bundle
```

> 注意：`file:` 是复制语义，改包后需 remove + add 刷新本地副本。
