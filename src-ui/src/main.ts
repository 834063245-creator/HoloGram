// HoloGram 主入口
// 三模式星图：minimal / standard / full — 独立实例，切换即重建

import '@xterm/xterm/css/xterm.css';
import { invoke, listen, isMockMode } from './bridge';
import { StarGraph, VisualMode } from './ui/graph';
import { ChatPanel } from './ui/chat';
import { CheckPanel, type CheckResult } from './ui/check';
import { decode } from '@msgpack/msgpack';
import { FileViewer } from './ui/file-viewer';
import { FileTreePanel } from './ui/file-tree';
import { TimelinePanel } from './ui/timeline';
import { ConstraintsPanel } from './ui/constraints';
import { HotspotsPanel } from './ui/hotspots';
import { ConflictPanel } from './ui/conflict';
import { SettingsPanel } from './ui/settings-panel';
import { GitPanel } from './ui/git-panel';
import { TerminalPanel } from './ui/terminal';
import { bus } from './ui/events';
import { Agent } from './agent/agent';
import { ToolRegistry, createHologramTools, createHologramToolsFromSchemas, createCodingTools, createSubAgentTool, type ToolExecutor } from './agent/tool';
import { PermissionPolicy, PermissionGate, showApprovalDialog } from './agent/permission';
import { MemoryManager, createMemoryTools } from './agent/memory';
import { initLogger, log } from './agent/logger';
import { HookRegistry, createGraphContextHook, createGraphContext, buildFileNodeIndex } from './agent/hooks';
import { loadSettings, saveSettings, getActiveProvider, defaultPricing, CHAT_MODES } from './settings';
import { t, setLang } from './i18n';
import { createAnthropicProvider } from './provider/anthropic';
import { createOpenAIProvider } from './provider/openai';
import type { Provider } from './provider/types';
import { iconSvg } from './ui/icons';
import { AgentVisualizer } from './ui/agent-visualizer';
import { GraphInteraction } from './ui/graph-interaction';
import { dbg } from './ui/debug';

// ── Worker layout helper ──
// Computes layout3D in a Web Worker to keep the main thread responsive.
// Falls back to synchronous computation if Worker fails or times out (5s).

function buildEdgePairs(graph: any): Array<[number, number]> {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : Object.values(graph.nodes || {});
  const nodeIdx = new Map<string, number>();
  nodes.forEach((n: any, i: number) => nodeIdx.set(n.id, i));
  const edges = Array.isArray(graph.edges) ? graph.edges : Object.values(graph.edges || {});
  const pairs: Array<[number, number]> = [];
  for (const e of edges) {
    const s = nodeIdx.get(e.source), t = nodeIdx.get(e.target);
    if (s !== undefined && t !== undefined) pairs.push([s, t]);
  }
  return pairs;
}

function layoutViaWorker(
  nodeCount: number,
  pairs: Array<[number, number]>,
): Promise<Float32Array> {
  return new Promise((resolve) => {
    try {
      const worker = new Worker(new URL('./ui/layout.worker.ts', import.meta.url), { type: 'module' });
      const timeout = setTimeout(() => {
        worker.terminate();
        // Fallback: import sync layout3D
        import('./ui/graph').then(() => resolve(new Float32Array(0))).catch(() => resolve(new Float32Array(0)));
      }, 5000);
      worker.onmessage = (e: MessageEvent) => {
        clearTimeout(timeout);
        worker.terminate();
        resolve(e.data.pos as Float32Array);
      };
      worker.onerror = () => {
        clearTimeout(timeout);
        worker.terminate();
        resolve(new Float32Array(0));
      };
      worker.postMessage({ nodes: nodeCount, pairs });
    } catch {
      resolve(new Float32Array(0));
    }
  });
}

// ── UI ──
const welcome = document.getElementById('welcome')!;
const graphEl = document.getElementById('graph')!;
const statusText = document.getElementById('status-text')!;
const tbPath = document.getElementById('tb-path')!;
const btnExplorer = document.getElementById('btn-explorer') as HTMLButtonElement;
const btnOpen = document.getElementById('btn-open') as HTMLButtonElement;
const btnReanalyze = document.getElementById('btn-reanalyze') as HTMLButtonElement;
const btnWelcomeOpen = document.getElementById('btn-welcome-open') as HTMLButtonElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchBtn = document.getElementById('search-btn') as HTMLButtonElement;
const btnFold = document.getElementById('btn-fold') as HTMLButtonElement;
const btnColorMode = document.getElementById('btn-color-mode') as HTMLButtonElement;
const btnScaleMode = document.getElementById('btn-scale-mode') as HTMLButtonElement;
const btnResetCam = document.getElementById('btn-reset-cam') as HTMLButtonElement;
const btnCheck = document.getElementById('btn-check') as HTMLButtonElement;
const btnDiff = document.getElementById('btn-diff') as HTMLButtonElement;
const btnTimeline = document.getElementById('btn-timeline') as HTMLButtonElement;
const btnConstraints = document.getElementById('btn-constraints') as HTMLButtonElement;
const btnConflict = document.getElementById('btn-conflict') as HTMLButtonElement;
const btnTerminal = document.getElementById('btn-terminal') as HTMLButtonElement;

// ── State ──
let currentPath: string | null = null;
let currentGraphData: any = null;
let currentFileGraphData: any = null;
let currentMode: VisualMode = 'standard';
let starGraph: StarGraph = new StarGraph(graphEl, currentMode);
let agentViz: AgentVisualizer | null = null;

/** Case-insensitive path comparison (Windows drive letters may differ in case). */
function isSamePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

// Chat state
let chatPanel: ChatPanel;
let checkPanel: CheckPanel;
let timelinePanel: TimelinePanel;
let hotspotsPanel: HotspotsPanel;
let conflictPanel: ConflictPanel;
let agent: Agent | null = null;
let diffActive = false;
let memoryManager: MemoryManager | null = null;

// ── Mode switch ──

const MODE_BUTTONS = () => document.querySelectorAll<HTMLButtonElement>('#mode-switch .mode-btn');

function setModeButtonsEnabled(enabled: boolean): void {
  MODE_BUTTONS().forEach(b => {
    const m = (b as HTMLElement).dataset['mode'];
    if (m === 'files') return; // file view always available
    b.disabled = !enabled;
    b.style.opacity = enabled ? '' : '0.35';
    b.style.cursor = enabled ? '' : 'not-allowed';
    b.title = enabled ? '' : '项目节点数超过渲染上限，星图已禁用';
  });
}

function setupModeSwitch(): void {
  const buttons = MODE_BUTTONS();

  // Restore saved view mode on startup
  const savedMode = loadSettings().display?.defaultViewMode || 'standard';
  const validModes: VisualMode[] = ['standard', 'full', 'files'];
  const mode = validModes.includes(savedMode as VisualMode) ? (savedMode as VisualMode) : 'standard';
  if (mode !== 'standard') {
    currentMode = mode;
    buttons.forEach(b => {
      b.classList.toggle('active', (b as HTMLElement).dataset['mode'] === savedMode);
    });
  }

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const mode = btn.dataset['mode'] as VisualMode;
      if (mode === currentMode) return;
      currentMode = mode;
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Persist view mode preference
      const settings = loadSettings();
      settings.display.defaultViewMode = mode;
      saveSettings(settings);

      // Destroy old, create new with same data
      starGraph.destroy();
      starGraph = new StarGraph(graphEl, currentMode);
      chatPanel.setStarGraph(starGraph);
      agentViz?.setGraph(starGraph);
      hotspotsPanel.setGraph(starGraph);
      const graphForMode = (currentMode === 'files' && currentFileGraphData)
        ? currentFileGraphData : currentGraphData;
      if (graphForMode) starGraph.render(graphForMode);

      // Re-wire search (new instance)
      if (searchInput.value.trim()) {
        setTimeout(() => starGraph.focusNode(searchInput.value.trim()), 300);
      }
    });
  });
}

