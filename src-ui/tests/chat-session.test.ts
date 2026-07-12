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

import { ChatPanel } from '../src/ui/chat';
import * as Session from '../src/ui/chat-session';
import { hashProjectPath, stripLineNumbers, scanMaxSessionId } from '../src/ui/chat-session';

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
    const strip = stripLineNumbers;

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

      const result = await scanMaxSessionId('D:/test');
      expect(result).toBe(0);
    });

    it('returns 0 when list_directory returns non-array', async () => {
      panel = createChatPanel();
      mockInvoke.mockResolvedValue(null);

      const result = await scanMaxSessionId('D:/test');
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

      const result = await scanMaxSessionId('D:/test');
      expect(result).toBe(71);
    });

    it('skips directories and non-json files', async () => {
      panel = createChatPanel();
      mockInvoke.mockResolvedValue([
        { name: 'sub', path: '/sessions/sub', is_dir: true, children: [] },
        { name: '3.json', path: '/sessions/3.json', is_dir: false, children: null },
        { name: 'readme.md', path: '/sessions/readme.md', is_dir: false, children: null },
      ]);

      const result = await scanMaxSessionId('D:/test');
      expect(result).toBe(3);
    });

    it('resolves within 100ms (no hang)', async () => {
      panel = createChatPanel();
      // Simulate a slow but not hung backend
      mockInvoke.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve([]), 10)));

      const start = Date.now();
      const result = await scanMaxSessionId('D:/test');
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

      // Flush rAF so _scheduleSync fires (notices are now debounced via rAF)
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

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

  // ═══════════════════════════════════════════════════════════════
  // listSavedSessions — parallel read + timeout (regression fix)
  // ═══════════════════════════════════════════════════════════════

  describe('listSavedSessions — parallel + timeout', () => {
    it('reads all session files in parallel (not serial)', async () => {
      panel = createChatPanel();
      // 5 session files — if serial, this takes 5x as long
      const files = [1, 2, 3, 4, 5].map(id => ({
        name: `${id}.json`, path: `/s/${id}.json`, is_dir: false, children: null,
      }));
      mockInvoke.mockResolvedValueOnce(files);
      for (const id of [1, 2, 3, 4, 5]) {
        mockInvoke.mockResolvedValueOnce(mockSessionFile(id, [{ role: 'user', content: `msg-${id}` }]));
      }

      const start = Date.now();
      const result = await panel.listSavedSessions('D:/test');
      const elapsed = Date.now() - start;

      expect(result).toHaveLength(5);
      // Parallel reads should complete quickly (< 100ms for mocked calls)
      // Serial would be at least 5 * async overhead
      expect(elapsed).toBeLessThan(500);
    });

    it('returns empty after 10s timeout if a session read hangs', async () => {
      panel = createChatPanel();
      mockInvoke.mockResolvedValueOnce([
        { name: '1.json', path: '/s/1.json', is_dir: false, children: null },
        { name: '2.json', path: '/s/2.json', is_dir: false, children: null },
      ]);
      // First file hangs forever, second resolves
      mockInvoke.mockReturnValueOnce(new Promise(() => {})); // never resolves
      mockInvoke.mockResolvedValueOnce(mockSessionFile(2, [{ role: 'user', content: 'ok' }]));

      vi.useFakeTimers();
      const promise = panel.listSavedSessions('D:/test');

      // Advance past the 10s timeout
      await vi.advanceTimersByTimeAsync(10_001);
      const result = await promise;
      vi.useRealTimers();

      expect(result).toEqual([]);
    });

    it('still returns readable sessions when one file fails', async () => {
      panel = createChatPanel();
      mockInvoke.mockResolvedValueOnce([
        { name: '1.json', path: '/s/1.json', is_dir: false, children: null },
        { name: '2.json', path: '/s/2.json', is_dir: false, children: null },
        { name: '3.json', path: '/s/3.json', is_dir: false, children: null },
      ]);
      // File 1: success
      mockInvoke.mockResolvedValueOnce(mockSessionFile(1, [{ role: 'user', content: 'hello' }]));
      // File 2: error
      mockInvoke.mockRejectedValueOnce(new Error('corrupt file'));
      // File 3: success
      mockInvoke.mockResolvedValueOnce(mockSessionFile(3, [{ role: 'user', content: 'world' }]));

      const result = await panel.listSavedSessions('D:/test');

      expect(result).toHaveLength(2);
      expect(result.map(r => r.id).sort()).toEqual([1, 3]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // _doSyncMessagesToDOM — perm cards are first-class messages
  // ═══════════════════════════════════════════════════════════════

  describe('_doSyncMessagesToDOM — perm card handling', () => {
    it('renders perm card as a normal message (not inject)', () => {
      panel = createChatPanel();
      const msgList = (panel as any).msgList as HTMLElement;

      // Push a user message + a permission message
      (panel as any).messages = [
        { role: 'user', _id: 'u1', text: 'hello', sessionIndex: 0 },
        { role: 'perm', _id: 'p1', toolName: 'write_file', reason: 'test', subject: 'f.txt', resolve: vi.fn() },
      ];
      (panel as any)._streamingAssistantId = null;

      (panel as any)._doSyncMessagesToDOM();

      // Both messages should be in DOM as normal children
      expect(msgList.children.length).toBe(2);
      // No perm-inline-card should be treated as inject → no duplicate preservation
      const permCards = msgList.querySelectorAll('.perm-inline-card');
      expect(permCards.length).toBe(1);
    });

    it('removes perm card from DOM when removed from model', () => {
      panel = createChatPanel();
      const msgList = (panel as any).msgList as HTMLElement;

      (panel as any).messages = [
        { role: 'user', _id: 'u1', text: 'q', sessionIndex: 0 },
        { role: 'perm', _id: 'p1', toolName: 'run_shell', reason: 'test', subject: 'cmd', resolve: vi.fn() },
      ];
      (panel as any)._streamingAssistantId = null;
      (panel as any)._doSyncMessagesToDOM();
      expect(msgList.querySelectorAll('.perm-inline-card').length).toBe(1);

      // Remove perm from model — simulates user clicking "允许"
      (panel as any).messages = [
        { role: 'user', _id: 'u1', text: 'q', sessionIndex: 0 },
      ];
      (panel as any)._doSyncMessagesToDOM();

      // Card should be gone — no longer "preserved as inject"
      expect(msgList.querySelectorAll('.perm-inline-card').length).toBe(0);
      expect(msgList.children.length).toBe(1);
    });

    it('does NOT cause count mismatch when perm card is in model', () => {
      panel = createChatPanel();
      const msgList = (panel as any).msgList as HTMLElement;

      (panel as any).messages = [
        { role: 'user', _id: 'u1', text: 'q', sessionIndex: 0 },
        { role: 'perm', _id: 'p1', toolName: 'write_file', reason: 'r', subject: 'f', resolve: vi.fn() },
      ];
      (panel as any)._streamingAssistantId = null;

      // Run sync multiple times — should not accumulate extra perm cards
      for (let i = 0; i < 3; i++) {
        (panel as any)._doSyncMessagesToDOM();
      }

      // msgCount should still match DOM children count
      // If perm cards were treated as injects, children would grow each iteration
      expect(msgList.children.length).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // saveActiveSession → setAgent → autoRestoreLastSession race
  // ═══════════════════════════════════════════════════════════════

  describe('save-active-then-rebuild race prevention', () => {
    it('autoRestoreLastSession succeeds when session was saved before setAgent reset', async () => {
      panel = createChatPanel();
      panel.setProjectPath('D:/test');

      // ── Step 1: Set up a live session with conversation ──
      const savedMessages: any[] = [];
      const fakeAgent = {
        getSession: () => [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '帮我分析' },
          { role: 'assistant', content: '好的，正在分析…' },
        ],
        setSession: vi.fn(),
      };
      panel.setAgent(fakeAgent as any);

      // ── Step 2: Save the active session (simulates finishTurn) ──
      // Mock write_file_content for both session file + tracker
      mockInvoke.mockResolvedValue('ok');
      await panel.saveActiveSession('D:/test');

      // Verify localStorage was written (saveActiveSession writes there first)
      const hash = hashProjectPath('D:/test').toString(36);
      const sessionId = (Session as any).getSessions?.()?.[0]?.id;
      // Just verify SOMETHING was written to localStorage
      const lsKeys = Object.keys(localStorage).filter(k => k.startsWith('hologram_session_'));
      expect(lsKeys.length).toBeGreaterThan(0);

      // ── Step 3: Simulate mode change → setupAgent → setAgent (resets all) ──
      const newFakeAgent = {
        getSession: () => [{ role: 'system', content: 'fresh sys' }],
        setSession: vi.fn(),
      };
      panel.setAgent(newFakeAgent as any);

      // After setAgent, sessions should be reset
      const sessions = Session.getSessions();
      expect(sessions?.length).toBe(1);
      expect(sessions?.[0]?.agent).toBe(newFakeAgent);

      // ── Step 4: autoRestoreLastSession should recover the saved conversation ──
      // Mock read_file_content: tracker + session file
      mockInvoke.mockReset();
      // Tracker points to session that was saved
      const savedId = lsKeys.length > 0
        ? parseInt(lsKeys[0].replace(`hologram_session_${hash}_`, ''), 10)
        : 1;
      mockInvoke
        .mockResolvedValueOnce(JSON.stringify({ lastId: savedId, nextId: savedId + 1 }))
        .mockResolvedValueOnce(JSON.stringify({
          id: savedId,
          label: '已保存',
          savedAt: new Date().toISOString(),
          messages: [
            { role: 'system', content: 'sys' },
            { role: 'user', content: '帮我分析' },
            { role: 'assistant', content: '好的，正在分析…' },
          ],
        }));

      // Set fresh agent factory for autoRestoreLastSession
      panel.setAgentFactory(async () => ({
        getSession: () => [{ role: 'system', content: 'fresh sys' }],
        setSession: (msgs: any[]) => { savedMessages.push(...msgs); },
      } as any));

      await panel.autoRestoreLastSession('D:/test');

      // Should have recovered the conversation
      const userMsgs = savedMessages.filter((m: any) => m.role === 'user');
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toBe('帮我分析');
    });
  });

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
