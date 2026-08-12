# 平台缺陷登记（2026-08-13 发现，待修）

> 来源：第三批任务执行期（11b 重切 / 14 any 清理 / 11c 拆分 agent.ts）。
> 性质：HoloGram 平台自身缺陷——发现者（编码 Agent）同时跑在 HoloGram 内、工作在 HoloGram 源码工作区，
> 因此这些缺陷既是平台运行时问题，也是平台源码的可修 bug。
> 目标读者：接手修复的 Agent 窗口。每条含现象、证据、影响、修复方向。

---

## A. 子 Agent 执行与合并链路

### A1. 合并结果报告混淆"动作"与"产物状态"

**现象**：2026-08-13 并行派发两个 fork 子 Agent（任务 11c 拆 agent.ts、任务 14 清 any），
两条返回报告与事实恰好对调：

- 14 报 `⚠️ 自动合并失败: failed to delete worktree: Directory not empty；diff 获取失败`，
  但其 **36 个文件的改动实际全部已进主仓**（commit `54ef41c7` "Agent worktree changes"）。
- 11c 报 `✅ 变更已自动合并回主仓`，但工作区**零改动**（agent.ts 原封未动、无任何新文件）。

**结论**：报告反映的是"合并动作执行了吗"，不是"产物在主仓吗"。
清理失败被上抛成"合并失败"；空 worktree 的合并（子 Agent 无产出）被报成"成功"。
失败路径连 diff 恢复材料都不给（"diff 获取失败"）。

**证据**：
- `git log`: `54ef41c7` "Agent worktree changes"（14 的产物，含 36 文件）
- 11c 返回体无任务报告（见 A2），工作区 `src/agent/agent.ts` 与派发前逐字节一致

**修复方向**：
1. 合并成功后校验产物：worktree diff 非空 → 才可报"合并成功"；为空 → 报"无产物"。
2. 清理失败与合并失败分离报告（清理失败 = 产物已在主仓，给 commit hash）。
3. 失败路径必须落盘 diff（不要出现"diff 获取失败"）。
4. 合并消息附产物摘要（文件数、行数、commit hash），父 Agent 无需追问即可核验。

### A2. 子 Agent 无产出时报告缺失、疑似提前终止

**现象**：11c 子 Agent 的返回体只有一行"(思考完成)"+ 系统合并消息，**没有任务报告**；
对比 14 有完整的文件级清单。无法区分"没干活"与"干了被丢"。

**修复方向**：
1. 子 Agent 正常完成必须携带报告字段（产物清单/结论），缺失时 spawn 结果标记 `incomplete`/`failed` 而非完成。
2. 异常终止（超时/上下文异常）显式标记，不能走"空合并报成功"路径。
3. spawn→执行→报告全生命周期落日志，供事后归因。

### A3. fork worktree 并发清理互相踩踏（磁盘紧张放大）

**现象**：14 的 worktree 清理报 `failed to delete ... Directory not empty`；当时两个 fork
并行创建/合并/清理，且 D 盘 98% 满（可用仅 9.5GB，见 C1）。git 在满盘时部分写入失败被静默吞掉。

**修复方向**：
1. worktree 清理失败重试（带延时），或清理改用尽力而为 + 异步回收。
2. worktree 创建/合并前做磁盘空间预检（见 C1）。
3. 并发 fork 的 merge/清理串行化（全局锁），避免目录级踩踏。

### A4. 合并后子 Agent 从通信拓扑消失，父 Agent 无法追问

**现象**：子 Agent 完成后 `agent(list)` 返回 `no communicable agents`，
对"报成功但无产物"的情况无从追问复核。

**说明**：完成后退出拓扑是设计行为，但 A1/A2 存在时，父 Agent 需要替代机制——
A1 的"产物摘要 + 产物校验"即为此目的。若 A1 修复后仍保留本条目，可考虑
合并消息内附一段子 Agent 报告的原文摘要。

---

## B. 工具层

### B1. fs(edit) 并发编辑同文件静默丢写

**现象**（两处独立目击）：
1. 主 Agent：同一批并行发 3 个 fs(edit)（`resolve.rs` 两处 + `graph.rs` 一处），
   其中 `resolve.rs` 的 1 个编辑**返回成功但未落盘**（编译报错后回读发现，
   单独重放同一编辑才生效）。
2. 任务 14 子 Agent 报告原文："本环境 edit 工具在多编辑同文件时偶发静默丢写，
   我已逐处回读复核并重放。"

**影响**：返回成功 ≠ 写盘成功，后续编译报"未改"类错误极易误判为自己改错。

