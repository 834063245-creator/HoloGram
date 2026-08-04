// defineTool 行为守护 — zod Schema-First 迁移的保障网。
// 覆盖: JSON Schema 输出形状 / 校验失败报错 / default+coerce / meta key 透传 / readOnly。
// 子 Agent 大批量迁移后, 这组测试保证工厂语义不漂移。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, toInputJsonSchema } from '../src/agent/tools/define-tool';
import type { ToolExecutor } from '../src/agent/tool';
import { createCodingTools } from '../src/agent/tool';

describe('toInputJsonSchema', () => {
  it('输出 JSON Schema 形状: properties + required, 无 $schema 元字段', () => {
    const s = z.object({ path: z.string().describe('repo root'), count: z.number().int().optional() });
    const out = toInputJsonSchema(s);
    expect(out).toEqual({
      type: 'object',
      properties: { path: { type: 'string', description: 'repo root' }, count: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 } },
      required: ['path'],
    });
    expect(out).not.toHaveProperty('$schema');
  });

  it('io:input 视图 — defaulted 字段不进 required（避免"有 default 又 required"矛盾）', () => {
    const s = z.object({ count: z.number().optional().default(10) });
    const out = toInputJsonSchema(s);
    expect(out.required).toBeUndefined();
    expect((out.properties as any).count.default).toBe(10);
  });

  it('enum 输出 enum 数组', () => {
    const s = z.object({ mode: z.enum(['fork', 'fresh']) });
    const out = toInputJsonSchema(s);
    expect((out.properties as any).mode).toEqual({ type: 'string', enum: ['fork', 'fresh'] });
  });
});

describe('defineTool execute 行为', () => {
  const mkTool = () =>
    defineTool({
      name: 'demo',
      description: 'demo tool',
      schema: z.object({
        path: z.string().describe('path'),
        count: z.coerce.number().int().optional().default(10).describe('count'),
      }),
      execute: (args) => Promise.resolve(JSON.stringify({ path: args.path, count: args.count })),
    });

  it('default 注入 + coerce: 漏传 count → 10; 传 "5" → 5(number)', async () => {
    const t = mkTool();
    expect(await t.execute({ path: '/x' })).toBe(JSON.stringify({ path: '/x', count: 10 }));
    expect(await t.execute({ path: '/x', count: '5' })).toBe(JSON.stringify({ path: '/x', count: 5 }));
  });

  it('校验失败抛错: 缺 required 字段 → 带"参数校验失败"的错误', async () => {
    const t = mkTool();
    await expect(t.execute({})).rejects.toThrow(/参数校验失败/);
  });

  it('meta key 透传: _callId/_agent_id/_forceGate 不被 strip 掉', async () => {
    let seen: any = null;
    const t = defineTool({
      name: 'meta',
      description: 'meta test',
      schema: z.object({ path: z.string() }),
      execute: (args) => {
        seen = args;
        return Promise.resolve('ok');
      },
    });
    await t.execute({ path: '/x', _callId: 'c1', _agent_id: 'a1', _forceGate: true });
    expect(seen).toMatchObject({ path: '/x', _callId: 'c1', _agent_id: 'a1', _forceGate: true });
  });

  it('readOnly 默认 false, 显式 true 生效', () => {
    expect(defineTool({ name: 'a', description: 'a', schema: z.object({}), execute: async () => 'x' }).readOnly()).toBe(false);
    expect(defineTool({ name: 'b', description: 'b', schema: z.object({}), readOnly: true, execute: async () => 'x' }).readOnly()).toBe(true);
  });

  it('parameters() 输出稳定（WeakMap 缓存, 多次调用同一对象引用）', () => {
    const t = mkTool();
    expect(t.parameters()).toBe(t.parameters());
  });
});

describe('迁移样板: read_file_content / git_log', () => {
  const exec: ToolExecutor = async (name, args) => JSON.stringify({ name, args });
  const tools = createCodingTools(exec);
  it('read_file_content 的 schema key 与转换后 Rust 参数一致', async () => {
    const t = tools.find((x) => x.name() === 'read_file_content')!;
    const params = t.parameters() as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(params.properties)).toEqual(['filePath', 'offset', 'limit']);
    expect(params.required).toEqual(['filePath']);
    // 透传执行 — 原样转发, 不手打包
    const out = JSON.parse(await t.execute({ filePath: 'D:/a.ts', offset: 3 }));
    expect(out.args).toEqual({ filePath: 'D:/a.ts', offset: 3 });
  });

  it('git_log: count 默认 10 + 字符串 coerce', async () => {
    const t = tools.find((x) => x.name() === 'git_log')!;
    const out = JSON.parse(await t.execute({ path: 'D:/p' }));
    expect(out.args.count).toBe(10);
    const out2 = JSON.parse(await t.execute({ path: 'D:/p', count: '3' }));
    expect(out2.args.count).toBe(3);
  });
});
