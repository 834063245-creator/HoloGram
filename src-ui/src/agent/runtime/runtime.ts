// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AgentRuntime — 管理 Agent 实例的生命周期
//
// 职责：
//   - 创建/销毁 Agent 实例
//   - 通过 RuntimeNotifier 接口向 UI 推送事件（不直接操作 zustand/store）
//   - 管理 ToolRegistry、hooks、preflight 等 Agent 依赖
//
// 不依赖：React, zustand, ui/event bus, ui/chat-store, ui/panel-store
//
// UI 层通过 setNotifier() 注入通知器，Runtime 通过它路由事件。

import { rpc } from '../../bridge';
import { createProvider } from '../../provider';
import type { Message, Provider } from '../../provider/types';
import { defaultPricing } from '../../settings';
import { Agent } from '../agent';
import type { AgentStore } from '../agent-store';
import type { AgentEvent, AgentUINotifier, EventSink } from '../agent-types';
import type { SubAgentPool } from '../coordinator';
import { createExecState, type ExecStateInstance } from '../execution-state';
import type { GoalManager } from '../goal-manager';
import type { GraphContext } from '../hooks';
import {
  buildGraphSnapshot,
  createGraphContextHook,
  createGraphPreflightHook,
  createStatePreflightHook,
  createStateReadHook,
  HookRegistry,
  PreflightHookRegistry,
} from '../hooks';
import { log } from '../logger';
import type { MemoryManager } from '../memory';
import { memoryBundleIngest } from '../memory-bundle-client';
import { MessageBus } from '../message-bus';
import type { SkillRegistry } from '../skills';
import type { DiagnosticsSource, LspDiagnostic } from '../state-inject';
import { buildTurnStartBlock, refreshGitStatus, refreshTimeline } from '../state-inject';
import type { TaskManager } from '../task';
import { ToolRegistry } from '../tool';
import { createCommunicationTools } from '../tools/communication';
import type { SubAgentSpawner } from '../tools/subagent';
import {
  type BuilderDeps,
  buildGraphContextFromData,
  buildSystemPrompt,
  buildToolRegistry,
  extractGraphNodeNames,
  loadEngineSnapshot,
  planRegistry,
  registerCompactionTools,
} from './agent-builder';

import type { AgentConfig, AgentHandle, AgentStatus, AgentSummary, RuntimeNotifier, RuntimePort } from './types';

// ── AgentHandleImpl ──

class AgentHandleImpl implements AgentHandle {
  constructor(
    private readonly _agent: Agent,
    private readonly _runtime: AgentRuntime,
  ) {}

  get id(): string {
    return this._agent.id;
  }
  get parentId(): string | null {
    return this._agent.parentId;
  }
  get status(): AgentStatus {
    // Agent doesn't expose a status field directly — derive from execState
    return 'idle';
  }

  run(signal: AbortSignal, input: string): Promise<void> {
    return this._agent.run(signal, input);
  }
  runGoal(signal: AbortSignal, goal: string) {
    return this._agent.runGoal(signal, goal);
  }
  resumeGoal(signal: AbortSignal, id?: string) {
    return this._agent.resumeGoal(signal, id);
  }
  compactNow(signal: AbortSignal) {
    return this._agent.compactNow(signal);
  }
  retractTurnAt(sessionIndex: number) {
    return this._agent.retractTurnAt(sessionIndex);
  }
  getSession() {
    return this._agent.getSession();
  }
  setSession(msgs: Message[]) {
    return this._agent.setSession(msgs);
  }
  newSession() {
    return this._agent.newSession();
  }
  get nextInsertIndex() {
    return this._agent.nextInsertIndex;
  }
  insertMessage(text: string, opts?: { silent?: boolean }) {
    return this._agent.insertMessage(text, opts);
  }
  cascadeAbort() {
    return this._agent.cascadeAbort();
  }
  stopAllSubAgents() {
    return this._agent.stopAllSubAgents();
  }
  runningSubAgentCount() {
    return this._agent.runningSubAgentCount();
  }
  setUiSessionId(sid: number) {
    return this._agent.setUiSessionId(sid);
  }

  /** Direct access to the underlying Agent — for internal use only */
  _getAgent(): Agent {
    return this._agent;
  }
}

// ── AgentRuntime ──

export class AgentRuntime implements RuntimePort {
  private agents = new Map<string, AgentHandleImpl>();
  private notifier: RuntimeNotifier | null = null;
  /** 全局 MessageBus 实例 — 构造时创建，所有 agent 共享 */
  private _bus = new MessageBus();

  /** 注入 UI 通知器 — 由 UI 层在启动时设置 */
  setNotifier(n: RuntimeNotifier): void {
    this.notifier = n;
  }

  /** 获取全局 MessageBus 实例 */
  getBus(): MessageBus {
    return this._bus;
  }

