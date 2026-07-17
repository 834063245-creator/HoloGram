// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Mock bridge and events ──

const rpcMock = vi.fn();
const emitMock = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => rpcMock(...args),
  listen: vi.fn(() => () => {}),
  isMockMode: () => false,
}));
vi.mock('../src/ui/events', () => ({
  bus: { emit: (...args: any[]) => emitMock(...args), on: vi.fn(), off: vi.fn() },
}));

import { GoalManager, type GoalRecord } from '../src/agent/goal-manager';

// ── Live in-memory FS(同 rpc 面,状态真实流转) ──

function mockLiveFs(initial: Record<string, string> = {}): Map<string, string> {
  const files = new Map<string, string>(Object.entries(initial));
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'create_directory') return null;
    if (method === 'write_file_content') {
      files.set(params.filePath as string, params.content as string);
      return '(mock: file saved)';
    }
    if (method === 'read_file_content') {
      const v = files.get(params.filePath as string);
      if (v === undefined) throw new Error(`ENOENT: ${params.filePath}`);
      return v;
    }
    if (method === 'delete_file_or_dir') {
      const p = params.path as string;
      for (const k of [...files.keys()]) {
        if (k === p || k.startsWith(p + '/')) files.delete(k);
      }
      return null;
    }
    if (method === 'list_directory') return '[]';
    throw new Error(`unexpected rpc: ${method}`);
  });
  return files;
}

function makeRecord(partial: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'goal-1',
    text: 'fix auth',
    status: 'active',
    iteration: 0,
    stallRounds: 0,
    summary: '',
    createdAt: 1000,
    updatedAt: 1000,
    ...partial,
  };
}

const GOALS = '/proj/.hologram/goals';

// ── CRUD ──

describe('GoalManager CRUD', () => {
  beforeEach(() => {
    emitMock.mockReset();
    mockLiveFs();
  });

  it('create + get round-trip, emits goal:state active', async () => {
    const gm = new GoalManager('/proj');
    const rec = await gm.create('fix auth bug');

    expect(rec.id).toMatch(/^goal-/);
    expect(rec.status).toBe('active');
    expect(rec.text).toBe('fix auth bug');

    const loaded = await gm.get(rec.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.text).toBe('fix auth bug');

    const emitted = emitMock.mock.calls.filter((c) => c[0] === 'goal:state');
    expect(emitted.length).toBe(1);
    expect((emitted[0][1] as GoalRecord).status).toBe('active');
  });

  it('create cancels an existing live goal (single-goal slot)', async () => {
    const gm = new GoalManager('/proj');
    const g1 = await gm.create('old goal');
    const g2 = await gm.create('new goal');

    expect((await gm.get(g1.id))!.status).toBe('cancelled');
    const active = await gm.getActive();
    expect(active).not.toBeNull();
    expect(active!.id).toBe(g2.id);
  });

  it('getActive returns null when no live goal; finds paused too', async () => {
    const gm = new GoalManager('/proj');
    expect(await gm.getActive()).toBeNull();

    const rec = await gm.create('paused goal');
    await gm.update(rec.id, { status: 'paused' });
    const active = await gm.getActive();
    expect(active).not.toBeNull();
    expect(active!.status).toBe('paused');
  });

  it('update refreshes fields + updatedAt, keeps id/createdAt, index stays consistent', async () => {
    const gm = new GoalManager('/proj');
    const rec = await gm.create('iterate');
    const before = rec.updatedAt;

    const updated = await gm.update(rec.id, { iteration: 5, stallRounds: 2 });
    expect(updated).not.toBeNull();
    expect(updated!.iteration).toBe(5);
    expect(updated!.stallRounds).toBe(2);
    expect(updated!.id).toBe(rec.id);
    expect(updated!.createdAt).toBe(rec.createdAt);
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(before);

    const all = await gm.list();
    expect(all.length).toBe(1);
    expect(all[0].iteration).toBe(5);
  });

  it('update on missing id returns null', async () => {
    const gm = new GoalManager('/proj');
    expect(await gm.update('goal-nope', { iteration: 1 })).toBeNull();
  });

  it('cancel keeps the record but clears the active slot', async () => {
    const gm = new GoalManager('/proj');
    const rec = await gm.create('cancel me');
    await gm.cancel(rec.id);

    expect((await gm.get(rec.id))!.status).toBe('cancelled');
    expect(await gm.getActive()).toBeNull();
    // 历史里仍可见
    expect((await gm.list()).some((r) => r.id === rec.id)).toBe(true);
  });

  it('delete removes record from index and files', async () => {
    const files = mockLiveFs();
    const gm = new GoalManager('/proj');
    const rec = await gm.create('delete me');
    await gm.delete(rec.id);

    expect(await gm.get(rec.id)).toBeNull();
    expect((await gm.list()).length).toBe(0);
    expect([...files.keys()].some((k) => k.includes(rec.id))).toBe(false);
  });
});

