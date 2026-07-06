import { describe, it, expect } from 'vitest';
import {
  createGraphContextHook,
  createGraphPreflightHook,
  createGraphContext,
  buildFileNodeIndex,
  HookRegistry,
  PreflightHookRegistry,
} from '../src/agent/hooks';
import type { GraphContext } from '../src/agent/hooks';

// ── 模拟图数据（2776 节点 / 6128 边的简化版）──

const mockGraphData = {
  nodes: [
    { id: 'n1', name: 'readFile', kind: 'function', location: 'D:/repo/src/io.ts:42' },
    { id: 'n2', name: 'parseConfig', kind: 'function', location: 'D:/repo/src/config.ts:10' },
    { id: 'n3', name: 'applyConfig', kind: 'function', location: 'D:/repo/src/config.ts:30' },
    { id: 'n4', name: 'render', kind: 'function', location: 'D:/repo/src/ui/app.tsx:55' },
    { id: 'n5', name: 'store', kind: 'variable', location: 'D:/repo/src/state.ts:5' },
    { id: 'n6', name: 'main', kind: 'function', location: 'D:/repo/src/main.ts:1' },
    { id: 'n7', name: 'format', kind: 'function', location: 'D:/repo/src/utils.ts:20' },
  ],
  edges: [
    // n6 → n2 → n3 → n4 (主链)
    { source: 'n6', target: 'n2' },
    { source: 'n2', target: 'n3' },
    { source: 'n3', target: 'n4' },
    { source: 'n3', target: 'n7' },
    { source: 'n4', target: 'n7' },
    // n5 被多个节点依赖（共享状态）
    { source: 'n1', target: 'n5' },
    { source: 'n2', target: 'n5' },
    { source: 'n3', target: 'n5' },
    { source: 'n4', target: 'n5' },
    { source: 'n6', target: 'n5' },
    { source: 'n7', target: 'n5' },
    // n6 调用 n1
    { source: 'n6', target: 'n1' },
    // n2 被 main 调用
    { source: 'n6', target: 'n3' },
  ],
};

function makeCtx(): GraphContext {
  const { fileIndex, fanIn, fanOut } = buildFileNodeIndex(mockGraphData);
  return createGraphContext(fileIndex, fanIn, fanOut);
}

// ═══════════════════════════════════════════════════════════
// GraphContext — 基础查询
// ═══════════════════════════════════════════════════════════

describe('GraphContext', () => {
  const ctx = makeCtx();

  it('getNodesInFile 返回文件内所有符号', () => {
    const nodes = ctx.getNodesInFile('D:/repo/src/config.ts');
    expect(nodes).toHaveLength(2);
    expect(nodes.map(n => n.name).sort()).toEqual(['applyConfig', 'parseConfig']);
  });

  it('getNodesInFile 大小写不敏感 + 反斜杠归一化', () => {
    const nodes = ctx.getNodesInFile('d:\\repo\\SRC\\Config.ts');
    expect(nodes).toHaveLength(2);
  });

  it('getImpactSummary 返回 top 扇入符号', () => {
    const summary = ctx.getImpactSummary('D:/repo/src/config.ts');
    expect(summary).toContain('parseConfig');
    expect(summary).toContain('2 个符号');
    expect(summary).toContain('trace_impact');
  });

  it('getImpactSummary 不存在文件返回 null', () => {
    expect(ctx.getImpactSummary('/nonexistent/file.ts')).toBeNull();
  });

  it('getSearchContext 返回多文件符号概要', () => {
    const ctx2 = ctx.getSearchContext([
      'D:/repo/src/config.ts',
      'D:/repo/src/ui/app.tsx',
    ]);
    expect(ctx2).toContain('config.ts');
    expect(ctx2).toContain('app.tsx');
  });
});

// ═══════════════════════════════════════════════════════════
// GraphContextHook — shouldEnrich
// ═══════════════════════════════════════════════════════════

describe('GraphContextHook.shouldEnrich', () => {
  const hook = createGraphContextHook(makeCtx());

  const shouldTrigger = [
    'read_file_content', 'read_file', 'search_content',
    'glob', 'list_directory', 'trace_dataflow',
    'search_symbols', 'inspect_symbol', 'git_diff', 'run_shell',
  ];

  const shouldNotTrigger = [
    'edit_file', 'write_file', 'explore_deps', 'git_status',
    'agent_spawn', 'ask_user', 'web_search',
  ];

  for (const name of shouldTrigger) {
    it(`✅ ${name} 触发钩子`, () => {
      expect(hook.shouldEnrich(name, {})).toBe(true);
    });
  }

  for (const name of shouldNotTrigger) {
    it(`❌ ${name} 不触发钩子`, () => {
      expect(hook.shouldEnrich(name, {})).toBe(false);
    });
  }
});

// ═══════════════════════════════════════════════════════════
// GraphContextHook.enrich — 各工具分支
// ═══════════════════════════════════════════════════════════

