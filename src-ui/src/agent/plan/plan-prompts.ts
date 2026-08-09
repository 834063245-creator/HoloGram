// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Plan 模式提醒文本 — 分层提醒，适配 HoloGram 的图引擎能力

function withPlanFileFooter(body: string, planFilePath: string | null): string {
  if (!planFilePath) return body;
  return `${body}\n\n计划文件路径: ${planFilePath}`;
}

/** 首次进入 / 每 5 轮刷新 — 完整工作流提醒 */
export function PLAN_FULL_REMINDER(planFilePath: string | null): string {
  return withPlanFileFooter(`## 规划模式已激活

你只有只读权限 + 写计划文件的权限。写文件、跑命令、Git 操作会在执行层被拦截（[已拦截]），不要尝试。

### 工作流程
1. **探索** — 用 fs(read/list/glob) / search(content) / explore_deps / trace_impact / fragile_modules 充分理解代码
2. **设计** — 确定最佳方案，考虑权衡
3. **写计划** — 用 fs 的 write 动作写到计划文件
4. **提交** — 调 exit_plan_mode 提交计划给用户审批

### 计划要求
- 列出具体步骤，引用真实文件名和函数名
- 包含「影响面分析」部分 — 图引擎会自动注入辅助数据
- 如有多方案（最多 3 个），用 exit_plan_mode 的 options 参数列出
- 不要用 ask_user 问「计划行不行」— 那是 exit_plan_mode 的事

### 图引擎辅助
- 读文件时自动显示该文件的下游依赖和脆弱度
- 写计划文件时自动追加影响面分析
- 主动调 trace_impact / explore_deps / fragile_modules 查依赖关系

### 结束条件
每轮必须以 exit_plan_mode（提交计划）或 ask_user（澄清需求）结束。`, planFilePath);
}

/** 2-4 轮后 — 稀疏提醒，避免刷屏 */
export function PLAN_SPARSE_REMINDER(planFilePath: string | null): string {
  return withPlanFileFooter(`## 规划模式
只读探索中。写好计划后调 exit_plan_mode 提交。`, planFilePath);
}

/** 恢复进入（计划已有内容，如会话恢复） */
export function PLAN_REENTRY_REMINDER(planFilePath: string | null): string {
  return withPlanFileFooter(`## 规划模式已恢复
计划文件已有内容。检查并修改后调 exit_plan_mode 提交。`, planFilePath);
}

/** plan 模式退出后的一次性提醒 */
export const PLAN_EXIT_REMINDER = `## 规划模式已退出
所有工具恢复可用。按批准的计划执行。审批通过后 preflight hook 会对每个文件变更自动做影响检查。`;
