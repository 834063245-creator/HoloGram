// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AgentBuilder — 从 bootstrap.ts 提取的纯组合逻辑
//
// 职责：
//   - 构建 ToolRegistry（hologram tools + coding tools + memory + skill + task）
//   - 构建 system prompt
//   - 加载引擎快照（loadEngineSnapshot）
//
// 不依赖：React, zustand, ui/event bus, ui/panel-store, ui/chat-store
//
// UI 回调通过 BuilderDeps 注入，不直接 import ui/ 模块。

import type { Tool, ToolExecutor } from '../tool';
import { ToolRegistry, agentInvoke } from '../tool';
import { rpc, listen } from '../../bridge';
import type { Provider } from '../../provider/types';
import { createCompactionTools } from '../compaction-model';
import type { GraphContext } from '../hooks';
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
} from '../hooks';
import type { Agent } from '../agent';
import { createCodingTools } from '../tools/coding';
import { createSubAgentTool } from '../tools/subagent';
import { createSkillTool } from '../skills';
import { createTaskTools } from '../task';

// ── Types ──

/** UI 依赖注入 — 由调用者（UI 层）提供，agent-builder 不直接 import ui/ */
export interface BuilderDeps {
  /** ask_user 工具的 UI 请求回调 */
  onAskUser?: (req: {
    id: string;
    question: string;
    header: string;
    options: { label: string; description: string }[];
    multiSelect: boolean;
    callback: (answer: string[] | null) => void;
  }) => void;
  /** dataflow_save 后的通知（UI 面板刷新） */
  onDataflowSaved?: () => void;
  /** LSP 诊断数据源（用于 state hooks） */
  diagnosticsSource?: {
    getDiagnosticsForFile(filePath: string): Promise<Array<{ line: number; severity: string; message: string; source: string }>>;
  };
  /** Shell 流式输出监听（由 UI 层提供 Tauri event listener） */
  shellStream?: {
    onOutput(streamId: string, cb: (chunk: string) => void): () => void;
    onDone(streamId: string, cb: (exitCode: number, error?: string) => void): () => void;
  };
}

// ── MCP Schema loading ──

