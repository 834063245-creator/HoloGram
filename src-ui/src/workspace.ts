// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Workspace — owns all state for one open project.
// Replaces 18+ module-level globals in main.ts.
//
// Lifecycle:
//   const ws = await Workspace.open(path, starGraph, chatPanel);
//   // ... user works ...
//   await ws.deactivate(chatPanel);
//
// Switching workspaces is atomic: old.deactivate() → new = Workspace.open() → assign.

import { Agent } from './agent/agent';
import { AgentStore } from './agent/agent-store';
import { auraShutdown } from './agent/aura-memory';
import { SubAgentPool } from './agent/coordinator';
import { GoalManager } from './agent/goal-manager';
import type { GraphContext } from './agent/hooks';
import { initLogger } from './agent/logger';
import { MemoryManager } from './agent/memory';
import { buildTurnStartBlock, refreshGitStatus, refreshTimeline } from './agent/state-inject';
import { TaskManager } from './agent/task';
import type { Tool } from './agent/tool';
import { ToolRegistry } from './agent/tool';
import type { ChatCore } from './app/chat/chat-core';
import { listen, rpc } from './bridge';
import { createProvider } from './provider';
import { defaultPricing, getActiveProvider, loadSettings, persistSecrets, restoreSecrets } from './settings';
import { stripLineNumbers } from './ui/chat-session';
import { useDockStore } from './ui/dock-store';
import { bus } from './ui/events';
import type { StarGraph } from './ui/graph';
import { getDiagnosticsForFile } from './ui/lsp-client';
import { getPanelStore } from './ui/panel-store';
import type { CheckResult } from './ui/react/CheckPanel';
// ── Runtime layer (replaces bootstrap.ts) ──
import { AgentRuntime } from './agent/runtime/runtime';
import {
  buildGraphContextFromData,
  buildToolRegistry,
  extractGraphNodeNames,
  scheduleEngineSnapshotRefresh,
  type BuilderDeps,
} from './agent/runtime/agent-builder';
import { createRuntimeAdapter, createBuilderDeps } from './ui/runtime-adapter';
import type { Provider } from './provider/types';
import { memoryBundleIngest } from './agent/memory-bundle-client';
import { SkillRegistry } from './agent/skills';

// ═══════════════════════════════════════════════════════
// Dynamic tool loading from engine registry
// ═══════════════════════════════════════════════════════

import { dbg } from './ui/debug';

// ── Path util ──────────────────────────────────────────────────────

/** Case-insensitive path comparison (Windows drive letters may differ in case). */
export function isSamePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

// ── Arg translation (moved from main.ts) ───────────────────────────

// ponytail: 所有 hologram 工具 schema 已用 camelCase (nodeId/maxDepth/from/to/...),
// Tauri v2 默认 camelCase 重命名 Rust snake_case 参数 → 期望的 JS key 正是这些 camelCase.
// 旧 ARG_TRANSLATIONS 把 camelCase→snake_case, 方向全反 → 7 个工具 (node/unused/impact/
// neighbors/path/coupling_report/community) 全部 "missing required key". 删整张表, args 直传.
// 若新增 hologram 命令: schema 参数名用 camelCase 即可, 无需任何翻译.

// ── Workspace class ─────────────────────────────────────────────────

export class Workspace {
  // ── Identity ──
  readonly path: string;

  // ── Graph data ──
  graphData: any = null;
  fileGraphData: any = null;

  // ── View state ──
  diffActive: boolean = false;

  // ── Agent & memory ──
  agent: Agent | null = null;
  prov: Provider | null = null;
  registry: ToolRegistry | null = null;
  memoryManager: MemoryManager | null = null;
  taskManager: TaskManager = new TaskManager();
  skillRegistry: SkillRegistry | null = null;
  agentStore: AgentStore | null = null;
  goalManager: GoalManager | null = null;

  // ── Runtime ──
  runtime: AgentRuntime | null = null;

  // ── Sub-agent pool ──
  subAgentPool = new SubAgentPool();

  // ── Store routing (per-panel isolation) ──
  _storeId: string = '__default__';

