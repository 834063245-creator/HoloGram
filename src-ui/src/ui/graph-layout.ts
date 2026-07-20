// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ── 3D Force-Directed Layout ─────────────────────────────────────
// Extracted from graph.ts: standalone layout functions with no
// THREE.js or StarGraph dependency.
//
// Layout pipeline:
//   fibonacciSphere → simulateForces → spiralGalaxies → repelCommunityCentroids
//   Orchestrated by layout3D
//
// Parameters LOCKED as of v4.2 — safety layers only, no tuning.
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════

// ── Fibonacci Sphere ──────────────────────────────────────────────

export function fibonacciSphere(n: number, radius: number): Float32Array {
  const pos = new Float32Array(n * 3),
    phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1 || 1)) * 2,
      r = Math.sqrt(1 - y * y),
      theta = phi * i;
    pos[i * 3] = Math.cos(theta) * r * radius;
    pos[i * 3 + 1] = y * radius;
    pos[i * 3 + 2] = Math.sin(theta) * r * radius;
  }
  return pos;
}

// ═══════════════════════════════════════════════════════════════════
// Robustness-hardened: per-pair force caps, per-node velocity caps,
// per-node displacement caps, every-iteration NaN sampling,
// adaptive shell constraint, adaptive iteration budget.
// Core aesthetic parameters (rep, att, damp, shellRadius formula)
// are LOCKED — safety layers only, no tuning.
// ═══════════════════════════════════════════════════════════════════

// ── Single-cluster force simulation ─────────────────────────────
// rep/att/damp LOCKED at 600/0.018/0.72.
// Returns positions centered around local origin.

