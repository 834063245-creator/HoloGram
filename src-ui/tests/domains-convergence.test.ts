import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../src/agent/tool';
import { defineTool } from '../src/agent/tools/define-tool';
import {
  collectHiddenToolNames,
  convergeRegistry,
  resolveGuardToolName,
} from '../src/agent/tools/domains';
import { selectToolSchemas } from '../src/agent/tool-select';

function fakeTool(name: string, description: string, readOnly = false, schema = z.object({})) {
  return defineTool({
    name,
    description,
    schema,
    readOnly,
    execute: async (args) => `${name}:${JSON.stringify(args)}`,
  });
}

function buildFsRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    fakeTool('read_file_content', 'Read a file', true, z.object({ filePath: z.string() })),
  );
  registry.register(
    fakeTool('write_file', 'Write a file', false, z.object({ filePath: z.string(), content: z.string() })),
  );
  registry.register(fakeTool('list_directory', 'List a directory', true, z.object({ path: z.string() })));
  return registry;
}

describe('ToolRegistry.hide', () => {
  it('隐藏的工具从 schemas() 消失但 get() 仍可解析', () => {
    const registry = new ToolRegistry();
    const t = fakeTool('hidden_tool', 'x');
    registry.register(t);
    registry.hide('hidden_tool');

    expect(registry.schemas().map((s) => s.name)).toEqual([]);
    expect(registry.get('hidden_tool')).toBe(t);
    expect(registry.isHidden('hidden_tool')).toBe(true);
  });

  it('unhide 恢复可见', () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('t1', 'x'));
    registry.hide('t1');
    registry.unhide('t1');
    expect(registry.schemas().map((s) => s.name)).toEqual(['t1']);
  });
});

describe('领域工具收敛', () => {
  it('fs 领域只包含已注册旧工具的动作，execute 委托给旧工具', async () => {
    const registry = buildFsRegistry();
    convergeRegistry(registry);

    const fs = registry.get('fs');
    expect(fs).toBeTruthy();
    expect(fs!.actions?.()).toEqual(['read', 'write', 'list']);
    expect(fs!.readOnlyActions?.()).toEqual(['read', 'list']);
    expect(fs!.readOnly()).toBe(false); // 混合读写 → 非整体只读

    expect(await fs!.execute({ action: 'read', filePath: 'D:/a.ts' })).toBe(
      'read_file_content:{"filePath":"D:/a.ts"}',
    );
    expect(await fs!.execute({ action: 'write', filePath: 'D:/a.ts', content: 'x' })).toBe(
      'write_file:{"filePath":"D:/a.ts","content":"x"}',
    );
  });

  it('不支持的 action 返回明确错误而不是抛异常', async () => {
    const registry = buildFsRegistry();
    convergeRegistry(registry);
    const out = await registry.get('fs')!.execute({ action: 'nope' });
    expect(out).toContain('unsupported action');
    expect(out).toContain('read, write, list');
  });

  it('旧工具名被隐藏但保留可执行', () => {
    const registry = buildFsRegistry();
    convergeRegistry(registry);
    const visible = registry.schemas().map((s) => s.name);
    expect(visible).toContain('fs');
    expect(visible).not.toContain('read_file_content');
    expect(registry.get('read_file_content')).toBeTruthy();
  });

  it('convergeRegistry 幂等：重复调用不产生重复领域工具', () => {
    const registry = buildFsRegistry();
    convergeRegistry(registry);
    convergeRegistry(registry);
    const fsNames = registry.schemas().filter((s) => s.name === 'fs');
    expect(fsNames).toHaveLength(1);
  });

  it('隐藏清单包含核心旧名与别名', () => {
    const hidden = collectHiddenToolNames();
    expect(hidden).toContain('read_file_content');
    expect(hidden).toContain('read_file'); // alias
    expect(hidden).toContain('agent_spawn');
    expect(hidden).toContain('agent_message');
  });

  it('resolveGuardToolName 把领域动作映射回旧工具名（门禁/hooks 不失效）', async () => {
    const registry = buildFsRegistry();
    convergeRegistry(registry);
    expect(resolveGuardToolName(registry, 'fs', { action: 'write', filePath: 'x' })).toBe('write_file');
    expect(resolveGuardToolName(registry, 'fs', { action: 'read', filePath: 'x' })).toBe('read_file_content');
    expect(resolveGuardToolName(registry, 'fs', { action: 'nope' })).toBe('fs');
    expect(resolveGuardToolName(registry, 'read_file_content', { filePath: 'x' })).toBe('read_file_content');
  });
});

describe('selectToolSchemas 每轮注入', () => {
  const registry = new ToolRegistry();
  registry.register(fakeTool('fileops', 'file system ops'));
  registry.register(fakeTool('grep', 'search source text'));
  registry.register(fakeTool('vcs', 'git operations'));
  registry.register(fakeTool('webfetch', 'fetch a url'));
  registry.register(fakeTool('alpha', 'graph dependency exploration'));
  registry.register(fakeTool('beta', 'commit changes to git repository'));
  registry.register(fakeTool('gamma', 'memory recall and search'));
  registry.register(fakeTool('delta', 'task board create and list'));

  it('limit=0 返回全量（兼容旧行为）', () => {
    expect(selectToolSchemas(registry, 'anything', 0)).toHaveLength(8);
  });

  it('limit 生效且保留原始顺序', () => {
    const out = selectToolSchemas(registry, '', 3);
    expect(out.length).toBeLessThanOrEqual(3);
    const idx = out.map((t) => registry.schemas().findIndex((s) => s.name === t.name));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it('上下文关键词命中工具描述时优先选中', () => {
    const out = selectToolSchemas(registry, '帮我 commit 这些 changes 到 git', 2);
    expect(out.map((t) => t.name)).toContain('beta');
  });
});
