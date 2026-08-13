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
import { typedRpc } from '../../rpc-contract';
import { z } from 'zod';
import { createCompactionTools } from '../compaction-model';
import type { GraphContext } from '../hooks';
import { defineTool } from '../tools/define-tool';
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
import { createSubAgentTool, createAgentKillTool, createAgentStatusTool } from '../tools/subagent';
import { createSkillTool } from '../skills';
import { createTaskTools } from '../task';
import { execStreamedShell } from './queued-shell';
import { createWaitTool } from '../tools/wait';
import { convergeRegistry } from '../tools/domains';
import { registerMcpTools, type McpClient } from '../mcp';

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
    batchIndex?: number;
    batchTotal?: number;
    callback: (answer: string[] | null) => void;
  }) => void;
  /** exit_plan_mode 工具的计划审批回调（UI 展示计划审批 banner） */
  onPlanReview?: (req: import('../plan/plan-tools').PlanReviewRequest) => void;
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
    const raw = await typedRpc('hologram_tools_list', {});
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
  providerName?: string,
  shellEnvSection = '',
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
    if (shellEnvSection.trim()) {
      prompt += `\n\n## 运行环境\n${shellEnvSection.trim()}`;
    }
    return prompt;
  }

  // 协作模式块必须模式无关：footer 热切换 / enter_plan_mode 都不重建系统提示词
  // （重建会击穿前缀缓存）。规划模式的完整工作流由 PlanModeInjector 的运行时
  // system-reminder 携带（plan/plan-prompts.ts），此处只写两种模式的静态约定。
  const modeBlock = `
## 协作模式
- 默认为**执行模式**：写文件、跑命令、Git 的全部工具可用。用户说"修"就直接修，修完跑测试验证。
- 用户可随时切入**规划模式**（只读分析 + 写计划文件）：经 enter_plan_mode 或界面切换。当前模式以运行时 system-reminder 为准；规划模式下写操作在执行层拦截（写计划文件除外），不要硬试。`;

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
13. **别用 shell(run) 搜文件/搜代码/操作 Git**。找文件用 fs(glob)，搜文本用 search(content)，Git 用 git(…)。shell(run) 只用于构建和测试。
14. **工具调用一律用领域工具名**（fs/shell/git/search/web/agent/task/memory/ask_user/Skill/wait/plan/browser）。历史会话里出现的旧名（run_shell/write_file/read_file_content/edit_file/search_content/git_* 等）不要再用。

