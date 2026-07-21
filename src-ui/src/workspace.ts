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
import type { AgentUINotifier } from './agent/agent-types';
import { auraShutdown } from './agent/aura-memory';
import { createCompactionTools } from './agent/compaction-model';
import { SubAgentPool } from './agent/coordinator';
import { GoalManager } from './agent/goal-manager';
import type { GraphContext } from './agent/hooks';
import {
  buildFileNodeIndex,
  buildGraphSnapshot,
  createGraphContext,
  createGraphContextHook,
  createGraphPreflightHook,
  createStatePreflightHook,
  createStateReadHook,
  HookRegistry,
  PreflightHookRegistry,
} from './agent/hooks';
import { initLogger } from './agent/logger';
// ponytail: permission dialog now embedded inline via ChatPanel.showPermissionCard
import { createMemoryTools, MemoryManager } from './agent/memory';
import { memoryBundleIngest } from './agent/memory-bundle-client';
import { createSkillTool, SkillRegistry } from './agent/skills';
import { buildTurnStartBlock, refreshGitStatus, refreshTimeline } from './agent/state-inject';
import { createTaskTools, TaskManager } from './agent/task';
import type { Tool } from './agent/tool';
import { agentInvoke, createCodingTools, createSubAgentTool, type ToolExecutor, ToolRegistry } from './agent/tool';
import type { ChatCore } from './app/chat/chat-core';
import { listen, rpc } from './bridge';
import { createProvider } from './provider';
import { defaultPricing, getActiveProvider, loadSettings, persistSecrets, restoreSecrets } from './settings';
import { stripLineNumbers } from './ui/chat-session';
import { msgStoreForActive } from './ui/chat-store';
import { useDockStore } from './ui/dock-store';
import { bus } from './ui/events';
import type { StarGraph } from './ui/graph';
import { getDiagnosticsForFile } from './ui/lsp-client';
import type { SubAgentPart } from './ui/message-model';
import { getPanelStore } from './ui/panel-store';
import type { CheckResult } from './ui/react/CheckPanel';
import { createSubAgentSink } from './ui/subagent-sink';

// ═══════════════════════════════════════════════════════
// Dynamic tool loading from engine registry
// ═══════════════════════════════════════════════════════

interface McpSchema {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

async function loadHologramSchemas(): Promise<McpSchema[]> {
  try {
    const raw = await rpc<string>('hologram_tools_list');
    return JSON.parse(raw) as McpSchema[];
  } catch {
    return [];
  }
}

function mcpSchemaToTool(schema: McpSchema, exec: ToolExecutor): Tool {
  const required = schema.inputSchema.required || [];
  return {
    name: () => schema.name,
    description: () => schema.description,
    parameters: () => ({
      type: 'object',
      properties: schema.inputSchema.properties,
      required,
    }),
    readOnly: () => !['analyze_project', 'validate_project', 'rename_symbol'].includes(schema.name),
    execute: (args: Record<string, unknown>) => exec(schema.name, args),
  };
}

import type { Provider } from './provider/types';
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
    // Fan out memory saves: UI bus (panels) + live agent mid-session injection.
    // (The agent core no longer listens to the bus itself — one-way boundary.)
    this.memoryManager.onSaved = (info) => {
      bus.emit('memory:saved', info);
      this.agent?.notifyMemorySaved(
        `记忆已更新: **${info.description || info.name}** (${info.confidence || 'reference'})`,
      );
    };
    // Start Aura init early — runs in parallel with file I/O below
    const auraReady = this.memoryManager.initAura();
    const graphNodes = extractGraphNodeNames(this.graphData);
    try {
      memorySection = await this.memoryManager.loadPromptSection(graphNodes);
    } catch (e) {
      console.error('[setupAgent] loadPromptSection failed:', e);
    }

    // Load project conventions (CLAUDE.md) — same file Claude Code reads
    let _claudeMdSection = '';
    try {
      const filesPath = `${this.path}/CLAUDE.md`;
      _claudeMdSection = await rpc<string>('read_file_content', { filePath: filesPath });
    } catch {
      /* file missing is fine */
    }

    // Init agent state persistence
    this.agentStore = new AgentStore(this.path);
    // Init goal lifecycle store — 旧格式迁移 + 崩溃孤儿接管,必须先于任何 /goal 新建
    this.goalManager = new GoalManager(this.path, (r) => bus.emit('goal:state', r));
    this.goalManager
      .migrateLegacy()
      .then(() => this.goalManager?.adoptOrphans())
      .catch(() => {});

    // Init skill registry (hot-loads on first Skill tool call)
    this.skillRegistry = new SkillRegistry(this.path);

    // ponytail: AuraSDK per-turn recall — no startup recall, hook fires on each user message
    await auraReady;
    // ponytail: 记忆注入可观测性 — 启动时打印加载了多少条
    if (memorySection.trim()) {
      const memLines = memorySection.split('\n').filter((l) => l.startsWith('- ')).length;
      const globalCount = this.memoryManager?.scopes?.().includes('global') ? ' (含全局)' : '';
      this.onStatusChange?.(`[记忆] 已注入 ${memLines} 条${globalCount}`);
    }

    const prov: Provider = createProvider(active, {
      disableThinking: settings.agent?.disableThinking,
    });

    const registry = new ToolRegistry();

