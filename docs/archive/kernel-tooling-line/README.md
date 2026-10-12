# 内核 / 工具 / 平台线（kernel-tooling-line）— 已归档计划

> **已归档（2026-10-08 · 文档面收尾）**——本目录收十三份过程文档：前十份**代码已完成、余真机验收**，
> 后三份**已作废 / 被取代**（无验收面）。判据 = CONVENTIONS §4：「**过程文档是否还活着**，不是验收跑没跑完」——
> 真机欠账由 [`plans/README.md`](../../plans/README.md) 欠账表承载（**本仓唯一在办真值**）。
> 现状承接：`ARCHITECTURE.md` · `CONVENTIONS.md`（工具/RPC/壳层纪律）· `docs/plugins/README.md`。

## 一、代码完成 · 余真机验收（10）

| 件 | 是什么 | 现在看哪 |
|---|---|---|
| [`shell-stability-bundled-bash-plan.md`](shell-stability-bundled-bash-plan.md) | 捆绑 MSYS2 bash + dsh 式执行纪律（P0-P5 全部落地并已实跑） | `CONVENTIONS.md` §3（shell 纪律现行条文） |
| [`command-surface-rework-plan.md`](command-surface-rework-plan.md) | 斜杠命令面重做（契约 v41 → v42） | 欠账表「斜杠命令面重做」四件 |
| [`artifact-inlining-payoff-plan.md`](artifact-inlining-payoff-plan.md) | 产物内联销账（A4）：39 产物零 ⚠ 行 + 三道门禁 | `docs/landmine-map.md` 第十五批 A4；欠账 W4 |
| [`engine-host-severance-plan.md`](engine-host-severance-plan.md) | 引擎-宿主逻辑全断：壳零 `hologram-*` crate 依赖 | `ARCHITECTURE.md`；欠账表真机四项 |
| [`engine-lsp-runtime-hardening-plan.md`](engine-lsp-runtime-hardening-plan.md) | 引擎/LSP 运行期加固（空闲误杀总闸 + 停止留痕带因；契约 v10） | 欠账两件已拆成独立设计件（`docs/plans/`） |
| [`office-cli-integration-plan.md`](office-cli-integration-plan.md) | OfficeCLI 集成：`office(action,…)` 一等域工具 + P0 权限判定 | 欠账表「OfficeCLI 集成」；技能 `officecli` |
| [`uninstall-purge-plan.md`](uninstall-purge-plan.md) | 卸载残留清理（NSIS 勾选删数据；`.msi` 渠道停发） | `src-tauri/src/purge.rs`；欠账表勾选验收 |
| [`app-shell-software-plugin-plan.md`](app-shell-software-plugin-plan.md) | 软件级插件（数据目录 / 受治进程治理 / 窗口原语 / 后台唤醒 + `notes-app` 范本） | `docs/plugins/README.md`；管理 UI 面另批 |
| [`lsp-fleet-daemon-plan.md`](lsp-fleet-daemon-plan.md) | LSP 舰队共享化：每根目录一套 LSP（`hologram-lspd`）——16GB 机器内存耗尽的结构性根治 | 欠账表「随包 LSP 守护（打包补件）」 |
| [`skills-mcp-production-plan.md`](skills-mcp-production-plan.md) | Skills 与 MCP 生产级改造：技能发现根与每步注入 + 用户级 `mcp.json` + 两个管理 tab | 欠账表「技能与 MCP 真机验收」 |

## 二、已作废 / 被取代（3）

| 件 | 状态 |
|---|---|
| [`kernel-plugin-runtime-plan.md`](kernel-plugin-runtime-plan.md) | 已作废——内核插件运行时线随 v3 决策（TS 策略建议层 + Rust 能力口强制层）整体拆除 |
| [`kernel-plugin-runtime-phase2-design.md`](kernel-plugin-runtime-phase2-design.md) | 已作废——同上（v3 拆除令） |
| [`dynamic-edge-detection-plan.md`](dynamic-edge-detection-plan.md) | superseded（2026-08-24）——动态边已并入 `docs/plans/v11-analysis-engine-master-plan.md`（该主文档仍挂起） |

**仍在办的近亲**（不在本目录）：内核能力口**决策真源与在产蓝本**留 `docs/plans/`（`kernel-plugin-architecture-decision.md` · `r1` · `r2` · `c3` · `d4`）——它们是**现状依据**，不是过程文档。
