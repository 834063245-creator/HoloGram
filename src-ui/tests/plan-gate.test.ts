// plan 门禁（planGateCheck + StreamingToolExecutor planGate）—
// plan 模式不再切换工具注册表（schema 跨模式恒定保 DeepSeek 前缀缓存），
// 写约束在执行层按 planState 运行时拦截。
import { describe, expect, it } from 'vitest';
import { StreamingToolExecutor } from '../src/agent/streaming-executor';
import { planGateCheck, planRegistry, type PlanGate } from '../src/agent/plan/plan-registry';
import { PlanStateManager } from '../src/agent/plan/plan-state';
import { ToolRegistry, type Tool } from '../src/agent/tool';

function fsDomainTool(executed: string[]): Tool {
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

function agentDomainTool(executed: string[]): Tool {
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

function mutatingMcpTool(executed: string[]): Tool {
  return {
    name: () => 'analyze_project',
    description: () => 're-analyze',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => false,
    execute: async () => {
      executed.push('analyze_project');
      return 'ok';
    },
  };
}

function readOnlyTool(executed: string[]): Tool {
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

function setup(gateState: PlanStateManager | null, ...tools: Tool[]) {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const gate: PlanGate = (name, args, tool) => planGateCheck(gateState, name, args, tool);
  const executor = new StreamingToolExecutor(registry, () => {}, null, null, null, null, gate);
  return executor;
}

describe('planGate — 执行层 plan 门禁（schema 不切换）', () => {
  it('plan 未激活：写动作放行', async () => {
    const executed: string[] = [];
    const ps = new PlanStateManager();
    const ex = setup(ps, fsDomainTool(executed));
    ex.addTool({ id: 'c1', name: 'fs', arguments: '{"action":"write","filePath":"/proj/a.ts"}' });
    const results = await ex.awaitRemaining();
    expect(results[0].output).toBe('ok');
    expect(executed).toEqual(['write']);
  });

  it('plan 激活：readOnly 工具与领域只读动作放行', async () => {
    const executed: string[] = [];
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const ex = setup(ps, fsDomainTool(executed), readOnlyTool(executed));
    ex.addTool({ id: 'c1', name: 'fs', arguments: '{"action":"read","filePath":"/proj/a.ts"}' });
    ex.addTool({ id: 'c2', name: 'graph_summary', arguments: '{}' });
    const results = await ex.awaitRemaining();
    expect(results.map((r) => r.output)).toEqual(['ok', 'ok']);
    expect(executed).toEqual(['read', 'graph_summary']);
  });

  it('plan 激活：领域写动作拦截，工具未执行', async () => {
    const executed: string[] = [];
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const ex = setup(ps, fsDomainTool(executed));
    ex.addTool({ id: 'c1', name: 'fs', arguments: '{"action":"write","filePath":"/proj/a.ts"}' });
    const results = await ex.awaitRemaining();
    expect(results[0].output).toContain('[已拦截]');
    expect(executed).toEqual([]);
  });

  it('plan 激活：fs(write)/fs(edit) 命中计划文件时豁免', async () => {
    const executed: string[] = [];
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const planFile = ps.state.planFilePath!;
    const ex = setup(ps, fsDomainTool(executed));
    ex.addTool({ id: 'c1', name: 'fs', arguments: JSON.stringify({ action: 'write', filePath: planFile }) });
    ex.addTool({ id: 'c2', name: 'fs', arguments: JSON.stringify({ action: 'edit', path: planFile }) });
    const results = await ex.awaitRemaining();
    expect(results.map((r) => r.output)).toEqual(['ok', 'ok']);
    expect(executed).toEqual(['write', 'edit']);
  });

  it('plan 激活：非只读非领域工具（analyze_project）拦截', async () => {
    const executed: string[] = [];
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const ex = setup(ps, mutatingMcpTool(executed));
    ex.addTool({ id: 'c1', name: 'analyze_project', arguments: '{}' });
    const results = await ex.awaitRemaining();
    expect(results[0].output).toContain('[已拦截]');
    expect(executed).toEqual([]);
  });

  it('plan 激活：agent(spawn) 放行，agent(kill) 拦截', async () => {
    const executed: string[] = [];
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const ex = setup(ps, agentDomainTool(executed));
    ex.addTool({ id: 'c1', name: 'agent', arguments: '{"action":"spawn","description":"explore"}' });
    ex.addTool({ id: 'c2', name: 'agent', arguments: '{"action":"kill","id":"sub-1"}' });
    const results = await ex.awaitRemaining();
    const byId = new Map(results.map((r) => [r.call.id, r.output]));
    expect(byId.get('c1')).toBe('ok');
    expect(byId.get('c2')).toContain('[已拦截]');
    expect(executed).toEqual(['spawn']);
  });

  it('plan 退出后写动作恢复放行（运行时状态，无需换注册表）', async () => {
    const executed: string[] = [];
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const ex = setup(ps, fsDomainTool(executed));
    ex.addTool({ id: 'c1', name: 'fs', arguments: '{"action":"write","filePath":"/proj/a.ts"}' });
    ps.exit();
    ex.addTool({ id: 'c2', name: 'fs', arguments: '{"action":"write","filePath":"/proj/a.ts"}' });
    const results = await ex.awaitRemaining();
    const byId = new Map(results.map((r) => [r.call.id, r.output]));
    expect(byId.get('c1')).toContain('[已拦截]');
    expect(byId.get('c2')).toBe('ok');
    expect(executed).toEqual(['write']);
  });

  it('非法 JSON 参数不经过门禁，走 invalid JSON 错误路径', async () => {
    const executed: string[] = [];
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const ex = setup(ps, fsDomainTool(executed));
    ex.addTool({ id: 'c1', name: 'fs', arguments: '{invalid' });
    const results = await ex.awaitRemaining();
    expect(results[0].output).toContain('invalid JSON arguments');
    expect(executed).toEqual([]);
  });
});

describe('planRegistry — plan 中 spawn 的子 Agent 静态只读克隆', () => {
  it('克隆集只含只读工具与守卫领域工具，隐藏旧名不进入', () => {
    const executed: string[] = [];
    const base = new ToolRegistry();
    base.register(fsDomainTool(executed));
    base.register(readOnlyTool(executed));
    base.register(mutatingMcpTool(executed));
    const writeFile: Tool = {
      name: () => 'write_file',
      description: () => 'legacy write',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => false,
      execute: async () => 'written',
    };
    base.register(writeFile);
    base.hide('write_file');

    const ps = new PlanStateManager();
    ps.enter('/proj');
    const planR = planRegistry(base, ps);
    const names = planR.schemas().map((s) => s.name);
    expect(names).toContain('fs');
    expect(names).toContain('graph_summary');
    expect(names).not.toContain('analyze_project');
    // write_file 以"仅计划文件"守卫形式重新可见
    expect(names).toContain('write_file');
  });

  it('守卫版 write_file：仅计划文件可写', async () => {
    const base = new ToolRegistry();
    const writeFile: Tool = {
      name: () => 'write_file',
      description: () => 'legacy write',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => false,
      execute: async () => 'written',
    };
    base.register(writeFile);
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const planR = planRegistry(base, ps);
    const guarded = planR.get('write_file')!;
    expect(await guarded.execute({ filePath: '/proj/other.ts' })).toContain('[已拦截]');
    expect(await guarded.execute({ filePath: ps.state.planFilePath! })).toBe('written');
  });
});