    // Hologram tools — dynamic from engine registry
    if (this.graphData) {
      const holoExec: ToolExecutor = async (name, args) => {
        const result = await rpc<string>('hologram_call', { tool: name, args });
        return typeof result === 'string' ? result : JSON.stringify(result);
      };
      const schemas = await loadHologramSchemas();
      for (const tool of schemas.map((s) => mcpSchemaToTool(s, holoExec))) {
        registry.register(tool);
      }
      dbg('setupAgent', `${schemas.length} hologram tools registered (dynamic)`);

      // dataflow_save / dataflow_query — Tauri commands, not MCP tools
      registry.register({
        name: () => 'dataflow_save',
        description: () =>
          '保存数据流追踪结果到 .hologram/dataflow/，供面板查看和后续查询。content 是你写的结构化追踪报告（markdown），会直接渲染给用户。query 是用户原始问题，用于索引。一次追踪调一次 save。',
        parameters: () => ({
          type: 'object',
          properties: {
            query: { type: 'string', description: '用户原始查询，用于面板列表展示和后续检索' },
            content: {
              type: 'string',
              description:
                '追踪报告内容（markdown）。描述完整数据流链路、节点角色（entry/buffer/consumer/sink）、关键变量、文件位置。会原样渲染给用户。',
            },
            exploreResult: { type: 'string', description: 'explore_deps 返回的完整 JSON 字符串（可选）' },
            dataflowResult: { type: 'string', description: 'trace_dataflow 返回的完整 JSON 字符串（可选）' },
          },
          required: ['query', 'content'],
        }),
        readOnly: () => false,
        execute: async (args) => {
          const result = await agentInvoke('dataflow_save', args);
          bus.emit('dataflow:saved');
          return result;
        },
      });
      registry.register({
        name: () => 'dataflow_query',
        description: () =>
          '查询已保存的数据流追踪结果。traceId 为空时列出所有已存追踪的摘要（traceId/query/createdAt）。传 traceId 加载完整追踪内容。用于回顾之前的分析结论、对比变更前后的数据流。',
        parameters: () => ({
          type: 'object',
          properties: {
            traceId: {
              type: 'string',
              description: '追踪 ID（如 df_20260705T143000000）。不传则列出所有已存追踪摘要。',
            },
            list: { type: 'boolean', description: '传 true 返回轻量摘要列表（不传 traceId 时默认开启）' },
          },
        }),
        readOnly: () => true,
        execute: (args) => agentInvoke('dataflow_query', args),
      });
    }

    // Coding tools
    // ── Active shell stream cleanups ──
    // Keys are streamIds; values are unlisten functions.
    // Cleaned up on new shell start, shell:done, or agentInvoke error.
    const _shellCleanups = new Map<string, Array<() => void>>();
    const SHELL_DONE_TIMEOUT_MS = 600_000; // 10 min — matches Rust max timeout

