// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// Golden snapshot for the 3D layout pipeline (graph-layout.ts).
// P4 钉板：拆解 graph.ts 之前先把布局坐标钉死——任何重构引起的
// 布局漂移都会让本测试炸掉。布局参数 LOCKED（见 graph-layout.ts 头注）。
//
// 只测确定性路径：layout3D 内部 = fibonacciSphere + simulateForces +
// Tier-A 质心弛豫，全程无 Math.random（spiralGalaxies 不在 layout3D 调用链上）。

import { describe, expect, it } from 'vitest';
import { fibonacciSphere, layout3D } from '../../src/scene/graph-layout';

// ── 固定种子图（fixture 即种子，无 RNG）──────────────────────

function makeFixture(n: number, comms: number): { nodeComm: number[]; edgePairs: [number, number][] } {
  const nodeComm = Array.from({ length: n }, (_, i) => i % comms);
  const edgePairs: [number, number][] = [];
  // 社区内链：i → i+comms（同社区）
  for (let i = 0; i + comms < n; i++) edgePairs.push([i, i + comms]);
  // 稀疏跨社区边：固定步长 7
  for (let i = 0; i + 1 < n; i += 7) edgePairs.push([i, i + 1]);
  return { nodeComm, edgePairs };
}

/** 坐标钉到 1e-4——足够抓住任何真实漂移，又不吃浮点尾数噪音。 */
function snap(pos: Float32Array): number[] {
  return Array.from(pos, (v) => Math.round(v * 1e4) / 1e4);
}

// ── Tests ────────────────────────────────────────────────────

describe('layout golden — 布局坐标钉板', () => {
  it('fibonacciSphere 固定分布', () => {
    expect(snap(fibonacciSphere(24, 100))).toMatchSnapshot();
  });

  it('layout3D 多社区两层布局（n=90, 3 社区）', async () => {
    const { nodeComm, edgePairs } = makeFixture(90, 3);
    const pos = await layout3D(90, edgePairs, undefined, nodeComm);
    expect(pos.length).toBe(90 * 3);
    expect(snap(pos)).toMatchSnapshot();
  });

  it('layout3D 单社区退化为单球模拟（n=40, 1 社区）', async () => {
    const { nodeComm, edgePairs } = makeFixture(40, 1);
    const pos = await layout3D(40, edgePairs, undefined, nodeComm);
    expect(pos.length).toBe(40 * 3);
    expect(snap(pos)).toMatchSnapshot();
  });

  it('layout3D 无社区信息（nodeComm=null）走单球路径', async () => {
    const { edgePairs } = makeFixture(30, 3);
    const pos = await layout3D(30, edgePairs, undefined, null);
    expect(pos.length).toBe(30 * 3);
    expect(snap(pos)).toMatchSnapshot();
  });

  it('layout3D 空图返回空数组', async () => {
    const pos = await layout3D(0, []);
    expect(pos.length).toBe(0);
  });

  it('重复运行结果逐位一致（确定性守护）', async () => {
    const { nodeComm, edgePairs } = makeFixture(90, 3);
    const a = await layout3D(90, edgePairs, undefined, nodeComm);
    const b = await layout3D(90, edgePairs, undefined, nodeComm);
    expect(snap(a)).toEqual(snap(b));
  });
});