// ── Session 快照 ──

describe('GoalManager session snapshots', () => {
  beforeEach(() => {
    emitMock.mockReset();
    mockLiveFs();
  });

  it('saveSession + loadSession round-trip', async () => {
    const gm = new GoalManager('/proj');
    const rec = await gm.create('snapshot');
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '<goal>fix</goal>' },
    ] as any[];
    await gm.saveSession(rec.id, msgs);

    const loaded = await gm.loadSession(rec.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.length).toBe(2);
    expect(loaded![1].content).toBe('<goal>fix</goal>');
  });

  it('loadSession returns null when no snapshot', async () => {
    const gm = new GoalManager('/proj');
    const rec = await gm.create('no snapshot');
    expect(await gm.loadSession(rec.id)).toBeNull();
  });
});

// ── 崩溃接管 ──

describe('GoalManager adoptOrphans', () => {
  beforeEach(() => emitMock.mockReset());

  it('ancient active record → paused', async () => {
    const orphan = makeRecord({ id: 'goal-orphan', status: 'active', updatedAt: 1 });
    mockLiveFs({
      [`${GOALS}/goal-orphan/goal.json`]: JSON.stringify(orphan),
      [`${GOALS}/index.json`]: JSON.stringify([orphan]),
    });
    const gm = new GoalManager('/proj'); // startedAt = now >> 1

    const adopted = await gm.adoptOrphans();
    expect(adopted.length).toBe(1);
    expect(adopted[0].id).toBe('goal-orphan');
    expect(adopted[0].status).toBe('paused');
    expect((await gm.get('goal-orphan'))!.status).toBe('paused');
  });

  it('fresh active record from this process is untouched', async () => {
    mockLiveFs();
    const gm = new GoalManager('/proj');
    const live = await gm.create('live goal'); // updatedAt >= startedAt

    const adopted = await gm.adoptOrphans();
    expect(adopted.length).toBe(0);
    expect((await gm.get(live.id))!.status).toBe('active');
  });
});

// ── 旧格式迁移 ──

describe('GoalManager migrateLegacy', () => {
  beforeEach(() => emitMock.mockReset());

  it('imports legacy goal.json as paused, copies session, deletes legacy file', async () => {
    const legacy = { goal: 'legacy goal', iteration: 3, stallRounds: 1, status: 'active', createdAt: 100, updatedAt: 200 };
    const legacySession = [{ role: 'system', content: 'sys' }, { role: 'user', content: '<goal>legacy goal</goal>' }];
    const files = mockLiveFs({
      '/proj/.hologram/agents/main/goal.json': JSON.stringify(legacy),
      '/proj/.hologram/agents/main/session.json': JSON.stringify(legacySession),
    });
    const gm = new GoalManager('/proj');

    const migrated = await gm.migrateLegacy();
    expect(migrated).not.toBeNull();
    expect(migrated!.text).toBe('legacy goal');
    expect(migrated!.status).toBe('paused'); // active 一律按 paused(启动时无活体循环)
    expect(migrated!.iteration).toBe(3);
    expect(migrated!.stallRounds).toBe(1);

    // session 快照已复制到新槽
    const session = await gm.loadSession(migrated!.id);
    expect(session).not.toBeNull();
    expect(session!.length).toBe(2);

    // 旧 goal.json 已删除(防止重复迁移)
    expect(files.has('/proj/.hologram/agents/main/goal.json')).toBe(false);
    // 再次迁移 → null
    expect(await gm.migrateLegacy()).toBeNull();
  });

  it('returns null when no legacy file', async () => {
    mockLiveFs();
    const gm = new GoalManager('/proj');
    expect(await gm.migrateLegacy()).toBeNull();
  });
});