// ── Folder picker ──

async function pickFolder(): Promise<string | null> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true, multiple: false, title: '选择工作区目录' });
    return result as string | null;
  } catch {
    return prompt('输入项目路径:');
  }
}

// ── Open & Analyze ──

async function openProject(path?: string, forceReanalyze = false): Promise<void> {
  const folder = path || (await pickFolder());
  if (!folder) return;

  // Save current sessions before switching workspace
  if (currentPath) {
    try { await chatPanel.saveActiveSession(currentPath); } catch { /* ignore */ }
    try { await invoke('stop_watching'); } catch { /* ignore */ }
  }

  // Clear stale state BEFORE loading new project (prevents wrong-project data leaks)
  currentGraphData = null;
  currentFileGraphData = null;
  currentPath = '';
  // Reset check state so new workspace gets a fresh run (prevent stale check panel + race skip)
  checkRunning = false;
  checkPending = false;
  if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
  checkPanel.update({ passed: true, timestamp: '', changed_files: [], total_changed_files: 0, l5_violations: [], l4_violations: [], l3_violations: [], l2_violations: [], passed_checks: [], blast_radius: 0, cross_community_edges: 0, new_cycles: 0, new_thread_conflicts: 0, api_signature_changes: 0 });
  // Register this workspace with the backend so all tool commands route here
  await invoke('set_active_project', { path: folder }).catch(() => {});
  initLogger(folder);

  setLoading(true, folder);

  // ── Progress listeners for streaming analysis ──
  let currentPhase = '';
  const unlistenProgress = await listen<{ current: number; total: number; file: string }>(
    'analyze-progress',
    (e) => {
      const { current, total, file } = e.payload;
      const basename = file.replace(/.*[/\\]/, '');
      statusText.textContent = `${currentPhase ? currentPhase + ' — ' : ''}[${current}/${total}] ${basename}`;
    },
  );
  const unlistenPhase = await listen<{ phase: string; message: string }>(
    'analyze-phase',
    (e) => {
      currentPhase = e.payload.message || e.payload.phase;
      statusText.textContent = currentPhase;
    },
  );
  const unlistenHeartbeat = await listen<{ label: string; elapsed: string }>(
    'analyze-heartbeat',
    (e) => {
      const { label, elapsed } = e.payload;
      statusText.textContent = `${label} (${elapsed}...)`;
    },
  );

  try {
    // ── 加载图：MsgPack 缓存优先，未命中则走引擎 RPC ──
    let graph: any;
    try {
      const holoPath = folder.replace(/\\/g, '/').replace(/\/$/, '') + '/hologram_graph.hologram';
      const bytes = await invoke<Uint8Array>('load_binary_graph', { path: holoPath });
      graph = decode(bytes) as any;
    } catch {
      // Fallback: call engine analyze via RPC
      const json = await invoke<string>('hologram_analyze', { path: folder });
      graph = JSON.parse(json);
    }
    currentGraphData = graph;
    const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : Object.keys(graph.nodes || {}).length;

    // 加载文件图
    try {
      const filesPath = folder.replace(/\\/g, '/').replace(/\/$/, '') + '/hologram_graph_files.json';
      currentFileGraphData = JSON.parse(await invoke<string>('read_file_content', { filePath: filesPath }));
    } catch { currentFileGraphData = null; }

    // ── 渲染 ──
    starGraph.render(graph);
    showGraphView(folder);
    setModeButtonsEnabled(true);
    statusText.textContent = `✨ ${nodeCount} 节点已就绪`;
    log.info('main', 'project loaded', {
      nodes: nodeCount,
      edges: Array.isArray(graph.edges) ? graph.edges.length : Object.keys(graph.edges || {}).length,
    });
    setLoading(false);
    unlistenProgress(); unlistenPhase(); unlistenHeartbeat(); currentPhase = '';
    // Agent 初始化（异步，不阻塞图的显示）
    try { await setupAgent(); } catch (e) { console.error('[openProject] setupAgent failed:', e); }
    // Restore saved sessions for this project (must be AFTER setupAgent sets agentFactory)
    chatPanel.setProjectPath(folder);
    chatPanel.autoRestoreLastSession(folder).catch(() => {});
    // 文件树
    if (FileTreePanel.get().isOpen()) FileTreePanel.get().load(folder);
    // 后台异步跑 check + watcher（必须 await watcher 启动，避免旧 watcher 竞态覆盖新数据）
    runCheck();
    await invoke('start_watching', { path: folder }).catch(() => {});
  } catch (err: any) {
    unlistenProgress(); unlistenPhase(); unlistenHeartbeat(); currentPhase = '';
    statusText.textContent = `分析失败: ${err}`; setLoading(false); throw err;
  }
}

function setLoading(active: boolean, folder?: string): void {
  btnOpen.disabled = active;
  btnOpen.innerHTML = active ? `${iconSvg('dot')} 分析中...` : `${iconSvg('folder-open')} 打开文件夹`;
  if (active) statusText.textContent = `正在分析 ${folder || ''}...`;
}

function showGraphView(path: string): void {
  currentPath = path;
  welcome.classList.add('hidden'); graphEl.classList.remove('hidden');
  btnOpen.disabled = false; btnOpen.innerHTML = `${iconSvg('folder-open')} 打开文件夹`;
  tbPath.textContent = path;
  timelinePanel.setProjectPath(path);
  hotspotsPanel.setProjectPath(path);
  TerminalPanel.get().setCwd(path);
  // Refresh file tree if it's already open (workspace switch)
  const ft = FileTreePanel.get();
  if (ft.isOpen()) ft.load(path);
}

// ── Search ──

function doSearch(): void {
  const query = searchInput.value.trim(); if (!query) return;
  const found = starGraph.focusNode(query);
  if (!found) { statusText.textContent = `未找到 "${query}"`; setTimeout(() => { if (statusText.textContent === `未找到 "${query}"`) statusText.textContent = '就绪'; }, 2000); }
}

// ── Agent setup ──

async function setupAgent(): Promise<void> {
  if (agentSetupRunning) { agentSetupPending = true; return; }
  agentSetupRunning = true;
  try {
    await setupAgentInner();
  } finally {
    agentSetupRunning = false;
    if (agentSetupPending) {
      agentSetupPending = false;
      await setupAgent();
    }
  }
}

