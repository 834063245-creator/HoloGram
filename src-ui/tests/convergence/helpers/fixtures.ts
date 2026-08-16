// Convergence 测试基建 — 确定性夹具。
//
// 目标：同一份代码在任何机器、任何时间跑出字节相同的契约输出。
// 内容：录制型 ToolExecutor、固定图数据、标准工具注册表、合成门禁工具、脚本化 Provider。

import { SubAgentPool } from '../../../src/agent/coordinator';
import { buildGraphSnapshot } from '../../../src/agent/hooks';
import { buildToolRegistry } from '../../../src/agent/runtime/agent-builder';
import { TaskManager } from '../../../src/agent/task';
import type { Tool, ToolExecutor, ToolRegistry } from '../../../src/agent/tool';
import type { SubAgentSpawner } from '../../../src/agent/tools/subagent';
import type { Chunk, Provider, Usage } from '../../../src/provider/types';
import { ChunkType } from '../../../src/provider/types';

// ── 录制型执行器：不触 Tauri，记录调用并返回空串 ──

export function recordingExec(log: Array<{ name: string; args: Record<string, unknown> }> = []): ToolExecutor {
  return async (name, args) => {
    log.push({ name, args });
    return '';
  };
}

// ── 固定图数据 — buildGraphSnapshot/buildFileNodeIndex 的确定性输入 ──

export const FIXED_GRAPH_DATA = {
  nodes: [
    { id: 'demo/core.ts', name: 'core', community_id: 0 },
    { id: 'demo/adapter.ts', name: 'adapter', community_id: 0 },
    { id: 'demo/ui.ts', name: 'ui', community_id: 1 },
    { id: 'demo/util.ts', name: 'util', community_id: 1 },
  ],
  edges: [
    { source: 'demo/adapter.ts', target: 'demo/core.ts', kind: 'import' },
    { source: 'demo/ui.ts', target: 'demo/core.ts', kind: 'call' },
    { source: 'demo/ui.ts', target: 'demo/util.ts', kind: 'import' },
    { source: 'demo/core.ts', target: 'demo/util.ts', kind: 'call' },
  ],
};

export function fixedGraphSnapshot(): string {
  return buildGraphSnapshot(FIXED_GRAPH_DATA);
}

// ── 标准注册表：真实 buildToolRegistry 生产路径 + 确定性依赖 ──
//
// 说明：graphData 给固定图 → hologram 动态工具走 loadHologramSchemas()，
// 测试环境（无 Tauri bridge）恒返回 []——引擎侧工具面由 Rust 测试与 RPC 契约守护，
// 本快照覆盖静态注册面（coding/task/browser/desktop/wait + 领域收敛）。
// memory/skill 为可选依赖，不传入（生产同样可缺省）。

export async function buildStandardRegistry(): Promise<ToolRegistry> {
  const stubSpawner = (async () => 'stub-spawn-result') as unknown as SubAgentSpawner;
  return buildToolRegistry({
    graphData: FIXED_GRAPH_DATA,
    deps: {},
    taskManager: new TaskManager(),
    subAgentPool: new SubAgentPool(),
    subAgentSpawner: stubSpawner,
  });
}

// ── 合成工具 — planGate / hook 管道快照用（形状对齐 tests/plan-gate.test.ts）──

export function fsDomainTool(executed: string[] = []): Tool {
  return {
    name: () => 'fs',
    description: () => 'fs domain',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => false,
    domain: () => 'fs',
    actions: () => ['read', 'write', 'edit', 'list'],
    readOnlyActions: () => ['read', 'list'],
    execute: async (args) => {
      executed.push(String((args as { action?: unknown }).action));
      return 'ok';
    },
  };
}

export function agentDomainTool(executed: string[] = []): Tool {
  return {
    name: () => 'agent',
    description: () => 'agent domain',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => false,
    domain: () => 'agent',
    actions: () => ['spawn', 'kill', 'inbox', 'list'],
    readOnlyActions: () => ['inbox', 'list'],
    execute: async (args) => {
      executed.push(String((args as { action?: unknown }).action));
      return 'ok';
    },
  };
}

export function readOnlyTool(executed: string[] = []): Tool {
  return {
    name: () => 'graph_summary',
    description: () => 'summary',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => true,
    execute: async () => {
      executed.push('graph_summary');
      return 'ok';
    },
  };
}

/** 可富化工具：post hook 命中时在结果尾部追加标记。 */
export function enrichableTool(): Tool {
  return {
    name: () => 'search_content',
    description: () => 'search',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => true,
    execute: async () => 'raw-result',
  };
}

/** 抛错工具：execute 恒抛 Error（错误路径快照用）。 */
export function throwingTool(): Tool {
  return {
    name: () => 'boom_tool',
    description: () => 'throws',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => false,
    execute: async () => {
      throw new Error('boom');
    },
  };
}

/** 进度工具：execute 期间发两次 onProgress。 */
export function progressTool(): Tool {
  return {
    name: () => 'slow_tool',
    description: () => 'progress',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => true,
    execute: async (_args, onProgress) => {
      onProgress?.('chunk-1');
      onProgress?.('chunk-2');
      return 'done';
    },
  };
}

/** preflight 目标工具：命中 GRAPH_PREFLIGHT 名单语义（edit_file）。 */
export function legacyEditTool(): Tool {
  return {
    name: () => 'edit_file',
    description: () => 'legacy edit',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => false,
    execute: async () => 'edited',
  };
}

// ── 脚本化 Provider — Phase 2/3 差分测试的确定性模型侧 ──

const USAGE: Usage = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  cache_hit_tokens: 0,
  cache_miss_tokens: 10,
  reasoning_tokens: 0,
  cache_creation_tokens: 0,
  finish_reason: 'stop',
};

/** 按脚本逐轮出块的假 Provider：每轮 yield 同一组 chunk。
 *  无状态 — 并发/重放安全；输入敏感脚本请直接写自定义 generator。 */
export function scriptedProvider(script: Chunk[]): Provider {
  return {
    name: () => 'mock',
    stream: async function* () {
      for (const c of script) yield c;
    },
  };
}

export { ChunkType, USAGE };
