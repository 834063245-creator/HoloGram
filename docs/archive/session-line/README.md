# 会话线（session-line）— 已归档计划

> **已归档（2026-10-08 · 文档面收尾；同日陆续追加至 7 件）**——本目录收「会话」线的五份过程文档：代码均已落地，**余真机验收**。
> 判据 = CONVENTIONS §4：「**过程文档是否还活着**，不是验收跑没跑完」——真机欠账由
> [`plans/README.md`](../../plans/README.md) 欠账表承载（**本仓唯一在办真值**）。
> 现状承接：`ARCHITECTURE.md` + `INVARIANTS.md`；会话存储与归属的现行约定以代码与 `INVARIANTS.md` 为准。

| 件 | 是什么 | 现在看哪 |
|---|---|---|
| [`session-tree-plan.md`](session-tree-plan.md) | 会话树（枝）：从任意已落定节点开枝，删父卷连坐整棵子树 | 欠账表「会话树『枝』手感」五项 |
| [`session-log-erasure-plan.md`](session-log-erasure-plan.md) | 卷日志的抹除：撤回即压实，旧内容从 `.ndjson` 物理抹除 | 欠账表相关条目；设计与证据在 `session-tree-plan` §12.9/§12.10 |
| [`sidebar-two-views-plan.md`](sidebar-two-views-plan.md) | 案卷侧栏双视角（案卷 ⇄ 枝）：父卷/子卷展示重构 | 欠账表「案卷侧栏双视角」 |
| [`workspace-session-ownership-rework.md`](workspace-session-ownership-rework.md) | 会话**物理归属工作区**（`{ws}/.lantai/sessions/` 唯一存储位；焦点/绑定/全局列表全退役） | 欠账表「会话归属反转」P5 实机验收 |
| [`session-rebuild-recovery-plan.md`](session-rebuild-recovery-plan.md) | 卷重建丢卡根治：资产/拟策块自工具回执恢复 + 开卷落盘断「判陈旧 → 重建」循环（案卷 51 真机取证） | 欠账表「卷重建丢卡根治」两条真机验收 |
| [`volume-number-governance-plan.md`](volume-number-governance-plan.md) | 卷号治理 A+B：号永不复用（发号账 `_issue.json`）+ 有名卷常显号收成两处 | 欠账表「卷号治理」真机一次 |
| [`concurrent-sessions-plan.md`](concurrent-sessions-plan.md) | 并发会话（多卷同跑）：会话身份端到端贯通，拆掉 chat UI 层全部单槽假设 | 欠账表「并发会话真机五项」 |

**已收官的历史方向**（本目录之外）：`session-unify-plan.md`（被归属反转取代）· `session-ledger-plan.md`（案卷总目 L0-L3，被归属反转取代）——均在 `docs/archive/` 平级。
