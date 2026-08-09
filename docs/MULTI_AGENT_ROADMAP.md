# 多 Agent 编排推进路线图

> 最后更新：2026-08-04
> 用途：多 Agent 协调机制的持续推进工作台——目标、已落地、待推进、红线。
> 配套文档：`docs/archive/MULTI_AGENT_STATUS.md`（多 Agent 系统实现状态，Phase 1-4 通信/持久化/UI）

## 1. 目标

**10-20 个子 Agent 在同一工作区并行协作，不打架、不互相拖累。**

核心原则（2026-08-03 讨论收敛）：

> **机制替代通讯**——一切需要协调的地方（资源占用、排队、验证、状态共享）变成系统的一部分，
> Agent 只管干活，互相不需要知道对方存在。通讯（消息）只在机制失效时兜底。
>
> 类比：多 Agent 的正确形态不是"一群人协作"，是"一个系统 + 多个工人"——流水线、红绿灯、门禁
> 替工人协调一切，工人不需要互相喊话。

规模论证：冲突概率 O(N²)、主 Agent 上下文 O(N)——3 个 Agent 靠运气，20 个必须机制化。
但物理约束没变（一个仓库、一把 git）——工具箱是队列 + 租约 + 门禁 + DAG，**不是分布式系统**（共识/选举/状态机复制是过度工程）。

## 2. 已落地（2026-08-03，全部构建通过并提交）

### 2.1 资源租约层 v1 — shell 排队可观察化

| 文件 | 内容 |
|------|------|
| `src-ui/src/agent/runtime/shell-queue.ts` | FIFO 可观察队列：队列长度/位置/预计等待/头部超时保护（超预期 1.5x 提示"可能卡住"） |
| `src-ui/src/agent/runtime/cmd-class.ts` | 命令分类（read/write/heavy + wrapper 解包 `bash -c "..."` + 静态表抄 BUILD_TEST_RE / git.rs 安全清单；unknown→write 保守默认） |
| `agent-builder.ts` 流式分支 | 排队期间 3s 间隔 onProgress 反馈 + 等待 >500ms 结果前缀（模型可见） |

**验证** ✅ A1 实测：两个子 Agent 并发跑 `ping`，第二个收到 `[shell 队列] ⏱ 排队 29.8s 后执行`，排队期间持续弹反馈。

**v1 决策**：保留全串行（cargo target 锁是资源级共享，串行是安全默认），分类只影响估算。**v2 按资源类型分队列**（见 §4）。

### 2.2 wait 工具 — 事件驱动等待

`src-ui/src/agent/tools/wait.ts`：`wait({ agentId, timeoutMs })` 阻塞到子 Agent 完成（内部 500ms 轮询 pool，**不消耗 LLM 轮次**），完成立即返回最终状态+结果摘要。

- 设计演进（重要教训）：第一版是固定时长 sleep——**错**。LLM 猜秒数，猜错白等/等不够，是轮询问题的另一种形态。正确语义 = bash_wait 的"等目标完成"。
- 工具分工：等子 Agent → `wait({agentId})`；等后台任务 → `bash_wait`；无事件可等（watcher 分析/文件出现）→ `wait({durationMs})` 兜底。

### 2.3 agent_board 工具 — 黑板第一层

`src-ui/src/agent/tools/board-status.ts`：TaskBoard 对主 Agent 可见（agentId/status/filesTouched/summary/diff 截断）。

背景：主 Agent 之前无法查询 TaskBoard——`task_list` 是 TaskManager 的任务系统（自己的待办），**与 TaskBoard 无关**；主 Agent 感知子 Agent 只剩 agent_inbox result 消息 + agent_status（pool 运行状态）。board 上的文件/diff 是黑盒。

### 2.4 Merge 门禁 v1 — merge-then-verify，信息报告模式