async function simulateForces(
  m: number,
  localPairs: [number, number][],
  shellRadius: number,
  signal?: AbortSignal,
): Promise<Float32Array> {
  if (m === 0) return new Float32Array(0);

  // ── Core parameters (LOCKED) ──
  const rep = 600,
    att = 0.018,
    damp = 0.72;
  const pos = fibonacciSphere(m, shellRadius);
  const vel = new Float32Array(m * 3);

  // ── Adaptive shell constraint — tighter for large graphs ──
  const sp = 0.006 + (m > 2000 ? 0.008 : 0) + (m > 4000 ? 0.006 : 0);

  // ── Adaptive iteration budget — fewer for large graphs (O(n²) cost) ──
  const maxIter = Math.min(60, Math.max(15, 60 - Math.floor(m / 800)));

  // ── Safety caps (derived from shell, not tuned per-graph) ──
  const REP_CAP = shellRadius * 8;
  const ATT_CAP = shellRadius;
  const VEL_CAP = shellRadius * 0.25;

  // Yield every N iterations to keep the UI responsive
  const YIELD_EVERY = m > 4000 ? 2 : m > 1500 ? 3 : 5;

  for (let iter = 0; iter < maxIter; iter++) {
    // Abort if a newer render supersedes this one
    if (signal?.aborted) return pos;

    // ── Repulsion (all pairs) ──
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        const dx = pos[i * 3] - pos[j * 3],
          dy = pos[i * 3 + 1] - pos[j * 3 + 1],
          dz = pos[i * 3 + 2] - pos[j * 3 + 2];
        const dist = Math.max(0.3, Math.sqrt(dx * dx + dy * dy + dz * dz));
        const f = Math.min(rep / (dist * dist + 1), REP_CAP);
        vel[i * 3] += (dx / dist) * f;
        vel[i * 3 + 1] += (dy / dist) * f;
        vel[i * 3 + 2] += (dz / dist) * f;
        vel[j * 3] -= (dx / dist) * f;
        vel[j * 3 + 1] -= (dy / dist) * f;
        vel[j * 3 + 2] -= (dz / dist) * f;
      }
    }
    // ── Attraction (edges only) ──
    for (const [s, t] of localPairs) {
      const dx = pos[s * 3] - pos[t * 3],
        dy = pos[s * 3 + 1] - pos[t * 3 + 1],
        dz = pos[s * 3 + 2] - pos[t * 3 + 2];
      const dist = Math.max(0.3, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const f = Math.min(dist * att, ATT_CAP);
      vel[s * 3] -= (dx / dist) * f;
      vel[s * 3 + 1] -= (dy / dist) * f;
      vel[s * 3 + 2] -= (dz / dist) * f;
      vel[t * 3] += (dx / dist) * f;
      vel[t * 3 + 1] += (dy / dist) * f;
      vel[t * 3 + 2] += (dz / dist) * f;
    }
    // ── Origin attraction ──
    for (let i = 0; i < m; i++) {
      vel[i * 3] -= pos[i * 3] * 0.0004;
      vel[i * 3 + 1] -= pos[i * 3 + 1] * 0.0004;
      vel[i * 3 + 2] -= pos[i * 3 + 2] * 0.0004;
    }
    // ── Per-node velocity cap ──
    for (let i = 0; i < m; i++) {
      const vx = vel[i * 3],
        vy = vel[i * 3 + 1],
        vz = vel[i * 3 + 2];
      const vm = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (vm > VEL_CAP) {
        const s = VEL_CAP / vm;
        vel[i * 3] = vx * s;
        vel[i * 3 + 1] = vy * s;
        vel[i * 3 + 2] = vz * s;
      }
    }
    // ── Damping + position update ──
    for (let i = 0; i < m * 3; i++) {
      vel[i] *= damp;
      pos[i] += vel[i];
    }
    // ── NaN detection ──
    if (iter % 5 === 0) {
      let diverged = false;
      for (let i = 0; i < m * 3 && !diverged; i++) {
        if (!Number.isFinite(pos[i]) || !Number.isFinite(vel[i])) diverged = true;
      }
      if (diverged) {
        const fresh = fibonacciSphere(m, shellRadius);
        for (let i = 0; i < m * 3; i++) {
          pos[i] = fresh[i];
          vel[i] = 0;
        }
      }
    } else {
      const sample = Math.max(10, Math.floor(Math.sqrt(m)));
      let diverged = false;
      for (let k = 0; k < sample && !diverged; k++) {
        const i = (k * 2654435761 + iter * 0x9e3779b9) % m;
        const i3 = i * 3;
        if (
          !Number.isFinite(pos[i3]) ||
          !Number.isFinite(pos[i3 + 1]) ||
          !Number.isFinite(pos[i3 + 2]) ||
          !Number.isFinite(vel[i3]) ||
          !Number.isFinite(vel[i3 + 1]) ||
          !Number.isFinite(vel[i3 + 2])
        ) {
          diverged = true;
        }
      }
      if (diverged) {
        const fresh = fibonacciSphere(m, shellRadius);
        for (let i = 0; i < m * 3; i++) {
          pos[i] = fresh[i];
          vel[i] = 0;
        }
      }
    }
    // ── Shell constraint (soft, one-sided: only pull in far outliers) ──
    // Original: pulled ALL nodes toward shellRadius → forced sphere shape.
    // Fix: only constrain nodes that drift far beyond the shell (2× radius).
    // This lets the graph find its natural shape while preventing runaway.
    const hardLimit = shellRadius * 2.5;
    for (let i = 0; i < m; i++) {
      const dx = pos[i * 3],
        dy = pos[i * 3 + 1],
        dz = pos[i * 3 + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > hardLimit) {
        // Pull back proportionally — soft, not snapping to shellRadius
        const pull = (dist - hardLimit) * sp * 3;
        pos[i * 3] -= (dx / dist) * pull;
        pos[i * 3 + 1] -= (dy / dist) * pull;
        pos[i * 3 + 2] -= (dz / dist) * pull;
      }
    }

    // Yield to event loop every N iterations to keep the UI responsive
    if (iter % YIELD_EVERY === YIELD_EVERY - 1 && iter < maxIter - 1) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  return pos;
}

// ── Procedural spiral galaxy generation (GPU companion) ──────────
// After GPU N-body sets community centroids, each community's nodes
// are placed in a spiral-arm pattern — hubs at center, leaves in arms.
// O(n) total, no iterations. Game-engine-style procedural generation.

/**
 * Local layout relaxation for incremental updates.
 * Runs a short force simulation on a subgraph (new nodes + their neighbors),
 * treating existing nodes as anchored (they don't move). Call after
 * `applyGraphDiff` appends new nodes.
 *
 * @param allPos - All node positions (Float32Array, n*3). Modified in-place.
 * @param n - Total node count.
 * @param allPairs - All edge pairs (source, target indices).
 * @param affectedIndices - Indices of nodes that need layout (new + neighbors).
 * @param anchoredIndices - Indices of existing nodes to keep fixed.
 * @param signal - Optional abort signal.
 */
