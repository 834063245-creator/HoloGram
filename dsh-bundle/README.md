# hologram-dsh

HoloGram 的代码依赖分析引擎 + 3D 图谱，作为 **DeepSeek Harness bundle 插件** 分发。

- **阶段 1（已完成 ✅）**：把 HoloGram 引擎打包成 DSH bundle，引擎的 34 个 MCP 图分析工具
  直接注入 DSH agent 的工具箱（`mcp__hologram__*` 命名空间）。零引擎改动。
- **阶段 2（规划中）**：把 `src-ui` 的 Three.js 3D 星图接进 DSH 的 web GUI（client-plugin 面板）。

## 这是什么

DSH 有一套 profile 插件机制：一个 npm 包只要在 `package.json` 里声明

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

它就是一个 "bundle"。用户 `dsh plugin add <包>` 之后，这个 `cordis.patch.yml`
会被插进 DSH 的运行时层叠，向 harness 注入新的插件行（工具、服务、web 面板等）。

本包注入两行：

| 行 id | 包 | 作用 |
|-------|----|------|
| `hologram-engine` | `hologram-dsh`（本包） | 解析随包的引擎二进制路径，提供 `hologramEngine` 服务 |
| `hologram-mcp` | `@deepseek-ai/dsh-mcp-client` | 用 stdio 拉起 `hologram-engine serve`，注册 MCP 工具 |

## 结构

```
dsh-bundle/
├── package.json          # dsh.bundle.patch -> cordis.patch.yml；@deepseek-ai/* 走 peerDeps
├── cordis.patch.yml       # 注入 glue 插件 + mcp-client 行
├── src/index.ts           # glue 插件：解析引擎二进制路径、提供服务
├── bin/                   # 随包分发的引擎二进制（pack:bin 生成，不入库）
│   ├── hologram-engine.exe
│   └── onnxruntime.dll    # 可选，向量/语义工具
├── scripts/pack-bin.mjs   # 从 engine/target/release 拷贝二进制到 bin/
├── tsdown.config.ts       # 构建 src -> lib/index.mjs（@deepseek-ai/* 标 external）
└── .gitignore
```

## 本地构建

前置：引擎已用 release 构建（`cd engine && cargo build --release`），产物在
`engine/target/release/hologram-engine.exe`。

```sh
# 1. 把引擎二进制复制进 bin/
npm run pack:bin

# 2. 构建插件（tsdown -> lib/index.mjs）
#    tsdown 来自本机 DSH 源码 checkout 的 node_modules，见 tsdown.config.ts
```

## 安装到 DSH 本地 profile（测试）

从一个 DSH checkout 运行（此时 `dsh` 未进 PATH，直接用源码入口）：

```sh
# 用 file: 本地安装到一个新 profile（会自动 init：dsh-base + 本包）
node --import tsx/esm apps/cli/src/bin.ts plugin --profile hologram-test add file:D:/HoloGramHG/dsh-bundle

# 看合成后的配置（确认 hologram-engine / hologram-mcp 两行在场）
node --import tsx/esm apps/cli/src/bin.ts --profile hologram-test --dump-config
```

装好后，boot 该 profile 时引擎会被拉起，34 个 `mcp__hologram__*` 工具进入 agent 工具箱：
`explore_deps`、`search_symbols`、`get_neighbors`、`trace_impact`、
`find_dep_path`、`inspect_symbol`、`get_community`、`cluster_report`、
`fragile_modules`、`detect_cycles`、`thread_conflicts`、`coupling_report`、
`arch_blindspots`、`graph_summary`、`project_timeline`、`analyze_project`、
`graph_diff`、`preflight_check`、`validate_project`、`project_health`、
`rename_symbol`、`engine_status`、`check_boundaries`、`find_unused`、
`list_flows`、`get_flow`、`get_affected_flows`、`trace_dataflow`、
`resolve_call`、`infer_type`、`find_implementations`、`find_references`、…

> 注意：DSH profile 用 `file:` 是**复制**——改了本包需 remove + add 刷新本地副本。
> 引擎分析的项目根默认取 DSH 进程的 cwd，可在 profile 的 `cordis.patch.yml` 里覆盖
> `hologram-engine` 行的 `config.projectRoot`。

## 项目根（默认 cwd）覆盖示例

在 profile 的 `cordis.patch.yml`（或 `$DSH_HOME/cordis.patch.yml`）追加：

```yaml
- id: hologram-engine
  config:
    projectRoot: D:/some/project
```

## 安装（用户侧）

```sh
# 需要 DeepSeek Harness 的 dsh CLI
dsh plugin --profile web add @a834063245/hologram-dsh
dsh web
```

postinstall 会自动从 GitHub Releases 下载对应平台的引擎二进制（Windows x64 先行）。
重启后：34 个 mcp__hologram__* 工具 + 侧边栏「3D 星图」。

> 平台矩阵：路线 A 目前仅 Windows x64。Linux/macOS 支持在路上。
> 引擎分析的项目根默认取 DSH 进程的 cwd，可在 profile 的 cordis.patch.yml 里覆盖
> hologram-engine 行的 config.projectRoot。

## 发布流程（维护者）

1. 本地构建：`cd engine && cargo build --release` → `cd dsh-bundle && npm run build && npm run build:client` → viewer `vite build`
2. 打 tag `v<version>` 并 push → GitHub Actions 构建引擎二进制并传到 Release
3. `npm publish`（壳包 ~200KB，postinstall 从 Release 下载二进制）

npm 包：`@a834063245/hologram-dsh`（公开）
二进制：GitHub Release 附件 `hologram-engine-win32-x64.exe`