| 文件 | 内容 |
|------|------|
| `src-ui/src/agent/tools/merge-gate.ts` | runGraphGate（轮询 hologram_run_check 直到非 quiet，60s 超时视为未验证）+ runCompileTest（默认关） |
| `merge.ts` 循环 | touch 顺延 TTL → 可选编译测试 → merge → 图检查 → 通过 markMerged / 失败 board.fail + 报告（**改动保留**） |
| `task-board.ts` | `touch(agentId)` 顺延 30min TTL（防门禁中途被巡检误杀） |

**2026-08-04 优化（5-Agent 实测暴露）**：merge 门禁从"逐条图检查"改为"批量统一一次"——原实现每个子 Agent 串行跑一次 `runGraphGate`（整图分析 + 最长 60s 轮询），5 个 Agent = 5 次全图扫描，秒级任务被放大成分钟级。`runGraphGate` 本身只依赖 projectPath/exec（不依赖单个 entry），统一一次即可覆盖全部已 merge 变更：5× 全图 → 1×。门禁语义不变（信息报告，失败只标记不回滚）。

**关键设计决策（2026-08-03 修正）**：
- **门禁定位 = 信息报告，不是裁决**。L5 红线（blast radius / 跨社区边 / L4 穿透）是启发式，**噪音可能很大**（正常重构碰高扇入模块就可能误报）。自动回滚（git reset --hard）会误伤正常改动 = 子 Agent 白做。故失败只标记 + 报告，主 Agent 决定修复 / git revert / 接受。**误报的代价从"白做"降为"零"。**
- 时序：worktree 变更对引擎图不可见（watcher 忽略 `.hologram`）→ 必须 merge-then-verify（先 cherry-pick → watcher 增量分析 → 图检查）。
- 触发语义：红线按"破坏性"判定（高扇入修改/新 L4 穿透/API 变更），**不是路径黑名单**——孤立新文件（如 `migrations/x.py`）零依赖零扇入 → blast radius 0 → 合理放行。若需路径级拦截，用 constraints.yaml 的 denylist（引擎已有）。

### 2.5 隔离层修复（验证暴露的真实 bug）

