// Convergence 测试基建 — hook-pipeline trace 夹具（Phase 0 冻结，Phase 2 差分复用）。
//
// 同一组 fixture 驱动两条执行路径：
//   legacy   —— StreamingToolExecutor 旧直调路径（hooks/preflightHooks/planGate ctor 注入）
//   pipeline —— eventBus 路径（attach* 适配器挂进 AgentEventBus）
// Phase 2 的等价性证明：两条路径对同一 fixture 产出与 phase-0/hook-pipeline.trace.json
// 冻结 baseline 逐字节一致的 trace。

import { EventKind } from '../../../src/agent/agent-types';
import { AgentEventBus, attachHookRegistry, attachPlanGate, attachPreflightRegistry } from '../../../src/agent/events';
import { HookRegistry, PreflightHookRegistry } from '../../../src/agent/hooks';
import { planGateCheck } from '../../../src/agent/plan/plan-registry';
import { PlanStateManager } from '../../../src/agent/plan/plan-state';
import { StreamingToolExecutor } from '../../../src/agent/streaming-executor';
import { type Tool, ToolRegistry } from '../../../src/agent/tool';
import type { ToolCall } from '../../../src/provider/types';
import { enrichableTool, fsDomainTool, legacyEditTool, progressTool, readOnlyTool, throwingTool } from './fixtures';

export type TraceMode = 'legacy' | 'pipeline';

export interface TraceCase {
  label: string;
  build: () => {
    registry: ToolRegistry;
    hooks?: HookRegistry | null;
    preflight?: PreflightHookRegistry | null;
    planGate?: ((name: string, args: Record<string, unknown>, tool: Tool) => string | null) | null;
  };
  calls: Array<{ id: string; name: string; arguments: string }>;
}

export function traceCases(): TraceCase[] {
  const ps = new PlanStateManager();
  ps.enter('/proj');

  return [
    {
      label: '未知工具',
      build: () => ({ registry: regWith(readOnlyTool()) }),
      calls: [{ id: 'c1', name: 'nope_tool', arguments: '{}' }],
    },
    {
      label: '隐藏旧名重定向',
      build: () => {
        const registry = regWith(legacyEditTool());
        registry.hide('edit_file');
        return { registry };
      },
      calls: [{ id: 'c1', name: 'edit_file', arguments: '{}' }],
    },
    {
      label: '非法JSON参数',
      build: () => ({ registry: regWith(readOnlyTool()) }),
      calls: [{ id: 'c1', name: 'graph_summary', arguments: '{invalid' }],
    },
    {
      label: 'planGate拦截',
      build: () => ({
        registry: regWith(fsDomainTool()),
        planGate: (name, args, tool) => planGateCheck(ps, name, args, tool),
      }),
      calls: [{ id: 'c1', name: 'fs', arguments: '{"action":"write","filePath":"/proj/a.ts"}' }],
    },
    {
      label: 'preflight HIGH 拦截',
      build: () => {
        const preflight = new PreflightHookRegistry();
        preflight.register({
          name: 'fixture-high',
          shouldCheck: (n) => n.includes('edit'),
          check: () => '⚠️ fixture 警告 风险等级: HIGH — 合成高风险',
        });
        return { registry: regWith(legacyEditTool()), preflight };
      },
      calls: [{ id: 'c1', name: 'edit_file', arguments: '{"filePath":"/proj/a.ts"}' }],
    },
    {
      label: 'preflight HIGH 带 _forceGate 放行并前置警告',
      build: () => {
        const preflight = new PreflightHookRegistry();
        preflight.register({
          name: 'fixture-high',
          shouldCheck: (n) => n.includes('edit'),
          check: () => '⚠️ fixture 警告 风险等级: HIGH — 合成高风险',
        });
        return { registry: regWith(legacyEditTool()), preflight };
      },
      calls: [{ id: 'c1', name: 'edit_file', arguments: '{"filePath":"/proj/a.ts","_forceGate":true}' }],
    },
    {
      label: 'post hook 富化',
      build: () => {
        const hooks = new HookRegistry();
        hooks.register({
          name: 'fixture-enrich',
          shouldEnrich: (n) => n.includes('search'),
          enrich: async (_n, _a, r) => `${r}\n[ENRICHED]`,
        });
        return { registry: regWith(enrichableTool()), hooks };
      },
      calls: [{ id: 'c1', name: 'search_content', arguments: '{"query":"demo"}' }],
    },
    {
      label: 'post hook 抛错静默降级',
      build: () => {
        const hooks = new HookRegistry();
        hooks.register({
          name: 'fixture-throw',
          shouldEnrich: (n) => n.includes('search'),
          enrich: async () => {
            throw new Error('hook-boom');
          },
        });
        return { registry: regWith(enrichableTool()), hooks };
      },
      calls: [{ id: 'c1', name: 'search_content', arguments: '{"query":"demo"}' }],
    },
    {
      label: '工具执行错误',
      build: () => ({ registry: regWith(throwingTool()) }),
      calls: [{ id: 'c1', name: 'boom_tool', arguments: '{}' }],
    },
    {
      label: '进度事件',
      build: () => ({ registry: regWith(progressTool()) }),
      calls: [{ id: 'c1', name: 'slow_tool', arguments: '{}' }],
    },
    {
      label: '并行只读双工具事件顺序',
      build: () => ({ registry: regWith(readOnlyTool(), progressTool()) }),
      calls: [
        { id: 'c1', name: 'graph_summary', arguments: '{}' },
        { id: 'c2', name: 'slow_tool', arguments: '{}' },
      ],
    },
  ];
}

function regWith(...tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  return registry;
}

/** 以指定模式跑一个 trace case，返回与 phase-0 baseline 同构的 trace 结构。 */
export async function runTraceCase(c: TraceCase, mode: TraceMode = 'legacy') {
  const events: Array<{ kind: string; name: string | undefined; chunk?: string }> = [];
  const { registry, hooks, preflight, planGate } = c.build();
  let ex: StreamingToolExecutor;
  if (mode === 'pipeline') {
    const bus = new AgentEventBus();
    if (planGate) attachPlanGate(bus, planGate);
    if (preflight) attachPreflightRegistry(bus, preflight);
    if (hooks) attachHookRegistry(bus, hooks);
    ex = new StreamingToolExecutor(registry, makeSink(events), null, null, null, null, null, bus);
  } else {
    ex = new StreamingToolExecutor(
      registry,
      makeSink(events),
      hooks ?? null,
      preflight ?? null,
      null,
      null,
      planGate ?? null,
    );
  }
  for (const call of c.calls) ex.addTool(call as ToolCall);
  const results = await ex.awaitRemaining();
  return {
    label: c.label,
    events,
    results: results.map((r) => ({
      id: r.call.id,
      name: r.call.name,
      output: r.output,
      truncated: r.truncated,
      err: r.err ?? null,
    })),
  };
}

function makeSink(events: Array<{ kind: string; name: string | undefined; chunk?: string }>) {
  return (ev: { kind: unknown; tool?: { name?: string; output?: string } }) => {
    events.push({
      kind: String(ev.kind),
      name: ev.tool?.name,
      chunk: ev.kind === EventKind.ToolProgress ? ev.tool?.output : undefined,
    });
  };
}
