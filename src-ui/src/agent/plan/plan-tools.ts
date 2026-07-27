// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Plan 模式工具 — enter_plan_mode + exit_plan_mode
//
// 两个工具都声明 readOnly: true，确保在任何模式下都存活。
// exit_plan_mode 通过 EventSink 发 PlanReview 事件到聊天流，
// 由 chat-stream 创建 PlanPart 卡片（不是弹窗），用户在卡片上审批。

import { rpc } from '../../bridge';
import type { EventSink } from '../agent-types';
import { EventKind } from '../agent-types';
import type { Tool } from '../tool';
import type { PlanStateManager } from './plan-state';

// ── 审批接口 ──

export interface PlanReviewRequest {
  planFilePath: string;
  planContent: string;
  options?: { label: string; description: string }[];
  callback: (response: PlanApprovalResponse) => void;
}

export type PlanApprovalResponse =
  | { decision: 'approved'; selectedLabel?: string }
  | { decision: 'revise'; feedback: string }
  | { decision: 'rejected' };

// ── enter_plan_mode ──

export function createEnterPlanModeTool(
  planState: PlanStateManager,
  projectPath: string,
): Tool {
  return {
    name: () => 'enter_plan_mode',
    description: () =>
      '进入规划模式。切换后你只有只读工具（加上写计划文件的权限）。' +
      '适合：新功能实现、多文件改动、架构决策、需求不明确的任务。' +
      '不适合：单行修复、明确的指令、纯探索任务。' +
      '进入后按流程操作：探索 → 设计 → 写计划文件 → exit_plan_mode 提交审批。',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => true,
    execute: async () => {
      if (planState.state.active) {
        return '已在规划模式中。继续探索代码，写好计划后调 exit_plan_mode 提交。';
      }
      const path = planState.enter(projectPath);
      return (
        `已进入规划模式。计划文件路径：${path}\n` +
        '用 write_file 把计划写到这个文件（计划文件写入不受只读限制）。\n' +
        '然后调 exit_plan_mode 提交计划给用户审批。'
      );
    },
  };
}

// ── exit_plan_mode ──

export function createExitPlanModeTool(
  planState: PlanStateManager,
  eventSink?: EventSink,
): Tool {
  return {
    name: () => 'exit_plan_mode',
    description: () =>
      '提交计划给用户审批。调用前必须先写好计划文件。' +
      '如果计划包含多个方案，用 options 参数列出（2-3个），用户会选择一个。' +
      '用户可以：批准 / 修改（带反馈，留在规划模式）/ 拒绝。' +
      '批准后自动切换到执行模式，所有工具恢复可用。',
    parameters: () => ({
      type: 'object',
      properties: {
        options: {
          type: 'array',
          description: '可选：2-3个备选方案，用户审批时选择一个。每个方案有 label 和 description。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '方案名称（1-8 个词）' },
              description: { type: 'string', description: '方案概述和权衡' },
            },
            required: ['label', 'description'],
          },
        },
      },
    }),
    readOnly: () => true,
    execute: async (args) => {
      if (!planState.state.active) {
        return '错误：不在规划模式中。先调 enter_plan_mode。';
      }
      const planPath = planState.state.planFilePath!;

      // 读取计划文件内容
      let planContent: string;
      try {
        planContent = await rpc<string>('read_file_content', { filePath: planPath });
        planContent = planContent.replace(/^\s*\d+\t/gm, '');
      } catch {
        return `错误：计划文件不存在。先用 write_file 写计划到 ${planPath}，再调 exit_plan_mode。`;
      }
      if (!planContent.trim()) {
        return `错误：计划文件为空。先写好计划再提交。路径：${planPath}`;
      }

      const options = (args.options as { label: string; description: string }[]) || undefined;
      const validOptions = options && options.length >= 2 ? options : undefined;

      // 有 eventSink → 发 PlanReview 事件到聊天流，UI 创建 PlanPart 卡片
      if (eventSink) {
        return new Promise<string>((resolve) => {
          eventSink({
            kind: EventKind.PlanReview,
            plan: {
              planFilePath: planPath,
              planContent,
              options: validOptions,
              callback: (response) => {
                switch (response.decision) {
                  case 'approved':
                    planState.exit();
                    resolve(
                      `计划已批准。${
                        response.selectedLabel ? `选定方案：${response.selectedLabel}。只执行选中的方案。` : ''
                      }\n已切换到执行模式，所有工具恢复可用。\n\n## 已批准计划：\n${planContent}`,
                    );
                    break;
                  case 'revise':
                    resolve(
                      `用户要求修改计划。反馈：${response.feedback}\n请根据反馈修改计划文件，然后重新调 exit_plan_mode。`,
                    );
                    break;
                  case 'rejected':
                    resolve('用户拒绝了计划。规划模式仍然激活。可以重新探索并修改计划。');
                    break;
                }
              },
            },
          });
        });
      }

      // 无 eventSink（headless 子 Agent 等）→ 自动批准
      planState.exit();
      return `计划已自动批准（无用户审批 UI）。已切换到执行模式。\n\n## 计划：\n${planContent}`;
    },
  };
}