## 视觉自评纪律（改 UI 后必做）
- 改完 UI 相关文件（css/tsx/html）后，**不要默认"写完了"** —— 你写的是代码，不是看到的画面。
- 用 browser 工具自查渲染结果：先 \`browser(report)\` 拿问题清单，再 \`browser(inspect, selector)\` 定位具体元素，修改后复查。
- 迭代上限 3 轮：改 1 次 → report 1 次 → 问题清零或收敛到可接受。
- 自家 webview 用 \`target: "self"\`（内直读）；操作外部页面（用户给的 Chrome 等）先 launch → targets → attach，外部 attach 需用户批准。
${modeBlock}`;

  let suffix = `\n## 模型身份
- ${modelNegation}
- ${modelIdentity}
- 项目: \`${projectPath}\``;

  // 多 Agent 段落无条件包含：规划模式下 agent(spawn) 仍可用（子 Agent 静态
  // 降级为只读克隆，见 planRegistry），内容在两种模式下都成立。
  suffix += `\n\n## 多 Agent 协作

### 子 Agent
- agent(spawn) 阻塞到子 Agent 完成，结果就是工具返回值。同一轮发多个可并行。大任务才委派，小任务自己做。
- **分工**：并行派发多个子 Agent 时，给每个 Agent 明确的、不重叠的文件范围。如果两个子 Agent 可能改同一批文件，改为串行或合并成一个任务。
- **验证**：子 Agent 不跑构建/测试（避免并行文件锁争抢）。所有子 Agent 返回后，由你统一跑一次编译/测试验证。

### 异步子 Agent
- 设 async=true 时 agent(spawn) 立即返回 agentId，不阻塞当前轮次。
- 适合长时间任务（重构、批量修改、跑测试套件）。你在等待期间可以继续处理其他工作。
- 异步子 Agent 完成后，结果通过 agent(message)（type: 'result'）推送到你的 inbox。
- 收到 type: 'result' 消息后：用 agent(ack) 确认，然后调 agent(merge) 合并其工作成果到主仓库。
- 异步子 Agent 最多 5 个并发。池满时 agent(spawn) 返回错误——先 agent(merge) 清理已完成的，或等现有任务结束。

### 合并
- agent(merge) 将已完成子 Agent 的 worktree 串行合并回主仓库。
- 冲突时 diff 保存在 TaskBoard 上，你需要手动用 fs(edit) 应用。
- 合并是不可逆操作——确认子 Agent 工作无误后再合并。

### Agent 间通信
- agent(message) 向指定 Agent 发消息（fire-and-forget，不等回复）。消息存入对方 inbox，30 分钟后自动过期。
- agent(request) 向指定 Agent 发同步请求并阻塞等待回复（有超时，默认 30 秒，最大 120 秒）。当你需要另一个 Agent 的直接回答时使用。
- **消息自动注入**：result/reply 消息会自动注入到你的上下文并从 inbox 移除，无需手动确认。
- request 消息会注入完整内容但保留在 inbox 中——用 agent(reply) 回复后会自动移除。
- 其他类型的消息显示轻量通知，用 agent(inbox) 查看详情。未查看的消息 30 分钟后自动过期。
- agent(inbox) 列出所有未过期消息。
- agent(ack) 确认自由类型消息已读（从 inbox 移除）。强消费类型消息无需手动 ack。
- agent(reply) 回复 inbox 中的消息。
- agent(list) 列出当前拓扑下可通信的 Agent。

### 共享发现
- agent(discover) 将你的发现发布到共享发现区（key / value / category）。
  类别：architecture（架构决策）、bug（缺陷）、pattern（模式/约定）、config（配置）。
- agent(lookup) 查询其他 Agent 发布的发现。
  在开始探索前用 agent(lookup) 检查已有发现，避免重复工作。
- 发现区自动注入：每轮开始时，你会看到其他 Agent 最新的发现（5 分钟内，<system-reminder> 格式）。

### 决策指南
- **同步 spawn**：短任务（< 1 分钟）、需要结果才能继续、单文件改动。
- **异步 spawn**：长任务（> 1 分钟）、互不依赖的并行任务、批量操作。
- **通信**：只在需要协调时发消息。收到 type: 'result' 后必须 agent(merge)。
- **不要**对正在运行的异步子 Agent 发 agent(message) 催促进度——等 result 消息。

### 拆分与执行（批量并行时的准则）
- **拆得越细越好，不要省 Agent 数量**：把大任务切成多个互不冲突的子任务并行派发。子 Agent 拥有你的完整能力，任务可以切得很细。只有真正不可分割时才合并任务。
- **子 Agent 的 prompt 要精简**：只给必要背景 + 该子 Agent 的具体任务，不要塞过多细节（它能力完整，自己能查）。每个子 Agent 拿到的任务范围必须明确、可独立完成。
- **范围硬约束**：写类任务必须给每个子 Agent 不重叠的文件范围；两个子 Agent 可能改同一文件时，改为串行或合并成一个任务。
- **读类任务可放宽**：只读/检查/回报类子 Agent 范围可以适度重叠，用 **fresh 模式**（不隔离、低开销、直接改主工作区）；写类任务用 **fork 模式**（worktree 隔离，靠 agent(merge) 合并回来）。
- **不自己包揽主活**：拆分清楚后，把各子任务交给子 Agent，别在主 Agent 里重复做。`;

  if (graphSnapshot) {
    suffix += `\n\n## 项目架构快照\n\`\`\`\n${graphSnapshot}\n\`\`\``;
  }
  if (memorySection) {
    suffix += `\n\n## 记忆库\n${memorySection}`;
  }
  if (claudeMdSection) {
    suffix += `\n\n## 项目规范\n${claudeMdSection}`;
  }

  // 运行环境块 — 由 Runtime 探测 shell_env 注入，Agent 第一轮就知道
  // 命令跑在哪个解释器上，从源头消灭"猜语法"类错误（对齐三家成熟框架做法）。
  let envBlock = '';
  if (shellEnvSection.trim()) {
    envBlock = `\n\n## 运行环境\n${shellEnvSection.trim()}`;
  }

  return staticRules + envBlock + suffix;
}

// ── Tool registry builder ──