interface McpSchema {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export async function loadHologramSchemas(): Promise<McpSchema[]> {
  try {
    const raw = await rpc<string>('hologram_tools_list');
    return JSON.parse(raw) as McpSchema[];
  } catch {
    return [];
  }
}

export function mcpSchemaToTool(schema: McpSchema, exec: ToolExecutor): Tool {
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

// ── Graph helpers ──

export function extractGraphNodeNames(graphData: unknown): string[] | undefined {
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

export function buildGraphContextFromData(graphData: any): GraphContext | null {
  if (!graphData) return null;
  const { fileIndex, fanIn, fanOut } = buildFileNodeIndex(graphData);
  return createGraphContext(fileIndex, fanIn, fanOut);
}

// ── System prompt builder ──

export function buildSystemPrompt(
  graphData: any,
  projectPath: string,
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

  if (!graphData) {
    let prompt = `你是 HoloGram 的 AI 编码助手。当前没有加载项目。
## 模型身份
- ${modelNegation}
- ${modelIdentity}`;
    if (memorySection.trim()) {
      prompt += `\n\n## 记忆库\n${memorySection}`;
    }
    return prompt;
  }

  const modeBlock = collaborationMode === 'plan'
    ? `
## 规划模式（当前激活）
你只有只读工具。不能写文件、跑命令、改代码、Git 操作。用户让你"修"时输出方案，用 ask_user 请用户切到正常模式再执行。`
    : `
## 执行模式
你有写文件、跑命令、Git 的全部工具。用户说"修"就直接修，修完跑测试验证。`;

  const staticRules = `你是 HoloGram 的编码 Agent。

## 行为规则
1. **能动手就别只建议**。用户说"修"就去修，不要只说"建议修改"。
2. **最小改动**。修 bug 不重构，改三行不抽象。改动只影响任务涉及的文件。
3. **不要留占位符**。每行改动都完整写出来，别用 \`// ... rest unchanged\`。
4. **改完验证**。跑编译/测试确认没炸，不要假设改对了。
5. **默认用中文回复**。代码标识符和文件名保持原样。
6. **不确定就问**。需求模糊、方案选不定、危险操作时用 ask_user。
7. **工具失败时诊断**。分析错误原因再调整，别用相同参数重试。
8. **能并行的只读操作一起发**（多个 Read/Grep/Glob 一次调用）。
9. **不要复读工具输出**。提炼关键结论，用户能看到工具卡片里的内容。
10. **像资深工程师一样说话**。简洁、直接、不拍马屁、不空洞鼓励。
11. **用户犯错时指出来**。用户说错了就直接说，不要为了讨好而同意。
12. **改完后检查**。注释和文档是否过时，一起更新。
13. **别用 run_shell 搜文件/搜代码/操作 Git**。找文件用 glob，搜文本用 search_content，Git 用专用 git_* 工具。run_shell 只用于构建和测试。
${modeBlock}`;

  let suffix = `\n## 模型身份
- ${modelNegation}
- ${modelIdentity}
- 项目: \`${projectPath}\``;

  if (collaborationMode !== 'plan') {
    suffix += `\n\n## 子 Agent
agent_spawn 阻塞到子 Agent 完成，结果就是工具返回值。同一轮发多个可并行。大任务才委派，小任务自己做。`;
  }

  if (graphSnapshot) {
    suffix += `\n\n## 项目架构快照\n\`\`\`\n${graphSnapshot}\n\`\`\``;
  }
  if (memorySection) {
    suffix += `\n\n## 记忆库\n${memorySection}`;
  }
  if (claudeMdSection) {
    suffix += `\n\n## 项目规范\n${claudeMdSection}`;
  }

  return staticRules + suffix;
}

// ── Tool registry builder ──

export interface ToolRegistryOptions {
  graphData: any;
  provider: Provider;
  deps: BuilderDeps;
  memoryManager?: MemoryManager;
  skillRegistry?: SkillRegistry;
  taskManager: TaskManager;
  subAgentPool: SubAgentPool;
  /** 子 Agent spawn 函数 — 由 Runtime 注入 */
  subAgentSpawner?: SubAgentSpawner;
}

import type { MemoryManager } from '../memory';
import type { SkillRegistry } from '../skills';
import type { SubAgentPool } from '../coordinator';
import type { TaskManager } from '../task';
import type { SubAgentSpawner } from '../tools/subagent';

export async function buildToolRegistry(opts: ToolRegistryOptions): Promise<ToolRegistry> {
  const { graphData, provider, deps, memoryManager: mm, skillRegistry, taskManager, subAgentPool, subAgentSpawner } = opts;
  const registry = new ToolRegistry();

  // ── Hologram tools ──
  if (graphData) {
    const holoExec: ToolExecutor = async (name, args) => {
      const result = await rpc<string>('hologram_call', { tool: name, args });
      return typeof result === 'string' ? result : JSON.stringify(result);
    };
    const schemas = await loadHologramSchemas();
    for (const tool of schemas.map((s) => mcpSchemaToTool(s, holoExec))) registry.register(tool);

    registry.register({
      name: () => 'dataflow_save',
      description: () => '保存数据流追踪结果到 .hologram/dataflow/，供面板查看和后续查询。',
      parameters: () => ({ type: 'object', properties: { query: { type: 'string' }, content: { type: 'string' } }, required: ['query', 'content'] }),
      readOnly: () => false,
      execute: async (args) => { const r = await agentInvoke('dataflow_save', args); deps.onDataflowSaved?.(); return r; },
    });
    registry.register({
      name: () => 'dataflow_query',
      description: () => '查询已保存的数据流追踪结果。',
      parameters: () => ({ type: 'object', properties: { traceId: { type: 'string' }, list: { type: 'boolean' } } }),
      readOnly: () => true,
      execute: (args) => agentInvoke('dataflow_query', args),
    });
  }

  // ── Coding tools ──
  const _shellCleanups = new Map<string, Array<() => void>>();
  const SHELL_TIMEOUT = 600_000;
  const codingExec: ToolExecutor = async (name, args, onProgress) => {
    if (name === 'run_shell' && args.runInBackground) {
      const taskId = await agentInvoke<string>('run_shell', args);
      let done = false;
      while (!done) {
        await new Promise((r) => setTimeout(r, 300));
        try {
          const st: any = await agentInvoke<any>('bash_output', { taskId });
          if (st.output && onProgress) onProgress(st.output);
          if (st.done) { done = true; return st.output || '(无输出)'; }
        } catch { done = true; return '(后台任务已结束)'; }
      }
      return '';
    }
    if (name === 'exec_command' && onProgress && !args.runInBackground) {
      const streamId = `shell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      for (const fns of _shellCleanups.values()) for (const fn of fns) fn();
      _shellCleanups.clear();
      return new Promise<string>((resolve) => {
        void (async () => {
          let fullOutput = ''; let timer: ReturnType<typeof setTimeout> | null = null; let settled = false;
          const cleanup = () => { if (timer) { clearTimeout(timer); timer = null; } const fns = _shellCleanups.get(streamId); if (fns) { for (const fn of fns) fn(); _shellCleanups.delete(streamId); } };
          const resolveOnce = (v: string) => { if (settled) return; settled = true; cleanup(); resolve(v); };
          const unOut = await listen<{ streamId: string; chunk: string }>('shell:output', (e) => { if (e.payload.streamId !== streamId) return; fullOutput += e.payload.chunk; onProgress(e.payload.chunk); });
          const unDone = await listen<{ streamId: string; exitCode: number; error?: string }>('shell:done', (e) => { if (e.payload.streamId !== streamId) return; if (e.payload.error) resolveOnce(`[exit ${e.payload.exitCode}]\n${e.payload.error}`); else if (e.payload.exitCode !== 0) resolveOnce(`[exit ${e.payload.exitCode}]\n${fullOutput}`); else resolveOnce(fullOutput || '(无输出)'); });
          _shellCleanups.set(streamId, [unOut, unDone]);
          timer = setTimeout(() => resolveOnce(`[exit -1] shell 超时 (${SHELL_TIMEOUT / 1000}s)`), SHELL_TIMEOUT);
          try { await agentInvoke<string>('exec_command', { ...args, streamToolId: streamId }); } catch (e: any) { resolveOnce(`错误: ${e}`); }
        })();
      });
    }
    const result = await agentInvoke<string>(name, args);
    return typeof result === 'string' ? result : JSON.stringify(result);
  };
  for (const tool of createCodingTools(codingExec, provider, { askUser: deps.onAskUser ?? (() => {}) })) registry.register(tool);
  registry.alias('read_file', 'read_file_content');
  if (skillRegistry) registry.register(createSkillTool(skillRegistry));
  if (mm) for (const tool of (await import('../memory')).createMemoryTools(mm) as any) registry.register(tool);
  for (const tool of createTaskTools(taskManager)) registry.register(tool);

  // ── Sub-agent tool ──
  if (subAgentSpawner) {
    registry.register(createSubAgentTool(subAgentSpawner, subAgentPool));
  }

  return registry;
}

// ── Compaction tools ──

export function registerCompactionTools(agent: Agent, reg: ToolRegistry): void {
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
}

// ── Plan mode registry ──

export function planRegistry(base: ToolRegistry): ToolRegistry {
  const out = new ToolRegistry();
  for (const t of base.filterReadOnly()) out.register(t);
  return out;
}

// ── Engine snapshot ──

export async function loadEngineSnapshot(ctx: GraphContext, projectPath: string, isRefresh = false): Promise<void> {
  try {
    const [fragileRaw, cycleRaw, healthRaw, blindspotsRaw] = await Promise.all([
      rpc<string>('hologram_call', { tool: 'fragile_modules', args: { limit: 15 } }),
      rpc<string>('hologram_call', { tool: 'detect_cycles', args: { mode: 'all' } }),
      rpc<string>('hologram_call', { tool: 'project_health', args: { path: projectPath, days: 30 } }),
      rpc<string>('hologram_call', { tool: 'arch_blindspots', args: { filter: 'all' } }).catch(() => '{"blindspots":[]}'),
    ]);
    const fragileData = JSON.parse(fragileRaw);
    const fragilityRanks: Array<{ file: string; score: number }> = [];
    if (fragileData.fragile_modules || fragileData.modules) {
      const list = fragileData.fragile_modules || fragileData.modules;
      for (const m of list) fragilityRanks.push({ file: m.file || m.module || '', score: m.fragility_score || m.score || 0 });
    }
    const cycleData = JSON.parse(cycleRaw);
    const cycleCount = cycleData.total_cycles || cycleData.cycles?.length || 0;
    const healthData = JSON.parse(healthRaw);
    const healthScore = healthData.coupling_density_score || healthData.score || 0;
    const blindspotsData = JSON.parse(blindspotsRaw);
    const synthesisAlerts: Array<{ type: string; count: number; detail: string }> = [];
    const rawBlindspots = blindspotsData.blindspots || blindspotsData.alerts || [];
    const typeCounts = new Map<string, number>();
    for (const b of rawBlindspots) { const t = b.type || b.kind || 'unknown'; typeCounts.set(t, (typeCounts.get(t) || 0) + 1); }
    for (const [type, count] of typeCounts) synthesisAlerts.push({ type, count, detail: `${count} detected in project` });
    const lspHotspots: Array<{ file: string; symbol: string; callers: number }> = [];
    for (const r of fragilityRanks.slice(0, 5)) { if (r.score > 100) lspHotspots.push({ file: r.file, symbol: r.file.split('/').pop()?.replace(/\.[^.]+$/, '') || '', callers: Math.round(r.score / 10) }); }
    const lspCallers = new Map<string, Array<{ symbol: string; count: number }>>();
    for (const r of fragilityRanks.slice(0, 3)) {
      try {
        const resolveRaw = await rpc<string>('hologram_call', { tool: 'resolve_call', args: { file: r.file } }).catch(() => '{}');
        const resolveData = JSON.parse(resolveRaw);
        if (resolveData.calls && Array.isArray(resolveData.calls)) {
          const fc = new Map<string, number>();
          for (const c of resolveData.calls) { const fn = c.callee || c.function || c.name || ''; if (fn) fc.set(fn, (fc.get(fn) || 0) + 1); }
          const sorted = [...fc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([symbol, count]) => ({ symbol, count }));
          if (sorted.length > 0) lspCallers.set(r.file, sorted);
        }
      } catch {}
    }
    const semanticNeighbors = new Map<string, Array<{ name: string; file: string }>>();
    for (const r of fragilityRanks.slice(0, 3)) {
      const symbol = r.file.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
      if (!symbol) continue;
      try {
        const searchRaw = await rpc<string>('hologram_call', { tool: 'search_symbols', args: { query: symbol, limit: 5 } }).catch(() => '{"results":[]}');
        const searchData = JSON.parse(searchRaw);
        const results = searchData.results || [];
        const neighbors = results.filter((s: any) => (s.name || '').toLowerCase() !== symbol.toLowerCase()).slice(0, 3).map((s: any) => ({ name: s.name || '', file: s.location || s.file || '' }));
        if (neighbors.length > 0) semanticNeighbors.set(r.file, neighbors);
      } catch {}
    }
    let baselineFragility: Map<string, number>;
    let sessionDrift = 0;
    if (!isRefresh && !ctx.engine) {
      baselineFragility = new Map<string, number>();
      for (const r of fragilityRanks) baselineFragility.set(r.file, r.score);
    } else {
      const prev = ctx.engine?.baselineFragility;
      if (prev && prev.size > 0) { let delta = 0; for (const r of fragilityRanks) { const before = prev.get(r.file) ?? 0; if (r.score > before) delta += (r.score - before) / Math.max(before, 1); } sessionDrift = delta; }
      baselineFragility = ctx.engine?.baselineFragility ?? new Map();
    }
    ctx.engine = { fragilityRanks, cycleCount, healthScore, baselineFragility, sessionDrift, lspHotspots, lspCallers, synthesisAlerts, semanticNeighbors, vectorReady: semanticNeighbors.size > 0 };
  } catch (e) {
    console.warn('[loadEngineSnapshot] engine data unavailable:', e);
  }
}

let _snapshotRefreshTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleEngineSnapshotRefresh(ctx: GraphContext, projectPath: string): void {
  if (_snapshotRefreshTimer) clearTimeout(_snapshotRefreshTimer);
  _snapshotRefreshTimer = setTimeout(() => {
    _snapshotRefreshTimer = null;
    loadEngineSnapshot(ctx, projectPath, true).catch(() => {});
  }, 3000);
}
