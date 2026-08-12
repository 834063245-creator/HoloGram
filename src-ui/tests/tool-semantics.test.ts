// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具收敛回归测试 — 模型调用领域工具（fs/shell/search/...）后，
// UI 流式渲染（diff 视图 / bash 代码块 / 写入预览 / 替换语义）必须继续工作。
// 覆盖 tool-semantics / formatToolResult / extractWritePreview / part-mutator。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks（与 audit-fixes-*.test.ts 一致的最小集）──
vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/ui/events', () => ({
  bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), withPrefix: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }) },
}));
vi.mock('../src/ui/app-shell', () => ({ shell: { register: vi.fn() } }));
vi.mock('../src/agent/permission', () => ({}));
vi.mock('../src/agent/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({
    providers: [{ name: 'test', model: 'test', apiKey: 'k', kind: 'openai', baseUrl: '', thinking: false }],
    activeProvider: 'test',
    agent: {},
    display: { language: 'zh', fontScale: 1 },
  })),
  saveSettings: vi.fn(),
  CHAT_MODES: [{ id: 'general', label: '通用', description: '', temperature: 0.7, maxSteps: 50 }],
}));
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

// ═══════════════════════════════════════════════════════════════════
// resolveSemanticToolName / displayToolName
// ═══════════════════════════════════════════════════════════════════

describe('resolveSemanticToolName — 领域调用归一化为旧语义名', () => {
  it('fs(write/edit/read/glob) 映射到旧名', async () => {
    const { resolveSemanticToolName } = await import('../src/ui/tool-semantics');
    expect(resolveSemanticToolName('fs', '{"action":"write","filePath":"/a.ts"}')).toBe('write_file');
    expect(resolveSemanticToolName('fs', '{"action":"edit"}')).toBe('edit_file');
    expect(resolveSemanticToolName('fs', '{"action":"read"}')).toBe('read_file_content');
    expect(resolveSemanticToolName('fs', '{"action":"glob"}')).toBe('glob');
  });

  it('shell/search/git 映射到旧名', async () => {
    const { resolveSemanticToolName } = await import('../src/ui/tool-semantics');
    expect(resolveSemanticToolName('shell', '{"action":"run"}')).toBe('run_shell');
    expect(resolveSemanticToolName('shell', '{"action":"output"}')).toBe('bash_output');
    expect(resolveSemanticToolName('shell', '{"action":"wait"}')).toBe('bash_wait');
    expect(resolveSemanticToolName('search', '{"action":"content"}')).toBe('search_content');
    expect(resolveSemanticToolName('git', '{"action":"commit"}')).toBe('git_commit');
  });

  it('非领域工具 / action 缺失 / 非法 JSON 原样返回', async () => {
    const { resolveSemanticToolName } = await import('../src/ui/tool-semantics');
    expect(resolveSemanticToolName('trace_impact', '{}')).toBe('trace_impact');
    expect(resolveSemanticToolName('fs', '{"filePath":"/a.ts"}')).toBe('fs');
    expect(resolveSemanticToolName('fs', '{not json')).toBe('fs');
    expect(resolveSemanticToolName('fs', undefined)).toBe('fs');
  });

  it('与 DOMAIN_SPECS 保持同步 — 每个 (domain, action) 都能解析', async () => {
    const { DOMAIN_SPECS } = await import('../src/agent/tools/domains');
    const { resolveSemanticToolName } = await import('../src/ui/tool-semantics');
    for (const spec of DOMAIN_SPECS) {
      for (const [action, oldName] of Object.entries(spec.actions)) {
        expect(resolveSemanticToolName(spec.name, `{"action":"${action}"}`), `${spec.name}(${action})`).toBe(oldName);
      }
    }
  });
});

