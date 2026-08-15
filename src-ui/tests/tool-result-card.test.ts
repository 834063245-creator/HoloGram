import { describe, expect, it } from 'vitest';

import { formatToolResult, TRUNCATED_BADGE } from '../src/ui/chat-utils';

describe('formatToolResult glob 卡片（结构化渲染收口）', () => {
  const globArgs = JSON.stringify({ action: 'glob', pattern: '**/*.rs' });

  it('合法 glob 结果渲染紧凑列表，不解析 executor 级截断标志外的文本', () => {
    const json = JSON.stringify({
      results: [{ path: 'a.rs' }, { path: 'b.rs' }],
      count: 2,
      truncated: false,
    });
    const out = formatToolResult('glob', json, false, globArgs);
    expect(out.kind).toBe('html');
    if (out.kind === 'html') {
      expect(out.html).toContain('2 个文件');
      expect(out.html).toContain('a.rs');
    }
  });

  it('results/count 缺失 → 大声降级并保留原文（宪法·错误不静默）', () => {
    const json = JSON.stringify({ results: [{ path: 'a.rs' }] }); // count 缺失
    const out = formatToolResult('glob', json, false, globArgs);
    expect(out.kind).toBe('html');
    if (out.kind === 'html') {
      expect(out.html).toContain('⚠ glob 结果结构异常');
      expect(out.html).toContain('a.rs'); // 原文仍在，可人工核对
    }
  });

  it('非 JSON 输出 → 大声降级而非静默回退', () => {
    const out = formatToolResult('glob', 'not-json', false, globArgs);
    expect(out.kind).toBe('html');
    if (out.kind === 'html') {
      expect(out.html).toContain('⚠ glob 结果解析失败');
      expect(out.html).toContain('not-json');
    }
  });

  it('truncated 标志 → UI 角标走单一常量（与 executor 标志同源）', () => {
    // run_shell 走 bash 代码块（html kind）；角标应随标志追加且文案单一来源
    const out = formatToolResult('run_shell', 'cargo build\n', true, undefined);
    expect(out.kind).toBe('html');
    if (out.kind === 'html') {
      expect(out.html).toContain(TRUNCATED_BADGE);
    }
    // 未截断不带角标
    const out2 = formatToolResult('run_shell', 'cargo build\n', false, undefined);
    if (out2.kind === 'html') {
      expect(out2.html).not.toContain(TRUNCATED_BADGE);
    }
  });
});
