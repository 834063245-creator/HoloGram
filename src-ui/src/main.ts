// HoloGram 主入口
// 三模式星图：minimal / standard / full — 独立实例，切换即重建

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { StarGraph, VisualMode } from './ui/graph';
import { ChatPanel } from './ui/chat';
import { CheckPanel, type CheckResult } from './ui/check';
import { FileViewer } from './ui/file-viewer';
import { TimelinePanel } from './ui/timeline';
import { ConstraintsPanel } from './ui/constraints';
import { bus } from './ui/events';
import { Agent } from './agent/agent';
import { ToolRegistry, createHologramTools, type ToolExecutor } from './agent/tool';
import { loadSettings, saveSettings, getActiveProvider, defaultPricing } from './settings';
import { createAnthropicProvider } from './provider/anthropic';
import { createOpenAIProvider } from './provider/openai';
import type { Provider } from './provider/types';

// ── UI ──
const welcome = document.getElementById('welcome')!;
const graphEl = document.getElementById('graph')!;
const statusText = document.getElementById('status-text')!;
const tbPath = document.getElementById('tb-path')!;
const btnOpen = document.getElementById('btn-open') as HTMLButtonElement;
const btnWelcomeOpen = document.getElementById('btn-welcome-open') as HTMLButtonElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchBtn = document.getElementById('search-btn') as HTMLButtonElement;
const btnFold = document.getElementById('btn-fold') as HTMLButtonElement;
const btnCheck = document.getElementById('btn-check') as HTMLButtonElement;
const btnDiff = document.getElementById('btn-diff') as HTMLButtonElement;
const btnTimeline = document.getElementById('btn-timeline') as HTMLButtonElement;
const btnConstraints = document.getElementById('btn-constraints') as HTMLButtonElement;

// ── State ──
let currentPath: string | null = null;
let currentGraphData: any = null;
let currentMode: VisualMode = 'standard';
let starGraph: StarGraph = new StarGraph(graphEl, currentMode);

// Chat state
let chatPanel: ChatPanel;
let checkPanel: CheckPanel;
let timelinePanel: TimelinePanel;
let agent: Agent | null = null;
let diffActive = false;

// ── Mode switch ──

