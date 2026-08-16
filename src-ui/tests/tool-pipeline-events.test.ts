// 类型化事件管道测试（agent-core-convergence Phase 2 / 验证计划 V2 T1 + T2）。
//
// T1：AgentEventBus 各 mode 的调度顺序与短路语义、listener disposer 移除。
// T2：差分矩阵——同一 ToolCall fixture 分别跑 legacy 直调路径与 event pipeline
//     路径，比较 PendingResult 与 legacy sink 事件序列必须逐项一致。
import { describe, expect, it } from 'vitest';
import type { ToolPipelineContext } from '../src/agent/agent-types';
import { AgentEventBus, attachHookRegistry, attachPlanGate, attachPreflightRegistry } from '../src/agent/events';
import { HookRegistry, PreflightHookRegistry } from '../src/agent/hooks';
import { type PlanGate, planGateCheck } from '../src/agent/plan/plan-registry';
import { PlanStateManager } from '../src/agent/plan/plan-state';
import { StreamingToolExecutor } from '../src/agent/streaming-executor';
import type { Tool } from '../src/agent/tool';
import { ToolRegistry } from '../src/agent/tool';
import type { ToolCall } from '../src/provider/types';

function ctxOf(overrides: Partial<ToolPipelineContext> = {}): ToolPipelineContext {
  const tool: Tool = {
    name: () => 'fs',
    description: () => 'd',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => false,
    execute: async () => 'ok',
  };
  return {
    call: { id: 'c1', name: 'fs', arguments: '{}' },
    tool,
    args: {},
    agentId: null,
    signal: null,
    guardName: 'fs',
    ...overrides,
  };
}

