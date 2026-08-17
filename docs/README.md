# HoloGram 文档索引

> 收敛日期：2026-08-17。原则：**根目录只放入口与规则；docs/ 按用途分层；完成即归档。**
> 找文档先看本页；本页没有的再去 `docs/archive/`，归档内容不是现状。

## 入口（按角色）

| 角色 | 先读 | 说明 |
|---|---|---|
| 用户 / 想跑起来 | [`README.md`](../README.md) | 定位、安装、快速开始、构建 |
| 贡献者 | [`CONTRIBUTING.md`](../CONTRIBUTING.md) | 提交流程、门禁、结构 |
| 内置 HoloGram Agent / Claude Code | [`CLAUDE.md`](../CLAUDE.md) | 每次会话自动注入的硬约束 |
| Codex / 其他项目级 Agent | [`AGENTS.md`](../AGENTS.md) | 静态注入的项目手册 |

## 规则（改动前必读）

1. [`CONVENTIONS.md`](../CONVENTIONS.md) — 编码约定，以代码现状为准。
2. [`INVARIANTS.md`](../INVARIANTS.md) — 已经炸过的雷；改 `src-ui/src/ui/**` / `src-ui/src/agent/**` / Rust 接缝前必读。
3. [`docs/adr/project-constitution.md`](adr/project-constitution.md) — 四条最高架构约定。
4. [`docs/landmine-map.md`](landmine-map.md) — 已知技术债与拆弹状态。
5. 优先级：project-constitution > INVARIANTS > CONVENTIONS > 历史 plan/handoff。

## 现状文档

| 文档 | 状态 | 内容 |
|---|---|---|
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | 当前（2026-08-17 校准） | 系统架构、技术栈、关键决策、验证基线 |
| [`CONTEXT.md`](../CONTEXT.md) | 当前 | 应用级统一词汇（`kind`/`status` 带簇前缀） |
| [`docs/MULTI_AGENT_ROADMAP.md`](MULTI_AGENT_ROADMAP.md) | 工作台 | 多 Agent 路线图与已落地能力 |
| [`docs/landmine-map.md`](landmine-map.md) | 当前 | 雷区地图、拆弹批次状态 |

## docs/ 分区

| 目录 | 放什么 | 现状 |
|---|---|---|
| [`adr/`](adr/) | 架构决策记录（编号 ADR + 主题 ADR） | 6 篇，见目录 |
| [`agents/`](agents/) | Agent 操作/事故/对比文档 | 保留：dsh-harness-comparison、platform-bugs-2026-08-13、frontend-rpc-contract（生成物） |
| [`design/`](design/) | 设计定稿与探索 | provider-system-spec、visual-language-ink-brass、mcp-acp-protocol-support、一张纸设计 |
| [`plans/`](plans/) | 仍待执行/评审的计划与实验 | 入口 [`plans/README.md`](plans/README.md) |
| [`research/`](research/) | 调研证据与决策 | 入口 [`research/README.md`](research/README.md) |
| [`archive/`](archive/) | 已竣工施工稿、历史 handoff、被取代的 plan | 入口 [`archive/README.md`](archive/README.md) |
| 散件 | 仍在使用的路线图/雷区/回归 runbook | `MULTI_AGENT_ROADMAP.md`、`landmine-map.md`、`p3-regression-runbook.md` |

## 已归档（2026-08-16 收敛）

- `docs/agents/frontend-refactor-handoff.md` → `docs/archive/frontend-refactor-handoff.md`（前端重构施工史）
- `docs/agents/p0-demining-handoff.md` / `p1-demining-handoff.md` → `docs/archive/`
- `docs/architecture-refactor-spec.md`、`docs/agent-shell-hardening.md` → `docs/archive/`
- `docs/plans/graph-id-refactor-plan.md`、`tool-convergence-browser-plan`、`browser-cdp-suite-plan` → `docs/archive/`
- `docs/code-graph-tools-gap-report.md` → `docs/research/`
- `docs/ARCH_ACTION_PLAN.md` → `docs/plans/arch-action-plan.md`
- `docs/provider-system-spec.md` → `docs/design/provider-system-spec.md`
- `docs/agents/visual-language-ink-brass.md` → `docs/design/visual-language-ink-brass.md`

## 维护规则

1. **完成即归档**：施工稿、交接稿、被取代的 plan 完成后移入 `docs/archive/`，并更新本索引与相关链接。
2. **生成物勿手改**：`docs/agents/frontend-rpc-contract.md` 由 `scripts/gen-rpc-contract-md.cjs` 生成。
3. **数字必须实测**：README / ARCHITECTURE / AGENTS / CONVENTIONS 中的用例数、方法数、语言数等，改动后要重测并标注日期。
4. **工具/RPC/领域动作变更**：同步 `tools/domains.ts` → 根规则文档 → 本索引 → 生成物。
5. 归档文件保留 commit 历史，不删除；历史文件顶部应有「已归档/被取代」说明。