export async function relaxNewNodes(
  allPos: Float32Array,
  n: number,
  allPairs: [number, number][],
  affectedIndices: Set<number>,
  anchoredIndices: Set<number>,
  signal?: AbortSignal,
): Promise<void> {
  const affected = [...affectedIndices];
  if (affected.length === 0) return;

  // Build local index map: global idx → local idx
  const gl2loc = new Map<number, number>();
  affected.forEach((gi, li) => gl2loc.set(gi, li));

  const m = affected.length;
  const shellR = Math.cbrt(Math.max(n, 10)) * 5; // small shell for local relax
  const vel = new Float32Array(m * 3);
  // Copy current positions (we modify allPos in-place, but use local pos for sim)
  const pos = new Float32Array(m * 3);
  for (let li = 0; li < m; li++) {
    const gi = affected[li];
    pos[li * 3] = allPos[gi * 3];
    pos[li * 3 + 1] = allPos[gi * 3 + 1];
    pos[li * 3 + 2] = allPos[gi * 3 + 2];
  }

  // Build local edge pairs (only edges where both nodes are in affected set)
  const localPairs: [number, number][] = [];
  for (const [s, t] of allPairs) {
    const ls = gl2loc.get(s),
      lt = gl2loc.get(t);
    if (ls !== undefined && lt !== undefined) localPairs.push([ls, lt]);
  }

  // Light parameters — short run, strong damping
  const rep = 300,
    att = 0.03,
    damp = 0.55;
  const maxIter = 8; // few iterations — layout should be close already
  const REP_CAP = shellR * 6;

  for (let iter = 0; iter < maxIter; iter++) {
    if (signal?.aborted) return;

    // Repulsion (all local pairs)
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        const dx = pos[i * 3] - pos[j * 3],
          dy = pos[i * 3 + 1] - pos[j * 3 + 1],
          dz = pos[i * 3 + 2] - pos[j * 3 + 2];
        const dist = Math.max(0.3, Math.sqrt(dx * dx + dy * dy + dz * dz));
        const f = Math.min(rep / (dist * dist + 1), REP_CAP);
        vel[i * 3] += (dx / dist) * f;
        vel[i * 3 + 1] += (dy / dist) * f;
        vel[i * 3 + 2] += (dz / dist) * f;
        vel[j * 3] -= (dx / dist) * f;
        vel[j * 3 + 1] -= (dy / dist) * f;
        vel[j * 3 + 2] -= (dz / dist) * f;
      }
    }
    // Attraction (local edges)
    for (const [s, t] of localPairs) {
      const dx = pos[s * 3] - pos[t * 3],
        dy = pos[s * 3 + 1] - pos[t * 3 + 1],
        dz = pos[s * 3 + 2] - pos[t * 3 + 2];
      const dist = Math.max(0.3, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const f = Math.min(dist * att, REP_CAP);
      vel[s * 3] -= (dx / dist) * f;
      vel[s * 3 + 1] -= (dy / dist) * f;
      vel[s * 3 + 2] -= (dz / dist) * f;
      vel[t * 3] += (dx / dist) * f;
      vel[t * 3 + 1] += (dy / dist) * f;
      vel[t * 3 + 2] += (dz / dist) * f;
    }
    // Damping + update
    for (let i = 0; i < m * 3; i++) {
      vel[i] *= damp;
      pos[i] += vel[i];
    }
    // Zero vel for anchored nodes → no movement
    for (let li = 0; li < m; li++) {
      const gi = affected[li];
      if (anchoredIndices.has(gi)) {
        vel[li * 3] = 0;
        vel[li * 3 + 1] = 0;
        vel[li * 3 + 2] = 0;
      }
    }
    // NaN guard
    if (iter % 3 === 0) {
      for (let i = 0; i < m * 3; i++) {
        if (!Number.isFinite(pos[i])) {
          pos[i] = allPos[affected[Math.floor(i / 3)] * 3 + (i % 3)];
          vel[i] = 0;
        }
      }
    }
    if (iter % 2 === 1 && iter < maxIter - 1) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  // Write back new positions for affected nodes
  for (let li = 0; li < m; li++) {
    const gi = affected[li];
    allPos[gi * 3] = pos[li * 3];
    allPos[gi * 3 + 1] = pos[li * 3 + 1];
    allPos[gi * 3 + 2] = pos[li * 3 + 2];
  }
}

