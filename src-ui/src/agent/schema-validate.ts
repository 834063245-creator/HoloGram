// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 结构化返回（output_schema）— JSON Schema 受限子集校验，零依赖。
// 子集语义对标 DSH harness 的 assertObjectJsonSchema：
// 仅支持 type / properties / required / additionalProperties / items /
// enum / const / oneOf — 不支持 pattern / format / 数值边界。
// 不支持的 schema 在派发前拒绝（fail loud），绝不在执行中静默降级。

export type JsonSchema = Record<string, unknown>;

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'oneOf',
]);

const VALID_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 校验 schema 本身是否落在受支持子集内。返回错误文案，null = 通过。 */
export function assertSupportedSchema(schema: unknown): string | null {
  if (!isPlainObject(schema)) return 'output_schema 必须是 JSON 对象';
  if (schema.type != null) {
    if (schema.type !== 'object') return 'output_schema 根节点 type 必须是 "object"';
  }
  return checkSchemaNode(schema, '$');
}

function checkSchemaNode(node: unknown, path: string): string | null {
  if (!isPlainObject(node)) return `schema 节点 ${path} 必须是对象`;
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      return `schema 节点 ${path} 含不支持的关键字 "${key}"（仅支持 ${[...SUPPORTED_KEYWORDS].join('/')}）`;
    }
  }
  if (node.type != null && typeof node.type !== 'string') return `schema 节点 ${path} 的 type 必须是字符串`;
  if (node.type != null && !VALID_TYPES.has(node.type as string)) {
    return `schema 节点 ${path} 的 type "${String(node.type)}" 不受支持`;
  }
  if (node.properties != null) {
    if (!isPlainObject(node.properties)) return `schema 节点 ${path} 的 properties 必须是对象`;
    for (const [k, v] of Object.entries(node.properties)) {
      const err = checkSchemaNode(v, `${path}.properties.${k}`);
      if (err) return err;
    }
  }
  if (node.required != null) {
    if (!Array.isArray(node.required) || node.required.some((r) => typeof r !== 'string')) {
      return `schema 节点 ${path} 的 required 必须是字符串数组`;
    }
  }
  if (node.additionalProperties != null && typeof node.additionalProperties !== 'boolean') {
    const err = checkSchemaNode(node.additionalProperties, `${path}.additionalProperties`);
    if (err) return err;
  }
  if (node.items != null) {
    const err = checkSchemaNode(node.items, `${path}.items`);
    if (err) return err;
  }
  if (node.enum != null && !Array.isArray(node.enum)) {
    return `schema 节点 ${path} 的 enum 必须是数组`;
  }
  if (node.oneOf != null) {
    if (!Array.isArray(node.oneOf)) return `schema 节点 ${path} 的 oneOf 必须是数组`;
    for (let i = 0; i < node.oneOf.length; i++) {
      const err = checkSchemaNode(node.oneOf[i], `${path}.oneOf[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function matchType(v: unknown, t: string): boolean {
  switch (t) {
    case 'object':
      return isPlainObject(v);
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number';
    case 'null':
      return v === null;
    default:
      return false;
  }
}

/** 校验值是否符合受限子集 schema。返回错误文案，null = 通过。
 *  先调 assertSupportedSchema 保证 schema 本身合法。 */
export function validateObjectJsonSchema(value: unknown, schema: JsonSchema, path = '$'): string | null {
  if (schema.type != null && !matchType(value, schema.type as string)) {
    return `${path}: 期望类型 ${String(schema.type)}，实际 ${describeType(value)}`;
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    return `${path}: 与 const 不符`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((c) => deepEqual(value, c))) {
    return `${path}: 不在 enum 允许值内`;
  }
  if (Array.isArray(schema.oneOf)) {
    const passes = schema.oneOf.filter((s) => validateObjectJsonSchema(value, s as JsonSchema, path) === null);
    if (passes.length !== 1) {
      return `${path}: oneOf 命中 ${passes.length} 个分支（要求恰好 1 个）`;
    }
  }
  if (isPlainObject(value)) {
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      if (!(key in props)) {
        if (schema.additionalProperties === false) {
          return `${path}.${key}: 不允许的额外属性`;
        }
        if (isPlainObject(schema.additionalProperties)) {
          const err = validateObjectJsonSchema(
            value[key],
            schema.additionalProperties as JsonSchema,
            `${path}.${key}`,
          );
          if (err) return err;
        }
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) {
        const err = validateObjectJsonSchema(value[key], sub as JsonSchema, `${path}.${key}`);
        if (err) return err;
      }
    }
    const required = (schema.required ?? []) as string[];
    for (const key of required) {
      if (!(key in value)) return `${path}: 缺少必需属性 "${key}"`;
    }
  }
  if (Array.isArray(value) && schema.items != null) {
    for (let i = 0; i < value.length; i++) {
      const err = validateObjectJsonSchema(value[i], schema.items as JsonSchema, `${path}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 从子 Agent 的最终文本中提取 JSON 对象。
 *  顺序尝试：整段 JSON.parse → 去 ```json 围栏 → 首个 { 到末个 } 的平衡截取。
 *  失败返回 undefined。 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fallthrough */
    }
  }
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (fenced.startsWith('{')) {
    try {
      return JSON.parse(fenced);
    } catch {
      /* fallthrough */
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 生成注入子 Agent prompt 的强制输出格式段。 */
export function buildOutputSchemaInstruction(schema: JsonSchema): string {
  return [
    '',
    '## 输出格式（强制）',
    '你的最终回复必须是一个 JSON 对象，且必须通过以下 JSON Schema 校验：',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
    '回复只能包含这个 JSON 对象本身 — 不要任何其他文字、解释、markdown 围栏。',
  ].join('\n');
}