describe('displayToolName — 领域调用显示名', () => {
  it('领域工具显示 domain(action)', async () => {
    const { displayToolName } = await import('../src/ui/tool-semantics');
    expect(displayToolName('fs', '{"action":"write"}')).toBe('fs(write)');
    expect(displayToolName('git', '{"action":"status"}')).toBe('git(status)');
  });

  it('非领域工具 / 无 action 显示原名', async () => {
    const { displayToolName } = await import('../src/ui/tool-semantics');
    expect(displayToolName('trace_impact', '{}')).toBe('trace_impact');
    expect(displayToolName('fs', '{}')).toBe('fs');
    expect(displayToolName('glob', undefined)).toBe('glob');
  });
});

// ═══════════════════════════════════════════════════════════════════
// formatToolResult — 领域工具结果的特殊渲染
// ═══════════════════════════════════════════════════════════════════

describe('formatToolResult — 领域工具结果特殊渲染', () => {
  it('fs(write) 走 diff 视图（含 filePath 头部）', async () => {
    const { formatToolResult } = await import('../src/ui/chat-utils');
    // write 结果无 old/new 参数 — 走兜底：显示 filePath 头部 + 代码块（body 需过短文本分支）
    const args = JSON.stringify({ action: 'write', filePath: '/tmp/a.ts', content: 'x\n'.repeat(30) });
    const r = formatToolResult('fs', 'file saved\n' + 'log line\n'.repeat(10), false, args);
    const html = r.kind === 'html' ? r.html : '';
    expect(html).toContain('diff-header');
    expect(html).toContain('/tmp/a.ts');
  });

  it('fs(edit) 带 old/new 参数走行级 diff', async () => {
    const { formatToolResult } = await import('../src/ui/chat-utils');
    const body = 'file edited\nsecond line to pass the short body check\n';
    const args = JSON.stringify({
      action: 'edit',
      filePath: '/tmp/a.ts',
      oldString: 'a\nb',
      newString: 'a\nX',
    });
    const r = formatToolResult('fs', body, false, args);
    const html = r.kind === 'html' ? r.html : '';
    expect(html).toContain('diff-lines');
    expect(html).toContain('diff-added');
    expect(html).toContain('diff-removed');
    expect(html).toContain('/tmp/a.ts');
  });

  it('shell(run) 走 bash 代码块', async () => {
    const { formatToolResult } = await import('../src/ui/chat-utils');
    const r = formatToolResult('shell', 'npm test\n\n PASS tests/unit\n', false, '{"action":"run"}');
    const html = r.kind === 'html' ? r.html : '';
    expect(html).toContain('language-bash');
  });

  it('search(content) 走代码块（非 markdown 误渲染）', async () => {
    const { formatToolResult } = await import('../src/ui/chat-utils');
    const r = formatToolResult('search', 'foo.ts:12: const x = 1\nbar.ts:34: const x = 2\n', false, '{"action":"content"}');
    const html = r.kind === 'html' ? r.html : '';
    expect(html).toContain('<pre><code>');
  });

  it('fs(glob) JSON 输出走紧凑列表（glob 分支位于 JSON 美化之前）', async () => {
    const { formatToolResult } = await import('../src/ui/chat-utils');
    const r = formatToolResult(
      'fs',
      JSON.stringify({ count: 1, results: [{ path: 'a.ts' }] }),
      false,
      '{"action":"glob"}',
    );
    const html = r.kind === 'html' ? r.html : '';
    expect(html).toContain('glob-summary');
    expect(html).toContain('a.ts');
    expect(html).toContain('1 个文件');
  });

  it('旧工具名行为不回归', async () => {
    const { formatToolResult } = await import('../src/ui/chat-utils');
    const shellR = formatToolResult('run_shell', 'out\n', false);
    expect(shellR.kind === 'html' ? shellR.html : '').toContain('language-bash');
    const editR = formatToolResult(
      'edit_file',
      'body\n',
      false,
      JSON.stringify({ file_path: '/a.ts', oldString: 'a', newString: 'b' }),
    );
    expect(editR.kind === 'html' ? editR.html : '').toContain('diff-lines');
  });
});

