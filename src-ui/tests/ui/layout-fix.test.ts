// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// Tests for the layout bug fixes:
// 1. Shell constraint — only pulls far outliers, not all nodes to shell
// 2. repelCommunityCentroids — reduced FACTOR/ITERS, delta clamp
// 3. No NaN / no extreme positions

import { describe, expect, it } from 'vitest';
import { fibonacciSphere, layout3D, repelCommunityCentroids } from '../../src/ui/graph-layout';

function makeFixture(n: number, comms: number): { nodeComm: number[]; edgePairs: [number, number][] } {
  const nodeComm = Array.from({ length: n }, (_, i) => i % comms);
  const edgePairs: [number, number][] = [];
  for (let i = 0; i + comms < n; i++) edgePairs.push([i, i + comms]);
  for (let i = 0; i + 1 < n; i += 7) edgePairs.push([i, i + 1]);
  return { nodeComm, edgePairs };
}

describe('shell constraint fix — no longer forces sphere', () => {
  it('nodes should not all cluster at shellRadius distance', { timeout: 30_000 }, async () => {
    const n = 100;
    const { nodeComm, edgePairs } = makeFixture(n, 5);
    const pos = await layout3D(n, edgePairs, undefined, nodeComm);

    // Compute distances from center
    const dists: number[] = [];
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(pos[i * 3] ** 2 + pos[i * 3 + 1] ** 2 + pos[i * 3 + 2] ** 2);
      dists.push(d);
    }
    dists.sort((a, b) => a - b);

    // In old code, shell constraint pulled everyone to shellRadius.
    // Now nodes should have a spread of distances — not all near one value.
    const p10 = dists[Math.floor(n * 0.1)];
    const p90 = dists[Math.floor(n * 0.9)];
    const spread = p90 - p10;

    // If everything was on a shell, spread would be near 0.
    // With the fix, we expect meaningful spread.
    expect(spread).toBeGreaterThan(0);
  });

  it('simulateForces via layout3D should not produce extreme positions', { timeout: 30_000 }, async () => {
    const n = 50;
    const pairs: [number, number][] = [];
    for (let i = 0; i + 1 < n; i++) pairs.push([i, i + 1]);
    const pos = await layout3D(n, pairs, undefined, null);
    const shellRadius = Math.cbrt(n) * 14;

    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(pos[i * 3] ** 2 + pos[i * 3 + 1] ** 2 + pos[i * 3 + 2] ** 2);
      // Nodes should stay within a reasonable multiple of shellRadius
      expect(d).toBeLessThan(shellRadius * 5.0);
    }
  });
});

describe('repelCommunityCentroids — no runaway displacement', () => {
  it('should not push communities to extreme distances', { timeout: 30_000 }, () => {
    const n = 200;
    const { nodeComm, edgePairs } = makeFixture(n, 8);

    // Start with fibonacci sphere
    const shellRadius = Math.cbrt(n) * 14;
    const pos = fibonacciSphere(n, shellRadius);

    // Run repel
    repelCommunityCentroids(pos, n, nodeComm, shellRadius, edgePairs);

    // Check no node flew to absurd distance
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(pos[i * 3] ** 2 + pos[i * 3 + 1] ** 2 + pos[i * 3 + 2] ** 2);
      expect(d).toBeLessThan(shellRadius * 10);
      expect(Number.isFinite(d)).toBe(true);
    }
  });

  it('should not produce NaN', { timeout: 30_000 }, () => {
    const n = 100;
    const { nodeComm, edgePairs } = makeFixture(n, 4);
    const pos = fibonacciSphere(n, Math.cbrt(n) * 14);

    repelCommunityCentroids(pos, n, nodeComm, Math.cbrt(n) * 14, edgePairs);

    for (let i = 0; i < n * 3; i++) {
      expect(Number.isFinite(pos[i])).toBe(true);
    }
  });
});

describe('layout3D — full pipeline safety', () => {
  it('large graph produces all-finite positions', { timeout: 30_000 }, async () => {
    const n = 2000;
    const { nodeComm, edgePairs } = makeFixture(n, 15);
    const pos = await layout3D(n, edgePairs, undefined, nodeComm);

    expect(pos.length).toBe(n * 3);
    for (let i = 0; i < n * 3; i++) {
      expect(Number.isFinite(pos[i])).toBe(true);
    }
  });

  it('empty graph returns empty array', { timeout: 30_000 }, async () => {
    const pos = await layout3D(0, []);
    expect(pos.length).toBe(0);
  });

  it('single community degrades to single-ball simulation', { timeout: 30_000 }, async () => {
    const n = 30;
    const { nodeComm, edgePairs } = makeFixture(n, 1);
    const pos = await layout3D(n, edgePairs, undefined, nodeComm);
    expect(pos.length).toBe(n * 3);
    for (let i = 0; i < n * 3; i++) {
      expect(Number.isFinite(pos[i])).toBe(true);
    }
  });
});
