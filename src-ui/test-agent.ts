/**
 * Agent 测试脚本 — Node.js 环境，不依赖 Tauri/浏览器。
 * 用法：npx tsx test-agent.ts
 *
 * 需要设置环境变量：
 *   DEEPSEEK_API_KEY=sk-xxxx
 * 或修改下面的 API_KEY
 */

import { execSync } from 'child_process';
import * as readline from 'readline';
import { Agent } from './src/agent/agent';
import { ToolRegistry, createHologramTools } from './src/agent/tool';
import { createOpenAIProvider } from './src/provider/openai';
import type { EventSink, AgentEvent } from './src/agent/agent';
import { EventKind } from './src/agent/agent';

// ══════════════════════════════════════
// 配置
// ══════════════════════════════════════

const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const MODEL = 'deepseek-chat';
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const PYTHON = process.env.PYTHON_PATH || 'python';
const GRAPH_FILE = process.env.GRAPH_FILE || `${PROJECT_ROOT}/hologram_full.json`;

// ══════════════════════════════════════
// Tool Executor — 通过 Python CLI 执行
// ══════════════════════════════════════

async function pythonExec(toolName: string, args: Record<string, unknown>): Promise<string> {
  const cliArgs: string[] = [];
  const graph = args.graph as string || GRAPH_FILE;

  switch (toolName) {
    case 'hologram_analyze': {
      const path = args.path as string || PROJECT_ROOT;
      return run(`${PYTHON} -m src_python analyze "${path}" -o "${GRAPH_FILE}"`);
    }
    case 'hologram_neighbors': {
      const nodeId = args.node_id as string;
      return run(`${PYTHON} -m src_python neighbors "${nodeId}" -g "${graph}"`);
    }
    case 'hologram_impact': {
      const nodeId = args.node_id as string;
      const d = args.max_depth as number;
      if (d && d > 0) {
        return run(`${PYTHON} -m src_python impact "${nodeId}" -d ${d} -g "${graph}"`);
      }
      return run(`${PYTHON} -m src_python impact "${nodeId}" -g "${graph}"`);
    }
    case 'hologram_path': {
      const from = args.from as string;
      const to = args.to as string;
      return run(`${PYTHON} -m src_python path "${from}" "${to}" -g "${graph}"`);
    }
    case 'hologram_diff': {
      const before = args.before_path as string;
      const after = (args.after_path as string) || GRAPH_FILE;
      return run(`${PYTHON} -m src_python diff "${before}" "${after}"`);
    }
    case 'hologram_fragile': {
      const limit = args.limit || 10;
      return run(`${PYTHON} -m src_python fragile -l ${limit} -g "${graph}"`);
    }
    case 'hologram_cycle': {
      const mode = args.mode || 'all';
      return run(`${PYTHON} -m src_python cycle -m ${mode} -g "${graph}"`);
    }
    case 'hologram_coupling_report': {
      const module = args.module as string;
      return run(`${PYTHON} -m src_python coupling-report "${module}" -g "${graph}"`);
    }
    case 'hologram_graph_summary': {
      return run(`${PYTHON} -c "
import sys, json
sys.path.insert(0, '${PROJECT_ROOT}/src_python')
from core.graph import Graph
graph = Graph.from_json('${graph}')
nodes = list(graph.nodes.values())
edges = list(graph.edges.values())
node_types = {}
edge_types = {}
for n in nodes:
    nt = n.type.value if hasattr(n.type, 'value') else str(n.type)
    node_types[nt] = node_types.get(nt, 0) + 1
for e in edges:
    et = e.type.value if hasattr(e.type, 'value') else str(e.type)
    edge_types[et] = edge_types.get(et, 0) + 1
n = len(nodes)
density = round((2 * len(edges)) / (n * (n - 1)), 6) if n > 1 else 0
print(json.dumps({
    'total_nodes': n,
    'total_edges': len(edges),
    'node_types': node_types,
    'edge_types': edge_types,
    'density': density,
    'top_node_kinds': sorted(node_types.items(), key=lambda x: x[1], reverse=True)[:10]
}, indent=2, ensure_ascii=False))
"`);
    }
    case 'hologram_blindspots':
    case 'hologram_thread_conflicts':
    case 'hologram_timeline':
    case 'hologram_community_report': {
      return `Tool "${toolName}" not available in CLI test mode. Use the Tauri app for full support.`;
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

function run(cmd: string): string {
  try {
    const result = execSync(cmd, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    return result || '(no output)';
  } catch (e: any) {
    return `error: ${e.stderr || e.message || e}`;
  }
}

// ══════════════════════════════════════
// Event Sink — 终端输出
// ══════════════════════════════════════

const sink: EventSink = (ev: AgentEvent) => {
  switch (ev.kind) {
    case EventKind.TurnStarted:
      // silent
      break;
    case EventKind.Reasoning:
      process.stdout.write(`\x1b[90m${ev.text}\x1b[0m`);
      break;
    case EventKind.Text:
      process.stdout.write(ev.text || '');
      break;
    case EventKind.Message:
      process.stdout.write('\n');
      break;
    case EventKind.ToolDispatch:
      if (!ev.tool?.partial) {
        console.log(`\n\x1b[36m🔧 ${ev.tool?.name}\x1b[0m ${ev.tool?.args?.slice(0, 100) || ''}`);
      }
      break;
    case EventKind.ToolResult:
      if (ev.tool?.err) {
        console.log(`\x1b[31m  ✗ ${ev.tool.err}\x1b[0m`);
      } else {
        const preview = (ev.tool?.output || '').slice(0, 200);
        console.log(`\x1b[32m  ✓\x1b[0m ${preview}${preview.length >= 200 ? '...' : ''}`);
      }
      break;
    case EventKind.Usage:
      if (ev.usage) {
        const cost = ev.pricing
          ? ((ev.usage.cache_hit_tokens * ev.pricing.cache_hit +
              ev.usage.cache_miss_tokens * ev.pricing.input +
              ev.usage.completion_tokens * ev.pricing.output) / 1_000_000)
          : 0;
        console.log(`\n\x1b[90m📊 ${ev.usage.total_tokens} tokens · ${ev.usage.finish_reason} · ~$${cost.toFixed(4)}\x1b[0m`);
      }
      break;
    case EventKind.Notice:
      const icon = ev.level === 'warn' ? '⚠' : 'ℹ';
      console.log(`\x1b[33m${icon} ${ev.text}\x1b[0m`);
      break;
  }
};

// ══════════════════════════════════════
// Agent 初始化
// ══════════════════════════════════════

const provider = createOpenAIProvider({
  name: 'deepseek',
  apiKey: API_KEY,
  baseUrl: 'https://api.deepseek.com',
  model: MODEL,
});

const registry = new ToolRegistry();
for (const tool of createHologramTools(pythonExec)) {
  registry.register(tool);
}

const systemPrompt = `You are a code topology analyst. You have access to hologram tools that query the dependency graph of this codebase.

The codebase is at: ${PROJECT_ROOT}
The pre-computed graph is at: ${GRAPH_FILE}

When answering:
- Use hologram_graph_summary first to understand the codebase structure
- Use hologram_fragile to find weak modules
- Use hologram_coupling_report to deep-dive into specific modules
- Use hologram_neighbors and hologram_impact to trace dependencies
- Use hologram_cycle to find circular dependencies
- Synthesize findings into actionable recommendations for the developer

Be concise. Output in Chinese when helpful.`;

const agent = new Agent(provider, registry, systemPrompt, { maxSteps: 10 }, sink);

// ══════════════════════════════════════
// 交互循环
// ══════════════════════════════════════

console.log('╔══════════════════════════════════╗');
console.log('║  全息观测站 Agent — 测试模式     ║');
console.log('║  Provider: DeepSeek              ║');
console.log('║  Tools:    Python CLI (2 test)    ║');
console.log('╚══════════════════════════════════╝');
console.log('');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function chat(input: string) {
  if (!input.trim()) return;
  if (input === '/exit' || input === '/quit') {
    console.log('再见。');
    rl.close();
    process.exit(0);
  }

  const controller = new AbortController();

  try {
    await agent.run(controller.signal, input);
  } catch (err: any) {
    console.error(`\n\x1b[31mAgent error: ${err.message}\x1b[0m`);
  }

  console.log('');
  prompt();
}

function prompt() {
  rl.question('\x1b[1m你 > \x1b[0m', chat);
}

prompt();