// ═══════════════════════════════════════════════════════════════════
// extractWritePreview — 领域工具流式写入预览
// ═══════════════════════════════════════════════════════════════════

describe('extractWritePreview — 领域工具流式预览', () => {
  it('fs(action=write) 从部分 JSON 提取 content', async () => {
    const { extractWritePreview } = await import('../src/provider/shared');
    const partial = '{"action":"write","filePath":"/a.ts","content":"hello\\nworld';
    const preview = extractWritePreview('fs', partial);
    expect(preview).toContain('hello');
    expect(preview).toContain('world');
  });

  it('fs(action=edit) 提取 newString', async () => {
    const { extractWritePreview } = await import('../src/provider/shared');
    const partial = '{"action":"edit","filePath":"/a.ts","newString":"replacement text';
    const preview = extractWritePreview('fs', partial);
    expect(preview).toBe('replacement text');
  });

  it('旧工具名行为不回归', async () => {
    const { extractWritePreview } = await import('../src/provider/shared');
    expect(extractWritePreview('write_file', '{"content":"data')).toBe('data');
    expect(extractWritePreview('edit_file', '{"newString":"x')).toBe('x');
    expect(extractWritePreview('run_shell', '{"command":"ls"}')).toBeNull();
    expect(extractWritePreview('fs', '{"action":"read"}')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// part-mutator — 领域工具流式输出语义（替换 vs 追加）
// ═══════════════════════════════════════════════════════════════════

describe('part-mutator — 领域工具 ToolProgress 语义', () => {
  let applyEventToParts: Awaited<ReturnType<typeof import('../src/ui/part-mutator')>>['applyEventToParts'];
  let AssistantPart: Awaited<ReturnType<typeof import('../src/ui/message-model')>>['AssistantPart'];
  let EventKind: Awaited<ReturnType<typeof import('../src/agent/agent-types')>>['EventKind'];

  beforeEach(async () => {
    const pm = await import('../src/ui/part-mutator');
    applyEventToParts = pm.applyEventToParts;
    const mm = await import('../src/ui/message-model');
    AssistantPart = mm.AssistantPart;
    const at = await import('../src/agent/agent-types');
    EventKind = at.EventKind;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fs(write) 的流式预览替换而非累积', () => {
    const parts: typeof AssistantPart[] = [];
    applyEventToParts(parts, {
      kind: EventKind.ToolDispatch,
      tool: { id: 't1', name: 'fs', args: '{"action":"write"', read_only: false, partial: true },
    });
    applyEventToParts(parts, {
      kind: EventKind.ToolProgress,
      tool: { id: 't1', name: 'fs', args: '{"action":"write"', output: 'line 1' },
    });
    applyEventToParts(parts, {
      kind: EventKind.ToolProgress,
      tool: { id: 't1', name: 'fs', args: '{"action":"write"', output: 'line 1\nline 2' },
    });
    const tp = parts[0];
    expect(tp.type).toBe('tool');
    if (tp.type === 'tool') expect(tp.output).toBe('line 1\nline 2');
  });

  it('shell(run) 的 stdout 增量追加', () => {
    const parts: typeof AssistantPart[] = [];
    applyEventToParts(parts, {
      kind: EventKind.ToolDispatch,
      tool: { id: 't2', name: 'shell', args: '{"action":"run"', read_only: false, partial: true },
    });
    applyEventToParts(parts, {
      kind: EventKind.ToolProgress,
      tool: { id: 't2', name: 'shell', args: '{"action":"run"', output: 'a' },
    });
    applyEventToParts(parts, {
      kind: EventKind.ToolProgress,
      tool: { id: 't2', name: 'shell', args: '{"action":"run"', output: 'b' },
    });
    const tp = parts[0];
    expect(tp.type).toBe('tool');
    if (tp.type === 'tool') expect(tp.output).toBe('ab');
  });
});
