// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ChatAgentHandle — 解耦 chat.ts 和 agent.ts 的接口层
// chat.ts 只依赖此接口，不直接 import Agent 类。
// Agent 类已结构性实现此接口，无需额外 adapter。

import type { Message } from '../provider/types';

/** 目标运行结果 — runGoal / resumeGoal 的统一返回 */
export type GoalRunResult = { status: 'completed' | 'failed' | 'aborted' | 'paused'; summary: string };

export interface ChatAgentHandle {
  /** 发起一轮对话：附加用户消息，驱动工具循环 */
  run(signal: AbortSignal, input: string): Promise<void>;

  /** 自主多轮目标执行。status 新增 'paused' — 用户中断时保存检查点，可通过 resumeGoal 继续。 */
  runGoal(signal: AbortSignal, goal: string): Promise<GoalRunResult>;

  /** 恢复暂停(或崩溃遗留)的目标;不传 id 时恢复唯一活体目标 */
  resumeGoal(signal: AbortSignal, id?: string): Promise<GoalRunResult>;

  /** 手动触发上下文压缩，返回摘要文本 */
  compactNow(signal: AbortSignal): Promise<string>;

  /** 撤回指定位置的对话轮次 */
  retractTurnAt(sessionIndex: number): void;

  /** 读取当前会话消息列表（只读） */
  getSession(): Message[];

  /** 替换整个会话消息列表 */
  setSession(msgs: Message[]): void;

  /** 开启全新会话（保留 system prompt） */
  newSession(): void;

  /** 预测下一条 insert 的 session 索引 */
  readonly nextInsertIndex: number;

  /** 在 Agent 运行中插入用户消息 */
  insertMessage(text: string): void;

  /** 级联取消：父Agent中断时停止所有运行中的子Agent */
  cascadeAbort(): void;

  /** 批量停止所有子Agent */
  stopAllSubAgents(): string[];

  /** 当前正在运行的子Agent数量 */
  runningSubAgentCount(): number;
}
