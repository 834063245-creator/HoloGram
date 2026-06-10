// HoloGram 主入口
// 三模式星图：minimal / standard / full — 独立实例，切换即重建

import '@xterm/xterm/css/xterm.css';
import { invoke, listen, isMockMode } from './bridge';
import { StarGraph, VisualMode } from './ui/graph';
import { ChatPanel } from './ui/chat';
import { CheckPanel, type CheckResult } from './ui/check';
import { FileViewer } from './ui/file-viewer';
import { FileTreePanel } from './ui/file-tree';
import { TimelinePanel } from './ui/timeline';
import { ConstraintsPanel } from './ui/constraints';
import { SettingsPanel } from './ui/settings-panel';
import { GitPanel } from './ui/git-panel';
import { TerminalPanel } from './ui/terminal';
import { bus } from './ui/events';
import { Agent } from './agent/agent';
import { ToolRegistry, createHologramTools, type ToolExecutor } from './agent/tool';
import { MemoryManager, createMemoryTools } from './agent/memory';
import { loadSettings, saveSettings, getActiveProvider, defaultPricing } from './settings';
import { createAnthropicProvider } from './provider/anthropic';
import { createOpenAIProvider } from './provider/openai';
import type { Provider } from './provider/types';
import { iconSvg } from './ui/icons';
import { visualizeAgentTool } from './ui/agent-visualizer';

// ── UI ──
const welcome = document.getElementById('welcome')!;
const graphEl = document.getElementById('graph')!;
const statusText = document.getElementById('status-text')!;
const tbPath = document.getElementById('tb-path')!;
const btnExplorer = document.getElementById('btn-explorer') as HTMLButtonElement;
const btnOpen = document.getElementById('btn-open') as HTMLButtonElement;
const btnWelcomeOpen = document.getElementById('btn-welcome-open') as HTMLButtonElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchBtn = document.getElementById('search-btn') as HTMLButtonElement;
const btnFold = document.getElementById('btn-fold') as HTMLButtonElement;
const btnCheck = document.getElementById('btn-check') as HTMLButtonElement;
const btnDiff = document.getElementById('btn-diff') as HTMLButtonElement;
const btnTimeline = document.getElementById('btn-timeline') as HTMLButtonElement;
const btnConstraints = document.getElementById('btn-constraints') as HTMLButtonElement;
const btnTerminal = document.getElementById('btn-terminal') as HTMLButtonElement;

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
let memoryManager: MemoryManager | null = null;

// ── Mode switch ──

