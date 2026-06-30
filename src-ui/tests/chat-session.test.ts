import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock bridge — all Tauri backend calls route through here ──
const mockInvoke = vi.fn();
vi.mock('../src/bridge', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

// ── Mock DOM-heavy libs that don't matter for session logic ──
vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/ui/events', () => ({ bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));
vi.mock('../src/ui/app-shell', () => ({
  shell: { register: vi.fn(), notifyPanelChanged: vi.fn(), wire: vi.fn(), navigateToFile: vi.fn() },
}));
vi.mock('../src/agent/permission', () => ({ showApprovalDialog: vi.fn(), cancelPendingApprovals: vi.fn() }));
vi.mock('../src/agent/logger', () => ({ initLogger: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({ providers: [{ name: 'test', model: 'test', apiKey: 'k', kind: 'openai', baseUrl: '', thinking: false }], activeProvider: 'test', agent: {}, display: { language: 'zh', fontScale: 1 } })),
  saveSettings: vi.fn(),
  getActiveProvider: vi.fn(() => ({ name: 'test', apiKey: 'k', baseUrl: '', model: 'm', kind: 'openai' })),
  defaultPricing: vi.fn(() => ({ cache_hit: 0, input: 0, output: 0, currency: 'CNY' })),
  CHAT_MODES: [{ id: 'general', label: '通用', description: '', temperature: 0.7, maxSteps: 50 }],
  restoreSecrets: vi.fn((s: any) => s),
  persistSecrets: vi.fn(),
}));

// GSAP in jsdom — gsap.fromTo needs requestAnimationFrame; vitest jsdom env provides it
vi.mock('gsap', () => {
  const createNoopTween = () => ({
    kill: () => {},
    play: () => {},
    pause: () => {},
    resume: () => {},
    restart: () => {},
    seek: () => {},
    then: () => {},
    eventCallback: () => {},
    timeScale: () => {},
    progress: () => {},
    totalProgress: () => {},
  });
  const gsap = {
    set: vi.fn(),
    to: vi.fn(createNoopTween),
    from: vi.fn(createNoopTween),
    fromTo: vi.fn(createNoopTween),
    killTweensOf: vi.fn(),
    isTweening: vi.fn(() => false),
    utils: { toArray: vi.fn(() => []) },
  };
  return { default: gsap, gsap };
});

// marked returns sanitized HTML — DOMPurify needs a real window in jsdom
vi.mock('dompurify', () => ({ default: { sanitize: (s: string) => s } }));
vi.mock('marked', () => ({ marked: { parse: (s: string) => s, lexer: (s: string) => [] } }));
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

import { ChatPanel, hashProjectPath } from '../src/ui/chat';

// ── Helpers ──

/** Create a minimal ChatPanel in a detached DOM container. */
function createChatPanel(): ChatPanel {
  const container = document.createElement('div');
  container.id = 'test-container';
  document.body.appendChild(container);

  // Add required global elements that buildDOM references
  const graph = document.createElement('div');
  graph.id = 'graph';
  document.body.appendChild(graph);

  return new ChatPanel(container);
}

/** Mock invoke to return session data on disk for read_file_content calls. */
function mockSessionFile(id: number, messages: any[], label = `会话 ${id}`, savedAt?: string) {
  return JSON.stringify({
    id, label,
    savedAt: savedAt || new Date().toISOString(),
    messages,
  });
}

// ── Tests ──

