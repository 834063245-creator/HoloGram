// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Coordinator — asynchronous multi-agent orchestration.
// CC ref: coordinator/coordinatorMode.ts, tools/AgentTool/

import type { Message } from '../provider/types';
import type { Agent } from './agent';

export enum SubAgentStatus {
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  Stopped = 'stopped',
}

export interface SubAgentHandle {
  id: string;
  description: string;
  status: SubAgentStatus;
  startedAt: number;
  result?: string;
  error?: string;
}

type Resolver = (result: string) => void;
type MessageCallback = (message: string) => void;

interface PendingAgent {
  handle: SubAgentHandle;
  resolve: Resolver;
  onMessage?: MessageCallback;
}

/** Pool of asynchronously running sub-agents.
 *  Spawn is fire-and-forget — parent agent doesn't block.
 *  Results are collected via pollCompleted() or injected as task-notifications. */
export class SubAgentPool {
  private agents = new Map<string, PendingAgent>();
  private completed: SubAgentHandle[] = [];

  /** Fire-and-forget spawn. Returns the handle ID immediately. */
  spawn(
    description: string,
    runFn: (onMessage?: (msg: string) => void) => Promise<{ text: string; err?: string }>,
    onMessage?: (msg: string) => void,
  ): string {
    const id = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handle: SubAgentHandle = {
      id,
      description,
      status: SubAgentStatus.Running,
      startedAt: Date.now(),
    };

    const promise = new Promise<string>((resolve) => {
      this.agents.set(id, { handle, resolve, onMessage });
    });

    // Fire and forget — don't await
    runFn(onMessage).then(
      ({ text, err }) => {
        const pending = this.agents.get(id);
        if (!pending) return; // already stopped/discarded
        if (err) {
          pending.handle.status = SubAgentStatus.Failed;
          pending.handle.error = err;
          pending.handle.result = text || err;
        } else {
          pending.handle.status = SubAgentStatus.Completed;
          pending.handle.result = text;
        }
        this.completed.push(pending.handle);
        pending.resolve(text);
        this.agents.delete(id);
      },
      (err) => {
        const pending = this.agents.get(id);
        if (!pending) return;
        pending.handle.status = SubAgentStatus.Failed;
        pending.handle.error = String(err?.message || err);
        pending.handle.result = pending.handle.error;
        this.completed.push(pending.handle);
        pending.resolve(pending.handle.error || '');
        this.agents.delete(id);
      },
    );

    return id;
  }

  /** Poll for completed results. Non-blocking. */
  pollCompleted(): SubAgentHandle[] {
    const results = [...this.completed];
    this.completed = [];
    return results;
  }

  /** Send a message to a running sub-agent (for SendMessage/agent_message tool). */
  sendMessage(id: string, message: string): boolean {
    const pending = this.agents.get(id);
    if (!pending || !pending.onMessage) return false;
    pending.onMessage(message);
    return true;
  }

  /** Stop a running sub-agent. */
  stop(id: string): boolean {
    const pending = this.agents.get(id);
    if (!pending) return false;
    pending.handle.status = SubAgentStatus.Stopped;
    pending.handle.error = 'stopped by user';
    this.completed.push(pending.handle);
    pending.resolve('');
    this.agents.delete(id);
    return true;
  }

  /** Get a summary of all agents (running + completed). */
  summary(): string {
    const lines: string[] = [];
    // Running
    for (const [, pending] of this.agents) {
      const elapsed = Math.round((Date.now() - pending.handle.startedAt) / 1000);
      lines.push(`- 🔄 ${pending.handle.description} (运行中, ${elapsed}s)`);
    }
    // Completed
    const recent = this.completed.slice(-5);
    for (const h of recent) {
      const icon = h.status === SubAgentStatus.Completed ? '✅' :
        h.status === SubAgentStatus.Failed ? '❌' : '⏹️';
      lines.push(`- ${icon} ${h.description} (${h.status})`);
    }
    return lines.length > 0 ? lines.join('\n') : '无运行中的子Agent';
  }

  get runningCount(): number {
    return this.agents.size;
  }

  /** Wait for all running agents to complete.
   *  ponytail: spins on pollCompleted with 100ms sleep — good enough
   *  for a dozen sub-agents. Add per-handle Promise if latency matters. */
  async awaitAll(): Promise<SubAgentHandle[]> {
    while (this.agents.size > 0) {
      await new Promise(r => setTimeout(r, 100));
    }
    return [...this.completed];
  }
}

/** Synthesize results from completed sub-agents into a final answer.
 *  Uses the parent agent to run a final LLM turn for synthesis. */
export async function synthesizeResults(
  handles: SubAgentHandle[],
  synthesisPrompt: string,
  parentAgent: Agent,
  signal: AbortSignal,
): Promise<string> {
  if (handles.length === 0) return '子Agent 未返回任何结果。';

  const report = handles.map(h => {
    const statusIcon = h.status === SubAgentStatus.Completed ? '✅' :
      h.status === SubAgentStatus.Failed ? '❌' : '⏹️';
    return `### ${statusIcon} ${h.description}\n${h.result || h.error || '(无输出)'}`;
  }).join('\n\n');

  const prompt = `${synthesisPrompt}\n\n## 子Agent 结果\n\n${report}`;
  await parentAgent.run(signal, prompt);
  // Return the last assistant message as the synthesis output
  const session = parentAgent.getSession();
  const lastAssistant = [...session].reverse().find(m => m.role === 'assistant');
  return lastAssistant?.content || '(合成未生成输出)';
}