function setupModeSwitch(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('#mode-switch .mode-btn');

  // Restore saved view mode on startup
  const savedMode = loadSettings().display?.defaultViewMode || 'standard';
  if (savedMode !== 'standard') {
    currentMode = savedMode;
    buttons.forEach(b => {
      b.classList.toggle('active', (b as HTMLElement).dataset['mode'] === savedMode);
    });
  }

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
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

  // Save current sessions before switching workspace
  if (currentPath) {
    try { await chatPanel.saveAllSessions(currentPath); } catch { /* ignore */ }
    try { await invoke('stop_watching'); } catch { /* ignore */ }
  }

  setLoading(true, folder);
  try {
    const json = await invoke<string>('analyze_and_load', { path: folder });
    const graph = JSON.parse(json);
    currentGraphData = graph;
    starGraph.render(graph);
    showGraphView(folder);
    setupAgent().catch(() => {});
    // Restore saved sessions for this project
    chatPanel.setProjectPath(folder);
    chatPanel.loadAllSessions(folder).catch(() => {});
    setLoading(false); // 图已就绪，不等 check
    // 文件树
    if (FileTreePanel.get().isOpen()) FileTreePanel.get().load(folder);
    // 后台异步跑 check + watcher
    runCheck();
    invoke('start_watching', { path: folder }).catch(() => {});
  } catch (err: any) {
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
  TerminalPanel.get().setCwd(path);
}

// ── Search ──

function doSearch(): void {
  const query = searchInput.value.trim(); if (!query) return;
  const found = starGraph.focusNode(query);
  if (!found) { statusText.textContent = `未找到 "${query}"`; setTimeout(() => { if (statusText.textContent === `未找到 "${query}"`) statusText.textContent = '就绪'; }, 2000); }
}

// ── Agent setup ──

async function setupAgent(): Promise<void> {
  const settings = loadSettings();
  const active = getActiveProvider(settings);

  if (!active.apiKey || active.apiKey.trim() === '') {
    agent = null;
    chatPanel.setAgent(null);
    return;
  }

  // ── Load memory index ──
  let memoryIndex = '';
  if (currentPath) {
    memoryManager = new MemoryManager(currentPath);
    try { memoryIndex = await memoryManager.loadIndexText(); } catch { /* ignore */ }
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
  if (currentGraphData) {
    const exec: ToolExecutor = async (name, args) => {
      const result = await invoke<string>(name, args);
      // 触发星图可视化（解析失败不影响对话）
      try {
        visualizeAgentTool(name, args, result, starGraph);
      } catch { /* 可视化失败静默跳过 */ }
      return result;
    };
    for (const tool of createHologramTools(exec)) {
      registry.register(tool);
    }
  }

  // Register memory tools
  if (memoryManager) {
    for (const tool of createMemoryTools(memoryManager)) {
      registry.register(tool);
    }
  }

  const pricing = defaultPricing(active.kind, active.model);
  const systemPrompt = buildSystemPrompt(memoryIndex);
  const agentOpts = settings.agent || {};
  agent = new Agent(prov, registry, systemPrompt, {
    pricing,
    temperature: agentOpts.temperature,
    maxSteps: agentOpts.maxSteps,
    contextWindow: agentOpts.contextWindow,
  }, chatPanel.sink);
  chatPanel.setAgent(agent);

  // Set factory for creating new sessions
  const mm = memoryManager; // capture for closure
  chatPanel.setAgentFactory(async () => {
    const s = loadSettings();
    const act = getActiveProvider(s);
    if (!act.apiKey || act.apiKey.trim() === '') return null;
    const p: Provider =
      act.kind === 'anthropic'
        ? createAnthropicProvider({ name: act.name, apiKey: act.apiKey, baseUrl: act.baseUrl, model: act.model, thinking: act.thinking || undefined })
        : createOpenAIProvider({ name: act.name, apiKey: act.apiKey, baseUrl: act.baseUrl, model: act.model });
    const r = new ToolRegistry();
    if (currentGraphData) {
      const exec: ToolExecutor = async (name, args) => {
        const result = await invoke<string>(name, args);
        try { visualizeAgentTool(name, args, result, starGraph); } catch {}
        return result;
      };
      for (const tool of createHologramTools(exec)) r.register(tool);
    }
    // Memory tools for new sessions too
    if (mm) {
      for (const tool of createMemoryTools(mm)) r.register(tool);
    }
    const pr = defaultPricing(act.kind, act.model);
    const aOpts = s.agent || {};
    // Reload memory index so new sessions see latest memories from other tabs
    let memIdx = '';
    if (mm) {
      try { memIdx = await mm.loadIndexText(); } catch { /* ignore */ }
    }
    return new Agent(p, r, buildSystemPrompt(memIdx), {
      pricing: pr,
      temperature: aOpts.temperature,
      maxSteps: aOpts.maxSteps,
      contextWindow: aOpts.contextWindow,
    }, chatPanel.sink);
  });
}

function buildSystemPrompt(memoryIndex = ''): string {
  if (!currentGraphData) {
    let prompt = `你是 HoloGram 全息观测站的 AI 架构分析助手。当前没有加载项目，可以进行一般性对话。

身份：你是一个代码架构分析专家，擅长依赖图分析、重构风险评估、架构健康诊断。
语言：始终用中文回复。代码和文件名用原样标记。
行为：诚实——不确定的事不说。工具返回空结果不要编造。提示用户可能需要加载项目。`;
    if (memoryIndex.trim()) {
      prompt += `\n\n## 记忆库\n以下是跨会话保存的记忆（使用 \`hologram_memory_read 名称\` 查看完整内容，\`hologram_memory_save\` 保存新记忆）:\n\n${memoryIndex}`;
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
1. **诚实**：工具返回空结果就说"未找到"，不要编造节点名或关系。
2. **精确**：引用节点名时用图表中的准确名称。不确定就用工具查。
3. **结构化**：用分点、表格、小结组织回答。先说结论再讲细节。
4. **中文**：始终用中文回复。代码标识符和文件名用反引号标记。
5. **先查后说**：任何涉及代码库的问题都必须调工具，不要凭"常识"猜测。

## 工具地图 — 什么问题用什么工具

### 日常查询
| 用户问 | 用这个工具 |
|--------|----------|
| "XXX 是什么？连了哪些东西？" | \`hologram_neighbors\` 查邻居 |
| "改 XXX 会炸吗？" | \`hologram_impact\` 追踪波及范围 |
| "从 A 到 B 怎么走？" | \`hologram_path\` 找依赖路径 |
| "项目整体怎么样？" | \`hologram_graph_summary\` 看统计 |
| "XXX 的修改历史？" | \`hologram_history\` 看节点变更记录 |
| "XXX 在哪个社区？" | \`hologram_community\` 看社区归属 |
| "最近的变更？" | \`hologram_changes\` 看变更摘要 |

### 架构健康诊断
| 用户问 | 用这个工具 |
|--------|----------|
| "最脆弱的模块？" | \`hologram_fragile\` — 找出依赖多、影响大的模块 |
| "有循环依赖吗？" | \`hologram_cycle\` — 检测环 |
| "有哪些耦合问题？" | \`hologram_coupling_report\` — 某个模块的耦合面 |
| "盲点在哪？" | \`hologram_blindspots\` — 测试覆盖不到的依赖 |
| "线程安全问题？" | \`hologram_thread_conflicts\` — 线程/协程冲突 |
| "延迟/时序边？" | \`hologram_delayed\` — 实时/周期性依赖 |
| "项目健康趋势？" | \`hologram_run_health\` — 多日趋势分析 |

### 变更风险评估
| 用户问 | 用这个工具 |
|--------|----------|
| "这次改了什么？" | \`hologram_diff\` — 对比两个版本的图差异 |
| "变更前置检查？" | \`hologram_run_preflight\` — 指定文件列表，模拟影响 |
| "完整检查？" | \`hologram_run_check\` — 跑约束校验 + 信号分析 |

### 文件与约束
| 用户问 | 用这个工具 |
|--------|----------|
| "看看这个文件" | \`read_file_content\` — 读取源文件内容 |
| "约束规则是啥？" | \`read_constraints\` — 查看项目的 hologram.constraints.yaml |

### 社区分析
| 用户问 | 用这个工具 |
|--------|----------|
| "有哪些社区/子系统？" | \`hologram_community_report\` — 社区检测结果 |
| "时间线？" | \`hologram_timeline\` — 变更时间线 |

## 工具组合模式

1. **全面体检**：\`graph_summary\` → \`fragile\` → \`cycle\` → \`blindspots\` → 汇总风险结论
2. **变更评估**：\`diff\` 看改动 → \`impact\` 追波及 → \`check\` 跑规则 → 总结风险等级
3. **模块深挖**：\`neighbors\` 看邻居 → \`coupling_report\` 看耦合 → \`community\` 看上下文 → 给出重构建议
4. **路径分析**：\`path\` 找依赖链 → \`impact\` 看链上各节点的波及面 → 判断链路脆弱点

## 输出格式

回复遵循这个结构：
1. **一句话结论**（加粗，放在最前面）
2. **关键发现**（3-5 条要点）
3. **数据支撑**（工具返回的具体数字/节点名）
4. **建议**（如果有的话）

示例：
> **结论：\`auth_service\` 是当前最脆弱的模块，修改它有高风险波及 18 个下游节点。**
>
> - 脆弱度 0.87，排名第 1
> - 18 个下游依赖，其中 3 个是 L4 穿透
> - 同时参与 2 个循环依赖
> - 建议：优先解耦 \`auth_service → token_cache\` 这条强依赖边
>
> 详细数据：hologram_fragile 返回 auth_service 评分 0.87，L4 层 edge_count=5…

## 项目上下文
- 路径: \`${currentPath || '未知'}\`
- 节点: ${nodes} 个
- 边: ${edges} 条
- 当前约束配置可通过 \`read_constraints\` 查看

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
- **关联记忆** — 对有联系的记忆，在正文中引用其他记忆名（用 \`[[记忆名]]\` 格式），便于追溯

${memoryIndex.trim()
  ? `### 当前已保存的记忆\n\n${memoryIndex}`
  : '### 当前已保存的记忆\n\n暂无。'}`;
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
    btnCheck.innerHTML = result.passed
      ? `${iconSvg('check-circle')} 简报`
      : `${iconSvg('alert')} 简报`;
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
  setupIcons();
  setupModeSwitch();

  // Chat panel
  chatPanel = new ChatPanel(document.body);
  chatPanel.setStarGraph(starGraph);

  // Check panel
  checkPanel = new CheckPanel(document.body);

  // ── P4: Timeline panel ──
  timelinePanel = new TimelinePanel(document.body);

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
    starGraph.highlightFile(filePath);
  });
  bus.on('highlight:folder', (folderPath: string) => {
    starGraph.highlightFolder(folderPath);
  });
  bus.on('highlight:clear', () => {
    starGraph.clearFileHighlight();
  });

  // "Send to Agent" from detail card (P4: 发送给 Agent)
  bus.on('agent:query', (question: string) => {
    if (ConstraintsPanel.get().isOpen()) ConstraintsPanel.get().close();
    chatPanel.ask(question);
    updateTabs();
  });

  // Auto-save chat sessions after each turn
  bus.on('chat:turn-done', () => {
    if (currentPath) {
      chatPanel.saveAllSessions(currentPath).catch(() => {});
    }
  });

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
    const hideLeft = FileTreePanel.get().isOpen() || timelinePanel.isOpen()
      || GitPanel.get().isOpen() || checkPanel.isOpen() || TerminalPanel.get().isOpen();
    const hideRight = chatPanel.isOpen() || ConstraintsPanel.get().isOpen();
    leftTabs.style.display = hideLeft ? 'none' : '';
    rightTabs.style.display = hideRight ? 'none' : '';
    leftTabs.querySelectorAll('.dock-tab').forEach(t => {
      const p = (t as HTMLElement).dataset['panel'];
      const active = (p === 'explorer' && FileTreePanel.get().isOpen())
        || (p === 'timeline' && timelinePanel.isOpen())
        || (p === 'git' && GitPanel.get().isOpen());
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
      chatPanel.toggle();
    } else if (p === 'constraints') {
      if (currentPath) ConstraintsPanel.get().load(currentPath);
      if (chatPanel.isOpen()) chatPanel.close();
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

  // ── P4: Terminal button ──
  btnTerminal.addEventListener('click', () => {
    closeBottomSiblings('terminal');
    TerminalPanel.get().toggle();
    updateTabs();
  });

  // ── Settings button ──
  const settingsPanel = SettingsPanel.get();
  settingsPanel.setOnSave(() => { setupAgent().catch(() => {}); });
  chatPanel.setOnOpenSettings(() => settingsPanel.open());
  const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement;
  btnSettings.addEventListener('click', () => {
    settingsPanel.toggle();
  });

  // Save sessions on app close
  window.addEventListener('beforeunload', () => {
    if (currentPath) {
      // Synchronous save via sendBeacon-style — use invoke without awaiting
      chatPanel.saveAllSessions(currentPath).catch(() => {});
    }
  });

  // Ctrl+L → open chat
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'l' || e.key === 'L') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (ConstraintsPanel.get().isOpen()) ConstraintsPanel.get().close();
      chatPanel.toggle();
      updateTabs();
    }
    // Ctrl+D → diff toggle
    if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey) && document.activeElement?.tagName !== 'INPUT') {
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
      if (!ft.isOpen() && timelinePanel.isOpen()) timelinePanel.close();
      ft.toggle();
      btnExplorer.classList.toggle('active', ft.isOpen());
      updateTabs();
    }
  });

  setupAgent().catch(() => {});

  const open = () => openProject();
  btnOpen.addEventListener('click', open);
  btnWelcomeOpen.addEventListener('click', open);

  // File explorer toggle — mutual exclusion with timeline + git (all left-edge)
  btnExplorer.addEventListener('click', () => {
    const ft = FileTreePanel.get();
    if (!ft.isOpen() && currentPath) ft.load(currentPath);
    if (!ft.isOpen()) {
      if (timelinePanel.isOpen()) timelinePanel.close();
      if (GitPanel.get().isOpen()) GitPanel.get().close();
    }
    ft.toggle();
    btnExplorer.classList.toggle('active', ft.isOpen());
    updateTabs();
  });

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
      else if (timelinePanel.isOpen()) { timelinePanel.close(); updateTabs(); }
      else if (GitPanel.get().isOpen()) { GitPanel.get().close(); updateTabs(); }
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

  // Live updates from file watcher
  listen<string>('graph-updated', (event) => {
    try {
      const graph = JSON.parse(event.payload);
      const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : Object.keys(graph.nodes || {}).length;
      if (nodeCount > 0) {
        currentGraphData = graph;
        starGraph.render(graph);
        // Clear diff on update
        if (diffActive) { starGraph.clearDiff(); diffActive = false; btnDiff.innerHTML = `${iconSvg('diff')} 变更`; }
        setupAgent().catch(() => {});
        runCheck();
        timelinePanel.setProjectPath(currentPath);
        statusText.textContent = `已更新 (${nodeCount} 节点)`;
        setTimeout(() => { if (statusText.textContent?.startsWith('已更新')) statusText.textContent = '就绪'; }, 3000);
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
      setupAgent().catch(() => {});
      // Restore saved sessions for the cached project
      chatPanel.setProjectPath(root);
      chatPanel.loadAllSessions(root).catch(() => {});
      runCheck();
      timelinePanel.setProjectPath(root || null);
      statusText.textContent = isMockMode() ? '🎨 Mock 模式 — 所见即所得，秒级刷新' : '已加载缓存图谱';
      if (root) { try { await invoke('start_watching', { path: root }); } catch { /* ignore */ } }
      return;
    }
  } catch { /* no cache */ }

  welcome.classList.remove('hidden'); graphEl.classList.add('hidden');
}

init();
