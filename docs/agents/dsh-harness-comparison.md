# DSH Harness × HoloGram Agent 横向对比与收口记录

> 生成：2026-08-15 · 分支：`feat/agent-gap-closure`
> 来源：对 `/home/jingjianhua/deepseek-harness` 的多 Agent 编排架构的完整盘点（subagent / workflow / goal / jobs / sandbox / session 六个子系统），与本仓库 Agent 运行时的逐项对比。

## 1. 一句话结论

HoloGram 的 Agent 在「单仓库多工人协同」垂直场景比 DSH 更深（git worktree 隔离、资源租约队列、merge 门禁、黑板/消息箱、记忆分级都是 DSH 没有的）；DSH 是一套通用编排平台，其强项在子 Agent 生命周期（可续聊/冷恢复）、编排原语（workflow/ralph）、Goal 严谨性（事件溯源 + CAS）与委派权限固化。本次收口把其中可移植、成本可控的部分全部落地，共 **6 项**。

## 2. 对比总览（维度 × 强弱）

| 维度 | DSH | HoloGram | 结论 |
|---|---|---|---|
| 子 Agent 后端 | 多 provider（进程内 spawn/fork、ACP、Codex app-server、Claude Code SDK、DSH SDK） | 仅进程内 fork/fresh；ACP 是服务端 | DSH 强；HoloGram 路线图红线明确不做 |
| 子 Agent 能力控制 | outputSchema / maxDepth / toolFilter / persona，能力不足派发前拒绝 | 本次补 output_schema + 深度守卫全模式化 | 已收口（P1-4 / P0-3） |
| 子 Agent 续接 | durable 可续子会话（send_message/interrupt/list_agents/冷恢复） | 消息箱 + wait；完成后不可续聊 | **未落地**（见 §4 P0-2） |
| 隔离生命周期 | 沙箱模式隔离，共享 workspace | git worktree + merge 门禁 + TTL | HoloGram 强；重启孤儿已收口（P0-1） |
| 编排原语 | workflow（模型写编排脚本）+ ralph（固定脚本迭代） | coordinator 固定并发池 + 租约队列，主 Agent 手动编排 | **未落地**（见 §4 P1-5） |
| Goal | 事件溯源 + revision CAS + blocked(机器可读 code) + 人类权威区分 | 文件型 + stall 检测 + adoptOrphans；本次补 blocked + 权威注释 | 已收口（P1-6） |
| 大输出 | spill 落盘 + locator | 原本 32KB 截断/500 字符裁剪 | 已收口（P2-7） |
| 委派权限 | 子级 approval 钉 never + 沙箱范围固化 + 不可扩权声明 | permissions.json 静态规则；本次剥离 ask_user / plan 工具 + 边界提示词 | 已收口（P2-10） |
| 循环守卫 | guard（无效模式 + per-call 预算） | storm breaker（同错 3 连发强制换策略） | 大部分已覆盖；per-call 预算未做 |
| 后台任务 | 通用 JobRegistry（stream/final 输出、job_output/kill/list） | shell 队列 + bash_wait + wait 工具 | **未落地**（见 §4 P2-8） |
| 记忆 | 无独立记忆包 | 置信度分级 + /remember 授权 + AuraSDK 语义检索 | HoloGram 强 |
| 黑板/消息 | 无 free-form 黑板 | TaskBoard/DiscoveryBoard/agent_message/topology | HoloGram 强 |

## 3. 本次落地清单（6 项，均验证后提交）