  // ── Check state ──
  checkRunning: boolean = false;
  checkPending: boolean = false;
  checkTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Agent setup guards ──
  agentSetupRunning: boolean = false;
  agentSetupPending: boolean = false;

  // ── Internals ──
  private _active: boolean = false;
  private _unlisteners: Array<() => void> = [];

  /** Guard: true while the initial cold-start render (step 4 of open()) is in flight.
   *  Prevents graph-updated events from stomping on the in-progress render with
   *  a second _renderImpl → clearGraph() call that disposes GPU resources the
   *  first render is still using. */
  _initialRenderActive: boolean = false;

  /** Preflight GraphContext — stored so engine snapshot can be refreshed after writes. */
  _preflightCtx: GraphContext | null = null;

  get active(): boolean {
    return this._active;
  }

  // ── UI callbacks (set by main.ts) ──
  onStatusChange: ((msg: string) => void) | null = null;
  onLoadingChange: ((loading: boolean) => void) | null = null;

  private constructor(path: string) {
    this.path = path;
  }

  /** Create a placeholder workspace for agent-only mode (no project loaded). Never activated. */
  static placeholder(): Workspace {
    return new Workspace('');
  }

  // ═══════════════════════════════════════════════════════════════
  // Factory: open a workspace — full analysis + render + watcher
  // ═══════════════════════════════════════════════════════════════

