import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/agent/agent-types';
import { EventKind } from '../src/agent/agent-types';
import type { Hook, PreflightHook } from '../src/agent/hooks';
import { HookRegistry, PreflightHookRegistry } from '../src/agent/hooks';
import { StreamingToolExecutor } from '../src/agent/streaming-executor';
import type { Tool } from '../src/agent/tool';
import { ToolRegistry } from '../src/agent/tool';

// ── Helpers ──

function makeTool(name: string, readOnly: boolean, output: string): Tool {
  return {
    name: () => name,
    description: () => `mock ${name}`,
    parameters: () => ({ type: 'object', properties: {}, required: [] }),
    readOnly: () => readOnly,
    execute: async () => output,
  };
}

function makeRegistry(tools: Tool[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}

function noopSink(_ev: AgentEvent): void {}

// ── Tests ──

describe('StreamingToolExecutor — hook integration', () => {
  it('post-tool hook is called after tool execution', async () => {
    const tool = makeTool('read_file_content', true, 'hello world');
    const registry = makeRegistry([tool]);

    const enrichSpy = vi.fn(async (_t: string, _a: Record<string, unknown>, r: string) => `[ENRICHED] ${r}`);
    const hook: Hook = {
      name: 'test-hook',
      shouldEnrich: () => true,
      enrich: enrichSpy,
    };
    const hooks = new HookRegistry();
    hooks.register(hook);

    const executor = new StreamingToolExecutor(registry, noopSink, hooks, null);
    executor.addTool({ id: 'c1', name: 'read_file_content', arguments: '{"filePath":"/test.ts"}' });

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(enrichSpy).toHaveBeenCalledTimes(1);
    expect(results[0].output).toContain('[ENRICHED]');
    expect(results[0].output).toContain('hello world');
  });

  it('post-tool hook is NOT called when hooks is null', async () => {
    const tool = makeTool('read_file_content', true, 'hello');
    const registry = makeRegistry([tool]);

    const executor = new StreamingToolExecutor(registry, noopSink, null, null);
    executor.addTool({ id: 'c1', name: 'read_file_content', arguments: '{"filePath":"/x.ts"}' });

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(results[0].output).toBe('hello'); // no enrichment
  });

  it('post-tool hook is NOT called for excluded tool names', async () => {
    const tool = makeTool('edit_file', false, 'edited');
    const registry = makeRegistry([tool]);

    const enrichSpy = vi.fn(async (_t: string, _a: Record<string, unknown>, r: string) => r);
    const hook: Hook = {
      name: 'graph-context',
      shouldEnrich: (t: string) => ['read_file_content', 'read_file', 'search_content'].includes(t),
      enrich: enrichSpy,
    };
    const hooks = new HookRegistry();
    hooks.register(hook);

    const executor = new StreamingToolExecutor(registry, noopSink, hooks, null);
    executor.addTool({ id: 'c1', name: 'edit_file', arguments: '{}' });

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(enrichSpy).not.toHaveBeenCalled();
  });

  it('preflight hook is called BEFORE execution', async () => {
    const tool = makeTool('edit_file', false, 'file written');
    const registry = makeRegistry([tool]);

    const callOrder: string[] = [];
    const originalExecute = tool.execute;
    tool.execute = async (args: any, onProgress: any) => {
      callOrder.push('execute');
      return originalExecute(args, onProgress);
    };

    const checkSpy = vi.fn((_t: string, _a: Record<string, unknown>) => {
      callOrder.push('preflight');
      return '⚠️ WARNING';
    });
    const preflightHook: PreflightHook = {
      name: 'graph-preflight',
      shouldCheck: () => true,
      check: checkSpy,
    };
    const preflight = new PreflightHookRegistry();
    preflight.register(preflightHook);

    const executor = new StreamingToolExecutor(registry, noopSink, null, preflight);
    executor.addTool({ id: 'c1', name: 'edit_file', arguments: '{"filePath":"/test.ts"}' });

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(checkSpy).toHaveBeenCalledTimes(1);
    // preflight runs before execute
    expect(callOrder).toEqual(['preflight', 'execute']);
    expect(results[0].output).toContain('⚠️ WARNING');
    expect(results[0].output).toContain('file written');
  });

  it('preflight warning is prepended to tool output', async () => {
    const tool = makeTool('edit_file', false, 'line 1\nline 2');
    const registry = makeRegistry([tool]);

    const preflightHook: PreflightHook = {
      name: 'graph-preflight',
      shouldCheck: () => true,
      check: () => '⚠️ [自动影响分析] 即将修改 `foo.ts`\n│  风险等级: MEDIUM',
    };
    const preflight = new PreflightHookRegistry();
    preflight.register(preflightHook);

    const executor = new StreamingToolExecutor(registry, noopSink, null, preflight);
    executor.addTool({ id: 'c1', name: 'edit_file', arguments: '{"filePath":"/foo.ts"}' });

    const results = await executor.awaitRemaining();
    const output = results[0].output;
    // Warning must appear BEFORE the original output
    expect(output.indexOf('⚠️ [自动影响分析]')).toBeLessThan(output.indexOf('line 1'));
    expect(output).toContain('─'.repeat(40));
  });

  it('preflight hook is NOT called for read-only tools', async () => {
    const tool = makeTool('read_file_content', true, 'content');
    const registry = makeRegistry([tool]);

    const checkSpy = vi.fn(() => null);
    const preflightHook: PreflightHook = {
      name: 'graph-preflight',
      shouldCheck: (t: string) => ['edit_file', 'write_file'].includes(t),
      check: checkSpy,
    };
    const preflight = new PreflightHookRegistry();
    preflight.register(preflightHook);

    const executor = new StreamingToolExecutor(registry, noopSink, null, preflight);
    executor.addTool({ id: 'c1', name: 'read_file_content', arguments: '{}' });

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it('both preflight + post-tool hooks work together', async () => {
    const tool = makeTool('edit_file', false, 'raw output');
    const registry = makeRegistry([tool]);

    const preflightHook: PreflightHook = {
      name: 'graph-preflight',
      shouldCheck: () => true,
      check: () => '⚠️ PREFLIGHT',
    };
    const postHook: Hook = {
      name: 'graph-context',
      shouldEnrich: () => true,
      enrich: async (_t, _a, r) => `📊 POST-HOOK\n${r}`,
    };
    const preflight = new PreflightHookRegistry();
    preflight.register(preflightHook);
    const hooks = new HookRegistry();
    hooks.register(postHook);

    const executor = new StreamingToolExecutor(registry, noopSink, hooks, preflight);
    executor.addTool({ id: 'c1', name: 'edit_file', arguments: '{}' });

    const results = await executor.awaitRemaining();
    const output = results[0].output;
    // Preflight at very top, post-hook after that
    expect(output.indexOf('⚠️ PREFLIGHT')).toBeLessThan(output.indexOf('📊 POST-HOOK'));
    expect(output.indexOf('📊 POST-HOOK')).toBeLessThan(output.indexOf('raw output'));
  });

  it('hook crash does NOT break tool result', async () => {
    const tool = makeTool('read_file_content', true, 'survived');
    const registry = makeRegistry([tool]);

    const crashHook: Hook = {
      name: 'crash-hook',
      shouldEnrich: () => true,
      enrich: async () => {
        throw new Error('BOOM!');
      },
    };
    const hooks = new HookRegistry();
    hooks.register(crashHook);

    const executor = new StreamingToolExecutor(registry, noopSink, hooks, null);
    executor.addTool({ id: 'c1', name: 'read_file_content', arguments: '{}' });

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(results[0].output).toBe('survived');
    expect(results[0].err).toBeUndefined();
  });

  it('preflight crash does NOT break tool result', async () => {
    const tool = makeTool('edit_file', false, 'still written');
    const registry = makeRegistry([tool]);

    const crashHook: PreflightHook = {
      name: 'crash-preflight',
      shouldCheck: () => true,
      check: () => {
        throw new Error('KABOOM!');
      },
    };
    const preflight = new PreflightHookRegistry();
    preflight.register(crashHook);

    const executor = new StreamingToolExecutor(registry, noopSink, null, preflight);
    executor.addTool({ id: 'c1', name: 'edit_file', arguments: '{}' });

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(results[0].output).toBe('still written');
    expect(results[0].err).toBeUndefined();
  });

  it('delete_file triggers preflight (tool name fix verified)', async () => {
    const tool = makeTool('delete_file', false, 'deleted');
    const registry = makeRegistry([tool]);

    const checkSpy = vi.fn(() => '⚠️ deleting file');
    const preflightHook: PreflightHook = {
      name: 'graph-preflight',
      shouldCheck: (t: string) =>
        [
          'delete_file',
          'rename_file',
          'edit_file',
          'write_file',
          'move_file',
          'git_discard',
          'git_checkout',
          'git_commit',
        ].includes(t),
      check: checkSpy,
    };
    const preflight = new PreflightHookRegistry();
    preflight.register(preflightHook);

    const executor = new StreamingToolExecutor(registry, noopSink, null, preflight);
    executor.addTool({ id: 'c1', name: 'delete_file', arguments: '{"filePath":"/x.ts"}' });

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(results[0].output).toContain('⚠️ deleting file');
  });

  it('rename_file triggers preflight (tool name fix verified)', async () => {
    const tool = makeTool('rename_file', false, 'renamed');
    const registry = makeRegistry([tool]);

    const checkSpy = vi.fn(() => '⚠️ renaming file');
    const preflightHook: PreflightHook = {
      name: 'graph-preflight',
      shouldCheck: (t: string) => ['delete_file', 'rename_file', 'edit_file', 'write_file', 'move_file'].includes(t),
      check: checkSpy,
    };
    const preflight = new PreflightHookRegistry();
    preflight.register(preflightHook);

    const executor = new StreamingToolExecutor(registry, noopSink, null, preflight);
    executor.addTool({ id: 'c1', name: 'rename_file', arguments: '{"filePath":"/x.ts"}' });

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(results[0].output).toContain('⚠️ renaming file');
  });
});

describe('StreamingToolExecutor — unknown tool', () => {
  it('unknown tool emits ToolDispatch AND ToolResult-with-error (no false stuck signal)', async () => {
    const registry = makeRegistry([]); // nothing registered — the call is hallucinated

    const events: AgentEvent[] = [];
    const executor = new StreamingToolExecutor(registry, (ev) => events.push(ev), null, null);
    executor.addTool({ id: 'c-ghost', name: 'hallucinated_tool', arguments: '{}' });

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(results[0].err).toBe('unknown tool "hallucinated_tool"');

    // Dispatch AND result must both fire — the sub-agent activity tracker sets
    // currentTool on dispatch and only clears on ToolResult; without the result
    // a healthy agent looks stuck after 120s.
    const dispatch = events.find((e) => e.kind === EventKind.ToolDispatch);
    expect(dispatch?.tool?.name).toBe('hallucinated_tool');
    const resultEv = events.find((e) => e.kind === EventKind.ToolResult);
    expect(resultEv).toBeDefined();
    expect(resultEv?.tool?.id).toBe('c-ghost');
    expect(resultEv?.tool?.name).toBe('hallucinated_tool');
    expect(resultEv?.tool?.err).toBe('unknown tool "hallucinated_tool"');
    expect(resultEv?.tool?.output).toBe('error: unknown tool "hallucinated_tool"');
  });
});

describe('StreamingToolExecutor — abort settles pending tools (会话 223 事故回归)', () => {
  it('abort before awaitRemaining: pending tool gets [已取消] result + ToolResult event (card terminates)', async () => {
    // 永不 settle 的工具 — 模拟卡住的 shell
    const neverTool: Tool = {
      name: () => 'run_shell',
      description: () => 'mock shell',
      parameters: () => ({ type: 'object', properties: {}, required: [] }),
      readOnly: () => false,
      execute: () => new Promise<string>(() => {}), // 永不 resolve
    };
    const registry = makeRegistry([neverTool]);
    const events: AgentEvent[] = [];
    const ctrl = new AbortController();
    const executor = new StreamingToolExecutor(registry, (ev) => events.push(ev), null, null, null, ctrl.signal);
    executor.addTool({ id: 'c-shell', name: 'run_shell', arguments: '{"command":"cargo test"}' });
    ctrl.abort();

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(results[0].call.id).toBe('c-shell');
    expect(results[0].err).toBe('aborted');
    expect(results[0].output).toContain('已取消');

    // 卡片必须有 ToolResult 终结事件 — 之前缺失导致卡片永久"执行中"
    const resultEv = events.find((e) => e.kind === EventKind.ToolResult && e.tool?.id === 'c-shell');
    expect(resultEv).toBeDefined();
    expect(resultEv?.tool?.err).toBe('aborted');
  });

  it('abort mid-awaitRemaining: remaining pending tools also settle with [已取消]', async () => {
    const slowTool: Tool = {
      name: () => 'search_content',
      description: () => 'mock search',
      parameters: () => ({ type: 'object', properties: {}, required: [] }),
      readOnly: () => true,
      execute: (args: any) =>
        new Promise<string>((res) => {
          // 依 id 区分：c-fast 立即返回；c-slow 永不返回
          const callId = (args as { _testId?: string })._testId ?? '';
          if (callId === 'c-fast') {
            setTimeout(() => res('fast result'), 10);
          }
          // c-slow 永不 settle
        }),
    };
    const registry = makeRegistry([slowTool]);
    const events: AgentEvent[] = [];
    const ctrl = new AbortController();
    const executor = new StreamingToolExecutor(registry, (ev) => events.push(ev), null, null, null, ctrl.signal);
    executor.addTool({ id: 'c-fast', name: 'search_content', arguments: '{"_testId":"c-fast"}' });
    executor.addTool({ id: 'c-slow', name: 'search_content', arguments: '{"_testId":"c-slow"}' });

    // 等 fast 完成的过程中 abort
    setTimeout(() => ctrl.abort(), 30);
    const results = await executor.awaitRemaining();

    const byId = new Map(results.map((r) => [r.call.id, r]));
    expect(byId.get('c-fast')?.output).toBe('fast result'); // 已完成 → 真实结果
    const slow = byId.get('c-slow');
    expect(slow).toBeDefined();
    expect(slow?.err).toBe('aborted');
    expect(slow?.output).toContain('已取消');

    const slowEv = events.find((e) => e.kind === EventKind.ToolResult && e.tool?.id === 'c-slow');
    expect(slowEv).toBeDefined();
    expect(slowEv?.tool?.err).toBe('aborted');
  });
});