| 修复 | 内容 | 验证 |
|------|------|------|
| untracked 文件误判无变更 | `git diff HEAD` 不显示新文件 → cleanup()/merge_to_main 误判"无变更"→ 删 worktree / 假阳性合并。新增 `diff_readonly()`（含 `ls-files --others`，永不删除）+ merge_to_main 变更检测修复 | ✅ B1 实测 gate_test.ts 真落地主仓（原 commit 引用已失效，git 历史 rewrite 后不存在；文件本身也已确认无残留） |
| verbatim 前缀误判 | canonicalize 返回 `\\?\` 前缀，与无前缀路径比较失败 → sandbox.rs 新增 `logical_path()` 统一比较 | ✅ 单测覆盖 |
| worktree 双前缀 | 前端 isolationId 已带 `agent-`，Rust slug 又拼一次 → `agent-agent-xxx`，去重 | ✅ 单测覆盖 |

### 2.6 提交记录

```
e6506fe fix(agent): wait 工具改为事件驱动
b65c3ec feat(agent): agent_board 工具 — TaskBoard 对主 Agent 可见
ea44dd7 feat(agent): 资源租约层 + wait 工具 + merge 门禁信息报告化
23c84da fix(isolation): untracked 文件误判无变更 + verbatim 前缀误判 + worktree 双前缀
7e2cc50 docs: ARCHITECTURE.md 对齐 v9.4.4
```

## 3. 待推进（近期，按序）

- [x] **`cargo tauri build`** —— 让上述修复进入实际应用（Rust 改动已 commit 并重新构建）
- [x] **wait 工具实测**：spawn 异步子 Agent 跑长任务 → 主 Agent 调 `wait({agentId})` → 应完成即返回
- [x] **agent_board 实测**：子 Agent 完成后调 `agent_board` → 应看到 status/filesTouched/diff
- [x] **5-Agent 真实运行**（验收点，红灯指标见 §6）
- ❌ **门禁"真违规"场景**（可选，2026-08-04 决定不做）——启发式红线噪音大、收益低，不主动注入违规
- [x] **清理测试残留**：验证项目里的 `migrations/`、`gate_test.ts` 等测试文件 — 2026-08-04 复查确认：`gate_test.ts` 与 `migrations/` 均不在工作区及 git 历史，worktree 无残留，`engine/fixtures/` 为正常测试夹具，无需清理

> **2026-08-04 状态**：§3 全部完成（含 1 项决定不做）。当前并发档位 5（`coordinator.ts` 默认 `DEFAULT_MAX_CONCURRENT = 5`），5-Agent 验收无红灯、排队未成瓶颈——§4 各项按规模触发、不提前支付，等待触发信号到来。

## 4. 未来阶段（按 N 增长触发，不提前支付）

| N 规模 | 触发信号 | 要建的东西 |
|--------|---------|-----------|
| 5-8 | 排队成瓶颈 | **租约层 v2**：按资源类型分队列（cmd-class 分类表已备好；只读命令可并行，写/重型串行；unknown 必须串行） |
| 8-15 | 主 Agent 上下文爆 | **任务 DAG + 调度器**：显式任务依赖（B 需要 A 的输出），只并行无依赖子任务；图引擎辅助拆解（任务依赖图 = 代码依赖图同构） |
| 15-20 | 通信量失控 | **层级编排 + 可观测性**：谁在等什么、为什么等（一行日志级起步） |
| 随时 | 静态表不够 | **命令清单动态化**：`git help -a` / `cargo --list` / shell 补全文件解析（zsh/fish），替换静态 50 条 |
| 随时 | 门禁误报多 | **门禁噪音治理**：L5 启发式分级报告、per-rule 配置（哪些红线报告/哪些忽略） |

## 5. 过度工程红线（明确不做）

- ❌ 死锁检测（租约 TTL 先扛，没死过不预防医学）
- ❌ 优先级/饥饿调度（等真遇到）
- ❌ 完整黑板系统（TaskBoard 加字段就够）
- ❌ 跨进程互斥（Claude Code/Cursor 的进程，管不了也不该管）
- ❌ 分布式系统工具箱（共识/选举/状态机复制——单仓库单 git 用不上）

## 6. 5-Agent 验收清单（红灯指标）

运行 5 个并行异步子 Agent（各改不重叠文件），结束后统一 agent_merge：

- [x] 每个子 Agent 的 shell 调用有队列反馈（无静默等待）
- [x] 并发 shell 无 listener 互杀（无 600s 超时卡死）
- [x] agent_merge 单次完成全部 5 个（门禁+merge 总耗时 <3min）
- [x] 图检查报告逐条列出（changed_files 数与 board filesTouched 一致性）
- [x] 全部 merged，无泄漏告警（lifecycle-manager 无 warn Notice）
- ❌ 故意注入 1 个违规文件（migrations/*.py）—— 对应 §3 门禁真违规场景，决定不做
- [x] 红灯判定：任一子 Agent 等待 >60s 无反馈 / merge 被误伤 / 报告误报 — **无红灯**

## 7. 已知坑与教训（验证中发现的，防再踩）

1. **git diff HEAD 不显示 untracked 文件**——凡"变更检测"必须加 `git ls-files --others --exclude-standard`。已踩两次（diff 提取 + merge 检测），INVARIANTS 候选。
2. **Windows canonicalize 返回 `\\?\` 前缀**——路径比较前必须统一（sandbox.rs `logical_path()`）。
3. **wait 工具不许做成固定 sleep**——事件驱动是唯一正确语义（bash_wait 模式）。
4. **门禁不许自动回滚**——启发式红线有噪音，误报时回滚的代价是白做、标记的代价是零。
5. **子 Agent 禁构建命令**（agent.ts BUILD_TEST_RE）——验证归门禁/主 Agent，子 Agent 只改文件。
6. **30min worktree TTL**——任何跨时间的处理（门禁、等待）必须 touch() 顺延。
7. **`task_list` ≠ TaskBoard**——一个是 TaskManager 自己的待办，一个是子 Agent 共享板，别混。