export interface ToolRegistryOptions {
  graphData: any;
  deps: BuilderDeps;
  memoryManager?: MemoryManager;
  skillRegistry?: SkillRegistry;
  taskManager: TaskManager;
  subAgentPool: SubAgentPool;
  /** 子 Agent spawn 函数 — 由 Runtime 注入 */
  subAgentSpawner?: SubAgentSpawner;
  /** 外部 MCP server client 列表 — 其工具以 mcp__<server>__<name> 注册进 registry */
  mcpClients?: McpClient[];
}

import type { MemoryManager } from '../memory';
import type { SkillRegistry } from '../skills';
import type { SubAgentPool } from '../coordinator';
import type { TaskManager } from '../task';
import type { SubAgentSpawner } from '../tools/subagent';

export async function buildToolRegistry(opts: ToolRegistryOptions): Promise<ToolRegistry> {
  const { graphData, deps, memoryManager: mm, skillRegistry, taskManager, subAgentPool, subAgentSpawner, mcpClients } = opts;
  const registry = new ToolRegistry();

  // ── Hologram tools ──
  if (graphData) {
    const holoExec: ToolExecutor = async (name, args) => {
      const result = await typedRpc('hologram_call', { tool: name, args });
      return typeof result === 'string' ? result : JSON.stringify(result);
    };
    const schemas = await loadHologramSchemas();
    for (const tool of schemas.map((s) => mcpSchemaToTool(s, holoExec))) registry.register(tool);

    registry.register(
      defineTool({
        name: 'dataflow_save',
        description: '保存数据流追踪结果到 .hologram/dataflow/，供面板查看和后续查询。',
        schema: z.object({
          query: z.string(),
          content: z.string(),
        }),
        execute: async (args) => {
          const r = await agentInvoke('dataflow_save', args);
          deps.onDataflowSaved?.();
          return r;
        },
      }),
    );
    registry.register(
      defineTool({
        name: 'dataflow_query',
        description: '查询已保存的数据流追踪结果。',
        schema: z.object({
          traceId: z.string().optional(),
          list: z.boolean().optional(),
        }),
        readOnly: true,
        execute: (args) => agentInvoke('dataflow_query', args),
      }),
    );
  }

  // ── Shell 执行（2026-08-10：队列退役，直连流式） ──
  // 多 Agent 构建锁互斥由 Rust 侧 BuildLock 承担（资源级原子检查 + 带路径打回，
  // 见 src-tauri/src/utils.rs）：冲突时 exec_command 返回错误，不排队不串行化。
  // abort 取消保留：bash_kill 携带 agent_id 身份，只能 kill 自己发起的 job。

  // ── Coding tools ──
  // 后台任务等待总上限:后台 job 若卡死(如 cargo 等待 target 文件锁)可能无限期运行,
  // 无总上限时下面的 for(;;) 循环永远 pending,Agent 会话表现为"无限等待 shell 结果"。
  const BG_WAIT_TIMEOUT = 30 * 60 * 1000;
  const codingExec: ToolExecutor = async (name, args, onProgress, signal) => {
    if (name === 'run_shell' && args.runInBackground) {
      // 命令名必须是 exec_command(run_shell 不是 Tauri 命令),args 已含 runInBackground: true
      const raw = await agentInvoke<string>('exec_command', args);
      const m = /ID:\s*(\d+)/.exec(raw);
      if (!m) return raw; // 启动失败 — 把 Rust 返回的消息直接给 agent（含构建锁打回）
      const jobId = m[1];
      let last = '';
      const bgDeadline = Date.now() + BG_WAIT_TIMEOUT;
      for (;;) {
        try {
          last = await agentInvoke<string>('bash_wait', { job_id: jobId, timeout_ms: 60_000 });
        } catch (e: any) {
          const msg = String(e?.message || e);
          if (msg.includes('等待超时')) {
            // 任务仍在跑 — 检查总超时,超时则放弃等待并把控制权交还 Agent
            if (Date.now() >= bgDeadline) {
              return `[exit -1] 后台任务已等待 ${BG_WAIT_TIMEOUT / 1000}s 仍未完成,已放弃等待(可能卡在文件锁或等待输入)。当前输出:\n${last}\n可用 bash_output(${jobId}) 查看进度, bash_kill(${jobId}) 终止任务。`;
            }
            if (onProgress) onProgress(`[后台任务运行中, job_id: ${jobId}]`);
            continue;
          }
          // 任务已被清理(完成或 kill)— 带最后已知输出返回
          return last ? `[后台任务结束]\n${last}` : `后台任务查询失败: ${msg}`;
        }
        if (last.includes('[任务已完成')) return last;
        if (onProgress) onProgress(last); // 每 60s 报一次进度
      }
    }
    if (name === 'exec_command' && !args.runInBackground) {
      // 直连流式执行（取消语义 + 600s 兜底）— 实现见 queued-shell.ts。
      // 构建锁冲突由 Rust 打回（错误信息直接返回，模型据此重试/等待）。
      return execStreamedShell(args, onProgress, signal);
    }
    // ── Timeout wrapper for search/list tools — prevent stuck Tauri invokes ──
    const TOOL_TIMEOUT = 120_000;
    const TIMEOUT_TOOLS = new Set(['search_content', 'search_code', 'glob', 'list_directory']);
    if (TIMEOUT_TOOLS.has(name)) {
      return new Promise<string>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(`(工具 ${name} 超时 (${TOOL_TIMEOUT / 1000}s)，请缩小搜索范围或使用更精确的模式)`);
        }, TOOL_TIMEOUT);
        agentInvoke<string>(name, args)
          .then((result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(typeof result === 'string' ? result : JSON.stringify(result));
          })
          .catch((e: any) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(`错误: ${e?.message || e}`);
          });
      });
    }

    const result = await agentInvoke<string>(name, args);
    return typeof result === 'string' ? result : JSON.stringify(result);
  };
  for (const tool of createCodingTools(codingExec, { askUser: deps.onAskUser ?? (() => {}) })) registry.register(tool);
  registry.alias('read_file', 'read_file_content');
  if (skillRegistry) registry.register(createSkillTool(skillRegistry));
  if (mm) for (const tool of (await import('../memory')).createMemoryTools(mm) as any) registry.register(tool);
  for (const tool of createTaskTools(taskManager)) registry.register(tool);

  // ── Sub-agent tools ──
  if (subAgentSpawner) {
    registry.register(createSubAgentTool(subAgentSpawner, subAgentPool));
    registry.register(createAgentStatusTool(subAgentPool));
  }

  // ── Browser tools（Agent 观察/操作前端 — CDP 双通道）──
  // 只注册细粒度 browser_* 工具；领域收敛（browser 领域）由 convergeRegistry
  // 统一处理（DOMAIN_SPECS 已含 browser）。self 通道已统一走 Rust CDP
  // （webview 调试端口惰性 attach，ADR 0003 D4），agent 层零浏览器 API。
  {
    const { createBrowserTools, createDesktopTools } = await import('../tools/browser');
    for (const t of createBrowserTools()) registry.register(t);
    for (const t of createDesktopTools()) registry.register(t);
  }

  // ── wait 工具 — 替代轮询循环（agent_status/bash_output 反复刷屏）。
  // 事件驱动：传 agentId 阻塞到子 Agent 完成；无 pool 时退化为兜底 sleep ──
  registry.register(createWaitTool(subAgentPool));

  // ── 外部 MCP server 工具（mcp__<server>__<name>）──
  // 由调用方（Runtime/UI）在构建时传入已连接好的 McpClient 列表；
  // 这里把其远端工具注册进 registry，Agent 就能像本地工具一样调用。
  if (mcpClients && mcpClients.length > 0) {
    for (const client of mcpClients) {
      if (client.isConnected) {
        registerMcpTools(client, registry);
      }
    }
  }

  // ── 工具层收敛：领域工具 + 隐藏旧名（旧工具保留在 registry 供 executor/测试解析）──
  convergeRegistry(registry);

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

// ── Engine snapshot ──

export async function loadEngineSnapshot(ctx: GraphContext, projectPath: string, isRefresh = false): Promise<void> {
  try {
    const [fragileRaw, cycleRaw, healthRaw, blindspotsRaw] = await Promise.all([
      typedRpc('hologram_call', { tool: 'fragile_modules', args: { limit: 15 } }),
      typedRpc('hologram_call', { tool: 'detect_cycles', args: { mode: 'all' } }),
      typedRpc('hologram_call', { tool: 'project_health', args: { path: projectPath, days: 30 } }),
      typedRpc('hologram_call', { tool: 'arch_blindspots', args: { filter: 'all' } }).catch(() => '{"blindspots":[]}'),
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
        const resolveRaw = await typedRpc('hologram_call', { tool: 'resolve_call', args: { file: r.file } }).catch(() => '{}');
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
        const searchRaw = await typedRpc('hologram_call', { tool: 'search_symbols', args: { query: symbol, limit: 5 } }).catch(() => '{"results":[]}');
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
