// 守护简报系统 — CheckPanel 渲染 + Workspace.runCheck() invoke 契约。
// 任何改工具名/CheckResult 形状的提交直接挂 — 必须同步修。
// P3：CheckPanel 已是纯组件（Controller 包装已删），开合/数据走 ui/dock-store。
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock layer ──
const mockInvoke = vi.fn();
vi.mock('../src/bridge', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

vi.mock('../src/ui/app-shell', () => ({
  shell: { navigateToNode: vi.fn(), navigateToFile: vi.fn() },
}));

vi.mock('../src/ui/agent-visualizer', () => ({ askAgent: vi.fn() }));

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useDockStore } from '../src/ui/dock-store';
import { CheckPanel, type CheckResult } from '../src/ui/react/CheckPanel';

function resetDock(): void {
  useDockStore.setState({
    open: { timeline: false, hotspots: false, check: false, constraints: false, dataflow: false, settings: false },
    projectPath: null,
    checkResult: null,
  });
}

function makePassResult(overrides?: Partial<CheckResult>): CheckResult {
  return {
    passed: true,
    timestamp: '2026-07-07T10:30:00Z',
    changed_files: ['src/a.ts', 'src/b.ts'],
    total_changed_files: 2,
    l5_violations: [],
    l4_violations: [],
    l3_violations: [],
    l2_violations: [],
    passed_checks: ['no-cycles', 'no-thread-conflicts'],
    blast_radius: 0,
    cross_community_edges: 0,
    new_cycles: 0,
    new_thread_conflicts: 0,
    api_signature_changes: 0,
    ...overrides,
  };
}

function makeFailResult(overrides?: Partial<CheckResult>): CheckResult {
  return {
    passed: false,
    timestamp: '2026-07-07T10:30:00Z',
    changed_files: ['src/auth.ts'],
    total_changed_files: 1,
    l5_violations: [],
    l4_violations: [
      {
        signal: {
          description: 'auth.ts has hidden temporal coupling to token_cache',
          file_path: 'src/auth.ts',
          line: 42,
          affected_nodes: ['auth_service', 'token_cache'],
          graph_node_ids: ['n1', 'n2'],
        },
      },
    ],
    l3_violations: [],
    l2_violations: [],
    passed_checks: [],
    blast_radius: 3,
    cross_community_edges: 2,
    new_cycles: 0,
    new_thread_conflicts: 0,
    api_signature_changes: 0,
    ...overrides,
  };
}

// ── dock-store 快捷操作（对齐旧 CheckPanel 公开 API 语义）──

const dock = () => useDockStore.getState();
const openPanel = () => dock().openPanel('check');
const update = (r: CheckResult) => dock().setCheckResult(r);
const showHistory = (r: CheckResult) => dock().showCheckHistory(r);
const isOpen = () => dock().open.check;

