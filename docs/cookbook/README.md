# docs/cookbook — 各 seam 的动手指南（索引）

> 本页是 cookbook 的**唯一入口**。每篇 = 一个 seam 上的「照着做就能接上」的最小配方；
> 契约全集在 [`../plugins/README.md`](../plugins/README.md)（平台契约总览），
> 规则约束在 [`../../CONVENTIONS.md`](../../CONVENTIONS.md) + [`../../INVARIANTS.md`](../../INVARIANTS.md)。
> 门禁：改 seam/组合面必过 `cd src-ui && npm run verify:convergence`；文档面过 `npm run doc-check`。

| 指南 | 做什么 | 对应 seam / 通道 |
|---|---|---|
| [`adding-an-llm-adapter.md`](adding-an-llm-adapter.md) | 接一个新 LLM 供应商/协议 | `llm` seam provider |
| [`adding-a-subagent-provider.md`](adding-a-subagent-provider.md) | 换/加子 Agent 执行后端 | `subagents` seam provider |
| [`adding-a-fs-backend.md`](adding-a-fs-backend.md) | 换文件系统后端 | `fs` seam provider |
| [`adding-a-shell-backend.md`](adding-a-shell-backend.md) | 换 shell 执行后端 | `shell` seam provider |
| [`adding-a-session-backend.md`](adding-a-session-backend.md) | 换会话持久化后端（卷读写/列举/删除） | `sessionPersistence` seam provider |
| [`adding-a-dynamic-plugin.md`](adding-a-dynamic-plugin.md) | 让模型在运行时定义插件包 | `ctx.dynamicRunner`（cordis 域） |
| [`adding-an-mcp-server.md`](adding-an-mcp-server.md) | 挂接外部 MCP server（插件声明式 / 用户级 `~/.lantai/mcp.json`） | manifest `mcpServers` / MCP 机器桥 |
| [`adding-a-skill.md`](adding-a-skill.md) | 给 Agent 加一门技能（项目级 / 用户级 / 出厂覆盖） | 技能发现根（`Skill` 工具 + 每步目录注入） |
| [`plugin-as-software.md`](plugin-as-software.md) | 写一个「软件级」插件（窗口 + 后台 + 数据目录） | app shell 四件套 |

## 读法

1. **先看契约**：`docs/plugins/README.md` §0 平台契约总览（贡献通道 / seam provider / 信任模型二分）。
2. **再抄同类**：这份 cookbook 的每一篇都对应仓库里一个已在产的实现——先 grep 到那个实现，照着它的形状写。
3. **守纪律**：seam 替换是契约面变更 ⇒ 按 `src-ui/src/composition/contract-version.ts` 四步流程升版；
   跨 seam 替换的集成证据在 `src-ui/tests/cross-seam-swap.test.ts`。
