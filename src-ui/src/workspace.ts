// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Workspace — owns all state for one open project.
// Replaces 18+ module-level globals in main.ts.
//
// Lifecycle:
//   const ws = await Workspace.open(path, starGraph, chatPanel, checkPanel);
//   // ... user works ...
//   await ws.deactivate(chatPanel);
//
// Switching workspaces is atomic: old.deactivate() → new = Workspace.open() → assign.

import { invoke, listen } from './bridge';
import { StarGraph } from './ui/graph';
import { ChatPanel } from './ui/chat';
import { CheckPanel, type CheckResult } from './ui/check';
import { Agent } from './agent/agent';
import { ToolRegistry, createHologramTools, createCodingTools, createSubAgentTool, type ToolExecutor } from './agent/tool';
import { showApprovalDialog } from './agent/permission';
import { MemoryManager, createMemoryTools } from './agent/memory';
import { TaskManager, createTaskTools } from './agent/task';
import { initLogger, log } from './agent/logger';
import { HookRegistry, createGraphContextHook, createGraphContext, buildFileNodeIndex, PreflightHookRegistry, createGraphPreflightHook } from './agent/hooks';
import { loadSettings, saveSettings, getActiveProvider, defaultPricing, CHAT_MODES, restoreSecrets, persistSecrets } from './settings';
import { createAnthropicProvider } from './provider/anthropic';
import { createOpenAIProvider } from './provider/openai';
import type { Provider } from './provider/types';
import { bus } from './ui/events';
import { dbg } from './ui/debug';

// ── Path util ──────────────────────────────────────────────────────

/** Case-insensitive path comparison (Windows drive letters may differ in case). */
export function isSamePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

// ── Arg translation (moved from main.ts) ───────────────────────────

type ArgMap = Record<string, string>;
const ARG_TRANSLATIONS: Record<string, ArgMap> = {
  hologram_impact:          { nodeId: 'node_id', maxDepth: 'depth' },
  hologram_neighbors:       { nodeId: 'node_id' },
  hologram_path:            { from: 'from_id', to: 'to_id' },
  hologram_diff:            { beforePath: 'before_path' },
  hologram_coupling_report: { module: 'module_name' },
  hologram_community_report:{ minSize: 'min_size' },
  hologram_history:         { nodeId: 'node_id' },
  hologram_community:       { nodeId: 'node_id' },
};
// ponytail: hologram_rename removed from ARG_TRANSLATIONS — its tool schema
// already uses camelCase (oldName/newName/dryRun/nodeId), and Tauri invoke
// handles camelCase→snake_case conversion. translateArgs double-converts.

function translateArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const map = ARG_TRANSLATIONS[tool];
  if (!map) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[map[k] || k] = v;
  }
  return out;
}

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
  memoryManager: MemoryManager | null = null;
  taskManager: TaskManager = new TaskManager();

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

  get active(): boolean { return this._active; }

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
    chatPanel: ChatPanel,
    checkPanel: CheckPanel,
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

    // 1. Register workspace with backend
    ws.onStatusChange?.('正在初始化引擎...');
    console.log('[Workspace.open] step 1: workspace_activate...');
    await invoke('workspace_activate', { path }).catch((e) => { console.error('[Workspace.open] workspace_activate failed:', e); });
    console.log('[Workspace.open] step 1: done');
    initLogger(path);

    // 2. Wire progress listeners (scoped to this workspace)
    let currentPhase = '';
    const unlistenProgress = await listen<{ current: number; total: number; file: string }>(
      'analyze-progress',
      (e) => {
        if (!ws._active) return;
        const { current, total, file } = e.payload;
        const basename = file.replace(/.*[/\\]/, '');
        ws.onStatusChange?.(`${currentPhase ? currentPhase + ' — ' : ''}[${current}/${total}] ${basename}`);
      },
    );
    const unlistenPhase = await listen<{ phase: string; message: string }>(
      'analyze-phase',
      (e) => {
        if (!ws._active) return;
        currentPhase = e.payload.message || e.payload.phase;
        ws.onStatusChange?.(currentPhase);
      },
    );
    const unlistenHeartbeat = await listen<{ label: string; elapsed: string }>(
      'analyze-heartbeat',
      (e) => {
        if (!ws._active) return;
        const { label, elapsed } = e.payload;
        ws.onStatusChange?.(`${label} (${elapsed}...)`);
      },
    );

    try {
      if (opts?.skipAnalysis && opts.cachedGraph) {
        // Cold-start: use cached graph for instant render.
        // Still fire analyze_and_load (force=false) so engine_init switches
        // the backend engine to THIS project. Without this, all hologram_*
        // tool calls hit the previous session's graph data.
        // ponytail: fire-and-forget — user sees graph immediately, engine
        // init finishes in background (~500ms from SQLite).
        ws.graphData = opts.cachedGraph;
        invoke('analyze_and_load', { path, force: false }).catch(() => {});
      } else {
        // Full analysis
        ws.onLoadingChange?.(true);
        const raw = await invoke<string>('analyze_and_load', { path, force: false });
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
          invoke<string>('read_file_content', { filePath: filesPath }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        ws.fileGraphData = JSON.parse(raw);
        console.log('[Workspace.open] step 3: done');
      } catch (e) { console.log('[Workspace.open] step 3: failed', e); ws.fileGraphData = null; }

      // 4. Render — defer to next macrotask so DOM status updates paint first.
      // ponytail: _renderImpl runs heavy sync prep (Map/Array builds for N nodes)
      // before its first await. Without setTimeout, the main thread is blocked
      // and "正在渲染图谱..." never paints — user sees stale "正在分析...".
      console.log('[Workspace.open] step 4: scheduling render...');
      ws.onStatusChange?.('正在渲染图谱...');
      setTimeout(() => { console.log('[Workspace.open] render starting'); starGraph.render(ws.graphData); }, 0);

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
            try {
              const raw = await invoke<string>('get_full_graph');
              ws.graphData = JSON.parse(raw);
              try {
                const filesPath = ws.path.replace(/\\/g, '/').replace(/\/$/, '') + '/hologram_graph_files.json';
                ws.fileGraphData = JSON.parse(await invoke<string>('read_file_content', { filePath: filesPath }));
              } catch { /* file graph may not exist yet */ }
              ws.doGraphUpdate(starGraph, checkPanel, summary.diff);
              bus.emit('timeline:refresh');
            } catch { /* get_full_graph failed */ }
          }
        } catch { /* ignore */ }
      });
      ws._unlisteners.push(unlistenGraphUpdated);

      const unlistenAnalysisComplete = await listen<{ path: string; graph_path: string }>(
        'analysis-complete',
        async (event) => {
          if (!ws._active) return;
          if (!isSamePath(ws.path, event.payload.path)) return;
          try {
            const raw = await invoke<string>('get_full_graph');
            ws.graphData = JSON.parse(raw);
            try {
              const filesPath = ws.path.replace(/\\/g, '/').replace(/\/$/, '') + '/hologram_graph_files.json';
              ws.fileGraphData = JSON.parse(await invoke<string>('read_file_content', { filePath: filesPath }));
            } catch { /* will be regenerated by watcher */ }
            const nc = Array.isArray(ws.graphData.nodes) ? ws.graphData.nodes.length : Object.keys(ws.graphData.nodes || {}).length;
            ws.onStatusChange?.(`✅ 符号图分析完成 (${nc} 节点) — Agent 工具已就绪`);
          } catch (e) {
            console.error('[analysis-complete] failed to reload graph:', e);
          }
        },
      );
      ws._unlisteners.push(unlistenAnalysisComplete);

      const unlistenAnalysisFailed = await listen<{ path: string; error: string }>(
        'analysis-failed',
        (event) => {
          if (!ws._active) return;
          if (!isSamePath(ws.path, event.payload.path)) return;
          const short = (event.payload.error || '未知错误').slice(0, 80);
          ws.onStatusChange?.(`⚠️ 后台分析失败: ${short}`);
        },
      );
      ws._unlisteners.push(unlistenAnalysisFailed);

      // Clean up progress listeners (they only live during initial analysis)
      unlistenProgress();
      unlistenPhase();
      unlistenHeartbeat();
      console.log('[Workspace.open] all done, returning workspace');

    } catch (err: any) {
      console.error('[Workspace.open] FAILED:', err);
      unlistenProgress(); unlistenPhase(); unlistenHeartbeat();
      ws.onStatusChange?.(`分析失败: ${err}`);
      ws.onLoadingChange?.(false);
      throw err;
    }

    return ws;
  }

  // ═══════════════════════════════════════════════════════════════
  // Deactivate — save state, stop watcher, remove listeners
  // ═══════════════════════════════════════════════════════════════

  async deactivate(chatPanel: ChatPanel): Promise<void> {
    this._active = false;

    // Save chat sessions
    try { await chatPanel.saveActiveSession(this.path); } catch { /* ignore */ }

    // Stop watcher and clear backend state
    try { await invoke('workspace_deactivate'); } catch { /* ignore */ }

    // Remove all event listeners
    for (const unlisten of this._unlisteners) {
      try { unlisten(); } catch { /* ignore */ }
    }
    this._unlisteners = [];

    // Clear agent & memory
    this.agent = null;
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

  async setupAgent(chatPanel: ChatPanel, checkPanel: CheckPanel): Promise<void> {
    if (this.agentSetupRunning) { this.agentSetupPending = true; return; }
    this.agentSetupRunning = true;
    try {
      await this._setupAgentInner(chatPanel, checkPanel);
    } finally {
      this.agentSetupRunning = false;
      if (this.agentSetupPending) {
        this.agentSetupPending = false;
        await this.setupAgent(chatPanel, checkPanel);
      }
    }
  }

  private async _setupAgentInner(chatPanel: ChatPanel, _checkPanel: CheckPanel): Promise<void> {
    let settings = loadSettings();
    settings = await restoreSecrets(settings);
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
    try { globalDir = await invoke<string>('get_global_memory_dir'); } catch { /* ignore */ }
    this.memoryManager = new MemoryManager(this.path, globalDir);
    try { memorySection = await this.memoryManager.loadPromptSection(); } catch (e) { console.error('[setupAgent] loadPromptSection failed:', e); }

    const prov: Provider =
      active.kind === 'anthropic'
        ? createAnthropicProvider({
            name: active.name, apiKey: active.apiKey, baseUrl: active.baseUrl,
            model: active.model, thinking: active.thinking || undefined,
          })
        : createOpenAIProvider({
            name: active.name, apiKey: active.apiKey, baseUrl: active.baseUrl, model: active.model,
          });

    const registry = new ToolRegistry();

    // Hologram tools
    if (this.graphData) {
      const holoExec: ToolExecutor = async (name, args) => {
        const mapped = translateArgs(name, args);
        const result = await invoke<string>(name, mapped);
        return typeof result === 'string' ? result : JSON.stringify(result);
      };
      for (const tool of createHologramTools(holoExec)) { registry.register(tool); }
      dbg('setupAgent', `${createHologramTools(holoExec).length} hologram tools registered`);
    }

    // Coding tools
    const codingExec: ToolExecutor = async (name, args, onProgress) => {
      if (name === 'run_shell' && args['runInBackground']) {
        const taskId = await invoke<string>('run_shell', { ...args, _agent: true });
        let done = false;
        while (!done) {
          await new Promise(r => setTimeout(r, 300));
          try {
            const status: any = await invoke<any>('bash_output', { taskId, _agent: true });
            if (status.output && onProgress) onProgress(status.output);
            if (status.done) { done = true; return status.output || '(无输出)'; }
          } catch { done = true; return '(后台任务已结束)'; }
        }
        return '';
      }
      const result = await invoke<string>(name, { ...args, _agent: true });
      return typeof result === 'string' ? result : JSON.stringify(result);
    };
    for (const tool of createCodingTools(codingExec)) { registry.register(tool); }

    // Aliases — short names for high-frequency tools
    registry.alias('read_file', 'read_file_content');
    // ponytail: hologram_history is now an alias of hologram_node (V4 richer result)
    registry.alias('hologram_history', 'hologram_node');

    // Memory tools
    if (this.memoryManager) {
      for (const tool of createMemoryTools(this.memoryManager)) { registry.register(tool); }
    }

    // Task tracking tools
    for (const tool of createTaskTools(this.taskManager)) { registry.register(tool); }

    const pricing = defaultPricing(active.kind, active.model);
    const systemPrompt = buildSystemPrompt(this, memorySection);
    const agentOpts = settings.agent || {};

    const mode = CHAT_MODES.find(m => m.id === agentOpts.chatMode) || CHAT_MODES[0];
    const temperature = mode.temperature;
    const maxSteps = mode.maxSteps;
    const contextWindow = agentOpts.contextWindow ?? 0;

    // ponytail: permission rules now evaluated in Rust has_permission_to_use_tool()
    // Dialog rendering still uses showApprovalDialog via permission-ask event → main.ts bridge

    this.agent = new Agent(prov, registry, systemPrompt, {
      pricing, temperature, maxSteps, contextWindow,
    }, chatPanel.sink);

    // Sub-agent tool
    try {
      const agentRef = this.agent;
      registry.register(createSubAgentTool(
        async (description, prompt, onProgress, mode) =>
          agentRef.spawnSubAgent(new AbortController().signal, description, prompt, onProgress, mode),
      ));
    } catch (e) { console.error('[setupAgent] sub-agent tool registration failed:', e); }

    // Wire tool schemas to UI panel — dynamic, not hardcoded
    chatPanel.setToolSchemas(registry.schemas());

    // Graph context hooks
    if (this.graphData) {
      const { fileIndex, fanIn, fanOut } = buildFileNodeIndex(this.graphData);
      const ctx = createGraphContext(fileIndex, fanIn, fanOut);
      const hooks = new HookRegistry();
      hooks.register(createGraphContextHook(ctx));
      this.agent.setHooks(hooks);

      // Preflight: warn before edit_file / write_file
      const preflightHooks = new PreflightHookRegistry();
      preflightHooks.register(createGraphPreflightHook(ctx));
      this.agent.setPreflightHooks(preflightHooks);
    }

    this.onStatusChange?.('[Agent] ✅ 已就绪');
    chatPanel.setAgent(this.agent);

    // Agent factory for new sessions
    {
      const mm = this.memoryManager;
      const hookCtx = this.graphData
        ? (() => { const { fileIndex, fanIn, fanOut } = buildFileNodeIndex(this.graphData); return createGraphContext(fileIndex, fanIn, fanOut); })()
        : null;
      const ws = this;
      chatPanel.setAgentFactory(async () => {
        let s = loadSettings();
        s = await restoreSecrets(s);
        const act = getActiveProvider(s);
        if (!act.apiKey || act.apiKey.trim() === '') return null;
        const p: Provider =
          act.kind === 'anthropic'
            ? createAnthropicProvider({ name: act.name, apiKey: act.apiKey, baseUrl: act.baseUrl, model: act.model, thinking: act.thinking || undefined })
            : createOpenAIProvider({ name: act.name, apiKey: act.apiKey, baseUrl: act.baseUrl, model: act.model });
        const r = new ToolRegistry();
        const factoryExec: ToolExecutor = async (name, args) => {
          const result = await invoke<string>(name, { ...args, _agent: true });
          return typeof result === 'string' ? result : JSON.stringify(result);
        };
        if (ws.graphData) {
          for (const tool of createHologramTools(factoryExec)) r.register(tool);
        }
        for (const tool of createCodingTools(factoryExec)) r.register(tool);
        r.alias('read_file', 'read_file_content');
        r.alias('hologram_history', 'hologram_node');
        if (mm) {
          for (const tool of createMemoryTools(mm)) r.register(tool);
        }
        // Sub-agents get their own task manager (per-agent scope)
        for (const tool of createTaskTools(new TaskManager())) r.register(tool);
        let memSection = '';
        if (mm) {
          try { memSection = await mm.loadPromptSection(); } catch { /* ignore */ }
        }
        const newAgent = new Agent(p, r, buildSystemPrompt(ws, memSection), {
          pricing: defaultPricing(act.kind, act.model),
          temperature: s.agent?.temperature, maxSteps: s.agent?.maxSteps,
          contextWindow: s.agent?.contextWindow,
        }, chatPanel.sink);
        if (hookCtx) {
          const hooks = new HookRegistry();
          hooks.register(createGraphContextHook(hookCtx));
          newAgent.setHooks(hooks);
        }
        // Sub-agent tool — same as _setupAgentInner
        {
          const agentRef = newAgent;
          r.register(createSubAgentTool(
            async (description, prompt, onProgress, mode) =>
              agentRef.spawnSubAgent(new AbortController().signal, description, prompt, onProgress, mode),
          ));
        }
        return newAgent;
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // runCheck — health check / briefing
  // ═══════════════════════════════════════════════════════════════

  async runCheck(checkPanel: CheckPanel): Promise<void> {
    if (!this.path) return;
    if (this.checkRunning) { this.checkPending = true; return; }
    if (this.checkTimer) { clearTimeout(this.checkTimer); this.checkTimer = null; }

    this.checkRunning = true;
    this.checkPending = false;
    try {
      const json = await invoke<string>('hologram_run_check', { path: this.path });
      try {
        const result: CheckResult = JSON.parse(json);
        checkPanel.update(result);
        checkPanel.loadAndRenderGate(this.path).catch(() => {});
        bus.emit('timeline:refresh');
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
        this.checkTimer = setTimeout(() => { this.checkTimer = null; if (!this.checkRunning) this.runCheck(checkPanel); }, 2000);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // doGraphUpdate — handle graph update from watcher (incremental if diff available)
  // ═══════════════════════════════════════════════════════════════

  doGraphUpdate(starGraph: StarGraph, checkPanel: CheckPanel, diff?: any): void {
    if (!this.graphData) return;
    const nodeCount = Array.isArray(this.graphData.nodes) ? this.graphData.nodes.length : Object.keys(this.graphData.nodes || {}).length;
    // ponytail: incremental path — no clearGraph, no layout recalc, no camera reset
    if (diff && starGraph.hasGraph) {
      try {
        starGraph.applyGraphDiff(diff, this.graphData);
        this.onStatusChange?.(`已增量更新 (${nodeCount} 节点)`);
      } catch (e) {
        console.error('[doGraphUpdate] incremental failed, falling back to full render:', e);
        starGraph.render(this.graphData);
        this.onStatusChange?.(`已更新 (${nodeCount} 节点)`);
        if (this.diffActive) { starGraph.clearDiff(); this.diffActive = false; }
      }
    } else {
      starGraph.render(this.graphData);
      this.onStatusChange?.(`已更新 (${nodeCount} 节点)`);
      if (this.diffActive) { starGraph.clearDiff(); this.diffActive = false; }
    }
    this.runCheck(checkPanel);
  }
}

// ═══════════════════════════════════════════════════════════════
// buildSystemPrompt — pure function, reads Workspace state
// ═══════════════════════════════════════════════════════════════

export function buildSystemPrompt(ws: Workspace, memorySection = ''): string {
  if (!ws.graphData) {
    let prompt = `你是 HoloGram 全息观测站的 AI 架构分析助手。当前没有加载项目，可以进行一般性对话。

## 模型身份（必须遵守）
- **你不是 Claude、不是 Anthropic 模型，不要声称自己是 Claude 或 Anthropic 的产品。**
- **你的后端 API 是 DeepSeek。任何关于模型品牌的问题，回答"DeepSeek（由 HoloGram 调度）"。**
- 禁止编造"Claude 家族标志性风格"等理由来解释你的行为。

身份：你是一个代码架构分析专家，擅长依赖图分析、重构风险评估、架构健康诊断。
语言：始终用中文回复。代码和文件名用原样标记。
行为：诚实——不确定的事不说。工具返回空结果不要编造。提示用户可能需要加载项目。`;
    if (memorySection.trim()) {
      prompt += `\n\n## 记忆库\n${memorySection}`;
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
- **你的后端 API 是 DeepSeek。任何关于模型品牌的问题，回答"DeepSeek（由 HoloGram 调度）"。**
- 禁止编造"Claude 家族标志性风格"等理由来解释你的行为。

## 身份
- 代码架构分析专家，擅长依赖图分析、重构风险评估、架构健康诊断
- 你能直接调用 ${ws.path || '项目'} 的依赖图数据（${nodes} 节点、${edges} 条边）
- 你看到的图已被分析引擎预处理——节点代表函数/类/模块/文件，边代表调用/继承/导入/时序关系

## 核心规则
1. **诚实**：工具返回空结果就说"未找到"。数据正常就说"无异常"。不要编造节点名或关系，也不要为了显得"有发现"而夸大正常数据。
2. **精确**：引用节点名时用图表中的准确名称。不确定就用工具查。
3. **结构化**：用分点、表格、小结组织回答。先说结论再讲细节。
4. **中文**：始终用中文回复。代码标识符和文件名用反引号标记。
5. **先查后说**：任何涉及代码库的问题都必须调工具，不要凭"常识"猜测。修改代码前注意工具返回结果顶部的 ⚠️ 自动影响分析——如果显示 MEDIUM 或 HIGH 风险，先调 hologram_impact 确认波及范围再动手。
6. **正常即正常**：工具数据不显示问题时，直接说"无异常"或"改动安全"。不要为了填充模板把低风险数据夸大为问题。遇到排名类工具（fragile/cycle），排名靠前不等于"坏了"——高耦合模块可能是设计中的枢纽。
7. **能动手就别只建议**：你有写文件、跑命令、Git 操作的工具。用户说"修"就直接修，不要只说"建议修改"。修完后跑相关测试确认没炸。
8. **不确定就问**：需求模糊、两个方案选不定、或即将执行危险操作时，用 \`ask_user\` 工具反问用户。不要猜。
9. **别用 run_shell 找文件/搜代码**：\`run_shell\` 只用于构建、测试、包管理、Git 推送拉取等必须 shell 的操作。找文件用 \`glob\`（文件名模式），搜文本用 \`search_content\`（内容搜索），看目录用 \`list_directory\`。禁止用 \`run_shell\` 跑 ls/find/grep/cat/head/tail/sed/awk。
10. **别复读工具输出**：工具已经返回的结果不要原文照搬到回复里。用户能看到工具卡片里的内容。你只需要提炼关键结论和行动。
11. **修改必须展示代码**：用 \`edit_file\` 或 \`write_file\` 做完修改后，贴出修改前后的关键代码片段（不要贴整个文件），并标注文件路径和行号。

## 工具地图 — 什么问题用什么工具

### 日常查询
| 用户问 | 用这个工具 |
|--------|----------|
| "分析 / 重新分析这个项目" | \`hologram_analyze\` — 跑全量分析，生成完整依赖图 |
| 找 "auth" / "parse" / "config" 相关的东西 | \`hologram_search\` — 模糊搜索节点（不用知道精确 ID） |
| "XXX 是什么？连了哪些东西？" | \`hologram_neighbors\` 查邻居 |
| "改 XXX 会炸吗？" | \`hologram_impact\` 追踪波及范围 |
| "从 A 到 B 怎么走？" | \`hologram_path\` 找依赖路径 |
| "项目整体怎么样？" | \`hologram_graph_summary\` 看统计 |
| "XXX 的修改历史？" | \`hologram_history\` 看节点变更记录 |
| "XXX 在哪个社区？" | \`hologram_community\` 看社区归属 |
| "最近的变更？" | \`hologram_changes\` 看变更摘要 |

### 架构分析
| 用户问 | 用这个工具 |
|--------|----------|
| "哪些模块依赖最多/耦合最深？" | \`hologram_fragile\` — 按耦合深度和扇入排名（高排名≠坏了，核心枢纽天然排名高） |
| "有循环依赖吗？" | \`hologram_cycle\` — 检测环（小环常见于 UI 回调，不一定需要修） |
| "耦合面怎么样？" | \`hologram_coupling_report\` — 某个模块的耦合深度分布 |
| "跨边界边/动态分发？" | \`hologram_blindspots\` — 运行时耦合模式（插件系统/DI 的动态边是正常的） |
| "线程/协程冲突？" | \`hologram_thread_conflicts\` — 线程安全检测 |
| "延迟/时序边？" | \`hologram_delayed\` — 实时/周期性依赖 |
| "项目最近怎么样？" | \`hologram_run_health\` — 耦合密度趋势分析 |

### 变更风险评估
| 用户问 | 用这个工具 |
|--------|----------|
| "这次改了什么？" | \`hologram_diff\` — 对比两个版本的图差异 |
| "变更前置检查？" | \`hologram_run_preflight\` — 指定文件列表，模拟影响 |
| "完整检查？" | \`hologram_run_check\` — 跑约束校验 + 信号分析 |

### 文件与搜索
| 用户问 | 用这个工具 |
|--------|----------|
| "看看这个文件" | \`read_file\` (\`read_file_content\`) — 读取源文件内容 |
| "XX 函数在哪定义的？" | \`search_content\` — 全项目文本搜索（支持字面量+正则） |
| "找出所有 *.rs 文件" | \`glob\` — 文件模式匹配（支持 ** 递归，如 "**/*.rs"） |
| "项目目录结构？" | \`list_directory\` — 列出目录内容 |
| "约束规则是啥？" | \`read_constraints\` — 查看项目的 hologram.constraints.yaml |

### 编码操作
| 用户问 | 用这个工具 |
|--------|----------|
| "帮我写个新文件" | \`write_file\` — 创建或覆盖整个文件 |
| "帮我改 XX 文件的某处" | \`edit_file\` — 精确字符串替换（推荐：安全、省 token） |
| "把 XXX 重命名为 YYY" | \`hologram_rename\` — 基于依赖图的全局重命名（先用 dryRun=true 预览） |
| "跑一下测试/build/安装依赖" | \`run_shell\` — 执行 shell 命令（支持超时 + 后台运行） |
| "后台任务怎么样了/停了它" | \`bash_output\` / \`bash_kill\` — 查看/终止后台任务 |
| "Git 状态/提交/推送/拉取" | \`git_status\` / \`git_commit\` / \`git_push\` / \`git_pull\` |
| "看看改了什么/提交记录" | \`git_diff\` / \`git_log\` |
| "查一下 XXX 怎么用" | \`web_search\` — 搜索文档/参考 |
| "打开这个网页/文档" | \`web_fetch\` — 抓取 URL 全文（HTML→纯文本） |
| 需要用户确认/选择 | \`ask_user\` — 弹出对话框反问用户 |

### 社区分析
| 用户问 | 用这个工具 |
|--------|----------|
| "有哪些社区/子系统？" | \`hologram_community_report\` — 社区检测结果 |
| "时间线？" | \`hologram_timeline\` — 变更时间线 |

## 工具组合模式

1. **全面体检**：\`graph_summary\` → \`fragile\` → \`cycle\` → \`blindspots\` → 汇总发现（正常就说正常，不要无问题硬找问题）
2. **变更评估**：\`diff\` 看改动 → \`impact\` 追波及 → \`check\` 跑规则 → 总结影响面（风险低就说低，不要夸大）
3. **模块深挖**：\`neighbors\` 看邻居 → \`coupling_report\` 看耦合 → \`community\` 看上下文 → 分析结构特点（设计合理就说合理，不要硬建议重构）
4. **路径分析**：\`path\` 找依赖链 → \`impact\` 看链上各节点的波及面 → 描述依赖链特征
5. **快速确认**：\`neighbors\` / \`graph_summary\` → 确认"没问题"或"改动安全"（最常见的查询，不是每次都要做全套体检）

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
> 详细数据：hologram_neighbors 返回 downstream_count=2, max_depth=1…

示例（发现问题时）：
> **结论：\`auth_service\` 耦合深度偏高，修改它有波及 18 个下游节点的风险。**
>
> - 耦合深度排名第 1
> - 18 个下游依赖，其中 3 个跨模块边界
> - 同时参与 2 个循环依赖
> - 建议：优先解耦 \`auth_service → token_cache\` 这条强依赖边
>
> 详细数据：hologram_fragile 返回 auth_service 评分 0.87…

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

${memorySection.trim() || '暂无。'}`;
}