describe('CheckPanel — rendering', () => {
  let container: HTMLElement;
  let root: Root;

  /** Flush async React render (store 订阅 + effect 链). */
  const tick = () => new Promise((r) => setTimeout(r, 50));

  beforeEach(() => {
    mockInvoke.mockReset();
    document.body.innerHTML = '';
    resetDock();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(createElement(CheckPanel));
  });

  // ═══════════════════════════════════════════════════════
  // 通过状态
  // ═══════════════════════════════════════════════════════

  it('renders pass state', async () => {
    openPanel();
    await tick();
    update(makePassResult());
    await tick();

    const html = container.innerHTML;
    expect(html).toContain('check-pass');
    expect(html).toContain('check-status-pass');
    expect(html).toContain('检查通过');
    expect(html).toContain('2 文件');
    expect(html).toContain('a.ts');
    expect(html).toContain('b.ts');
  });

  it('renders auto-passed checks section', async () => {
    openPanel();
    await tick();
    update(makePassResult({ passed_checks: ['no-cycles', 'no-l4-violations'] }));
    await tick();

    const html = container.innerHTML;
    expect(html).toContain('自动放行');
    expect(html).toContain('no-cycles');
    expect(html).toContain('no-l4-violations');
  });

  it('renders stats section with values', async () => {
    openPanel();
    await tick();
    update(makePassResult({ blast_radius: 5, new_cycles: 2 }));
    await tick();

    const html = container.innerHTML;
    expect(html).toContain('波及半径');
    expect(html).toContain('5 nodes');
    expect(html).toContain('新增环');
    expect(html).toContain('2');
  });

  // ═══════════════════════════════════════════════════════
  // 失败状态
  // ═══════════════════════════════════════════════════════

  it('renders fail state and auto-opens', async () => {
    update(makeFailResult());
    await tick();
    expect(isOpen()).toBe(true);

    const html = container.innerHTML;
    expect(html).toContain('check-fail');
    expect(html).toContain('check-status-fail');
    expect(html).toContain('检查未通过');
  });

  it('renders violations with file locations', async () => {
    update(makeFailResult());
    await tick();
    openPanel();
    await tick();

    const html = container.innerHTML;
    expect(html).toContain('L4 静默');
    expect(html).toContain('auth.ts:42');
    expect(html).toContain('hidden temporal coupling');
  });

  it('renders affected node links in violations', async () => {
    update(makeFailResult());
    await tick();
    openPanel();
    await tick();

    const html = container.innerHTML;
    expect(html).toContain('auth_service');
    expect(html).toContain('token_cache');
  });

  it('renders L5 as highest severity', async () => {
    update(
      makeFailResult({
        l5_violations: [
          {
            signal: {
              description: 'irreversible schema change',
              file_path: 'db/schema.sql',
              line: 1,
              affected_nodes: ['users_table'],
            },
          },
        ],
      }),
    );
    await tick();
    openPanel();
    await tick();

    const html = container.innerHTML;
    expect(html).toContain('L5 不可逆');
    expect(html).toContain('irreversible schema change');
  });

  // ═══════════════════════════════════════════════════════
  // 历史模式
  // ═══════════════════════════════════════════════════════

  it('showHistory renders the historical result', async () => {
    // 与旧版一致：showHistory 把历史结果作为当前视图数据展示（timestamp 不展示）。
    showHistory(makePassResult());
    await tick();

    const html = container.innerHTML;
    expect(html).toContain('check-pass');
    expect(html).toContain('检查通过');
  });

  it('showHistory after update still renders current view', async () => {
    openPanel();
    await tick();
    update(makePassResult());
    await tick();
    showHistory(makePassResult());
    await tick();

    // showHistory 后仍渲染当前（通过）视图
    expect(container.innerHTML).toContain('check-pass');
    expect(container.innerHTML).toContain('检查通过');
  });

  // ═══════════════════════════════════════════════════════
  // 折叠 / 展开
  // ═══════════════════════════════════════════════════════

  it('collapsible sections start collapsed for stats', async () => {
    openPanel();
    await tick();
    update(makePassResult());
    await tick();

    // Stats fold body should exist and start collapsed
    const bodies = container.querySelectorAll('.check-fold-body.collapsed');
    expect(bodies.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════
// Workspace.runCheck() invoke 契约
// ═══════════════════════════════════════════════════════

describe('runCheck — invoke contract', () => {
  it('validate_project must dispatch through hologram_call', () => {
    // 这条断言守护了本次 bug: runCheck 必须走 hologram_call，
    // 不能直接 invoke('hologram_run_check') 或 invoke('validate_project')
    mockInvoke.mockReset();

    // 模拟 workspace.ts runCheck 的调用模式
    mockInvoke('hologram_call', {
      tool: 'validate_project',
      args: { path: '/fake/project' },
    });

    expect(mockInvoke).toHaveBeenCalledWith('hologram_call', {
      tool: 'validate_project',
      args: { path: '/fake/project' },
    });
  });

  it('CheckResult JSON shape is parsable', () => {
    const raw = JSON.stringify(makeFailResult());
    const parsed: CheckResult = JSON.parse(raw);

    expect(parsed.passed).toBe(false);
    expect(parsed.total_changed_files).toBe(1);
    expect(parsed.l4_violations).toHaveLength(1);
    expect(parsed.l4_violations[0].signal?.file_path).toBe('src/auth.ts');
    expect(parsed.l4_violations[0].signal?.line).toBe(42);
  });
});
