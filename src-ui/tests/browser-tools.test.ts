import { describe, expect, it, vi } from 'vitest';

// browser 工具全量走 Rust CDP（ADR 0003 D4 统一后端）——mock agentInvoke 捕获路由，
// 其余导出（ToolRegistry 等）保留真实实现
vi.mock('../src/agent/tool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/tool')>();
  return { ...actual, agentInvoke: vi.fn(async () => '{"ok":true}') };
});

import { ToolRegistry, agentInvoke } from '../src/agent/tool';
import { convergeRegistry } from '../src/agent/tools/domains';
import { createBrowserTools } from '../src/agent/tools/browser';

function buildBrowserRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of createBrowserTools()) registry.register(t);
  convergeRegistry(registry);
  return registry;
}

const invokeMock = agentInvoke as unknown as ReturnType<typeof vi.fn>;

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

  it('browser 领域 action 覆盖 P1/P2 全清单', () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    const actions = t.actions?.() ?? [];
    for (const a of [
      'launch', 'kill', 'targets', 'attach', 'new_tab', 'close_tab',
      'navigate', 'back', 'forward', 'reload',
      'snapshot', 'content', 'inspect', 'report', 'console', 'network', 'network_detail', 'network_har', 'screenshot', 'audit',
      'click', 'hover', 'type', 'select', 'upload', 'dialog', 'press', 'scroll', 'viewport', 'eval', 'status', 'wait',
    ]) {
      expect(actions).toContain(a);
    }
  });

  it('wait 路由到 browser_wait 并透传 selector/ms', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'wait', selector: '#done', ms: 5000 });
    expect(invokeMock).toHaveBeenCalledWith(
      'browser_wait',
      expect.objectContaining({ selector: '#done', ms: 5000 }),
    );
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
    // target 是 self/外部判别，不是 attach 的目标
    expect(props.target).toBeDefined();
    expect(String(props.target.description)).toContain('self');
    // attach 用 targetId（CDP target id），与 target 判别分离
    expect(props.targetId).toBeDefined();
    expect(String(props.targetId.description)).toContain('CDP target id');
  });
});