    const codingExec: ToolExecutor = async (name, args, onProgress) => {
      if (name === 'run_shell' && args.runInBackground) {
        const taskId = await agentInvoke<string>('run_shell', args);
        let done = false;
        while (!done) {
          await new Promise((r) => setTimeout(r, 300));
          try {
            const status: any = await agentInvoke<any>('bash_output', { taskId });
            if (status.output && onProgress) onProgress(status.output);
            if (status.done) {
              done = true;
              return status.output || '(无输出)';
            }
          } catch {
            done = true;
            return '(后台任务已结束)';
          }
        }
        return '';
      }
      // ── Streaming shell: real-time output via Tauri events ──
      if (name === 'exec_command' && onProgress && !args.runInBackground) {
        const streamId = `shell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        // Clean up stale listeners from abandoned Promises (e.g. agent abort)
        for (const cleanups of _shellCleanups.values()) {
          for (const fn of cleanups) fn();
        }
        _shellCleanups.clear();

        return new Promise<string>((resolve) => {
          void (async () => {
            let fullOutput = '';
            let doneTimer: ReturnType<typeof setTimeout> | null = null;
            let settled = false;

            const cleanup = () => {
              if (doneTimer !== null) {
                clearTimeout(doneTimer);
                doneTimer = null;
              }
              const fns = _shellCleanups.get(streamId);
              if (fns) {
                for (const fn of fns) fn();
                _shellCleanups.delete(streamId);
              }
            };

            const resolveOnce = (value: string) => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(value);
            };

            // await both listen() so unsub fns are set before any event can fire
            const unsubOutput = await listen<{ streamId: string; kind: string; chunk: string }>(
              'shell:output',
              (event) => {
                if (event.payload.streamId !== streamId) return;
                fullOutput += event.payload.chunk;
                onProgress(event.payload.chunk);
              },
            );

            const unsubDone = await listen<{ streamId: string; exitCode: number; error?: string }>(
              'shell:done',
              (event) => {
                if (event.payload.streamId !== streamId) return;
                if (event.payload.error) {
                  resolveOnce(`[exit code: ${event.payload.exitCode}]\n${event.payload.error}`);
                } else if (event.payload.exitCode !== 0) {
                  resolveOnce(`[exit code: ${event.payload.exitCode}]\n${fullOutput}`);
                } else {
                  resolveOnce(fullOutput || '(无输出)');
                }
              },
            );

            _shellCleanups.set(streamId, [unsubOutput, unsubDone]);

            // Timeout guard: if shell:done never fires (Rust thread crashed etc.)
            doneTimer = setTimeout(() => {
              resolveOnce(
                `[exit code: -1]\n错误: shell 超时 (${SHELL_DONE_TIMEOUT_MS / 1000}s)，未收到 shell:done 事件`,
              );
            }, SHELL_DONE_TIMEOUT_MS);

            try {
              await agentInvoke<string>('exec_command', { ...args, streamToolId: streamId });
              // Streaming path: Rust returns {"status":"started"} immediately.
              // We wait for shell:done (or timeout) to resolve.
            } catch (e: any) {
              resolveOnce(`错误: ${e}`);
            }
          })();
        });
      }
      const result = await agentInvoke<string>(name, args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    };
    for (const tool of createCodingTools(codingExec, prov, { askUser: (req) => bus.emit('prompt:ask', req) })) {
      registry.register(tool);
    }

    // Aliases — short names for high-frequency tools
    registry.alias('read_file', 'read_file_content');
    // ponytail: symbol_history / cluster_report now first-class in all_schemas() — no aliases needed

    // Skill tool (always registered — hot-loads on call)
    if (this.skillRegistry) {
      registry.register(createSkillTool(this.skillRegistry));
    }

    // Memory tools
    if (this.memoryManager) {
      for (const tool of createMemoryTools(this.memoryManager)) {
        registry.register(tool);
      }
    }

    // Compaction stats tool — ponytail: extracted helper, used in both main agent and factory
    const registerCompactionTools = (agent: Agent, reg: ToolRegistry): void => {
      for (const tool of createCompactionTools(
        () => agent.getCompactionTracker(),
        () => agent.getPricing(),
        () => ({
          compactRatio: agent.getCompactRatio(),
          recentKeep: agent.getRecentKeep(),
          contextWindow: agent.getContextWindow(),
        }),
        async () => agent.loadCompactionConfig(),
      )) {
        reg.register(tool);
      }
    };
    // Task tracking tools
    for (const tool of createTaskTools(this.taskManager)) {
      registry.register(tool);
    }

    // ── Store shared state (Agent creation moved to factory below) ──
    this.prov = prov;
    this.registry = registry; // plan-mode filtering handled per-session in factory

    // Wire tool schemas to UI panel — dynamic, not hardcoded
    chatPanel.setToolSchemas(registry.schemas());

    // Cold-start: prime state caches (git status, timeline)
    refreshGitStatus(this.path).catch(() => {});
    refreshTimeline(this.path).catch(() => {});

    // ── Agent factory — single source of truth for Agent creation ──
    // Used for both initial agent and new-session creation.
    {
      const mm = this.memoryManager;
      const hookCtx = this.graphData
        ? (() => {
            const { fileIndex, fanIn, fanOut } = buildFileNodeIndex(this.graphData);
            return createGraphContext(fileIndex, fanIn, fanOut);
          })()
        : null;

      const factory = async (): Promise<Agent | null> => {
        let s = loadSettings();
        s = await restoreSecrets(s);
        const act = getActiveProvider(s);
        if (!act.apiKey || act.apiKey.trim() === '') return null;

        // Clone shared tool registry — all workspace-level tools
        const r = new ToolRegistry();
        for (const t of this.registry?.all() ?? []) r.register(t);

        // Sub-agent tools — per-Agent lifecycle, wired via agentRef indirection.
        // The spawner delegates to Agent.spawnSubAgent, which merges the pool's
        // abort signal with the agent's current run signal (real stop/timeout).
        const agentRef = { current: null as Agent | null };
        r.register(
          createSubAgentTool(
            async (description, prompt, onProgress, mode, allowlist, coordSignal) =>
              agentRef.current?.spawnSubAgent(description, prompt, onProgress, mode, allowlist, coordSignal) ??
              Promise.resolve({ text: '', err: 'agent not available' }),
            this.subAgentPool,
          ),
        );

        // UI notification port — the agent core emits domain signals, the UI
        // side owns ALL rendering concerns (bus events, SubAgentPart, bumps).
        const subParts = new Map<string, SubAgentPart>();
        const bumpStore = () => msgStoreForActive(this._storeId)?.getState().bump();
        const uiNotifier: AgentUINotifier = {
          progress: (step, toolName) => bus.emit('agent:progress', { step, toolName }),
          toolDone: (toolName, args, output) => bus.emit('agent:tool-done', { toolName, args, output }),
          subAgentSpawn: (info, onProgress) => {
            const store = msgStoreForActive(this._storeId);
            if (!store) return undefined;
            const subPart: SubAgentPart = {
              type: 'subagent',
              agentId: info.agentId,
              description: info.description,
              status: 'running',
              parts: [],
              version: 0,
            };
            subParts.set(info.agentId, subPart);
            const msgs = store.getState().messages;
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i];
              if (m.role === 'assistant' && (m as any).status === 'streaming') {
                (m as any).parts.push(subPart);
                break;
              }
            }
            bumpStore();
            return createSubAgentSink({ subPart, bump: bumpStore, onProgress });
          },
          subAgentFinished: (id, ok) => {
            const part = subParts.get(id);
            if (part) {
              part.status = ok ? 'done' : 'error';
              subParts.delete(id);
            }
            bumpStore();
          },
        };

        // Build system prompt (per-session, with memory section)
        let memSection = '';
        if (mm) {
          try {
            const graphNodes = this.graphData ? extractGraphNodeNames(this.graphData) : undefined;
            memSection = await mm.loadPromptSection(graphNodes);
          } catch {
            /* ignore */
          }
        }
        let claudeMd = '';
        try {
          claudeMd = await rpc<string>('read_file_content', { filePath: `${this.path}/CLAUDE.md` });
        } catch {
          /* file missing is fine */
        }

        const snap = this.graphData ? buildGraphSnapshot(this.graphData) : '';
        const mode = this._modeState();
        const sysPrompt = buildSystemPrompt(this, memSection, snap, claudeMd, mode.collaborationMode, active.name);
        const effR = mode.collaborationMode === 'plan' ? this._planRegistry(r) : r;

        const agentOpts = s.agent || {};
        const newAgent = new Agent(this.prov!, effR, sysPrompt, {
          agentId: 'main',
          parentId: null,
          eventSink: chatPanel.eventSink,
          execState: chatPanel.execState,
          onSessionPersisted: (_sid: string, messages: Array<{ role: string; content: unknown }>) => {
            memoryBundleIngest(
              messages.map((m) => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
              })),
              'holo',
              _sid,
            ).catch(() => {});
            (async () => {
              await refreshGitStatus(this.path);
              await refreshTimeline(this.path);
              const block = buildTurnStartBlock();
              if (block) newAgent.insertMessage(`<system-reminder>\n${block}\n</system-reminder>`, { silent: true });
            })().catch(() => {});
          },
          pricing: defaultPricing(act.kind, act.model),
          temperature: agentOpts.temperature ?? 0.7,
          contextWindow: agentOpts.contextWindow ?? 0,
          maxTokens: act.maxTokens ?? 0,
          ui: uiNotifier,
        });

        newAgent.setCompactionConfigPath(this.path);
        newAgent.setAgentStore(this.agentStore!);
        newAgent.setGoalManager(this.goalManager!);
        newAgent.applyAutoTuneConfig().catch(() => {});
        newAgent.setSubAgentPool(this.subAgentPool);
        agentRef.current = newAgent; // wire for sub-agent notifications + spawn

        // Compaction stats tool (needs Agent reference)
        registerCompactionTools(newAgent, r);

        // Graph context hooks
        if (hookCtx) {
          loadEngineSnapshot(hookCtx, this.path).catch(() => {});
          const hooks = new HookRegistry();
          hooks.register(createGraphContextHook(hookCtx));
          hooks.register(createStateReadHook(this.path, getDiagnosticsForFile));
          newAgent.setHooks(hooks);
          const preflightHooks = new PreflightHookRegistry();
          preflightHooks.register(createGraphPreflightHook(hookCtx));
          preflightHooks.register(createStatePreflightHook(getDiagnosticsForFile));
          newAgent.setPreflightHooks(preflightHooks);
          this._preflightCtx = hookCtx;

          // Per-turn AuraSDK recall
          if (mm) {
            newAgent.setPreRunHook(async (input: string) => {
              if (!mm.auraReady) return null;
              try {
                const records = await mm.auraSemanticRecall(input, 5);
                if (records.length === 0) return null;
                const lines = records.map((r) => {
                  const tagStr = r.tags?.length ? `[${r.tags.join(', ')}] ` : '';
                  return `- ${tagStr}${r.content.slice(0, 250)}`;
                });
                return `AuraSDK 语义记忆召回（当前问题的相关历史记忆，仅供参考——文件记忆更权威）：\n${lines.join('\n')}`;
              } catch {
                return null;
              }
            });
          }
        }

        return newAgent;
      };

      // Register for future new-session creation
      chatPanel.setAgentFactory(factory);

      // Create initial agent immediately
      const initialAgent = await factory();
      if (initialAgent) {
        this.agent = initialAgent;
        chatPanel.setAgent(initialAgent);
        this.onStatusChange?.('[Agent] ✅ 已就绪');
      }
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
// loadEngineSnapshot — fetch engine-level data for enriched preflight
// Called once at Agent startup (baseline), then after each write tool
// to compute session drift against the baseline.
// ═══════════════════════════════════════════════════════════════

async function loadEngineSnapshot(ctx: GraphContext, projectPath: string, isRefresh = false): Promise<void> {
  try {
    // Fire all four engine queries in parallel
    const [fragileRaw, cycleRaw, healthRaw, blindspotsRaw] = await Promise.all([
      rpc<string>('hologram_call', { tool: 'fragile_modules', args: { limit: 15 } }),
      rpc<string>('hologram_call', { tool: 'detect_cycles', args: { mode: 'all' } }),
      rpc<string>('hologram_call', { tool: 'project_health', args: { path: projectPath, days: 30 } }),
      rpc<string>('hologram_call', { tool: 'arch_blindspots', args: { filter: 'all' } }).catch(
        () => '{"blindspots":[]}',
      ),
    ]);

    // ── Fragility (分析引擎) ──
    const fragileData = JSON.parse(fragileRaw);
    const fragilityRanks: Array<{ file: string; score: number }> = [];
    if (fragileData.fragile_modules || fragileData.modules) {
      const list = fragileData.fragile_modules || fragileData.modules;
      for (const m of list) {
        fragilityRanks.push({
          file: m.file || m.module || '',
          score: m.fragility_score || m.score || 0,
        });
      }
    }

    // ── Cycles (分析引擎) ──
    const cycleData = JSON.parse(cycleRaw);
    const cycleCount = cycleData.total_cycles || cycleData.cycles?.length || 0;

    // ── Health (分析引擎) ──
    const healthData = JSON.parse(healthRaw);
    const healthScore = healthData.coupling_density_score || healthData.score || 0;

    // ── Synthesis alerts (合成引擎) ──
    const blindspotsData = JSON.parse(blindspotsRaw);
    const synthesisAlerts: Array<{ type: string; count: number; detail: string }> = [];
    const rawBlindspots = blindspotsData.blindspots || blindspotsData.alerts || [];
    const typeCounts = new Map<string, number>();
    for (const b of rawBlindspots) {
      const t = b.type || b.kind || 'unknown';
      typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
    }
    for (const [type, count] of typeCounts) {
      synthesisAlerts.push({ type, count, detail: `${count} detected in project` });
    }

    // ── LSP hotspots: derive from fragility ranks (top-caller symbols) ──
    const lspHotspots: Array<{ file: string; symbol: string; callers: number }> = [];
    for (const r of fragilityRanks.slice(0, 5)) {
      if (r.score > 100) {
        lspHotspots.push({
          file: r.file,
          symbol:
            r.file
              .split('/')
              .pop()
              ?.replace(/\.[^.]+$/, '') || '',
          callers: Math.round(r.score / 10),
        });
      }
    }

    // ── LSP real call resolution: resolve_call on top 3 fragile files ──
    const lspCallers = new Map<string, Array<{ symbol: string; count: number }>>();
    for (const r of fragilityRanks.slice(0, 3)) {
      try {
        const resolveRaw = await rpc<string>('hologram_call', {
          tool: 'resolve_call',
          args: { file: r.file },
        }).catch(() => '{}');
        const resolveData = JSON.parse(resolveRaw);
        if (resolveData.calls && Array.isArray(resolveData.calls)) {
          // Aggregate caller counts per function
          const funcCallers = new Map<string, number>();
          for (const c of resolveData.calls) {
            const fn = c.callee || c.function || c.name || '';
            if (fn) funcCallers.set(fn, (funcCallers.get(fn) || 0) + 1);
          }
          const sorted = [...funcCallers.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([symbol, count]) => ({ symbol, count }));
          if (sorted.length > 0) lspCallers.set(r.file, sorted);
        }
      } catch {
        /* per-file LSP can fail silently */
      }
    }

    // ── Semantic neighbors: search_symbols on top fragile module names ──
    const semanticNeighbors = new Map<string, Array<{ name: string; file: string }>>();
    for (const r of fragilityRanks.slice(0, 3)) {
      const symbol =
        r.file
          .split('/')
          .pop()
          ?.replace(/\.[^.]+$/, '') || '';
      if (!symbol) continue;
      try {
        const searchRaw = await rpc<string>('hologram_call', {
          tool: 'search_symbols',
          args: { query: symbol, limit: 5 },
        }).catch(() => '{"results":[]}');
        const searchData = JSON.parse(searchRaw);
        const results = searchData.results || [];
        const neighbors = results
          .filter((s: any) => (s.name || '').toLowerCase() !== symbol.toLowerCase())
          .slice(0, 3)
          .map((s: any) => ({ name: s.name || '', file: s.location || s.file || '' }));
        if (neighbors.length > 0) semanticNeighbors.set(r.file, neighbors);
      } catch {
        /* search can fail silently */
      }
    }

    // ── Baseline / drift ──
    let baselineFragility: Map<string, number>;
    let sessionDrift = 0;

    if (!isRefresh && !ctx.engine) {
      baselineFragility = new Map<string, number>();
      for (const r of fragilityRanks) {
        baselineFragility.set(r.file, r.score);
      }
    } else {
      const prev = ctx.engine?.baselineFragility;
      if (prev && prev.size > 0) {
        let delta = 0;
        for (const r of fragilityRanks) {
          const before = prev.get(r.file) ?? 0;
          if (r.score > before) delta += (r.score - before) / Math.max(before, 1);
        }
        sessionDrift = delta;
      }
      baselineFragility = ctx.engine?.baselineFragility ?? new Map();
    }

    ctx.engine = {
      fragilityRanks,
      cycleCount,
      healthScore,
      baselineFragility,
      sessionDrift,
      lspHotspots,
      lspCallers,
      synthesisAlerts,
      semanticNeighbors,
      vectorReady: semanticNeighbors.size > 0,
    };
  } catch (e) {
    console.warn('[loadEngineSnapshot] engine data unavailable, preflight runs in lightweight mode:', e);
  }
}

/** Debounced refresh of engine snapshot after a file-modifying tool completes.
 *  Fires at most once per 3 seconds — multiple rapid edits batch into one refresh. */
let _snapshotRefreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleEngineSnapshotRefresh(ctx: GraphContext, projectPath: string): void {
  if (_snapshotRefreshTimer) clearTimeout(_snapshotRefreshTimer);
  _snapshotRefreshTimer = setTimeout(() => {
    _snapshotRefreshTimer = null;
    loadEngineSnapshot(ctx, projectPath, true).catch(() => {});
  }, 3000);
}

// ═══════════════════════════════════════════════════════════════
// buildSystemPrompt — pure function, reads Workspace state
// ═══════════════════════════════════════════════════════════════

/** Extract node names from graph data for memory relevance filtering.
 *  ponytail: simple array extract — graphData.nodes contains file/symbol paths. */
function extractGraphNodeNames(graphData: unknown): string[] | undefined {
  if (!graphData || typeof graphData !== 'object') return undefined;
  const gd = graphData as Record<string, unknown>;
  const nodes = gd.nodes;
  if (!nodes) return undefined;
  if (Array.isArray(nodes)) {
    return nodes
      .map((n: unknown) => {
        if (typeof n === 'string') return n;
        if (typeof n === 'object' && n !== null) {
          const obj = n as Record<string, unknown>;
          return String(obj.id || obj.name || obj.file || '');
        }
        return '';
      })
      .filter(Boolean);
  }
  if (typeof nodes === 'object') {
    return Object.keys(nodes as Record<string, unknown>);
  }
  return undefined;
}

export function buildSystemPrompt(
  ws: Workspace,
  memorySection = '',
  graphSnapshot = '',
  claudeMdSection = '',
  collaborationMode: 'normal' | 'plan' = 'normal',
  providerName?: string,
): string {
  const modelIdentity = providerName === 'anthropic'
    ? '你的后端 API 是 Anthropic (Claude)。任何关于模型品牌的问题，回答"Claude（由 HoloGram 调度）"。'
    : `你的后端 API 是 ${providerName || 'DeepSeek'}。任何关于模型品牌的问题，回答"${providerName || 'DeepSeek'}（由 HoloGram 调度）"。`;
  const modelNegation = providerName === 'anthropic'
    ? '你可以承认自己是 Claude，但需说明你运行在 HoloGram 调度框架中。'
    : '你不是 Claude、不是 Anthropic 模型，不要声称自己是 Claude 或 Anthropic 的产品。';

  if (!ws.graphData) {
    let prompt = `你是 HoloGram 全息观测站的 AI 架构分析助手。当前没有加载项目，可以进行一般性对话。

## 模型身份（必须遵守）
- **${modelNegation}**
- **${modelIdentity}**
- 禁止编造"Claude 家族标志性风格"等理由来解释你的行为。

身份：你是一个代码架构分析专家，擅长依赖图分析、重构风险评估、架构健康诊断。
语言：始终用中文回复。代码和文件名用原样标记。
行为：诚实——不确定的事不说。工具返回空结果不要编造。提示用户可能需要加载项目。`;

    if (memorySection.trim()) {
      prompt += `\n\n## 记忆库\n${memorySection}\n\n> ⚠️ 记忆是写入时的快照。引用的文件名、函数名、路径可能已过时。基于记忆推荐任何文件或函数前，先用 glob/grep 确认它仍然存在。发现过时记忆 → 调 hologram_memory_save 更新或 hologram_memory_delete 删除。`;
    }
    if (collaborationMode === 'plan') {
      prompt += `\n\n## 规划模式（当前激活）\n你处于规划模式。只能使用只读工具分析代码和设计方案，不能执行任何修改操作。\n- 用 \`ask_user\` 向用户确认方案\n- 方案确定后，让用户切换到正常模式再执行\n- 不要调用任何写工具`;
    }
    return prompt;
  }
  const nodes = ws.graphData.nodes
    ? Array.isArray(ws.graphData.nodes)
      ? ws.graphData.nodes.length
      : Object.keys(ws.graphData.nodes).length
    : 0;
  const edges = ws.graphData.edges
    ? Array.isArray(ws.graphData.edges)
      ? ws.graphData.edges.length
      : Object.keys(ws.graphData.edges).length
    : 0;
  return `你是 HoloGram 全息观测站的 AI 架构分析助手。你的任务是用依赖图分析工具帮用户理解代码库、评估变更风险、诊断架构问题。

## 模型身份（必须遵守）
- **你不是 Claude、不是 Anthropic 模型，不要声称自己是 Claude 或 Anthropic 的产品。**
- **${modelIdentity}**
- 禁止编造"Claude 家族标志性风格"等理由来解释你的行为。

## 身份
- 代码架构分析专家，擅长依赖图分析、重构风险评估、架构健康诊断
- 你能直接调用 ${ws.path || '项目'} 的依赖图数据（${nodes} 节点、${edges} 条边）
- 你看到的图已被分析引擎预处理，节点代表函数/类/模块/文件，边代表调用/继承/导入/时序关系
${graphSnapshot ? `\n## 项目架构快照\n\`\`\`\n${graphSnapshot}\n\`\`\`\n` : ''}${
  collaborationMode === 'plan'
    ? `
## ⚠️ 规划模式（当前激活）

你处于**只读规划模式**。你的工具集中只有分析、搜索、读取类工具，没有任何写操作工具。
- **能做**：搜索代码、分析架构、追踪依赖、诊断问题、设计重构方案
- **不能做**：写文件、改代码、跑构建、Git commit、改记忆
- **行为准则**：用户让你"修"时，给出详细方案（改哪个文件、怎么改、为什么），然后用 \`ask_user\` 请用户确认方案、切换到正常模式
- **强制**：绝不要尝试调用写工具——它们不存在于你的工具集中，调用只会返回错误
`
    : ''
}
## 核心规则
1. **诚实**：工具返回空结果就说"未找到"。数据正常就说"无异常"。不要编造节点名或关系，也不要为了显得"有发现"而夸大正常数据。
2. **精确**：引用节点名时用图表中的准确名称。不确定就用工具查。
3. **结构化**：用分点、表格、小结组织回答。先说结论再讲细节。
4. **中文**：始终用中文回复。代码标识符和文件名用反引号标记。
5. **先查后说**：任何涉及代码库的问题都必须调工具，不要凭"常识"猜测。修改代码前注意工具返回结果顶部的 ⚠️ 自动影响分析——如果显示 MEDIUM 或 HIGH 风险，先调 trace_impact 确认波及范围再动手。
6. **正常即正常**：工具数据不显示问题时，直接说"无异常"或"改动安全"。不要为了填充模板把低风险数据夸大为问题。遇到排名类工具（fragile/cycle），排名靠前不等于"坏了"——高耦合模块可能是设计中的枢纽。
7. **${collaborationMode === 'plan' ? '只规划不执行' : '能动手就别只建议'}**：${collaborationMode === 'plan' ? '你没有写文件和运行命令的工具。用户说"修"时，输出详细方案，包含修改的文件、具体改动、前后对比，然后建议用户切换到正常模式执行' : '你有写文件、跑命令、Git 操作的工具。用户说"修"就直接修，不要只说"建议修改"。修完后跑相关测试确认没炸'}。
8. **不确定就问**：需求模糊、两个方案选不定、或即将执行危险操作时，用 \`ask_user\` 工具反问用户。不要猜。
9. **别用 run_shell 找文件/搜代码/操作 Git**：\`run_shell\` 只用于构建、测试、包管理等必须 shell 的操作。找文件用 \`glob\`（文件名模式），搜文本用 \`search_content\`（内容搜索），看目录用 \`list_directory\`。Git 操作用专用工具：\`git_status\`（状态）、\`git_diff\`（差异）、\`git_stage\`（暂存）、\`git_commit\`（提交）、\`git_push\`（推送）、\`git_pull\`（拉取）、\`git_log\`（日志）、\`git_checkout\`（切换分支）等。禁止用 \`run_shell\` 跑 ls/find/grep/cat/head/tail/sed/awk/git。
10. **别复读工具输出**：工具已经返回的结果不要原文照搬到回复里。用户能看到工具卡片里的内容。你只需要提炼关键结论和行动。
11. **${collaborationMode === 'plan' ? '方案必须具体' : '修改必须展示代码'}**：${collaborationMode === 'plan' ? '推荐的修改方案要精确到文件路径和代码片段，给出修改前后的 diff 对比，让用户在正常模式下可以直接交给 Agent 执行' : '用 `edit_file` 或 `write_file` 做完修改后，贴出修改前后的关键代码片段（不要贴整个文件），并标注文件路径和行号'}。

## 工具地图 — 什么问题用什么工具

### 日常查询
| 用户问 | 用这个工具 |
|--------|----------|
| "分析 / 重新分析这个项目" | \`analyze_project\` — 跑全量分析，生成完整依赖图 |
| 找 "auth" / "parse" / "config" 相关的东西 | \`search_symbols\` — 模糊搜索节点（不用知道精确 ID） |
| "XXX 是什么？连了哪些东西？" | \`get_neighbors\` 查邻居 |
| "改 XXX 会炸吗？" | \`trace_impact\` 追踪波及范围 |
| "从 A 到 B 怎么走？" | \`find_dep_path\` 找依赖路径 |
| "项目整体怎么样？" | \`graph_summary\` 看统计 |
| "XXX 的修改历史？" | \`symbol_history\` 看节点变更记录 |
| "XXX 在哪个社区？" | \`get_community\` 看社区归属 |
| "最近的变更？" | \`project_timeline\` 看变更摘要 |

### 架构分析
| 用户问 | 用这个工具 |
|--------|----------|
| "哪些模块依赖最多/耦合最深？" | \`fragile_modules\` — 按耦合深度和扇入排名（高排名≠坏了，核心枢纽天然排名高） |
| "有循环依赖吗？" | \`detect_cycles\` — 检测环（小环常见于 UI 回调，不一定需要修） |
| "耦合面怎么样？" | \`coupling_report\` — 某个模块的耦合深度分布 |
| "跨边界边/动态分发？" | \`arch_blindspots\` — 运行时耦合模式（插件系统/DI 的动态边是正常的） |
| "线程/协程冲突？" | \`thread_conflicts\` — 线程安全检测 |
| "延迟/时序边？" | \`async_edges\` — 实时/周期性依赖 |
| "项目最近怎么样？" | \`project_health\` — 耦合密度趋势分析 |

### 变更风险评估
| 用户问 | 用这个工具 |
|--------|----------|
| "这次改了什么？" | \`graph_diff\` — 对比两个版本的图差异 |
| "变更前置检查？" | \`preflight_check\` — 指定文件列表，模拟影响 |
| "完整检查？" | \`validate_project\` — 跑约束校验 + 信号分析 |

### 数据流探索
| 用户问 | 用这个工具 |
|--------|----------|
| "logBuffer 的数据流是什么？" | \`explore_deps\`（query="logBuffer 数据流"）— 引擎实时解析符号、追踪数据流路径、返回关系+源码+依赖者 |
| "X 的下游影响是什么？" | \`trace_impact\` 或 \`explore_deps\` — 沿调用图追踪波及范围 |
| "X 和 Y 之间怎么调的？" | \`find_dep_path\` — 找最短调用路径 |
| "X 函数读写了哪些变量？" | \`trace_dataflow\` — tree-sitter 精确分析 per-function reads/writes/triggers |

### 文件与搜索
| 用户问 | 用这个工具 |
|--------|----------|
| "看看这个文件" | \`read_file\` (\`read_file_content\`) — 读取源文件内容 |
| "XX 函数在哪定义的？" | \`search_content\` — 全项目文本搜索（支持字面量+正则） |
| "找出所有 *.rs 文件" | \`glob\` — 文件模式匹配（支持 ** 递归，如 "**/*.rs"） |
| "项目目录结构？" | \`list_directory\` — 列出目录内容 |
| "约束规则是啥？" | \`read_constraints\` — 查看项目的 hologram.constraints.yaml |

### ${collaborationMode === 'plan' ? '方案规划' : '编码操作'}
${
  collaborationMode === 'plan'
    ? `| 用户问 | 用这个工具 |