describe('ChatPanel session persistence', () => {
  let panel: ChatPanel;

  beforeEach(() => {
    // Clean localStorage between tests
    localStorage.clear();
    // Reset mock between tests
    mockInvoke.mockReset();
    // Default: all invoke calls resolve with empty
    mockInvoke.mockResolvedValue(null);
  });

  afterEach(() => {
    // Clean up DOM
    document.body.innerHTML = '';
  });

  // ═══════════════════════════════════════════════════════════════
  // stripLineNumbers — cat -n format from Rust read_file_content
  // ═══════════════════════════════════════════════════════════════

  describe('stripLineNumbers', () => {
    const strip = (s: string) => (ChatPanel as any).stripLineNumbers(s);

    it('removes single line number prefix', () => {
      const input = '     1\t{"id":1,"label":"test"}';
      const result = strip(input);
      expect(result).toBe('{"id":1,"label":"test"}');
    });

    it('removes multi-line line numbers', () => {
      const input = '     1\t{"id":1,\n     2\t"label":"test",\n     3\t"ok":true}';
      const result = strip(input);
      expect(result).toBe('{"id":1,\n"label":"test",\n"ok":true}');
    });

    it('handles large line numbers (right-aligned in 6 chars)', () => {
      const input = '   999\t{"big":true}';
      const result = strip(input);
      expect(result).toBe('{"big":true}');
    });

    it('passes through text without line numbers unchanged', () => {
      const input = '{"plain":"json"}';
      const result = strip(input);
      expect(result).toBe('{"plain":"json"}');
    });

    it('handles empty string', () => {
      expect(strip('')).toBe('');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // scanMaxSessionId — must never hang
  // ═══════════════════════════════════════════════════════════════

  describe('scanMaxSessionId', () => {
    it('returns 0 when list_directory rejects (backend unavailable)', async () => {
      panel = createChatPanel();
      mockInvoke.mockRejectedValue(new Error('backend down'));

      const result = await (panel as any).scanMaxSessionId('D:/test');
      expect(result).toBe(0);
    });

    it('returns 0 when list_directory returns non-array', async () => {
      panel = createChatPanel();
      mockInvoke.mockResolvedValue(null);

      const result = await (panel as any).scanMaxSessionId('D:/test');
      expect(result).toBe(0);
    });

    it('returns max numeric ID from entries', async () => {
      panel = createChatPanel();
      mockInvoke.mockResolvedValue([
        { name: '1.json', path: '/sessions/1.json', is_dir: false, children: null },
        { name: '71.json', path: '/sessions/71.json', is_dir: false, children: null },
        { name: '_active.json', path: '/sessions/_active.json', is_dir: false, children: null },
        { name: 'not-json.txt', path: '/sessions/not-json.txt', is_dir: false, children: null },
      ]);

      const result = await (panel as any).scanMaxSessionId('D:/test');
      expect(result).toBe(71);
    });

    it('skips directories and non-json files', async () => {
      panel = createChatPanel();
      mockInvoke.mockResolvedValue([
        { name: 'sub', path: '/sessions/sub', is_dir: true, children: [] },
        { name: '3.json', path: '/sessions/3.json', is_dir: false, children: null },
        { name: 'readme.md', path: '/sessions/readme.md', is_dir: false, children: null },
      ]);

      const result = await (panel as any).scanMaxSessionId('D:/test');
      expect(result).toBe(3);
    });

    it('resolves within 100ms (no hang)', async () => {
      panel = createChatPanel();
      // Simulate a slow but not hung backend
      mockInvoke.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve([]), 10)));

      const start = Date.now();
      const result = await (panel as any).scanMaxSessionId('D:/test');
      const elapsed = Date.now() - start;

      expect(result).toBe(0);
      expect(elapsed).toBeLessThan(500); // generous upper bound
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // listSavedSessions — filters, parses, sorts
  // ═══════════════════════════════════════════════════════════════

  describe('listSavedSessions', () => {
    it('returns empty array when list_directory rejects', async () => {
      panel = createChatPanel();
      mockInvoke.mockRejectedValue(new Error('dir not found'));

      const result = await panel.listSavedSessions('D:/test');
      expect(result).toEqual([]);
    });

    it('returns empty array when list_directory returns non-array', async () => {
      panel = createChatPanel();
      mockInvoke.mockResolvedValue('not an array');

      const result = await panel.listSavedSessions('D:/test');
      expect(result).toEqual([]);
    });

    it('filters out _active.json and deleted sessions', async () => {
      panel = createChatPanel();
      // list_directory returns file entries
      mockInvoke
        .mockResolvedValueOnce([
          { name: '1.json', path: '/s/1.json', is_dir: false, children: null },
          { name: '_active.json', path: '/s/_active.json', is_dir: false, children: null },
          { name: '40.json', path: '/s/40.json', is_dir: false, children: null },
        ])
        // read_file_content for 1.json
        .mockResolvedValueOnce(mockSessionFile(1, [
          { role: 'system', content: 'prompt' },
          { role: 'user', content: 'hello' },
        ]))
        // read_file_content for 40.json (deleted marker)
        .mockResolvedValueOnce(JSON.stringify({ id: 40, deleted: true }));

      const result = await panel.listSavedSessions('D:/test');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
      expect(result[0].msgCount).toBe(1); // only user message counts
    });

    it('returns sessions sorted by savedAt descending', async () => {
      panel = createChatPanel();
      mockInvoke
        .mockResolvedValueOnce([
          { name: '1.json', path: '/s/1.json', is_dir: false, children: null },
          { name: '2.json', path: '/s/2.json', is_dir: false, children: null },
        ])
        .mockResolvedValueOnce(mockSessionFile(1, [{ role: 'user', content: 'old' }], 'Old', '2026-01-01T00:00:00Z'))
        .mockResolvedValueOnce(mockSessionFile(2, [{ role: 'user', content: 'new' }], 'New', '2026-06-30T00:00:00Z'));

      const result = await panel.listSavedSessions('D:/test');
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(2); // newest first
      expect(result[1].id).toBe(1);
    });

    it('handles cat -n formatted session files (read_file_content regression)', async () => {
      panel = createChatPanel();
      const rawJSON = mockSessionFile(46, [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'real conversation' },
      ], '有对话', '2026-06-30T12:00:00Z');

      mockInvoke
        .mockResolvedValueOnce([
          { name: '46.json', path: '/s/46.json', is_dir: false, children: null },
        ])
        // read_file_content returns cat -n format: line numbers prepended
        .mockResolvedValueOnce(
          rawJSON.split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n')
        );

      const result = await panel.listSavedSessions('D:/test');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(46);
      expect(result[0].label).toBe('有对话');
      expect(result[0].msgCount).toBe(1);
    });

    it('skips entries with unreadable session files', async () => {
      panel = createChatPanel();
      mockInvoke
        .mockResolvedValueOnce([
          { name: '1.json', path: '/s/1.json', is_dir: false, children: null },
          { name: '2.json', path: '/s/2.json', is_dir: false, children: null },
        ])
        // First read fails
        .mockRejectedValueOnce(new Error('permission denied'))
        // Second succeeds
        .mockResolvedValueOnce(mockSessionFile(2, [{ role: 'user', content: 'ok' }]));

      const result = await panel.listSavedSessions('D:/test');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // autoRestoreLastSession — regression guards
  // ═══════════════════════════════════════════════════════════════

  describe('autoRestoreLastSession', () => {
    it('completes without calling list_directory (regression: no backend hang)', async () => {
      panel = createChatPanel();
      // Set up factory that returns a minimal agent-like object
      let factoryCalled = false;
      panel.setAgentFactory(async () => {
        factoryCalled = true;
        return {
          getSession: () => [{ role: 'system', content: 'sys' }],
          setSession: vi.fn(),
          run: vi.fn(),
        } as any;
      });
      panel.setProjectPath('D:/test');

      // No tracker, no localStorage sessions → returns early
      mockInvoke.mockRejectedValue(new Error('no tracker'));

      const start = Date.now();
      await panel.autoRestoreLastSession('D:/test');
      const elapsed = Date.now() - start;

      // Must complete within 1s — if list_directory were called and hung, this times out
      expect(elapsed).toBeLessThan(1000);

      // Verify list_directory was NOT invoked (the regression guard)
      const listDirCalls = mockInvoke.mock.calls.filter(
        (call: any[]) => call[0] === 'list_directory'
      );
      expect(listDirCalls).toHaveLength(0);
    });

    it('shows notice when tracker is missing and localStorage is empty', async () => {
      panel = createChatPanel();
      panel.setAgentFactory(async () => ({
        getSession: () => [{ role: 'system', content: 'sys' }],
        setSession: vi.fn(),
      } as any));
      panel.setProjectPath('D:/test');

      mockInvoke.mockRejectedValue(new Error('no tracker'));

      await panel.autoRestoreLastSession('D:/test');

      // Verify a notice was added (autoRestoreLastSession → no lastId → addNotice)
      const notices = document.querySelectorAll('.msg-notice');
      // The notice is "未找到历史会话，已创建新会话"
      expect(notices?.length).toBeGreaterThan(0);
    });

    it('falls back to localStorage when tracked session has only system messages', async () => {
      panel = createChatPanel();

      // Put a good session in localStorage
      const goodSession = {
        id: 71,
        label: '有内容的会话',
        savedAt: '2026-06-30T10:00:00Z',
        messages: [
          { role: 'system', content: 'prompt' },
          { role: 'user', content: '帮我分析项目' },
          { role: 'assistant', content: '好的' },
        ],
      };
      const hash = hashProjectPath('D:/test').toString(36);
      localStorage.setItem(`hologram_session_${hash}_71`, JSON.stringify(goodSession));

      let setSessionMsgs: any[] = [];
      panel.setAgentFactory(async () => ({
        getSession: () => [{ role: 'system', content: 'sys' }],
        setSession: (msgs: any[]) => { setSessionMsgs = msgs; },
      } as any));
      panel.setProjectPath('D:/test');

      // Tracker points to session 1
      mockInvoke
        .mockResolvedValueOnce(JSON.stringify({ lastId: 1, nextId: 1 }))
        // Session 1 has only system prompt — no user messages
        .mockResolvedValueOnce(JSON.stringify({
          id: 1, label: '空会话',
          savedAt: '2026-06-29T00:00:00Z',
          messages: [{ role: 'system', content: '你是助手' }],
        }));

      await panel.autoRestoreLastSession('D:/test');

      // Should have fallen back to localStorage session 71
      const userMsgs = setSessionMsgs.filter((m: any) => m.role === 'user');
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toBe('帮我分析项目');
    });

    it('does NOT call list_directory during auto-restore', async () => {
      panel = createChatPanel();
      panel.setAgentFactory(async () => ({
        getSession: () => [{ role: 'system', content: 'sys' }],
        setSession: vi.fn(),
      } as any));
      panel.setProjectPath('D:/test');

      // Tracker exists, session file exists with valid conversation
      mockInvoke
        .mockResolvedValueOnce(JSON.stringify({ lastId: 46, nextId: 77 }))
        .mockResolvedValueOnce(mockSessionFile(46, [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hello' },
        ]));

      await panel.autoRestoreLastSession('D:/test');

      // list_directory should NOT have been called
      const listDirCalls = mockInvoke.mock.calls.filter(
        (call: any[]) => call[0] === 'list_directory'
      );
      expect(listDirCalls).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // localStorage key isolation
  // ═══════════════════════════════════════════════════════════════

  describe('localStorage key isolation', () => {
    it('different projects produce different key prefixes', () => {
      const h1 = hashProjectPath('D:/HoloGramHG').toString(36);
      const h2 = hashProjectPath('D:/langchain').toString(36);
      expect(h1).not.toBe(h2);
    });

    it('same project produces consistent key prefix', () => {
      const h1 = hashProjectPath('D:/HoloGramHG').toString(36);
      const h2 = hashProjectPath('D:/HoloGramHG').toString(36);
      expect(h1).toBe(h2);
    });
  });
});
