// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AgentBootstrap — pure function that creates the Provider, ToolRegistry,
// and Agent factory. Extracted from Workspace._setupAgentInner to break
// the God Class pattern.
//
// Responsibilities:
//   - Create Provider from settings
//   - Register all tools (hologram, coding, skill, memory, task)
//   - Build system prompt
//   - Create Agent factory (used for both initial agent and new sessions)
//   - Wire hooks (graph context, preflight, AuraSDK recall)
//
// NOT responsible for:
//   - Reading files / persisting settings
//   - Creating MemoryManager / AgentStore / GoalManager / SkillRegistry
//   (these are created by Workspace and passed in)

import { Agent } from './agent';
import { AgentStore } from './agent-store';
import type { AgentEvent, AgentUINotifier, EventSink } from './agent-types';
import { createCompactionTools } from './compaction-model';
import { SubAgentPool } from './coordinator';
import type { ExecStateInstance } from './execution-state';
import { GoalManager } from './goal-manager';
import type { GraphContext } from './hooks';
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
} from './hooks';
import { memoryBundleIngest } from './memory-bundle-client';
import { MemoryManager } from './memory';
import { createSkillTool, SkillRegistry } from './skills';
import { buildTurnStartBlock, refreshGitStatus, refreshTimeline } from './state-inject';
import { createTaskTools, TaskManager } from './task';
import type { Tool } from './tool';
import { agentInvoke, createCodingTools, createSubAgentTool, type ToolExecutor, ToolRegistry } from './tool';

import { listen, rpc } from '../bridge';
import type { Provider } from '../provider/types';
import { createProvider } from '../provider';
import { defaultPricing, getActiveProvider, loadSettings, restoreSecrets, persistSecrets } from '../settings';
import { msgStoreForActive } from '../ui/chat-store';
import { bus } from '../ui/events';
import { getDiagnosticsForFile } from '../ui/lsp-client';
import type { SubAgentPart } from '../ui/message-model';
import { getPanelStore } from '../ui/panel-store';
import { createSubAgentSink } from '../ui/subagent-sink';
import { dbg } from '../ui/debug';
import { refreshGitStatus as _rgs, refreshTimeline as _rt } from './state-inject';

// ── Types ──

export interface BootstrapInput {
  settings: ReturnType<typeof loadSettings>;
  projectPath: string;
  graphData: any;
  memoryManager: MemoryManager;
  skillRegistry: SkillRegistry;
  taskManager: TaskManager;
  agentStore: AgentStore;
  goalManager: GoalManager;
  subAgentPool: SubAgentPool;
  storeId: string;
  eventSink: (ev: AgentEvent) => void;
  execState: ExecStateInstance;
  onStatusChange: ((msg: string) => void) | null;
}

export interface BootstrapOutput {
  provider: Provider;
  toolRegistry: ToolRegistry;
  factory: () => Promise<Agent | null>;
  preflightCtx: GraphContext | null;
}

// ── Dynamic tool loading from engine registry ──

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

// ── Helpers ──

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

function registerCompactionTools(agent: Agent, reg: ToolRegistry): void {
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

function modeState(storeId: string): { collaborationMode: 'normal' | 'plan'; permissionMode: 'ask' | 'auto' | 'yolo' } {
  try {
    const ps = getPanelStore(storeId).getState();
    return { collaborationMode: ps.collaborationMode as any, permissionMode: ps.permissionMode as any };
  } catch {
    return { collaborationMode: 'normal', permissionMode: 'ask' };
  }
}

function planRegistry(base: ToolRegistry): ToolRegistry {
  const out = new ToolRegistry();
  for (const t of base.filterReadOnly()) out.register(t);
  return out;
}

function buildSystemPrompt(
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

  const nodes = graphData?.nodes
    ? (Array.isArray(graphData.nodes) ? graphData.nodes.length : Object.keys(graphData.nodes).length)
    : 0;

  // ── No graph loaded — lightweight identity prompt ──
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

  // ── Full coding-agent prompt ──
  const modeBlock = collaborationMode === 'plan'
    ? `
## 规划模式（当前激活）
你只有只读工具。不能写文件、跑命令、改代码、Git 操作。
- 用户让你"修"时，输出方案（改哪个文件、怎么改、diff），不要动手
- 方案确定后用 ask_user 请用户切到正常模式再执行`
    : `
## 执行模式
你有写文件、跑命令、Git 的全部工具。用户说"修"就直接修，修完跑测试验证。`;

  return `你是 HoloGram 的编码 Agent。你有 ${nodes} 个节点、${projectPath ? '已加载依赖图' : '当前项目'}。

## 模型身份
- ${modelNegation}
- ${modelIdentity}

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
${modeBlock}
${collaborationMode !== 'plan' ? `
## 子 Agent
agent_spawn 阻塞到子 Agent 完成，结果就是工具返回值。
- 同一轮发多个 agent_spawn 即可并行
- prompt 要自足——子 Agent 看不到你的对话
- 大任务才委派（多文件改动），小任务自己做` : ''}

## 项目上下文
- 路径: \`${projectPath}\`
${graphSnapshot ? `\n\`\`\`\n${graphSnapshot}\n\`\`\`` : ''}
${memorySection ? `\n## 记忆库\n${memorySection}` : ''}
${claudeMdSection ? `\n## 项目规范\n${claudeMdSection}` : ''}`;
}
let _snapshotRefreshTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleEngineSnapshotRefresh(ctx: GraphContext, projectPath: string): void {
  if (_snapshotRefreshTimer) clearTimeout(_snapshotRefreshTimer);
  _snapshotRefreshTimer = setTimeout(() => {
    _snapshotRefreshTimer = null;
    loadEngineSnapshot(ctx, projectPath, true).catch(() => {});
  }, 3000);
}
