/**
 * Agent 单次测试 — 发送一条消息，打印结果，退出。
 * 用法：npx tsx test-once.ts "你的问题"
 */
import { execSync } from 'child_process';
import { Agent, EventKind } from './src/agent/agent';
import type { AgentEvent } from './src/agent/agent';
import { ToolRegistry, createHologramTools } from './src/agent/tool';
import { createOpenAIProvider } from './src/provider/openai';

const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const PYTHON = process.env.PYTHON_PATH || 'python';
const GRAPH_FILE = process.env.GRAPH_FILE || `${PROJECT_ROOT}/hologram_full.json`;

async function pythonExec(toolName: string, args: Record<string, unknown>): Promise<string> {
  try {
    let cmd: string;
    const graph = (args.graph as string) || GRAPH_FILE;
    switch (toolName) {
      case 'hologram_analyze': {
        const path = (args.path as string) || PROJECT_ROOT;
        cmd = `${PYTHON} -m src_python analyze "${path}" -o "${GRAPH_FILE}"`;
        break;
      }
      case 'hologram_neighbors': {
        cmd = `${PYTHON} -m src_python neighbors "${args.node_id}" -g "${graph}"`;
        break;
      }
      case 'hologram_impact': {
        const d = args.max_depth as number;
        cmd = d && d > 0
          ? `${PYTHON} -m src_python impact "${args.node_id}" -d ${d} -g "${graph}"`
          : `${PYTHON} -m src_python impact "${args.node_id}" -g "${graph}"`;
        break;
      }
      case 'hologram_path': {
        cmd = `${PYTHON} -m src_python path "${args.from}" "${args.to}" -g "${graph}"`;
        break;
      }
      case 'hologram_diff': {
        cmd = `${PYTHON} -m src_python diff "${args.before_path}" "${args.after_path || GRAPH_FILE}"`;
        break;
      }
      case 'hologram_fragile': {
        const limit = args.limit || 10;
        cmd = `${PYTHON} -m src_python fragile -l ${limit} -g "${graph}"`;
        break;
      }
      case 'hologram_cycle': {
        const mode = args.mode || 'all';
        cmd = `${PYTHON} -m src_python cycle -m ${mode} -g "${graph}"`;
        break;
      }
      case 'hologram_coupling_report': {
        cmd = `${PYTHON} -m src_python coupling-report "${args.module}" -g "${graph}"`;
        break;
      }
      case 'hologram_graph_summary': {
        cmd = `${PYTHON} -c "
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
"`;
        break;
      }
      default:
        return `工具 "${toolName}" 暂未在 CLI 测试模式中实现。`;
    }

    const result = execSync(cmd, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    return result || '(无输出)';
  } catch (e: any) {
    return `错误: ${e.stderr || e.message || e}`;
  }
}

const sink = (ev: AgentEvent) => {
  switch (ev.kind) {
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
        console.log(`\n\x1b[36m🔧 ${ev.tool?.name}\x1b[0m`);
      }
      break;
    case EventKind.ToolResult:
      if (ev.tool?.err) {
        console.log(`\x1b[31m  ✗ ${ev.tool.err}\x1b[0m`);
      } else {
        const preview = (ev.tool?.output || '').slice(0, 200).replace(/\n/g, ' ');
        console.log(`\x1b[32m  ✓\x1b[0m ${preview}${preview.length >= 200 ? '...' : ''}`);
      }
      break;
    case EventKind.Usage:
      if (ev.usage) {
        console.log(`\n\x1b[90m📊 ${ev.usage.total_tokens} tokens · finish=${ev.usage.finish_reason} · hit=${ev.usage.cache_hit_tokens}\x1b[0m`);
      }
      break;
    case EventKind.Notice:
      console.log(`\x1b[33m${ev.level === 'warn' ? '⚠' : 'ℹ'} ${ev.text}\x1b[0m`);
      break;
  }
};

async function main() {
  const question = process.argv[2] || '分析一下这个项目的整体结构';

  const provider = createOpenAIProvider({
    name: 'deepseek',
    apiKey: API_KEY,
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  });

  const registry = new ToolRegistry();
  for (const tool of createHologramTools(pythonExec)) {
    registry.register(tool);
  }

  const systemPrompt = `你是代码拓扑分析助手。你可以使用 hologram 工具查询这个代码库的依赖图。

代码库路径: ${PROJECT_ROOT}
预计算图谱: ${GRAPH_FILE}

使用工具时:
- 先用 hologram_graph_summary 了解整体结构
- 用 hologram_fragile 找脆弱模块
- 用 hologram_coupling_report 深入分析特定模块
- 用 hologram_neighbors 和 hologram_impact 追踪依赖
- 用 hologram_cycle 查找循环依赖
- 综合发现给出可操作的建议

用中文回答。简洁。`;

  const agent = new Agent(provider, registry, systemPrompt, { maxSteps: 10 }, sink);

  console.log(`\n\x1b[1m🔍 问题: ${question}\x1b[0m\n`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    await agent.run(controller.signal, question);
  } catch (err: any) {
    console.error(`\n\x1b[31mAgent error: ${err.message}\x1b[0m`);
  } finally {
    clearTimeout(timeout);
  }

  console.log('\n\x1b[1m✅ 完成\x1b[0m');
}

main();
