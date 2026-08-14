# DeepSeek V4 Pro × 极简模式 能力验证实验计划

> 状态：Draft（未执行）
> 目标环境：Linux（物理机 / 云主机 / WSL2；**不可用 Windows 本机**）
> 关联文档：`browser-cdp-suite-review-round2.md`（同目录）、
> `D:\useful\deepseek-harness` 的 minimal preset 相关 Agent Notes

## 0. 背景与假设

仓库证据表明 `deepseek-harness` 的 `minimal`（极简模式）是
**Claude SWE-compatible RL agent 的基准 runtime**：

- 固定 persona：`You are a helpful software engineer assistant.`
- 动作空间锁死为 `bash` + `str_replace_editor`
- 持久 bash：cwd / 环境变量 / 进程状态跨调用保留
- `includeRuntimeContext: false` + `complete: true`：清除一切运行时上下文注入
- 不挂 compaction：保证 rollout 轨迹逐 token 可回放
- Python SDK / JSON-RPC 入口：批量 rollout worker 形态

坊间说法：「**DeepSeek V4 Pro 只有搭配极简模式才能发挥完整能力**」。

机制解释：V4 Pro（可能）是在上述 observation/action 分布上做过 RL 的编码模型。
推理时如果 prompt、工具集、工具描述、上下文注入与训练分布不一致，策略会发生
distribution shift。因此该说法等价于：

> H1：在 SWE 式编码任务上，`minimal` preset 的任务解决率显著高于 `standard` preset。
> H2：`minimal` 的工具调用效率更高（更少无效调用 / 更少轮次 / 更少 token）。
> H3：`standard` 的性能损失主要来自 prompt/tool 分布漂移，而非工具数量本身（可选验证）。

## 1. 成功标准

| 指标 | 判定 |
|---|---|
| 主指标：Resolved@1 | minimal 相对 standard 提升 ≥ 10 个百分点，且 McNemar p < 0.05 |
| 次指标：有效工具调用率 | minimal 显著高于 standard |
| 次指标：成本 | minimal 每任务平均 token/cost 显著低于 standard（或差距可解释） |
| 质量门禁 | 每组 ≥ 30 个配对任务；环境、模型、超参、验收脚本完全一致 |

若 H1 不成立，结论同样有价值：说明「极简模式最强」在当前 V4 Pro 权重上不成立
或需要更严格的任务域。

## 2. 环境（必须 Linux）

| 项 | 要求 |
|---|---|
| 机器 | Ubuntu 22.04 / 24.04，或等价的 Linux 容器 |
| 隔离 | 每个 run 使用全新容器 / 全新 workspace 克隆 |
| 运行时 | Node 22 LTS + pnpm；Python 3.12（任务依赖按任务要求） |
| harness | `deepseek-harness` 固定 commit（记录 commit hash） |
| 模型 | DeepSeek V4 Pro（记录 API endpoint + 模型 id） |
| 权限 | 自动化运行设置 `DSH_PERMISSION_MODE=danger-full-access`（避免 Ask 卡死；两个 arm 相同） |
| 网络 | 能访问 DeepSeek API；pip / npm 镜像可用 |

## 3. 实验臂

| 臂 | Preset | 关键差异 |
|---|---|---|
| A | `minimal` | 2 tools、持久 bash、固定 prompt、无 context 注入、无 compaction |
| B | `standard` | 完整工具链、普通 bash、完整 persona 与 context、有 compaction |
| C（可选） | `code` | standard + TypeScript code mode，验证工具呈现方式的影响 |

Pilot 先跑 A/B；只有 H1 显著时才考虑 C。

## 4. 任务集

### 4.1 任务域

优先使用**私有 / 自建任务**，避免公开 benchmark 的污染问题：

- 私有仓库中的真实 bug（每个任务有明确失败测试和接受标准）；
- 由成员按模板新造的 synthetic tasks（改 bug / 加功能 / 补测试）；
- 禁止直接使用 SWE-bench 公共实例作为主证据（可作为补充参考）。

### 4.2 任务模板

每个任务目录必须包含：

```text
task-<id>/
  README.md        # 任务目标，用自然语言描述
  repo/            # 基线仓库（或 git bundle）
  setup.sh         # 安装依赖
  verify.sh        # 验收：退出码 0 = resolved
  config.json      # timeout、max_turns、max_tokens
```

要求：