describe('browser 动作路由（统一走 Rust CDP）', () => {
  it('snapshot 路由到 browser_snapshot 并透传参数', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'snapshot', scope: '#main', maxResults: 50 });
    // 领域工具剥掉 action；camelCase→snake 转换发生在 bridge.rpc() 层，不在 agentInvoke 内
    expect(invokeMock).toHaveBeenCalledWith(
      'browser_snapshot',
      expect.objectContaining({ scope: '#main', maxResults: 50 }),
    );
  });

  it('self=true 透传 self 标记（webview 只读会话由 Rust 路由）', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'inspect', target: 'self', selector: '.card' });
    expect(invokeMock).toHaveBeenCalledWith(
      'browser_inspect',
      expect.objectContaining({ target: 'self', selector: '.card' }),
    );
  });

  it('console/network/screenshot/audit 路由到对应 RPC', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'console', limit: 10 });
    await t.execute({ action: 'network', limit: 5 });
    await t.execute({ action: 'network_detail', requestId: 'r1' });
    await t.execute({ action: 'network_har', limit: 50 });
    await t.execute({ action: 'screenshot' });
    await t.execute({ action: 'audit', limit: 20 });
    expect(invokeMock).toHaveBeenCalledWith('browser_console', expect.objectContaining({ limit: 10 }));
    expect(invokeMock).toHaveBeenCalledWith('browser_network', expect.objectContaining({ limit: 5 }));
    expect(invokeMock).toHaveBeenCalledWith('browser_network_detail', expect.objectContaining({ requestId: 'r1' }));
    expect(invokeMock).toHaveBeenCalledWith('browser_network_har', expect.objectContaining({ limit: 50 }));
    expect(invokeMock).toHaveBeenCalledWith('browser_screenshot', expect.any(Object));
    expect(invokeMock).toHaveBeenCalledWith('browser_audit', expect.objectContaining({ limit: 20 }));
  });

  it('click/type 路由并透传 selector（支持 ref 编号）', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'click', selector: '37' });
    await t.execute({ action: 'type', selector: '12', text: 'hello', replace: true });
    expect(invokeMock).toHaveBeenCalledWith('browser_click', expect.objectContaining({ selector: '37' }));
    expect(invokeMock).toHaveBeenCalledWith('browser_type', expect.objectContaining({ selector: '12', text: 'hello', replace: true }));
  });

  it('navigate/content/select 路由到新增 RPC', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'navigate', url: 'https://example.com' });
    await t.execute({ action: 'content', scope: '#main', format: 'markdown', maxChars: 2000 });
    await t.execute({ action: 'select', selector: '42', value: 'option-a' });
    expect(invokeMock).toHaveBeenCalledWith('browser_navigate', expect.objectContaining({ url: 'https://example.com' }));
    expect(invokeMock).toHaveBeenCalledWith('browser_content', expect.objectContaining({ scope: '#main', format: 'markdown', maxChars: 2000 }));
    expect(invokeMock).toHaveBeenCalledWith('browser_select', expect.objectContaining({ selector: '42', value: 'option-a' }));
  });

  it('launch headless/windowSize 与 network_detail 路由到新增 RPC', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'launch', headless: true, windowSize: { width: 800, height: 600 } });
    await t.execute({ action: 'network_detail', requestId: 'r-1' });
    expect(invokeMock).toHaveBeenCalledWith(
      'browser_launch',
      expect.objectContaining({ headless: true, windowSize: { width: 800, height: 600 } }),
    );
    expect(invokeMock).toHaveBeenCalledWith('browser_network_detail', expect.objectContaining({ requestId: 'r-1' }));
  });

  it('viewport 路由到 browser_viewport 并透传 DPR/mobile', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'viewport', width: 800, height: 600, deviceScaleFactor: 2, mobile: true });
    expect(invokeMock).toHaveBeenCalledWith(
      'browser_viewport',
      expect.objectContaining({ width: 800, height: 600, deviceScaleFactor: 2, mobile: true }),
    );
  });

  it('tab/dialog/upload/hover/组合键/截图参数路由到新增 RPC', async () => {
    const registry = buildBrowserRegistry();
    const t = registry.get('browser')!;
    await t.execute({ action: 'new_tab', url: 'https://example.com' });
    await t.execute({ action: 'close_tab', targetId: 'tab-1' });
    await t.execute({ action: 'hover', selector: '17' });
    await t.execute({ action: 'dialog', accept: true, promptText: 'ok' });
    await t.execute({ action: 'upload', files: ['C:/tmp/a.txt'], selector: '#file' });
    await t.execute({ action: 'press', key: 'a', modifiers: ['ctrl'] });
    await t.execute({ action: 'screenshot', fullPage: true, inline: true });
    expect(invokeMock).toHaveBeenCalledWith('browser_new_tab', expect.objectContaining({ url: 'https://example.com' }));
    expect(invokeMock).toHaveBeenCalledWith('browser_close_tab', expect.objectContaining({ targetId: 'tab-1' }));
    expect(invokeMock).toHaveBeenCalledWith('browser_hover', expect.objectContaining({ selector: '17' }));
    expect(invokeMock).toHaveBeenCalledWith('browser_dialog', expect.objectContaining({ accept: true, promptText: 'ok' }));
    expect(invokeMock).toHaveBeenCalledWith('browser_upload', expect.objectContaining({ files: ['C:/tmp/a.txt'], selector: '#file' }));
    expect(invokeMock).toHaveBeenCalledWith('browser_press', expect.objectContaining({ key: 'a', modifiers: ['ctrl'] }));
    expect(invokeMock).toHaveBeenCalledWith('browser_screenshot', expect.objectContaining({ fullPage: true, inline: true }));
  });
});
