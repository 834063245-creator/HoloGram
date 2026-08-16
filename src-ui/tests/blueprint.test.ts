// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// Phase 6 T1 — AgentBlueprint 声明式组合原语行为规约。
// 重复 key 拒绝 / 表序保持 / when() 门控 / standard() 实例隔离与表审计。

import { describe, expect, it } from 'vitest';
import { AgentBlueprint, type AgentCapability, type BlueprintScope } from '../src/agent/blueprint';

/** 最小 capability 构造（install 记录调用序）。 */
function cap(
  key: string,
  phase: 'context' | 'agent',
  order: string[],
  when?: AgentCapability['when'],
): AgentCapability {
  return {
    key,
    phase,
    ...(when ? { when } : {}),
    install: () => {
      order.push(key);
    },
  };
}

/** 最小 scope 桩 — 原语级测试不触发真实装配。 */
function stubScope(): BlueprintScope {
  return {
    ctx: {} as BlueprintScope['ctx'],
    inputs: {},
    tools: {} as BlueprintScope['tools'],
    hooks: {} as BlueprintScope['hooks'],
    preflightHooks: {} as BlueprintScope['preflightHooks'],
    deps: {
      isolationExec: async () => '',
      messageBus: {} as BlueprintScope['deps']['messageBus'],
    },
  };
}

describe('AgentBlueprint T1 — 原语行为', () => {
  it('重复 key 拒绝（构造与 add 双路径）', () => {
    expect(() => new AgentBlueprint([cap('a', 'agent', []), cap('a', 'context', [])])).toThrow(/key 重复: a/);
    const bp = new AgentBlueprint([cap('a', 'agent', [])]);
    expect(() => bp.add(cap('a', 'context', []))).toThrow(/key 重复: a/);
  });

  it('capabilities() 按阶段过滤且保持声明序；keys() 反映追加', () => {
    const order: string[] = [];
    const bp = new AgentBlueprint([cap('a', 'context', order), cap('b', 'agent', order), cap('c', 'context', order)]);
    expect(bp.capabilities('context').map((c) => c.key)).toEqual(['a', 'c']);
    expect(bp.capabilities('agent').map((c) => c.key)).toEqual(['b']);
    expect(bp.capabilities().map((c) => c.key)).toEqual(['a', 'b', 'c']);
    bp.add(cap('d', 'agent', order));
    expect(bp.keys()).toEqual(['a', 'b', 'c', 'd']);
    expect(bp.capability('b')?.phase).toBe('agent');
    expect(bp.capability('nope')).toBeUndefined();
  });

  it('install/when 直行：when 缺省恒装，返回 false 跳过', () => {
    const order: string[] = [];
    const scope = stubScope();
    const bp = new AgentBlueprint([
      cap('a', 'context', order),
      cap('gated', 'context', order, () => false),
      cap('kept', 'context', order, () => true),
    ]);
    for (const c of bp.capabilities('context')) {
      if (c.when?.(scope) ?? true) c.install(scope);
    }
    expect(order).toEqual(['a', 'kept']);
  });

  it('standard() 每次返回全新实例 — 扩展不污染标准装配', () => {
    const a = AgentBlueprint.standard();
    const before = a.keys().length;
    a.add(cap('custom-x', 'agent', []));
    expect(a.keys()).toContain('custom-x');
    const b = AgentBlueprint.standard();
    expect(b.keys()).not.toContain('custom-x');
    expect(b.keys()).toHaveLength(before);
  });

  it('standard() 装配面封闭 — 表序冻结（新增 capability 必须显式改此断言）', () => {
    expect(AgentBlueprint.standard().keys()).toEqual([
      // context 阶段
      'plan-tools',
      // agent 阶段（注册序 = 工具面序 — phase-1 effective 快照钉字节）
      'communication-tools',
      'discovery-tools',
      'merge-tools',
      'request-tool',
      'spawn-tool',
      'task-tools',
      'compaction-tools',
      'converge-tools',
      'graph-hooks',
      'board-tracking-hook',
      'plan-injector',
      'pre-run-hook',
      'auto-tune',
    ]);
  });

  it('standard() 的 capability 均声明 key/phase/install', () => {
    for (const c of AgentBlueprint.standard().capabilities()) {
      expect(c.key, 'key 必须非空').toMatch(/^[a-z][a-z0-9-]*$/);
      expect(['context', 'agent']).toContain(c.phase);
      expect(typeof c.install).toBe('function');
    }
  });
});