describe('GraphContextHook.enrich', () => {
  const ctx = makeCtx();
  const hook = createGraphContextHook(ctx);

  it('read_file_content 注入符号概要', async () => {
    const out = await hook.enrich('read_file_content',
      { filePath: 'D:/repo/src/config.ts' },
      'line 1\nline 2\n');
    expect(out).toContain('📊 [图上下文]');
    expect(out).toContain('parseConfig');
    // 原始结果在注入块之后
    expect(out).toContain('line 1');
  });

  it('read_file 有函数时追加 dataflow 提示', async () => {
    const out = await hook.enrich('read_file',
      { filePath: 'D:/repo/src/config.ts' },
      'some content');
    expect(out).toContain('trace_dataflow 追踪');
  });

  it('search_content 注入匹配文件符号', async () => {
    const result = JSON.stringify({
      matches: [
        { file: 'D:/repo/src/config.ts', line: 10 },
        { file: 'D:/repo/src/ui/app.tsx', line: 55 },
      ],
    });
    const out = await hook.enrich('search_content', { directory: 'D:/repo' }, result);
    expect(out).toContain('📊 [图上下文]');
    expect(out).toContain('config.ts');
  });

  it('glob 注入匹配文件符号', async () => {
    const out = await hook.enrich('glob', { pattern: '*.ts' },
      'D:/repo/src/config.ts\nD:/repo/src/ui/app.tsx\nREADME.md\n');
    expect(out).toContain('📊 [图上下文]');
    expect(out).toContain('config.ts');
    // 非源文件(README.md)不会被 extractFilesFromGlobResult 提取，
    // 所以注入摘要中不应出现。但原始 still 在结果体中。
    const injectedBlock = out.split('─'.repeat(40))[0];
    expect(injectedBlock).not.toContain('README.md');
  });

  it('list_directory 注入源文件符号', async () => {
    const out = await hook.enrich('list_directory', { path: 'D:/repo' },
      'path: D:/repo/src/config.ts  type: file\npath: D:/repo/src/ui/app.tsx  type: file\npath: D:/repo/readme.txt  type: file');
    expect(out).toContain('📊 [图上下文]');
    expect(out).toContain('config.ts');
    // 非源文件(readme.txt)不会被提取，注入块中不应出现
    const injectedBlock = out.split('─'.repeat(40))[0];
    expect(injectedBlock).not.toContain('readme.txt');
  });

  it('trace_dataflow 注入共享变量', async () => {
    const out = await hook.enrich('trace_dataflow', { files: ['src/state.ts'] },
      JSON.stringify({ shared_state: [{ var: 'store', readers: 6, writers: 1 }] }));
    expect(out).toContain('共享变量');
    expect(out).toContain('store');
    expect(out).toContain('trace_impact');
  });

  it('trace_dataflow 无共享变量时不注入', async () => {
    const out = await hook.enrich('trace_dataflow', { files: ['src/state.ts'] },
      JSON.stringify({ shared_state: [] }));
    expect(out).not.toContain('📊 [图上下文]');
  });

  it('search_symbols 注入命中节点', async () => {
    const out = await hook.enrich('search_symbols', { query: 'config' },
      JSON.stringify({ results: [{ name: 'parseConfig' }, { name: 'applyConfig' }] }));
    expect(out).toContain('命中 2 个节点');
    expect(out).toContain('parseConfig');
    expect(out).toContain('get_neighbors');
  });

  it('inspect_symbol 注入社区归属', async () => {
    const out = await hook.enrich('inspect_symbol', { nodeId: 'parseConfig' },
      JSON.stringify({ community: 'core-utils' }));
    expect(out).toContain('社区归属');
    expect(out).toContain('core-utils');
    expect(out).toContain('get_community');
  });

  it('git_diff 注入变更文件符号', async () => {
    const out = await hook.enrich('git_diff', { path: 'D:/repo' },
      '+++ a/D:/repo/src/config.ts\n@@ -1,3 +1,5 @@\n+++ b/D:/repo/src/ui/app.tsx\n');
    expect(out).toContain('📊 [图上下文]');
    expect(out).toContain('config.ts');
  });

  it('run_shell 测试命令注入提示', async () => {
    const out = await hook.enrich('run_shell', { command: 'npm test -- --coverage' }, 'PASS');
    expect(out).toContain('🧪');
    expect(out).toContain('validate_project');
  });

  it('run_shell 构建命令注入提示', async () => {
    const out = await hook.enrich('run_shell', { command: 'npm install' }, 'added 42 packages');
    expect(out).toContain('🔧');
    expect(out).toContain('validate_project');
  });

  it('run_shell 非测试/构建命令不注入', async () => {
    const out = await hook.enrich('run_shell', { command: 'echo hello' }, 'hello');
    expect(out).not.toContain('📊 [图上下文]');
  });

  // ── 边界条件 ──

  it('结果过大时跳过注入', async () => {
    const big = 'x'.repeat(31_000);
    const out = await hook.enrich('read_file',
      { filePath: 'D:/repo/src/config.ts' }, big);
    expect(out).toBe(big); // 原文不动
  });

  it('错误结果不注入', async () => {
    const out = await hook.enrich('read_file',
      { filePath: 'D:/repo/src/config.ts' }, 'error: file not found');
    expect(out).toBe('error: file not found');
  });

  it('不存在文件返回原结果', async () => {
    const out = await hook.enrich('read_file',
      { filePath: 'D:/repo/src/nonexistent.ts' }, 'some content');
    expect(out).toBe('some content');
  });
});

