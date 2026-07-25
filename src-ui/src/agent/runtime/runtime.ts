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
import { EventKind } from '../agent-types';
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
import { createBoardTrackingHook } from '../hooks/board-tracking-hook';
import { log } from '../logger';
import type { MemoryManager } from '../memory';
import { memoryBundleIngest } from '../memory-bundle-client';
import { MessageBus } from '../message-bus';
import { JsonMessageStore } from '../message-store';
import { TaskBoard } from '../task-board';
import { DiscoveryBoard } from '../discovery-board';
import { createDiscoveryTools } from '../tools/discovery';
import type { SkillRegistry } from '../skills';
import type { DiagnosticsSource, LspDiagnostic } from '../state-inject';
import { buildTurnStartBlock, refreshGitStatus, refreshTimeline } from '../state-inject';
import type { TaskManager } from '../task';
import { ToolRegistry, agentInvoke } from '../tool';
import { createCommunicationTools } from '../tools/communication';
import { createMergeTool } from '../tools/merge';
import { createRequestTool } from '../tools/request';
import { AgentLifecycleManager } from '../lifecycle-manager';
import { enqueueIsolationOp } from '../isolation-queue';
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
    return this._agent.isRunning ? 'running' : 'idle';
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
  /** 全局 MessageBus 实例 */
  private _bus: MessageBus;
  /** 全局 TaskBoard 实例 */
  private _taskBoard: TaskBoard;
  /** 全局 DiscoveryBoard 实例 */
  private _discoveryBoard: DiscoveryBoard;
  /** 项目路径 — 用于持久化 */
  private _projectPath: string;
  /** LifecycleManager 实例 — 每个 agent 一个，持有 pool/board/bus/exec/sink 引用 */
  private _lifecycleManagers = new Map<string, AgentLifecycleManager>();
  /** 启动恢复 promise — createAgent 前必须 await ready() */
  private _readyPromise: Promise<void>;

  constructor(projectPath?: string) {
    this._projectPath = projectPath ?? '';
    if (projectPath) {
      const store = new JsonMessageStore(projectPath);
      this._bus = new MessageBus(undefined, store);
      this._taskBoard = new TaskBoard(projectPath);
      this._discoveryBoard = new DiscoveryBoard(projectPath);
      // 启动恢复 — 保留 promise 引用，createAgent 前必须 await ready()
      this._readyPromise = this._restore();
    } else {
      this._bus = new MessageBus();
      this._taskBoard = new TaskBoard();
      this._discoveryBoard = new DiscoveryBoard();
      this._readyPromise = Promise.resolve();
    }
  }

  /** 等待启动恢复完成 — createAgent 前必须 await */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /** 注入 UI 通知器 — 由 UI 层在启动时设置 */
  setNotifier(n: RuntimeNotifier): void {
    this.notifier = n;
  }

  /** 获取全局 MessageBus 实例 */
  getBus(): MessageBus {
    return this._bus;
  }

  /** 获取全局 TaskBoard 实例 */
  getTaskBoard(): TaskBoard {
    return this._taskBoard;
  }

  /** 获取全局 DiscoveryBoard 实例 */
  getDiscoveryBoard(): DiscoveryBoard {
    return this._discoveryBoard;
  }

  /** 启动恢复 — 在 createAgent() 之前完成。
   *  1. 恢复所有 inbox 消息
   *  2. 恢复 TaskBoard 条目
   *  3. 孤儿检测：崩溃时还在跑的子 agent，进程已死，标记为 stopped 并清理 worktree
   *  best-effort — 永不抛异常阻塞启动 */
  private async _restore(): Promise<void> {
    try {
      // 1. 恢复所有 inbox 消息
      await this._bus.restore();
      // 1b. 清除跨 session 泄漏的 result/reply — 这些只在上个 session 内有效
      this._bus.purgeEphemeralTypes();

      // 2. 恢复 TaskBoard 条目
      await this._taskBoard.restore();

      // 2b. 恢复 DiscoveryBoard 条目
      await this._discoveryBoard.restore();

      // 3. 孤儿检测：找 status === 'running' 的条目 — 这些是崩溃时还在跑的子 agent
      const orphans = this._taskBoard.getAllEntries().filter((e) => e.status === 'running');
      for (const orphan of orphans) {
        this._taskBoard.stop(orphan.agentId);
        // 清理 worktree
        if (orphan.isolationId) {
          try {
            await enqueueIsolationOp(async () => {
              await agentInvoke<string>('agent_isolation_discard', { agent_id: orphan.isolationId! }).catch(() => {});
            });
          } catch {
            /* best-effort */
          }
        }
        console.warn(`[AgentRuntime] 检测到孤儿 agent: ${orphan.agentId}, 已标记为 stopped`);
      }

      // 4. 刷新持久化（把 stop 状态写回）
      if (orphans.length > 0) {
        await this._taskBoard.flush();
      }
    } catch {
      // best-effort — 恢复失败不阻塞启动
    }
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
      taskBoard: this._taskBoard,
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
    if (config.subAgentPool) newAgent.setSubAgentPool(config.subAgentPool);

    // 7b. Wire message bus + register communication tools
    // setBus() handles bus.register() with wake callback — no duplicate call needed
    newAgent.setBus(this._bus);
    // Wire discovery board for inter-agent knowledge sharing
    newAgent.setDiscoveryBoard(this._discoveryBoard);
    // Register communication tools — plan mode gets only read-only tools (agent_inbox / agent_list)
    for (const tool of createCommunicationTools(this._bus, () => newAgent.id)) {
      if (config.collaborationMode === 'plan' && !tool.readOnly()) continue;
      effR.register(tool);
    }

    // Register discovery tools — plan mode: only read-only agent_lookup
    for (const tool of createDiscoveryTools(this._discoveryBoard, () => newAgent.id)) {
      if (config.collaborationMode === 'plan' && !tool.readOnly()) continue;
      effR.register(tool);
    }

    // isolationExec — 用于 agent_isolation_discard / agent_isolation_merge
    // 被 agent_merge 工具和 LifecycleManager 共用
    const isolationExec = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const result = await agentInvoke<string>(name, args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    };

    // Register agent_merge tool — allows parent to merge completed async sub-agent worktrees
    if (config.collaborationMode !== 'plan') {
      effR.register(createMergeTool(this._taskBoard, () => newAgent.id, isolationExec));
    }

    // Register agent_request tool — synchronous request with timeout
    if (config.collaborationMode !== 'plan') {
      effR.register(createRequestTool(this._bus, () => newAgent.id));
    }

    // 7c. Wire LifecycleManager — 全局空闲判定 + 泄漏检测 + worktree TTL 清理
    if (config.subAgentPool) {
      const rawSink = config.eventSink ?? (() => {});
      const wrappedSink: EventSink = (ev) => {
        rawSink(ev);
        // Forward Notice events to the notifier for the panel
        if (ev.kind === EventKind.Notice) {
          this.notifier?.onLifecycleAlert?.(agentId, ev.level ?? 'info', ev.text ?? '');
        }
      };
      const lifecycle = new AgentLifecycleManager(
        config.subAgentPool,
        this._taskBoard,
        this._bus,
        isolationExec,
        wrappedSink,
      );
      lifecycle.start();
      this._lifecycleManagers.set(agentId, lifecycle);
    }

    // 8. Register compaction tools on the agent's effective registry
    registerCompactionTools(newAgent, effR);

    // 9. Wire hooks (graph context + state + board tracking)
    const hooks = new HookRegistry();
    const preflightHooks = new PreflightHookRegistry();
    if (config.graphContext) {
      loadEngineSnapshot(config.graphContext, config.projectPath).catch(() => {});
      hooks.register(createGraphContextHook(config.graphContext));
      if (this._diagSource) {
        hooks.register(createStateReadHook(config.projectPath, this._diagSource));
      }
      preflightHooks.register(createGraphPreflightHook(config.graphContext));
      if (this._diagSource) {
        preflightHooks.register(createStatePreflightHook(this._diagSource));
      }
    }
    // Board tracking hook — always register when board is available
    hooks.register(createBoardTrackingHook(agentId, this._taskBoard));
    newAgent.setHooks(hooks);
    newAgent.setPreflightHooks(preflightHooks);

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
    // Flush 持久化 — 在清理前落盘
    this._bus.clearFlushTimer();
    this._taskBoard.clearFlushTimer();
    this._discoveryBoard.clearFlushTimer();
    void this._bus.flush();
    void this._taskBoard.flush();
    void this._discoveryBoard.flush();
    handle
      ._getAgent()
      .saveState('done')
      .catch(() => {});
    // 停止 LifecycleManager 巡检定时器
    this._lifecycleManagers.get(id)?.stop();
    this._lifecycleManagers.delete(id);
    this._bus.unregister(id);
    this._taskBoard.unregister(id);
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
        this.notifier?.onSubAgentFinished(id, agentId, sessionId, ok);
      },
      onStatusChange: (running: boolean) => {
        this.notifier?.onAgentStatus(agentId, running ? 'running' : 'idle');
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