function setupModeSwitch(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('#mode-switch .mode-btn');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset['mode'] as VisualMode;
      if (mode === currentMode) return;
      currentMode = mode;
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Destroy old, create new with same data
      starGraph.destroy();
      starGraph = new StarGraph(graphEl, currentMode);
      chatPanel.setStarGraph(starGraph);
      if (currentGraphData) starGraph.render(currentGraphData);

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

async function openProject(path?: string): Promise<void> {
  const folder = path || (await pickFolder());
  if (!folder) return;

  if (currentPath) { try { await invoke('stop_watching'); } catch { /* ignore */ } }

  setLoading(true, folder);
  try {
    const json = await invoke<string>('analyze_and_load', { path: folder });
    const graph = JSON.parse(json);
    currentGraphData = graph;
    starGraph.render(graph);
    showGraphView(folder);
    setupAgent();
    runCheck();
    try { await invoke('start_watching', { path: folder }); } catch { /* ignore */ }
  } catch (err: any) {
    statusText.textContent = `分析失败: ${err}`; setLoading(false); throw err;
  }
}

function setLoading(active: boolean, folder?: string): void {
  btnOpen.disabled = active;
  btnOpen.textContent = active ? '⏳ 分析中...' : '📂 打开文件夹';
  if (active) statusText.textContent = `正在分析 ${folder || ''}...`;
}

function showGraphView(path: string): void {
  currentPath = path;
  welcome.classList.add('hidden'); graphEl.classList.remove('hidden');
  btnOpen.disabled = false; btnOpen.textContent = '📂 打开文件夹';
  tbPath.textContent = path;
  timelinePanel.setProjectPath(path);
}

// ── Search ──

function doSearch(): void {
  const query = searchInput.value.trim(); if (!query) return;
  const found = starGraph.focusNode(query);
  if (!found) { statusText.textContent = `未找到 "${query}"`; setTimeout(() => { if (statusText.textContent === `未找到 "${query}"`) statusText.textContent = '就绪'; }, 2000); }
}

// ── Agent setup ──

function setupAgent(): void {
  const settings = loadSettings();
  const active = getActiveProvider(settings);

  if (!active.apiKey || active.apiKey.trim() === '') {
    agent = null;
    chatPanel.setAgent(null);
    return;
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
  if (currentGraphData) {
    const exec: ToolExecutor = async (name, args) => {
      return await invoke<string>(name, args);
    };
    for (const tool of createHologramTools(exec)) {
      registry.register(tool);
    }
  }

  const pricing = defaultPricing(active.kind, active.model);
  const systemPrompt = buildSystemPrompt();
  agent = new Agent(prov, registry, systemPrompt, { pricing }, chatPanel.sink);
  chatPanel.setAgent(agent);
}

function buildSystemPrompt(): string {
  if (!currentGraphData) {
    return '你是全息观测站的 AI 助手。当前没有加载项目，可以进行一般性对话。打开项目后你将获得代码依赖图分析工具。';
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
  return `你是全息观测站的 AI 助手，可以分析代码依赖图。

项目: ${currentPath || '未知'}
规模: ${nodes} 节点, ${edges} 边

工具: hologram_analyze / neighbors / impact / path / fragile / cycle / coupling_report / blindspots / thread_conflicts / timeline / diff / community_report / graph_summary

用户会问"哪个模块最脆弱？""A 和 B 怎么关联？""改这里会炸吗？""有没有循环依赖？"——直接用工具查，给出结论。`;
}

// ── Check ──

let checkRunning = false;
let checkPending = false;
let checkTimer: ReturnType<typeof setTimeout> | null = null;

async function runCheck(): Promise<void> {
  if (!currentPath) return;
  if (checkRunning) { checkPending = true; return; }

  checkRunning = true;
  try {
    const json = await invoke<string>('hologram_run_check', { path: currentPath });
    const result: CheckResult = JSON.parse(json);
    checkPanel.update(result);
    btnCheck.textContent = result.passed ? '📋 简报' : '⚠️ 简报';
  } catch (err: any) {
    console.error('Check failed:', err);
  } finally {
    checkRunning = false;
    // If a check was requested while we were running, run one more after a short delay
    if (checkPending) {
      checkPending = false;
      if (checkTimer) clearTimeout(checkTimer);
      checkTimer = setTimeout(() => { checkTimer = null; runCheck(); }, 2000);
    }
  }
}

// ── Init ──

async function init(): Promise<void> {
  setupModeSwitch();

  // Chat panel
  chatPanel = new ChatPanel(document.body);
  chatPanel.setStarGraph(starGraph);

  // Check panel
  checkPanel = new CheckPanel(document.body);

  // ── P4: Timeline panel ──
  timelinePanel = new TimelinePanel(document.body);

  // Navigate from check panel to star graph (P2: 简报 ↔ 星图链路)
  bus.on('navigate:node', (nodeName: string) => {
    starGraph.focusNode(nodeName);
  });

  // Navigate from check panel to file viewer (P4: 浮动文件窗口)
  bus.on('navigate:file', async (filePath: string) => {
    FileViewer.get().open(filePath);
  });

  const btnChat = document.getElementById('btn-chat') as HTMLButtonElement;
  btnChat.addEventListener('click', () => chatPanel.toggle());

  btnCheck.addEventListener('click', () => checkPanel.toggle());

  // ── P4: Diff button — compare current graph with previous snapshot ──
  btnDiff.addEventListener('click', async () => {
    if (diffActive) {
      starGraph.clearDiff();
      diffActive = false;
      btnDiff.textContent = '📊 变更';
      statusText.textContent = '已清除变更着色';
    } else {
      if (!currentPath) { statusText.textContent = '请先打开项目'; return; }
      try {
        // Compare last snapshot with current graph
        const diffJson = await invoke<string>('hologram_diff', {
          beforePath: `${currentPath}/hologram_graph.json`,
        });
        const diff = JSON.parse(diffJson);
        if (diff.is_empty) {
          statusText.textContent = '无结构变更';
        } else {
          starGraph.showDiff(diff);
          diffActive = true;
          btnDiff.textContent = '📊 清除';
          statusText.textContent = `变更: +${diff.added_nodes?.length || 0}/-${diff.removed_nodes?.length || 0}/~${diff.modified_nodes?.length || 0}`;
        }
      } catch (err: any) {
        statusText.textContent = `变更分析失败: ${err}`;
      }
    }
  });

  // ── P4: Timeline button ──
  btnTimeline.addEventListener('click', () => {
    if (currentPath) timelinePanel.setProjectPath(currentPath);
    timelinePanel.toggle();
  });

  // ── P4: Constraints button ──
  btnConstraints.addEventListener('click', () => {
    if (currentPath) ConstraintsPanel.get().load(currentPath);
    ConstraintsPanel.get().toggle();
  });

  // Ctrl+L → open chat
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'l' || e.key === 'L') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      chatPanel.toggle();
    }
    // Ctrl+D → diff toggle
    if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey) && document.activeElement?.tagName !== 'INPUT') {
      e.preventDefault();
      btnDiff.click();
    }
  });

  setupAgent();

  const open = () => openProject();
  btnOpen.addEventListener('click', open);
  btnWelcomeOpen.addEventListener('click', open);

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  // Fold toggle
  btnFold.addEventListener('click', () => { starGraph.toggleFold(); updateFoldBtn(); });
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'f' || e.key === 'F') && document.activeElement?.tagName !== 'INPUT') {
      starGraph.toggleFold(); updateFoldBtn();
    }
    if (e.key === 'Escape') {
      if (starGraph.isInsideGalaxy) starGraph.exitGalaxy();
      else if (FileViewer.get().isOpen) FileViewer.get().close();
    }
  });
  function updateFoldBtn(): void {
    btnFold.textContent = starGraph.isFolded ? '🌀 展开' : '🌀 折叠';
  }

  // Live updates from file watcher
  listen<string>('graph-updated', (event) => {
    try {
      const graph = JSON.parse(event.payload);
      const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : Object.keys(graph.nodes || {}).length;
      if (nodeCount > 0) {
        currentGraphData = graph;
        starGraph.render(graph);
        // Clear diff on update
        if (diffActive) { starGraph.clearDiff(); diffActive = false; btnDiff.textContent = '📊 变更'; }
        setupAgent();
        runCheck();
        timelinePanel.setProjectPath(currentPath);
        statusText.textContent = `🔄 已更新 (${nodeCount} 节点)`;
        setTimeout(() => { if (statusText.textContent?.startsWith('🔄')) statusText.textContent = '就绪'; }, 3000);
      }
    } catch { /* ignore */ }
  });

  // Try cached graph
  try {
    const json = await invoke<string>('load_graph_json');
    const graph = JSON.parse(json);
    const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : Object.keys(graph.nodes || {}).length;
    if (nodeCount > 0) {
      const root = graph.meta?.source_root || '';
      currentGraphData = graph;
      starGraph.render(graph);
      showGraphView(root);
      setupAgent();
      runCheck();
      timelinePanel.setProjectPath(root || null);
      statusText.textContent = '已加载缓存图谱';
      if (root) { try { await invoke('start_watching', { path: root }); } catch { /* ignore */ } }
      return;
    }
  } catch { /* no cache */ }

  welcome.classList.remove('hidden'); graphEl.classList.add('hidden');
}

init();
