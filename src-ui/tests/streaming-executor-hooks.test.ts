import { describe, it, expect, vi } from 'vitest';
import { StreamingToolExecutor } from '../src/agent/streaming-executor';
import { ToolRegistry } from '../src/agent/tool';
import type { Tool } from '../src/agent/tool';
import { HookRegistry, PreflightHookRegistry } from '../src/agent/hooks';
import type { Hook, PreflightHook } from '../src/agent/hooks';
import { EventKind, type AgentEvent, type Pricing } from '../src/agent/agent-types';

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
      check: () => '⚠️ [自动影响分析] 即将修改 `foo.ts`\n│  风险等级: HIGH',
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
      enrich: async () => { throw new Error('BOOM!'); },
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
      check: () => { throw new Error('KABOOM!'); },
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
      shouldCheck: (t: string) => ['delete_file', 'rename_file', 'edit_file', 'write_file', 'move_file',
        'git_discard', 'git_checkout', 'git_commit'].includes(t),
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
