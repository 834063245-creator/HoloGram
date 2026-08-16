// 注册表 disposer 契约测试（agent-core-convergence Phase 1 / 验证计划 T1 + T5）。
// 覆盖 ToolRegistry / HookRegistry / PreflightHookRegistry 三个注册 API：
// 返回的 disposer 删除指定项、重复调用 no-op、陈旧 disposer 不误删后来者、
// 100 次注册/释放循环后注册表归零（泄漏检测）。
import { describe, expect, it } from 'vitest';
import { ToolRegistry, type Tool } from '../src/agent/tool';
import { HookRegistry, PreflightHookRegistry } from '../src/agent/hooks';

function toyTool(name: string): Tool {
  return {
    name: () => name,
    description: () => `${name} desc`,
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => true,
    execute: async () => `${name}-ok`,
  };
}

describe('ToolRegistry.register → Disposer', () => {
  it('disposer 删除指定工具；重复调用 no-op', () => {
    const reg = new ToolRegistry();
    const dispose = reg.register(toyTool('alpha'));
    expect(reg.names()).toContain('alpha');
    dispose();
    expect(reg.names()).not.toContain('alpha');
    expect(reg.get('alpha')).toBeUndefined();
    expect(() => dispose()).not.toThrow();
    expect(reg.names()).toEqual([]);
  });

  it('hidden 状态随 disposer 一并清除（unregister 语义）', () => {
    const reg = new ToolRegistry();
    const dispose = reg.register(toyTool('legacy_thing'));
    reg.hide('legacy_thing');
    expect(reg.isHidden('legacy_thing')).toBe(true);
    dispose();
    expect(reg.isHidden('legacy_thing')).toBe(false);
    // 同名重注册不受残留 hidden 影响
    const dispose2 = reg.register(toyTool('legacy_thing'));
    expect(reg.schemas().map((s) => s.name)).toContain('legacy_thing');
    dispose2();
  });

  it('陈旧 disposer 不误删同名的新工具', () => {
    const reg = new ToolRegistry();
    const t1 = toyTool('shared');
    const dispose1 = reg.register(t1);
    reg.unregister('shared');
    const t2 = toyTool('shared');
    reg.register(t2);
    dispose1(); // 陈旧清理器——不得删掉 t2
    expect(reg.get('shared')).toBe(t2);
  });

  it('注册 100 次再全部 dispose，注册表归零（T5 泄漏检测）', () => {
    const reg = new ToolRegistry();
    const disposers = [];
    for (let i = 0; i < 100; i++) disposers.push(reg.register(toyTool(`tool_${i}`)));
    expect(reg.names()).toHaveLength(100);
    for (const d of disposers) d();
    expect(reg.names()).toEqual([]);
    expect(reg.schemas()).toEqual([]);
    expect(reg.visibleTools()).toEqual([]);
  });
});

describe('HookRegistry.register → Disposer', () => {
  it('disposer 移除 hook；apply 不再触发；重复调用 no-op', async () => {
    const hooks = new HookRegistry();
    const dispose = hooks.register({
      name: 'test',
      shouldEnrich: () => true,
      enrich: async (_n, _a, r) => `${r}+enriched`,
    });
    expect(await hooks.apply('x', {}, 'raw')).toBe('raw+enriched');
    dispose();
    dispose();
    expect(await hooks.apply('x', {}, 'raw')).toBe('raw');
  });

  it('多 hook 各自独立释放', async () => {
    const hooks = new HookRegistry();
    const d1 = hooks.register({
      name: 'h1',
      shouldEnrich: () => true,
      enrich: async (_n, _a, r) => `${r}+1`,
    });
    hooks.register({
      name: 'h2',
      shouldEnrich: () => true,
      enrich: async (_n, _a, r) => `${r}+2`,
    });
    d1();
    expect(await hooks.apply('x', {}, 'raw')).toBe('raw+2');
  });
});

describe('PreflightHookRegistry.register → Disposer', () => {
  it('disposer 移除 preflight hook；check 不再触发；重复调用 no-op', () => {
    const pre = new PreflightHookRegistry();
    const dispose = pre.register({
      name: 'p1',
      shouldCheck: () => true,
      check: () => 'warn',
    });
    expect(pre.check('edit_file', {})).toBe('warn');
    dispose();
    dispose();
    expect(pre.check('edit_file', {})).toBeNull();
  });
});
