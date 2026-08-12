import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/agent/tool';
import { convergeRegistry } from '../src/agent/tools/domains';
import { createBrowserTools, type DomProbe } from '../src/agent/tools/browser';

function buildBrowserRegistry(probe?: DomProbe): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of createBrowserTools({ domProbe: probe })) registry.register(t);
  convergeRegistry(registry);
  return registry;
}

describe('browser 领域工具注册', () => {
  it('领域工具 browser 可见，细粒度 browser_* 被隐藏', () => {
    const registry = buildBrowserRegistry();
    const visible = registry.schemas().map((s) => s.name);
    expect(visible).toContain('browser');
    expect(visible).not.toContain('browser_inspect');
    expect(visible).not.toContain('browser_launch');
    // 隐藏但可解析（领域工具委托）
    expect(registry.get('browser_inspect')).toBeDefined();
  });

  it('browser 领域 action 包含 inspect/report/click/type/eval', () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    const actions = t.actions?.() ?? [];
    for (const a of ['launch', 'targets', 'attach', 'inspect', 'report', 'click', 'type', 'press', 'scroll', 'eval']) {
      expect(actions).toContain(a);
    }
  });

  it('未知 action 返回错误提示', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    const result = await t.execute({ action: 'fly_to_moon' });
    expect(result).toContain('unsupported action');
  });

  it('领域 schema 含 target 判别 + targetId（语义分离）', () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    const schema = t.parameters() as Record<string, any>;
    const props = schema.properties ?? {};
    // target 是 self/外部判别（inspect/report 共享），不是 attach 的目标
    expect(props.target).toBeDefined();
    expect(String(props.target.description)).toContain('self');
    // attach 用 targetId（CDP target id），与 target 判别分离
    expect(props.targetId).toBeDefined();
    expect(String(props.targetId.description)).toContain('CDP target id');
  });
});

describe('browser self 探针（webview 内直读）', () => {
  it('inspect 返回几何/样式/文本', async () => {
    const calls: string[] = [];
    const probe: DomProbe = {
      async inspect(selector, props, maxResults) {
        calls.push(selector);
        return [{ tag: 'div', selector, rect: { x: 1, y: 2, width: 100, height: 50 }, visible: true }];
      },
      async report() {
        return { issues: [], ok: true };
      },
    };
    const registry = buildBrowserRegistry(probe);
    const t = registry.get('browser')!;
    const result = await t.execute({ action: 'inspect', target: 'self', selector: '.card' });
    expect(calls).toEqual(['.card']);
    const parsed = JSON.parse(result);
    expect(parsed[0].selector).toBe('.card');
    expect(parsed[0].rect.width).toBe(100);
  });

  it('report 返回问题清单', async () => {
    const probe: DomProbe = {
      async inspect() {
        return [];
      },
      async report(scope) {
        return { issues: [{ rule: 'contrast', severity: 'warn', detail: '对比度 2.1:1', selector: 'p' }], ok: false };
      },
    };
    const registry = buildBrowserRegistry(probe);
    const t = registry.get('browser')!;
    const result = await t.execute({ action: 'report', target: 'self' });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues[0].rule).toBe('contrast');
  });

  it('self 模式不支持 click/type（只读探针）', async () => {
    const probe: DomProbe = {
      async inspect() {
        return [];
      },
      async report() {
        return { issues: [], ok: true };
      },
    };
    const registry = buildBrowserRegistry(probe);
    const t = registry.get('browser')!;
    const result = await t.execute({ action: 'click', target: 'self', selector: 'button' });
    expect(result).toContain('self 模式暂不支持');
  });

  it('无探针注入时 self 返回明确错误', async () => {
    const registry = buildBrowserRegistry(undefined);
    const t = registry.get('browser')!;
    const result = await t.execute({ action: 'inspect', target: 'self', selector: 'div' });
    expect(result).toContain('domProbe');
  });
});
