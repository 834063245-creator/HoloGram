# 文档事实单一真源（生成物，勿手改）

<!-- 生成：node scripts/doc-facts.cjs ｜ 门禁：npm run doc-check（--check 逐字节对拍） -->

> 本表是**跨文档复述的标量事实**的唯一权威。L0/L1/L2 层文档禁止手抄下表数字——
> 要么指向本表（`docs/facts.generated.md`），要么直接写指针（真源文件）。
> 改真源 → 重跑 `node scripts/doc-facts.cjs` → 同 commit（doc-sync 门禁对拍）。

| 事实 id | 含义 | 值 | 真源 |
|---|---|---|---|
| `agent_config_fields` | AgentConfig 冻结字段数 | **23** | `src-ui/src/agent/runtime/types.ts` |
| `builtin_service_plugins` | 内核插件数（BUILTIN_PLUGINS 表） | **19** | `src-ui/src/plugins/service-plugins.ts` |
| `factory_products` | 出厂产物数（builtin-roster.json） | **39** | `src-ui/src/plugins/builtin-roster.json` |
| `tool_domains` | 兰台应用侧域工具数（src-ui DOMAIN_SPECS） | **11** | `src-ui/src/agent/tools/domains.ts` |
| `open_surface_contract_version` | 开放面契约版本 | **57** | `src-ui/src/composition/contract-version.ts` |
| `engine_contract_version` | 引擎开放面契约版本 | **11** | `engine/src/contract.rs` |
| `engine_shell_methods` | 引擎壳专属方法数 | **11** | `engine/src/contract.rs` |
| `engine_visible_tools` | 引擎模型可见默认工具数（域 + 未折叠） | **7** | `engine/src/tools/mod.rs` |
| `engine_default_tools` | 引擎可寻址工具数（DEFAULT_MCP_TOOLS，tools/call 原名） | **36** | `engine/src/tools/mod.rs` |
| `first_party_plugins` | 第一方插件总数（内核 + 出厂产物） | **58** | `src-ui/src/plugins/service-plugins.ts + src-ui/src/plugins/builtin-roster.json` |

## 域工具清单（`tool_domains` 的展开）

`fs` · `shell` · `git` · `search` · `web` · `agent` · `task` · `memory` · `browser` · `desktop` · `cordis`

> 域清单 = `DOMAIN_SPECS` 顶层 `name` 序（注册序 = 可见面构造序，属字节契约）。
> 已退役域（`graph` / `ops` / `lsp` 等，2026-09-09 图谱全量退役）不得再以现状口吻出现。
