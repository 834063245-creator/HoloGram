// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// 深空全息星图 · Deep Space Holographic Star Chart
// 三模式：minimal | standard | full
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { iconHtml } from './icons';
import { bus } from './events';
import { t, getLang, setLang } from '../i18n';
import { gpuLayout } from './gpu-layout';

// ── Types ────────────────────────────────────────────────────

interface GraphNode {
  id: string; name: string; type?: string; kind?: string;
  location?: string; properties?: Record<string, unknown>;
}
interface GraphEdge {
  id: string; source: string; target: string; type?: string;
  properties?: Record<string, unknown>;
}
interface GraphJSON {
  nodes: GraphNode[] | Record<string, GraphNode>;
  edges: GraphEdge[] | Record<string, GraphEdge>;
  meta?: Record<string, unknown>;
}

interface EdgeData { s: number; t: number; couplingDepth: number; edgeType: string; direction: string; crossFile: boolean; }
interface CommunityData { id: string; label: string; node_ids: string[]; level?: number; parent_id?: string | null; }


// ── Color Palette ────────────────────────────────────────────

const NODE_COLORS: Record<string, number> = {
  symbol: 0x7eb8ff, SYMBOL: 0x7eb8ff,
  function: 0x8ec8ff, method: 0x8ec8ff,
  class: 0x6aadff, module: 0x7eb8ff,
  interface: 0x7eb8ff, variable: 0x94d0ff, constant: 0x94d0ff,
  medium: 0xf0c060, MEDIUM: 0xf0c060,
  file: 0xf0c060, database: 0xe8b84c, cache: 0xe8b84c, queue: 0xe8b84c,
  temporal: 0xc098ff, TEMPORAL: 0xc098ff,
  thread: 0xc098ff, timer: 0xb888f8, trigger: 0xb888f8,
};
const GLOW_COLORS: Record<string, number> = {
  symbol: 0x4488cc, SYMBOL: 0x4488cc,
  function: 0x4499dd, method: 0x4499dd,
  class: 0x3377bb, module: 0x4488cc,
  interface: 0x4488cc, variable: 0x55aadd, constant: 0x55aadd,
  medium: 0xcc8800, MEDIUM: 0xcc8800,
  file: 0xcc8800, database: 0xbb7700, cache: 0xbb7700, queue: 0xbb7700,
  temporal: 0x8855cc, TEMPORAL: 0x8855cc,
  thread: 0x8855cc, timer: 0x7744bb, trigger: 0x7744bb,
};

function edgeColorByType(edgeType: string, direction: string, crossFile = false): THREE.Color {
  const et = edgeType.toLowerCase();
  // Data edges — green read, red write, amber share
  if (et === 'reads') return new THREE.Color(0x66dd66);
  if (et === 'writes') return new THREE.Color(0xff7777);
  if (et === 'shares') return new THREE.Color(0xffaa44);
  // Temporal edges — orange
  if (et === 'triggers' || et === 'awaits' || et === 'sequences') return new THREE.Color(0xffaa55);
  // Backward-compat: old Python engine keywords
  if (et === 'data') return direction === 'write' ? new THREE.Color(0xff7777) : new THREE.Color(0x66dd66);
  if (et === 'temporal') return new THREE.Color(0xffaa55);
  // Inheritance — magenta
  if (et === 'inherits' || (crossFile && direction === 'inherit')) return new THREE.Color(0xff66ff);
  // Imports — subtle teal-blue
  if (et === 'imports') return new THREE.Color(0x5599cc);
  // Defines — slightly brighter blue
  if (et === 'defines') return new THREE.Color(0x5588cc);
  // Calls and everything else — structural blue
  return new THREE.Color(0x6699cc);
}
function edgeOpacityByDepth(depth: number): number {
  const m = 0.10; // dark-universe: subtle web, brightens on hover/highlight
  switch (depth) { case 1: return 0.015 * m; case 2: return 0.11 * m; case 3: return 0.17 * m; case 4: return 0.22 * m; default: return 0.08 * m; }
}

function hexToCSS(hex: number): string { return '#' + hex.toString(16).padStart(6, '0'); }

/** Deterministic hashed color from a community ID string. Same ID → same hue. */
function communityColor(communityId: string): number {
  let hash = 0;
  for (let i = 0; i < communityId.length; i++) {
    hash = ((hash << 5) - hash) + communityId.charCodeAt(i);
    hash |= 0; // 32-bit int
  }
  const hue = ((hash & 0x7fffffff) % 360) / 360;
  const color = new THREE.Color();
  color.setHSL(hue, 0.55, 0.52);
  return color.getHex();
}

const BG_COLOR = 0x030812;
const TYPE_LABELS: Record<string, string> = {
  symbol: 'SYM', function: 'FN', method: 'MTH', class: 'CLS',
  module: 'MOD', variable: 'VAR', constant: 'CST', interface: 'IFC',
  medium: 'MED', file: 'FILE', database: 'DB', cache: 'CACHE', queue: 'Q',
  temporal: 'TMP', thread: 'THR', timer: 'TIM', trigger: 'TRG',
};

// ── Glow Textures ─────────────────────────────────────────────

function createGlowTexture(): THREE.Texture {
  const size = 128, c = document.createElement('canvas');
  c.width = c.height = size; const ctx = c.getContext('2d')!;
  const h = size / 2;
  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.02, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.08, 'rgba(255,255,255,0.55)'); g.addColorStop(0.2, 'rgba(255,255,255,0.18)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.03)'); g.addColorStop(0.7, 'rgba(255,255,255,0.004)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

function createSpikeTexture(): THREE.Texture {
  const size = 256, c = document.createElement('canvas');
  c.width = c.height = size; const ctx = c.getContext('2d')!;
  const cx = size / 2, cy = size / 2;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.03, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.1, 'rgba(255,255,255,0.5)'); g.addColorStop(0.25, 'rgba(255,255,255,0.15)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.02)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3, sx = Math.cos(a), sy = Math.sin(a);
    const w = ctx.createLinearGradient(cx, cy, cx + sx * size * 0.45, cy + sy * size * 0.45);
    w.addColorStop(0, 'rgba(255,255,255,0.7)'); w.addColorStop(0.15, 'rgba(255,240,220,0.4)');
    w.addColorStop(0.5, 'rgba(255,200,150,0.08)'); w.addColorStop(1, 'transparent');
    ctx.fillStyle = w; ctx.beginPath();
    ctx.moveTo(cx + sx * 3, cy + sy * 3); ctx.lineTo(cx + sx * size * 0.48, cy + sy * size * 0.48);
    ctx.lineTo(cx - sy * 1.5, cy + sx * 1.5); ctx.lineTo(cx + sy * 1.5, cy - sx * 1.5); ctx.fill();
    const cg = ctx.createLinearGradient(cx, cy, cx - sx * size * 0.35, cy - sy * size * 0.35);
    cg.addColorStop(0, 'rgba(255,255,255,0.5)'); cg.addColorStop(0.15, 'rgba(200,220,255,0.3)');
    cg.addColorStop(0.5, 'rgba(150,180,255,0.05)'); cg.addColorStop(1, 'transparent');
    ctx.fillStyle = cg; ctx.beginPath();
    ctx.moveTo(cx - sx * 3, cy - sy * 3); ctx.lineTo(cx - sx * size * 0.38, cy - sy * size * 0.38);
    ctx.lineTo(cx + sy * 1.2, cy - sx * 1.2); ctx.lineTo(cx - sy * 1.2, cy + sx * 1.2); ctx.fill();
  }
  return new THREE.CanvasTexture(c);
}

// ── Fibonacci Sphere ─────────────────────────────────────────

function fibonacciSphere(n: number, radius: number): Float32Array {
  const pos = new Float32Array(n * 3), phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1 || 1)) * 2, r = Math.sqrt(1 - y * y), theta = phi * i;
    pos[i * 3] = Math.cos(theta) * r * radius;
    pos[i * 3 + 1] = y * radius;
    pos[i * 3 + 2] = Math.sin(theta) * r * radius;
  }
  return pos;
}

// ── 3D Force-Directed Layout ─────────────────────────────────
// ═══════════════════════════════════════════════════════════════
// Robustness-hardened: per-pair force caps, per-node velocity caps,
// per-node displacement caps, every-iteration NaN sampling,
// adaptive shell constraint, adaptive iteration budget.
// Core aesthetic parameters (rep, att, damp, shellRadius formula)
// are LOCKED — safety layers only, no tuning.
//
// v4.1 note: nodeComm parameter accepted but layout is uniform
// Fibonacci sphere for now — community-aware forces to be iterated
// with small, tested changes. Diagnostics from _renderImpl show
// whether community/directory grouping detected enough clusters.
// ═══════════════════════════════════════════════════════════════

// ── Single-cluster force simulation ──────────────────────────
// Extracted from layout3D — identical logic, parameterized shellRadius.
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
  const rep = 600, att = 0.018, damp = 0.72;
  const pos = fibonacciSphere(m, shellRadius);
  const vel = new Float32Array(m * 3);

  // ── Adaptive shell constraint — tighter for large graphs ──
  const sp = 0.006 + (m > 2000 ? 0.008 : 0) + (m > 4000 ? 0.006 : 0); // 0.006 / 0.014 / 0.020

  // ── Adaptive iteration budget — fewer for large graphs (O(n²) cost) ──
  const maxIter = Math.min(60, Math.max(15, 60 - Math.floor(m / 800)));

  // ── Safety caps (derived from shell, not tuned per-graph) ──
  const REP_CAP = shellRadius * 8;         // per-pair repulsion
  const ATT_CAP = shellRadius;             // per-pair attraction
  const VEL_CAP = shellRadius * 0.25;      // per-node velocity before damping

  // Yield every N iterations to keep the UI responsive
  const YIELD_EVERY = m > 4000 ? 2 : m > 1500 ? 3 : 5;

  for (let iter = 0; iter < maxIter; iter++) {
    // Abort if a newer render supersedes this one
    if (signal?.aborted) return pos;

    // ── Repulsion (all pairs) ──
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        const dx = pos[i * 3] - pos[j * 3], dy = pos[i * 3 + 1] - pos[j * 3 + 1], dz = pos[i * 3 + 2] - pos[j * 3 + 2];
        const dist = Math.max(0.3, Math.sqrt(dx * dx + dy * dy + dz * dz));
        const f = Math.min(rep / (dist * dist + 1), REP_CAP);
        vel[i * 3] += (dx / dist) * f; vel[i * 3 + 1] += (dy / dist) * f; vel[i * 3 + 2] += (dz / dist) * f;
        vel[j * 3] -= (dx / dist) * f; vel[j * 3 + 1] -= (dy / dist) * f; vel[j * 3 + 2] -= (dz / dist) * f;
      }
    }
    // ── Attraction (edges only) ──
    for (const [s, t] of localPairs) {
      const dx = pos[s * 3] - pos[t * 3], dy = pos[s * 3 + 1] - pos[t * 3 + 1], dz = pos[s * 3 + 2] - pos[t * 3 + 2];
      const dist = Math.max(0.3, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const f = Math.min(dist * att, ATT_CAP);
      vel[s * 3] -= (dx / dist) * f; vel[s * 3 + 1] -= (dy / dist) * f; vel[s * 3 + 2] -= (dz / dist) * f;
      vel[t * 3] += (dx / dist) * f; vel[t * 3 + 1] += (dy / dist) * f; vel[t * 3 + 2] += (dz / dist) * f;
    }
    // ── Origin attraction ──
    for (let i = 0; i < m; i++) {
      vel[i * 3] -= pos[i * 3] * 0.0004;
      vel[i * 3 + 1] -= pos[i * 3 + 1] * 0.0004;
      vel[i * 3 + 2] -= pos[i * 3 + 2] * 0.0004;
    }
    // ── Per-node velocity cap ──
    for (let i = 0; i < m; i++) {
      const vx = vel[i * 3], vy = vel[i * 3 + 1], vz = vel[i * 3 + 2];
      const vm = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (vm > VEL_CAP) { const s = VEL_CAP / vm; vel[i * 3] = vx * s; vel[i * 3 + 1] = vy * s; vel[i * 3 + 2] = vz * s; }
    }
    // ── Damping + position update ──
    for (let i = 0; i < m * 3; i++) { vel[i] *= damp; pos[i] += vel[i]; }
    // ── NaN detection (lightweight sampling every iter, full sweep every 5) ──
    if (iter % 5 === 0) {
      // Full sweep
      let diverged = false;
      for (let i = 0; i < m * 3 && !diverged; i++) {
        if (!isFinite(pos[i]) || !isFinite(vel[i])) diverged = true;
      }
      if (diverged) {
        const fresh = fibonacciSphere(m, shellRadius);
        for (let i = 0; i < m * 3; i++) { pos[i] = fresh[i]; vel[i] = 0; }
      }
    } else {
      // Sampling sweep — check √n random nodes
      const sample = Math.max(10, Math.floor(Math.sqrt(m)));
      let diverged = false;
      for (let k = 0; k < sample && !diverged; k++) {
        const i = (k * 2654435761 + iter * 0x9e3779b9) % m; // cheap pseudo-random
        const i3 = i * 3;
        if (!isFinite(pos[i3]) || !isFinite(pos[i3 + 1]) || !isFinite(pos[i3 + 2]) ||
            !isFinite(vel[i3]) || !isFinite(vel[i3 + 1]) || !isFinite(vel[i3 + 2])) {
          diverged = true;
        }
      }
      if (diverged) {
        const fresh = fibonacciSphere(m, shellRadius);
        for (let i = 0; i < m * 3; i++) { pos[i] = fresh[i]; vel[i] = 0; }
      }
    }
    // ── Shell constraint (adaptive strength) ──
    for (let i = 0; i < m; i++) {
      const dx = pos[i * 3], dy = pos[i * 3 + 1], dz = pos[i * 3 + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > 1) {
        const drift = (dist - shellRadius) * sp;
        pos[i * 3] -= (dx / dist) * drift;
        pos[i * 3 + 1] -= (dy / dist) * drift;
        pos[i * 3 + 2] -= (dz / dist) * drift;
      }
    }

    // Yield to event loop every N iterations to keep the UI responsive
    if (iter % YIELD_EVERY === YIELD_EVERY - 1 && iter < maxIter - 1) {
      await new Promise<void>(r => setTimeout(r, 0));
    }
  }
  return pos;
}

// ── 3D Force-Directed Layout ─────────────────────────────────
// ═══════════════════════════════════════════════════════════════
// Two-tier community-aware layout (v4.2):
//   Tier B — per-community force simulation (simulateForces, same params)
//   Tier A — cluster center placement with collision relaxation
// Degenerate case (≤1 community): falls back to single-ball simulateForces,
// behaviour identical to v4.1.
// ═══════════════════════════════════════════════════════════════

// ── Community clustering post-pass (GPU companion) ────────────
// After GPU N-body, compress intra-community + repel inter-community.
// O(n) per iteration, not O(n²). Gives tight clusters like CPU layout.
function pullCommunities(
  pos: Float32Array,
  n: number,
  nodeComm: number[],
  shellRadius: number,
): void {
  // Build community info
  const comms = new Map<number, { cx: number; cy: number; cz: number; cnt: number; nodes: number[] }>();
  for (let i = 0; i < n; i++) {
    const c = nodeComm[i];
    if (c < 0) continue;
    let cc = comms.get(c);
    if (!cc) { cc = { cx: 0, cy: 0, cz: 0, cnt: 0, nodes: [] }; comms.set(c, cc); }
    cc.cx += pos[i * 3]; cc.cy += pos[i * 3 + 1]; cc.cz += pos[i * 3 + 2];
    cc.cnt++;
    cc.nodes.push(i);
  }
  const commArr = [...comms.values()];
  for (const cc of commArr) {
    cc.cx /= cc.cnt; cc.cy /= cc.cnt; cc.cz /= cc.cnt;
  }

  const compressStr = 0.04;   // intra-community compression
  const repelStr = shellRadius * 0.002; // inter-community centroid repulsion

  for (let iter = 0; iter < 15; iter++) {
    // ── Compress: each node moves 8% toward its community centroid ──
    for (const cc of commArr) {
      for (const i of cc.nodes) {
        const dx = cc.cx - pos[i * 3];
        const dy = cc.cy - pos[i * 3 + 1];
        const dz = cc.cz - pos[i * 3 + 2];
        pos[i * 3] += dx * compressStr;
        pos[i * 3 + 1] += dy * compressStr;
        pos[i * 3 + 2] += dz * compressStr;
      }
    }
    // ── Recompute centroids after compression ──
    for (const cc of commArr) {
      cc.cx = 0; cc.cy = 0; cc.cz = 0;
      for (const i of cc.nodes) {
        cc.cx += pos[i * 3]; cc.cy += pos[i * 3 + 1]; cc.cz += pos[i * 3 + 2];
      }
      cc.cx /= cc.cnt; cc.cy /= cc.cnt; cc.cz /= cc.cnt;
    }
    // ── Repel centroids apart (O(C²) centroid-level, O(n) node apply) ──
    const dxArr = new Float32Array(commArr.length);
    const dyArr = new Float32Array(commArr.length);
    const dzArr = new Float32Array(commArr.length);
    for (let a = 0; a < commArr.length; a++) {
      let fx = 0, fy = 0, fz = 0;
      for (let b = 0; b < commArr.length; b++) {
        if (a === b) continue;
        const dx = commArr[a].cx - commArr[b].cx;
        const dy = commArr[a].cy - commArr[b].cy;
        const dz = commArr[a].cz - commArr[b].cz;
        const d = Math.max(0.1, Math.sqrt(dx * dx + dy * dy + dz * dz));
        const f = repelStr / (d + 1);
        fx += (dx / d) * f; fy += (dy / d) * f; fz += (dz / d) * f;
      }
      dxArr[a] = fx; dyArr[a] = fy; dzArr[a] = fz;
    }
    // Apply accumulated centroid displacement to all nodes once
    for (let a = 0; a < commArr.length; a++) {
      for (const i of commArr[a].nodes) {
        pos[i * 3] += dxArr[a];
        pos[i * 3 + 1] += dyArr[a];
        pos[i * 3 + 2] += dzArr[a];
      }
    }
  }
}

