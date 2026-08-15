// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// output_schema 结构化返回 — schema 子集校验 + JSON 提取 + 工具接线。
// 覆盖：受限子集拒绝、值校验、围栏/前后缀文本提取、异步组合拒绝、失败不静默。

import { describe, expect, it } from 'vitest';
import { SubAgentPool } from '../src/agent/coordinator';
import { createSubAgentTool, type SubAgentSpawner } from '../src/agent/tools/subagent';
import {
  assertSupportedSchema,
  buildOutputSchemaInstruction,
  extractJsonObject,
  validateObjectJsonSchema,
} from '../src/agent/schema-validate';

function makeSpawner(result: { text: string; err?: string }): SubAgentSpawner {
  return async () => result;
}

describe('schema-validate — supported subset gate', () => {
  it('accepts the documented subset', () => {
    expect(
      assertSupportedSchema({
        type: 'object',
        properties: { name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
        required: ['name'],
        additionalProperties: false,
      }),
    ).toBeNull();
  });

  it('rejects non-object roots and unsupported keywords (fail loud)', () => {
    expect(assertSupportedSchema({ type: 'array' })).toContain('根节点');
    expect(assertSupportedSchema({ type: 'object', pattern: 'x' })).toContain('不支持的关键字');
    expect(assertSupportedSchema({ type: 'object', properties: { n: { type: 'number', minimum: 1 } } })).toContain(
      'minimum',
    );
  });
});

describe('schema-validate — value validation', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      count: { type: 'integer' },
      mode: { enum: ['a', 'b'] },
      tags: { type: 'array', items: { type: 'string' } },
      exact: { const: 7 },
    },
    required: ['name'],
    additionalProperties: false,
  };

  it('passes a fully valid object', () => {
    expect(
      validateObjectJsonSchema(
        { name: 'x', count: 1, mode: 'a', tags: ['t'], exact: 7 },
        schema,
      ),
    ).toBeNull();
  });

  it('fails on missing required, extra properties, wrong type, enum miss', () => {
    expect(validateObjectJsonSchema({}, schema)).toContain('缺少必需属性 "name"');
    expect(validateObjectJsonSchema({ name: 'x', extra: 1 }, schema)).toContain('不允许的额外属性');
    expect(validateObjectJsonSchema({ name: 5 }, schema)).toContain('期望类型 string');
    expect(validateObjectJsonSchema({ name: 'x', mode: 'c' }, schema)).toContain('不在 enum');
  });

  it('oneOf requires exactly one branch', () => {
    const s = { type: 'object', oneOf: [{ required: ['a'] }, { required: ['b'] }] } as const;
    expect(validateObjectJsonSchema({ a: 1 }, s as never)).toBeNull();
    expect(validateObjectJsonSchema({ a: 1, b: 2 }, s as never)).toContain('oneOf 命中 2 个分支');
  });
});

describe('schema-validate — JSON extraction', () => {
  it('parses bare object, fenced object, and object inside prose', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('前缀文字 {"a":1} 后缀文字')).toEqual({ a: 1 });
    expect(extractJsonObject('no json here')).toBeUndefined();
  });

  it('builds an instruction appendix naming the schema', () => {
    const text = buildOutputSchemaInstruction({ type: 'object', required: ['x'] });
    expect(text).toContain('输出格式（强制）');
    expect(text).toContain('"required"');
  });
});

describe('agent_spawn — output_schema wiring', () => {
  const schema = {
    type: 'object',
    properties: { verdict: { type: 'string' } },
    required: ['verdict'],
    additionalProperties: false,
  };

  it('returns the validated JSON as the tool result', async () => {
    const pool = new SubAgentPool();
    const seen: { outputSchema?: Record<string, unknown> | null } = {};
    const tool = createSubAgentTool(
      (async (_d, _p, _prog, _m, _al, _sig, _am, _id, outputSchema) => {
        seen.outputSchema = outputSchema;
        return { text: '```json\n{"verdict":"ok"}\n```' };
      }) as SubAgentSpawner,
      pool,
    );
    const out = await tool.execute({ description: 't', prompt: 'do it', output_schema: schema });
    expect(JSON.parse(out as string)).toEqual({ verdict: 'ok' });
    expect(seen.outputSchema).toEqual(schema);
  });

  it('does not silently degrade on invalid result — returns the failure wrapper', async () => {
    const pool = new SubAgentPool();
    const tool = createSubAgentTool(
      (async () => ({ text: '{"verdict": 5}' })) as SubAgentSpawner,
      pool,
    );
    const out = await tool.execute({ description: 't', prompt: 'do it', output_schema: schema });
    expect(String(out)).toContain('output_schema 校验失败');
    expect(String(out)).toContain('原文');
  });

  it('rejects async + output_schema before spawning (fail loud)', async () => {
    const pool = new SubAgentPool();
    let spawned = false;
    const tool = createSubAgentTool(
      (async () => {
        spawned = true;
        return { text: 'x' };
      }) as SubAgentSpawner,
      pool,
    );
    const out = await tool.execute({
      description: 't',
      prompt: 'do it',
      async: true,
      output_schema: schema,
    });
    expect(String(out)).toContain('仅支持阻塞模式');
    expect(spawned).toBe(false);
  });

  it('rejects unsupported schema keywords at spawn time', async () => {
    const pool = new SubAgentPool();
    let spawned = false;
    const tool = createSubAgentTool(
      (async () => {
        spawned = true;
        return { text: 'x' };
      }) as SubAgentSpawner,
      pool,
    );
    const out = await tool.execute({
      description: 't',
      prompt: 'do it',
      output_schema: { type: 'object', properties: { n: { type: 'number', minimum: 1 } } },
    });
    expect(String(out)).toContain('output_schema 不受支持');
    expect(spawned).toBe(false);
  });
});
