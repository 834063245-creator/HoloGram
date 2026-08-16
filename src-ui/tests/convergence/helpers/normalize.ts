// Convergence 测试基建 — 快照稳定化。
//
// 规则（验证计划 §7.3）：契约快照只测稳定表面——
// 不把耗时、随机 id、未规范化路径写入快照；所有输出先归一再序列化比较。

/** 归一易变文本：计划 id（plan-<ts>-<rand>）、ISO 时间戳。
 *  只做保守的定向替换，不 blanket 清数字（会掩盖真实回归）。 */
export function normalizeVolatileText(s: string): string {
  return s
    .replace(/plan-\d+-[a-z0-9]+/g, 'plan-<id>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<iso-ts>');
}

/** 递归排序 key 的稳定序列化：对象 key 按字典序、字符串先归一、2 空格缩进。
 *  同一份输入在任何机器、任何时间产出字节相同的结果。 */
export function stableStringify(value: unknown): string {
  return stringifyValue(value, 0);
}

function stringifyValue(value: unknown, indent: number): string {
  const pad = '  '.repeat(indent);
  const padInner = '  '.repeat(indent + 1);
  if (typeof value === 'string') return JSON.stringify(normalizeVolatileText(value));
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Map || value instanceof Set) {
    // Map/Set 不进契约快照 — 强制先转数组，防止静默丢字段
    throw new Error('[convergence] stableStringify: 不支持 Map/Set，先转为数组或普通对象');
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => `${padInner}${stringifyValue(v, indent + 1)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (keys.length === 0) return '{}';
  const entries = keys.map((k) => `${padInner}${JSON.stringify(k)}: ${stringifyValue(obj[k], indent + 1)}`);
  return `{\n${entries.join(',\n')}\n${pad}}`;
}