|--------|----------|
| "帮我设计重构方案" | 先用 \`explore_deps\` / \`search_content\` 理解现状 → \`trace_impact\` 预估影响 → 输出方案 |
| "这个改动安全吗？" | \`preflight_check\` 模拟影响 → \`trace_impact\` 追踪波及 → 给出风险评级 |
| "帮我分析架构问题" | \`fragile_modules\` / \`detect_cycles\` / \`arch_blindspots\` 诊断 → 给出建议 |
| "方案确认了" | 用 \`ask_user\` 请用户切换到正常模式后你再执行 |
| "看看 XXX 的实现" | \`read_file\` / \`search_content\` / \`inspect_symbol\` |
| "查一下 XXX 怎么用" | \`web_fetch\` — 抓取文档 |
| 需要用户确认/选择 | \`ask_user\` — 弹出对话框反问用户 |`
    : `| 用户问 | 用这个工具 |
|--------|----------|
| "帮我写个新文件" | \`write_file\` — 创建或覆盖整个文件 |
| "帮我改 XX 文件的某处" | \`edit_file\` — 精确字符串替换（推荐：安全、省 token） |
| "把 XXX 重命名为 YYY" | \`rename_symbol\` — 基于依赖图的全局重命名（先用 dryRun=true 预览） |
| "跑一下测试/build/安装依赖" | \`run_shell\` — 执行 shell 命令（支持超时 + 后台运行） |
| "后台任务怎么样了/停了它" | \`bash_output\` / \`bash_kill\` — 查看/终止后台任务 |
| "Git 状态/提交/推送/拉取" | \`git_status\` / \`git_commit\` / \`git_push\` / \`git_pull\` |
| "看看改了什么/提交记录" | \`git_diff\` / \`git_log\` |
| "查一下 XXX 怎么用" | \`web_fetch\` — 抓取 URL 全文（HTML→纯文本） |
| 需要用户确认/选择 | \`ask_user\` — 弹出对话框反问用户 |`
}