  /** 创建 Agent — 接收完整配置，Runtime 不做 UI 依赖的事 */
  async createAgent(config: AgentConfig): Promise<AgentHandle> {
    const agentId = config.agentId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 1. 构建 system prompt（如果没预构建）
    let sysPrompt = config.systemPrompt;
    if (!sysPrompt) {
      let memSection = '';
      if (config.memoryManager) {
        try {
          memSection = await config.memoryManager.loadPromptSection(
            config.graphData ? extractGraphNodeNames(config.graphData) : undefined,
          );
        } catch {}
      }
      let claudeMd = '';
      try {
        claudeMd = await rpc<string>('read_file_content', { filePath: `${config.projectPath}/CLAUDE.md` });
      } catch {}
      const snap = config.graphData ? buildGraphSnapshot(config.graphData) : '';
      sysPrompt = buildSystemPrompt(
        config.graphData,
        config.projectPath,
        memSection,
        snap,
        claudeMd,
        config.collaborationMode ?? 'normal',
        config.provider.name(),
      );
    }

    // 2. Clone tools registry (each agent gets its own copy)
    const r = new ToolRegistry();
    for (const t of config.tools.all()) r.register(t);

    // 3. Plan mode: filter to read-only
    const effR = config.collaborationMode === 'plan' ? planRegistry(r) : r;

    // 4. Create Agent instance
    const execState = config.execState ?? createExecState();
    const newAgent = new Agent(config.provider, effR, sysPrompt, {
      agentId,
      parentId: config.parentId ?? null,
      eventSink: config.eventSink ?? (() => {}),
      execState,
      onSessionPersisted: config.onSessionPersisted,
      pricing: config.pricing,
      temperature: config.temperature ?? 0.7,
      contextWindow: config.contextWindow ?? 0,
      maxTokens: config.maxTokens ?? 0,
      ui: this._wrapNotifier(agentId),
      messageBus: this._bus,
    });

    // 5. Wire isolation
    if (config.isolationId) {
      newAgent._isolationId = config.isolationId;
    }

    // 6. Wire compaction tools
    newAgent.setCompactionConfigPath(config.projectPath);

    // 7. Wire persistence
    if (config.agentStore) newAgent.setAgentStore(config.agentStore);
    if (config.goalManager) newAgent.setGoalManager(config.goalManager);
    newAgent.applyAutoTuneConfig().catch(() => {});
    if (config.subAgentPool) newAgent.setSubAgentPool(config.subAgentPool);

    // 7b. Wire message bus + register communication tools
    newAgent.setBus(this._bus);
    this._bus.register({
      agentId,
      parentId: config.parentId ?? null,
      depth: config.subagentDepth ?? 0,
    });
    // Register communication tools — plan mode gets only read-only tools (agent_inbox / agent_list)
    for (const tool of createCommunicationTools(this._bus, () => newAgent.id)) {
      if (config.collaborationMode === 'plan' && !tool.readOnly()) continue;
      effR.register(tool);
    }

    // 8. Register compaction tools on the agent's registry copy
    registerCompactionTools(newAgent, r);

    // 9. Wire hooks (graph context + state)
    if (config.graphContext) {
      loadEngineSnapshot(config.graphContext, config.projectPath).catch(() => {});
      const hooks = new HookRegistry();
      hooks.register(createGraphContextHook(config.graphContext));
      if (this._diagSource) {
        hooks.register(createStateReadHook(config.projectPath, this._diagSource));
      }
      newAgent.setHooks(hooks);
      const preflightHooks = new PreflightHookRegistry();
      preflightHooks.register(createGraphPreflightHook(config.graphContext));
      if (this._diagSource) {
        preflightHooks.register(createStatePreflightHook(this._diagSource));
      }
      newAgent.setPreflightHooks(preflightHooks);
    }

    // 10. Wire pre-run hook (AuraSDK semantic recall)
    if (config.preRunHook) {
      newAgent.setPreRunHook(config.preRunHook);
    }

    // 11. Auto-tune
    newAgent.applyAutoTuneConfig().catch(() => {});

    // 12. Register and return
    const handle = new AgentHandleImpl(newAgent, this);
    this.agents.set(agentId, handle);
    log.info('runtime', `agent created: ${agentId}`);

    return handle;
  }

  getAgent(id: string): AgentHandle | null {
    return this.agents.get(id) ?? null;
  }

  destroyAgent(id: string): void {
    const handle = this.agents.get(id);
    if (!handle) return;
    handle
      ._getAgent()
      .saveState('done')
      .catch(() => {});
    this._bus.unregister(id);
    this.agents.delete(id);
    log.info('runtime', `agent destroyed: ${id}`);
  }

  listAgents(): AgentSummary[] {
    return Array.from(this.agents.values()).map((h) => ({
      id: h.id,
      parentId: h.parentId,
      status: h.status,
      description: h.id === 'main' ? '主Agent' : `Agent (${h.id})`,
      subagentDepth: 0, // TODO: expose from Agent
    }));
  }

  // ── Private: wrap RuntimeNotifier into AgentUINotifier ──

  private _wrapNotifier(agentId: string): AgentUINotifier {
    return {
      progress: (step: number, toolName: string) => {
        this.notifier?.onProgress(agentId, step, toolName);
      },
      toolDone: (toolName: string, args: Record<string, unknown>, output: string) => {
        this.notifier?.onToolDone(agentId, toolName, args, output);
      },
      subAgentSpawn: (info, onProgress) => {
        return this.notifier?.onSubAgentSpawn({
          agentId: info.agentId,
          parentAgentId: agentId,
          description: info.description,
          sessionId: info.sessionId,
          onProgress,
        });
      },
      subAgentFinished: (id, sessionId, ok) => {
        this.notifier?.onSubAgentFinished(id, agentId, ok);
      },
      sessionReplaced: (messages: Message[]) => {
        this.notifier?.onSessionReplaced(agentId, messages);
      },
    };
  }

  // ── Private: diagnostics source ──
  // Injected by setDiagnosticsSource() — agent-builder can't import ui/lsp-client
  private _diagSource: DiagnosticsSource | null = null;

  setDiagnosticsSource(fn: DiagnosticsSource): void {
    this._diagSource = fn;
  }

  private _getDiagnosticsSource(): DiagnosticsSource | null {
    return this._diagSource;
  }
}