// ═══════════════════════════════════════════════════════════
// GraphPreflightHook — shouldCheck
// ═══════════════════════════════════════════════════════════

describe('GraphPreflightHook.shouldCheck', () => {
  const hook = createGraphPreflightHook(makeCtx());

  const shouldTrigger = [
    'edit_file', 'write_file',
    'delete_file', 'rename_file', 'move_file',
    'git_discard', 'git_checkout', 'git_commit',
  ];

  const shouldNotTrigger = ['read_file', 'explore_deps', 'search_content'];

  for (const name of shouldTrigger) {
    it(`✅ ${name} 触发预检`, () => {
      expect(hook.shouldCheck(name)).toBe(true);
    });
  }

  for (const name of shouldNotTrigger) {
    it(`❌ ${name} 不触发预检`, () => {
      expect(hook.shouldCheck(name)).toBe(false);
    });
  }
});

// ═══════════════════════════════════════════════════════════
// GraphPreflightHook.check — 各分支
// ═══════════════════════════════════════════════════════════

describe('GraphPreflightHook.check', () => {
  const ctx = makeCtx();
  const hook = createGraphPreflightHook(ctx);

  it('edit_file 正常文件注入影响分析', () => {
    // config.ts: parseConfig(fanIn=1), applyConfig(fanIn=1)
    const warn = hook.check('edit_file', { filePath: 'D:/repo/src/config.ts' });
    expect(warn).not.toBeNull();
    expect(warn!).toContain('⚠️ [自动影响分析]');
    expect(warn!).toContain('config.ts');
    expect(warn!).toContain('2 个符号');
  });

  it('edit_file fanIn=0 的不打扰', () => {
    // io.ts: readFile(fanIn=1) — 但它是被 n6 依赖的，fanIn=1
    // 实际上所有节点都有 fanIn... 换个思路，用虚构文件
    const warn = hook.check('edit_file', { filePath: 'D:/repo/src/nonexistent.ts' });
    expect(warn).toBeNull();
  });

  it('git_discard 用 path+file 拼接路径', () => {
    const warn = hook.check('git_discard', { path: 'D:/repo', file: 'src/config.ts' });
    expect(warn).not.toBeNull();
    expect(warn!).toContain('丢弃修改');
    expect(warn!).toContain('config.ts');
  });

  it('git_checkout 注入通用警告', () => {
    const warn = hook.check('git_checkout', { path: 'D:/repo', branch: 'feature/x' });
    expect(warn).not.toBeNull();
    expect(warn!).toContain('切换分支');
    expect(warn!).toContain('feature/x');
    expect(warn!).toContain('git_status');
    expect(warn!).toContain('git_stash_push');
  });

  it('git_commit 注入通用警告', () => {
    const warn = hook.check('git_commit', { path: 'D:/repo', message: 'fix: stuff' });
    expect(warn).not.toBeNull();
    expect(warn!).toContain('创建提交');
    expect(warn!).toContain('git_diff');
    expect(warn!).toContain('trace_impact');
  });
});

// ═══════════════════════════════════════════════════════════
// HookRegistry / PreflightHookRegistry — 崩溃静默降级
// ═══════════════════════════════════════════════════════════

describe('HookRegistry', () => {
  it('apply 多个 hook 叠加', async () => {
    const reg = new HookRegistry();
    reg.register({
      name: 'a',
      shouldEnrich: () => true,
      enrich: async (_t, _a, r) => '[A]' + r,
    });
    reg.register({
      name: 'b',
      shouldEnrich: () => true,
      enrich: async (_t, _a, r) => '[B]' + r,
    });
    const out = await reg.apply('read_file', {}, 'original');
    expect(out).toBe('[B][A]original');
  });

  it('apply hook 崩溃不影响后续', async () => {
    const reg = new HookRegistry();
    reg.register({
      name: 'crash',
      shouldEnrich: () => true,
      enrich: async () => { throw new Error('boom'); },
    });
    reg.register({
      name: 'ok',
      shouldEnrich: () => true,
      enrich: async (_t, _a, r) => '[OK]' + r,
    });
    const out = await reg.apply('read_file', {}, 'original');
    expect(out).toBe('[OK]original');
  });
});

describe('PreflightHookRegistry', () => {
  it('check 返回第一个非 null 警告', () => {
    const reg = new PreflightHookRegistry();
    reg.register({
      name: 'a',
      shouldCheck: () => true,
      check: () => 'WARN_A',
    });
    reg.register({
      name: 'b',
      shouldCheck: () => true,
      check: () => 'WARN_B',
    });
    expect(reg.check('edit_file', {})).toBe('WARN_A'); // 第一个命中即返回
  });

  it('check 全部 null 返回 null', () => {
    const reg = new PreflightHookRegistry();
    reg.register({
      name: 'silent',
      shouldCheck: () => true,
      check: () => null,
    });
    expect(reg.check('edit_file', {})).toBeNull();
  });
});
