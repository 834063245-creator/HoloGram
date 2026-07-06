// 守护时间轴面板 — refresh() 调用契约 + 渲染 + 错误处理。
// 任何改工具名/命令名的提交，这些测试直接挂 — 必须同步修。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock layer ──
const mockInvoke = vi.fn();
vi.mock('../src/bridge', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

const busOn = vi.fn();
vi.mock('../src/ui/events', () => ({
  bus: { emit: vi.fn(), on: (...args: any[]) => busOn(...args), off: vi.fn() },
}));

vi.mock('../src/ui/app-shell', () => ({
  shell: { notifyPanelChanged: vi.fn(), navigateToNode: vi.fn(), navigateToFile: vi.fn() },
}));

vi.mock('../src/ui/agent-visualizer', () => ({ askAgent: vi.fn() }));

vi.mock('../src/ui/file-viewer', () => ({ FileViewer: { get: () => ({ open: vi.fn() }) } }));

import { TimelinePanel } from '../src/ui/timeline';

function makeContainer(): HTMLElement {
  const div = document.createElement('div');
  document.body.appendChild(div);
  return div;
}

const MOCK_EVENTS = [
  { id: 1, timestamp: '2026-07-07T10:30:00Z', event_type: 'agent_edit', file: 'src/a.ts', summary: 'edit: changed a function' },
  { id: 2, timestamp: '2026-07-07T10:31:00Z', event_type: 'commit', file: 'src/a.ts', summary: 'commit: fix bug' },
];

/** Wait for refresh() promise chain to fully flush */
const flush = () => new Promise(r => setTimeout(r, 10));

describe('TimelinePanel — invoke contract', () => {
  let panel: TimelinePanel;
  let container: HTMLElement;

  beforeEach(() => {
    mockInvoke.mockReset();
    busOn.mockReset();
    document.body.innerHTML = '';
    container = makeContainer();
    panel = new TimelinePanel(container);
  });

  afterEach(() => {
    panel.destroy();
  });

  // ═══════════════════════════════════════════════════════
  // 核心契约: refresh() 走 hologram_call 统一分发
  // ═══════════════════════════════════════════════════════

  it('refresh() calls hologram_call with tool=project_timeline', async () => {
    mockInvoke.mockResolvedValue(JSON.stringify({ events: MOCK_EVENTS }));

    panel.setProjectPath('/fake/project');
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalled());

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [cmd, payload] = mockInvoke.mock.calls[0];
    expect(cmd).toBe('hologram_call');
    expect(payload).toEqual({ tool: 'project_timeline', args: { limit: 60 } });
  });

  it('parses JSON response and renders events', async () => {
    mockInvoke.mockResolvedValue(JSON.stringify({ events: MOCK_EVENTS }));

    panel.setProjectPath('/fake/project');
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    await flush();

    panel.toggle();
    const html = container.querySelector('.tl-content')!.innerHTML;
    expect(html).toContain('edit: changed a function');
    expect(html).toContain('commit: fix bug');
  });

  it('renders empty state when no events', async () => {
    mockInvoke.mockResolvedValue(JSON.stringify({ events: [] }));

    panel.setProjectPath('/fake/project');
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    await flush();

    panel.toggle();
    const html = container.querySelector('.tl-content')!.innerHTML;
    expect(html).toContain('暂无时间轴事件');
  });

  it('renders error state on invoke failure', async () => {
    // Open panel first so the catch block renders error HTML
    panel.toggle();
    mockInvoke.mockRejectedValue(new Error('Tauri IPC broken'));

    panel.setProjectPath('/fake/project');
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    await flush();

    const html = container.querySelector('.tl-content')!.innerHTML;
    expect(html).toContain('时间轴暂时不可用');
    expect(html).toContain('Tauri IPC broken');
  });

  it('guards against concurrent refresh while loading', async () => {
    let resolveInvoke: (v: string) => void;
    mockInvoke.mockReturnValue(new Promise(r => { resolveInvoke = r; }));

    panel.setProjectPath('/fake/project');
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));

    (panel as any).refresh();
    expect(mockInvoke).toHaveBeenCalledTimes(1); // skipped

    resolveInvoke!(JSON.stringify({ events: MOCK_EVENTS }));
  });

  // ═══════════════════════════════════════════════════════
  // 事件总线
  // ═══════════════════════════════════════════════════════

  it('registers timeline:refresh listener on setProjectPath', () => {
    panel.setProjectPath('/fake/project');
    expect(busOn).toHaveBeenCalledWith('timeline:refresh', expect.any(Function));
  });

  // ═══════════════════════════════════════════════════════
  // 渲染覆盖
  // ═══════════════════════════════════════════════════════

  it('all known event types render without fallback emoji', async () => {
    const allTypes = [
      'agent_write', 'agent_edit', 'agent_delete', 'agent_rename', 'agent_move',
      'file_changed', 'data_file_changed', 'commit',
      'blindspot_detected', 'user_action',
      'commit_violation', 'commit_clean', 'check',
      'analyze', 'incremental_update', 'incremental_fallback',
      'watcher_full_reanalyze',
    ];
    const events = allTypes.map((t, i) => ({
      id: i + 1,
      timestamp: `2026-07-07T10:${String(i).padStart(2, '0')}:00Z`,
      event_type: t,
      file: 'src/x.ts',
      summary: `${t} event`,
    }));

    mockInvoke.mockResolvedValue(JSON.stringify({ events }));
    panel.setProjectPath('/fake/project');
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    await flush();

    panel.toggle();
    const html = container.querySelector('.tl-content')!.innerHTML;
    expect(html).not.toContain('\u{1F4CC}'); // fallback emoji
  });
});
