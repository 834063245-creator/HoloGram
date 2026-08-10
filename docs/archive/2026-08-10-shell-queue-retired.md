# 2026-08-10 shell 排队设计退役记录

> 状态：已退役 · 对应提交：dfe44a3（误报修复）+ 队列删除提交

## 发生了什么

前端全局 shell 队列（`shell-queue.ts` 双车道调度 + `queued-shell.ts` 排队反馈）整体删除，
多 Agent 构建锁互斥下沉到 Rust 侧 BuildLock（`src-tauri/src/utils.rs`）。

## 为什么退役

1. **误报**：排队时长统计把执行时间计入（`waitMs = 入队→完成`），单 Agent 会话任何
   跑 >0.5s 的命令都被标注"排队 Xs 后执行"——"永远在排队"的假象。
2. **性质缺陷**：串行队列的阻塞面是"时间线"而非"资源交集"。防 1 个死锁点（两个
   cargo 抢 target/）制造 N 个阻塞点（所有 shell 与不相干命令互等）。锁/隔离才是
   正确粒度：冲突只发生在同一把锁上。
3. **管不住队列外进程**：用户手动命令、后台任务、引擎自身进程全在队列外——应用层
   队列是残缺的锁，正确互斥在 OS 层（cargo/npm/git 自带文件锁）。

## 替代方案（BuildLock）

- 资源级锁表：`(cwd, lock_name)` → 持有者（job_id/cmd/owner/started_at）
- 原子检查+注册：Tauri 单进程 + Mutex 临界区，无 TOCTOU
- 锁生命周期 = job 生命周期（`remove_job` 统一释放）
- **打回而非排队**：冲突返回带路径错误（重试 / bash_wait 等待 / 不提供 kill），
  决策权给 LLM；OS 文件锁兜底竞态外冲突
- `bash_kill` 加所有权边界：Agent 只能 kill 自己发起的 job（用户任务/其他 Agent
  任务拒绝），杜绝"无故 kill 别人的 shell"

## 已知局限（接受）

- 用户手动命令不注册 ledger → 锁表不可见 → OS 锁兜底
- cargo workspace root（子目录跑、target 在根）按 cwd 判定可能漏判
- 模型重试依赖 LLM 行为——最坏退回 OS 等锁（与退役前一致，不会更差）

## 遗留

- 前端 `queued-shell.ts` 保留为纯流式执行器（取消语义 + 600s 兜底）
- `cmd-class.ts` / `shell-queue.test.ts` 随队列一并删除