- verify.sh 必须可重复、无副作用、不依赖网络；
- 任务目标只描述「做什么」，不包含答案或代码片段；
- 难度分层：P1 简单文件编辑、P2 跨文件逻辑、P3 需要调试/运行测试。

### 4.3 数量

| 阶段 | 数量 | 用途 |
|---|---|---|
| Pilot | 8 个配对任务 × A/B | 验证 runner、采集方差、估算成本 |
| Full | 30-50 个配对任务 × A/B | 主实验 |
| 补充 | 20 个公开 SWE 实例 × A/B | 与社区结果对齐（可选，标注污染风险） |

## 5. Runner 协议

### 5.1 每轮任务

1. 从 base commit 克隆 / reset 任务 workspace；
2. 运行 `setup.sh`；
3. 新建空白 session；
4. 通过 Web API 选择 preset：
   - `agentPreset.list` 确认 roster；
   - `agentPreset.select` 指定 `minimal` 或 `standard`；
5. 发送统一任务 prompt；
6. 循环至结束 / 达到 `max_turns` / `max_tokens` / 超时；
7. 运行 `verify.sh` 记录 resolved；
8. 保存 session JSONL、prompt、tool calls、最终 diff、token/cost。

### 5.2 一致性要求

- 同一任务 A/B 两臂使用**相同任务 prompt**、相同 workspace 初始状态；
- 温度、top_p、max_tokens、context window 显式固定并记录；
- 每臂独立 session，不共享任何历史；
- runner 启动前校验工具目录：
  - A 必须恰为 `bash` + `str_replace_editor`；
  - B 记录完整工具清单。

### 5.3 超时与预算

| 参数 | 建议值 |
|---|---|
| 每任务墙钟上限 | 30 min |
| max_turns | 50 |
| 上下文 | 模型默认 / 记录 |
| 每任务 API 预算 | 记录，用于成本分析 |

## 6. 数据采集

每个 run 输出：

```text
results/
  <task-id>/<arm>/
    session.ndjson
    prompt.txt
    tool-calls.jsonl
    final-message.md
    diff.patch
    metrics.json
```

`metrics.json` 至少包含：

```json
{
  "task": "task-001",
  "arm": "minimal",
  "resolved": true,
  "turns": 12,
  "input_tokens": 0,
  "output_tokens": 0,
  "tool_calls": 18,
  "invalid_tool_calls": 0,
  "verify_duration_sec": 3.2,
  "wall_seconds": 900,
  "cost_usd": 0.0,
  "model": "deepseek-v4-pro",
  "harness_commit": "..."
}
```

## 7. 分析

1. **主分析**：paired McNemar test on resolved（同任务 A/B）。
2. **效率分析**：paired t-test / Wilcoxon on turns、tokens、cost。
3. **工具行为分析**：
   - 无效 / 重试调用比例；
   - bash 与 editor 的调用分布；
   - standard 是否出现工具选择困难（工具名错误、无关工具调用）。
4. **轨迹定性抽检**：每臂抽 5 条轨迹人工 review，判断失败原因类别
   （定位失败 / 工具使用失败 / 预算耗尽 / 策略错误）。
5. 输出置信区间和 effect size；报告可复现所需全部配置。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 公开任务污染 | 主证据用私有任务 |
| 模型随机性 | 温度固定；pilot 测方差，必要时每臂重复 2 次取平均 |
| standard 会 compaction | 不禁止；这是 arm 的真实组成部分，记录触发情况 |
| Ask 卡死 | `danger-full-access`；若改 ask，需记录并排除卡死任务 |
| API 波动 | 失败任务允许重试 1 次，并在数据中标记 |
| 成本 | pilot 先测单任务成本再放大 |

## 9. 交付物

1. `results/` 原始数据
2. `analysis.ipynb` / 脚本（可复现统计）
3. `REPORT.md`：
   - H1/H2 是否成立；
   - 对「V4 Pro 必须搭配极简模式」说法的最终结论；
   - 对 Windows / pwsh / minimal-win 路线的产品建议；
   - 与 CDP 修复文档联动：明确哪些能力应作为 minimal 的后续增量而不破坏训练分布。

## 10. 执行前 checklist

- [ ] Linux 机器可用，dsh 在目标 commit 可启动
- [ ] V4 Pro API 可用，模型 id / 上下文窗口确认
- [ ] 8 个 pilot 任务就绪并通过人工基线
- [ ] runner 能自动完成 preset 选择与 verify
- [ ] session 日志完整落盘
- [ ] 记录 harness commit、模型 id、超参与环境
