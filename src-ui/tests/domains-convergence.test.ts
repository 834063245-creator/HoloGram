import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../src/agent/tool';
import { createStableSchemaSelector, selectToolSchemas, userContext } from '../src/agent/tool-select';
import { StreamingToolExecutor } from '../src/agent/streaming-executor';
import { defineTool } from '../src/agent/tools/define-tool';
import {
  collectHiddenToolNames,
  convergeRegistry,
  DOMAIN_SPECS,
  normalizeArgs,
  retireRedirect,
  resolveGuardToolName,
} from '../src/agent/tools/domains';

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
  registry.register(fakeTool('read_file_content', 'Read a file', true, z.object({ filePath: z.string() })));
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

describe('领域工具参数 schema（DeepSeek 严格校验回归）', () => {
  it('fs 根节点为 type:object，action 是必选枚举，动作参数合并为可选属性', () => {
    const registry = buildFsRegistry();
    convergeRegistry(registry);
    const fs = registry.get('fs');
    expect(fs).toBeTruthy();
    if (!fs) throw new Error('fs domain tool missing');
    const params = fs.parameters() as {
      type?: string;
      oneOf?: unknown;
      anyOf?: unknown;
      properties: Record<string, { type?: string; enum?: string[] }>;
      required?: string[];
    };

    expect(params.type).toBe('object');
    expect(params.oneOf).toBeUndefined();
    expect(params.anyOf).toBeUndefined();
    expect(params.properties.action).toMatchObject({ type: 'string', enum: ['read', 'write', 'list'] });
    expect(params.required).toEqual(['action']);
    for (const key of ['filePath', 'content', 'path']) {
      expect(params.properties[key]).toBeTruthy();
    }
  });

  it('所有领域工具的参数根节点均为 type:object（DeepSeek 不再 400）', () => {
    const registry = new ToolRegistry();
    for (const spec of DOMAIN_SPECS) {
      for (const oldName of Object.values(spec.actions)) {
        registry.register(fakeTool(oldName, oldName, true, z.object({ p1: z.string() })));
      }
    }
    convergeRegistry(registry);

    for (const spec of DOMAIN_SPECS) {
      const domainTool = registry.get(spec.name);
      expect(domainTool, spec.name).toBeTruthy();
      if (!domainTool) continue;
      const params = domainTool.parameters() as {
        type?: string;
        oneOf?: unknown;
        anyOf?: unknown;
        properties: Record<string, { enum?: string[] }>;
        required?: string[];
      };
      expect(params.type, spec.name).toBe('object');
      expect(params.oneOf, spec.name).toBeUndefined();
      expect(params.anyOf, spec.name).toBeUndefined();
      expect(params.properties.action.enum, spec.name).toEqual(Object.keys(spec.actions));
      expect(params.required, spec.name).toEqual(['action']);
    }
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

    expect(await fs!.execute({ action: 'read', filePath: 'D:/a.ts' })).toBe('read_file_content:{"filePath":"D:/a.ts"}');
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

describe('normalizeArgs 参数别名归一（领域扁平 schema 摩擦修复）', () => {
  it('fs(delete, filePath) 补成 delete_file 的 path', async () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('delete_file', 'Delete', false, z.object({ path: z.string() })));
    convergeRegistry(registry);
    const out = await registry.get('fs')!.execute({ action: 'delete', filePath: 'D:/x' });
    expect(out).toContain('"path":"D:/x"');
  });

  it('fs(read, path) 补成 read_file_content 的 filePath', async () => {
    const registry = buildFsRegistry();
    convergeRegistry(registry);
    const out = await registry.get('fs')!.execute({ action: 'read', path: 'D:/a.ts' });
    expect(out).toContain('"filePath":"D:/a.ts"');
  });

  it('直接调用 normalizeArgs', () => {
    const old = fakeTool('x', 'x', false, z.object({ filePath: z.string() }));
    expect(normalizeArgs(old, { path: 'p' })).toEqual({ path: 'p', filePath: 'p' });
  });
});

describe('retireRedirect 旧名淘汰重定向', () => {
  it('常见旧名映射到领域动作', () => {
    expect(retireRedirect('read_file_content')).toBe('fs(read)');
    expect(retireRedirect('write_file')).toBe('fs(write)');
    expect(retireRedirect('edit_file')).toBe('fs(edit)');
    expect(retireRedirect('run_shell')).toBe('shell(run)');
    expect(retireRedirect('search_content')).toBe('search(content)');
    expect(retireRedirect('git_status')).toBe('git(status)');
    expect(retireRedirect('agent_spawn')).toBe('agent(spawn)');
    expect(retireRedirect('agent_message')).toBe('agent(message)');
    expect(retireRedirect('task_create')).toBe('task(create)');
    expect(retireRedirect('hologram_memory_save')).toBe('memory(save)');
  });

  it('read_file 别名经链解析到 fs(read)', () => {
    expect(retireRedirect('read_file')).toBe('fs(read)');
  });

  it('未知/领域名返回 null（不误伤）', () => {
    expect(retireRedirect('fs')).toBeNull();
    expect(retireRedirect('whatever')).toBeNull();
  });
});

describe('executor 拦截隐藏旧名（负反馈 seam）', () => {
  it('模型调用 read_file_content 返回 [已淘汰] 重定向而非执行', async () => {
    const registry = buildFsRegistry();
    convergeRegistry(registry);
    const events: unknown[] = [];
    const ex = new StreamingToolExecutor(registry, (e) => events.push(e));
    ex.addTool({ id: 'c1', name: 'read_file_content', arguments: '{"filePath":"D:/a"}' });
    const results = await ex.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(results[0].output).toContain('[已淘汰]');
    expect(results[0].output).toContain('fs(read)');
    // 领域工具不受影响，仍正常执行
    ex.addTool({ id: 'c2', name: 'fs', arguments: '{"action":"read","filePath":"D:/a"}' });
    const results2 = await ex.awaitRemaining();
    expect(results2[0].output).toContain('read_file_content:');
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

  it('常驻集包含 search/memory，低 limit 也不丢', () => {
    const r = new ToolRegistry();
    r.register(fakeTool('search', 'search source text'));
    r.register(fakeTool('memory', 'memory ops'));
    r.register(fakeTool('gamma', 'unrelated tool'));
    const out = selectToolSchemas(r, '', 2);
    const names = out.map((t) => t.name);
    expect(names).toContain('search');
    expect(names).toContain('memory');
    expect(names).not.toContain('gamma');
  });
});

describe('schema 稳定性契约（缓存命中保护）', () => {
  function buildRegistry(): ToolRegistry {
    const r = new ToolRegistry();
    r.register(fakeTool('search', 'search source text'));
    r.register(fakeTool('memory', 'memory recall and search'));
    r.register(fakeTool('fileops', 'file system ops'));
    r.register(fakeTool('grep', 'search source text'));
    r.register(fakeTool('vcs', 'git operations'));
    r.register(fakeTool('webfetch', 'fetch a url'));
    r.register(fakeTool('alpha', 'graph dependency exploration'));
    r.register(fakeTool('beta', 'commit changes to git repository'));
    return r;
  }

  it('userContext 只取 user 消息，工具循环轮次不参与打分', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '帮我 commit 到 git' },
      { role: 'assistant', content: '', tool_calls: [{ name: 'git', arguments: '{}' }] },
      { role: 'tool', content: 'ok' },
      { role: 'assistant', content: '继续' },
    ] as any;
    const ctx1 = userContext(msgs);
    const ctx2 = userContext([
      ...msgs,
      { role: 'tool', content: 'more results' },
      { role: 'assistant', content: '再读一个文件' },
    ] as any);
    expect(ctx1).toBe('帮我 commit 到 git');
    expect(ctx2).toBe(ctx1);
  });

  it('userContext 只保留最近 3 条 user 消息', () => {
    const msgs = [1, 2, 3, 4].map((i) => ({ role: 'user', content: `msg${i}` }));
    expect(userContext(msgs as any)).toBe('msg2\nmsg3\nmsg4');
  });

  it('同一上下文重复 select 返回同一引用（锁存生效）', () => {
    const r = buildRegistry();
    const s = createStableSchemaSelector();
    const a = s.select(r, 4, '帮我 commit 到 git');
    const b = s.select(r, 4, '帮我 commit 到 git');
    expect(b).toBe(a);
  });

  it('工具循环内 schema 保持逐字节一致（消息增长不改变子集）', () => {
    const r = buildRegistry();
    const s = createStableSchemaSelector();
    const ctx = '帮我 commit 到 git';
    const first = s.select(r, 4, ctx);
    // 模拟工具循环：10 轮 assistant/tool 消息增长 — userContext 不变
    const loopCtx = userContext([
      { role: 'user', content: ctx },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'assistant' : 'tool',
        content: `round ${i} output`,
      })),
    ] as any);
    expect(loopCtx).toBe(ctx);
    const after = s.select(r, 4, loopCtx);
    expect(after).toBe(first);
  });

  it('新用户消息触发重算（子集可随指令变化）', () => {
    const r = buildRegistry();
    const s = createStableSchemaSelector();
    const a = s.select(r, 4, '帮我 commit 到 git');
    const b = s.select(r, 4, '现在搜索代码里的 bug');
    expect(b).not.toBe(a);
  });

  it('registry 引用变化触发重算（plan 模式切换路径）', () => {
    const r1 = buildRegistry();
    const r2 = buildRegistry();
    const s = createStableSchemaSelector();
    const a = s.select(r1, 4, 'ctx');
    const b = s.select(r2, 4, 'ctx');
    expect(b).not.toBe(a);
  });

  it('limit 变化触发重算', () => {
    const r = buildRegistry();
    const s = createStableSchemaSelector();
    const a = s.select(r, 4, 'ctx');
    const b = s.select(r, 5, 'ctx');
    expect(b).not.toBe(a);
  });
});