  static async open(
    path: string,
    starGraph: StarGraph,
    _chatPanel: ChatCore,
    opts?: { skipAnalysis?: boolean; cachedGraph?: any },
    callbacks?: { onStatusChange?: (msg: string) => void; onLoadingChange?: (loading: boolean) => void },
  ): Promise<Workspace> {
    const ws = new Workspace(path);
    ws._active = true;
    // ponytail: wire callbacks immediately so progress listeners inside this
    // method can push status updates. Without this, the entire analysis phase
    // is silent — onStatusChange was assigned AFTER open() returned.
    ws.onStatusChange = callbacks?.onStatusChange ?? null;
    ws.onLoadingChange = callbacks?.onLoadingChange ?? null;

    // Auto-schedule check when agent writes files
    bus.on('check:schedule', () => ws.scheduleCheck());

    // 1. Register workspace with backend
    ws.onStatusChange?.('正在初始化引擎...');
    console.log('[Workspace.open] step 1: workspace_activate...');
    await rpc('workspace_activate', { path }).catch((e) => {
      console.error('[Workspace.open] workspace_activate failed:', e);
    });
    console.log('[Workspace.open] step 1: done');
    initLogger(path);

    // 2. Wire progress listeners (scoped to this workspace)
    let currentPhase = '';
    const unlistenProgress = await listen<{ current: number; total: number; file: string }>('analyze-progress', (e) => {
      if (!ws._active) return;
      const { current, total, file } = e.payload;
      const basename = file.replace(/.*[/\\]/, '');
      ws.onStatusChange?.(`${currentPhase ? currentPhase + ' — ' : ''}[${current}/${total}] ${basename}`);
    });
    const unlistenPhase = await listen<{ phase: string; message: string }>('analyze-phase', (e) => {
      if (!ws._active) return;
      currentPhase = e.payload.message || e.payload.phase;
      ws.onStatusChange?.(currentPhase);
    });
    const unlistenHeartbeat = await listen<{ label: string; elapsed: string }>('analyze-heartbeat', (e) => {
      if (!ws._active) return;
      const { label, elapsed } = e.payload;
      ws.onStatusChange?.(`${label} (${elapsed}...)`);
    });

    try {
      if (opts?.skipAnalysis && opts.cachedGraph) {
        // Cold-start: use cached graph for instant render.
        // Still fire analyze_and_load (force=false) so engine_init switches
        // the backend engine to THIS project. Without this, all hologram_*
        // tool calls hit the previous session's graph data.
        // ponytail: fire-and-forget — user sees graph immediately, engine
        // init finishes in background (~500ms from SQLite).
        ws.graphData = opts.cachedGraph;
        rpc('analyze_and_load', { path, force: false }).catch(() => {});
      } else {
        // Full analysis
        ws.onLoadingChange?.(true);
        const raw = await rpc<string>('analyze_and_load', { path, force: false });
        ws.graphData = JSON.parse(raw);
      }

      // 3. Load file-level graph — timeout at 5s, don't block workspace open.
      // ponytail: read_file_content's async require_read runs on the Tokio runtime
      // which can be saturated by the fire-and-forget analyze_and_load serializing
      // 11669-node JSON on the async thread. This is an internal file; if it times
      // out, file-level graph is null — non-fatal.
      console.log('[Workspace.open] step 3: read_file_content...');
      try {
        const filesPath = path.replace(/\\/g, '/').replace(/\/$/, '') + '/hologram_graph_files.json';
        const raw = await Promise.race([
          rpc<string>('read_file_content', { filePath: filesPath }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        ws.fileGraphData = JSON.parse(stripLineNumbers(raw));
        console.log('[Workspace.open] step 3: done');
      } catch (e) {
        console.log('[Workspace.open] step 3: failed', e);
        ws.fileGraphData = null;
      }

      // 4. Render — defer to next macrotask so DOM status updates paint first.
      // ponytail: _renderImpl runs heavy sync prep (Map/Array builds for N nodes)
      // before its first await. Without setTimeout, the main thread is blocked
      // and "正在渲染图谱..." never paints — user sees stale "正在分析...".
      // ponytail 2: _initialRenderActive prevents graph-updated from calling
      // doGraphUpdate→render→_renderImpl→clearGraph() while this render is
      // in flight (cold-start race: fire-and-forget analyze_and_load emits
      // graph-updated → get_full_graph → doGraphUpdate → render stomps on us).
      console.log('[Workspace.open] step 4: scheduling render...');
      ws.onStatusChange?.('正在渲染图谱...');
      ws._initialRenderActive = true;
      setTimeout(async () => {
        console.log('[Workspace.open] render starting');
        try {
          await starGraph.render(ws.graphData);
        } catch {
          /* render handles its own errors */
        }
        ws._initialRenderActive = false;
        // Run initial check to establish baseline — also schedules subsequent checks via doGraphUpdate
        ws.runCheck();
      }, 0);

      // 5. Wire persistent event listeners (graph-updated, analysis-complete, analysis-failed)
      console.log('[Workspace.open] step 5: wiring listeners...');
      const unlistenGraphUpdated = await listen<string>('graph-updated', async (event) => {
        if (!ws._active) return;
        try {
          const summary = JSON.parse(event.payload);
          const eventRoot = summary.meta?.source_root || '';
          if (eventRoot && !isSamePath(eventRoot, ws.path)) return;
          const nc = summary.total_nodes || summary.node_count || 0;
          if (nc > 0 && ws.path) {
            // ponytail: if the initial cold-start render is still in flight,
            // don't stomp on it with another _renderImpl → clearGraph().
            // The initial render already has ws.graphData (cachedGraph).
            // Subsequent graph-updated events will trigger doGraphUpdate normally
            // once _initialRenderActive clears.
            if (ws._initialRenderActive) {
              console.log('[Workspace.open] graph-updated: skipping (initial render in flight)');
              return;
            }
            try {
              const raw = await rpc<string>('get_full_graph');
              ws.graphData = JSON.parse(raw);
              try {
                const filesPath = ws.path.replace(/\\/g, '/').replace(/\/$/, '') + '/hologram_graph_files.json';
                ws.fileGraphData = JSON.parse(
                  stripLineNumbers(await rpc<string>('read_file_content', { filePath: filesPath })),
                );
              } catch {
                /* file graph may not exist yet */
              }
              ws.doGraphUpdate(starGraph, summary.diff);
              bus.emit('timeline:refresh');
            } catch {
              /* get_full_graph failed */
            }
          }
        } catch {
          /* ignore */
        }
      });
      ws._unlisteners.push(unlistenGraphUpdated);

      // Agent tool-done → auto-trigger briefings when files may have changed
      const FILE_MODIFY_TOOLS = new Set([
        'write_file',
        'edit_file',
        'delete_file',
        'rename_file',
        'move_file',
        'git_commit',
        'git_stage',
        'git_push',
        'git_pull',
        'run_shell',
        'rename_symbol',
      ]);
      const onToolDone = (evt: { toolName: string }) => {
        if (FILE_MODIFY_TOOLS.has(evt.toolName)) {
          ws.scheduleCheck();
          bus.emit('timeline:refresh');
          // Refresh engine snapshot — tracks cumulative structure drift
          if (ws._preflightCtx) scheduleEngineSnapshotRefresh(ws._preflightCtx, ws.path);
        }
      };
      bus.on('agent:tool-done', onToolDone);
      ws._unlisteners.push(() => bus.off('agent:tool-done', onToolDone));

      const unlistenAnalysisComplete = await listen<string>('analysis-complete', async (event) => {
        if (!ws._active) return;
        try {
          const summary = JSON.parse(event.payload);
          if (!isSamePath(ws.path, summary.path)) return;
          const raw = await rpc<string>('get_full_graph');
          ws.graphData = JSON.parse(raw);
          try {
            const filesPath = ws.path.replace(/\\/g, '/').replace(/\/$/, '') + '/hologram_graph_files.json';
            ws.fileGraphData = JSON.parse(
              stripLineNumbers(await rpc<string>('read_file_content', { filePath: filesPath })),
            );
          } catch {
            /* will be regenerated by watcher */
          }
          // Use diff for incremental update if available, otherwise full render
          ws.doGraphUpdate(starGraph, summary.diff);
          bus.emit('timeline:refresh');
        } catch (e) {
          console.error('[analysis-complete] failed to reload graph:', e);
        }
      });
      ws._unlisteners.push(unlistenAnalysisComplete);

      const unlistenAnalysisFailed = await listen<{ path: string; error: string }>('analysis-failed', (event) => {
        if (!ws._active) return;
        if (!isSamePath(ws.path, event.payload.path)) return;
        const short = (event.payload.error || '未知错误').slice(0, 80);
        ws.onStatusChange?.(`⚠️ 后台分析失败: ${short}`);
      });
      ws._unlisteners.push(unlistenAnalysisFailed);

      // Clean up progress listeners (they only live during initial analysis)
      unlistenProgress();
      unlistenPhase();
      unlistenHeartbeat();
      console.log('[Workspace.open] all done, returning workspace');
    } catch (err: any) {
      console.error('[Workspace.open] FAILED:', err);
      unlistenProgress();
      unlistenPhase();
      unlistenHeartbeat();
      ws.onStatusChange?.(`分析失败: ${err}`);
      ws.onLoadingChange?.(false);
      throw err;
    }

    return ws;
  }

  // ═══════════════════════════════════════════════════════════════
  // Deactivate — save state, stop watcher, remove listeners
  // ═══════════════════════════════════════════════════════════════

  async deactivate(chatPanel: ChatCore): Promise<void> {
    this._active = false;

    // Save chat sessions
    try {
      await chatPanel.saveActiveSession(this.path);
    } catch {
      /* ignore */
    }

    // Stop watcher and clear backend state
    try {
      await rpc('workspace_deactivate');
    } catch {
      /* ignore */
    }

    // Remove all event listeners
    for (const unlisten of this._unlisteners) {
      try {
        unlisten();
      } catch {
        /* ignore */
      }
    }
    this._unlisteners = [];

    // Clear agent & memory
    // Stop all running sub-agents before clearing
    this.subAgentPool.stopAll();
    // Destroy runtime agents
    if (this.runtime) {
      for (const summary of this.runtime.listAgents()) {
        this.runtime.destroyAgent(summary.id);
      }
      this.runtime = null;
    }
    // Persist agent state before clearing
    if (this.agent) {
      this.agent.saveState('done').catch(() => {});
    }
    this.agent = null;
    try {
      await auraShutdown();
    } catch {
      /* ignore */
    }
    this.memoryManager = null;

    // Clear timers
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // setupAgent — build the LLM agent with hologram/coding/memory tools
  // ═══════════════════════════════════════════════════════════════

  async setupAgent(chatPanel: ChatCore): Promise<void> {
    if (this.agentSetupRunning) {
      this.agentSetupPending = true;
      return;
    }
    this.agentSetupRunning = true;
    try {
      await this._setupAgentInner(chatPanel);
    } finally {
      this.agentSetupRunning = false;
      if (this.agentSetupPending) {
        this.agentSetupPending = false;
        await this.setupAgent(chatPanel);
      }
    }
  }

  /** Plan-mode tool registry: shallow-copies only read-only tools from the given registry. */
  private _planRegistry(base: ToolRegistry): ToolRegistry {
    const out = new ToolRegistry();
    for (const t of base.filterReadOnly()) out.register(t);
    return out;
  }

  /** Read mode state from the panel store. Falls back to normal/ask. */
  private _modeState(): { collaborationMode: 'normal' | 'plan'; permissionMode: 'ask' | 'auto' | 'yolo' } {
    try {
      const ps = getPanelStore(this._storeId).getState();
      return { collaborationMode: ps.collaborationMode as any, permissionMode: ps.permissionMode as any };
    } catch (e) {
      console.warn('[Workspace] _modeState failed, falling back to normal/ask:', e);
      return { collaborationMode: 'normal', permissionMode: 'ask' };
    }
  }

  private async _setupAgentInner(chatPanel: ChatCore): Promise<void> {
    this._storeId = chatPanel.panelId;

    let settings = loadSettings();
    settings = await restoreSecrets(settings);

    // Initialize mode state from saved preferences
    const sAgent = settings.agent || {};
    const ps = getPanelStore(this._storeId).getState();
    if (sAgent.collaborationMode && ps.collaborationMode === 'normal') {
      ps.setCollaborationMode(sAgent.collaborationMode);
    }
    if (sAgent.permissionMode && ps.permissionMode === 'ask') {
      ps.setPermissionMode(sAgent.permissionMode);
    }

    const active = getActiveProvider(settings);

    const diag = `[Agent] provider=${active.name} keyLen=${(active.apiKey || '').length}`;
    this.onStatusChange?.(diag);
    bus.emit('agent:diag', { text: diag, ready: !!active.apiKey && active.apiKey.trim() !== '' });

    if (!active.apiKey || active.apiKey.trim() === '') {
      this.agent = null;
      chatPanel.setAgent(null as any);
      bus.emit('agent:diag', { text: `❌ 未检测到 API Key — provider="${active.name}" 的 Key 为空。`, ready: false });
      return;
    }

    persistSecrets(settings).catch(() => {});

    // Load memories (global + project)
    let memorySection = '';
    let globalDir: string | undefined;
    try {
      globalDir = await rpc<string>('get_global_memory_dir');
    } catch {
      /* ignore */
    }
    this.memoryManager = new MemoryManager(this.path, globalDir);
    this.memoryManager.onSaved = (info) => {
      bus.emit('memory:saved', info);
      this.agent?.notifyMemorySaved(
        `记忆已更新: **${info.description || info.name}** (${info.confidence || 'reference'})`,
      );
    };
    const auraReady = this.memoryManager.initAura();
    try {
      memorySection = await this.memoryManager.loadPromptSection(extractGraphNodeNames(this.graphData));
    } catch (e) {
      console.error('[setupAgent] loadPromptSection failed:', e);
    }

    // Init agent state persistence + goal lifecycle + skill registry
    this.agentStore = new AgentStore(this.path);
    this.goalManager = new GoalManager(this.path, (r) => bus.emit('goal:state', r));
    this.goalManager.migrateLegacy().then(() => this.goalManager?.adoptOrphans()).catch(() => {});
    this.skillRegistry = new SkillRegistry(this.path);

    await auraReady;
    if (memorySection.trim()) {
      const memLines = memorySection.split('\n').filter((l) => l.startsWith('- ')).length;
      const globalCount = this.memoryManager?.scopes?.().includes('global') ? ' (含全局)' : '';
      this.onStatusChange?.(`[记忆] 已注入 ${memLines} 条${globalCount}`);
    }

    // ── Create Provider ──
    const prov: Provider = createProvider(active, {
      disableThinking: settings.agent?.disableThinking,
    });
    prov.prewarm?.();
    this.prov = prov;

    // ── Create Runtime + UI adapter ──
    const runtime = new AgentRuntime();
    const adapter = createRuntimeAdapter(this._storeId);
    runtime.setNotifier(adapter);
    runtime.setDiagnosticsSource(getDiagnosticsForFile);
    this.runtime = runtime;

    // ── Build graph context ──
    const graphCtx = buildGraphContextFromData(this.graphData);
    this._preflightCtx = graphCtx;

    // ── Build tool registry (via agent-builder, zero UI imports) ──
    const builderDeps: BuilderDeps = createBuilderDeps(this._storeId);
    const agentRef = { current: null as Agent | null };

    const registry = await buildToolRegistry({
      graphData: this.graphData,
      provider: prov,
      deps: builderDeps,
      memoryManager: this.memoryManager,
      skillRegistry: this.skillRegistry,
      taskManager: this.taskManager,
      subAgentPool: this.subAgentPool,
      subAgentSpawner: async (desc, prompt, prog, mode, al, sig) =>
        agentRef.current?.spawnSubAgent(desc, prompt, prog, mode, al, sig) ??
        Promise.resolve({ text: '', err: 'agent not available' }),
    });
    this.registry = registry;

    // Wire tool schemas to UI panel
    chatPanel.setToolSchemas(registry.schemas());

    // Cold-start: prime state caches
    refreshGitStatus(this.path).catch(() => {});
    refreshTimeline(this.path).catch(() => {});

    // ── Factory: creates fresh agent via runtime on each call ──
    const factory = async (): Promise<Agent | null> => {
      let s = loadSettings();
      s = await restoreSecrets(s);
      const act = getActiveProvider(s);
      if (!act.apiKey || act.apiKey.trim() === '') return null;

      const ms = this._modeState();
      const agentOpts = s.agent || {};

      const handle = await runtime.createAgent({
        agentId: 'main',
        parentId: null,
        projectPath: this.path,
        graphData: this.graphData,
        provider: prov,
        tools: registry,
        memoryManager: this.memoryManager ?? undefined,
        skillRegistry: this.skillRegistry ?? undefined,
        goalManager: this.goalManager ?? undefined,
        agentStore: this.agentStore ?? undefined,
        subAgentPool: this.subAgentPool,
        taskManager: this.taskManager,
        graphContext: graphCtx,
        eventSink: chatPanel.eventSink,
        execState: chatPanel.execState,
        collaborationMode: ms.collaborationMode,
        pricing: defaultPricing(act.kind, act.model),
        temperature: agentOpts.temperature ?? 0.7,
        contextWindow: agentOpts.contextWindow ?? 0,
        maxTokens: act.maxTokens ?? 0,
        preRunHook: this.memoryManager
          ? async (input: string) => {
              if (!this.memoryManager!.auraReady) return null;
              try {
                const records = await this.memoryManager!.auraSemanticRecall(input, 5);
                if (records.length === 0) return null;
                const lines = records.map((r) => {
                  const t = r.tags?.length ? `[${r.tags.join(', ')}] ` : '';
                  return `- ${t}${r.content.slice(0, 250)}`;
                });
                return `AuraSDK 语义记忆召回：\n${lines.join('\n')}`;
              } catch {
                return null;
              }
            }
          : undefined,
        onSessionPersisted: (_sid: string, messages: Array<{ role: string; content: unknown }>) => {
          memoryBundleIngest(
            messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
            'holo',
            _sid,
          ).catch(() => {});
          (async () => {
            await refreshGitStatus(this.path);
            await refreshTimeline(this.path);
            const block = buildTurnStartBlock();
            if (block) agentRef.current?.insertMessage(`<system-reminder>\n${block}\n</system-reminder>`, { silent: true });
          })().catch(() => {});
        },
      });

      const agent = (handle as any)._getAgent() as Agent;
      agentRef.current = agent;
      this.memoryManager?.prewarmAura();
      return agent;
    };

    // Register factory + create initial agent
    chatPanel.setAgentFactory(factory);
    const initialAgent = await factory();
    if (initialAgent) {
      this.agent = initialAgent;
      chatPanel.setAgent(initialAgent);
      this.onStatusChange?.('[Agent] ✅ 已就绪');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // runCheck — health check / briefing
  // ═══════════════════════════════════════════════════════════════

  async runCheck(): Promise<void> {
    if (!this.path) return;
    if (this.checkRunning) {
      this.checkPending = true;
      return;
    }
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }

    this.checkRunning = true;
    this.checkPending = false;
    try {
      const json = await rpc<string>('hologram_run_check', { path: this.path });
      try {
        const result: CheckResult = JSON.parse(json);
        const dock = useDockStore.getState();
        dock.setCheckResult(result);
        // 旧 loadAndRenderGate 实际等价于 open() — 每次简报后展开面板
        dock.openPanel('check');
        bus.emit('timeline:refresh');
        // Notify toolbar so it can show violation badge
        const cnt =
          (result.l5_violations?.length || 0) +
          (result.l4_violations?.length || 0) +
          (result.l3_violations?.length || 0) +
          (result.l2_violations?.length || 0);
        bus.emit('check:result', { passed: result.passed, violations: cnt });
        // Push status-bar notification — visible even when check panel is closed
        if (!result.passed) {
          this.onStatusChange?.(`⚠ 简报未通过: ${cnt} 条违规`);
        }
      } catch (parseErr) {
        console.error('[runCheck] JSON parse failed:', parseErr, 'raw:', json.slice(0, 200));
        this.onStatusChange?.('简报解析失败');
      }
    } catch (err: any) {
      console.error('Check failed:', err);
      this.onStatusChange?.('简报请求失败');
    } finally {
      this.checkRunning = false;
      if (this.checkPending) {
        this.checkPending = false;
        if (this.checkTimer) clearTimeout(this.checkTimer);
        this.checkTimer = setTimeout(() => {
          this.checkTimer = null;
          if (!this.checkRunning) this.runCheck();
        }, 2000);
      }
    }
  }

  /** Debounced check — call whenever agent writes files. 3s delay batches multiple writes. */
  scheduleCheck(): void {
    if (!this.path) return;
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      if (!this.checkRunning) this.runCheck();
    }, 3000);
  }

  // ═══════════════════════════════════════════════════════════════
  // doGraphUpdate — handle graph update from watcher (incremental if diff available)
  // ═══════════════════════════════════════════════════════════════

  doGraphUpdate(starGraph: StarGraph, diff?: any): void {
    if (!this.graphData) return;
    const nodeCount = Array.isArray(this.graphData.nodes)
      ? this.graphData.nodes.length
      : Object.keys(this.graphData.nodes || {}).length;
    // ponytail: incremental path — no clearGraph, no camera reset, local layout relax on new nodes
    if (diff && starGraph.hasGraph) {
      starGraph
        .applyGraphDiff(diff, this.graphData)
        .then(() => {
          this.onStatusChange?.(`已增量更新 (${nodeCount} 节点)`);
          this.runCheck();
        })
        .catch((e) => {
          console.error('[doGraphUpdate] incremental failed, falling back to full render:', e);
          starGraph.render(this.graphData);
          this.onStatusChange?.(`已更新 (${nodeCount} 节点)`);
          if (this.diffActive) {
            starGraph.clearDiff();
            this.diffActive = false;
          }
          this.runCheck();
        });
    } else {
      starGraph.render(this.graphData);
      this.onStatusChange?.(`已更新 (${nodeCount} 节点)`);
      if (this.diffActive) {
        starGraph.clearDiff();
        this.diffActive = false;
      }
      this.runCheck();
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// buildSystemPrompt — pure function, reads Workspace state
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// (dataflow trace Agent removed — engine queries replace it)
