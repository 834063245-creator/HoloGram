// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 图分页加载（P0-2）回归测试
//
// 回归背景（2026-08-11 布局「一锅粥」事故）：
//   loadGraphPages 曾把最后一页才携带的权威 communities / hierarchical_communities
//   在 render/applyGraphDiff 之后才挂到 graphData — 渲染器读到的永远是空壳 []，
//   而 JS 空数组为真值使 `hierarchical_communities || communities` 无法回退，
//   布局丢失社区分组退化为目录分组。
//
// 本文件锁定两条不变式：
//   1. render/applyGraphDiff 被调用时，graphData 上必须已有该页携带的权威社区；
//   2. 逐页合并后节点按 id 去重、最终社区为权威版本。

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));
vi.mock('../src/ui/events', () => ({ bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));

import { loadGraphPages } from '../src/workspace';

// ── helpers ──────────────────────────────────────────────

interface RenderCall {
  kind: 'render' | 'diff';
  nodes: number;
  communities: number;
  hierarchical: number;
}

function makeWs(path = 'D:/proj') {
  return {
    _active: true,
    get active() {
      return this._active;
    },
    path,
    graphData: {
      meta: {},
      nodes: [] as any[],
      edges: [] as any[],
      communities: [] as any[],
      hierarchical_communities: [] as any[],
    },
    onStatusChange: undefined as any,
  } as any;
}

function makeStarGraph(calls: RenderCall[]) {
  const snap = (g: any): RenderCall => ({
    kind: 'render',
    nodes: g.nodes.length,
    communities: g.communities?.length ?? -1,
    hierarchical: g.hierarchical_communities?.length ?? -1,
  });
  return {
    hasGraph: true,
    render: vi.fn(async (g: any) => {
      calls.push(snap(g));
    }),
    applyGraphDiff: vi.fn(async (_d: any, g: any) => {
      const s = snap(g);
      s.kind = 'diff';
      calls.push(s);
    }),
    relayoutInPlace: vi.fn(async () => {}),
  } as any;
}

function node(id: string, cid: number) {
  return { id, name: id, type: 'function', location: id.split(':')[0], community_id: cid };
}

function pagePayload(page: number, totalPages: number, nodes: any[], extra: any = {}) {
  return JSON.stringify({
    meta: { source_root: 'D:/proj', node_count: 3, edge_count: 1 },
    page,
    page_size: 2,
    total_pages: totalPages,
    has_more: page + 1 < totalPages,
    nodes,
    edges: [],
    ...extra,
  });
}

// ── tests ────────────────────────────────────────────────

describe('loadGraphPages（P0-2 分页加载）', () => {
  beforeEach(() => mockRpc.mockReset());

  it('单页：render 时权威社区已挂上 graphData（空壳 [] 不得进入渲染器）', async () => {
    const ws = makeWs();
    const calls: RenderCall[] = [];
    const sg = makeStarGraph(calls);
    mockRpc.mockResolvedValue(
      pagePayload(0, 1, [node('a.ts:f1', 1), node('a.ts:f2', 1), node('b.ts:g1', 2)], {
        communities: [
          { id: '1', size: 2, node_ids: ['a.ts:f1', 'a.ts:f2'], label: 'a.ts' },
          { id: '2', size: 1, node_ids: ['b.ts:g1'], label: 'b.ts' },
        ],
        hierarchical_communities: [{ id: 'h1', label: 'a', node_ids: ['a.ts:f1', 'a.ts:f2'], level: 0 }],
      }),
    );

    const ok = await loadGraphPages(ws, sg, { meta: {}, page_size: 2, total_pages: 1 });

    expect(ok).toBe(true);
    expect(sg.render).toHaveBeenCalledTimes(1);
    // 修复前：render 看到 hierarchical=0（空壳），布局回退目录分组
    expect(calls[0].hierarchical).toBe(1);
    expect(calls[0].communities).toBe(2);
    expect(calls[0].nodes).toBe(3);
    // 单页：首页已是全量布局，无需就地重布局
    expect(sg.relayoutInPlace).not.toHaveBeenCalled();
  });

  it('多页：末页 applyGraphDiff 时权威层级社区已挂上；节点按 id 去重', async () => {
    const ws = makeWs();
    const calls: RenderCall[] = [];
    const sg = makeStarGraph(calls);
    // 页 0：不含社区（仅首页）；页 1：含权威社区，且携带与页 0 重复的节点（漂移吸收）
    mockRpc.mockResolvedValueOnce(pagePayload(0, 2, [node('a.ts:f1', 1), node('a.ts:f2', 1)])).mockResolvedValueOnce(
      pagePayload(1, 2, [node('a.ts:f2', 1), node('b.ts:g1', 2)], {
        communities: [{ id: '1', size: 3, node_ids: ['a.ts:f1', 'a.ts:f2', 'b.ts:g1'], label: 'a.ts' }],
        hierarchical_communities: [{ id: 'h1', label: 'a', node_ids: ['a.ts:f1'], level: 0 }],
      }),
    );

    const ok = await loadGraphPages(ws, sg, { meta: {}, page_size: 2, total_pages: 2 });

    expect(ok).toBe(true);
    expect(calls.map((c) => c.kind)).toEqual(['render', 'diff']);
    // 首页 render：无权威层级 → 回退到渐进重建的 level-0 社区（非空！）
    expect(calls[0].hierarchical).toBe(0);
    expect(calls[0].communities).toBe(1);
    // 末页 diff：权威层级必须先于 applyGraphDiff 挂上（修复前为 0）
    expect(calls[1].hierarchical).toBe(1);
    expect(calls[1].communities).toBe(1);
    // 合并结果：重复节点 a.ts:f2 去重，最终社区为权威版
    expect(ws.graphData.nodes.map((n: any) => n.id).sort()).toEqual(['a.ts:f1', 'a.ts:f2', 'b.ts:g1']);
    expect(ws.graphData.communities[0].size).toBe(3);
    expect(ws.graphData.hierarchical_communities[0].id).toBe('h1');
    // 多页：末页到齐后必须做一次全量就地重布局（分页只是传输机制）
    expect(sg.relayoutInPlace).toHaveBeenCalledTimes(1);
  });

  it('工作区切走：停止拉页并返回 false', async () => {
    const ws = makeWs();
    const sg = makeStarGraph([]);
    mockRpc.mockImplementation(async () => {
      ws._active = false;
      return pagePayload(0, 3, [node('a.ts:f1', 1)]);
    });

    const ok = await loadGraphPages(ws, sg, { meta: {}, page_size: 1, total_pages: 3 });

    expect(ok).toBe(false);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});