describe('T1 — AgentEventBus 调度语义', () => {
  it('on 返回 disposer，能移除监听', () => {
    const bus = new AgentEventBus();
    const seen: string[] = [];
    const d = bus.on('tool/preflight', () => {
      seen.push('a');
      return null;
    });
    expect(bus.listenerCount('tool/preflight')).toBe(1);
    bus.runPreflight(ctxOf());
    d();
    d(); // 幂等
    bus.runPreflight(ctxOf());
    expect(seen).toEqual(['a']);
    expect(bus.listenerCount('tool/preflight')).toBe(0);
  });

  it('优先级：数值大的先执行；同优先级按注册序', () => {
    const bus = new AgentEventBus();
    const order: string[] = [];
    bus.on('tool/preflight', () => {
      order.push('reg1');
      return null;
    });
    bus.on(
      'tool/preflight',
      () => {
        order.push('p10');
        return null;
      },
      { priority: 10 },
    );
    bus.on(
      'tool/preflight',
      () => {
        order.push('p10-second');
        return null;
      },
      { priority: 10 },
    );
    bus.on(
      'tool/preflight',
      () => {
        order.push('p5');
        return null;
      },
      { priority: 5 },
    );
    bus.runPreflight(ctxOf());
    expect(order).toEqual(['p10', 'p10-second', 'p5', 'reg1']);
  });

  it('runPreflight 聚合非 null 警告并 join 双换行', () => {
    const bus = new AgentEventBus();
    bus.on('tool/preflight', () => null);
    bus.on('tool/preflight', () => '⚠️ A');
    bus.on('tool/preflight', () => '⚠️ B');
    expect(bus.runPreflight(ctxOf())).toBe('⚠️ A\n\n⚠️ B');
  });

  it('runGuard 首个非 null 短路；后续监听不执行；不吞异常', () => {
    const bus = new AgentEventBus();
    const ran: string[] = [];
    bus.on(
      'tool/guard',
      () => {
        ran.push('first');
        return null;
      },
      { priority: 10 },
    );
    bus.on('tool/guard', () => {
      ran.push('second');
      return '[已拦截] blocked';
    });
    bus.on('tool/guard', () => {
      ran.push('never');
      return 'never';
    });
    expect(bus.runGuard(ctxOf())).toBe('[已拦截] blocked');
    expect(ran).toEqual(['first', 'second']);

    bus.on(
      'tool/guard',
      () => {
        throw new Error('guard-boom');
      },
      { priority: 20 },
    );
    expect(() => bus.runGuard(ctxOf())).toThrow('guard-boom');
  });

  it('runAround 输出按优先级异步流过（waterfall）', async () => {
    const bus = new AgentEventBus();
    bus.on('tool/around', async (_c, out) => `${out}+1`);
    bus.on(
      'tool/around',
      async (_c, out) => {
        await new Promise((r) => setTimeout(r, 1));
        return `${out}+2`;
      },
      { priority: 5 },
    );
    expect(await bus.runAround(ctxOf(), 'raw')).toBe('raw+2+1');
  });

  it('emitResult / emitError 广播给全部监听', () => {
    const bus = new AgentEventBus();
    const got: string[] = [];
    bus.on('tool/result', (_c, r) => got.push(`r:${r.output}:${r.err ?? '-'}`));
    bus.on('tool/result', () => got.push('r2'));
    bus.on('tool/error', (_c, e) => got.push(`e:${e}`));
    bus.emitResult(ctxOf(), { output: 'out', truncated: false, err: null });
    bus.emitError(ctxOf(), 'boom');
    expect(got).toEqual(['r:out:-', 'r2', 'e:boom']);
  });

  it('attachPlanGate：args 非法（null）或 tool 缺失时放行', () => {
    const bus = new AgentEventBus();
    const d = attachPlanGate(bus, () => '[已拦截] gated');
    expect(bus.runGuard(ctxOf({ args: null }))).toBeNull();
    expect(bus.runGuard(ctxOf({ tool: null }))).toBeNull();
    expect(bus.runGuard(ctxOf())).toBe('[已拦截] gated');
    d();
    expect(bus.runGuard(ctxOf())).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════
// T2 — 差分矩阵：legacy 直调 vs event pipeline（验证计划 V2 T2）
// 纪律：两侧各自独立构建夹具实例（不共享 registry/hooks），防共享同一 bug。
// ═══════════════════════════════════════════════════════

interface DiffFixture {
  registry: () => ToolRegistry;
  hooks?: () => HookRegistry;
  preflight?: () => PreflightHookRegistry;
  planGate?: PlanGate;
  signal?: () => AbortSignal;
  calls: ToolCall[];
}

function toyTool(name: string, opts: Partial<Tool> = {}): Tool {
  return {
    name: () => name,
    description: () => `${name} desc`,
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => true,
    execute: async () => `${name}-ok`,
    ...opts,
  };
}

function regOf(...tools: Tool[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}

function fsToy(): Tool {
  return {
    name: () => 'fs',
    description: () => 'fs domain',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => false,
    domain: () => 'fs',
    actions: () => ['read', 'write'],
    readOnlyActions: () => ['read'],
    execute: async () => 'ok',
  };
}

function hookOf(h: {
  name: string;
  shouldEnrich: (n: string) => boolean;
  enrich: (n: string, a: Record<string, unknown>, r: string) => Promise<string>;
}): HookRegistry {
  const hooks = new HookRegistry();
  hooks.register({
    name: h.name,
    shouldEnrich: (n) => h.shouldEnrich(n),
    enrich: async (n, a, r) => h.enrich(n, a, r),
  });
  return hooks;
}

function preOf(p: {
  name: string;
  shouldCheck: (n: string) => boolean;
  check: () => string | null;
}): PreflightHookRegistry {
  const pre = new PreflightHookRegistry();
  pre.register({
    name: p.name,
    shouldCheck: (n) => p.shouldCheck(n),
    check: () => p.check(),
  });
  return pre;
}

function call(id: string, name: string, args: string): ToolCall {
  return { id, name, arguments: args };
}

function diffCases(): Array<{ label: string; fixture: DiffFixture }> {
  const ps = new PlanStateManager();
  ps.enter('/proj');
  const gate: PlanGate = (name, args, tool) => planGateCheck(ps, name, args, tool);

  return [
    {
      label: '未知工具',
      fixture: { registry: () => regOf(toyTool('known')), calls: [call('c1', 'nope_tool', '{}')] },
    },
    {
      label: '隐藏旧名重定向',
      fixture: {
        registry: () => {
          const r = regOf(toyTool('edit_file', { readOnly: () => false }));
          r.hide('edit_file');
          return r;
        },
        calls: [call('c1', 'edit_file', '{}')],
      },
    },
    {
      label: '非法 JSON 参数',
      fixture: { registry: () => regOf(toyTool('graph_summary')), calls: [call('c1', 'graph_summary', '{invalid')] },
    },
    {
      label: 'preflight HIGH 拦截',
      fixture: {
        registry: () => regOf(toyTool('edit_file', { readOnly: () => false })),
        preflight: () =>
          preOf({
            name: 'high',
            shouldCheck: (n) => n.includes('edit'),
            check: () => '⚠️ fixture 警告 风险等级: HIGH — 合成高风险',
          }),
        calls: [call('c1', 'edit_file', '{"filePath":"/proj/a.ts"}')],
      },
    },
    {
      label: 'preflight HIGH 带 _forceGate 放行',
      fixture: {
        registry: () => regOf(toyTool('edit_file', { readOnly: () => false, execute: async () => 'edited' })),
        preflight: () =>
          preOf({
            name: 'high',
            shouldCheck: (n) => n.includes('edit'),
            check: () => '⚠️ fixture 警告 风险等级: HIGH — 合成高风险',
          }),
        calls: [call('c1', 'edit_file', '{"filePath":"/proj/a.ts","_forceGate":true}')],
      },
    },
    {
      label: 'planGate 拦截（dispatch 同步段）',
      fixture: {
        registry: () => regOf(fsToy()),
        planGate: gate,
        calls: [call('c1', 'fs', '{"action":"write","filePath":"/proj/a.ts"}')],
      },
    },
    {
      label: 'hook 富化',
      fixture: {
        registry: () => regOf(toyTool('search_content')),
        hooks: () =>
          hookOf({
            name: 'enrich',
            shouldEnrich: (n) => n.includes('search'),
            enrich: async (_n, _a, r) => `${r}\n[ENRICHED]`,
          }),
        calls: [call('c1', 'search_content', '{"query":"demo"}')],
      },
    },
    {
      label: 'hook 抛错静默降级',
      fixture: {
        registry: () => regOf(toyTool('search_content')),
        hooks: () =>
          hookOf({
            name: 'throw',
            shouldEnrich: (n) => n.includes('search'),
            enrich: async () => {
              throw new Error('hook-boom');
            },
          }),
        calls: [call('c1', 'search_content', '{"query":"demo"}')],
      },
    },
    {
      label: 'preflight 抛错静默降级',
      fixture: {
        registry: () => regOf(toyTool('edit_file', { readOnly: () => false })),
        preflight: () =>
          preOf({
            name: 'boom',
            shouldCheck: (n) => n.includes('edit'),
            check: () => {
              throw new Error('preflight-boom');
            },
          }),
        calls: [call('c1', 'edit_file', '{"filePath":"/proj/a.ts"}')],
      },
    },
    {
      label: '工具执行错误',
      fixture: {
        registry: () =>
          regOf(
            toyTool('boom_tool', {
              readOnly: () => false,
              execute: async () => {
                throw new Error('boom');
              },
            }),
          ),
        calls: [call('c1', 'boom_tool', '{}')],
      },
    },
    {
      label: 'AbortError 中止',
      fixture: {
        registry: () =>
          regOf(
            toyTool('slow_tool', {
              execute: async (_a, _p, signal) => {
                await new Promise<void>((resolve, reject) => {
                  const t = setTimeout(resolve, 40);
                  signal?.addEventListener(
                    'abort',
                    () => {
                      clearTimeout(t);
                      reject(new DOMException('Aborted', 'AbortError'));
                    },
                    { once: true },
                  );
                });
                return 'never';
              },
            }),
          ),
        signal: () => {
          const ctl = new AbortController();
          setTimeout(() => ctl.abort(), 5);
          return ctl.signal;
        },
        calls: [call('c1', 'slow_tool', '{}')],
      },
    },
    {
      label: '多调用混合（读并行 + 写 + 拦截）',
      fixture: {
        registry: () => regOf(toyTool('graph_summary'), fsToy(), toyTool('edit_file', { readOnly: () => false })),
        planGate: gate,
        calls: [
          call('c1', 'graph_summary', '{}'),
          call('c2', 'fs', '{"action":"read","filePath":"/proj/a.ts"}'),
          call('c3', 'fs', '{"action":"write","filePath":"/proj/a.ts"}'),
        ],
      },
    },
  ];
}

interface SideOutcome {
  events: Array<{ kind: string; name: string | undefined }>;
  results: Array<{ id: string; name: string; output: string; truncated: boolean; err: string | null }>;
  threw: string | null;
}

function sinkRecorder() {
  const events: Array<{ kind: string; name: string | undefined }> = [];
  const sink = (ev: { kind: unknown; tool?: { name?: string } }) => {
    events.push({ kind: String(ev.kind), name: ev.tool?.name });
  };
  return { events, sink };
}

async function runLegacy(c: { fixture: DiffFixture }): Promise<SideOutcome> {
  const f = c.fixture;
  const { events, sink } = sinkRecorder();
  const ex = new StreamingToolExecutor(
    f.registry(),
    sink as never,
    f.hooks?.() ?? null,
    f.preflight?.() ?? null,
    null,
    f.signal?.() ?? null,
    f.planGate ?? null,
  );
  return finish(ex, f, events);
}

async function runPipeline(c: { fixture: DiffFixture }): Promise<SideOutcome> {
  const f = c.fixture;
  const { events, sink } = sinkRecorder();
  const bus = new AgentEventBus();
  if (f.planGate) attachPlanGate(bus, f.planGate);
  if (f.preflight) attachPreflightRegistry(bus, f.preflight());
  if (f.hooks) attachHookRegistry(bus, f.hooks());
  const ex = new StreamingToolExecutor(f.registry(), sink as never, null, null, null, f.signal?.() ?? null, null, bus);
  return finish(ex, f, events);
}

async function finish(
  ex: StreamingToolExecutor,
  f: DiffFixture,
  events: Array<{ kind: string; name: string | undefined }>,
): Promise<SideOutcome> {
  for (const c of f.calls) ex.addTool(c);
  let threw: string | null = null;
  let results: Array<{ id: string; name: string; output: string; truncated: boolean; err: string | null }> = [];
  try {
    const raw = await ex.awaitRemaining();
    results = raw.map((r) => ({
      id: r.call.id,
      name: r.call.name,
      output: r.output,
      truncated: r.truncated,
      err: r.err ?? null,
    }));
  } catch (e) {
    threw = String((e as Error).name ?? e);
  }
  return { events, results, threw };
}

describe('T2 — 差分矩阵：legacy 直调 vs event pipeline', () => {
  for (const c of diffCases()) {
    it(`${c.label}：PendingResult 与 sink 事件序列逐项一致`, async () => {
      const legacy = await runLegacy(c);
      const pipeline = await runPipeline(c);
      expect(pipeline.results).toEqual(legacy.results);
      expect(pipeline.events).toEqual(legacy.events);
      expect(pipeline.threw).toBe(legacy.threw);
    });
  }

  it('新路径 bus 事件按预期触发（guard/preflight/around/result/error 结构性验证）', async () => {
    const bus = new AgentEventBus();
    attachPreflightRegistry(
      bus,
      preOf({ name: 'high', shouldCheck: (n) => n.includes('edit'), check: () => '⚠️ 风险等级: HIGH — x' }),
    );
    attachHookRegistry(
      bus,
      hookOf({
        name: 'enrich',
        shouldEnrich: (n) => n.includes('search'),
        enrich: async (_n, _a, r) => `${r}[E]`,
      }),
    );
    const busEvents: string[] = [];
    bus.on('tool/result', (_ctx, r) => busEvents.push(`result:${r.output.slice(0, 20)}`));
    bus.on('tool/error', (_ctx, e) => busEvents.push(`error:${e}`));

    // 场景 1：guard veto——临时挂自定义守卫拦截 fs，验证后摘除
    const dg = bus.on('tool/guard', (ctx) => (ctx.call.name === 'fs' ? '[已拦截] 自定义守卫 veto' : null), {
      priority: 5,
    });
    const ex1 = new StreamingToolExecutor(regOf(fsToy()), () => {}, null, null, null, null, null, bus);
    ex1.addTool(call('c1', 'fs', '{"action":"write","filePath":"/proj/a.ts"}'));
    await ex1.awaitRemaining();
    dg();

    // 场景 2：preflight HIGH 拦截 + around 富化 + 未知工具 error
    const ex2 = new StreamingToolExecutor(
      regOf(toyTool('edit_file', { readOnly: () => false, execute: async () => 'edited' }), toyTool('search_content')),
      () => {},
      null,
      null,
      null,
      null,
      null,
      bus,
    );
    ex2.addTool(call('c2', 'edit_file', '{"filePath":"/proj/a.ts"}'));
    ex2.addTool(call('c3', 'search_content', '{"query":"x"}'));
    ex2.addTool(call('c4', 'ghost_tool', '{}'));
    await ex2.awaitRemaining();

    expect(busEvents).toHaveLength(4);
    expect(busEvents[0].startsWith('result:[已拦截] 自定义守卫')).toBe(true);
    expect(busEvents[1].startsWith('result:⚠️')).toBe(true); // HIGH block 带前置警告
    // ghost 的同步短路错误先于 search 的异步富化结果落账（与 legacy 时序一致）
    expect(busEvents[2]).toBe('error:unknown tool "ghost_tool"');
    expect(busEvents[3].startsWith('result:search_content-ok')).toBe(true); // around 富化后
  });
});