async function setupAgentInner(): Promise<void> {
  const settings = loadSettings();
  const active = getActiveProvider(settings);

  if (!active.apiKey || active.apiKey.trim() === '') {
    agent = null;
    chatPanel.setAgent(null);
    return;
  }

  // ── Load memories into prompt ──
  let memorySection = '';
  if (currentPath) {
    memoryManager = new MemoryManager(currentPath);
    try { memorySection = await memoryManager.loadPromptSection(); } catch (e) { console.error('[setupAgent] loadPromptSection failed:', e); }
  } else {
    memoryManager = null;
  }

  const prov: Provider =
    active.kind === 'anthropic'
      ? createAnthropicProvider({
          name: active.name,
          apiKey: active.apiKey,
          baseUrl: active.baseUrl,
          model: active.model,
          thinking: active.thinking || undefined,
        })
      : createOpenAIProvider({
          name: active.name,
          apiKey: active.apiKey,
          baseUrl: active.baseUrl,
          model: active.model,
        });

  const registry = new ToolRegistry();

  // ── Step 1: 修传输层 — MCP 优先，CLI 兜底 ──
  // Factory: CLI executor（合并原 exec/exec2 重复代码）
  function createExecutor(_graphData: any, _sg: StarGraph): ToolExecutor {
    return async (name, args) => {
      const result = await invoke<string>(name, args);
      // Visualization now handled by AgentVisualizer via EventBus (single entry)
      return typeof result === 'string' ? result : JSON.stringify(result);
    };
  }

  // Try MCP for hologram tools — faster (persistent process, <100ms vs 500ms+ CLI)
  let hologramViaMcp = false;
  if (currentGraphData && currentPath) {
    try {
      const toolsJson = await invoke<string>('start_mcp_server', { projectRoot: currentPath });
      const parsed = JSON.parse(toolsJson);
      const schemas = (parsed.tools || []) as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;

      // MCP executor: calls mcp_call instead of direct invoke
      const mcpExec: ToolExecutor = async (name, args) => {
        const result = await invoke<string>('mcp_call', { toolName: name, args: JSON.stringify(args) });
        // Visualization now handled by AgentVisualizer via EventBus (single entry)
        return result;
      };

      for (const tool of createHologramToolsFromSchemas(schemas, mcpExec)) {
        registry.register(tool);
      }
      hologramViaMcp = true;
      dbg('setupAgent', `MCP mode: ${schemas.length} tools`);
    } catch (e) {
      dbg('setupAgent', `MCP unavailable, CLI fallback: ${e}`);
    }
  }

  // CLI fallback for hologram tools (MCP failed or no project path)
  if (!hologramViaMcp && currentGraphData) {
    const exec = createExecutor(currentGraphData, starGraph);
    for (const tool of createHologramTools(exec)) {
      registry.register(tool);
    }
  }

  // Coding tools (file I/O, shell, search, git, web) — always direct CLI invoke
  const codingExec: ToolExecutor = async (name, args, onProgress) => {
    // ── run_shell background mode: stream output via polling ──
    if (name === 'run_shell' && args['runInBackground']) {
      const taskId = await invoke<string>('run_shell', args);
      // Poll for output until the task completes
      let done = false;
      while (!done) {
        await new Promise(r => setTimeout(r, 300));
        try {
          const status: any = await invoke<any>('bash_output', { taskId });
          if (status.output && onProgress) {
            onProgress(status.output);
          }
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
    const result = await invoke<string>(name, args);
    return typeof result === 'string' ? result : JSON.stringify(result);
  };
  for (const tool of createCodingTools(codingExec)) {
    registry.register(tool);
  }

  // Register memory tools
  if (memoryManager) {
    for (const tool of createMemoryTools(memoryManager)) {
      registry.register(tool);
    }
  }

  const pricing = defaultPricing(active.kind, active.model);
  const systemPrompt = buildSystemPrompt(memorySection);
  const agentOpts = settings.agent || {};

  // ── Apply chat mode preset (temperature, maxSteps) ──
  const mode = CHAT_MODES.find(m => m.id === agentOpts.chatMode) || CHAT_MODES[0];
  const temperature = mode.temperature;
  const maxSteps = mode.maxSteps;
  const contextWindow = agentOpts.contextWindow ?? 0;

  // ── Permission gate ──
  const defaultMode = settings.permissions?.defaultMode || 'ask';
  const perm = new PermissionPolicy(defaultMode);
  if (settings.permissions) {
    perm.importRules(settings.permissions);
  }
  const gate = new PermissionGate(perm, (toolName, desc, args) =>
    showApprovalDialog(toolName, desc, args),
  );
  gate.onRemember = (rule: string) => {
    // Persist remembered allow rule
    const s = loadSettings();
    const rules = s.permissions || { allow: [], deny: [] };
    if (!rules.allow) rules.allow = [];
    if (!rules.allow.includes(rule)) rules.allow.push(rule);
    s.permissions = rules;
    saveSettings(s);
  };

  agent = new Agent(prov, registry, systemPrompt, {
    pricing,
    temperature,
    maxSteps,
    contextWindow,
    gate,
  }, chatPanel.sink);

  // ── Register sub-agent tool (needs the live agent instance) ──
  try {
    const agentRef = agent; // capture for closure
    registry.register(createSubAgentTool(
      async (description, prompt, onProgress) =>
        agentRef.spawnSubAgent(new AbortController().signal, description, prompt, onProgress),
    ));
    dbg('setupAgent', 'sub-agent tool registered');
  } catch (e) { console.error('[setupAgent] sub-agent tool registration failed:', e); }

  // ── PreToolUse hooks: enrich tool results with graph context ──
  if (currentGraphData) {
    const { fileIndex, fanIn, fanOut } = buildFileNodeIndex(currentGraphData);
    const ctx = createGraphContext(fileIndex, fanIn, fanOut);
    const hooks = new HookRegistry();
    hooks.register(createGraphContextHook(ctx));
    agent.setHooks(hooks);
  }

  chatPanel.setAgent(agent);

  // Set factory for creating new sessions
  const mm = memoryManager; // capture for closure
  const hookCtx = currentGraphData
    ? (() => { const { fileIndex, fanIn, fanOut } = buildFileNodeIndex(currentGraphData); return createGraphContext(fileIndex, fanIn, fanOut); })()
    : null;
  chatPanel.setAgentFactory(async () => {
    const s = loadSettings();
    const act = getActiveProvider(s);
    if (!act.apiKey || act.apiKey.trim() === '') return null;
    const p: Provider =
      act.kind === 'anthropic'
        ? createAnthropicProvider({ name: act.name, apiKey: act.apiKey, baseUrl: act.baseUrl, model: act.model, thinking: act.thinking || undefined })
        : createOpenAIProvider({ name: act.name, apiKey: act.apiKey, baseUrl: act.baseUrl, model: act.model });
    const r = new ToolRegistry();
    const exec2 = createExecutor(currentGraphData, starGraph);
    if (currentGraphData) {
      for (const tool of createHologramTools(exec2)) r.register(tool);
    }
    // Coding tools always available
    for (const tool of createCodingTools(exec2)) r.register(tool);
    // Memory tools for new sessions too
    if (mm) {
      for (const tool of createMemoryTools(mm)) r.register(tool);
    }
    const pr = defaultPricing(act.kind, act.model);
    const aOpts = s.agent || {};
    // Reload memory content so new sessions see latest memories from other tabs
    let memSection = '';
    if (mm) {
      try { memSection = await mm.loadPromptSection(); } catch { /* ignore */ }
    }
    // Permission gate for new session (shares policy with main agent)
    const gate2 = new PermissionGate(perm, (toolName, desc, args) =>
      showApprovalDialog(toolName, desc, args),
    );
    gate2.onRemember = gate.onRemember;
    const newAgent = new Agent(p, r, buildSystemPrompt(memSection), {
      pricing: pr,
      temperature: aOpts.temperature,
      maxSteps: aOpts.maxSteps,
      contextWindow: aOpts.contextWindow,
      gate: gate2,
    }, chatPanel.sink);
    // Wire hooks for new sessions too
    if (hookCtx) {
      const hooks = new HookRegistry();
      hooks.register(createGraphContextHook(hookCtx));
      newAgent.setHooks(hooks);
    }
    return newAgent;
  });
}

function buildSystemPrompt(memorySection = ''): string {
  if (!currentGraphData) {
    let prompt = `你是 HoloGram 全息观测站的 AI 架构分析助手。当前没有加载项目，可以进行一般性对话。

身份：你是一个代码架构分析专家，擅长依赖图分析、重构风险评估、架构健康诊断。
语言：始终用中文回复。代码和文件名用原样标记。
行为：诚实——不确定的事不说。工具返回空结果不要编造。提示用户可能需要加载项目。`;
    if (memorySection.trim()) {
      prompt += `\n\n## 记忆库\n${memorySection}`;
    }
    return prompt;
  }
  const nodes = currentGraphData.nodes
    ? Array.isArray(currentGraphData.nodes)
      ? currentGraphData.nodes.length
      : Object.keys(currentGraphData.nodes).length
    : 0;
  const edges = currentGraphData.edges
    ? Array.isArray(currentGraphData.edges)
      ? currentGraphData.edges.length
      : Object.keys(currentGraphData.edges).length
    : 0;
  return `你是 HoloGram 全息观测站的 AI 架构分析助手。你的任务是用依赖图分析工具帮用户理解代码库、评估变更风险、诊断架构问题。

## 身份
- 代码架构分析专家，擅长依赖图分析、重构风险评估、架构健康诊断
- 你能直接调用 ${currentPath || '项目'} 的依赖图数据（${nodes} 节点、${edges} 条边）
- 你看到的图已被分析引擎预处理——节点代表函数/类/模块/文件，边代表调用/继承/导入/时序关系

## 核心规则
1. **诚实**：工具返回空结果就说"未找到"。数据正常就说"无异常"。不要编造节点名或关系，也不要为了显得"有发现"而夸大正常数据。
2. **精确**：引用节点名时用图表中的准确名称。不确定就用工具查。
3. **结构化**：用分点、表格、小结组织回答。先说结论再讲细节。
4. **中文**：始终用中文回复。代码标识符和文件名用反引号标记。
5. **先查后说**：任何涉及代码库的问题都必须调工具，不要凭"常识"猜测。
6. **正常即正常**：工具数据不显示问题时，直接说"无异常"或"改动安全"。不要为了填充模板把低风险数据夸大为问题。遇到排名类工具（fragile/cycle），排名靠前不等于"坏了"——高耦合模块可能是设计中的枢纽。
7. **能动手就别只建议**：你有写文件、跑命令、Git 操作的工具。用户说"修"就直接修，不要只说"建议修改"。修完后跑相关测试确认没炸。
8. **不确定就问**：需求模糊、两个方案选不定、或即将执行危险操作时，用 \`ask_user\` 工具反问用户。不要猜。

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
| "看看这个文件" | \`read_file_content\` — 读取源文件内容 |
| "XX 函数在哪定义的？" | \`search_code\` — 全项目搜索文本或符号 |
| "项目目录结构？" | \`list_directory\` — 列出目录内容 |
| "约束规则是啥？" | \`read_constraints\` — 查看项目的 hologram.constraints.yaml |

### 编码操作
| 用户问 | 用这个工具 |
|--------|----------|
| "帮我写个新文件" | \`write_file\` — 创建或覆盖整个文件 |
| "帮我改 XX 文件的某处" | \`edit_file\` — 精确字符串替换（推荐：安全、省 token） |
| "把 XXX 重命名为 YYY" | \`hologram_rename\` — 基于依赖图的全局重命名（先用 dry_run=true 预览） |
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
- 路径: \`${currentPath || '未知'}\`
- 节点: ${nodes} 个
- 边: ${edges} 条
- 当前约束配置可通过 \`read_constraints\` 查看

## 用户焦点上下文

用户消息有时会以 \`[用户当前选中了图中的节点 "xxx"]\` 或 \`[用户当前正在查看文件 "xxx"]\` 前缀开头。这表示用户在 UI 中正在关注该节点/文件。当你需要读取文件或分析代码时，优先考虑这些路径——用户说"读一下这个"时就是指它。

## 记忆库

你拥有跨会话持久化记忆。记忆存储在项目的 \`.hologram/memory/\` 目录下，以 Markdown 文件保存，\`MEMORY.md\` 作为索引。

### 记忆操作工具
- **\`hologram_memory_list\`** — 列出所有已保存的记忆
- **\`hologram_memory_read 名称\`** — 读取一条记忆的完整内容
- **\`hologram_memory_save\`** — 保存新记忆或更新已有记忆
- **\`hologram_memory_delete 名称\`** — 删除一条记忆

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

// ── Check ──

let checkRunning = false;
let checkPending = false;
let checkTimer: ReturnType<typeof setTimeout> | null = null;
let agentSetupRunning = false;
let agentSetupPending = false;

async function runCheck(): Promise<void> {
  if (!currentPath) return;
  if (checkRunning) { checkPending = true; return; }
  // Cancel any pending deferred check (avoid double-run race)
  if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }

  checkRunning = true;
  checkPending = false;
  try {
    const json = await invoke<string>('hologram_run_check', { path: currentPath });
    try {
      const result: CheckResult = JSON.parse(json);
      checkPanel.update(result);
      checkPanel.loadAndRenderGate(currentPath!).catch(() => {});
      btnCheck.innerHTML = result.passed
        ? `${iconSvg('check-circle')} 简报`
        : `${iconSvg('alert')} 简报`;
    } catch (parseErr) {
      console.error('[runCheck] JSON parse failed:', parseErr, 'raw:', json.slice(0, 200));
      statusText.textContent = '简报解析失败';
    }
  } catch (err: any) {
    console.error('Check failed:', err);
    statusText.textContent = '简报请求失败';
  } finally {
    checkRunning = false;
    // If a check was requested while we were running, run one more after a short delay
    if (checkPending) {
      checkPending = false;
      if (checkTimer) clearTimeout(checkTimer);
      checkTimer = setTimeout(() => { checkTimer = null; if (!checkRunning) runCheck(); }, 2000);
    }
  }
}

// ── Icon setup ──

function setupIcons(): void {
  document.querySelectorAll('[data-icon]').forEach(el => {
    const iconName = (el as HTMLElement).dataset['icon']!;
    const svgStr = iconSvg(iconName);
    // Prepend icon before existing text
    el.insertAdjacentHTML('afterbegin', svgStr);
    // Keep text for accessibility
    (el as HTMLElement).classList.add('toolbar-btn');
  });
}

// ── Init ──

async function init(): Promise<void> {
  // Init language from saved settings
  setLang(loadSettings().display.language);

  // v4 Phase 4: listen for Unity events
  const { listen } = await import('@tauri-apps/api/event');
  const { bus: eventBus } = await import('./ui/events');
  const { FileViewer } = await import('./ui/file-viewer');
  await listen('unity-event', (event: any) => {
    const { event: evt, payload } = event.payload;
    console.log('[Unity]', evt, payload);
    if (evt === 'node_double_clicked') {
      const parts = (payload as string).split('|');
      if (parts.length > 1 && parts[1]) {
        eventBus.emit('navigate:file', parts[1]);
      }
    }
    if (evt === 'path_selected') {
      const parts = (payload as string).split('|');
      if (parts.length === 2) {
        chatPanel.open();
        chatPanel.ask(`分析从 ${parts[0]} 到 ${parts[1]} 的依赖路径。请分析这条依赖链的架构合理性、风险点、以及如果修改起点的潜在影响范围。`);
      }
    }
  });

  // ── 毙掉 Tauri WebView 的所有浏览器原生快捷键 ──
  // capture 阶段拦截，preventDefault 阻止浏览器默认行为，不阻止事件继续冒泡
  (() => {
    const isEditing = () => {
      const el = document.activeElement;
      if (!el) return false;
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
    };

    // 应用自己的快捷键（允许通过，不做拦截）
    const APP_CTRL_KEYS = new Set(['l', 'd', 'e']); // Chat / Diff / Explorer
    const APP_CTRL_KEYS_EXTRA = new Set(['`', ',']); // Terminal / Settings

    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const alt = e.altKey;

      // ── 在输入框/文本区中：只拦截浏览器级危险快捷键 ──
      if (isEditing()) {
        // 标准编辑键永远放行
        if (mod && !shift && !alt && new Set(['c', 'v', 'x', 'z', 'y', 'a']).has(key)) return;
        // 输入框中拦截：浏览器刷新/保存/打印/打开/新建等
        if (mod && !alt && ['r', 'p', 's', 'u', 'o', 'n'].includes(key)) { e.preventDefault(); return; }
        if (key === 'f5' || key === 'f12') { e.preventDefault(); return; }
        if (alt && (key === 'arrowleft' || key === 'arrowright')) { e.preventDefault(); return; }
        return;
      }

      // ── 非输入区：拦截所有浏览器原生快捷键 ──

      // 应用自己的快捷键 → 放行
      if (mod && !shift && !alt && APP_CTRL_KEYS.has(key)) return;
      if (mod && !shift && !alt && APP_CTRL_KEYS_EXTRA.has(key)) return;
      if (!mod && !alt && !shift && (key === 'f' || key === 'escape' || key === 'b')) return;

      // F 功能键（全部毙掉）
      if (['f1', 'f3', 'f4', 'f5', 'f6', 'f7', 'f10', 'f11', 'f12'].includes(key)) {
        e.preventDefault(); return;
      }
      // Ctrl 组合键 → 全毙（已知白名单已放过）
      if (mod && !alt) { e.preventDefault(); return; }
      // Alt 组合键 → 全毙（阻止 Alt+←→ 前进后退导航、Alt+D 地址栏等）
      if (alt) { e.preventDefault(); return; }
      // Backspace 回退导航（浏览器老旧行为，WebView2 可能残留）
      if (key === 'backspace') { e.preventDefault(); return; }
    }, { capture: true });
  })();

  setupIcons();
  setupModeSwitch();

  // Chat panel
  chatPanel = new ChatPanel(document.body);
  chatPanel.setStarGraph(starGraph);

  // Check panel
  checkPanel = new CheckPanel(document.body);

  // Step 2: AgentVisualizer — single entry for agent→graph visualization
  agentViz = new AgentVisualizer(starGraph);

  // Step 3: GraphInteraction — graph as Agent input device
  new GraphInteraction();

  // ── P4: Timeline panel ──
  timelinePanel = new TimelinePanel(document.body);

  // ── P6: Hotspots panel ──
  hotspotsPanel = new HotspotsPanel(document.body);
  hotspotsPanel.setGraph(starGraph);

  // ── P7: Conflict panel ──
  conflictPanel = new ConflictPanel(document.body);
  conflictPanel.setGraph(starGraph);

  // Timeline → check: view historical briefing
  bus.on('check:history', ({ checkData, timestamp }: { checkData: CheckResult; timestamp: string }) => {
    // Close bottom siblings except check
    if (TerminalPanel.get().isOpen()) TerminalPanel.get().toggle();
    checkPanel.showHistory(checkData, timestamp);
    updateTabs();
  });

  // Navigate from check panel to star graph (P2: 简报 ↔ 星图链路)
  bus.on('navigate:node', (nodeName: string) => {
    starGraph.focusNode(nodeName);
  });

  // Navigate from check panel to file viewer (P4: 浮动文件窗口)
  bus.on('navigate:file', async (filePath: string) => {
    FileViewer.get().open(filePath);
  });

  // File tree → star graph highlight
  bus.on('highlight:file', (filePath: string) => {
    dbg('main.highlight:file', filePath);
    starGraph.highlightFile(filePath);
  });
  bus.on('highlight:folder', (folderPath: string) => {
    dbg('main.highlight:folder', folderPath);
    starGraph.highlightFolder(folderPath);
  });
  bus.on('highlight:clear', () => {
    dbg('main.highlight:clear');
    starGraph.clearFileHighlight();
  });

  // "Send to Agent" from detail card (P4: 发送给 Agent)
  bus.on('agent:query', (question: string) => {
    dbg('main.agent:query', question);
    if (ConstraintsPanel.get().isOpen()) ConstraintsPanel.get().close();
    chatPanel.ask(question);
    updateTabs();
  });

  // Auto-save chat sessions after each turn
  bus.on('chat:turn-done', () => {
    if (currentPath) {
      chatPanel.saveActiveSession(currentPath).catch(() => {});
    }
  });

  // ── graph→file tree reverse linking: click node in star graph → expand file tree ──
  window.addEventListener('graph:node-selected', ((e: CustomEvent) => {
    const filePath = e.detail as string;
    if (!filePath) return;
    dbg('main.graph:node-selected', filePath);
    const ft = FileTreePanel.get();
    if (!ft.isOpen()) {
      ft.show();
      btnExplorer.classList.add('active');
      if (currentPath) {
        ft.load(currentPath).then(() => {
          ft.highlightPath(filePath);
        });
      }
    } else {
      ft.highlightPath(filePath);
    }
  }) as EventListener);

  // ── Dock tabs: sync active state ──
  const leftTabs = document.getElementById('left-tabs')!;
  const rightTabs = document.getElementById('right-tabs')!;
  const bottomTabs = document.getElementById('bottom-tabs')!;
  leftTabs.style.display = '';
  rightTabs.style.display = '';
  bottomTabs.style.display = '';
  // Listen for panel close buttons (they don't go through our toggle handlers)
  bus.on('panel:toggle', () => updateTabs());

  const updateTabs = () => {
    // Hide edge tabs when their side's panel is open (avoid overlap)
    // Left-edge panels: file tree, timeline, git only (NOT check/terminal — those are bottom)
    const hideLeft = FileTreePanel.get().isOpen() || timelinePanel.isOpen()
      || GitPanel.get().isOpen() || hotspotsPanel.isOpen();
    const hideRight = chatPanel.isOpen() || ConstraintsPanel.get().isOpen();
    leftTabs.style.display = hideLeft ? 'none' : '';
    rightTabs.style.display = hideRight ? 'none' : '';
    leftTabs.querySelectorAll('.dock-tab').forEach(t => {
      const p = (t as HTMLElement).dataset['panel'];
      const active = (p === 'explorer' && FileTreePanel.get().isOpen())
        || (p === 'timeline' && timelinePanel.isOpen())
        || (p === 'git' && GitPanel.get().isOpen())
        || (p === 'hotspots' && hotspotsPanel.isOpen());
      t.classList.toggle('active', !!active);
    });
    rightTabs.querySelectorAll('.dock-tab').forEach(t => {
      const p = (t as HTMLElement).dataset['panel'];
      const active = (p === 'chat' && chatPanel.isOpen()) || (p === 'constraints' && ConstraintsPanel.get().isOpen());
      t.classList.toggle('active', !!active);
    });
    bottomTabs.querySelectorAll('.dock-tab').forEach(t => {
      const p = (t as HTMLElement).dataset['panel'];
      const active = (p === 'check' && checkPanel.isOpen()) || (p === 'terminal' && TerminalPanel.get().isOpen());
      t.classList.toggle('active', !!active);
    });
  };

  // ── Left dock: explorer ↔ timeline (mutual exclusion) ──
  leftTabs.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.dock-tab') as HTMLElement;
    if (!tab) return;
    const p = tab.dataset['panel'];
    // Close all left-edge siblings
    const closeLeftSiblings = (except: string) => {
      if (except !== 'explorer' && FileTreePanel.get().isOpen()) { FileTreePanel.get().close(); btnExplorer.classList.remove('active'); }
      if (except !== 'timeline' && timelinePanel.isOpen()) timelinePanel.close();
      if (except !== 'git' && GitPanel.get().isOpen()) GitPanel.get().close();
      if (except !== 'hotspots' && hotspotsPanel.isOpen()) hotspotsPanel.close();
    };

    if (p === 'explorer') {
      closeLeftSiblings('explorer');
      const ft = FileTreePanel.get();
      if (!ft.isOpen() && currentPath) ft.load(currentPath);
      ft.toggle();
      btnExplorer.classList.toggle('active', ft.isOpen());
    } else if (p === 'timeline') {
      closeLeftSiblings('timeline');
      if (currentPath) timelinePanel.setProjectPath(currentPath);
      timelinePanel.toggle();
    } else if (p === 'git') {
      closeLeftSiblings('git');
      if (currentPath) GitPanel.get().load(currentPath);
      else GitPanel.get().toggle();
    } else if (p === 'hotspots') {
      closeLeftSiblings('hotspots');
      if (currentPath) hotspotsPanel.setProjectPath(currentPath);
      hotspotsPanel.toggle();
    }
    updateTabs();
  });

  // ── Right dock: chat ↔ constraints (mutual exclusion) ──
  rightTabs.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.dock-tab') as HTMLElement;
    if (!tab) return;
    const p = tab.dataset['panel'];
    if (p === 'chat') {
      if (ConstraintsPanel.get().isOpen()) ConstraintsPanel.get().close();
      if (conflictPanel.isOpen()) conflictPanel.close();
      chatPanel.toggle();
    } else if (p === 'constraints') {
      if (currentPath) ConstraintsPanel.get().load(currentPath);
      if (chatPanel.isOpen()) chatPanel.close();
      if (conflictPanel.isOpen()) conflictPanel.close();
      ConstraintsPanel.get().toggle();
    }
    updateTabs();
  });

  const btnChat = document.getElementById('btn-chat') as HTMLButtonElement;
  btnChat.addEventListener('click', () => {
    if (ConstraintsPanel.get().isOpen()) ConstraintsPanel.get().close();
    chatPanel.toggle();
    updateTabs();
  });

  // ── Bottom dock: check ↔ terminal (mutual exclusion) ──
  const closeBottomSiblings = (except: string) => {
    if (except !== 'check' && checkPanel.isOpen()) checkPanel.close();
    if (except !== 'terminal' && TerminalPanel.get().isOpen()) TerminalPanel.get().toggle();
  };

  bottomTabs.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.dock-tab') as HTMLElement;
    if (!tab) return;
    const p = tab.dataset['panel'];
    if (p === 'check') {
      closeBottomSiblings('check');
      checkPanel.toggle();
    } else if (p === 'terminal') {
      closeBottomSiblings('terminal');
      TerminalPanel.get().toggle();
    }
    updateTabs();
  });

  btnCheck.addEventListener('click', () => {
    closeBottomSiblings('check');
    checkPanel.toggle();
    updateTabs();
  });

  // ── P4: Diff button — compare current graph with previous snapshot ──
  btnDiff.addEventListener('click', async () => {
    if (diffActive) {
      starGraph.clearDiff();
      diffActive = false;
      btnDiff.innerHTML = `${iconSvg('diff')} 变更`;
      statusText.textContent = '已清除变更着色';
    } else {
      if (!currentPath) { statusText.textContent = '请先打开项目'; return; }
      try {
        const beforePath = `${currentPath}/hologram_before.json`;
        const afterPath = `${currentPath}/hologram_graph.json`;
        const diffJson = await invoke<string>('hologram_diff', {
          before_path: beforePath,
          after_path: afterPath,
        });
        const diff = JSON.parse(diffJson);
        if (diff.is_empty) {
          statusText.textContent = '已创建变更基线 · 再次分析后即可比较差异';
        } else {
          starGraph.showDiff(diff);
          diffActive = true;
          btnDiff.innerHTML = `${iconSvg('diff')} 清除`;
          statusText.textContent = `+${diff.added_nodes?.length || 0} / -${diff.removed_nodes?.length || 0} / ~${diff.modified_nodes?.length || 0}`;
        }
      } catch (err: any) {
        statusText.textContent = `变更分析失败: ${err}`;
      }
    }
  });

  // ── P4: Timeline button ── (mutual exclusion with file tree + git)
  btnTimeline.addEventListener('click', () => {
    if (currentPath) timelinePanel.setProjectPath(currentPath);
    if (FileTreePanel.get().isOpen()) { FileTreePanel.get().close(); btnExplorer.classList.remove('active'); }
    if (GitPanel.get().isOpen()) GitPanel.get().close();
    if (hotspotsPanel.isOpen()) hotspotsPanel.close();
    timelinePanel.toggle();
    updateTabs();
  });

  // ── P4: Constraints button ──
  btnConstraints.addEventListener('click', () => {
    if (currentPath) ConstraintsPanel.get().load(currentPath);
    if (chatPanel.isOpen()) chatPanel.close();
    ConstraintsPanel.get().toggle();
    updateTabs();
  });

  // ── P7: Conflict button ──
  btnConflict.addEventListener('click', () => {
    conflictPanel.toggle();
    updateTabs();
  });

  // ── P4: Terminal button ──
  btnTerminal.addEventListener('click', () => {
    closeBottomSiblings('terminal');
    TerminalPanel.get().toggle();
    updateTabs();
  });

  // ── Settings button ──
  const settingsPanel = SettingsPanel.get();
  settingsPanel.setOnSave(async () => {
    await setupAgent().catch(() => {});
    if (currentPath && agent) {
      chatPanel.autoRestoreLastSession(currentPath).catch(e => console.error('[settings] autoRestoreLastSession failed:', e));
    }
  });
  chatPanel.setOnOpenSettings(() => settingsPanel.open());
  const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement;
  btnSettings.addEventListener('click', () => {
    settingsPanel.toggle();
  });

  // Save sessions on app close
  window.addEventListener('beforeunload', () => {
    if (currentPath) {
      chatPanel.saveActiveSession(currentPath).then(
        () => console.log('[beforeunload] session saved'),
        (e) => console.error('[beforeunload] session save failed:', e),
      );
    }
  });

  /** 焦点在输入框/文本区时不触发全局快捷键。 */
  const isEditing = () => {
    const el = document.activeElement;
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
  };

  // Ctrl+L → open chat
  window.addEventListener('keydown', (e) => {
    // 在输入框/文本区中打字时不触发全局快捷键
    if (isEditing()) return;
    if ((e.key === 'l' || e.key === 'L') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (ConstraintsPanel.get().isOpen()) ConstraintsPanel.get().close();
      if (conflictPanel.isOpen()) conflictPanel.close();
      chatPanel.toggle();
      updateTabs();
    }
    // Ctrl+D → diff toggle
    if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      btnDiff.click();
    }
    // Ctrl+` → terminal toggle
    if (e.key === '`' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      closeBottomSiblings('terminal');
      TerminalPanel.get().toggle();
      updateTabs();
    }
    // Ctrl+, → settings
    if (e.key === ',' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      settingsPanel.toggle();
    }
    // Ctrl+E → file explorer toggle
    if ((e.key === 'e' || e.key === 'E') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const ft = FileTreePanel.get();
      if (!ft.isOpen() && currentPath) ft.load(currentPath);
      if (!ft.isOpen()) {
        if (timelinePanel.isOpen()) timelinePanel.close();
        if (GitPanel.get().isOpen()) GitPanel.get().close();
      }
      ft.toggle();
      btnExplorer.classList.toggle('active', ft.isOpen());
      updateTabs();
    }
  });

  const open = () => openProject();
  btnOpen.addEventListener('click', open);
  btnWelcomeOpen.addEventListener('click', open);

  // Re-analyze current project (A2: regenerates layout positions)
  btnReanalyze.addEventListener('click', async () => {
    if (!currentPath) { statusText.textContent = '请先打开项目'; return; }
    btnReanalyze.disabled = true;
    btnReanalyze.textContent = '分析中…';
    statusText.textContent = '重新分析中…';
    try {
      await invoke('stop_watching');
      await openProject(currentPath, true);
    } catch (e: any) {
      statusText.textContent = `重分析失败: ${e}`;
    } finally {
      btnReanalyze.disabled = false;
      btnReanalyze.textContent = '重分析';
    }
  });

  // File explorer toggle — mutual exclusion with timeline + git (all left-edge)
  btnExplorer.addEventListener('click', () => {
    const ft = FileTreePanel.get();
    if (!ft.isOpen() && currentPath) ft.load(currentPath);
    if (!ft.isOpen()) {
      if (timelinePanel.isOpen()) timelinePanel.close();
      if (GitPanel.get().isOpen()) GitPanel.get().close();
      if (hotspotsPanel.isOpen()) hotspotsPanel.close();
    }
    ft.toggle();
    btnExplorer.classList.toggle('active', ft.isOpen());
    updateTabs();
  });

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  // Color mode cycle
  const colorModeOrder: Array<'type' | 'community' | 'coupling'> = ['type', 'community', 'coupling'];
  let colorModeIdx = 0;
  const updateColorTooltip = () => {
    const mode = colorModeOrder[colorModeIdx];
    const labels: Record<string, string> = { type: t('color.type'), community: t('color.community'), coupling: t('color.coupling') };
    btnColorMode.title = `${t('color.tooltip')}: ${labels[mode]}`;
  };
  btnColorMode.addEventListener('click', () => {
    colorModeIdx = (colorModeIdx + 1) % 3;
    starGraph.recolorByMode(colorModeOrder[colorModeIdx]);
    btnColorMode.innerHTML = iconSvg('chart');
    updateColorTooltip();
  });

  // Scale mode toggle
  let scaleByCoupling = false;
  const updateScaleTooltip = () => {
    btnScaleMode.title = `${t('scale.tooltip')}: ${scaleByCoupling ? t('scale.coupling') : t('scale.degree')}`;
  };
  btnScaleMode.addEventListener('click', () => {
    scaleByCoupling = !scaleByCoupling;
    starGraph.rescaleByMode(scaleByCoupling ? 'coupling' : 'degree');
    btnScaleMode.innerHTML = iconSvg('blast');
    updateScaleTooltip();
  });

  // Update tooltips on language change
  bus.on('lang:changed', () => {
    updateColorTooltip();
    updateScaleTooltip();
  });

  // Fold toggle
  btnFold.addEventListener('click', () => { starGraph.toggleFold(); updateFoldBtn(); });
  btnResetCam.addEventListener('click', () => { starGraph.resetCamera(); });
  window.addEventListener('keydown', (e) => {
    if (isEditing()) return;
    if ((e.key === 'f' || e.key === 'F')) {
      starGraph.toggleFold(); updateFoldBtn();
    }
    if ((e.key === 'r' || e.key === 'R')) {
      starGraph.resetCamera();
    }
    if (e.key === '?') {
      toggleShortcuts();
    }
    if (e.key === 'Escape') {
      if (starGraph.isInsideGalaxy) starGraph.exitGalaxy();
      else if (timelinePanel.isOpen()) { timelinePanel.close(); updateTabs(); }
      else if (GitPanel.get().isOpen()) { GitPanel.get().close(); updateTabs(); }
      else if (hotspotsPanel.isOpen()) { hotspotsPanel.close(); updateTabs(); }
      else if (conflictPanel.isOpen()) { conflictPanel.close(); updateTabs(); }
      else if (FileTreePanel.get().isOpen()) { FileTreePanel.get().close(); btnExplorer.classList.remove('active'); updateTabs(); }
      else if (FileViewer.get().isOpen) FileViewer.get().close();
      else starGraph.clearAgentHighlight();
    }
  });
  function updateFoldBtn(): void {
    btnFold.innerHTML = starGraph.isFolded
      ? `${iconSvg('fold')} 展开`
      : `${iconSvg('fold')} 折叠`;
  }

  // ── Shortcuts overlay toggle ──
  const shortcutsOverlay = document.getElementById('shortcuts-overlay')!;
  function toggleShortcuts(): void {
    const visible = shortcutsOverlay.style.display !== 'none';
    shortcutsOverlay.style.display = visible ? 'none' : '';
    if (!visible) {
      // Auto-hide after 12s of no hover
      clearTimeout((shortcutsOverlay as any)._hideTimer);
      (shortcutsOverlay as any)._hideTimer = setTimeout(() => {
        if (shortcutsOverlay.style.display !== 'none') {
          shortcutsOverlay.style.display = 'none';
        }
      }, 12000);
    }
  }
  // Reset auto-hide timer on mouse enter
  shortcutsOverlay.addEventListener('mouseenter', () => {
    clearTimeout((shortcutsOverlay as any)._hideTimer);
  });
  shortcutsOverlay.addEventListener('mouseleave', () => {
    (shortcutsOverlay as any)._hideTimer = setTimeout(() => {
      if (shortcutsOverlay.style.display !== 'none') {
        shortcutsOverlay.style.display = 'none';
      }
    }, 12000);
  });
  // Close button inside overlay
  shortcutsOverlay.querySelector('.so-close')?.addEventListener('click', () => {
    shortcutsOverlay.style.display = 'none';
  });
  // Toolbar shortcut button
  const btnShortcuts = document.getElementById('btn-shortcuts') as HTMLButtonElement;
  btnShortcuts.addEventListener('click', () => toggleShortcuts());

  // Live updates from file watcher — debounced to avoid jank during Agent runs
  let _lastGraphUpdate = 0;
  let _pendingRender: ReturnType<typeof setTimeout> | null = null;
  const GRAPH_UPDATE_DEBOUNCE_MS = 2500; // accumulate file changes over 2.5s before re-render

  listen<string>('graph-updated', async (event) => {
    try {
      const graph = JSON.parse(event.payload);
      // Guard: ignore watcher events from a previous project (race after workspace switch)
      const eventRoot = graph.meta?.source_root || '';
      if (currentPath && eventRoot && !isSamePath(eventRoot, currentPath)) {
        console.warn('[graph-updated] ignoring stale event from', eventRoot, 'current is', currentPath);
        return;
      }
      const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : Object.keys(graph.nodes || {}).length;
      if (nodeCount > 0) {
        // Always update the in-memory graph data — Agent tools read from this
        currentGraphData = graph;
        // Also refresh the file-level graph
        if (currentPath) {
          try {
            const filesPath = currentPath.replace(/\\/g, '/').replace(/\/$/, '') + '/hologram_graph_files.json';
            currentFileGraphData = JSON.parse(await invoke<string>('read_file_content', { filePath: filesPath }));
          } catch { /* file graph may not exist yet */ }
        }

        // Debounce the 3D re-render — skip if we just rendered recently
        const now = Date.now();
        if (now - _lastGraphUpdate < GRAPH_UPDATE_DEBOUNCE_MS) {
          // Schedule a deferred render; if another update arrives, the timer resets
          if (_pendingRender) clearTimeout(_pendingRender);
          _pendingRender = setTimeout(() => {
            _pendingRender = null;
            if (currentGraphData) _doGraphUpdate(currentGraphData);
          }, GRAPH_UPDATE_DEBOUNCE_MS - (now - _lastGraphUpdate));
          return;
        }
        if (_pendingRender) { clearTimeout(_pendingRender); _pendingRender = null; }
        _doGraphUpdate(graph);
      }
    } catch { /* ignore */ }
  });

  // ── 后台全量分析完成事件：更新符号图数据，Agent 工具立即可用 ──
  listen<{ path: string; graph_path: string }>('analysis-complete', async (event) => {
    const { path: projPath } = event.payload;
    // Only update if still on the same project
    if (!currentPath || !isSamePath(currentPath, projPath)) return;
    try {
      const graphPath = projPath.replace(/\\/g, '/').replace(/\/$/, '') + '/hologram_graph.json';
      const raw = await invoke<string>('read_file_content', { filePath: graphPath });
      const fullGraph = JSON.parse(raw);
      const nc = Array.isArray(fullGraph.nodes) ? fullGraph.nodes.length : Object.keys(fullGraph.nodes || {}).length;
      // Update data for tools (Agent reads currentGraphData)
      currentGraphData = fullGraph;
      // 文件视图保持轻量扫描结果（含社区数据），不被完整分析的 to_file_graph 覆写
      if (currentMode !== 'files') {
        try {
          const filesPath = projPath.replace(/\\/g, '/').replace(/\/$/, '') + '/hologram_graph_files.json';
          currentFileGraphData = JSON.parse(await invoke<string>('read_file_content', { filePath: filesPath }));
        } catch { /* file graph will be regenerated by watcher */ }
      }
      statusText.textContent = `✅ 符号图分析完成 (${nc} 节点) — Agent 工具已就绪`;
      setTimeout(() => { if (statusText.textContent?.startsWith('✅ 符号图')) statusText.textContent = '📁 文件视图 · 大项目模式'; }, 5000);
    } catch (e) {
      console.error('[analysis-complete] failed to reload graph:', e);
    }
  });

  listen<{ path: string; error: string }>('analysis-failed', (event) => {
    const { path: projPath, error } = event.payload;
    if (!currentPath || !isSamePath(currentPath, projPath)) return;
    log.error('main', 'analysis failed', { path: projPath, error });
    const short = (error || '未知错误').slice(0, 80);
    statusText.textContent = `⚠️ 后台分析失败: ${short}`;
  });

  function _doGraphUpdate(graph: any): void {
    _lastGraphUpdate = Date.now();

    const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : Object.keys(graph.nodes || {}).length;
    starGraph.render(graph);
    statusText.textContent = `已更新 (${nodeCount} 节点)`;
    setTimeout(() => { if (statusText.textContent?.startsWith('已更新')) statusText.textContent = '就绪'; }, 3000);
    if (diffActive) { starGraph.clearDiff(); diffActive = false; btnDiff.innerHTML = `${iconSvg('diff')} 变更`; }
    if (nodeCount > 40000) {
      setModeButtonsEnabled(false);
    }
    // NOTE: Agent does NOT need re-init on incremental updates — its tools read
    // currentGraphData which is already refreshed. Re-initializing would kill MCP
    // connections and disrupt active conversations.
    runCheck();
    timelinePanel.setProjectPath(currentPath);
    hotspotsPanel.setProjectPath(currentPath);
    // Notify file tree to refresh (debounced in FileTreePanel)
    bus.emit('workspace:files-changed', {});
  }

  // Try cached graph (A3: msgpack first, JSON fallback)
  try {
    let graph: any;
    try {
      const bytes = await invoke<Uint8Array>('load_binary_graph');
      graph = decode(bytes) as any;
    } catch {
      const json = await invoke<string>('load_graph_json');
      graph = JSON.parse(json);
    }
    const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : Object.keys(graph.nodes || {}).length;
    if (nodeCount > 0) {
      let root: string = graph.meta?.source_root || '';
      // Fallback: if meta.source_root is missing, try the Rust backend's ACTIVE_PROJECT
      if (!root) {
        try { root = await invoke<string>('get_active_project'); } catch { /* ignore */ }
      }
      if (!root) {
        // No path available — can't run check or watcher, but graph still renders
        currentGraphData = graph;
        starGraph.render(graph);
        statusText.textContent = '⚠️ 缓存图谱已加载，但工作区路径丢失 — 请重新打开项目';
        return;
      }

      // ── Match openProject(): reset state, register workspace, then run check ──
      checkRunning = false;
      checkPending = false;
      if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
      checkPanel.update({ passed: true, timestamp: '', changed_files: [], total_changed_files: 0, l5_violations: [], l4_violations: [], l3_violations: [], l2_violations: [], passed_checks: [], blast_radius: 0, cross_community_edges: 0, new_cycles: 0, new_thread_conflicts: 0, api_signature_changes: 0 });
      await invoke('set_active_project', { path: root }).catch(() => {});

      currentGraphData = graph;
      const isLightweight = graph.meta?.lightweight === true;
      // Auto-load file-level graph for large projects
      try {
        const filesPath = root.replace(/\\/g, '/').replace(/\/$/, '') + '/hologram_graph_files.json';
        currentFileGraphData = JSON.parse(await invoke<string>('read_file_content', { filePath: filesPath }));
      } catch { currentFileGraphData = null; }

      starGraph.render(graph);
      setModeButtonsEnabled(true);
      statusText.textContent = `✨ ${nodeCount} 节点已就绪`;
      showGraphView(root);
      setLoading(false);
      // Agent 初始化（异步，不阻塞图的显示）
      try { await setupAgent(); } catch (e) { console.error('[init] setupAgent failed:', e); }
      // Restore saved sessions for the cached project (must be AFTER setupAgent sets agentFactory)
      chatPanel.setProjectPath(root);
      chatPanel.autoRestoreLastSession(root).catch(() => {});
      runCheck();
      timelinePanel.setProjectPath(root || null);
      hotspotsPanel.setProjectPath(root || null);
      statusText.textContent = isMockMode() ? '🎨 Mock 模式 — 所见即所得，秒级刷新' : '已加载缓存图谱';
      try { await invoke('start_watching', { path: root }); } catch { /* ignore */ }
      return;
    }
  } catch { /* no cache */ }

  // 没有缓存图 — 创建一个无项目上下文的 Agent（仅用于一般对话）
  welcome.classList.remove('hidden'); graphEl.classList.add('hidden');
  setupAgent().catch(() => {});
}

init();