async function layout3D(
  n: number,
  edgePairs: [number, number][],
  signal?: AbortSignal,
  nodeComm?: number[] | null,
): Promise<Float32Array> {
  if (n === 0) return new Float32Array(0);

  // ── Count real communities ──
  const groupIds = nodeComm ? [...new Set(nodeComm.filter(c => c >= 0))] : [];

  // Degenerate: ≤1 community → single-ball
  if (groupIds.length <= 1) {
    return simulateForces(n, edgePairs, Math.cbrt(n) * 14, signal);
  }

  // ═══════════════════════════════════════════════════════════════
  // Multi-community: two-tier layout
  // ═══════════════════════════════════════════════════════════════

  // ── Build groups ──
  const groups = new Map<number, number[]>(); // commId → global indices
  for (const gid of groupIds) groups.set(gid, []);
  const UNASSIGNED = -2;
  groups.set(UNASSIGNED, []);

  for (let i = 0; i < n; i++) {
    const c = nodeComm![i];
    if (c >= 0) groups.get(c)!.push(i);
    else groups.get(UNASSIGNED)!.push(i);
  }
  if (groups.get(UNASSIGNED)!.length === 0) groups.delete(UNASSIGNED);

  const groupEntries = [...groups.entries()]; // [commId, globalIndices[]][]
  const C = groupEntries.length;
  if (C <= 1) return simulateForces(n, edgePairs, Math.cbrt(n) * 14, signal);

  // ── Tier B: per-community simulation ──
  const localPositions: Float32Array[] = new Array(C);
  const groupRadii: number[] = new Array(C);
  const globalToLocal: Int32Array[] = new Array(C);
  const nodeToGroup = new Int32Array(n).fill(-1); // global index → group index 0..C-1

  for (let g = 0; g < C; g++) {
    const members = groupEntries[g][1];
    const m = members.length;

    // Build global→local map
    const g2l = new Int32Array(n).fill(-1);
    for (let li = 0; li < m; li++) {
      g2l[members[li]] = li;
      nodeToGroup[members[li]] = g;
    }
    globalToLocal[g] = g2l;

    // Extract local edges (both ends in this group)
    const localPairs: [number, number][] = [];
    for (const [s, t] of edgePairs) {
      const ls = g2l[s], lt = g2l[t];
      if (ls >= 0 && lt >= 0) localPairs.push([ls, lt]);
    }

    const localShell = Math.cbrt(m) * 14;
    const localPos = await simulateForces(m, localPairs, localShell, signal);
    localPositions[g] = localPos;

    // Compute radius: p90 of distances from local centroid
    let cx = 0, cy = 0, cz = 0;
    for (let li = 0; li < m; li++) {
      cx += localPos[li * 3]; cy += localPos[li * 3 + 1]; cz += localPos[li * 3 + 2];
    }
    cx /= m; cy /= m; cz /= m;
    const dists: number[] = [];
    for (let li = 0; li < m; li++) {
      const dx = localPos[li * 3] - cx, dy = localPos[li * 3 + 1] - cy, dz = localPos[li * 3 + 2] - cz;
      dists.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    dists.sort((a, b) => a - b);
    groupRadii[g] = dists[Math.floor(dists.length * 0.9)] || localShell;

    // Abort check between communities (cheap, avoids wasted work)
    if (signal?.aborted) break;
  }

  // If aborted during Tier B, synthesize whatever we have so far
  if (signal?.aborted) {
    const partial = new Float32Array(n * 3);
    for (let g = 0; g < C; g++) {
      const lp = localPositions[g];
      if (!lp) continue; // community not yet simulated
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
  const SEP = 1.4;           // inter-cluster spacing multiplier (higher = more gaps)
  const COARSE_ITER = 400;   // cheap — C is only tens of groups
  const ATT_A = 0.01;        // cross-community attraction strength

  // Build cross-community edge weights
  const crossWeight: number[][] = Array.from({ length: C }, () => new Array(C).fill(0));
  for (const [s, t] of edgePairs) {
    const sg = nodeToGroup[s], tg = nodeToGroup[t];
    if (sg >= 0 && tg >= 0 && sg !== tg) crossWeight[sg][tg]++; // directed
  }

  // Initial spread radius from sum of diameters
  const totalDiameter = groupRadii.reduce((s, r) => s + 2 * r, 0);
  const R0 = Math.max(SEP * totalDiameter / (2 * Math.PI), 10);

  const centers = fibonacciSphere(C, R0);
  const cVel = new Float32Array(C * 3);

  for (let iter = 0; iter < COARSE_ITER; iter++) {
    if (signal?.aborted) break;

    // a) Mild attraction along cross-edges
    for (let i = 0; i < C; i++) {
      for (let j = i + 1; j < C; j++) {
        const w = crossWeight[i][j] + crossWeight[j][i];
        if (w === 0) continue;
        const dx = centers[i * 3] - centers[j * 3];
        const dy = centers[i * 3 + 1] - centers[j * 3 + 1];
        const dz = centers[i * 3 + 2] - centers[j * 3 + 2];
        const dist = Math.max(0.1, Math.sqrt(dx * dx + dy * dy + dz * dz));
        const f = Math.min(w * ATT_A, dist * 0.5); // cap: never pull more than half the gap
        const fx = (dx / dist) * f, fy = (dy / dist) * f, fz = (dz / dist) * f;
        cVel[i * 3] -= fx; cVel[i * 3 + 1] -= fy; cVel[i * 3 + 2] -= fz;
        cVel[j * 3] += fx; cVel[j * 3 + 1] += fy; cVel[j * 3 + 2] += fz;
      }
    }

    // b) Hard collision: push apart if dist < (r[i] + r[j]) * SEP
    for (let i = 0; i < C; i++) {
      for (let j = i + 1; j < C; j++) {
        const dx = centers[i * 3] - centers[j * 3];
        const dy = centers[i * 3 + 1] - centers[j * 3 + 1];
        const dz = centers[i * 3 + 2] - centers[j * 3 + 2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const minDist = (groupRadii[i] + groupRadii[j]) * SEP;
        if (dist < minDist && dist > 0.001) {
          const push = (minDist - dist) / 2;
          const nx = dx / dist, ny = dy / dist, nz = dz / dist;
          centers[i * 3] += nx * push;
          centers[i * 3 + 1] += ny * push;
          centers[i * 3 + 2] += nz * push;
          centers[j * 3] -= nx * push;
          centers[j * 3 + 1] -= ny * push;
          centers[j * 3 + 2] -= nz * push;
          // Dampen velocity along collision normal to prevent oscillation
          const vi = cVel[i * 3] * nx + cVel[i * 3 + 1] * ny + cVel[i * 3 + 2] * nz;
          const vj = cVel[j * 3] * nx + cVel[j * 3 + 1] * ny + cVel[j * 3 + 2] * nz;
          if (vi > 0) { cVel[i * 3] -= nx * vi; cVel[i * 3 + 1] -= ny * vi; cVel[i * 3 + 2] -= nz * vi; }
          if (vj < 0) { cVel[j * 3] -= nx * vj; cVel[j * 3 + 1] -= ny * vj; cVel[j * 3 + 2] -= nz * vj; }
        }
      }
    }

    // Mild damping + position update for centers
    for (let i = 0; i < C * 3; i++) { cVel[i] *= 0.9; centers[i] += cVel[i]; }

    // NaN guard for centers (every 10 iterations)
    if (iter % 10 === 0) {
      let diverged = false;
      for (let i = 0; i < C * 3 && !diverged; i++) {
        if (!isFinite(centers[i])) diverged = true;
      }
      if (diverged) {
        const fresh = fibonacciSphere(C, R0);
        for (let i = 0; i < C * 3; i++) { centers[i] = fresh[i]; cVel[i] = 0; }
      }
    }
  }

  // ── Synthesize final positions ──
  const finalPos = new Float32Array(n * 3);
  for (let g = 0; g < C; g++) {
    const members = groupEntries[g][1];
    const localPos = localPositions[g];
    const cx = centers[g * 3], cy = centers[g * 3 + 1], cz = centers[g * 3 + 2];
    for (let li = 0; li < members.length; li++) {
      const gi = members[li];
      finalPos[gi * 3] = cx + localPos[li * 3];
      finalPos[gi * 3 + 1] = cy + localPos[li * 3 + 1];
      finalPos[gi * 3 + 2] = cz + localPos[li * 3 + 2];
    }
  }

  return finalPos;
}

// ═══════════════════════════════════════════════════════════════
// StarGraph — 深空星图 (mode-aware from construction)
// ═══════════════════════════════════════════════════════════════

export class StarGraph {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private container: HTMLElement;
  private animId = 0;
  private starfield!: THREE.Points;
  private galaxyGroup = new THREE.Group(); // parent for full-mode rotation
  private nodeGroup = new THREE.Group();
  private edgeGroup = new THREE.Group();
  private highlightEdgeGroup = new THREE.Group();
  private legendEl!: HTMLDivElement;
  private sphereGeo: THREE.SphereGeometry;
  private glowTex: THREE.Texture;

  // Graph data
  private graphNodes: GraphNode[] = [];
  private nodePositions: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private deg: number[] = [];
  private edgeDataList: EdgeData[] = [];
  private maxDeg = 1;
  private neighborMap: number[][] = [];
  private edgeIndexOf: number[][] = [];
  private nodeLabelIdx: number[] = [];
  private l34Count: number[] = [];

  // Meshes
  private nodeCores: THREE.Mesh[] = [];
  private nodeGlows: THREE.Sprite[] = [];
  private nodeGlowColors: number[] = [];
  private nodeCoreColors: number[] = [];
  private edgeLineGroups: THREE.LineSegments[] = [];
  private colorMode: 'type' | 'community' | 'coupling' = 'type';
  private scaleMode: 'degree' | 'coupling' = 'degree';

  // Full-FX extras
  private twinklePhases: number[] = [];
  private twinkleSpeeds: number[] = [];
  private edgeParticles!: THREE.Points;
  private edgeParticleData: { edgeIdx: number; t: number; speed: number; dir: number }[] = [];
  private nodeGlows2: THREE.Sprite[] = []; // second glow layer (full mode)

  // Minimap
  private minimapCanvas!: HTMLCanvasElement;
  private minimapCtx!: CanvasRenderingContext2D;
  private _mmDragging = false;
  private _mmOffX = 0; private _mmOffY = 0;

  // Diagnostics
  private _diagMsg = '';

  // Diff overlay (P4: 变更回看着色)
  private diffActive = false;
  private diffAddedIds = new Set<string>();
  private diffRemovedIds = new Set<string>();
  private diffModifiedIds = new Set<string>();

  // Hover
  private raycaster: THREE.Raycaster;
  private mouse = new THREE.Vector2(-999, -999);
  private hoveredIdx = -1;
  private hoveredGalaxyIdx = -1;
  private hoverScale = 0;
  private targetHoverScale = 0;

  // Labels
  private labelsContainer!: HTMLDivElement;
  private labelDivs: HTMLDivElement[] = [];

  // Tooltip & Detail card
  private tooltipEl!: HTMLDivElement;
  private detailCard!: HTMLDivElement;
  private selectedIdx = -1;

  // Graph spatial scale — p95 radius from center, set after layout.
  // Used for camera zoom range only (no LOD).
  private _graphRadius = 1000;

  // Camera reset — store initial view
  private _initCamPos = new THREE.Vector3();
  private _initCamTarget = new THREE.Vector3(0, 0, 0);

  // Focus
  private focusTarget = new THREE.Vector3();
  private focusActive = false;
  private focusProgress = 0;
  private focusNodeIdx = -1;

  // Focus subgraph (detail-card button triggered)
  private focusSubgraphActive = false;
  private focusSubgraphIdx = -1;
  private focusSubgraphVisibleIndices = new Set<number>();
  private focusSubgraphBanner!: HTMLDivElement;
  private focusSubgraphSavedGlowOpacities: number[] = [];
  private focusSubgraphSavedCoreVisible: boolean[] = [];
  private focusSubgraphSavedEdgeOpacities: number[] = [];
  private focusStartCam = new THREE.Vector3();
  private focusStartLook = new THREE.Vector3();
  private focusFlash = 0;

  // File highlight (from file tree)
  private _fileHighlight = false;
  private _fileHighlightIndices = new Set<number>();
  private _fileOpacityOriginal = new Map<number, number>();
  private _agentHighlightIndices = new Set<number>();

  // Step 2: Agent lens & trail
  private _lensActive = false;
  private _lensOriginalOpacities: Map<number, number> | null = null;
  private _trailLine: THREE.LineSegments | null = null;

  // Blast
  private blastMode = false;
  private blastSource = -1;
  private blastDistances: number[] = [];
  private blastMaxDist = 3; // Reduced from 8 to 3 for more focused impact analysis
  private blastEdgeType: string = 'all'; // 'all', 'structural', 'data', 'temporal'
  private blastDirection: string = 'both'; // 'both', 'outbound', 'inbound'

  // Incremental-update abort: cancel in-flight layout when new data arrives
  private _layoutAbort: AbortController | null = null;

  // ── Community / Galaxy fold overlay ──────────────────────
  private foldMode = false;
  private enteredGalaxyId: string | null = null;             // null=universe, string=inside a galaxy
  private enteredSubCommunityId: string | null = null;       // null=whole galaxy, string=drilled into sub-community
  private _drillStack: string[] = [];                        // multi-level sub-community drill path (top = current)
  private communities: CommunityData[] = [];
  private nodeCommMap = new Map<number, string>();           // nodeIdx → communityId
  private _subCommByNodeIdx = new Map<number, string>();     // nodeIdx → subCommunityId (inside constellation)
  private commFoldGroup = new THREE.Group();                 // galaxy clouds + constellation edges
  // Galaxy cloud data (computed after layout)
  private galaxyMeta: { id: string; label: string; centroid: THREE.Vector3; memberIndices: number[]; radius: number }[] = [];
  private communityRingGroup = new THREE.Group();
  private galaxyClouds: THREE.Points[] = [];
  private galaxyGlows: THREE.Sprite[] = [];

  // Post-processing (full mode only)
  private composer!: EffectComposer;
  private bloomPass!: UnrealBloomPass;

  // Animation
  private pulseTime = 0;
  private tmpVec3 = new THREE.Vector3();
  // Idle detection — throttle expensive per-frame work when nothing changes
  private _idleCounter = 0;
  private _lastCamPos = new THREE.Vector3();
  private _lastCamTarget = new THREE.Vector3();

  private readonly mode = 'full';

  constructor(container: HTMLElement) {
    this.container = container;

    const bg = false ? 0x000005 : BG_COLOR;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(bg);
    // No fog — dark-universe rendering handles depth through contrast, not distance blur

    this.camera = new THREE.PerspectiveCamera(40, 2, 0.5, 500000); // near/far widened after layout

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.4;
    container.appendChild(this.renderer.domElement);

    // ── Post-processing pipeline ──
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      0.35,  // strength — low default, bright objects still bloom on hover
      0.3,   // radius — tight bloom, no global glow fog
      0.85,  // threshold — only bright things bloom (hover highlights)
    );
    this.composer.addPass(this.bloomPass);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;       // quick stop
    this.controls.rotateSpeed = 0.5;          // halved — no whip
    this.controls.zoomSpeed = 1.0;            // responsive zoom
    this.controls.screenSpacePanning = true;  // right-drag to pan = recenter orbit target
    this.controls.minDistance = 5;
    this.controls.maxDistance = 12000;
    this.controls.maxDistance = 4000;

    this.glowTex = createSpikeTexture();
    this.sphereGeo = new THREE.SphereGeometry(1, 24, 16);

    // starfield disabled
    // if (true) this.buildStarfield();
    // nebulaDust disabled
    // if (mode === 'full') this.buildNebulaDust();

    if (true) this.buildHoloGrid();

    this.galaxyGroup.add(this.edgeGroup);
    this.galaxyGroup.add(this.highlightEdgeGroup);
    this.galaxyGroup.add(this.nodeGroup);
    this.galaxyGroup.add(this.commFoldGroup);
    this.galaxyGroup.add(this.communityRingGroup);
    this.scene.add(this.galaxyGroup);

    this.raycaster = new THREE.Raycaster();
    this.setupHover();
    this.setupTooltip();
    this.setupDetailCard();
    this.setupSelectRect();
    this.setupPromptBar();

    // Labels container (not in minimal mode — but always create, hide via CSS)
    this.labelsContainer = document.createElement('div');
    this.labelsContainer.id = 'graph-labels';
    if (false) this.labelsContainer.style.display = 'none';
    this.container.appendChild(this.labelsContainer);

    // Minimap — draggable radar overview
    this.minimapCanvas = document.createElement('canvas');
    this.minimapCanvas.id = 'graph-minimap';
    this.minimapCanvas.width = 260; this.minimapCanvas.height = 180;
    this.minimapCanvas.style.cssText = 'position:absolute;bottom:12px;right:12px;border:1px solid rgba(255,255,255,0.18);border-radius:6px;background:rgba(3,8,18,0.85);cursor:grab;z-index:10;';
    this.container.appendChild(this.minimapCanvas);
    this._setupMinimapDrag();
    this.minimapCtx = this.minimapCanvas.getContext('2d')!;

    this.buildLegend();
    this.buildFocusBanner();

    // Rebuild legend + focus banner on language change
    this._langHandler = ({ lang }: { lang: string }) => {
      setLang(lang as 'zh' | 'en');
      // Remove old DOM elements before rebuilding
      if (this.legendEl) { this.legendEl.remove(); }
      this.buildLegend();
      if (this.graphNodes.length > 0) this.legendEl.style.display = '';
      if (this.focusSubgraphBanner) { this.focusSubgraphBanner.remove(); }
      this.buildFocusBanner();
      if (this.focusSubgraphActive && this.focusSubgraphIdx >= 0) {
        // Refresh focus banner text while staying in focus mode
        const node = this.graphNodes[this.focusSubgraphIdx];
        this.focusSubgraphBanner.innerHTML =
          `${iconHtml('focus', 14)} <b>${t('focus.title')}: ${node.name}</b> &middot; ${this.focusSubgraphVisibleIndices.size} ${t('focus.nodes')} &middot; ${t('focus.exit')}`;
        this.focusSubgraphBanner.style.display = 'flex';
      }
    };
    bus.on('lang:changed', this._langHandler);
    let pointerDown = new THREE.Vector2();
    let pointerDragged = false;
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      pointerDown.set(e.clientX, e.clientY);
      pointerDragged = false;
      // Step 3: Alt+left-drag → rectangle selection
      if (e.altKey && e.button === 0) {
        this._selecting = true;
        this._selectStart.set(e.clientX, e.clientY);
        this._selectEnd.set(e.clientX, e.clientY);
        this._showSelectRect();
        this.controls.enabled = false;
        e.preventDefault();
        e.stopPropagation();
      }
    });
    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (this._selecting) {
        this._selectEnd.set(e.clientX, e.clientY);
        this._updateSelectRect();
        return;
      }
      if (Math.abs(e.clientX - pointerDown.x) > 4 || Math.abs(e.clientY - pointerDown.y) > 4) {
        pointerDragged = true;
      }
    });
    canvas.addEventListener('pointerup', (e: PointerEvent) => {
      // Step 3: Alt+drag selection complete
      if (this._selecting) {
        this._selecting = false;
        this._hideSelectRect();
        this.controls.enabled = true;
        this._handleRegionSelect();
        return;
      }
      if (pointerDragged) return;
      // Step 3: Shift+click → quick path mode
      if (e.shiftKey) {
        this._handleShiftClick(e);
        return;
      }
      this.onClick(e);
    });
    // Prevent browser context menu on canvas
    canvas.addEventListener('contextmenu', (e: Event) => e.preventDefault());
    this._onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (this.focusSubgraphActive) { this.exitFocusSubgraph(); return; }
        if (this._promptBarEl?.style.display === 'flex') { this._hidePrompt(); return; }
        if (this._selecting) { this._selecting = false; this._hideSelectRect(); this.controls.enabled = true; return; }
        if (this._shiftSourceIdx >= 0) { this._clearShiftPath(); return; }
        if (this._pathSource >= 0) { this.clearPath(); e.stopImmediatePropagation(); return; }
        if (this.enteredSubCommunityId) { this.exitSubCommunity(); return; }
        if (this.enteredGalaxyId) { this.exitGalaxy(); return; }
        // In universe fold view: ESC exits fold mode
        if (this.foldMode) { this.setFoldMode(false); return; }
        if (this.blastMode) { this.exitBlastMode(); return; }
      }
      if (e.key === 'b' || e.key === 'B') {
        if (this.blastMode) { this.exitBlastMode(); }
        else if (this.hoveredIdx >= 0) { this.startBlastMode(this.hoveredIdx); }
        else if (this.selectedIdx >= 0) { this.startBlastMode(this.selectedIdx); }
      }
    };
    window.addEventListener('keydown', this._onKeyDown);

    this.onResize();
    window.addEventListener('resize', this.onResize);
    this.animate();

    // Kick off WebGPU compute pipeline init (non-blocking)
    gpuLayout.init().then(ready => {
      if (ready) console.log('[StarGraph] GPU layout ready');
    }).catch(() => { /* GPU init failure is non-critical; CPU fallback used */ });
  }

  // ── Cross-edge energy flow (fold mode) ──────────────────
  private crossFlowParticles!: THREE.Points;
  private crossFlowData: { segIdx: number; t: number; speed: number }[] = [];
  private crossFlowSegments: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }[] = [];

  // ── Starfield ────────────────────────────────────────────

  // ── Nebula dust (full mode) ──────────────────────────────
  private nebulaDust!: THREE.Points;
  private nebulaPhases: number[] = [];

  private buildNebulaDust(): void {
    const count = 300;
    const posArr = new Float32Array(count * 3);
    const colArr = new Float32Array(count * 3);
    const rMin = 80, rMax = 900;
    for (let i = 0; i < count; i++) {
      const r = rMin + Math.random() * (rMax - rMin);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      posArr[i * 3] = Math.cos(theta) * Math.sin(phi) * r;
      posArr[i * 3 + 1] = Math.sin(phi) * r * 0.4;
      posArr[i * 3 + 2] = Math.sin(theta) * Math.sin(phi) * r;
      // Deep space colors: purple, teal, amber
      const hues = [0.6, 0.65, 0.7, 0.55, 0.12, 0.08]; // purples, teals, warm ambers
      const hue = hues[Math.floor(Math.random() * hues.length)];
      const c = new THREE.Color(); c.setHSL(hue, 0.6, 0.5 + Math.random() * 0.3);
      colArr[i * 3] = c.r; colArr[i * 3 + 1] = c.g; colArr[i * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    const mat = new THREE.PointsMaterial({
      size: 18, map: this.glowTex, blending: THREE.AdditiveBlending,
      depthWrite: false, vertexColors: true, transparent: true, opacity: 0.12,
    });
    this.nebulaDust = new THREE.Points(geo, mat);
    this.nebulaPhases = new Array(count).fill(0).map(() => Math.random() * Math.PI * 2);
    this.scene.add(this.nebulaDust);
  }

  private animateNebulaDust(): void {
    if (!this.nebulaDust) return;
    this.nebulaDust.rotation.y += 0.0001;
    this.nebulaDust.rotation.x += 0.00005;
    // Subtle opacity pulse
    const op = 0.08 + Math.sin(this.pulseTime * 0.2) * 0.04;
    (this.nebulaDust.material as THREE.PointsMaterial).opacity = op;
  }

  private buildStarfield(): void {
    const isFull = true;
    const count = isFull ? 4000 : 2200;
    const posArr = new Float32Array(count * 3), colArr = new Float32Array(count * 3);
    const layers = isFull ? [
      { r: [600, 1400], n: 600, hue: [200, 240], sat: 0.5, l: [0.4, 0.7] },
      { r: [300, 800], n: 1200, hue: [190, 220], sat: 0.35, l: [0.5, 0.85] },
      { r: [80, 450], n: 1200, hue: [180, 210], sat: 0.25, l: [0.65, 1.0] },
      { r: [15, 250], n: 1000, hue: [25, 55], sat: 0.55, l: [0.7, 1.0] },
    ] : [
      { r: [500, 1000], n: 300, hue: [210, 230], sat: 0.4, l: [0.5, 0.8] },
      { r: [250, 600], n: 700, hue: [200, 220], sat: 0.3, l: [0.6, 0.9] },
      { r: [60, 350], n: 700, hue: [190, 210], sat: 0.2, l: [0.7, 1.0] },
      { r: [10, 180], n: 500, hue: [30, 50], sat: 0.5, l: [0.7, 0.95] },
    ];
    let idx = 0;
    for (const L of layers) {
      for (let i = 0; i < L.n && idx < count; i++) {
        const theta = Math.random() * Math.PI * 2, phi = Math.acos(2 * Math.random() - 1);
        const r = L.r[0] + Math.random() * (L.r[1] - L.r[0]);
        posArr[idx * 3] = Math.cos(theta) * Math.sin(phi) * r;
        posArr[idx * 3 + 1] = Math.sin(phi) * r; // spherical
        posArr[idx * 3 + 2] = Math.sin(theta) * Math.sin(phi) * r;
        const hsl = new THREE.Color();
        hsl.setHSL((L.hue[0] + Math.random() * (L.hue[1] - L.hue[0])) / 360, L.sat, L.l[0] + Math.random() * (L.l[1] - L.l[0]));
        colArr[idx * 3] = hsl.r; colArr[idx * 3 + 1] = hsl.g; colArr[idx * 3 + 2] = hsl.b;
        idx++;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    const mat = new THREE.PointsMaterial({ size: 2.2, map: this.glowTex, blending: THREE.AdditiveBlending, depthWrite: false, vertexColors: true, transparent: true, opacity: 1.0 });
    this.starfield = new THREE.Points(geo, mat);
    this.scene.add(this.starfield);
  }

  // ── Infinite holographic grid (shader-based) ──────────────
  private holoGrid!: THREE.Mesh;
  private holoGridY = -60;

  private buildHoloGrid(): void {
    const gridSize = 60; // world-unit spacing of major grid lines

    const vert = /* glsl */ `
      varying vec3 vWorldPos;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

    const frag = /* glsl */ `
      varying vec3 vWorldPos;
      uniform vec3 uCameraWorldPos;
      uniform float uGridSize;
      uniform float uFadeDist;

      float gridLine(float coord, float size, float w) {
        float d = abs(mod(coord + size * 0.5, size) - size * 0.5);
        return 1.0 - smoothstep(0.0, w, d);
      }

      void main() {
        float majorSize = uGridSize;
        float minorSize = majorSize / 5.0;

        // Major grid lines
        float mx = gridLine(vWorldPos.x, majorSize, 0.5);
        float mz = gridLine(vWorldPos.z, majorSize, 0.5);
        float major = max(mx, mz);

        // Minor grid lines (don't overlap majors)
        float nx = gridLine(vWorldPos.x, minorSize, 0.25);
        float nz = gridLine(vWorldPos.z, minorSize, 0.25);
        float minor = max(nx, nz) * (1.0 - major);

        // Fade with world-space distance from camera
        float dist = length(vWorldPos.xz - uCameraWorldPos.xz);
        float fade = 1.0 - smoothstep(uFadeDist * 0.4, uFadeDist, dist);

        float alpha = (major * 0.15 + minor * 0.05) * fade;
        gl_FragColor = vec4(0.15, 0.3, 0.5, alpha);
      }
    `;

    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uCameraWorldPos: { value: new THREE.Vector3() },
        uGridSize: { value: gridSize },
        uFadeDist: { value: 1800 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // Huge plane on XZ (rotated flat)
    const geo = new THREE.PlaneGeometry(20000, 20000);
    geo.rotateX(-Math.PI / 2);
    this.holoGrid = new THREE.Mesh(geo, mat);
    this.holoGrid.position.y = this.holoGridY;
    this.holoGrid.renderOrder = 1;
    this.scene.add(this.holoGrid);
  }

  private positionGrid(pos: Float32Array): void {
    if (!this.holoGrid) return;
    let minY = Infinity;
    for (let i = 0; i < pos.length / 3; i++) {
      minY = Math.min(minY, pos[i * 3 + 1]);
    }
    this.holoGridY = minY - 40;
    this.holoGrid.position.y = this.holoGridY;
  }

  // ── Tooltip ──────────────────────────────────────────────

  private setupTooltip(): void {
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.id = 'graph-tooltip';
    this.tooltipEl.innerHTML = '<div class="tt-name"></div><div class="tt-meta"></div><div class="tt-loc"></div>';
    this.container.appendChild(this.tooltipEl);
  }

  private updateTooltip(): void {
    // Galaxy hover takes priority — tooltip already set by updateHover()
    if (this.foldMode && this.hoveredGalaxyIdx >= 0) return;
    if (this.hoveredIdx < 0 || this.hoveredIdx >= this.graphNodes.length) { this.tooltipEl.classList.remove('visible'); return; }
    const node = this.graphNodes[this.hoveredIdx];
    const kind = ((node.type || node.kind || 'symbol') as string).toLowerCase();
    this.tooltipEl.querySelector('.tt-name')!.textContent = node.name;
    const metaEl = this.tooltipEl.querySelector('.tt-meta')!;
    let metaText = `${TYPE_LABELS[kind] || kind.toUpperCase()} · 度 ${this.deg[this.hoveredIdx]}`;
    // Show community context in all views when available
    const cid = this.nodeCommMap.get(this.hoveredIdx);
    if (cid) {
      const comm = this.communities.find(c => c.id === cid);
      const commLabel = comm ? comm.label.split('/')[0].replace(/_/g, ' ') : cid;
      metaText += ` · 🌌 ${commLabel}`;
    }
    metaEl.textContent = metaText;
    (metaEl as HTMLElement).dataset['kind'] = kind;
    this.tooltipEl.querySelector('.tt-loc')!.textContent = node.location || '';
    const i = this.hoveredIdx;
    this.tmpVec3.set(this.nodePositions[i * 3], this.nodePositions[i * 3 + 1], this.nodePositions[i * 3 + 2]);
    this.tmpVec3.project(this.camera);
    if (this.tmpVec3.z > 1) { this.tooltipEl.classList.remove('visible'); return; }
    const x = (this.tmpVec3.x * 0.5 + 0.5) * this.container.clientWidth;
    const y = (-this.tmpVec3.y * 0.5 + 0.5) * this.container.clientHeight;
    this.tooltipEl.style.left = `${x + 18}px`; this.tooltipEl.style.top = `${y - 10}px`;
    this.tooltipEl.classList.add('visible');
  }

  // ── Detail Card ──────────────────────────────────────────

  private setupDetailCard(): void {
    this.detailCard = document.createElement('div');
    this.detailCard.id = 'detail-card';
    this.detailCard.innerHTML =
      `<button class="dc-close">${iconHtml('close', 12)}</button>` +
      '<div class="dc-name"></div><div class="dc-meta"></div><div class="dc-divider"></div>' +
      '<div class="dc-coupling"></div><div class="dc-divider"></div>' +
      '<div class="dc-location"></div>' +
      `<div class="dc-actions"><button class="dc-open-btn">${iconHtml('file', 11)} 打开</button><button class="dc-agent-btn">${iconHtml('agent', 11)} 问 Agent</button><button class="dc-blast-btn">${iconHtml('blast', 11)} 波及</button><button class="dc-focus-btn">${iconHtml('focus', 11)} 聚焦</button></div>` +
      '<div class="dc-blast-filters" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid #333;">' +
      '<div style="font-size:11px;color:#888;margin-bottom:4px;">边类型过滤:</div>' +
      '<div class="dc-blast-type-btns" style="display:flex;gap:4px;flex-wrap:wrap;">' +
      '<button class="dc-blast-type-btn" data-type="all" style="padding:2px 6px;font-size:10px;background:#444;border:1px solid #666;border-radius:3px;cursor:pointer;">全部</button>' +
      '<button class="dc-blast-type-btn" data-type="structural" style="padding:2px 6px;font-size:10px;background:#333;border:1px solid #555;border-radius:3px;cursor:pointer;">结构</button>' +
      '<button class="dc-blast-type-btn" data-type="data" style="padding:2px 6px;font-size:10px;background:#333;border:1px solid #555;border-radius:3px;cursor:pointer;">数据</button>' +
      '<button class="dc-blast-type-btn" data-type="temporal" style="padding:2px 6px;font-size:10px;background:#333;border:1px solid #555;border-radius:3px;cursor:pointer;">时间</button>' +
      '</div>' +
      '<div style="font-size:11px;color:#888;margin-top:6px;margin-bottom:4px;">方向过滤:</div>' +
      '<div class="dc-blast-dir-btns" style="display:flex;gap:4px;flex-wrap:wrap;">' +
      '<button class="dc-blast-dir-btn" data-dir="both" style="padding:2px 6px;font-size:10px;background:#444;border:1px solid #666;border-radius:3px;cursor:pointer;">双向</button>' +
      '<button class="dc-blast-dir-btn" data-dir="outbound" style="padding:2px 6px;font-size:10px;background:#333;border:1px solid #555;border-radius:3px;cursor:pointer;">出向</button>' +
      '<button class="dc-blast-dir-btn" data-dir="inbound" style="padding:2px 6px;font-size:10px;background:#333;border:1px solid #555;border-radius:3px;cursor:pointer;">入向</button>' +
      '</div>' +
      '</div>';
    this.container.appendChild(this.detailCard);
    this.detailCard.querySelector('.dc-close')!.addEventListener('click', (e) => { e.stopPropagation(); this.hideDetail(); });
    this.detailCard.querySelector('.dc-focus-btn')!.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (this.selectedIdx >= 0) { const idx = this.selectedIdx; this.hideDetail(); this.enterFocusSubgraph(idx); }
    });
    this.detailCard.querySelector('.dc-blast-btn')!.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (this.selectedIdx >= 0) this.startBlastMode(this.selectedIdx);
    });
    // Blast filter: show/hide filters panel when blast mode is active
    this.detailCard.querySelector('.dc-blast-btn')!.addEventListener('contextmenu', (e) => {
      e.stopPropagation(); e.preventDefault();
      const panel = this.detailCard.querySelector('.dc-blast-filters') as HTMLElement;
      if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    // Blast filter: edge type buttons
    this.detailCard.querySelectorAll('.dc-blast-type-btn').forEach(btn => {
      btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        this.blastEdgeType = (btn as HTMLElement).dataset.type || 'all';
        this.detailCard.querySelectorAll('.dc-blast-type-btn').forEach(b => {
          (b as HTMLElement).style.background = b === btn ? '#444' : '#333';
          (b as HTMLElement).style.borderColor = b === btn ? '#666' : '#555';
        });
        if (this.blastMode) { this.computeBlastDistances(); this.buildBlastEdges(); this.updateBlastNodeColors(); }
      });
    });
    // Blast filter: direction buttons
    this.detailCard.querySelectorAll('.dc-blast-dir-btn').forEach(btn => {
      btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        this.blastDirection = (btn as HTMLElement).dataset.dir || 'both';
        this.detailCard.querySelectorAll('.dc-blast-dir-btn').forEach(b => {
          (b as HTMLElement).style.background = b === btn ? '#444' : '#333';
          (b as HTMLElement).style.borderColor = b === btn ? '#666' : '#555';
        });
        if (this.blastMode) { this.computeBlastDistances(); this.buildBlastEdges(); this.updateBlastNodeColors(); }
      });
    });
    this.detailCard.querySelector('.dc-open-btn')!.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (this.selectedIdx >= 0) {
        const node = this.graphNodes[this.selectedIdx];
        if (node.location) {
          const loc = node.location;
          const lastColon = loc.lastIndexOf(':');
          const filePath = lastColon > 1 ? loc.substring(0, lastColon) : loc;
          import('./events').then(m => m.bus.emit('navigate:file', filePath)).catch(() => {});
        }
      }
    });
    this.detailCard.querySelector('.dc-agent-btn')!.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (this.selectedIdx >= 0) {
        const node = this.graphNodes[this.selectedIdx];
        const kind = ((node.type || node.kind || 'symbol') as string).toLowerCase();
        const question = `分析节点 "${node.name}" (${TYPE_LABELS[kind] || kind}, 度=${this.deg[this.selectedIdx]}, ${node.location || '未知位置'})。它和其他模块的关系如何？改它会有什么影响？`;
        // Emit event to ChatPanel via bus
        import('./events').then(m => m.bus.emit('agent:query', question)).catch(() => {});
      }
    });
  }

  private onClick(e: MouseEvent): void {
    if (this.nodeCores.length === 0) return;
    const rect = this.container.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(mx, my), this.camera);

    // Helper: intersect galaxy core sprites and return the community id
    const hitCloudId = (): string | null => {
      const coreSprites = this.galaxyGlows.filter((_, i) => i % 2 === 1);
      const hits = this.raycaster.intersectObjects(coreSprites);
      if (hits.length > 0) {
        return (hits[0].object.userData['galaxyId'] as string) || null;
      }
      return null;
    };

    // In universe view: click galaxy cloud → enterGalaxy
    if (this.foldMode && !this.enteredGalaxyId) {
      const cid = hitCloudId();
      if (cid) { this.enterGalaxy(cid); }
      return;
    }

    // Inside a galaxy or sub-community: dispatch based on whether we're in cloud or constellation view
    if (this.foldMode && this.enteredGalaxyId) {
      // Current parent is the deepest sub-community, or the galaxy itself
      const activeParentId = this._drillStack.length > 0
        ? this._drillStack[this._drillStack.length - 1]
        : this.enteredGalaxyId;

      // Check if current parent has sub-communities (→ cloud view) or not (→ constellation view)
      if (this._hasVisibleSubCommunities(activeParentId)) {
        // Cloud view: click sub-cloud → enterSubCommunity
        const cid = hitCloudId();
        if (cid) { this.enterSubCommunity(cid); }
        return;
      }
    }

    // Intersect ALL node cores (ignore .visible — hover/click should always work)
    const hits = this.raycaster.intersectObjects(this.nodeCores);
    const idx = hits.length > 0 ? this.nodeCores.indexOf(hits[0].object as THREE.Mesh) : -1;

    if (idx >= 0 && idx !== this.selectedIdx) this.showDetail(idx);
    else if (idx < 0) this.hideDetail();
    else if (idx < 0) this.hideDetail();

    // Step 3: Emit graph:node-clicked (for external interaction handlers)
    if (idx >= 0 && idx < this.graphNodes.length) {
      const node = this.graphNodes[idx];
      bus.emit('graph:node-clicked', {
        nodeName: node.name,
        nodeType: (node.type || node.kind || 'symbol') as string,
        nodeId: node.id,
        degree: this.deg[idx] || 0,
        location: node.location || '',
      });
    }
  }

  private showDetail(idx: number): void {
    this.selectedIdx = idx;
    const node = this.graphNodes[idx];
    // Emit file path for file tree ↔ graph linking
    if (node.location) {
      const filePath = node.location.indexOf(':') >= 0
        ? node.location.substring(0, node.location.lastIndexOf(':'))
        : node.location;
      window.dispatchEvent(new CustomEvent('graph:node-selected', { detail: filePath }));
    }
    const kind = ((node.type || node.kind || 'symbol') as string).toLowerCase();
    const dist = [0, 0, 0, 0, 0];
    for (const e of this.edgeDataList) { if (e.s === idx || e.t === idx) dist[e.couplingDepth] = (dist[e.couplingDepth] || 0) + 1; }
    const maxDist = Math.max(...dist, 1);
    this.detailCard.querySelector('.dc-name')!.textContent = node.name;
    const metaEl = this.detailCard.querySelector('.dc-meta')!;
    metaEl.textContent = `${TYPE_LABELS[kind] || kind.toUpperCase()} · 度 ${this.deg[idx]}${this.deg[idx] >= 10 ? ' · hub' : ''}`;
    (metaEl as HTMLElement).dataset['kind'] = kind;
    const bars = [
      { label: 'L1 公开API', v: dist[1], cls: 'l1' }, { label: 'L2 内部导入', v: dist[2], cls: 'l2' },
      { label: 'L3 共享数据', v: dist[3], cls: 'l3' }, { label: 'L4 封装穿透', v: dist[4], cls: 'l4' },
    ];
    this.detailCard.querySelector('.dc-coupling')!.innerHTML = bars.filter(b => b.v > 0).map(b => {
      const pct = Math.round((b.v / maxDist) * 100);
      const warn = b.cls === 'l3' ? ` ${iconHtml('alert', 10)}` : b.cls === 'l4' ? ` ${iconHtml('block', 10)}` : '';
      return `<div class="dc-bar-row"><span class="dc-bar-label">${b.label}</span><span class="dc-bar-count">${b.v} 条</span><span class="dc-bar-track"><span class="dc-bar-fill ${b.cls}" style="width:${pct}%"></span></span>${warn}</div>`;
    }).join('') || '<div class="dc-empty">无耦合边</div>';
    this.detailCard.querySelector('.dc-location')!.textContent = node.location || '';
    const openBtn = this.detailCard.querySelector('.dc-open-btn') as HTMLButtonElement;
    if (openBtn) openBtn.style.display = node.location ? '' : 'none';
    this.positionDetailCard(idx);
    this.detailCard.classList.add('visible');
  }

  private hideDetail(): void { this.selectedIdx = -1; this.detailCard.classList.remove('visible'); }

  private positionDetailCard(idx: number): void {
    this.tmpVec3.set(this.nodePositions[idx * 3], this.nodePositions[idx * 3 + 1], this.nodePositions[idx * 3 + 2]);
    this.tmpVec3.project(this.camera);
    const x = (this.tmpVec3.x * 0.5 + 0.5) * this.container.clientWidth;
    const y = (-this.tmpVec3.y * 0.5 + 0.5) * this.container.clientHeight;
    let left = x + 24, top = y - 60;
    if (left + 220 > this.container.clientWidth - 10) left = x - 244;
    if (top < 10) top = 10;
    if (top + 200 > this.container.clientHeight - 10) top = this.container.clientHeight - 210;
    if (left < 10) left = 10;
    this.detailCard.style.left = `${left}px`; this.detailCard.style.top = `${top}px`;
  }

  // ── Path finding ─────────────────────────────────────────

  private _pathSource = -1;
  private _pathTarget = -1;
  private _pathNodes = new Set<number>();
  private _pathEdges = new Set<number>();

  // ── Step 3: Shift+click quick path mode ───────────────────
  private _shiftSourceIdx = -1;
  private _onKeyDown?: (e: KeyboardEvent) => void;

  // ── Step 3: Alt+drag rectangle selection ──────────────────
  private _selecting = false;
  private _selectStart = new THREE.Vector2();
  private _selectEnd = new THREE.Vector2();
  private _selectRectEl!: HTMLDivElement;

  // ── Step 3: Floating prompt bar (confirmation before asking Agent) ──
  private _promptBarEl!: HTMLDivElement;
  private _promptTitleEl!: HTMLSpanElement;
  private _promptBtnEl!: HTMLButtonElement;
  private _promptQuestion = '';
  private _promptTimer: ReturnType<typeof setTimeout> | null = null;
  private _langHandler: ((data: { lang: string }) => void) | null = null;
  private _showPromptBound: ((data: { title: string; question: string }) => void) | null = null;

  private setPathSource(idx: number): void {
    if (this.focusSubgraphActive) this.exitFocusSubgraph();
    this._pathSource = idx;
    this._pathTarget = -1;
    this._pathNodes.clear(); this._pathEdges.clear();
    // Highlight the source node in cyan
    this.highlightPathNodes();
    const st = document.getElementById('status-text');
    if (st) st.innerHTML = `${iconHtml('link', 11)} 路径起点: ${this.graphNodes[idx].name} · 右键目标节点选"路径"完成 · ESC 取消`;
  }

  private setPathTarget(idx: number): void {
    this._pathTarget = idx;
    this.findShortestPath();
    const st = document.getElementById('status-text');
    const len = this._pathNodes.size;
    if (st) st.textContent = len > 0
      ? `${iconHtml('link', 11)} 路径: ${this.graphNodes[this._pathSource].name} → ${this.graphNodes[this._pathTarget].name} · ${len} 节点 · ESC 清除`
      : `${iconHtml('link', 11)} 未找到 ${this.graphNodes[this._pathSource].name} → ${this.graphNodes[this._pathTarget].name} 的路径`;
  }

  private findShortestPath(): void {
    this._pathNodes.clear(); this._pathEdges.clear();
    const src = this._pathSource, dst = this._pathTarget;
    if (src < 0 || dst < 0) return;
    // BFS with parent tracking
    const n = this.graphNodes.length;
    const visited = new Array<boolean>(n).fill(false);
    const parent = new Array<number>(n).fill(-1);
    const parentEdge = new Array<number>(n).fill(-1);
    const queue = [src];
    visited[src] = true;
    let found = false;
    while (queue.length > 0 && !found) {
      const u = queue.shift()!;
      for (let ei = 0; ei < (this.edgeIndexOf[u]?.length || 0); ei++) {
        const edgeIdx = this.edgeIndexOf[u][ei];
        const d = this.edgeDataList[edgeIdx];
        const v = d.s === u ? d.t : d.s;
        if (!visited[v]) {
          visited[v] = true;
          parent[v] = u;
          parentEdge[v] = edgeIdx;
          queue.push(v);
          if (v === dst) { found = true; break; }
        }
      }
    }
    if (!found) return;
    // Backtrack to collect path
    let cur = dst;
    while (cur !== src) {
      this._pathNodes.add(cur);
      this._pathEdges.add(parentEdge[cur]);
      cur = parent[cur];
    }
    this._pathNodes.add(src);
    this.highlightPathNodes();
  }

  private highlightPathNodes(): void {
    const src = this._pathSource;
    // Update all node glows: path nodes bright cyan, others dim
    for (let i = 0; i < this.graphNodes.length; i++) {
      const onPath = this._pathNodes.has(i) || i === src;
      if (this.nodeGlows[i]) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity =
          onPath ? 0.9 : (this._pathNodes.size > 0 ? 0.06 : 0.55);
        if (onPath) {
          (this.nodeGlows[i].material as THREE.SpriteMaterial).color.set(
            i === src ? 0x44ffdd : i === this._pathTarget ? 0xff8844 : 0x44ddff);
        }
      }
      if (this.nodeCores[i]) {
        this.nodeCores[i].visible = onPath || this._pathNodes.size === 0;
      }
    }
    // Dim/hide non-path edges
    for (const lines of this.edgeLineGroups) {
      (lines.material as THREE.LineBasicMaterial).opacity =
        this._pathNodes.size > 0 ? 0.01 : edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
    }
    // Brighten path edges
    this.rebuildPathEdges();
  }

  private rebuildPathEdges(): void {
    while (this.highlightEdgeGroup.children.length) this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);
    if (this._pathEdges.size === 0) return;
    const pos = this.nodePositions;
    const verts: number[] = [];
    for (const ei of this._pathEdges) {
      const d = this.edgeDataList[ei];
      verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2],
                 pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.highlightEdgeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: 0x44ffcc, transparent: true, opacity: 0.8,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })));
  }

  private clearPath(): void {
    this._pathSource = -1;
    this._pathTarget = -1;
    this._pathNodes.clear();
    this._pathEdges.clear();
    // Restore normal appearance
    for (let i = 0; i < this.graphNodes.length; i++) {
      if (this.nodeGlows[i]) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = false ? 0 : 0.55;
        (this.nodeGlows[i].material as THREE.SpriteMaterial).color.set(this.nodeGlowColors[i]);
      }
      if (this.nodeCores[i]) this.nodeCores[i].visible = true;
    }
    for (const lines of this.edgeLineGroups) {
      (lines.material as THREE.LineBasicMaterial).opacity =
        edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
    }
    while (this.highlightEdgeGroup.children.length) this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);
    const st = document.getElementById('status-text');
    if (st && st.innerHTML?.includes('link')) st.innerHTML = '就绪';
  }

  // ── Step 3: Shift+click quick path mode ──────────────────

  /** Get node index from a pointer event, or -1 if no node hit. Checks ALL cores. */
  private _hitNode(e: PointerEvent | MouseEvent): number {
    if (this.nodeCores.length === 0) return -1;
    const rect = this.container.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(mx, my), this.camera);
    const hits = this.raycaster.intersectObjects(this.nodeCores);
    return hits.length > 0 ? this.nodeCores.indexOf(hits[0].object as THREE.Mesh) : -1;
  }

  private _handleShiftClick(e: PointerEvent): void {
    const idx = this._hitNode(e);
    if (idx < 0) {
      // Shift+click on empty → cancel
      this._clearShiftPath();
      return;
    }
    if (this._shiftSourceIdx < 0) {
      // First Shift+click → set source
      this._shiftSourceIdx = idx;
      const node = this.graphNodes[idx];
      const st = document.getElementById('status-text');
      if (st) st.innerHTML = `${iconHtml('link', 11)} 路径起点: ${node.name} · Shift+点击目标节点完成 · ESC 取消`;
      // Briefly pulse the source node
      if (this.nodeGlows[idx]) {
        (this.nodeGlows[idx].material as THREE.SpriteMaterial).color.set(0x44ffdd);
        (this.nodeGlows[idx].material as THREE.SpriteMaterial).opacity = 0.9;
      }
    } else if (idx === this._shiftSourceIdx) {
      // Same node → cancel
      this._clearShiftPath();
    } else {
      // Second Shift+click → find path & emit event
      const srcIdx = this._shiftSourceIdx;
      const srcNode = this.graphNodes[srcIdx];
      const tgtNode = this.graphNodes[idx];
      // Use existing path finding
      this.setPathSource(srcIdx);
      this.setPathTarget(idx);
      const pathNames = Array.from(this._pathNodes)
        .map(i => this.graphNodes[i]?.name || '')
        .filter(Boolean);
      // Emit event
      bus.emit('graph:path-selected', {
        from: { name: srcNode.name, id: srcNode.id, type: (srcNode.type || srcNode.kind || 'symbol') as string },
        to: { name: tgtNode.name, id: tgtNode.id, type: (tgtNode.type || tgtNode.kind || 'symbol') as string },
        pathLength: pathNames.length,
        pathNames,
      });
      this._shiftSourceIdx = -1;
    }
  }

  private _clearShiftPath(): void {
    if (this._shiftSourceIdx >= 0 && this._shiftSourceIdx < this.nodeGlows.length) {
      (this.nodeGlows[this._shiftSourceIdx].material as THREE.SpriteMaterial).color.set(
        this.nodeGlowColors[this._shiftSourceIdx]);
      (this.nodeGlows[this._shiftSourceIdx].material as THREE.SpriteMaterial).opacity = 0.55;
    }
    this._shiftSourceIdx = -1;
    const st = document.getElementById('status-text');
    if (st && st.innerHTML?.includes('link')) st.innerHTML = '就绪';
  }

  // ── Step 3: Alt+drag rectangle selection ─────────────────

  private setupSelectRect(): void {
    this._selectRectEl = document.createElement('div');
    this._selectRectEl.id = 'graph-select-rect';
    this._selectRectEl.style.cssText =
      'position:absolute;z-index:18;pointer-events:none;display:none;' +
      'border:1px solid rgba(100,180,255,0.7);' +
      'background:rgba(60,140,240,0.08);' +
      'box-shadow:inset 0 0 20px rgba(80,160,255,0.15);';
    this.container.appendChild(this._selectRectEl);
  }

  private _showSelectRect(): void {
    this._selectRectEl.style.display = '';
    this._updateSelectRect();
  }

  private _updateSelectRect(): void {
    const rect = this.container.getBoundingClientRect();
    const x1 = Math.min(this._selectStart.x, this._selectEnd.x) - rect.left;
    const y1 = Math.min(this._selectStart.y, this._selectEnd.y) - rect.top;
    const x2 = Math.max(this._selectStart.x, this._selectEnd.x) - rect.left;
    const y2 = Math.max(this._selectStart.y, this._selectEnd.y) - rect.top;
    this._selectRectEl.style.left = `${x1}px`;
    this._selectRectEl.style.top = `${y1}px`;
    this._selectRectEl.style.width = `${x2 - x1}px`;
    this._selectRectEl.style.height = `${y2 - y1}px`;
  }

  private _hideSelectRect(): void {
    this._selectRectEl.style.display = 'none';
  }

  private _handleRegionSelect(): void {
    const rect = this.container.getBoundingClientRect();
    // Compute screen-space rectangle bounds
    const sx1 = Math.min(this._selectStart.x, this._selectEnd.x) - rect.left;
    const sy1 = Math.min(this._selectStart.y, this._selectEnd.y) - rect.top;
    const sx2 = Math.max(this._selectStart.x, this._selectEnd.x) - rect.left;
    const sy2 = Math.max(this._selectStart.y, this._selectEnd.y) - rect.top;
    const minDim = 8;
    if (sx2 - sx1 < minDim || sy2 - sy1 < minDim) return; // too small

    const halfW = rect.width * 0.5;
    const halfH = rect.height * 0.5;
    const nodeNames: string[] = [];

    for (let i = 0; i < this.graphNodes.length; i++) {
      if (!this.nodeCores[i]?.visible) continue;
      // Project node position to screen space
      this.tmpVec3.set(
        this.nodePositions[i * 3],
        this.nodePositions[i * 3 + 1],
        this.nodePositions[i * 3 + 2],
      );
      this.tmpVec3.project(this.camera);
      if (this.tmpVec3.z > 1) continue; // behind camera
      const sx = this.tmpVec3.x * halfW + halfW;
      const sy = -this.tmpVec3.y * halfH + halfH;
      if (sx >= sx1 && sx <= sx2 && sy >= sy1 && sy <= sy2) {
        nodeNames.push(this.graphNodes[i].name);
      }
    }

    if (nodeNames.length === 0) return;

    // Emit event
    bus.emit('graph:region-selected', {
      nodeNames,
      nodeCount: nodeNames.length,
    });

    // Flash the selected nodes briefly
    this.highlightNodeNames(nodeNames.slice(0, 30), '#60a0ff');
    setTimeout(() => {
      if (!this.blastMode && this._pathSource < 0 && !this._lensActive) {
        this.clearAgentHighlight();
      }
    }, 2500);
  }

  // ── Step 3: Floating prompt bar ──────────────────────────

  private setupPromptBar(): void {
    this._promptBarEl = document.createElement('div');
    this._promptBarEl.id = 'graph-prompt-bar';
    this._promptBarEl.style.cssText =
      'position:absolute;z-index:19;top:12px;left:50%;transform:translateX(-50%);' +
      'display:none;align-items:center;gap:10px;padding:8px 14px;' +
      'background:var(--panel-bg,rgba(4,12,28,0.94));' +
      'backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);' +
      'border:1px solid rgba(60,100,180,0.3);' +
      'border-radius:6px;' +
      'box-shadow:0 0 0 1px rgba(60,100,180,0.05),0 12px 36px rgba(0,0,0,0.5);' +
      'font-family:var(--font-mono);font-size:10px;color:var(--starlight-dim,#c3daf8);white-space:nowrap;' +
      'opacity:0;transition:opacity 0.16s;';
    this._promptTitleEl = document.createElement('span');
    this._promptTitleEl.style.cssText = 'max-width:420px;overflow:hidden;text-overflow:ellipsis;';
    this._promptBarEl.appendChild(this._promptTitleEl);
    this._promptBtnEl = document.createElement('button');
    this._promptBtnEl.textContent = 'Ask Agent';
    // Mirror detail-card button template (dc-agent-btn)
    this._promptBtnEl.style.cssText =
      'font-family:var(--font-hud);font-size:7px;font-weight:600;' +
      'letter-spacing:0.5px;text-transform:uppercase;' +
      'padding:3px 8px;border-radius:2px;cursor:pointer;' +
      'transition:all var(--snap);' +
      'border:1px solid rgba(140,100,200,0.25);' +
      'background:rgba(12,22,36,0.6);color:var(--nebula,#a088e0);';
    this._promptBtnEl.addEventListener('mouseenter', () => {
      this._promptBtnEl.style.background = 'rgba(22,36,54,0.7)';
      this._promptBtnEl.style.color = 'var(--starlight-dim,#c3daf8)';
    });
    this._promptBtnEl.addEventListener('mouseleave', () => {
      this._promptBtnEl.style.background = 'rgba(12,22,36,0.6)';
      this._promptBtnEl.style.color = 'var(--nebula,#a088e0)';
    });
    this._promptBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._promptQuestion) {
        bus.emit('agent:query', this._promptQuestion);
      }
      this._hidePrompt();
    });
    this._promptBarEl.appendChild(this._promptBtnEl);
    // Dismiss button — mirrors dc-close
    const dismissBtn = document.createElement('button');
    dismissBtn.innerHTML = iconHtml('close', 11);
    dismissBtn.style.cssText =
      'padding:2px 4px;border:none;background:none;color:rgba(120,160,215,0.5);' +
      'cursor:pointer;font-size:11px;line-height:0;transition:color var(--snap);';
    dismissBtn.addEventListener('mouseenter', () => { dismissBtn.style.color = 'var(--starlight-dim,#c3daf8)'; });
    dismissBtn.addEventListener('mouseleave', () => { dismissBtn.style.color = 'rgba(120,160,215,0.5)'; });
    dismissBtn.addEventListener('click', (e) => { e.stopPropagation(); this._hidePrompt(); });
    this._promptBarEl.appendChild(dismissBtn);
    this.container.appendChild(this._promptBarEl);

    // Subscribe to show-prompt events (from GraphInteraction)
    this._showPromptBound = this._showPrompt; // arrow fn already bound
    bus.on('graph:show-prompt', this._showPromptBound);
  }

  private _showPrompt = (data: { title: string; question: string }): void => {
    if (this._promptTimer) clearTimeout(this._promptTimer);
    this._promptTitleEl.textContent = data.title;
    this._promptQuestion = data.question;
    this._promptBarEl.style.display = 'flex';
    this._promptBarEl.style.opacity = '1';
    // Auto-hide after 8s if user doesn't click
    this._promptTimer = setTimeout(() => this._hidePrompt(), 8000);
  };

  private _hidePrompt = (): void => {
    if (this._promptTimer) { clearTimeout(this._promptTimer); this._promptTimer = null; }
    this._promptBarEl.style.opacity = '0';
    setTimeout(() => {
      if (this._promptBarEl.style.opacity === '0') {
        this._promptBarEl.style.display = 'none';
        this._promptQuestion = '';
      }
    }, 200);
  };

  // ── Hover ────────────────────────────────────────────────
  // Hover raycaster uses ALL nodeCores regardless of .visible state.
  // This is intentional: .visible is a visual/rendering concern, and many
  // features (agent highlight, path mode, blast) temporarily toggle it.
  // If a node exists in the graph, it should be hoverable and clickable.
  // The only exception is fold-mode cloud view, which intentionally restricts
  // interaction to galaxy clouds only.

  private setupHover(): void {
    this.container.addEventListener('pointermove', (e: PointerEvent) => {
      const rect = this.container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    });
    this.container.addEventListener('pointerleave', () => {
      this.mouse.x = -999; this.mouse.y = -999;
    });
  }

  /** Raycast against node cores; returns index or -1. Uses ALL cores regardless of .visible. */
  private _raycastNode(): number {
    if (this.nodeCores.length === 0) return -1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.nodeCores);
    if (hits.length === 0) return -1;
    return this.nodeCores.indexOf(hits[0].object as THREE.Mesh);
  }

  private updateHover(): void {
    if (this.nodeCores.length === 0) return;
    if (!isFinite(this.mouse.x) || !isFinite(this.mouse.y)) return;

    // Cloud hover: fold mode with visible galaxy clouds (nodes hidden intentionally)
    const cloudViewActive = this.foldMode && this.galaxyGlows.length > 0
      && !this.nodeCores.some(c => c.visible);
    if (cloudViewActive) {
      if (this.hoveredIdx >= 0) { this.hoveredIdx = -1; this.targetHoverScale = 0; this.rebuildHighlightEdges(-1); }
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const coreSprites = this.galaxyGlows.filter((_, i) => i % 2 === 1);
      const galaxyHits = this.raycaster.intersectObjects(coreSprites);
      if (galaxyHits.length > 0 && this.mouse.x > -999) {
        this.container.style.cursor = 'pointer';
        const gIdx = galaxyHits[0].object.userData['galaxyIndex'] as number | undefined;
        if (gIdx !== undefined && gIdx < this.galaxyMeta.length) {
          this.hoveredGalaxyIdx = gIdx;
          const gm = this.galaxyMeta[gIdx];
          const shortName = (gm.label || gm.id).split('/')[0].replace(/_/g, ' ');
          const isSub = !!this.enteredGalaxyId;
          this.tooltipEl.querySelector('.tt-name')!.textContent = `${isSub ? '📁' : '🌌'} ${shortName}`;
          this.tooltipEl.querySelector('.tt-meta')!.textContent = `${gm.memberIndices.length} 节点 · ${gm.memberIndices.length >= 30 ? '大型星团' : gm.memberIndices.length >= 10 ? '中型星团' : '小型星团'}`;
          this.tooltipEl.querySelector('.tt-loc')!.textContent = isSub ? '点击钻入子社区' : '点击进入查看内部连线';
          this.tmpVec3.copy(gm.centroid);
          this.tmpVec3.project(this.camera);
          if (this.tmpVec3.z <= 1) {
            const x = (this.tmpVec3.x * 0.5 + 0.5) * this.container.clientWidth;
            const y = (-this.tmpVec3.y * 0.5 + 0.5) * this.container.clientHeight;
            this.tooltipEl.style.left = `${x + 18}px`; this.tooltipEl.style.top = `${y - 10}px`;
            this.tooltipEl.classList.add('visible');
          }
        }
      } else {
        this.container.style.cursor = '';
        this.tooltipEl.classList.remove('visible');
        this.hoveredGalaxyIdx = -1;
      }
      return;
    }

    // Standard / constellation view: raycast all cores (ignore .visible)
    const newIdx = this._raycastNode();
    if (newIdx !== this.hoveredIdx) {
      // Restore previous hovered node
      if (this.hoveredIdx >= 0 && this.hoveredIdx < this.nodeCores.length) {
        const prevBase = this.getNodeBaseScale(this.hoveredIdx);
        const isFull = true;
        this.nodeCores[this.hoveredIdx].scale.setScalar(isFull ? prevBase * 0.4 : prevBase);
        if (this.nodeGlows[this.hoveredIdx]) {
          this.nodeGlows[this.hoveredIdx].scale.setScalar(prevBase * (isFull ? 9 : 7.0));
          (this.nodeGlows[this.hoveredIdx].material as THREE.SpriteMaterial).opacity = 0.55;
        }
      }
      this.hoveredIdx = newIdx;
      this.targetHoverScale = newIdx >= 0 ? 1 : 0;
      this.rebuildHighlightEdges(newIdx);
    }
  }

  private rebuildHighlightEdges(nodeIdx: number): void {
    if (this.blastMode) return;
    while (this.highlightEdgeGroup.children.length) this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);
    if (nodeIdx < 0 || nodeIdx >= this.graphNodes.length) return;
    const edges = this.edgeIndexOf[nodeIdx];
    if (edges.length === 0) return;
    const pos = this.nodePositions, verts: number[] = [], colors: number[] = [];
    for (const ei of edges) {
      const d = this.edgeDataList[ei];
      verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
      const c = edgeColorByType(d.edgeType, d.direction, d.crossFile), bright = 2.5;
      colors.push(Math.min(1, c.r * bright), Math.min(1, c.g * bright), Math.min(1, c.b * bright), Math.min(1, c.r * bright), Math.min(1, c.g * bright), Math.min(1, c.b * bright));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.highlightEdgeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending })));
  }

  // ── Labels ───────────────────────────────────────────────

  private updateLabels(): void {
    const halfW = this.container.clientWidth * 0.5, halfH = this.container.clientHeight * 0.5;
    const hoverI = this.hoveredIdx;
    const selI = this.selectedIdx;
    for (let k = 0; k < this.nodeLabelIdx.length; k++) {
      const i = this.nodeLabelIdx[k], div = this.labelDivs[k];
      if (!div) continue;
      this.tmpVec3.set(this.nodePositions[i * 3], this.nodePositions[i * 3 + 1], this.nodePositions[i * 3 + 2]);
      this.tmpVec3.project(this.camera);
      const behind = this.tmpVec3.z > 1;
      if (behind || this.foldMode) { div.style.display = 'none'; continue; }
      const focused = i === hoverI || i === selI;
      div.style.display = '';
      div.style.left = `${this.tmpVec3.x * halfW + halfW}px`;
      div.style.top = `${-this.tmpVec3.y * halfH + halfH}px`;
      div.style.opacity = focused ? '1' : '0.18';
      div.style.fontSize = focused ? '11px' : '10px';
    }
    // Galaxy labels — no distance fade, hover brightens
    for (let k = 0; k < this.galaxyLabelDivs.length; k++) {
      const div = this.galaxyLabelDivs[k];
      const gIdx = Number(div.dataset['galaxyIndex']);
      if (gIdx === undefined || gIdx >= this.galaxyMeta.length) continue;
      const gm = this.galaxyMeta[gIdx];
      this.tmpVec3.copy(gm.centroid);
      this.tmpVec3.project(this.camera);
      const behind = this.tmpVec3.z > 1;
      const hovered = gIdx === this.hoveredGalaxyIdx;
      div.style.display = (!behind && this.foldMode && !this.enteredGalaxyId) ? '' : 'none';
      div.style.left = `${this.tmpVec3.x * halfW + halfW}px`;
      div.style.top = `${-this.tmpVec3.y * halfH + halfH}px`;
      div.style.opacity = hovered ? '0.9' : '0.3';
      div.style.color = hovered ? 'rgba(255,220,160,0.95)' : '';
      div.style.fontSize = hovered ? '12px' : '10px';
      div.style.textShadow = hovered ? '0 0 14px rgba(255,180,60,0.9), 0 0 30px rgba(255,120,20,0.5)' : '';
    }
  }

  // ── Blast ────────────────────────────────────────────────

  private startBlastMode(idx: number): void {
    if (this.focusSubgraphActive) this.exitFocusSubgraph();
    this.blastMode = true; this.blastSource = idx; this.computeBlastDistances(); this.buildBlastEdges();
    const st = document.getElementById('status-text');
    const inRadius = this.blastDistances.filter(d => d >= 0).length;
    if (st) st.innerHTML = `${iconHtml('blast', 12)} 波及: ${this.graphNodes[idx]?.name || '?'}  ·  ${inRadius} 节点  ·  B/ESC 退出`;
  }

  private computeBlastDistances(): void {
    const n = this.graphNodes.length;
    this.blastDistances = new Array(n).fill(-1);
    if (this.blastSource < 0) return;
    this.blastDistances[this.blastSource] = 0;
    const queue = [this.blastSource];
    console.log(`[DEBUG] computeBlastDistances: source=${this.blastSource}, maxDist=${this.blastMaxDist}, edgeType=${this.blastEdgeType}, direction=${this.blastDirection}`);
    while (queue.length > 0) {
      const u = queue.shift()!, du = this.blastDistances[u];
      if (du >= this.blastMaxDist) continue;
      // Filter neighbors based on edge type and direction
      for (const v of this.neighborMap[u] || []) {
        if (this.blastDistances[v] === -1) {
          // Check if ANY edge between u and v passes the filter
          const passesFilter = this.edgeIndexOf[u].some(ei => {
            const d = this.edgeDataList[ei];
            if ((d.s !== u || d.t !== v) && (d.s !== v || d.t !== u)) return false;
            if (this.blastEdgeType !== 'all' && d.edgeType !== this.blastEdgeType) return false;
            if (this.blastDirection === 'outbound' && d.s !== u) return false;
            if (this.blastDirection === 'inbound' && d.t !== u) return false;
            return true;
          });
          if (passesFilter) { this.blastDistances[v] = du + 1; queue.push(v); }
        }
      }
    }
    const reached = this.blastDistances.filter(d => d >= 0).length;
    console.log(`[DEBUG] computeBlastDistances: reached ${reached} nodes`);
  }

  private buildBlastEdges(): void {
    while (this.highlightEdgeGroup.children.length) this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);
    if (!this.blastMode) return;
    const pos = this.nodePositions, verts: number[] = [], colors: number[] = [];
    console.log(`[DEBUG] buildBlastEdges: edgeType=${this.blastEdgeType}, direction=${this.blastDirection}`);
    let edgeCount = 0;
    for (const d of this.edgeDataList) {
      const ds = this.blastDistances[d.s], dt = this.blastDistances[d.t];
      if (ds < 0 || dt < 0) continue;
      // Apply edge type filter
      if (this.blastEdgeType !== 'all' && d.edgeType !== this.blastEdgeType) continue;
      // Apply direction filter
      if (this.blastDirection === 'outbound' && d.s !== this.blastSource && ds > dt) continue;
      if (this.blastDirection === 'inbound' && d.t !== this.blastSource && dt > ds) continue;
      verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
      const minD = Math.min(ds, dt);
      const c = minD === 0 ? new THREE.Color(0xffffff) : minD === 1 ? new THREE.Color(0xff6644) : minD <= 3 ? new THREE.Color(0xffaa44) : new THREE.Color(0xffdd88);
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
      edgeCount++;
    }
    console.log(`[DEBUG] buildBlastEdges: rendered ${edgeCount} edges`);
    if (verts.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.highlightEdgeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.30, depthWrite: false, blending: THREE.AdditiveBlending })));
  }

  private exitBlastMode(): void {
    this.blastMode = false; this.blastSource = -1; this.blastDistances = [];
    while (this.highlightEdgeGroup.children.length) this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);
    for (let i = 0; i < this.nodeGlows.length; i++) {
      (this.nodeGlows[i].material as THREE.SpriteMaterial).color.set(this.nodeGlowColors[i]);
      (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = false ? 0 : 0.55;
      const kind = ((this.graphNodes[i]?.type || this.graphNodes[i]?.kind || 'symbol') as string).toLowerCase();
      (this.nodeCores[i].material as THREE.MeshBasicMaterial).color.set(
        0xffffff
      );
    }
    const st = document.getElementById('status-text');
    if (st && st.innerHTML?.includes('blast')) st.innerHTML = '就绪';
  }

  private updateBlastNodeColors(): void {
    if (!this.blastMode) return;
    const isFull = true;
    for (let i = 0; i < this.nodeGlows.length; i++) {
      const d = this.blastDistances[i];
      if (d >= 0) {
        const c = new THREE.Color();
        if (d === 0) c.set(0xffffff); else if (d === 1) c.set(0xff4422); else if (d === 2) c.set(0xff8800); else if (d === 3) c.set(0xffcc00); else c.setHSL(0.55 - (d / this.blastMaxDist) * 0.3, 0.6, 0.4 + (1 - d / this.blastMaxDist) * 0.3);
        (this.nodeGlows[i].material as THREE.SpriteMaterial).color.set(c);
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.7;
        (this.nodeCores[i].material as THREE.MeshBasicMaterial).color.set(c);
        const base = this.getNodeBaseScale(i);
        this.nodeGlows[i].scale.setScalar(base * (isFull ? 7 : 7.0) * (d === 0 ? 2 : 1.2));
        this.nodeCores[i].scale.setScalar(base * (d === 0 ? 2 : 1));
      } else {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.12;
      }
    }
  }

  // ── Focus ────────────────────────────────────────────────

  private flyToNode(idx: number): void {
    const px = this.nodePositions[idx * 3], py = this.nodePositions[idx * 3 + 1], pz = this.nodePositions[idx * 3 + 2];
    this.focusTarget.set(px, py, pz); this.focusStartCam.copy(this.camera.position); this.focusStartLook.copy(this.controls.target);
    this.focusActive = true; this.focusProgress = 0; this.focusNodeIdx = idx; this.focusFlash = 1;
  }

  private _resettingCamera = false;

  /** Reset camera to the default overview position with smooth animation. */
  resetCamera(): void {
    if (this._initCamPos.lengthSq() < 1) return; // not initialized
    this.focusStartCam.copy(this.camera.position);
    this.focusStartLook.copy(this.controls.target);
    this.focusTarget.copy(this._initCamPos);
    this.focusActive = true; this.focusProgress = 0; this.focusNodeIdx = -1; this.focusFlash = 0;
    this._resettingCamera = true;
  }

  focusNode(query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q || this.graphNodes.length === 0) return false;
    let idx = this.graphNodes.findIndex(n => n.name.toLowerCase() === q);
    if (idx < 0) idx = this.graphNodes.findIndex(n => n.name.toLowerCase().startsWith(q));
    if (idx < 0) idx = this.graphNodes.findIndex(n => n.name.toLowerCase().includes(q));
    if (idx < 0) return false;
    // If fold mode is on, enter that galaxy instead of flying to node
    if (this.foldMode) {
      const cid = this.nodeCommMap.get(idx);
      if (cid) { this.enterGalaxy(cid); return true; }
      // Orphan node — can't enter, just fly
      this.flyToNode(idx); return true;
    }
    this.flyToNode(idx); return true;
  }

  // ── File highlight (文件树 → 星图联动) ────────────────────

  /** Highlight all nodes belonging to a file (match by location prefix). */
  highlightFile(filePath: string): void {
    if (this.focusSubgraphActive) this.exitFocusSubgraph();
    // Restore any previous highlight before applying new one
    if (this._fileHighlight) this.clearFileHighlight();

    const normalized = filePath.replace(/\\/g, '/');

    for (let i = 0; i < this.graphNodes.length; i++) {
      const loc = (this.graphNodes[i].location || '').replace(/\\/g, '/');
      const f = loc.indexOf(':') >= 0 ? loc.substring(0, loc.lastIndexOf(':')) : loc;
      if (f === normalized) {
        this._fileHighlightIndices.add(i);
      }
    }

    if (this._fileHighlightIndices.size === 0) return;

    this._fileHighlight = true;
    this._applyFileHighlight();
  }

  /** Highlight all nodes under a directory (recursive prefix match). */
  highlightFolder(folderPath: string): void {
    // Restore any previous highlight before applying new one
    if (this._fileHighlight) this.clearFileHighlight();

    const normalized = folderPath.replace(/\\/g, '/');
    const prefix = normalized.endsWith('/') ? normalized : normalized + '/';
    this._fileHighlightIndices.clear();
    this._fileOpacityOriginal.clear();

    for (let i = 0; i < this.graphNodes.length; i++) {
      const loc = (this.graphNodes[i].location || '').replace(/\\/g, '/');
      const f = loc.indexOf(':') >= 0 ? loc.substring(0, loc.lastIndexOf(':')) : loc;
      if (f.startsWith(prefix)) {
        this._fileHighlightIndices.add(i);
      }
    }

    if (this._fileHighlightIndices.size === 0) return;

    this._fileHighlight = true;
    this._applyFileHighlight();
  }

  clearFileHighlight(): void {
    this._fileHighlight = false;
    this._fileHighlightIndices.clear();
    this._applyFileHighlight();
  }

  // ── Color mode switching ──────────────────────────────────

  /** Cycle node coloring mode. Returns the new mode's display label. */
  recolorByMode(mode: 'type' | 'community' | 'coupling'): string {
    this.colorMode = mode;
    if (this.graphNodes.length === 0) return mode === 'type' ? '按类型' : mode === 'community' ? '按社区' : '按耦合';

    const isFull = true;
    for (let i = 0; i < this.nodeCores.length; i++) {
      const kind = ((this.graphNodes[i].type || this.graphNodes[i].kind || 'symbol') as string).toLowerCase();
      let coreColor: number;
      let glowColor: number;

      if (mode === 'type') {
        coreColor = isFull ? 0xffffff : (NODE_COLORS[kind] || 0x7eb8ff);
        glowColor = GLOW_COLORS[kind] || 0x4488cc;
      } else if (mode === 'community') {
        const cid = this.nodeCommMap?.get(i);
        coreColor = cid ? communityColor(cid) : 0x555555;
        glowColor = coreColor;
      } else { // coupling heatmap: green (low) → red (high)
        const risk = this.l34Count[i] || 0;
        const maxRisk = Math.max(1, ...this.l34Count);
        const t = risk / maxRisk;
        const c = new THREE.Color();
        c.setHSL(0.33 - t * 0.33, 0.75, 0.38 + (1 - t) * 0.18);
        coreColor = c.getHex();
        glowColor = coreColor;
      }

      (this.nodeCores[i].material as THREE.MeshBasicMaterial).color.set(coreColor);
      (this.nodeGlows[i].material as THREE.SpriteMaterial).color.set(glowColor);
      this.nodeCoreColors[i] = coreColor;
      this.nodeGlowColors[i] = glowColor;
    }

    const labels: Record<string, string> = { type: t('color.type'), community: t('color.community'), coupling: t('color.coupling') };
    return labels[mode];
  }

  // ── Node scale mode ──────────────────────────────────────

  private getNodeBaseScale(i: number): number {
    const val = this.scaleMode === 'degree' ? this.deg[i] : (this.l34Count[i] || 0);
    const maxVal = this.scaleMode === 'degree' ? this.maxDeg : Math.max(1, ...this.l34Count);
    return 0.6 + (val / maxVal) * 2.8;
  }

  /** Magnitude factor 0.15–1.0: hub nodes shine bright, leaf nodes barely visible. */
  private _nodeMag(i: number): number {
    return 0.15 + 0.85 * (Math.log1p(this.deg[i]) / Math.log1p(this.maxDeg));
  }

  /** Toggle node size between degree-based and coupling-risk-based. Returns display label. */
  rescaleByMode(mode: 'degree' | 'coupling'): string {
    this.scaleMode = mode;
    if (this.graphNodes.length === 0) return mode === 'degree' ? '按度' : '按耦合风险';

    this.maxDeg = Math.max(1, ...this.deg);
    const isFull = true;
    for (let i = 0; i < this.nodeCores.length; i++) {
      const base = this.getNodeBaseScale(i);
      this.nodeCores[i].scale.setScalar(isFull ? base * 0.4 : base);
      if (this.nodeGlows[i]) {
        this.nodeGlows[i].scale.setScalar(base * (isFull ? 9 : 7.0));
      }
      if (this.nodeGlows2[i]) {
        this.nodeGlows2[i].scale.setScalar(base * 16);
      }
    }
    return mode === 'degree' ? t('scale.degree') : t('scale.coupling');
  }

  // ── Agent highlight (Agent ↔ 星图联动) ──────────────────

  /** Highlight a set of nodes by name (fuzzy match). Matched nodes glow in the given color; others dim. */
  highlightNodeNames(names: string[], colorHex?: string): void {
    if (this.focusSubgraphActive) this.exitFocusSubgraph();
    this._clearAgentHighlightState();
    if (!names.length || this.graphNodes.length === 0) return;

    const color = colorHex ? parseInt(colorHex.replace('#', ''), 16) : 0xf0b848; // default sol
    const lowerNames = names.map(n => n.trim().toLowerCase());

    for (let i = 0; i < this.graphNodes.length; i++) {
      const nodeName = (this.graphNodes[i].name || '').toLowerCase();
      const shortName = nodeName.split('.').pop() || '';
      const found = lowerNames.some(q =>
        nodeName === q || nodeName.startsWith(q) || nodeName.includes(q) || shortName === q
      );
      if (found) {
        this._agentHighlightIndices.add(i);
      }
    }

    if (this._agentHighlightIndices.size === 0) return;

    // Apply: dim non-highlighted, recolor highlighted
    for (let i = 0; i < this.nodeGlows.length; i++) {
      if (this._agentHighlightIndices.has(i)) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).color.set(color);
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.88;
        if (this.nodeCores[i]) this.nodeCores[i].visible = true;
      } else {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.025;
        if (false &&this.nodeCores[i]) this.nodeCores[i].visible = false;
      }
    }
    // Dim non-path edges
    for (const lines of this.edgeLineGroups) {
      (lines.material as THREE.LineBasicMaterial).opacity = 0.008;
    }
    // Fly to centroid of highlighted nodes
    this._flyToCentroid(this._agentHighlightIndices);
  }

  /** Show the dependency path between two nodes on the graph. */
  showPathOnGraph(fromName: string, toName: string): boolean {
    const srcIdx = this._findNodeIndexByName(fromName);
    const dstIdx = this._findNodeIndexByName(toName);
    if (srcIdx < 0 || dstIdx < 0) return false;
    this.setPathSource(srcIdx);
    this.setPathTarget(dstIdx);
    return this._pathNodes.size > 0;
  }

  /** Clear all Agent-triggered highlights (path + node highlight). */
  clearAgentHighlight(): void {
    this._clearAgentHighlightState();
    this.clearPath();
    // Also restore any file highlight if active
    if (this._fileHighlight) {
      this._applyFileHighlight();
    }
  }

  private _clearAgentHighlightState(): void {
    if (this._agentHighlightIndices.size === 0) return;
    // Restore original glows for previously highlighted nodes
    for (const i of this._agentHighlightIndices) {
      if (this.nodeGlows[i]) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).color.set(this.nodeGlowColors[i]);
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = false ? 0 : 0.55;
      }
      if (this.nodeCores[i]) this.nodeCores[i].visible = true;
    }
    // Restore non-highlighted dimmed nodes (opacity + visibility)
    for (let i = 0; i < this.nodeGlows.length; i++) {
      if (!this._agentHighlightIndices.has(i)) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.55;
        if (this.nodeCores[i]) this.nodeCores[i].visible = true;
      }
    }
    // Restore edge opacities
    for (const lines of this.edgeLineGroups) {
      (lines.material as THREE.LineBasicMaterial).opacity =
        edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
    }
    this._agentHighlightIndices.clear();
  }

  // ── P6: Hotspot highlighting — 复发热点着色 ──

  private _hotspotFiles: Map<string, number> = new Map(); // filePath → recurrence count

  /** Color nodes belonging to hotspot files with intensity proportional to L4 recurrence count. */
  highlightHotspots(hotspots: Array<{ file: string; count: number }>): void {
    this.clearHotspots();
    if (!hotspots.length || this.graphNodes.length === 0) return;

    // Build a map of filename → count
    for (const hs of hotspots) {
      const key = (hs.file || '').replace(/\\/g, '/').toLowerCase();
      const prev = this._hotspotFiles.get(key) || 0;
      this._hotspotFiles.set(key, Math.max(prev, hs.count));
    }

    // Apply coloring: intensity from 0.3 (count=2) to 1.0 (count≥8)
    for (let i = 0; i < this.graphNodes.length; i++) {
      const loc = (this.graphNodes[i].location || '').toLowerCase();
      if (!loc) continue;
      // Match any hotspot file path against node location
      for (const [hsPath, count] of this._hotspotFiles) {
        if (loc.includes(hsPath) || hsPath.includes(loc)) {
          const intensity = Math.min(1, 0.3 + (count - 2) * 0.12);
          // Tint glow toward fail/warn color
          if (this.nodeGlows[i]) {
            const r = 0.85, g = 0.2 + (1 - intensity) * 0.3, b = 0.2 + (1 - intensity) * 0.3;
            (this.nodeGlows[i].material as THREE.SpriteMaterial).color.setRGB(r, g, b);
            (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.35 + intensity * 0.55;
          }
          // Pulse larger glows for high-count hotspots
          if (this.nodeGlows[i] && count >= 5) {
            const s = 1.0 + (count - 4) * 0.12;
            this.nodeGlows[i].scale.setScalar(s);
          }
          break;
        }
      }
    }
  }

  clearHotspots(): void {
    if (this._hotspotFiles.size === 0) return;
    this._hotspotFiles.clear();
    // Restore original glow colors and opacities
    for (let i = 0; i < this.nodeGlows.length; i++) {
      if (this.nodeGlows[i]) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).color.set(
          this.nodeGlowColors[i] || 0x5588cc,
        );
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.55;
        this.nodeGlows[i].scale.setScalar(1.0);
      }
    }
  }

  // ── Agent Lens (Step 2) — dim everything except visited nodes ──

  /** Dim all nodes except those matching the given names to 1% opacity. */
  setAgentLens(nodeNames: Set<string>): void {
    if (!nodeNames || nodeNames.size === 0 || this.graphNodes.length === 0) {
      this.clearAgentLens();
      return;
    }

    // Build set of matched node indices
    const lensIndices = new Set<number>();
    const lowerNames = Array.from(nodeNames).map(n => n.trim().toLowerCase());

    for (let i = 0; i < this.graphNodes.length; i++) {
      const nodeName = (this.graphNodes[i].name || '').toLowerCase();
      const shortName = nodeName.split('.').pop() || '';
      const found = lowerNames.some(q =>
        nodeName === q || nodeName.startsWith(q) || nodeName.includes(q) || shortName === q
      );
      if (found) lensIndices.add(i);
    }

    if (lensIndices.size === 0) return;

    // Save original opacities for restoration
    if (!this._lensOriginalOpacities) {
      this._lensOriginalOpacities = new Map();
    }

    // Apply lens: visited nodes stay bright, others dim to 1%
    for (let i = 0; i < this.nodeGlows.length; i++) {
      const mat = this.nodeGlows[i].material as THREE.SpriteMaterial;
      if (lensIndices.has(i)) {
        mat.opacity = 0.88;
        if (this.nodeCores[i]) this.nodeCores[i].visible = true;
      } else {
        if (!this._lensOriginalOpacities.has(i)) {
          this._lensOriginalOpacities.set(i, mat.opacity);
        }
        mat.opacity = 0.01;
        if (false &&this.nodeCores[i]) this.nodeCores[i].visible = false;
      }
    }

    // Dim all edges
    for (const lines of this.edgeLineGroups) {
      (lines.material as THREE.LineBasicMaterial).opacity = 0.005;
    }

    this._lensActive = true;
  }

  /** Restore normal rendering from agent lens mode. */
  clearAgentLens(): void {
    if (!this._lensActive && !this._lensOriginalOpacities) return;
    this._lensActive = false;

    for (let i = 0; i < this.nodeGlows.length; i++) {
      const orig = this._lensOriginalOpacities?.get(i);
      if (orig !== undefined) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = orig;
      } else {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.55;
      }
      if (this.nodeCores[i]) this.nodeCores[i].visible = true;
    }

    // Restore edge opacities
    for (const lines of this.edgeLineGroups) {
      (lines.material as THREE.LineBasicMaterial).opacity =
        edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
    }

    this._lensOriginalOpacities?.clear();
    this._clearTrailLine();
  }

  // ── Agent Trail (Step 2) — dashed line through visited nodes ──

  /**
   * Draw a dashed line through the sequence of node names (max 20 steps).
   * Most recent nodes are brighter. Earlier nodes fade out.
   */
  updateAgentTrail(nodeNames: string[]): void {
    this._clearTrailLine();

    if (!nodeNames || nodeNames.length < 2 || this.graphNodes.length === 0) return;

    // Map names to indices (fuzzy match), skip consecutive duplicates
    const indices: number[] = [];
    for (const name of nodeNames) {
      const idx = this._findNodeIndexByName(name);
      if (idx >= 0) {
        if (indices.length === 0 || indices[indices.length - 1] !== idx) {
          indices.push(idx);
        }
      }
    }

    if (indices.length < 2) return;

    const pos = this.nodePositions;
    const verts: number[] = [];
    const colors: number[] = [];

    for (let k = 0; k < indices.length - 1; k++) {
      const i = indices[k];
      const j = indices[k + 1];
      verts.push(
        pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2],
        pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2],
      );
      // Fade: earlier segments are dimmer, latest segment is brightest
      const t = (k + 1) / (indices.length - 1); // 0..1, later = brighter
      const bright = 0.2 + t * 0.7;
      // Cyan trail
      colors.push(0.2 * bright, bright, bright, 0.2 * bright, bright, bright);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    this._trailLine = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.nodeGroup.add(this._trailLine);
  }

  /** Remove the existing trail line from the scene. */
  private _clearTrailLine(): void {
    if (this._trailLine) {
      this.nodeGroup.remove(this._trailLine);
      this._trailLine.geometry.dispose();
      (this._trailLine.material as THREE.Material).dispose();
      this._trailLine = null;
    }
  }

  /** Find a node's array index by name (fuzzy). Returns -1 if not found. */
  private _findNodeIndexByName(query: string): number {
    const q = query.trim().toLowerCase();
    if (!q || this.graphNodes.length === 0) return -1;
    let idx = this.graphNodes.findIndex(n => n.name.toLowerCase() === q);
    if (idx < 0) idx = this.graphNodes.findIndex(n => n.name.toLowerCase().startsWith(q));
    if (idx < 0) idx = this.graphNodes.findIndex(n => n.name.toLowerCase().includes(q));
    return idx;
  }

  /** Fly camera to the centroid of a set of node indices. */
  private _flyToCentroid(indices: Set<number>): void {
    if (indices.size === 0) return;
    let cx = 0, cy = 0, cz = 0;
    for (const i of indices) {
      cx += this.nodePositions[i * 3];
      cy += this.nodePositions[i * 3 + 1];
      cz += this.nodePositions[i * 3 + 2];
    }
    const n = indices.size;
    this.focusTarget.set(cx / n, cy / n, cz / n);
    this.focusStartCam.copy(this.camera.position);
    this.focusStartLook.copy(this.controls.target);
    this.focusActive = true;
    this.focusProgress = 0;
    this.focusFlash = 0;
  }

  private _applyFileHighlight(): void {
    const hl = this._fileHighlight;
    const idxs = this._fileHighlightIndices;

    // Nodes: dim non-highlighted
    for (let i = 0; i < this.nodeGlows.length; i++) {
      const visible = !hl || idxs.has(i);
      if (hl && !visible && this.nodeGlows[i].visible) {
        this._fileOpacityOriginal.set(i, (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity);
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.03;
        (this.nodeCores[i].material as THREE.SpriteMaterial).opacity = 0.03;
      } else if (!hl && this._fileOpacityOriginal.has(i)) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = this._fileOpacityOriginal.get(i)!;
        (this.nodeCores[i].material as THREE.SpriteMaterial).opacity = this._fileOpacityOriginal.get(i)! * 0.6;
        this._fileOpacityOriginal.delete(i);
      }
    }

    // Edges: dim all when highlighting
    for (const lines of this.edgeLineGroups) {
      const mat = lines.material as THREE.LineBasicMaterial;
      if (hl) {
        (lines as any).__prevOpacity = mat.opacity;
        mat.opacity = 0.015;
      } else if ((lines as any).__prevOpacity !== undefined) {
        mat.opacity = (lines as any).__prevOpacity;
        delete (lines as any).__prevOpacity;
      }
    }

    // Labels: hide non-highlighted
    for (let k = 0; k < this.nodeLabelIdx.length; k++) {
      this.labelDivs[k].style.display = (!hl || idxs.has(this.nodeLabelIdx[k])) ? '' : 'none';
    }

    // Fly to centroid of highlighted nodes
    if (hl && idxs.size > 0) {
      let cx = 0, cy = 0, cz = 0;
      for (const i of idxs) {
        cx += this.nodePositions[i * 3];
        cy += this.nodePositions[i * 3 + 1];
        cz += this.nodePositions[i * 3 + 2];
      }
      const n = idxs.size;
      this.focusTarget.set(cx / n, cy / n, cz / n);
      this.focusStartCam.copy(this.camera.position);
      this.focusStartLook.copy(this.controls.target);
      this.focusActive = true;
      this.focusProgress = 0;
      this.focusFlash = 0;
    }
  }

  // ══════════════════════════════════════════════════════════
  // Community / Galaxy fold overlay
  // ══════════════════════════════════════════════════════════

  get isFolded(): boolean { return this.foldMode; }
  get isInsideGalaxy(): boolean { return this.enteredGalaxyId !== null; }
  get communityCount(): number { return this.communities.length; }

  /** Toggle galaxy fold overlay on/off. Re-renders from stored data. */
  setFoldMode(on: boolean): void {
    if (on === this.foldMode) return;
    this.foldMode = on;
    this.enteredGalaxyId = null;
    if (on) {
      // Dark-universe fold: subdued exposure + bloom
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 0.6;
      // Full mode: subtle bloom for fold view
      if (true) {
        if (this.composer.passes.indexOf(this.bloomPass) === -1) {
          this.composer.addPass(this.bloomPass);
        }
        this.bloomPass.strength = 0.2;
        this.bloomPass.threshold = 0.9;
      }
      // Standard mode: no bloom, nothing to adjust
      this.applyFoldOverlay();
      // Start cross-edge energy flow
      this.initCrossEdgeFlow();
      const st = document.getElementById('status-text');
      if (st) st.innerHTML = `${iconHtml('galaxy', 12)} ${this.galaxyMeta.length} 星团 · 点击进入或搜索`;
    } else {
      this.clearFoldOverlay();
      // Restore original tone mapping + bloom for this mode
      if (true) {
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.4;
        this.bloomPass.strength = 0.35;
        this.bloomPass.threshold = 0.85;
        if (this.composer.passes.indexOf(this.bloomPass) === -1) {
          this.composer.addPass(this.bloomPass);
        }
      } else {
        // Standard mode: no bloom, just reset tone mapping
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.toneMappingExposure = 1.0;
      }
    }
  }

  toggleFold(): void { this.setFoldMode(!this.foldMode); }

  // ── Diff overlay (P4: 变更回看着色) ──────────────────────

  /** Apply diff coloring: green=added, red=removed, orange=modified. */
  showDiff(diffJson: { added_nodes?: Array<{id:string}>; removed_nodes?: Array<{id:string}>; modified_nodes?: Array<{node_id:string}> }): void {
    this.diffActive = true;
    this.diffAddedIds = new Set((diffJson.added_nodes || []).map(n => n.id));
    this.diffRemovedIds = new Set((diffJson.removed_nodes || []).map(n => n.id));
    this.diffModifiedIds = new Set((diffJson.modified_nodes || []).map(n => n.node_id));

    const GREEN = 0x44dd44, RED = 0xee4444, ORANGE = 0xf0a020;

    for (let i = 0; i < this.graphNodes.length; i++) {
      const nid = this.graphNodes[i].id;
      let diffColor: number | null = null;
      if (this.diffAddedIds.has(nid)) diffColor = GREEN;
      else if (this.diffRemovedIds.has(nid)) diffColor = RED;
      else if (this.diffModifiedIds.has(nid)) diffColor = ORANGE;

      if (diffColor !== null && this.nodeGlows[i]) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).color.set(diffColor);
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.85;
      }
    }

    // Pulse effect on diff nodes: slightly increase scale
    for (let i = 0; i < this.graphNodes.length; i++) {
      if (this.diffAddedIds.has(this.graphNodes[i].id) && this.nodeCores[i]) {
        this.nodeCores[i].scale.setScalar((this.nodeCores[i].scale.x || 1) * 1.3);
      }
    }
  }

  /** Remove diff coloring, restore normal colors. */
  clearDiff(): void {
    if (!this.diffActive) return;
    this.diffActive = false;
    this.diffAddedIds.clear();
    this.diffRemovedIds.clear();
    this.diffModifiedIds.clear();

    const isFull = true;
    for (let i = 0; i < this.graphNodes.length; i++) {
      const kind = ((this.graphNodes[i].type || this.graphNodes[i].kind || 'symbol') as string).toLowerCase();
      const glowColor = GLOW_COLORS[kind] || 0x4488cc;
      if (this.nodeGlows[i]) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).color.set(glowColor);
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = false ? 0 : 0.55;
      }
      if (this.nodeCores[i]) {
        const coreColor = isFull ? 0xffffff : (NODE_COLORS[kind] || 0x7eb8ff);
        (this.nodeCores[i].material as THREE.MeshBasicMaterial).color.set(coreColor);
        const baseScale = this.getNodeBaseScale(i);
        this.nodeCores[i].scale.setScalar(isFull ? baseScale * 0.4 : baseScale);
      }
    }
  }

  get hasDiff(): boolean { return this.diffActive; }

  // ══════════════════════════════════════════════════════════
  // Fold overlay — two layers
  //   Layer 1 (universe): galaxy clouds at centroids, unique hues, nodes hidden
  //   Layer 2 (inside):   single constellation — member nodes + internal edges lit
  // ══════════════════════════════════════════════════════════

  private static readonly CONSTELLATION_COLOR = 0xffaa44;
  /** Communities with fewer members than this are hidden from the galaxy view. */
  private static readonly MIN_GALAXY_SIZE = 5;

  private _communityGlowSprites: THREE.Sprite[] = [];
  private _hoveredCommunityIdx = -1;

  private _buildCommunityRings(): void {
    while (this.communityRingGroup.children.length > 0) {
      this.communityRingGroup.remove(this.communityRingGroup.children[0]);
    }
    this._communityGlowSprites = [];
    // Build soft radial glow texture
    const size = 128;
    const cvs = document.createElement('canvas'); cvs.width = size; cvs.height = size;
    const ctx = cvs.getContext('2d')!;
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.75, 'rgba(255,255,255,0.06)');
    gradient.addColorStop(0.9, 'rgba(255,255,255,0.18)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, size, size);
    const glowTex = new THREE.CanvasTexture(cvs);

    for (let gi = 0; gi < this.galaxyMeta.length; gi++) {
      const gm = this.galaxyMeta[gi];
      if (gm.radius <= 0) continue;
      const hue = ((gm.id.split('').reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0), 0) & 0x7fffffff) % 360) / 360;
      const color = new THREE.Color().setHSL(hue, 0.3, 0.5);
      const mat = new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 });
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(gm.centroid);
      sprite.scale.setScalar(gm.radius * 2.5);
      this.communityRingGroup.add(sprite);
      this._communityGlowSprites.push(sprite);
    }
  }

  private _updateCommunityRingHover(): void {
    const prev = this._hoveredCommunityIdx;
    let next = -1;
    if (this.hoveredIdx >= 0 && this.hoveredIdx < this.graphNodes.length) {
      for (let gi = 0; gi < this.galaxyMeta.length; gi++) {
        if (this.galaxyMeta[gi].memberIndices.includes(this.hoveredIdx)) { next = gi; break; }
      }
    }
    if (next === prev) return;
    if (prev >= 0 && this._communityGlowSprites[prev]) {
      (this._communityGlowSprites[prev].material as THREE.SpriteMaterial).opacity = 0;
    }
    if (next >= 0 && this._communityGlowSprites[next]) {
      (this._communityGlowSprites[next].material as THREE.SpriteMaterial).opacity = 0.25;
    }
    this._hoveredCommunityIdx = next;
  }

  private applyFoldOverlay(): void {
    // Hide all nodes
    for (let i = 0; i < this.graphNodes.length; i++) {
      if (this.nodeCores[i]) this.nodeCores[i].visible = false;
      if (this.nodeGlows[i]) this.nodeGlows[i].visible = false;
      if (this.nodeGlows2[i]) this.nodeGlows2[i].visible = false;
    }
    // Hide ALL edges — additive blending makes even 0.02 accumulate to bright
    for (const lines of this.edgeLineGroups) {
      lines.visible = false;
    }
    while (this.highlightEdgeGroup.children.length) {
      this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);
    }
    if (this.edgeParticles) this.edgeParticles.visible = false;
    if (this.enteredGalaxyId) {
      // Layer 2: inside a galaxy — show its nodes + internal edges as a constellation
      this._showConstellation(this.enteredGalaxyId);
    } else {
      // Layer 1: universe view — galaxy clouds at centroids, no cross edges
      this.buildGalaxyClouds();
    }
  }

  private clearFoldOverlay(): void {
    this.hoveredGalaxyIdx = -1;
    this.hideGalaxyTitle();
    const isFull = true;
    for (let i = 0; i < this.graphNodes.length; i++) {
      const kind = ((this.graphNodes[i].type || this.graphNodes[i].kind || 'symbol') as string).toLowerCase();
      const glowColor = GLOW_COLORS[kind] || 0x4488cc;
      const coreColor = glowColor; // dark-universe: type-colored core, not white-hot
      if (this.nodeCores[i]) { this.nodeCores[i].visible = true; (this.nodeCores[i].material as THREE.MeshBasicMaterial).color.set(coreColor); }
      if (this.nodeGlows[i]) { this.nodeGlows[i].visible = true; (this.nodeGlows[i].material as THREE.SpriteMaterial).color.set(glowColor); }
      if (this.nodeGlows2[i]) this.nodeGlows2[i].visible = true;
    }
    for (const lines of this.edgeLineGroups) {
      lines.visible = true;
    }
    if (this.edgeParticles) this.edgeParticles.visible = true;
    this._disposeFoldChildren();
    this.clearCrossEdgeFlow();
    this.galaxyClouds = []; this.galaxyGlows = [];
  }

  /** Dispose all children of commFoldGroup, releasing GPU resources. */
  private _disposeFoldChildren(): void {
    while (this.commFoldGroup.children.length) {
      const child = this.commFoldGroup.children[0];
      if ((child as any).geometry) (child as any).geometry.dispose();
      const mat = (child as any).material;
      if (mat) {
        if (Array.isArray(mat)) mat.forEach((m: THREE.Material) => m.dispose());
        else (mat as THREE.Material).dispose();
      }
      this.commFoldGroup.remove(child);
    }
  }

  /** Reveal one galaxy as a constellation: member nodes glow + internal edges bright.
   * Returns count of sub-communities found. */
  private _showConstellation(galaxyId: string): number {
    const gm = this.galaxyMeta.find(g => g.id === galaxyId);
    if (!gm) return 0;
    const isFull = true;
    const cc = new THREE.Color(StarGraph.CONSTELLATION_COLOR);
    for (const mi of gm.memberIndices) {
      if (this.nodeCores[mi]) {
        this.nodeCores[mi].visible = true;
        (this.nodeCores[mi].material as THREE.MeshBasicMaterial).color.set(StarGraph.CONSTELLATION_COLOR);
      }
      if (this.nodeGlows[mi]) {
        this.nodeGlows[mi].visible = true;
        (this.nodeGlows[mi].material as THREE.SpriteMaterial).color.set(StarGraph.CONSTELLATION_COLOR);
      }
    }
    // Internal edges for this galaxy only
    const pos = this.nodePositions;
    const verts: number[] = [], colors: number[] = [];
    for (let ei = 0; ei < this.edgeDataList.length; ei++) {
      const { s, t } = this.edgeDataList[ei];
      const sc = this.nodeCommMap.get(s), tc = this.nodeCommMap.get(t);
      if (!sc || sc !== galaxyId || tc !== galaxyId) continue;
      verts.push(pos[s * 3], pos[s * 3 + 1], pos[s * 3 + 2], pos[t * 3], pos[t * 3 + 1], pos[t * 3 + 2]);
      colors.push(cc.r, cc.g, cc.b, cc.r, cc.g, cc.b);
    }
    if (verts.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      this.commFoldGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.06,
        depthWrite: false, blending: THREE.AdditiveBlending,
      })));
    }

    // Show sub-communities (Level 1+) if they exist
    // Match any community whose parent_id matches this galaxy
    const subCommunities = this.communities.filter(c => {
      if (!c.parent_id || c.parent_id !== galaxyId) return false;
      // level may be number or string from JSON round-trip; cast robustly
      const lvl = Number(c.level);
      return !isNaN(lvl) && lvl >= 1;
    });
    let subCount = 0;
    this._subCommByNodeIdx.clear();
    if (subCommunities.length > 0) {
      const subColors = [0x66aaff, 0xff66aa, 0x66ffaa, 0xffaa66, 0xaa66ff]; // Distinct colors for sub-communities
      subCommunities.forEach((subComm, idx) => {
        const subColor = new THREE.Color(subColors[idx % subColors.length]);
        const subMembers: number[] = [];
        for (const nid of subComm.node_ids) {
          const nodeIdx = this.graphNodes.findIndex(n => n.id === nid);
          if (nodeIdx >= 0) {
            subMembers.push(nodeIdx);
            this._subCommByNodeIdx.set(nodeIdx, subComm.id);
          }
        }
        if (subMembers.length > 0) subCount++;
        // Highlight sub-community nodes with distinct color (override full mode white)
        for (const mi of subMembers) {
          if (this.nodeCores[mi]) {
            (this.nodeCores[mi].material as THREE.MeshBasicMaterial).color.set(subColor);
          }
          if (this.nodeGlows[mi]) {
            (this.nodeGlows[mi].material as THREE.SpriteMaterial).color.set(subColor);
          }
        }
      });
    }
    return subCount;
  }

  /** Enter a galaxy: hide clouds, reveal its constellation. */
  private galaxyTitleEl!: HTMLDivElement;

  enterGalaxy(galaxyId: string): void {
    if (!this.foldMode || this.enteredGalaxyId === galaxyId) return;
    this.enteredGalaxyId = galaxyId;
    this.enteredSubCommunityId = null;
    this._drillStack = []; // Reset sub-community drill path
    // Dismiss any lingering galaxy hover tooltip
    this.hoveredGalaxyIdx = -1;
    this.container.style.cursor = '';
    this.tooltipEl?.classList.remove('visible');
    // Clear fold group
    this._disposeFoldChildren();
    this.galaxyClouds = []; this.galaxyGlows = [];

    // Find sub-communities of this galaxy
    const subCommunities = this.communities.filter(c => {
      if (!c.parent_id || c.parent_id !== galaxyId) return false;
      const lvl = Number(c.level);
      return !isNaN(lvl) && lvl >= 1;
    });

    if (subCommunities.length > 0) {
      // Has sub-communities → show sub-community clouds (drill deeper)
      this._showSubCommunityClouds(subCommunities);
      const gm = this.galaxyMeta.find(g => g.id === galaxyId);
      this.showGalaxyTitle(gm);
      const st = document.getElementById('status-text');
      if (st) st.innerHTML = `${iconHtml('galaxy', 12)} ${gm?.label || galaxyId} · ${subCommunities.length} 子星团 · 点击进入或 ESC 退回`;
    } else {
      // Leaf galaxy → show constellation (all member nodes)
      this._showConstellation(galaxyId);
      const gm = this.galaxyMeta.find(g => g.id === galaxyId);
      // Set up independent camera orbit around the constellation centroid
      if (gm) {
        let clusterRadius = 30;
        for (const mi of gm.memberIndices) {
          const dx = this.nodePositions[mi * 3] - gm.centroid.x;
          const dy = this.nodePositions[mi * 3 + 1] - gm.centroid.y;
          const dz = this.nodePositions[mi * 3 + 2] - gm.centroid.z;
          clusterRadius = Math.max(clusterRadius, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        const viewDist = clusterRadius * 3.2;
        const camPos = gm.centroid.clone().add(
          new THREE.Vector3(viewDist * 0.55, viewDist * 0.4, viewDist * 0.7));
        this.focusTarget.copy(camPos);
        this.focusStartCam.copy(this.camera.position);
        this.focusStartLook.copy(this.controls.target);
        this._constellationLookTarget = gm.centroid.clone();
        this.focusActive = true; this.focusProgress = 0; this.focusNodeIdx = -1; this.focusFlash = 0;
        this.controls.target.copy(gm.centroid);
        this.controls.enablePan = true;
        this.controls.minDistance = clusterRadius * 1.5;
        this.controls.maxDistance = clusterRadius * 8;
      }
      this.showGalaxyTitle(gm);
      const st = document.getElementById('status-text');
      if (st) st.innerHTML = `${iconHtml('focus', 12)} 星座: ${gm?.label || galaxyId} · ${gm?.memberIndices.length || 0} 节点 · ESC 退回`;
    }
  }

  /** Render sub-community clouds — clickable "mini galaxies" inside a parent galaxy. */
  private _showSubCommunityClouds(subCommunities: CommunityData[]): void {
    // Build temporary galaxyMeta entries for sub-community clouds
    const subMeta: { id: string; label: string; centroid: THREE.Vector3; memberIndices: number[]; radius: number }[] = [];
    for (const sc of subCommunities) {
      const memberIndices: number[] = [];
      let sx = 0, sy = 0, sz = 0;
      for (const nid of sc.node_ids) {
        const idx = this.graphNodes.findIndex(n => n.id === nid);
        if (idx >= 0) {
          memberIndices.push(idx);
          sx += this.nodePositions[idx * 3];
          sy += this.nodePositions[idx * 3 + 1];
          sz += this.nodePositions[idx * 3 + 2];
        }
      }
      if (memberIndices.length === 0) continue;
      subMeta.push({
        id: sc.id,
        label: sc.label,
        centroid: new THREE.Vector3(sx / memberIndices.length, sy / memberIndices.length, sz / memberIndices.length),
        memberIndices,
        radius: 0,
      });
    }
    // Hide all nodes
    for (let i = 0; i < this.graphNodes.length; i++) {
      if (this.nodeCores[i]) this.nodeCores[i].visible = false;
      if (this.nodeGlows[i]) this.nodeGlows[i].visible = false;
    }
    // Save original galaxyMeta if not already saved, then swap for cloud rendering
    if (!this._savedGalaxyMeta) this._savedGalaxyMeta = this.galaxyMeta;
    this.galaxyMeta = subMeta;
    this.buildGalaxyClouds();
    // Tighten hover targets for sub-community clouds (core sprites are oversized by default)
    for (let i = 0; i < this.galaxyGlows.length; i++) {
      this.galaxyGlows[i].scale.multiplyScalar(i % 2 === 1 ? 0.4 : 0.35);
    }
    for (const cloud of this.galaxyClouds) {
      cloud.scale.multiplyScalar(0.6);
    }

    // Frame camera on all sub-community centroids
    if (subMeta.length > 0) {
      let cx = 0, cy = 0, cz = 0;
      for (const sm of subMeta) { cx += sm.centroid.x; cy += sm.centroid.y; cz += sm.centroid.z; }
      cx /= subMeta.length; cy /= subMeta.length; cz /= subMeta.length;
      let maxR = 30;
      for (const sm of subMeta) {
        const dx = sm.centroid.x - cx, dy = sm.centroid.y - cy, dz = sm.centroid.z - cz;
        maxR = Math.max(maxR, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
      const centroid = new THREE.Vector3(cx, cy, cz);
      const viewDist = Math.max(maxR * 3.0, 120);
      this.focusTarget.copy(centroid.clone().add(new THREE.Vector3(viewDist * 0.5, viewDist * 0.4, viewDist * 0.7)));
      this.focusStartCam.copy(this.camera.position);
      this.focusStartLook.copy(this.controls.target);
      this._constellationLookTarget = centroid.clone();
      this.focusActive = true; this.focusProgress = 0; this.focusNodeIdx = -1; this.focusFlash = 0;
      this.controls.target.copy(centroid);
      this.controls.minDistance = maxR * 1.5;
      this.controls.maxDistance = maxR * 12;
    }
  }

  /** When flying to constellation, controls look at centroid, not at camera target. */
  private _constellationLookTarget = new THREE.Vector3();

  /** Show fixed galaxy title at top of viewport when inside a constellation. */
  private showGalaxyTitle(gm: { id: string; label: string } | undefined): void {
    if (!this.galaxyTitleEl) {
      this.galaxyTitleEl = document.createElement('div');
      this.galaxyTitleEl.id = 'galaxy-title';
      this.galaxyTitleEl.style.cssText =
        'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:15;' +
        'font-size:18px;font-weight:700;letter-spacing:1px;pointer-events:none;' +
        'color:#ffcc80;text-shadow:0 0 20px rgba(255,160,40,0.6),0 0 40px rgba(255,100,20,0.3);' +
        'transition:opacity 0.3s;opacity:0;';
      this.container.appendChild(this.galaxyTitleEl);
    }
    const shortName = gm ? gm.label.split('/')[0].replace(/_/g, ' ') : '';
    this.galaxyTitleEl.textContent = `🌌 ${shortName}`;
    this.galaxyTitleEl.style.opacity = '1';
  }

  private hideGalaxyTitle(): void {
    if (this.galaxyTitleEl) this.galaxyTitleEl.style.opacity = '0';
  }

  /** Show a temporary floating label at the galaxy centroid. */
  private showGalaxyLabel(gm: { id: string; label: string; centroid: THREE.Vector3 } | undefined): void {
    if (!gm) return;
    const label = document.createElement('div');
    label.className = 'galaxy-flash-label';
    label.textContent = `🌌 ${gm.label || gm.id}`;
    label.style.cssText = 'position:absolute;z-index:12;pointer-events:none;font-size:16px;font-weight:700;color:#ffe0a0;text-shadow:0 0 20px rgba(255,180,60,0.8),0 0 40px rgba(255,140,30,0.4);white-space:nowrap;opacity:0;transition:opacity 0.2s;';
    const halfW = this.container.clientWidth * 0.5, halfH = this.container.clientHeight * 0.5;
    this.tmpVec3.copy(gm.centroid).project(this.camera);
    label.style.left = `${this.tmpVec3.x * halfW + halfW}px`;
    label.style.top = `${-this.tmpVec3.y * halfH + halfH}px`;
    label.style.transform = 'translate(-50%, -50%)';
    this.container.appendChild(label);
    requestAnimationFrame(() => { label.style.opacity = '1'; });
    setTimeout(() => { label.style.opacity = '0'; setTimeout(() => label.remove(), 300); }, 1800);
  }

  /** Check if a community has visible sub-communities (Level 1+ with enough members). */
  private _hasVisibleSubCommunities(parentId: string): boolean {
    return this.communities.some(c => {
      if (!c.parent_id || c.parent_id !== parentId) return false;
      const lvl = Number(c.level);
      return !isNaN(lvl) && lvl >= 1 && c.node_ids.length >= 4;
    });
  }

  /** Exit galaxy back to universe view. */
  exitGalaxy(): void {
    if (!this.foldMode || !this.enteredGalaxyId) return;
    this.enteredGalaxyId = null;
    this.enteredSubCommunityId = null;
    this._drillStack = [];
    this.hideGalaxyTitle();
    // Restore free controls — zoom range scaled to graph size
    this.controls.enablePan = true;
    this.controls.minDistance = Math.max(1, this._graphRadius * 0.005);
    this.controls.maxDistance = this._graphRadius * 6;
    this.camera.near = Math.max(0.1, this.controls.minDistance * 0.5);
    this.camera.far = this.controls.maxDistance * 2;
    this.camera.updateProjectionMatrix();
    this._disposeFoldChildren();
    // Re-hide all nodes AND restore their original kind-based colors
    const isFull = true;
    for (let i = 0; i < this.graphNodes.length; i++) {
      const kind = ((this.graphNodes[i].type || this.graphNodes[i].kind || 'symbol') as string).toLowerCase();
      const coreColor = isFull ? 0xffffff : (NODE_COLORS[kind] || 0x7eb8ff);
      const glowColor = GLOW_COLORS[kind] || 0x4488cc;
      if (this.nodeCores[i]) { this.nodeCores[i].visible = false; (this.nodeCores[i].material as THREE.MeshBasicMaterial).color.set(coreColor); }
      if (this.nodeGlows[i]) { this.nodeGlows[i].visible = false; (this.nodeGlows[i].material as THREE.SpriteMaterial).color.set(glowColor); }
      if (this.nodeGlows2[i]) this.nodeGlows2[i].visible = false;
    }
    // Restore original galaxyMeta
    if (this._savedGalaxyMeta) { this.galaxyMeta = this._savedGalaxyMeta; this._savedGalaxyMeta = null; }
    this.buildGalaxyClouds();
    const st = document.getElementById('status-text');
    if (st) st.innerHTML = `${iconHtml('galaxy', 12)} ${this.galaxyMeta.length} 星团 · 点击进入或搜索`;
  }

  /** Stash for original galaxyMeta when drilling into sub-cloud view. */
  private _savedGalaxyMeta: typeof this.galaxyMeta | null = null;

  /** Drill into a sub-community — show sub-clouds if it has children, or constellation if leaf. */
  enterSubCommunity(subCommId: string): void {
    if (!this.foldMode || !this.enteredGalaxyId || this.enteredSubCommunityId === subCommId) return;
    const subComm = this.communities.find(c => c.id === subCommId);
    if (!subComm) return;
    this._drillStack.push(subCommId);
    this.enteredSubCommunityId = subCommId;
    // Dismiss any lingering cloud hover tooltip
    this.hoveredGalaxyIdx = -1;
    this.container.style.cursor = '';
    this.tooltipEl?.classList.remove('visible');
    this._disposeFoldChildren();
    this.galaxyClouds = []; this.galaxyGlows = [];

    // Check for deeper sub-communities
    const deeperSubs = this.communities.filter(c => {
      if (!c.parent_id || c.parent_id !== subCommId) return false;
      const lvl = Number(c.level);
      return !isNaN(lvl) && lvl >= 2;
    });

    if (deeperSubs.length > 0) {
      // Has deeper sub-communities → show them as clouds
      this._showSubCommunityClouds(deeperSubs);
      const shortName = subComm.label.split('/')[0].replace(/_/g, ' ');
      this.showGalaxyTitle({ id: subCommId, label: subComm.label });
      const st = document.getElementById('status-text');
      if (st) st.innerHTML = `${iconHtml('galaxy', 12)} 子社区: ${shortName} · ${deeperSubs.length} 子星团 · 点击进入或 ESC 退回`;
    } else {
      // Leaf sub-community → show constellation (nodes with edges)
      // Hide all nodes first
      for (let i = 0; i < this.graphNodes.length; i++) {
        if (this.nodeCores[i]) this.nodeCores[i].visible = false;
        if (this.nodeGlows[i]) this.nodeGlows[i].visible = false;
      }
      // Show only sub-community members
      const shownIndices: number[] = [];
      for (const nid of subComm.node_ids) {
        const idx = this.graphNodes.findIndex(n => n.id === nid);
        if (idx >= 0) {
          shownIndices.push(idx);
          if (this.nodeCores[idx]) {
            this.nodeCores[idx].visible = true;
            (this.nodeCores[idx].material as THREE.MeshBasicMaterial).color.set(0xffaa44);
          }
          if (this.nodeGlows[idx]) {
            this.nodeGlows[idx].visible = true;
            (this.nodeGlows[idx].material as THREE.SpriteMaterial).color.set(0xffaa44);
            (this.nodeGlows[idx].material as THREE.SpriteMaterial).opacity = 0.7;
          }
        }
      }
      this._buildSubCommunityEdges(subComm.node_ids);
      // Camera frame
      let sx = 0, sy = 0, sz = 0;
      for (const mi of shownIndices) {
        sx += this.nodePositions[mi * 3]; sy += this.nodePositions[mi * 3 + 1]; sz += this.nodePositions[mi * 3 + 2];
      }
      const centroid = new THREE.Vector3(sx / shownIndices.length, sy / shownIndices.length, sz / shownIndices.length);
      let clusterRadius = 30;
      for (const mi of shownIndices) {
        const dx = this.nodePositions[mi * 3] - centroid.x;
        const dy = this.nodePositions[mi * 3 + 1] - centroid.y;
        const dz = this.nodePositions[mi * 3 + 2] - centroid.z;
        clusterRadius = Math.max(clusterRadius, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
      const viewDist = clusterRadius * 3.5;
      this.focusTarget.copy(centroid.clone().add(new THREE.Vector3(viewDist * 0.5, viewDist * 0.4, viewDist * 0.7)));
      this.focusStartCam.copy(this.camera.position);
      this.focusStartLook.copy(this.controls.target);
      this._constellationLookTarget = centroid.clone();
      this.focusActive = true; this.focusProgress = 0; this.focusNodeIdx = -1; this.focusFlash = 0;
      this.controls.target.copy(centroid);
      this.controls.minDistance = clusterRadius * 1.5;
      this.controls.maxDistance = clusterRadius * 8;
      const shortName = subComm.label.split('/')[0].replace(/_/g, ' ');
      this.showGalaxyTitle({ id: subCommId, label: subComm.label });
      const st = document.getElementById('status-text');
      if (st) st.innerHTML = `${iconHtml('focus', 12)} 子社区: ${shortName} · ${shownIndices.length} 节点 · ESC 退回`;
    }
  }

  /** Exit sub-community: pop drill stack, restore parent's view. */
  exitSubCommunity(): void {
    if (!this.foldMode || this._drillStack.length === 0) return;
    // Pop current sub-community from stack
    this._drillStack.pop();
    this._disposeFoldChildren();
    this.galaxyClouds = []; this.galaxyGlows = [];

    if (this._drillStack.length > 0) {
      // Still inside a sub-community chain — restore that sub-community's view
      const parentSubId = this._drillStack[this._drillStack.length - 1];
      this.enteredSubCommunityId = parentSubId;
      const parentSub = this.communities.find(c => c.id === parentSubId);
      if (!parentSub) return;
      // Check if this parent has deeper sub-communities
      if (this._hasVisibleSubCommunities(parentSubId)) {
        const deeperSubs = this.communities.filter(c => c.parent_id === parentSubId && Number(c.level) >= 2);
        this._showSubCommunityClouds(deeperSubs);
        const shortName = parentSub.label.split('/')[0].replace(/_/g, ' ');
        this.showGalaxyTitle({ id: parentSubId, label: parentSub.label });
        const st = document.getElementById('status-text');
        if (st) st.innerHTML = `${iconHtml('galaxy', 12)} 子社区: ${shortName} · ${deeperSubs.length} 子星团 · 点击进入或 ESC 退回`;
      } else {
        // Leaf — show constellation for this sub-community
        for (let i = 0; i < this.graphNodes.length; i++) {
          if (this.nodeCores[i]) this.nodeCores[i].visible = false;
          if (this.nodeGlows[i]) this.nodeGlows[i].visible = false;
        }
        const shownIndices: number[] = [];
        for (const nid of parentSub.node_ids) {
          const idx = this.graphNodes.findIndex(n => n.id === nid);
          if (idx >= 0) {
            shownIndices.push(idx);
            if (this.nodeCores[idx]) { this.nodeCores[idx].visible = true; (this.nodeCores[idx].material as THREE.MeshBasicMaterial).color.set(0xffaa44); }
            if (this.nodeGlows[idx]) { this.nodeGlows[idx].visible = true; (this.nodeGlows[idx].material as THREE.SpriteMaterial).color.set(0xffaa44); (this.nodeGlows[idx].material as THREE.SpriteMaterial).opacity = 0.7; }
          }
        }
        this._buildSubCommunityEdges(parentSub.node_ids);
        const shortName = parentSub.label.split('/')[0].replace(/_/g, ' ');
        this.showGalaxyTitle({ id: parentSubId, label: parentSub.label });
        const st = document.getElementById('status-text');
        if (st) st.innerHTML = `${iconHtml('focus', 12)} 子社区: ${shortName} · ${shownIndices.length} 节点 · ESC 退回`;
      }
    } else {
      // Back at galaxy level — restore galaxy's view
      this.enteredSubCommunityId = null;
      const galaxyId = this.enteredGalaxyId;
      if (!galaxyId) return;
      if (this._hasVisibleSubCommunities(galaxyId)) {
        const subCommunities = this.communities.filter(c => c.parent_id === galaxyId && Number(c.level) >= 1);
        this._showSubCommunityClouds(subCommunities);
        const gm = this.galaxyMeta.find(g => g.id === galaxyId);
        this.showGalaxyTitle(gm);
        const st = document.getElementById('status-text');
        if (st) st.innerHTML = `${iconHtml('galaxy', 12)} ${gm?.label || galaxyId} · ${subCommunities.length} 子星团 · 点击进入或 ESC 退回`;
      } else {
        this._showConstellation(galaxyId);
        const gm = this.galaxyMeta.find(g => g.id === galaxyId);
        this.showGalaxyTitle(gm);
        const st = document.getElementById('status-text');
        if (st) st.innerHTML = `${iconHtml('focus', 12)} 星座: ${gm?.label || galaxyId} · ${gm?.memberIndices.length || 0} 节点 · ESC 退回`;
      }
    }
  }

  /** Build internal edges for a sub-community's member nodes. */
  private _buildSubCommunityEdges(nodeIds: string[]): void {
    const memberSet = new Set(nodeIds);
    const pos = this.nodePositions;
    const verts: number[] = [], colors: number[] = [];
    const cc = new THREE.Color(0xffaa44);
    for (const d of this.edgeDataList) {
      const nidS = this.graphNodes[d.s]?.id, nidT = this.graphNodes[d.t]?.id;
      if (!nidS || !nidT) continue;
      if (!memberSet.has(nidS) || !memberSet.has(nidT)) continue;
      verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
      colors.push(cc.r, cc.g, cc.b, cc.r, cc.g, cc.b);
    }
    if (verts.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.commFoldGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.08,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })));
  }

  // ── Galaxy clouds (universe view) ────────────────────────

  /** Build galaxy clusters — dense core + sparse halo, each visually distinct. */
  private buildGalaxyClouds(): void {
    this.galaxyClouds = []; this.galaxyGlows = [];
    const total = this.galaxyMeta.length;
    const goldenRatio = 0.618033988749895;
    for (let gi = 0; gi < total; gi++) {
      const gm = this.galaxyMeta[gi];
      // Galaxies are aggregates — should dominate the view
      // 5 nodes→81, 50 nodes→158, 120 nodes→220
      const r = 45 + Math.sqrt(gm.memberIndices.length) * 16;
      // Wide hue spread across the full warm-cool spectrum for distinction
      const hue = ((gi * goldenRatio) % 1) * 0.26 + 0.03;  // 0.03–0.29 (orange→yellow→green→teal)
      const tint = new THREE.Color(); tint.setHSL(hue, 0.7, 0.4);    // subdued ambient
      const bright = new THREE.Color(); bright.setHSL(hue, 0.35, 0.7); // visible but not blinding
      // Shape variety: varying flattening and tilt per galaxy
      const flat = 0.3 + (gm.memberIndices.length % 7) * 0.05;  // 0.30-0.60 disk thickness
      const elon = 0.6 + (gm.memberIndices.length % 5) * 0.08;  // 0.60-0.92 equatorial elongation
      const tiltA = (gm.id.charCodeAt(gm.id.length - 1) * 2.3) % (Math.PI * 2);
      const tiltB = (gm.id.charCodeAt(0) * 1.5) % (Math.PI * 0.5);
      const ctA = Math.cos(tiltA), stA = Math.sin(tiltA);
      const ctB = Math.cos(tiltB), stB = Math.sin(tiltB);
      // ── Dense inner core particles (bright, tightly clustered) ──
      const coreN = Math.min(250, 25 + Math.floor(gm.memberIndices.length * 2.2));
      const corePos = new Float32Array(coreN * 3);
      const coreCol = new Float32Array(coreN * 3);
      for (let j = 0; j < coreN; j++) {
        const dr = Math.abs(this._gaussRand()) * 0.25 * r;
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        let px = Math.cos(th) * Math.sin(ph) * dr;
        let py = Math.sin(ph) * dr * flat * 0.6;
        let pz = Math.sin(th) * Math.sin(ph) * dr * elon;
        // Double rotation
        let rx = px * ctA - pz * stA; let rz = px * stA + pz * ctA;
        let ry = py * ctB - rz * stB; rz = py * stB + rz * ctB;
        corePos[j * 3] = gm.centroid.x + rx;
        corePos[j * 3 + 1] = gm.centroid.y + ry;
        corePos[j * 3 + 2] = gm.centroid.z + rz;
        const f = 1 - (dr / (r * 0.25)) * 0.3;
        coreCol[j * 3] = bright.r * f + (1 - f);
        coreCol[j * 3 + 1] = bright.g * f + (1 - f) * 0.7;
        coreCol[j * 3 + 2] = bright.b * f + (1 - f) * 0.3;
      }
      const coreGeo = new THREE.BufferGeometry();
      coreGeo.setAttribute('position', new THREE.BufferAttribute(corePos, 3));
      coreGeo.setAttribute('color', new THREE.BufferAttribute(coreCol, 3));
      this.commFoldGroup.add(new THREE.Points(coreGeo, new THREE.PointsMaterial({
        size: 3.5, map: this.glowTex, blending: THREE.AdditiveBlending,
        depthWrite: false, vertexColors: true, transparent: true, opacity: 0.17,
      })));
      // ── Sparse outer halo particles with spiral arm structure ──
      const haloN = Math.min(1500, 150 + gm.memberIndices.length * 15);
      const haloPos = new Float32Array(haloN * 3);
      const haloCol = new Float32Array(haloN * 3);
      const useSpiral = gm.memberIndices.length >= 8;
      const armCount = gm.memberIndices.length >= 30 ? 3 : 2;
      const twist = 0.08 + (gm.memberIndices.length % 13) * 0.007; // 1.5–2.5 full turns per galaxy
      for (let j = 0; j < haloN; j++) {
        let dr: number, px: number, py: number, pz: number;
        if (useSpiral && Math.random() < 0.85) {
          // Spiral arm particle
          dr = (0.15 + Math.random() * 0.85) * r;
          const armIdx = j % armCount;
          const armAngle = dr * twist + (armIdx * Math.PI * 2) / armCount;
          const scatter = Math.abs(this._gaussRand()) * 0.15 * r; // arm width
          const a = armAngle + this._gaussRand() * 0.3; // angle jitter
          px = Math.cos(a) * dr + this._gaussRand() * scatter;
          py = this._gaussRand() * dr * flat * 0.3;
          pz = Math.sin(a) * dr + this._gaussRand() * scatter;
        } else {
          // Random scatter halo
          dr = (0.25 + Math.abs(this._gaussRand()) * 0.75) * r;
          const th = Math.random() * Math.PI * 2;
          const ph = Math.acos(2 * Math.random() - 1);
          px = Math.cos(th) * Math.sin(ph) * dr;
          py = Math.sin(ph) * dr * flat;
          pz = Math.sin(th) * Math.sin(ph) * dr * elon;
        }
        let rx = px * ctA - pz * stA; let rz = px * stA + pz * ctA;
        let ry = py * ctB - rz * stB; rz = py * stB + rz * ctB;
        haloPos[j * 3] = gm.centroid.x + rx;
        haloPos[j * 3 + 1] = gm.centroid.y + ry;
        haloPos[j * 3 + 2] = gm.centroid.z + rz;
        const f = 1 - (dr / r) * 0.7;
        haloCol[j * 3] = tint.r * f; haloCol[j * 3 + 1] = tint.g * f; haloCol[j * 3 + 2] = tint.b * f;
      }
      const haloGeo = new THREE.BufferGeometry();
      haloGeo.setAttribute('position', new THREE.BufferAttribute(haloPos, 3));
      haloGeo.setAttribute('color', new THREE.BufferAttribute(haloCol, 3));
      const haloCloud = new THREE.Points(haloGeo, new THREE.PointsMaterial({
        size: 2.5, map: this.glowTex, blending: THREE.AdditiveBlending,
        depthWrite: false, vertexColors: true, transparent: true, opacity: 0.14,
      }));
      this.commFoldGroup.add(haloCloud); this.galaxyClouds.push(haloCloud);
      // Tag halo particles with galaxy index for potential future use
      haloCloud.userData = { galaxyIndex: gi, galaxyId: gm.id };
      // ── Soft ambient glow sprite ──
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTex, color: tint, blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true, opacity: 0.14,
      }));
      glow.position.copy(gm.centroid);
      glow.scale.setScalar(r * 2.0);
      glow.userData = { galaxyIndex: gi, galaxyId: gm.id };
      this.commFoldGroup.add(glow); this.galaxyGlows.push(glow);
      // ── Central core sprite ──
      const coreSprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTex, color: bright, blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true, opacity: 0.35,
      }));
      coreSprite.position.copy(gm.centroid);
      coreSprite.scale.setScalar(r * 0.35);
      coreSprite.userData = { galaxyIndex: gi, galaxyId: gm.id };
      this.commFoldGroup.add(coreSprite); this.galaxyGlows.push(coreSprite);
    }
    // ── Draw cross-galaxy edges (inter-cluster connections) ──
    this.buildCrossEdges();
    // ── Show labels for the largest galaxies ──
    this.buildGalaxyLabels();
  }

  private galaxyLabelDivs: HTMLDivElement[] = [];
  private buildGalaxyLabels(): void {
    // Clean old labels
    for (const d of this.galaxyLabelDivs) d.remove();
    this.galaxyLabelDivs = [];
    // Label the top ~15 galaxies by size
    const maxLabels = Math.min(15, this.galaxyMeta.length);
    for (let gi = 0; gi < maxLabels; gi++) {
      const gm = this.galaxyMeta[gi];
      const div = document.createElement('div');
      div.className = 'galaxy-label';
      // Extract a short name from the label (first part before /)
      const shortName = gm.label.split('/')[0].replace(/^test_/, '').replace(/_/g, ' ');
      div.textContent = shortName.length > 24 ? shortName.slice(0, 22) + '…' : shortName;
      div.style.cssText = 'position:absolute;z-index:3;pointer-events:none;font-size:10px;color:var(--starlight-dim,rgba(200,200,220,0.55));text-shadow:0 0 6px rgba(0,0,0,0.7);white-space:nowrap;transform:translate(-50%,-50%);';
      this.container.appendChild(div);
      div.dataset['galaxyIndex'] = String(gi); div.dataset['galaxyId'] = gm.id;
      this.galaxyLabelDivs.push(div);
    }
  }

  private buildCrossEdges(): void {
    const seen = new Set<string>();
    const verts: number[] = [], colors: number[] = [];
    const pos = this.nodePositions;
    for (const d of this.edgeDataList) {
      const sc = this.nodeCommMap.get(d.s), tc = this.nodeCommMap.get(d.t);
      if (!sc && !tc) continue;
      if (sc === tc) continue;
      const key = [sc || '', tc || ''].sort().join('::') + `::${d.edgeType}::${d.direction}`;
      if (seen.has(key)) continue; seen.add(key);
      const gs = sc ? this.galaxyMeta.find(g => g.id === sc) : null;
      const gt = tc ? this.galaxyMeta.find(g => g.id === tc) : null;
      // Skip edges where either end belongs to a community too small to have a galaxy cloud
      if (!gs || !gt) continue;
      verts.push(
        gs.centroid.x, gs.centroid.y, gs.centroid.z,
        gt.centroid.x, gt.centroid.y, gt.centroid.z);
      const c = edgeColorByType(d.edgeType, d.direction, d.crossFile);
      colors.push(c.r * 1.2, c.g * 1.2, c.b * 1.2, c.r * 1.2, c.g * 1.2, c.b * 1.2);
    }
    if (verts.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.commFoldGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.08,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })));
  }

  // ── Cross-edge energy flow (data streaming between galaxies) ──

  private initCrossEdgeFlow(): void {
    if (this.crossFlowParticles) {
      this.commFoldGroup.remove(this.crossFlowParticles);
      this.crossFlowParticles.geometry.dispose();
      (this.crossFlowParticles.material as THREE.Material).dispose();
    }
    // Build segment list from cross-edges
    this.crossFlowSegments = [];
    const seen = new Set<string>();
    const pos = this.nodePositions;
    for (const d of this.edgeDataList) {
      const sc = this.nodeCommMap.get(d.s), tc = this.nodeCommMap.get(d.t);
      if (!sc || !tc || sc === tc) continue;
      const gs = this.galaxyMeta.find(g => g.id === sc);
      const gt = this.galaxyMeta.find(g => g.id === tc);
      if (!gs || !gt) continue;
      const key = [sc, tc].sort().join('::');
      if (seen.has(key)) continue; seen.add(key);
      this.crossFlowSegments.push({
        x1: gs.centroid.x, y1: gs.centroid.y, z1: gs.centroid.z,
        x2: gt.centroid.x, y2: gt.centroid.y, z2: gt.centroid.z,
      });
    }
    if (this.crossFlowSegments.length === 0) return;
    // Create flow particles — 5 per segment for density
    const totalParticles = this.crossFlowSegments.length * 5;
    const pArr = new Float32Array(totalParticles * 3);
    const cArr = new Float32Array(totalParticles * 3);
    this.crossFlowData = [];
    for (let i = 0; i < totalParticles; i++) {
      const segIdx = i % this.crossFlowSegments.length;
      const seg = this.crossFlowSegments[segIdx];
      const t = Math.random();
      pArr[i * 3] = seg.x1 + (seg.x2 - seg.x1) * t;
      pArr[i * 3 + 1] = seg.y1 + (seg.y2 - seg.y1) * t;
      pArr[i * 3 + 2] = seg.z1 + (seg.z2 - seg.z1) * t;
      // Dark-universe: dim flow colors
      const colorChoice = Math.random();
      if (colorChoice < 0.4) {
        cArr[i * 3] = 0.12; cArr[i * 3 + 1] = 0.28; cArr[i * 3 + 2] = 0.32; // dim cyan
      } else if (colorChoice < 0.8) {
        cArr[i * 3] = 0.30; cArr[i * 3 + 1] = 0.24; cArr[i * 3 + 2] = 0.10; // dim gold
      } else {
        cArr[i * 3] = 0.28; cArr[i * 3 + 1] = 0.26; cArr[i * 3 + 2] = 0.24; // dim warm
      }
      this.crossFlowData.push({ segIdx, t, speed: 0.004 + Math.random() * 0.012 });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pArr, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(cArr, 3));
    const mat = new THREE.PointsMaterial({
      size: 2.0, map: this.glowTex, blending: THREE.AdditiveBlending,
      depthWrite: false, vertexColors: true, transparent: true, opacity: 0.03,
    });
    this.crossFlowParticles = new THREE.Points(geo, mat);
    this.commFoldGroup.add(this.crossFlowParticles);
  }

  private animateCrossEdgeFlow(): void {
    if (!this.crossFlowParticles || this.crossFlowSegments.length === 0) return;
    const pArr = this.crossFlowParticles.geometry.attributes['position'].array as Float32Array;
    for (let i = 0; i < this.crossFlowData.length; i++) {
      const fd = this.crossFlowData[i];
      fd.t += fd.speed;
      if (fd.t > 1.1) fd.t = -0.1;
      if (fd.t < 0) fd.t += 1.1;
      const seg = this.crossFlowSegments[fd.segIdx];
      if (!seg) continue;
      const t = Math.max(0, Math.min(1, fd.t));
      pArr[i * 3] = seg.x1 + (seg.x2 - seg.x1) * t;
      pArr[i * 3 + 1] = seg.y1 + (seg.y2 - seg.y1) * t;
      pArr[i * 3 + 2] = seg.z1 + (seg.z2 - seg.z1) * t;
    }
    this.crossFlowParticles.geometry.attributes['position'].needsUpdate = true;
  }

  private clearCrossEdgeFlow(): void {
    if (this.crossFlowParticles) {
      this.commFoldGroup.remove(this.crossFlowParticles);
      this.crossFlowParticles.geometry.dispose();
      (this.crossFlowParticles.material as THREE.Material).dispose();
    }
    this.crossFlowData = []; this.crossFlowSegments = [];
  }

  private _gaussRand(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.min(3, Math.max(-3, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v))) / 3;
  }

  private updateFocus(): void {
    if (!this.focusActive) return;
    this.focusProgress += 0.025;
    const t = easeInOutCubic(Math.min(1, this.focusProgress));
    if (this._resettingCamera) {
      // Camera reset: lerp camera position AND controls target to initial values
      this.camera.position.lerpVectors(this.focusStartCam, this.focusTarget, t);
      this.controls.target.lerpVectors(this.focusStartLook, this._initCamTarget, t);
    } else if (this.enteredGalaxyId !== null) {
      // Constellation fly-to: focusTarget is camera destination, lookTarget is centroid
      this.camera.position.lerpVectors(this.focusStartCam, this.focusTarget, t);
      this.controls.target.lerpVectors(this.focusStartLook, this._constellationLookTarget, t);
    } else {
      // Node fly-to: focusTarget is node position, camera offsets from it
      this.camera.position.lerpVectors(this.focusStartCam, this.focusTarget.clone().add(new THREE.Vector3(80, 60, 100)), t);
      this.controls.target.lerpVectors(this.focusStartLook, this.focusTarget, t);
    }
    if (this.focusNodeIdx >= 0 && this.focusNodeIdx < this.nodeGlows.length) {
      const base = this.getNodeBaseScale(this.focusNodeIdx);
      const flashScale = 1 + Math.sin(this.focusProgress * 20) * 0.5 * this.focusFlash;
      this.nodeGlows[this.focusNodeIdx].scale.setScalar(base * 5.5 * flashScale);
      (this.nodeGlows[this.focusNodeIdx].material as THREE.SpriteMaterial).opacity = 0.55 + 0.45 * this.focusFlash;
      this.nodeCores[this.focusNodeIdx].scale.setScalar(base * flashScale);
      this.focusFlash *= 0.97;
    }
    if (t >= 1) { this.focusActive = false; this._resettingCamera = false; if (this.enteredGalaxyId === null && !this._resettingCamera) setTimeout(() => this.restoreFocusNode(), 800); }
  }

  private restoreFocusNode(): void {
    if (this.focusNodeIdx < 0 || this.focusNodeIdx >= this.nodeGlows.length) return;
    const base = this.getNodeBaseScale(this.focusNodeIdx);
    this.nodeGlows[this.focusNodeIdx].scale.setScalar(base * 5.5);
    (this.nodeGlows[this.focusNodeIdx].material as THREE.SpriteMaterial).opacity = 0.55;
    this.nodeCores[this.focusNodeIdx].scale.setScalar(base);
    this.focusNodeIdx = -1;
  }

  // ── Render ───────────────────────────────────────────────

  async render(graph: GraphJSON): Promise<void> {
    try {
      await this._renderImpl(graph);
    } catch (e) {
      console.error('[StarGraph] render crashed:', e);
      // Attempt recovery: clear state, show minimal status
      try { this.clearGraph(); } catch { /* best effort */ }
      this.updateStatus(0, 0);
    }
  }

  private async _renderImpl(graph: GraphJSON): Promise<void> {
    // Cancel any in-flight layout from a previous render
    if (this._layoutAbort) { this._layoutAbort.abort(); }
    this._layoutAbort = new AbortController();
    this.clearGraph();
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : Object.values(graph.nodes);
    const edges = Array.isArray(graph.edges) ? graph.edges : Object.values(graph.edges);
    if (nodes.length === 0) { this.updateStatus(0, 0); return; }
    this.graphNodes = nodes;

    const nodeIdx = new Map<string, number>();
    const pairs: [number, number][] = [];
    const eData: EdgeData[] = [];
    const deg = new Array<number>(nodes.length).fill(0);
    for (let i = 0; i < nodes.length; i++) nodeIdx.set(nodes[i].id, i);
    // Extract file path from node location (e.g. "src/foo.py:10" → "src/foo.py")
    const nodeFile = new Map<number, string>();
    for (let i = 0; i < nodes.length; i++) {
      const loc = nodes[i].location || '';
      // Strip line number suffix (e.g. ":10")
      const filePath = loc.replace(/:\d+$/, '');
      nodeFile.set(i, filePath);
    }
    for (const e of edges) {
      const s = nodeIdx.get(e.source), t = nodeIdx.get(e.target);
      if (s !== undefined && t !== undefined && s !== t) {
        pairs.push([s, t]); deg[s]++; deg[t]++;
        const crossFile = nodeFile.get(s) !== nodeFile.get(t);
        eData.push({ s, t, couplingDepth: ((e as any).coupling_depth as number) || 0, edgeType: e.type || '', direction: (e as any).direction || '', crossFile });
      }
    }
    // Debug: count cross-file edges
    const crossFileCount = eData.filter(e => e.crossFile).length;
    console.log(`[DEBUG] Total edges: ${eData.length}, cross-file edges: ${crossFileCount}`);
    this.deg = deg; this.edgeDataList = eData; this.maxDeg = Math.max(...deg, 1);

    this.neighborMap = Array.from({ length: nodes.length }, () => []);
    this.edgeIndexOf = Array.from({ length: nodes.length }, () => []);
    for (let ei = 0; ei < eData.length; ei++) {
      const { s, t } = eData[ei];
      this.neighborMap[s].push(t); this.neighborMap[t].push(s);
      this.edgeIndexOf[s].push(ei); this.edgeIndexOf[t].push(ei);
    }

    // ── Parse communities & build node→community index ──────
    this.communities = ((graph as any).communities || []) as CommunityData[];
    this.nodeCommMap.clear();
    // Debug: log community data
    const level0Comms = this.communities.filter(c => !c.level || c.level === 0);
    const level1Comms = this.communities.filter(c => c.level === 1);
    console.log(`[DEBUG] Total communities: ${this.communities.length}, Level 0: ${level0Comms.length}, Level 1: ${level1Comms.length}`);
    if (level1Comms.length > 0) {
      console.log(`[DEBUG] Level 1 communities:`, level1Comms.map(c => ({ id: c.id, parent_id: c.parent_id, node_count: c.node_ids.length })));
    }

    // Use the most granular community level for layout (prefer Level 1 over Level 0)
    // Level 1 = finer sub-modules → better spatial separation for the star map
    const layoutComms = level1Comms.length > level0Comms.length ? level1Comms : level0Comms;
    for (const comm of layoutComms) {
      for (const nid of comm.node_ids) {
        const idx = nodeIdx.get(nid);
        if (idx !== undefined) this.nodeCommMap.set(idx, comm.id);
      }
    }
    // Galaxy fold mode always uses Level 0 for top-level navigation
    const level0Communities = level0Comms;
    // Pre-compute galaxy members (centroids filled after layout)
    // Only keep communities above minimum size — single-node communities are noise
    this.galaxyMeta = [];
    let skippedSingletons = 0;
    for (const comm of level0Communities) {
      const members: number[] = [];
      for (const nid of comm.node_ids) {
        const idx = nodeIdx.get(nid);
        if (idx !== undefined) members.push(idx);
      }
      if (members.length >= StarGraph.MIN_GALAXY_SIZE) {
        this.galaxyMeta.push({ id: comm.id, label: comm.label, centroid: new THREE.Vector3(), memberIndices: members, radius: 0 });
      } else if (members.length > 0 && members.length < StarGraph.MIN_GALAXY_SIZE) {
        skippedSingletons += members.length;
      }
    }
    // Sort galaxies by size descending so largest render first (OCD-friendly)
    this.galaxyMeta.sort((a, b) => b.memberIndices.length - a.memberIndices.length);

    this.l34Count = new Array(nodes.length).fill(0);
    for (const e of eData) { if (e.couplingDepth >= 3) { this.l34Count[e.s]++; this.l34Count[e.t]++; } }

    // ── Force-directed layout: GPU compute (WebGPU) → CPU fallback ──
    const shellRadius = Math.cbrt(nodes.length) * 14;
    const sp = 0.006 + (nodes.length > 2000 ? 0.008 : 0) + (nodes.length > 4000 ? 0.006 : 0);
    const maxIter = Math.min(60, Math.max(15, 60 - Math.floor(nodes.length / 800)));
    let layoutSource = 'CPU';

    // Build numeric community index array for layout (0..C-1, -1 = unassigned)
    const commStrIds = [...new Set(this.nodeCommMap.values())];
    const commStrToIdx = new Map<string, number>();
    commStrIds.forEach((sid, i) => commStrToIdx.set(sid, i));
    const nodeCommArr = new Array<number>(nodes.length).fill(-1);
    for (const [nodeIdx, commStr] of this.nodeCommMap) {
      nodeCommArr[nodeIdx] = commStrToIdx.get(commStr) ?? -1;
    }

    // Fallback: if Louvain gave us ≤1 community, group by top-level directory
    if (commStrIds.length <= 1) {
      console.warn(`[StarGraph] Louvain only found ${commStrIds.length} communities — falling back to directory-based grouping`);
      const dirGroups = new Map<string, number[]>();
      for (let i = 0; i < nodes.length; i++) {
        const loc = nodes[i].location || '';
        // Extract top-level dir: "src/foo/bar.py" → "src", "engine/src/main.rs" → "engine"
        const topDir = loc.replace(/^[\/\\]+/, '').split(/[\/\\]/)[0] || '(root)';
        if (!dirGroups.has(topDir)) dirGroups.set(topDir, []);
        dirGroups.get(topDir)!.push(i);
      }
      console.warn(`[StarGraph] Directory-based groups: ${dirGroups.size} groups`, [...dirGroups.keys()]);
      // Only use if we get more groups than Louvain
      if (dirGroups.size > 1) {
        let nextId = 0;
        for (const [dir, members] of dirGroups) {
          for (const mi of members) nodeCommArr[mi] = nextId;
          nextId++;
        }
        layoutSource = 'CPU(dirs)';
        console.warn(`[StarGraph] Using ${dirGroups.size} directory-based communities for layout`);
      } else {
        console.warn(`[StarGraph] Even directory grouping only found ${dirGroups.size} group — falling back to uniform`);
      }
    } else {
      console.warn(`[StarGraph] Using ${commStrIds.length} Louvain communities for layout`);
      layoutSource = 'CPU(community)';
    }

    let rawPos: Float32Array;
    // GPU path: always try GPU if available. Communities get a lightweight CPU pull post-pass.
    if (gpuLayout.ready) {
      const initPos = fibonacciSphere(nodes.length, shellRadius);
      const gpuResult = await gpuLayout.compute(nodes.length, pairs, initPos, {
        n: nodes.length,
        rep: 600, att: 0.018, damp: 0.72,
        REP_CAP: shellRadius * 8,
        ATT_CAP: shellRadius,
        VEL_CAP: shellRadius * 0.25,
        shellRadius, sp,
        originStr: 0.0004,
      }, maxIter);
      if (gpuResult) {
        rawPos = gpuResult;
        layoutSource = 'GPU';
        // Community pull: nudge nodes toward their community centroid (O(n), not O(n²))
        const effGroups = new Set(nodeCommArr.filter(c => c >= 0));
        if (effGroups.size > 1) {
          pullCommunities(rawPos, nodes.length, nodeCommArr, shellRadius);
          layoutSource = 'GPU+community';
        }
      } else {
        rawPos = await layout3D(nodes.length, pairs, this._layoutAbort?.signal, nodeCommArr);
        layoutSource = 'CPU(fallback)';
      }
    } else {
      rawPos = await layout3D(nodes.length, pairs, this._layoutAbort?.signal, nodeCommArr);
    }
    // ── Safety: replace NaN, safe centroid + camera ──
    let fixed = 0;
    for (let i = 0; i < rawPos.length; i++) {
      if (!isFinite(rawPos[i])) { rawPos[i] = 0; fixed++; }
    }
    if (fixed > 0) console.warn(`[StarGraph] Fixed ${fixed} NaN position components`);
    // ── Bounding-box centering (immune to cluster-size bias) ──
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const x = rawPos[i * 3], y = rawPos[i * 3 + 1], z = rawPos[i * 3 + 2];
      if (isFinite(x) && isFinite(y) && isFinite(z)) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }
    const bbcx = (minX + maxX) / 2, bbcy = (minY + maxY) / 2, bbcz = (minZ + maxZ) / 2;
    for (let i = 0; i < nodes.length; i++) {
      rawPos[i * 3] -= bbcx; rawPos[i * 3 + 1] -= bbcy; rawPos[i * 3 + 2] -= bbcz;
    }
    this.nodePositions = rawPos;

    // ── Radius = p95 distance from bounding-box center ──
    const dists: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const r2 = rawPos[i * 3] ** 2 + rawPos[i * 3 + 1] ** 2 + rawPos[i * 3 + 2] ** 2;
      if (isFinite(r2)) dists.push(Math.sqrt(r2));
    }
    dists.sort((a, b) => a - b);
    const radius = dists[Math.floor(dists.length * 0.95)] || 50;
    const absMax = dists[dists.length - 1] || 50;
    this._graphRadius = radius; // graph spatial scale — used for camera zoom range only

    // FOV-based camera distance — fills frame regardless of project size
    const fovRad = this.camera.fov * Math.PI / 180;
    const aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
    const camDist = (radius / Math.tan(fovRad / 2)) * 0.4 / Math.min(1, aspect);

    const shellR = Math.cbrt(nodes.length) * 14;
    const isoCount = deg.filter(d => d === 0).length;
    this._diagMsg = `${layoutSource} shellR≈${shellR | 0} radius=${radius | 0} absMax=${absMax | 0} cam=${camDist | 0} iso=${isoCount}/${nodes.length} NaNfix=${fixed}`;

    // ── Camera zoom range — wide open, no LOD clamping ──
    this.controls.minDistance = Math.max(0.5, radius * 0.001);
    this.controls.maxDistance = Math.max(this.controls.maxDistance, camDist * 6);
    // Clip planes: match the actual zoom range so nothing gets hardware-culled
    this.camera.near = Math.max(0.05, this.controls.minDistance * 0.5);
    this.camera.far = this.controls.maxDistance * 2;

    // Flatter camera angle — less top-down, more natural
    const dir = new THREE.Vector3(0.3, 0.25, 1).normalize();
    this.camera.position.set(dir.x * camDist, dir.y * camDist, dir.z * camDist);
    this.controls.target.set(0, 0, 0);
    this._initCamPos.copy(this.camera.position);
    this._initCamTarget.set(0, 0, 0);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix(); this.controls.update();

    // (standard mode: no bloom — bloom is full-mode only)

    // ── Build scene geometry (all invisible initially for progressive reveal) ──
    this.buildEdges(rawPos, eData);
    this.buildNodes(nodes, rawPos, deg);
    this.buildLabels(nodes, deg);
    this.positionGrid(rawPos);

    // Edge particle flow — full mode dense, standard mode subtle, minimal none
    if (true) {
      this.initEdgeParticles(rawPos, eData);
    }
    if (true) {
      this.initTwinkleData(nodes.length);
    }

    // ── Progressive reveal: nodes materialize in batches from center outward ──
    this._startProgressiveReveal(nodes.length);

    // ── Compute galaxy centroids + radii from layout ──────────
    for (const gm of this.galaxyMeta) {
      let sx = 0, sy = 0, sz = 0;
      for (const mi of gm.memberIndices) {
        sx += rawPos[mi * 3]; sy += rawPos[mi * 3 + 1]; sz += rawPos[mi * 3 + 2];
      }
      const cx = sx / gm.memberIndices.length, cy = sy / gm.memberIndices.length, cz = sz / gm.memberIndices.length;
      gm.centroid.set(cx, cy, cz);
      // p90 radius
      const dists: number[] = [];
      for (const mi of gm.memberIndices) {
        const dx = rawPos[mi * 3] - cx, dy = rawPos[mi * 3 + 1] - cy, dz = rawPos[mi * 3 + 2] - cz;
        dists.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
      dists.sort((a, b) => a - b);
      gm.radius = dists[Math.floor(dists.length * 0.9)] || 30;
    }
    this._buildCommunityRings();

    // ── Apply fold overlay if active ─────────────────────────
    if (this.foldMode) this.applyFoldOverlay();

    this.updateStatus(nodes.length, edges.length, graph.meta);
    if (this.legendEl) this.legendEl.style.display = '';
    // Append layout diagnostics so user can report them (release build has no DevTools)
    if (this._diagMsg) {
      const st = document.getElementById('status-text');
      if (st) st.textContent = (st.textContent || '') + ' | ' + this._diagMsg;
    }
    // Fix: container may have been display:none during constructor onResize().
    // Defer resize one frame to ensure CSS layout has settled.
    requestAnimationFrame(() => this.onResize());
  }

  // -- end of _renderImpl; render() wrapper is above --

  // ── Progressive reveal: materialize nodes in batches ────────
  private _revealRevealed = true; // false during animation
  private _revealCancelled = false;

  private _startProgressiveReveal(nodeCount: number): void {
    this._revealCancelled = false;
    const BATCH_SIZE = Math.max(50, Math.floor(nodeCount / 40)); // ~40 frames total, min 50 per batch
    const totalNodes = this.nodeCores.length;
    const totalEdgeGroups = this.edgeLineGroups.length;

    // Save target opacities, then set everything invisible
    const coreTargetOpacities: number[] = [];
    const glowTargetOpacities: number[] = [];
    const glow2TargetOpacities: number[] = [];
    const edgeTargetOpacities: number[] = [];

    for (const core of this.nodeCores) {
      const mat = core.material as THREE.MeshBasicMaterial;
      coreTargetOpacities.push(mat.opacity);
      mat.transparent = true;
      mat.opacity = 0;
    }
    for (const glow of this.nodeGlows) {
      const mat = glow.material as THREE.SpriteMaterial;
      glowTargetOpacities.push(mat.opacity);
      mat.opacity = 0;
    }
    for (const glow2 of this.nodeGlows2) {
      const mat = glow2.material as THREE.SpriteMaterial;
      glow2TargetOpacities.push(mat.opacity);
      mat.opacity = 0;
    }
    for (const lines of this.edgeLineGroups) {
      const mat = lines.material as THREE.LineBasicMaterial;
      edgeTargetOpacities.push(mat.opacity);
      mat.opacity = 0;
    }
    // Hide labels during reveal
    this.labelsContainer.style.opacity = '0';

    this._revealRevealed = false;
    let revealedNodes = 0;
    let revealedEdges = 0;
    const edgeRevealBatch = Math.max(1, Math.ceil(totalEdgeGroups / 10)); // edges reveal in ~10 frames

    const revealFrame = () => {
      if (this._revealCancelled) return; // clearGraph was called — stop
      // Reveal a batch of nodes
      const nodeEnd = Math.min(revealedNodes + BATCH_SIZE, totalNodes);
      for (let i = revealedNodes; i < nodeEnd; i++) {
        const core = this.nodeCores[i];
        if (core) {
          const mat = core.material as THREE.MeshBasicMaterial;
          mat.opacity = coreTargetOpacities[i];
        }
        const glow = this.nodeGlows[i];
        if (glow) {
          (glow.material as THREE.SpriteMaterial).opacity = glowTargetOpacities[i];
        }
        // nodeGlows2 is indexed by totalNodes (only exists in full mode)
        if (i < this.nodeGlows2.length) {
          (this.nodeGlows2[i].material as THREE.SpriteMaterial).opacity = glow2TargetOpacities[i];
        }
      }
      revealedNodes = nodeEnd;

      // Reveal edges faster (they're fewer visual groups)
      const edgeEnd = Math.min(revealedEdges + edgeRevealBatch, totalEdgeGroups);
      for (let i = revealedEdges; i < edgeEnd; i++) {
        const lines = this.edgeLineGroups[i];
        if (lines) {
          (lines.material as THREE.LineBasicMaterial).opacity = edgeTargetOpacities[i];
        }
      }
      revealedEdges = edgeEnd;

      // Check if done
      if (revealedNodes >= totalNodes && revealedEdges >= totalEdgeGroups) {
        this._revealRevealed = true;
        // Fade in labels
        this.labelsContainer.style.transition = 'opacity 0.4s ease-in';
        this.labelsContainer.style.opacity = '1';
        setTimeout(() => { this.labelsContainer.style.transition = ''; }, 500);
        return;
      }
      requestAnimationFrame(revealFrame);
    };
    requestAnimationFrame(revealFrame);
  }

  private clearGraph(): void {
    this._revealCancelled = true; // cancel any in-flight progressive reveal
    // Dispose materials/geometries before removing to prevent GPU memory leak (audit HIGH fix)
    const disposeGroup = (g: THREE.Group) => {
      while (g.children.length) {
        const child = g.children[0];
        if ((child as THREE.Mesh).geometry) (child as THREE.Mesh).geometry.dispose();
        const mat = (child as THREE.Mesh).material;
        if (mat) {
          if (Array.isArray(mat)) mat.forEach(m => (m as THREE.Material).dispose());
          else (mat as THREE.Material).dispose();
        }
        g.remove(child);
      }
    };
    disposeGroup(this.nodeGroup);
    disposeGroup(this.edgeGroup);
    disposeGroup(this.highlightEdgeGroup);
    disposeGroup(this.commFoldGroup);
    // Dispose stored references (prevent GPU leak across re-renders)
    // IMPORTANT: nodeCores share this.sphereGeo — do NOT dispose individual core geometries
    for (const core of this.nodeCores) { (core.material as THREE.Material)?.dispose(); }
    for (const g of this.nodeGlows) { g.material && (g.material as THREE.Material).dispose(); }
    for (const g of this.nodeGlows2) { g.material && (g.material as THREE.Material).dispose(); }
    for (const lines of this.edgeLineGroups) { lines.geometry?.dispose(); (lines.material as THREE.Material)?.dispose(); }
    this.labelsContainer.innerHTML = '';
    this.labelDivs = []; this.nodeLabelIdx = [];
    this.nodeCores = []; this.nodeGlows = []; this.nodeGlows2 = []; this.nodeGlowColors = []; this.nodeCoreColors = []; this.colorMode = 'type'; this.edgeLineGroups = [];
    this.galaxyClouds = []; this.galaxyGlows = [];
    this.galaxyMeta = []; this.communityRingGroup.clear(); this._communityGlowSprites = []; this._hoveredCommunityIdx = -1;
    this.foldMode = false; this.enteredGalaxyId = null; this.enteredSubCommunityId = null;
    this._drillStack = [];
    this._subCommByNodeIdx.clear();
    this._savedGalaxyMeta = null;
    this.hideGalaxyTitle();
    this._pathSource = -1; this._pathTarget = -1; this._pathNodes.clear(); this._pathEdges.clear();
    this._shiftSourceIdx = -1; this._selecting = false;
    this._hidePrompt();
    for (const d of this.galaxyLabelDivs) d.remove();
    this.galaxyLabelDivs = [];
    this.neighborMap = []; this.edgeIndexOf = [];
    this.hoveredIdx = -1; this.targetHoverScale = 0;
    this.focusActive = false; this.focusNodeIdx = -1; this.selectedIdx = -1;
    this.blastMode = false; this.blastSource = -1; this.blastDistances = []; this.l34Count = [];
    this._diagMsg = '';
    if (this.legendEl) this.legendEl.style.display = 'none';
    this.focusSubgraphActive = false; this.focusSubgraphIdx = -1; this.focusSubgraphVisibleIndices.clear();
    if (this.focusSubgraphBanner) this.focusSubgraphBanner.style.display = 'none';
    this.tooltipEl?.classList.remove('visible');
    this.detailCard?.classList.remove('visible');
    // Step 2: Clear lens & trail state
    this._lensActive = false;
    this._lensOriginalOpacities?.clear();
    this._clearTrailLine();
  }

  // ── Edges ────────────────────────────────────────────────

  private buildEdges(pos: Float32Array, data: EdgeData[]): void {
    if (data.length === 0) return;
    const key = (d: EdgeData) => `${d.edgeType}:${d.direction}:${d.couplingDepth}:${d.crossFile ? 1 : 0}`;
    const groups = new Map<string, { verts: number[]; colors: number[]; depth: number; crossFile: boolean }>();
    for (const d of data) {
      const k = key(d);
      if (!groups.has(k)) { const c = edgeColorByType(d.edgeType, d.direction, d.crossFile); groups.set(k, { verts: [], colors: [], depth: d.couplingDepth, crossFile: d.crossFile }); }
      const g = groups.get(k)!;
      g.verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
      const c = edgeColorByType(d.edgeType, d.direction, d.crossFile);
      g.colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    for (const [, g] of groups) {
      const B = 2000;
      for (let b = 0; b < g.verts.length; b += B * 6) {
        const v = g.verts.slice(b, b + B * 6), cl = g.colors.slice(b, b + B * 6);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(cl, 3));
        const opacity = edgeOpacityByDepth(g.depth);
        const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
        const lines = new THREE.LineSegments(geo, mat);
        lines.userData['edgeDepth'] = g.depth;
        this.edgeGroup.add(lines); this.edgeLineGroups.push(lines);
      }
    }
  }

  // ── Nodes ────────────────────────────────────────────────

  private buildNodes(nodes: GraphNode[], pos: Float32Array, deg: number[]): void {
    const isFull = true;
    for (let i = 0; i < nodes.length; i++) {
      const kind = ((nodes[i].type || nodes[i].kind || 'symbol') as string).toLowerCase();
      const glowColor = GLOW_COLORS[kind] || 0x4488cc;
      const coreColor = isFull ? glowColor : (NODE_COLORS[kind] || 0x7eb8ff); // dark-universe: type-colored core, white-hot only on hover
      const baseScale = 0.8 + (deg[i] / this.maxDeg) * 2.8;
      const glowOpacity = false ? 0 : 0.75;
      const glowScaleMul = isFull ? 22 : 16;

      // Full mode: large soft outer glow first (behind everything)
      if (isFull) {
        const outerGlow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this.glowTex, color: glowColor,
          blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.48,
        }));
        outerGlow.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        outerGlow.scale.setScalar(baseScale * 16);
        this.nodeGroup.add(outerGlow); this.nodeGlows2.push(outerGlow);
      }

      // Inner spike glow (or standard glow)
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTex, color: glowColor,
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: glowOpacity,
      }));
      glow.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      glow.scale.setScalar(baseScale * glowScaleMul);
      this.nodeGroup.add(glow); this.nodeGlows.push(glow); this.nodeGlowColors.push(glowColor);
      this.nodeCoreColors.push(coreColor);

      // Core — small bright white center in full mode, colored in standard
      const core = new THREE.Mesh(this.sphereGeo, new THREE.MeshBasicMaterial({ color: coreColor }));
      core.position.copy(glow.position);
      core.scale.setScalar(isFull ? baseScale * 0.35 : baseScale);
      core.userData = { nodeIndex: i };
      this.nodeGroup.add(core); this.nodeCores.push(core);
    }
  }

  // ── Legend (color key) ────────────────────────────────────

  private buildLegend(): void {
    this.legendEl = document.createElement('div');
    this.legendEl.id = 'graph-legend';
    this.legendEl.style.display = 'none';
    this.legendEl.innerHTML =
      `<div class="legend-section">
        <div class="legend-title">${t('legend.node')}</div>
        <div class="legend-row"><span class="legend-swatch" style="background:${hexToCSS(0x7eb8ff)};color:${hexToCSS(0x7eb8ff)}"></span> ${t('legend.symbol')}</div>
        <div class="legend-row"><span class="legend-swatch" style="background:${hexToCSS(0xf0c060)};color:${hexToCSS(0xf0c060)}"></span> ${t('legend.medium')}</div>
        <div class="legend-row"><span class="legend-swatch" style="background:${hexToCSS(0xc098ff)};color:${hexToCSS(0xc098ff)}"></span> ${t('legend.temporal')}</div>
      </div>
      <div class="legend-section">
        <div class="legend-title">${t('legend.edge')}</div>
        <div class="legend-row"><span class="legend-edge-swatch" style="background:${hexToCSS(0x6699cc)}"></span> ${t('legend.structural')}</div>
        <div class="legend-row"><span class="legend-edge-swatch" style="background:${hexToCSS(0x66dd66)}"></span> ${t('legend.dataRead')}</div>
        <div class="legend-row"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff7777)}"></span> ${t('legend.dataWrite')}</div>
        <div class="legend-row"><span class="legend-edge-swatch" style="background:${hexToCSS(0xffaa55)}"></span> ${t('legend.temporalEdge')}</div>
      </div>`;
    this.container.appendChild(this.legendEl);
  }

  // ── Focus subgraph (detail-card button triggered) ────────────

  private buildFocusBanner(): void {
    this.focusSubgraphBanner = document.createElement('div');
    this.focusSubgraphBanner.id = 'graph-focus-banner';
    this.focusSubgraphBanner.textContent = '';
    this.focusSubgraphBanner.addEventListener('click', () => this.exitFocusSubgraph());
    this.container.appendChild(this.focusSubgraphBanner);
  }

  private enterFocusSubgraph(idx: number): void {
    if (idx < 0 || idx >= this.graphNodes.length) return;
    if (this.focusSubgraphActive) this.exitFocusSubgraph();

    this.focusSubgraphIdx = idx;
    this.focusSubgraphVisibleIndices.clear();
    this.focusSubgraphVisibleIndices.add(idx);
    for (const ni of this.neighborMap[idx] || []) {
      this.focusSubgraphVisibleIndices.add(ni);
    }

    // Save current state
    this.focusSubgraphSavedGlowOpacities = [];
    this.focusSubgraphSavedCoreVisible = [];
    for (let i = 0; i < this.graphNodes.length; i++) {
      this.focusSubgraphSavedGlowOpacities.push(
        this.nodeGlows[i] ? (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity : 0.55);
      this.focusSubgraphSavedCoreVisible.push(
        this.nodeCores[i] ? this.nodeCores[i].visible : true);

      if (!this.focusSubgraphVisibleIndices.has(i)) {
        if (this.nodeGlows[i]) {
          (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.02;
        }
        if (this.nodeCores[i]) this.nodeCores[i].visible = false;
      }
    }

    // Dim edges
    this.focusSubgraphSavedEdgeOpacities = this.edgeLineGroups.map(
      lines => (lines.material as THREE.LineBasicMaterial).opacity);
    for (const lines of this.edgeLineGroups) {
      (lines.material as THREE.LineBasicMaterial).opacity = 0.005;
    }

    // Build focus edges (only between visible nodes)
    this._buildFocusSubgraphEdges();

    // Highlight the focus node
    if (this.nodeGlows[idx]) {
      (this.nodeGlows[idx].material as THREE.SpriteMaterial).opacity = 0.92;
      (this.nodeGlows[idx].material as THREE.SpriteMaterial).color.set(0xffffff);
    }

    this.focusSubgraphActive = true;
    const node = this.graphNodes[idx];
    this.focusSubgraphBanner.innerHTML =
      `${iconHtml('focus', 14)} <b>${t('focus.title')}: ${node.name}</b> &middot; ${this.focusSubgraphVisibleIndices.size} ${t('focus.nodes')} &middot; ${t('focus.exit')}`;
    this.focusSubgraphBanner.style.display = 'flex';
    this.flyToNode(idx);
  }

  exitFocusSubgraph(): void {
    if (!this.focusSubgraphActive) return;

    for (let i = 0; i < this.graphNodes.length; i++) {
      if (i < this.focusSubgraphSavedGlowOpacities.length && this.nodeGlows[i]) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity =
          this.focusSubgraphSavedGlowOpacities[i];
      }
      if (i < this.focusSubgraphSavedCoreVisible.length && this.nodeCores[i]) {
        this.nodeCores[i].visible = this.focusSubgraphSavedCoreVisible[i];
      }
    }
    for (let ei = 0; ei < this.edgeLineGroups.length; ei++) {
      if (ei < this.focusSubgraphSavedEdgeOpacities.length) {
        (this.edgeLineGroups[ei].material as THREE.LineBasicMaterial).opacity =
          this.focusSubgraphSavedEdgeOpacities[ei];
      }
    }
    // Restore focus node glow color
    if (this.focusSubgraphIdx >= 0 && this.focusSubgraphIdx < this.nodeGlows.length) {
      (this.nodeGlows[this.focusSubgraphIdx].material as THREE.SpriteMaterial).color.set(
        this.nodeGlowColors[this.focusSubgraphIdx]);
      (this.nodeGlows[this.focusSubgraphIdx].material as THREE.SpriteMaterial).opacity = 0.55;
    }
    // Clear focus edges
    while (this.highlightEdgeGroup.children.length)
      this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);

    this.focusSubgraphActive = false;
    this.focusSubgraphIdx = -1;
    this.focusSubgraphVisibleIndices.clear();
    this.focusSubgraphBanner.style.display = 'none';
  }

  private _buildFocusSubgraphEdges(): void {
    while (this.highlightEdgeGroup.children.length)
      this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);
    const visible = this.focusSubgraphVisibleIndices;
    const verts: number[] = [];
    const colors: number[] = [];
    const pos = this.nodePositions;

    for (const d of this.edgeDataList) {
      if (visible.has(d.s) && visible.has(d.t)) {
        verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2],
                    pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
        const c = edgeColorByType(d.edgeType, d.direction, d.crossFile);
        colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    if (verts.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.highlightEdgeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.55,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })));
  }

  private buildLabels(nodes: GraphNode[], deg: number[]): void {
    // No labels — visual-only rendering. Hover/selection reveals name via tooltip + detail card.
    this.nodeLabelIdx = [];
  }

  // ── Minimap ───────────────────────────────────────────────

  private _setupMinimapDrag(): void {
    const c = this.minimapCanvas;
    const onDown = (e: PointerEvent) => {
      this._mmDragging = true;
      this._mmOffX = e.clientX - c.offsetLeft;
      this._mmOffY = e.clientY - c.offsetTop;
      c.style.cursor = 'grabbing';
      c.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!this._mmDragging) return;
      c.style.left = `${e.clientX - this._mmOffX}px`;
      c.style.top = `${e.clientY - this._mmOffY}px`;
      c.style.right = 'auto'; c.style.bottom = 'auto';
    };
    const onUp = () => {
      this._mmDragging = false;
      c.style.cursor = 'grab';
    };
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointerleave', onUp);
  }

  private updateMinimap(): void {
    if (!this.minimapCtx || !this.nodePositions || this.nodePositions.length === 0) return;
    const ctx = this.minimapCtx;
    const W = 260, H = 180;
    ctx.clearRect(0, 0, W, H);

    // Compute 2D bounds (top-down: XZ plane → minimap XY)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.graphNodes.length; i++) {
      const x = this.nodePositions[i * 3], z = this.nodePositions[i * 3 + 2];
      if (isFinite(x) && isFinite(z)) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }
    const bw = maxX - minX || 1, bh = maxZ - minZ || 1;
    const scale = Math.min((W - 20) / bw, (H - 20) / bh);
    const ox = (W - bw * scale) / 2, oy = (H - bh * scale) / 2;
    const proj = (px: number, pz: number) => ({
      u: ox + (px - minX) * scale,
      v: oy + (pz - minZ) * scale,
    });

    // Draw nodes as tiny dots
    ctx.fillStyle = 'rgba(150,200,255,0.5)';
    for (let i = 0; i < this.graphNodes.length; i++) {
      const { u, v } = proj(this.nodePositions[i * 3], this.nodePositions[i * 3 + 2]);
      if (u > 2 && u < W - 2 && v > 2 && v < H - 2) {
        ctx.fillRect(u - 0.6, v - 0.6, 1.2, 1.2);
      }
    }

    // Draw camera frustum indicator
    const cam = this.camera.position;
    const target = this.controls.target;
    const { u: cx, v: cz } = proj(cam.x, cam.z);
    const { u: tx, v: tz } = proj(target.x, target.z);
    // Camera view direction on XZ plane
    const dx = tx - cx, dz = tz - cz;
    const dist = Math.sqrt(dx * dx + dz * dz) || 1;
    const ndx = dx / dist, ndz = dz / dist;
    // Frustum width at target
    const halfFov = (this.camera.fov * Math.PI / 180) / 2;
    const fw = Math.tan(halfFov) * dist * 0.35;
    const px = -ndz * fw, pz = ndx * fw;

    ctx.strokeStyle = 'rgba(255,200,100,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - px, cz - pz);
    ctx.lineTo(cx + px, cz + pz);
    ctx.lineTo(tx + px, tz + pz);
    ctx.lineTo(tx - px, tz - pz);
    ctx.closePath();
    ctx.stroke();
    // Camera dot
    ctx.fillStyle = 'rgba(255,200,100,0.9)';
    ctx.beginPath(); ctx.arc(cx, cz, 2.5, 0, Math.PI * 2); ctx.fill();
  }

  // ── Status ───────────────────────────────────────────────

  private updateStatus(nodeCount: number, edgeCount: number, meta?: Record<string, unknown>): void {
    const ns = document.getElementById('status-nodes'), es = document.getElementById('status-edges'), st = document.getElementById('status-text');
    if (ns) ns.textContent = `${nodeCount} 节点`;
    if (es) es.textContent = `${edgeCount} 边`;
    let sCount = 0, dCount = 0, tCount = 0;
    for (const e of this.edgeDataList) {
      if (e.edgeType === 'structural' || e.edgeType === 'STRUCTURAL') sCount++;
      else if (e.edgeType === 'data' || e.edgeType === 'DATA') dCount++;
      else if (e.edgeType === 'temporal' || e.edgeType === 'TEMPORAL') tCount++;
    }
    const coup = (meta?.coupling || {}) as Record<string, number>;
    const l3 = coup.total_l3 || 0, l4 = coup.total_l4 || 0;
    if (st) {
      let text = `${nodeCount} 节点 · ${edgeCount} 边 · S${sCount} D${dCount} T${tCount}`;
      if (l4 > 0) text += ` · ${iconHtml('block', 10)} L4×${l4}`;
      else if (l3 > 0) text += ` · ${iconHtml('alert', 10)} L3×${l3}`;
      if (this.foldMode && this.galaxyMeta.length > 0) text += ` · ${iconHtml('galaxy', 10)} ${this.galaxyMeta.length} 星座`;
      st.innerHTML = text;
    }
  }

  // ── Full-FX: edge particle flow ──────────────────────────

  private initTwinkleData(n: number): void {
    this.twinklePhases = new Array(n).fill(0).map(() => Math.random() * Math.PI * 2);
    this.twinkleSpeeds = new Array(n).fill(0).map(() => 0.5 + Math.random() * 2.5);
  }

  private initEdgeParticles(pos: Float32Array, data: EdgeData[]): void {
    // Remove old
    if (this.edgeParticles) { this.galaxyGroup.remove(this.edgeParticles); (this.edgeParticles.material as THREE.Material).dispose(); this.edgeParticles.geometry.dispose(); }
    this.edgeParticleData = [];
    if (data.length === 0) return;

    const isFull = true;
    const isMinimal = false;
    if (isMinimal) return; // no particles in minimal mode

    // Many small subtle particles — ambient data flow, not flashy dots
    const count = isFull ? Math.min(2000, data.length * 4) : Math.min(1000, data.length * 2);
    const pPos = new Float32Array(count * 3);
    const pCol = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const ei = Math.floor(Math.random() * data.length);
      const d = data[ei];
      const t = Math.random();
      pPos[i * 3]     = pos[d.s * 3]     + (pos[d.t * 3]     - pos[d.s * 3])     * t;
      pPos[i * 3 + 1] = pos[d.s * 3 + 1] + (pos[d.t * 3 + 1] - pos[d.s * 3 + 1]) * t;
      pPos[i * 3 + 2] = pos[d.s * 3 + 2] + (pos[d.t * 3 + 2] - pos[d.s * 3 + 2]) * t;

      // Subtle color: match edge type, occasional gentle warm accent
      const c = edgeColorByType(d.edgeType, d.direction, d.crossFile);
      const bright = 0.6 + Math.random() * 0.6;
      pCol[i * 3] = Math.min(1, c.r * bright);
      pCol[i * 3 + 1] = Math.min(1, c.g * bright);
      pCol[i * 3 + 2] = Math.min(1, c.b * bright);

      this.edgeParticleData.push({
        edgeIdx: ei, t,
        speed: (isFull ? 0.002 : 0.001) + Math.random() * (isFull ? 0.008 : 0.003),
        dir: Math.random() > 0.5 ? 1 : -1,
      });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
    const mat = new THREE.PointsMaterial({
      size: isFull ? 1.2 : 0.7,
      map: this.glowTex, blending: THREE.AdditiveBlending,
      depthWrite: false, vertexColors: true, transparent: true,
      opacity: isFull ? 0.6 : 0.45,
    });
    this.edgeParticles = new THREE.Points(geo, mat);
    this.galaxyGroup.add(this.edgeParticles);
  }

  private animateEdgeParticles(): void {
    if (!this.edgeParticles || this.edgeParticleData.length === 0) return;
    const posArr = this.edgeParticles.geometry.attributes['position'].array as Float32Array;
    const nPos = this.nodePositions;
    for (let i = 0; i < this.edgeParticleData.length; i++) {
      const pd = this.edgeParticleData[i];
      const d = this.edgeDataList[pd.edgeIdx];
      if (!d) continue;
      pd.t += pd.speed * pd.dir;
      if (pd.t > 1) { pd.t = 1; pd.dir = -1; }
      if (pd.t < 0) { pd.t = 0; pd.dir = 1; }
      posArr[i * 3]     = nPos[d.s * 3]     + (nPos[d.t * 3]     - nPos[d.s * 3])     * pd.t;
      posArr[i * 3 + 1] = nPos[d.s * 3 + 1] + (nPos[d.t * 3 + 1] - nPos[d.s * 3 + 1]) * pd.t;
      posArr[i * 3 + 2] = nPos[d.s * 3 + 2] + (nPos[d.t * 3 + 2] - nPos[d.s * 3 + 2]) * pd.t;
    }
    this.edgeParticles.geometry.attributes['position'].needsUpdate = true;
  }

  // ── Animate ──────────────────────────────────────────────

  private animate(): void {
    this.animId = requestAnimationFrame(() => this.animate());
    const isMinimal = false;
    const isFull = true;
    // Auto-rotation disabled

    // Infinite grid follows camera Y — always at viewer level, capped below nodes
    if (this.holoGrid) {
      const sMat = this.holoGrid.material as THREE.ShaderMaterial;
      sMat.uniforms['uCameraWorldPos'].value.copy(this.camera.position);
      this.holoGrid.position.y = Math.min(this.camera.position.y, this.holoGridY);
    }

    if (!isMinimal) this.animateEdgeParticles();
    if (isMinimal) {
      this.controls.update();
      this.composer.render();
      return;
    }

    // ── Idle detection: throttle expensive work when scene is static ──
    const camMoved = this.camera.position.distanceToSquared(this._lastCamPos) > 0.0001
                  || this.controls.target.distanceToSquared(this._lastCamTarget) > 0.0001;
    const mouseOnCanvas = this.mouse.x > -999;
    const isActive = camMoved || mouseOnCanvas || this.hoveredIdx >= 0
                  || this.focusProgress > 0 || this.blastMode
                  || (this._pathSource >= 0) || this._selecting;
    if (isActive) { this._idleCounter = 0; } else { this._idleCounter++; }
    this._lastCamPos.copy(this.camera.position);
    this._lastCamTarget.copy(this.controls.target);
    const IDLE = this._idleCounter > 60; // ~1s of no activity

    if (!IDLE || this._idleCounter % 4 === 0) {
      try { this.updateHover(); } catch { /* hover must never crash the animation loop */ }
      try { this.updateFocus(); } catch { /* ditto */ }
    }

    // Hover effects
    this.hoverScale += (this.targetHoverScale - this.hoverScale) * 0.18;
    const neighborSet = new Set(this.hoveredIdx >= 0 ? this.neighborMap[this.hoveredIdx] || [] : []);
    if (this.hoveredIdx >= 0 && this.hoveredIdx < this.nodeCores.length) {
      const base = this.getNodeBaseScale(this.hoveredIdx);
      const s = 1 + this.hoverScale * 1.2;
      this.nodeCores[this.hoveredIdx].scale.setScalar(base * s);
      if (this.nodeGlows[this.hoveredIdx]) {
        this.nodeGlows[this.hoveredIdx].scale.setScalar(base * (isFull ? 7 : 7.0) * s);
        (this.nodeGlows[this.hoveredIdx].material as THREE.SpriteMaterial).opacity = 0.65 + this.hoverScale * 0.25;
      }
      for (const ni of neighborSet) {
        if (ni !== this.hoveredIdx && ni < this.nodeGlows.length) {
          (this.nodeGlows[ni].material as THREE.SpriteMaterial).opacity = 0.55 + this.hoverScale * 0.10;
        }
      }
    }

    // ── Galaxy cloud breathe + core pulse + hover highlight + cross-edge flow ──
    if (this.foldMode && !this.enteredGalaxyId) {
      this.animateCrossEdgeFlow();
      for (let k = 0; k < this.galaxyGlows.length; k++) {
        const glow = this.galaxyGlows[k];
        if (!glow) continue;
        const gi = Math.floor(k / 2);
        const gm = this.galaxyMeta[gi];
        if (!gm) continue;
        const hovered = gi === this.hoveredGalaxyIdx;
        const d = 1; // no LOD — galaxy glow constant regardless of camera distance
        if (k % 2 === 0) {
          // Ambient glow — slow breathe, boost on hover
          const w = 1 + Math.sin(this.pulseTime * 0.5 + k * 1.7) * 0.12;
          (glow.material as THREE.SpriteMaterial).opacity = (hovered ? 0.26 : 0.12) * d * w;
        } else {
          // Core sprite — heartbeat pulse, brighten + enlarge on hover
          const hoverMul = hovered ? 1.6 : 1.0;
          const beat = 0.8 + 0.2 * Math.abs(Math.sin(this.pulseTime * (1.2 + gi * 0.37)));
          (glow.material as THREE.SpriteMaterial).opacity = 0.22 * d * beat * hoverMul;
          const gm_r = 45 + Math.sqrt(gm.memberIndices.length) * 16;
          const s = gm_r * 0.35 * (0.95 + 0.05 * Math.sin(this.pulseTime * (2 + gi * 0.41))) * (hovered ? 1.3 : 1.0);
          glow.scale.setScalar(s);
        }
      }
      // Hover highlight for halo particles
      for (let ci = 0; ci < this.galaxyClouds.length; ci++) {
        const cloud = this.galaxyClouds[ci];
        if (!cloud) continue;
        const gIdx = cloud.userData['galaxyIndex'] as number;
        (cloud.material as THREE.PointsMaterial).opacity =
          (gIdx === this.hoveredGalaxyIdx) ? 0.6 : 0.4;
      }
    }

    this.pulseTime += 0.03 * (isFull ? 1.5 : 1);
    // Per-node glow loop — skip when idle to save CPU (cosmetic only, imperceptible at 10fps vs 60fps)
    if (!IDLE || this._idleCounter % 6 === 0) {
    const inPathMode = this._pathSource >= 0;
    const galTime = performance.now() * 0.001; // galaxy time for color cycling
    for (let i = 0; i < this.nodeGlows.length; i++) {
      if (this.focusSubgraphActive && !this.focusSubgraphVisibleIndices.has(i)) continue;
      if (i === this.focusSubgraphIdx || i === this.hoveredIdx || neighborSet.has(i) || i === this.focusNodeIdx) continue;
      // Path mode: keep path nodes highlighted, non-path nodes dimmed
      if (inPathMode) {
        if (this._pathNodes.has(i) || i === this._pathSource) continue; // path node — keep highlight
        if (this._pathNodes.size > 0) {
          (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.05;
          this.nodeCores[i].visible = false;
          continue;
        }
      }
      if (this.blastMode) {
        const d = this.blastDistances[i];
        if (d >= 0) {
          const c = new THREE.Color();
          if (d === 0) c.set(0xffffff); else if (d === 1) c.set(0xff4422); else if (d === 2) c.set(0xff8800); else if (d === 3) c.set(0xffcc00); else c.setHSL(0.55 - (d / this.blastMaxDist) * 0.3, 0.6, 0.4 + (1 - d / this.blastMaxDist) * 0.3);
          (this.nodeGlows[i].material as THREE.SpriteMaterial).color.set(c);
          (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.7;
          (this.nodeCores[i].material as THREE.MeshBasicMaterial).color.set(c);
          const base = this.getNodeBaseScale(i);
          this.nodeGlows[i].scale.setScalar(base * (isFull ? 7 : 7.0) * (d === 0 ? 2 : 1.2));
          this.nodeCores[i].scale.setScalar(base * (d === 0 ? 2 : 1));
        } else {
          (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = Math.min(1, 0.75 * this._nodeMag(i));
        }
      } else {
        const risk = this.l34Count[i];
        if (isFull) {
          // Full mode: individual twinkle + color cycling
          const twinkle = 1 + Math.sin(galTime * this.twinkleSpeeds[i] + this.twinklePhases[i]) * 0.35;
          const wave = 1 + Math.sin(this.pulseTime * (1 + risk * 0.7)) * (risk > 0 ? 0.4 : 0.15);
          const combined = twinkle * wave;
          const mag = this._nodeMag(i);
          (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = Math.min(1, 1.5 * combined * mag);
          // Animate outer glow layer too
          if (this.nodeGlows2[i]) {
            (this.nodeGlows2[i].material as THREE.SpriteMaterial).opacity = 0.48 * combined * mag;
            const base = this.getNodeBaseScale(i);
            this.nodeGlows2[i].scale.setScalar(base * 16 * combined);
          }
          // Hue shift
          const hueShift = (Math.sin(galTime * 0.3 + this.twinklePhases[i]) * 0.05);
          const origColor = new THREE.Color(this.nodeGlowColors[i]);
          const hsl: { h: number; s: number; l: number } = { h: 0, s: 0, l: 0 };
          origColor.getHSL(hsl);
          const newColor = new THREE.Color();
          newColor.setHSL((hsl.h + hueShift + 1) % 1, Math.min(1, hsl.s * 1.2), Math.min(1, hsl.l * 1.3));
          (this.nodeGlows[i].material as THREE.SpriteMaterial).color.set(newColor);
          const base = this.getNodeBaseScale(i);
          this.nodeGlows[i].scale.setScalar(base * 9 * combined);
        } else {
          const freq = 1 + risk * 0.7;
          const amp = risk > 0 ? Math.min(0.4, risk * 0.13) : 0.06;
          const wave = 1 + Math.sin(this.pulseTime * freq) * amp;
          (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = Math.min(1, 0.9 * wave * this._nodeMag(i));
          const base = this.getNodeBaseScale(i);
          this.nodeGlows[i].scale.setScalar(base * 5.5);
        }
      }
    }
    } // end IDLE-guarded per-node glow loop

    if (!IDLE || this._idleCounter % 3 === 0) {
      this.updateTooltip(); this.updateLabels(); this._updateCommunityRingHover();
    }
    if (!IDLE || this._idleCounter % 6 === 0) this.updateMinimap();
    this.controls.update();
    this.composer.render();
  }

  // ── Resize ───────────────────────────────────────────────

  private onResize = (): void => {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (h === 0 || w === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  };

  // ── Destroy ──────────────────────────────────────────────

  destroy(): void {
    cancelAnimationFrame(this.animId);
    this.minimapCanvas?.remove();
    this.communityRingGroup.clear();
    // Cancel progressive reveal if in-flight (audit: prevent rAF leak after destroy)
    this._revealCancelled = true;
    // Clear prompt auto-hide timer (audit: prevent timeout after destroy)
    if (this._promptTimer) { clearTimeout(this._promptTimer); this._promptTimer = null; }
    window.removeEventListener('resize', this.onResize);
    // Remove window keydown listener (audit HIGH fix — prevent stale reference)
    if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
    // Unsubscribe EventBus handlers (audit: prevent stale bus listeners)
    if (this._langHandler) { bus.off('lang:changed', this._langHandler); this._langHandler = null; }
    if (this._showPromptBound) { bus.off('graph:show-prompt', this._showPromptBound); this._showPromptBound = null; }
    // Dispose all GPU resources
    for (const cloud of this.galaxyClouds) { if (cloud) { cloud.geometry.dispose(); (cloud.material as THREE.Material).dispose(); } }
    for (const glow of this.galaxyGlows) (glow.material as THREE.Material).dispose();
    if (this.nebulaDust) { this.nebulaDust.geometry.dispose(); (this.nebulaDust.material as THREE.Material).dispose(); }
    // Dispose InstancedMesh cores + glows
    for (const core of this.nodeCores) { core.geometry?.dispose(); (core.material as THREE.Material)?.dispose(); }
    for (const g of this.nodeGlows) { g.material && (g.material as THREE.Material).dispose(); g.geometry?.dispose(); }
    for (const g of this.nodeGlows2) { g.material && (g.material as THREE.Material).dispose(); g.geometry?.dispose(); }
    for (const lines of this.edgeLineGroups) { lines.geometry?.dispose(); (lines.material as THREE.Material)?.dispose(); }
    this.bloomPass?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.glowTex.dispose(); this.sphereGeo.dispose();
    for (const d of this.galaxyLabelDivs) d.remove(); this.galaxyLabelDivs = [];
    this.galaxyTitleEl?.remove(); this.tooltipEl?.remove(); this.labelsContainer?.remove(); this.detailCard?.remove();
    this._selectRectEl?.remove();
    this._promptBarEl?.remove();
  }
}

function easeInOutCubic(t: number): number { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