| Commit | 项 | 内容 |
|---|---|---|
| `94618f8` | P0-3 深度上限 | `AgentConfig.subagentDepth` 曾被 runtime 丢弃、`listAgents()` 恒报 0、守卫只拦 fork；现在 fork/fresh 统一守卫 + 只读 getter 真实深度 |
| `f136e36` | P0-1 worktree 孤儿收养 | Rust `workspace_activate` 扫描 `.hologram/worktrees/` 重建隔离注册表（`adopt_worktree` 用 `merge-base --is-ancestor` 回溯诞生基——worktree 与主仓共享对象库，`cat-file -e` 会把不可达孤儿 commit 误当基）；前端根 Agent 绑定会话时重挂旧父 id 条目 + 注册磁盘孤儿为可合并条目；running 孤儿改「先保全 diff 再保留现场」 |
| `6fcb5f0` | P1-4 output_schema | `agent_spawn` 支持 object-rooted JSON Schema 结构化返回（DSH 同款子集：type/properties/required/additionalProperties/items/enum/const/oneOf），不支持的 schema 派发前拒绝、校验失败原文带回不静默、异步组合明确拒绝 |
| `bde599f` | P1-6 Goal blocked | `goal_report(status="blocked", summary=强制原因)`，blocked 是可恢复态（占单目标槽、`/goal resume` 继续）；生命周期动作只由人类 /goal 命令进入（权威分离以注释固化） |
| `929a76e` | P2-7 spill 溢写 | 大 diff（>8KB）由 Rust 侧落盘 `.hologram/spill/` 回传 locator（落盘失败退回截断并标记）；`agent_board`/merge 冲突保全展示 locator 而非截断体 |
| `df6d828` | P2-10 委派不可扩权 | 子 Agent 工具集剥离 `ask_user`（子 Agent 不得直连人类）与 `enter/exit_plan_mode`（闭包绑定父 planState——调用即翻父模式）；剥离面抽成纯函数 `buildSubAgentTools` 可测；子 Agent 系统提示追加委派边界段 |

## 4. 未落地项与理由（按需再开）

- **P0-2 子 Agent 可续聊**（DSH continuable children）：需要 durable 子会话 + activation 管理 + 冷恢复，是 DSH 最深的子系统。HoloGram 已有 `agent-session-state.ts` 底子，但完整落地需新开窗口。
- **P1-5 模型可编程编排**（workflow/ralph）：与 HoloGram「机制替代通讯」哲学存在路线取舍；其自身路线图 §4 的「任务 DAG + 调度器」在 N=8-15 才触发。DSH 的 pipeline/parallel 原语可作为届时参照。
- **P2-8 通用 job 抽象**：现有 shell 租约队列 + bash_wait 已覆盖当前规模；通用 JobRegistry 收益要等后台任务种类变多。
- **guard 的 per-call 预算**：storm breaker 已覆盖「无效重复模式」；token/时长预算改动 executor 热路径，风险收益不划算。
- **外部 Agent provider**（Claude Code/Codex/ACP 后端）：路线图 §5 明确红线，尊重不碰。

## 5. 验证记录

- 前端：`npx tsc --noEmit` + `npm run build` 每项通过；新增单测 22 个（schema-validate 11 / spill 5 / 工具剥离 3 / goal blocked 1 / 收养 Rust 2 + spill Rust 1），全部通过；既有 spawn/goal/board 回归套件绿。
- Rust：并发会话在同一工作区开发 CDP，故 Rust 验证在独立 git worktree（HEAD 干净树 + 我的改动 + 软链 `src-ui/dist` 与 `grammars/`）中执行 `cargo build` + `cargo test`，与并发 WIP 零干扰。`test_forward_map_worktree` 在 Linux 上失败为既有问题（`D:/` 路径是 Windows 语义，HEAD 原版同样失败）。
- 打包链：`engine cargo build` + `cargo tauri build` 见收口窗口记录。

## 6. 注意事项（分支卫生）

- 收口窗口期间另一个 Agent 会话在同一工作区并行开发 Browser CDP/web 套件，其提交（`f3ed688`、`4ea88eb`、`5515416`、`8a2837d`）混入本分支（共享工作区只认当前 checkout 的分支）。本分支回主仓时建议按需 cherry-pick 本表 6 个 commit，或整体评估后合并。
- 本次所有提交只 `git add` 各自文件，未触碰并发会话的任何改动；合并冲突请以各自 commit 边界为准。