export function spiralGalaxies(
  pos: Float32Array,
  n: number,
  nodeComm: number[],
  nodeDeg: number[],
  shellRadius: number,
): void {
  type Comm = { id: number; cx: number; cy: number; cz: number; cnt: number; nodes: number[] };
  const comms = new Map<number, Comm>();
  const unassigned: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = nodeComm[i];
    if (c < 0) {
      unassigned.push(i);
      continue;
    }
    let cc = comms.get(c);
    if (!cc) {
      cc = { id: c, cx: 0, cy: 0, cz: 0, cnt: 0, nodes: [] };
      comms.set(c, cc);
    }
    cc.cx += pos[i * 3];
    cc.cy += pos[i * 3 + 1];
    cc.cz += pos[i * 3 + 2];
    cc.cnt++;
    cc.nodes.push(i);
  }
  const commArr = [...comms.values()];
  for (const cc of commArr) {
    cc.cx /= cc.cnt;
    cc.cy /= cc.cnt;
    cc.cz /= cc.cnt;
  }

  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (const cc of commArr) {
    const m = cc.nodes.length;
    cc.nodes.sort((a, b) => nodeDeg[b] - nodeDeg[a]);
    const commR = Math.cbrt(m) * shellRadius * 0.04;
    const arms = m < 15 ? 2 : m < 40 ? 3 : 4;
    const twist = 1.2 + (m % 7) * 0.3;
    const flat = 0.15 + (m % 5) * 0.04;
    const tiltA = (cc.cx * 7.3 + cc.cy * 3.1) % (Math.PI * 2);
    const tiltB = (cc.cz * 5.7 + cc.cx * 2.3) % (Math.PI * 0.6);
    const ctA = Math.cos(tiltA),
      stA = Math.sin(tiltA);
    const ctB = Math.cos(tiltB),
      stB = Math.sin(tiltB);

    // Seeded PRNG — deterministic per community (mulberry32)
    let _s = ((cc.id + 1) * 2654435761) >>> 0;
    const rng = () => {
      _s = (_s + 0x6d2b79f5) | 0;
      let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const gauss = () => {
      let u = 0,
        v = 0;
      while (u === 0) u = rng();
      while (v === 0) v = rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    for (let j = 0; j < m; j++) {
      const t = j / Math.max(1, m - 1);
      const r = commR * t ** 0.55;
      const armIdx = j % arms;
      const armAngle = (armIdx / arms) * Math.PI * 2;
      const spiralAngle = r * twist + armAngle;
      const scatter = commR * 0.06 * (0.3 + t * 1.2);
      const px = Math.cos(spiralAngle) * r + gauss() * scatter;
      const py = gauss() * r * flat * 0.5;
      const pz = Math.sin(spiralAngle) * r + gauss() * scatter;
      const rx = px * ctA - pz * stA;
      let rz = px * stA + pz * ctA;
      const ry = py * ctB - rz * stB;
      rz = py * stB + rz * ctB;
      const i = cc.nodes[j];
      pos[i * 3] = cc.cx + rx;
      pos[i * 3 + 1] = cc.cy + ry;
      pos[i * 3 + 2] = cc.cz + rz;
    }
  }

  for (let j = 0; j < unassigned.length; j++) {
    const i = unassigned[j];
    const r = shellRadius * 0.1 * Math.cbrt(j + 1);
    const th = goldenAngle * j;
    const ph = Math.acos(1 - (2 * (j + 0.5)) / Math.max(1, unassigned.length));
    pos[i * 3] = Math.cos(th) * Math.sin(ph) * r;
    pos[i * 3 + 1] = Math.cos(ph) * r;
    pos[i * 3 + 2] = Math.sin(th) * Math.sin(ph) * r;
  }
}

// ── Community centroid repel + cross-edge attract ─────────────────

export function repelCommunityCentroids(
  pos: Float32Array,
  n: number,
  nodeComm: number[],
  _shellRadius: number,
  edgePairs: [number, number][],
): void {
  const commMap = new Map<number, { cx: number; cy: number; cz: number; nodes: number[]; r: number; idx: number }>();
  for (let i = 0; i < n; i++) {
    const c = nodeComm[i];
    if (c < 0) continue;
    let cc = commMap.get(c);
    if (!cc) {
      cc = { cx: 0, cy: 0, cz: 0, nodes: [], r: 0, idx: 0 };
      commMap.set(c, cc);
    }
    cc.cx += pos[i * 3];
    cc.cy += pos[i * 3 + 1];
    cc.cz += pos[i * 3 + 2];
    cc.nodes.push(i);
  }
  const comms = [...commMap.values()];
  if (comms.length < 2) return;
  for (let a = 0; a < comms.length; a++) comms[a].idx = a;
  for (const cc of comms) {
    cc.cx /= cc.nodes.length;
    cc.cy /= cc.nodes.length;
    cc.cz /= cc.nodes.length;
    const dists: number[] = [];
    for (const i of cc.nodes) {
      const dx = pos[i * 3] - cc.cx,
        dy = pos[i * 3 + 1] - cc.cy,
        dz = pos[i * 3 + 2] - cc.cz;
      dists.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    dists.sort((a, b) => a - b);
    cc.r = dists[Math.floor(dists.length * 0.9)] || 20;
  }
  const C = comms.length;
  const crossW = new Array(C).fill(0).map(() => new Array(C).fill(0));
  for (const [s, t] of edgePairs) {
    const sc = nodeComm[s],
      tc = nodeComm[t];
    if (sc < 0 || tc < 0 || sc === tc) continue;
    const sa = commMap.get(sc)?.idx,
      ta = commMap.get(tc)?.idx;
    if (sa === undefined || ta === undefined) continue;
    crossW[sa][ta]++;
    crossW[ta][sa]++;
  }
  const FACTOR = 1.3;
  const ITERS = 15;
  const ATT_STR = 0.008;
  for (let iter = 0; iter < ITERS; iter++) {
    const deltas = comms.map(() => ({ dx: 0, dy: 0, dz: 0 }));
    let hadOverlap = false;
    for (let a = 0; a < C; a++) {
      for (let b = a + 1; b < C; b++) {
        const ca = comms[a],
          cb = comms[b];
        const dx = cb.cx - ca.cx,
          dy = cb.cy - ca.cy,
          dz = cb.cz - ca.cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < 0.01) continue;
        const nx = dx / dist,
          ny = dy / dist,
          nz = dz / dist;
        const minDist = (ca.r + cb.r) * FACTOR;
        if (dist < minDist) {
          hadOverlap = true;
          const push = (minDist - dist) / 2;
          deltas[a].dx -= nx * push;
          deltas[a].dy -= ny * push;
          deltas[a].dz -= nz * push;
          deltas[b].dx += nx * push;
          deltas[b].dy += ny * push;
          deltas[b].dz += nz * push;
        }
        const w = crossW[a][b];
        if (w > 0) {
          const pull = Math.min(w * ATT_STR, dist * 0.3);
          deltas[a].dx += nx * pull;
          deltas[a].dy += ny * pull;
          deltas[a].dz += nz * pull;
          deltas[b].dx -= nx * pull;
          deltas[b].dy -= ny * pull;
          deltas[b].dz -= nz * pull;
        }
      }
    }
    if (!hadOverlap && iter > 5) break;
    // Clamp per-iteration delta to prevent runaway displacement
    const MAX_DELTA = 50;
    for (let a = 0; a < C; a++) {
      const cc = comms[a],
        d = deltas[a];
      const dmag = Math.sqrt(d.dx * d.dx + d.dy * d.dy + d.dz * d.dz);
      if (dmag > MAX_DELTA) {
        const scale = MAX_DELTA / dmag;
        d.dx *= scale;
        d.dy *= scale;
        d.dz *= scale;
      }
      cc.cx += d.dx;
      cc.cy += d.dy;
      cc.cz += d.dz;
      for (const i of cc.nodes) {
        pos[i * 3] += d.dx;
        pos[i * 3 + 1] += d.dy;
        pos[i * 3 + 2] += d.dz;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Two-tier community-aware layout (v4.2):
//   Tier B — per-community force simulation (simulateForces, same params)
//   Tier A — cluster center placement with collision relaxation
// ═══════════════════════════════════════════════════════════════════

export async function layout3D(
  n: number,
  edgePairs: [number, number][],
  signal?: AbortSignal,
  nodeComm?: number[] | null,
): Promise<Float32Array> {
  if (n === 0) return new Float32Array(0);

  const groupIds = nodeComm ? [...new Set(nodeComm.filter((c) => c >= 0))] : [];

  // Degenerate: ≤1 community → single-ball
  if (groupIds.length <= 1) {
    return simulateForces(n, edgePairs, Math.cbrt(n) * 14, signal);
  }

  // ═══════════════════════════════════════════════════════════════
  // Multi-community: two-tier layout (CPU path)
  // GPU path is handled directly in _renderImpl
  // ═══════════════════════════════════════════════════════════════

  // ── Build groups ──
  const groupMap = new Map<number, number[]>(); // commId → global indices
  for (const gid of groupIds) groupMap.set(gid, []);
  const UNASSIGNED = -2;
  groupMap.set(UNASSIGNED, []);

  for (let i = 0; i < n; i++) {
    const c = nodeComm?.[i];
    if (c != null && c >= 0) groupMap.get(c)?.push(i);
    else groupMap.get(UNASSIGNED)?.push(i);
  }
  if (groupMap.get(UNASSIGNED)?.length === 0) groupMap.delete(UNASSIGNED);

  const groupEntries = [...groupMap.entries()];
  const C = groupEntries.length;
  if (C <= 1) return simulateForces(n, edgePairs, Math.cbrt(n) * 14, signal);

  // ── Tier B: per-community simulation ──
  const localPositions: Float32Array[] = new Array(C);
  const groupRadii: number[] = new Array(C);
  const globalToLocal: Int32Array[] = new Array(C);
  const nodeToGroup = new Int32Array(n).fill(-1);

  for (let g = 0; g < C; g++) {
    const members = groupEntries[g][1];
    const m = members.length;

    const g2l = new Int32Array(n).fill(-1);
    for (let li = 0; li < m; li++) {
      g2l[members[li]] = li;
      nodeToGroup[members[li]] = g;
    }
    globalToLocal[g] = g2l;

    const localPairs: [number, number][] = [];
    for (const [s, t] of edgePairs) {
      const ls = g2l[s],
        lt = g2l[t];
      if (ls >= 0 && lt >= 0) localPairs.push([ls, lt]);
    }

    const localShell = Math.cbrt(m) * 14;
    const localPos = await simulateForces(m, localPairs, localShell, signal);
    localPositions[g] = localPos;

    let cx = 0,
      cy = 0,
      cz = 0;
    for (let li = 0; li < m; li++) {
      cx += localPos[li * 3];
      cy += localPos[li * 3 + 1];
      cz += localPos[li * 3 + 2];
    }
    cx /= m;
    cy /= m;
    cz /= m;
    const dists: number[] = [];
    for (let li = 0; li < m; li++) {
      const dx = localPos[li * 3] - cx,
        dy = localPos[li * 3 + 1] - cy,
        dz = localPos[li * 3 + 2] - cz;
      dists.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    dists.sort((a, b) => a - b);
    groupRadii[g] = dists[Math.floor(dists.length * 0.9)] || localShell;

    if (signal?.aborted) break;
  }

  if (signal?.aborted) {
    const partial = new Float32Array(n * 3);
    for (let g = 0; g < C; g++) {
      const lp = localPositions[g];
      if (!lp) continue;
      const members = groupEntries[g][1];
      for (let li = 0; li < members.length; li++) {
        const gi = members[li];
        partial[gi * 3] = lp[li * 3];
        partial[gi * 3 + 1] = lp[li * 3 + 1];
        partial[gi * 3 + 2] = lp[li * 3 + 2];
      }
    }
    return partial;
  }

  // ── Tier A: place cluster centers in space (collision relaxation) ──
  const SEP = 1.4;
  const COARSE_ITER = 400;
  const ATT_A = 0.01;

  const crossWeight: number[][] = Array.from({ length: C }, () => new Array(C).fill(0));
  for (const [s, t] of edgePairs) {
    const sg = nodeToGroup[s],
      tg = nodeToGroup[t];
    if (sg >= 0 && tg >= 0 && sg !== tg) crossWeight[sg][tg]++;
  }

  // R0 scales with √C, not linearly with totalDiameter.
  // Old: R0 = totalDiameter / 4.49 → O(C) growth, 50 communities = 2200+ radius.
  // New: surface area packing → O(√C) growth. 4πR²/C ≥ π·avgR²·SEP² → R ≥ avgR·√C·SEP/2.
  const avgR = groupRadii.reduce((s, r) => s + r, 0) / C;
  const R0 = Math.max(avgR * Math.sqrt(C) * SEP * 1.2, 10);

  const centers = fibonacciSphere(C, R0);
  const cVel = new Float32Array(C * 3);

  for (let iter = 0; iter < COARSE_ITER; iter++) {
    if (signal?.aborted) break;

    for (let i = 0; i < C; i++) {
      for (let j = i + 1; j < C; j++) {
        const w = crossWeight[i][j] + crossWeight[j][i];
        if (w === 0) continue;
        const dx = centers[i * 3] - centers[j * 3];
        const dy = centers[i * 3 + 1] - centers[j * 3 + 1];
        const dz = centers[i * 3 + 2] - centers[j * 3 + 2];
        const dist = Math.max(0.1, Math.sqrt(dx * dx + dy * dy + dz * dz));
        const f = Math.min(w * ATT_A, dist * 0.5);
        const fx = (dx / dist) * f,
          fy = (dy / dist) * f,
          fz = (dz / dist) * f;
        cVel[i * 3] -= fx;
        cVel[i * 3 + 1] -= fy;
        cVel[i * 3 + 2] -= fz;
        cVel[j * 3] += fx;
        cVel[j * 3 + 1] += fy;
        cVel[j * 3 + 2] += fz;
      }
    }

    for (let i = 0; i < C; i++) {
      for (let j = i + 1; j < C; j++) {
        const dx = centers[i * 3] - centers[j * 3];
        const dy = centers[i * 3 + 1] - centers[j * 3 + 1];
        const dz = centers[i * 3 + 2] - centers[j * 3 + 2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const minDist = (groupRadii[i] + groupRadii[j]) * SEP;
        if (dist < minDist && dist > 0.001) {
          const push = (minDist - dist) / 2;
          const nx = dx / dist,
            ny = dy / dist,
            nz = dz / dist;
          centers[i * 3] += nx * push;
          centers[i * 3 + 1] += ny * push;
          centers[i * 3 + 2] += nz * push;
          centers[j * 3] -= nx * push;
          centers[j * 3 + 1] -= ny * push;
          centers[j * 3 + 2] -= nz * push;
          const vi = cVel[i * 3] * nx + cVel[i * 3 + 1] * ny + cVel[i * 3 + 2] * nz;
          const vj = cVel[j * 3] * nx + cVel[j * 3 + 1] * ny + cVel[j * 3 + 2] * nz;
          if (vi > 0) {
            cVel[i * 3] -= nx * vi;
            cVel[i * 3 + 1] -= ny * vi;
            cVel[i * 3 + 2] -= nz * vi;
          }
          if (vj < 0) {
            cVel[j * 3] -= nx * vj;
            cVel[j * 3 + 1] -= ny * vj;
            cVel[j * 3 + 2] -= nz * vj;
          }
        }
      }
    }

    for (let i = 0; i < C * 3; i++) {
      cVel[i] *= 0.9;
      centers[i] += cVel[i];
    }

    if (iter % 10 === 0) {
      let diverged = false;
      for (let i = 0; i < C * 3 && !diverged; i++) {
        if (!Number.isFinite(centers[i])) diverged = true;
      }
      if (diverged) {
        const fresh = fibonacciSphere(C, R0);
        for (let i = 0; i < C * 3; i++) {
          centers[i] = fresh[i];
          cVel[i] = 0;
        }
      }
    }
  }

  // ── Synthesize final positions ──
  const finalPos = new Float32Array(n * 3);
  for (let g = 0; g < C; g++) {
    const members = groupEntries[g][1];
    const localPos = localPositions[g];
    const cx = centers[g * 3],
      cy = centers[g * 3 + 1],
      cz = centers[g * 3 + 2];
    for (let li = 0; li < members.length; li++) {
      const gi = members[li];
      finalPos[gi * 3] = cx + localPos[li * 3];
      finalPos[gi * 3 + 1] = cy + localPos[li * 3 + 1];
      finalPos[gi * 3 + 2] = cz + localPos[li * 3 + 2];
    }
  }

  return finalPos;
}