**根因（2026-08-13 定位，源码级）**：`src-tauri/src/commands/editor.rs` 的
`edit_file` **原生内置乐观并发检查（OCC）**，但 check-then-write 无锁，存在
TOCTOU 窗口：

```
read_text → 本地替换 → 写前重读磁盘
  ├─ current != content → 拒绝："文件在编辑过程中被并发修改，请重试"
  │   （:72-78 容错路径、:126-132 主路径）
  └─ current == content → write_atomic（utils.rs:342，tmp+rename）
```

- **能拦住**：错开到达的并发写（A 写完后 B 才到检查点 → 正确拒绝报错）。
- **拦不住**：真并发交错（A 检查通过 → B 也通过 → A 写 → B 覆盖 → 双双返回
  成功，先写者改动静默丢失）——"静默丢写"即此窗口。
- **次要弱点**：检查用 `if let Ok(current)`，读磁盘失败时检查被静默跳过，
  降级为无保护直接写；`write_atomic` 的 tmp+rename（带进程内唯一 seq）只保证
  单次写原子性，不管多写者语义（最后写者赢）。

**修复方向（2026-08-13 设计结论）**：整文件相等检查是错误机制，应删除。
编辑的冲突条件只有一个：old_string 在当前磁盘内容里是否仍存在。
正确设计 = per-file 写锁把"读最新内容 → old_string 匹配 → 应用"原子化：

```
锁内：content = read()
     old_string 在 content 里？
       在 → 应用，成功
       不在 → 报 not found（现有语义，天然正确）
```

- 非重叠区域的并发编辑全部成功（自然组合，git merge 同语义）
- 重叠编辑的后者报 not found（其 old_string 确已失效，Agent 重读重试）
- 外部编辑器（用户 VSCode）改动同样被覆盖：匹配成功 = 目标区域未被动过，
  无需区分改动来源
- 零静默丢失；锁内不再需要任何整文件相等检查

**测试现状（2026-08-13 查证）**：editor.rs 有测试模块但 8 个测试全针对
`build_line_diff` 渲染，写入路径/并发行为零覆盖。仓库已有同类问题的
**现成先例可直接抄**：`src-tauri/src/credential.rs` 的 `CRED_WRITE_LOCK`
（`OnceLock<Mutex<()>>` 进程级写锁，串行化读-改-写）+ 测试
`test_concurrent_stores_do_not_lose_keys`（8 线程并发写、断言零丢失）。
修复 edit_file 时按该模式加 per-file 写锁 + 并发回归测试即可。

### B2. git rename/mv 半拉子（上批任务 12 遗留）

**现象**：任务 12 执行 `git mv file-viewer.ts → file-viewer.tsx`，实际只有
create `.tsx` 进了 commit（`3ebfec7`），**delete `.ts` 从未进任何 commit**。
HEAD 一直携带旧 `.ts` 文件（其中 import 已删除的 marked/dompurify），
直到 2026-08-13 修 14 遗留时才被发现并补删（commit `0feb956`）。
中途 tsc 报 "Cannot find module 'marked'" 的根因即此。

**修复方向**：
1. 排查 git 工具的 rename/mv 路径是否完整执行了 delete+add（还是只 add 新路径）。
2. 至少文档化纪律：git mv 后必须 git status 确认 `RM` 状态（rename 已登记）。

---

## C. 环境

### C1. 磁盘水位无预检（两批连续踩坑）

**现象**：D 盘 377G 用至 368G（98%），可用仅 9.5GB。cargo 增量编译持续占盘
（`engine/target/debug/incremental` 554M、`src-tauri/target/debug/incremental` 1.4G，
上批已清过 ~9.5GB 又长回来）。满盘时 worktree 的 git 操作部分失败且错误被吞
（A3 的直接诱因）。

**修复方向**：
1. 平台层：worktree 创建 / cargo 构建前磁盘预检，可用空间低于阈值（如 5GB）拒绝执行并提示。
2. 环境层（用户可做）：cargo target 移出 D 盘或扩容分区；
   Agent 会话启动时水位 >95% 主动告警。

---

## 附：修复完成前，父 Agent 侧的临时验收纪律（非平台 bug，是操作规范）

子 Agent 返回后**不看报告文字**，直接核验产物：
1. `git log` 是否出现新的 "Agent worktree changes" commit；
2. 预期文件是否存在于主仓工作区；
3. 预期符号/结构是否可检索到（search 工具）。

三条任一不满足 → 视为子 Agent 未产出，按失败处理（重做或亲自做），不要被"合并成功"字样误导。