### 社区分析
| 用户问 | 用这个工具 |
|--------|----------|
| "有哪些社区/子系统？" | \`cluster_report\` — 社区检测结果 |
| "时间线？" | \`project_timeline\` — 变更时间线 |
${
  collaborationMode === 'plan'
    ? ''
    : `
### 委派子Agent
\`agent_spawn\` 会**阻塞直到子Agent完成**，子Agent的最终报告就是工具结果。用法：
- **大任务拆分**：独立、多文件的子任务委派出去，子Agent有干净上下文，只做这一件事
- **并行**：在**同一轮**发多个 \`agent_spawn\` 调用即可并行（例如 3 个模块各派一个调研Agent）
- **指令要自足**：子Agent看不到你的对话，prompt 里写清要做什么、涉及哪些文件、如何验证（跑什么命令确认没炸）
- **文件隔离**：fork 模式（默认）的文件修改在独立 worktree 中，成功后自动合并回主仓；合并冲突时 diff 会随结果返回，由你手动应用
- **别委派小事**：几次工具调用能做完的事自己做，委派的开销大于收益
`
}

### LSP 符号解析
| 用户问 | 用这个工具 |
|--------|----------|
| "X 函数调了什么？" | \`resolve_call\` — LSP 精确解析调用目标（非 grep 猜） |
| "X 的类型/接口定义？" | \`infer_type\` — 类型定义跳转 |
| "谁实现了 X 接口？" | \`find_implementations\` — 查找所有实现 |
| "X 在哪里被引用？" | \`find_references\` — 全项目引用追踪 |

## 工具组合模式

1. **全面体检**：\`graph_summary\` → \`fragile\` → \`cycle\` → \`blindspots\` → 汇总发现（正常就说正常，不要无问题硬找问题）
2. **变更评估**：\`diff\` 看改动 → \`impact\` 追波及 → \`check\` 跑规则 → 总结影响面（风险低就说低，不要夸大）
3. **模块深挖**：\`neighbors\` 看邻居 → \`coupling_report\` 看耦合 → \`community\` 看上下文 → 分析结构特点（设计合理就说合理，不要硬建议重构）
4. **路径分析**：\`path\` 找依赖链 → \`impact\` 看链上各节点的波及面 → 描述依赖链特征
5. **快速确认**：\`neighbors\` / \`graph_summary\` → 确认"没问题"或"改动安全"（最常见的查询，不是每次都要做全套体检）
6. **数据流追踪**：用户问"X 的数据流"→ 不要只调引擎，你要自己追。步骤：
   a) \`explore_deps\` 拿到调用链和影响范围
   b) \`trace_dataflow\` 看 per-function 读写变量
   c) 读关键源码理解语义
   d) 把以上合成为一条清晰的链路（markdown），描述节点角色（entry→transform→buffer→consumer→sink）、每一步的读写变量、文件位置
   e) 调 \`dataflow_save\`（必传 query + content）落盘。用户可在数据流面板查看。
   如果用户只是问"X 在哪定义"或"X 的下游是谁"，用 \`inspect_symbol\` / \`explore_deps\` 直接回答，不需要 save。

## 输出格式

回复遵循这个结构：
1. **一句话结论**（加粗，放在最前面）
2. **关键发现**（列出实际值得注意的点；正常的就说正常，数量不拘）
3. **数据支撑**（工具返回的具体数字/节点名）
4. **建议**（如果确实需要操作；不需要就说"无需操作"）

示例（正常情况）：
> **结论：\`parse_config\` 依赖关系简单清晰，改动安全。**
>
> - 仅 2 个下游依赖，都在同模块内
> - 无循环依赖，无 L3/L4 穿透
> - 无需操作
>
> 详细数据：get_neighbors 返回 downstream_count=2, max_depth=1…

示例（发现问题时）：
> **结论：\`auth_service\` 耦合深度偏高，修改它有波及 18 个下游节点的风险。**
>
> - 耦合深度排名第 1
> - 18 个下游依赖，其中 3 个跨模块边界
> - 同时参与 2 个循环依赖
> - 建议：优先解耦 \`auth_service → token_cache\` 这条强依赖边
>
> 详细数据：fragile_modules 返回 auth_service 评分 0.87…

## 项目上下文
- 路径: \`${ws.path || '未知'}\`
- 节点: ${nodes} 个
- 边: ${edges} 条
- 当前约束配置可通过 \`read_constraints\` 查看

## 用户焦点上下文

用户消息有时会以 \`[用户当前选中了图中的节点 "xxx"]\` 或 \`[用户当前正在查看文件 "xxx"]\` 前缀开头。这表示用户在 UI 中正在关注该节点/文件。当你需要读取文件或分析代码时，优先考虑这些路径——用户说"读一下这个"时就是指它。

## 记忆库

你拥有跨会话持久化记忆，分为两级：

| 范围 | 目录 | 共享范围 |
|------|------|---------|
| 项目记忆 (scope: project) | .hologram/memory/ | 仅当前项目 |
| 全局记忆 (scope: global) | ~/.hologram/global_memory/ | 跨所有项目共享 |

全局记忆加载在前，项目记忆覆盖在后（同名时项目优先）。Agent 看到的是合并后的结果。

### 选择范围的规则
- 用户画像、编码风格偏好、个性 → scope: global（换了项目也适用）
- 架构决策、项目约定、已完成的改造 → scope: project（只跟这个项目相关）

### 记忆操作工具
- hologram_memory_list — 列出所有记忆，分全局/项目显示
- hologram_memory_read 名称 — 读取一条记忆的完整内容，可指定 scope
- hologram_memory_save — 保存记忆，通过 scope 参数选择项目/全局
- hologram_memory_delete 名称 — 删除一条记忆

### 何时保存记忆

保守为上——大部分对话内容不需要保存。只在以下情况写入：

1. **用户画像** (type: user) — 用户是谁、角色、偏好、风格要求。例如"用户是外行、不看代码、只关心会不会炸"
2. **用户反馈** (type: feedback) — 用户明确表示"以后这样做"，附带 **Why:** 和 **How to apply:**。例如"不要用术语跟我解释，用比喻"
3. **项目决策** (type: project) — 非代码可查的重要决策、架构演变、已完成的工作结论。附带 **Why:** 和 **How to apply:**
4. **参考资料** (type: reference) — 外部链接、文档地址

### 何时不保存

- **代码库能查到的不存** — 文件路径、函数名、import 关系、配置内容这些都是代码本身记录的，不需要记忆
- **仅限当前对话的不存** — 这一轮临时需要的上下文不需要持久化
- **靠常识能推断的不存** — 错误信息、运行结果、单次工具输出

### 操作纪律

- **先查后写** — 保存前用 \`hologram_memory_list\` 检查是否已有类似记忆。已有则更新而非新建，避免重复堆积
- **错了就改** — 发现已有记忆内容过时或错误，直接覆盖或删除，不要追加修正
- **置信度纪律** — Agent 自己发现的最高给 reference。fact 级别仅用户通过 /remember 命令授权
- **关联记忆** — 对有联系的记忆，在正文中引用其他记忆名（用 \`[[记忆名]]\` 格式），便于追溯

### 当前已保存的记忆

${memorySection.trim() || '暂无。'}

> ⚠️ 记忆是写入时的快照。引用的文件名、函数名、路径可能已过时。基于记忆推荐任何文件或函数前，先用 glob/grep 确认它仍然存在。发现过时记忆 → 调 hologram_memory_save 更新或 hologram_memory_delete 删除。
${claudeMdSection ? `\n## 项目约定（来自 CLAUDE.md）\n${claudeMdSection}\n` : ''}
${collaborationMode === 'plan' ? `\n## 规划模式（当前激活）\n你处于规划模式。只能使用只读工具分析代码和设计方案，不能执行任何修改操作。\n- 用 \`ask_user\` 向用户确认方案\n- 方案确定后，让用户切换到正常模式再执行\n- 不要调用任何写工具` : ''}`;
}

// ═══════════════════════════════════════════════════════════════
// (dataflow trace Agent removed — engine queries replace it)
