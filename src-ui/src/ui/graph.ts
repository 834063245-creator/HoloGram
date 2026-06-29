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
import { shell } from './app-shell';
import { t, getLang, setLang } from '../i18n';
import { gpuLayout } from './gpu-layout';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

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

// ponytail: 8 代码符号色相均分(210/180/150/120/90/60/30/0°)，存储金系明度递减，时序紫系明度递减
const NODE_COLORS: Record<string, number> = {
  symbol: 0x6ab0ff, SYMBOL: 0x6ab0ff,     // 210° 蓝 — 通用符号
  function: 0x4ad8c8, FUNCTION: 0x4ad8c8, // 175° 青 — 函数
  method: 0x4ad8c8, METHOD: 0x4ad8c8,     // 175° 青 — 方法
  class: 0x7fd84a, CLASS: 0x7fd84a,       // 105° 绿 — 类
  module: 0xd8d84a, MODULE: 0xd8d84a,     // 60°  黄 — 模块
  interface: 0xf0a850, INTERFACE: 0xf0a850, // 30° 橙 — 接口
  variable: 0xf07070, VARIABLE: 0xf07070, // 0°   红 — 变量
  constant: 0xd850b0, CONSTANT: 0xd850b0, // 320° 品红 — 常量
  medium: 0xf0c060, MEDIUM: 0xf0c060,
  file: 0xf0c060, FILE: 0xf0c060,         // 40° 金
  database: 0xe0a040, DATABASE: 0xe0a040, // 35° 暗金
  cache: 0xd09030, CACHE: 0xd09030,       // 30° 更暗
  queue: 0xc08020, QUEUE: 0xc08020,       // 25° 最暗
  temporal: 0xc098ff, TEMPORAL: 0xc098ff,
  thread: 0xc098ff, THREAD: 0xc098ff,     // 270° 紫
  timer: 0xa880ff, TIMER: 0xa880ff,       // 260° 蓝紫
  trigger: 0x9068ff, TRIGGER: 0x9068ff,   // 250° 更蓝紫
};
const GLOW_COLORS: Record<string, number> = {
  symbol: 0x2a6acc, SYMBOL: 0x2a6acc,
  function: 0x1a9888, FUNCTION: 0x1a9888,
  method: 0x1a9888, METHOD: 0x1a9888,
  class: 0x4a982a, CLASS: 0x4a982a,
  module: 0x98982a, MODULE: 0x98982a,
  interface: 0xc07028, INTERFACE: 0xc07028,
  variable: 0xc03838, VARIABLE: 0xc03838,
  constant: 0x983070, CONSTANT: 0x983070,
  medium: 0xcc8800, MEDIUM: 0xcc8800,
  file: 0xcc8800, FILE: 0xcc8800,
  database: 0xb07000, DATABASE: 0xb07000,
  cache: 0x905800, CACHE: 0x905800,
  queue: 0x704000, QUEUE: 0x704000,
  temporal: 0x7855cc, TEMPORAL: 0x7855cc,
  thread: 0x7855cc, THREAD: 0x7855cc,
  timer: 0x6040bb, TIMER: 0x6040bb,
  trigger: 0x4830aa, TRIGGER: 0x4830aa,
};

// ponytail: 10 边各独立色相 — 结构系冷色, 数据系暖色, 时序系紫橙; 旧引擎 data/temporal 兼容映射
const _EDGE_COLORS: Record<string, number> = {
  calls: 0x4a9adf,       // 210° 蓝
  imports: 0x4adfdf,     // 180° 青
  defines: 0x4adf8a,     // 150° 青绿
  inherits: 0xff66dd,    // 315° 品红
  reads: 0x66dd66,       // 120° 绿
  writes: 0xff5566,      // 355° 红
  shares: 0xffaa44,      // 35° 橙
  triggers: 0xff8833,    // 22° 橙红
  awaits: 0xc068ff,      // 280° 紫
  sequences: 0x8866ff,   // 250° 蓝紫
  data: 0xff5566,        // 兼容旧引擎
  temporal: 0xff8833,
  structural: 0x4a9adf,
};
function edgeColorByType(edgeType: string, direction: string, crossFile = false): THREE.Color {
  const et = edgeType.toLowerCase();
  if (et === 'data') return new THREE.Color(direction === 'write' ? _EDGE_COLORS.writes : _EDGE_COLORS.reads);
  if (et === 'structural') return new THREE.Color(_EDGE_COLORS.calls);
  if (et === 'inherits' || (crossFile && direction === 'inherit')) return new THREE.Color(_EDGE_COLORS.inherits);
  const hex = _EDGE_COLORS[et] ?? _EDGE_COLORS.calls;
  return new THREE.Color(hex);
}
function edgeOpacityByDepth(depth: number): number {
  // ponytail: m 0.05→0.02 总览极淡; 边类型辨识靠图例筛选+hover 提亮
  const m = 0.02;
  switch (depth) { case 1: return 0.04 * m; case 2: return 0.11 * m; case 3: return 0.17 * m; case 4: return 0.22 * m; default: return 0.08 * m; }
}

function edgeWidthByDepth(depth: number): number {
  switch (depth) { case 1: return 1.0; case 2: return 1.4; case 3: return 1.8; case 4: return 2.4; default: return 1.2; }
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

// ── Procedural spiral galaxy generation (GPU companion) ──────
// After GPU N-body sets community centroids, each community's nodes
// are placed in a spiral-arm pattern — hubs at center, leaves in arms.
// O(n) total, no iterations. Game-engine-style procedural generation.
function spiralGalaxies(
  pos: Float32Array,
  n: number,
  nodeComm: number[],
  nodeDeg: number[],
  shellRadius: number,
): void {
  // ── Build communities + compute centroids from GPU output ──
  type Comm = { cx: number; cy: number; cz: number; cnt: number; nodes: number[] };
  const comms = new Map<number, Comm>();
  const unassigned: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = nodeComm[i];
    if (c < 0) { unassigned.push(i); continue; }
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

  // ── Per-community spiral generation ──
  const goldenAngle = Math.PI * (3 - Math.sqrt(5)); // ~137.5° — sunflower seed pattern
  for (const cc of commArr) {
    const m = cc.nodes.length;
    // Sort by degree descending — hub at center
    cc.nodes.sort((a, b) => nodeDeg[b] - nodeDeg[a]);
    // Community radius scales with member count
    const commR = Math.cbrt(m) * shellRadius * 0.04;
    // Arm count: 2 for small, 3 for medium, 4 for large
    const arms = m < 15 ? 2 : m < 40 ? 3 : 4;
    // Spiral twist: how tightly arms wind
    const twist = 1.2 + (m % 7) * 0.3;
    // Disk flattening
    const flat = 0.15 + (m % 5) * 0.04;
    // Random tilt per community
    const tiltA = (cc.cx * 7.3 + cc.cy * 3.1) % (Math.PI * 2);
    const tiltB = (cc.cz * 5.7 + cc.cx * 2.3) % (Math.PI * 0.6);
    const ctA = Math.cos(tiltA), stA = Math.sin(tiltA);
    const ctB = Math.cos(tiltB), stB = Math.sin(tiltB);

    for (let j = 0; j < m; j++) {
      // Radius: hub at ~0, leaves at commR
      const t = j / Math.max(1, m - 1); // 0=hub, 1=leaf
      const r = commR * Math.pow(t, 0.55); // nonlinear — denser near center
      // Angle: spiral + arm offset
      const armIdx = j % arms;
      const armAngle = (armIdx / arms) * Math.PI * 2;
      const spiralAngle = r * twist + armAngle;
      // Scatter: leaves have more scatter than hubs
      const scatter = commR * 0.06 * (0.3 + t * 1.2);
      const gauss = () => {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      };
      // Position in local disk frame
      let px = Math.cos(spiralAngle) * r + gauss() * scatter;
      let py = gauss() * r * flat * 0.5;
      let pz = Math.sin(spiralAngle) * r + gauss() * scatter;
      // Apply tilt rotation
      let rx = px * ctA - pz * stA;
      let rz = px * stA + pz * ctA;
      let ry = py * ctB - rz * stB;
      rz = py * stB + rz * ctB;
      // Place at centroid
      const i = cc.nodes[j];
      pos[i * 3] = cc.cx + rx;
      pos[i * 3 + 1] = cc.cy + ry;
      pos[i * 3 + 2] = cc.cz + rz;
    }
  }

  // Unassigned nodes stay near origin with slight scatter
  for (let j = 0; j < unassigned.length; j++) {
    const i = unassigned[j];
    const r = shellRadius * 0.1 * Math.cbrt(j + 1);
    const th = goldenAngle * j;
    const ph = Math.acos(1 - 2 * (j + 0.5) / Math.max(1, unassigned.length));
    pos[i * 3] = Math.cos(th) * Math.sin(ph) * r;
    pos[i * 3 + 1] = Math.cos(ph) * r;
    pos[i * 3 + 2] = Math.sin(th) * Math.sin(ph) * r;
  }
}

// ponytail: 社区质心斥力+跨边引力后处理 — 推开无依赖社区, 拉近有跨边的社区, 结构感来自耦合关系
function repelCommunityCentroids(
  pos: Float32Array,
  n: number,
  nodeComm: number[],
  shellRadius: number,
  edgePairs: [number, number][],
): void {
  const commMap = new Map<number, { cx: number; cy: number; cz: number; nodes: number[]; r: number; idx: number }>();
  for (let i = 0; i < n; i++) {
    const c = nodeComm[i];
    if (c < 0) continue;
    let cc = commMap.get(c);
    if (!cc) { cc = { cx: 0, cy: 0, cz: 0, nodes: [], r: 0, idx: 0 }; commMap.set(c, cc); }
    cc.cx += pos[i * 3]; cc.cy += pos[i * 3 + 1]; cc.cz += pos[i * 3 + 2];
    cc.nodes.push(i);
  }
  const comms = [...commMap.values()];
  if (comms.length < 2) return;
  for (let a = 0; a < comms.length; a++) comms[a].idx = a;
  for (const cc of comms) {
    cc.cx /= cc.nodes.length; cc.cy /= cc.nodes.length; cc.cz /= cc.nodes.length;
    const dists: number[] = [];
    for (const i of cc.nodes) {
      const dx = pos[i * 3] - cc.cx, dy = pos[i * 3 + 1] - cc.cy, dz = pos[i * 3 + 2] - cc.cz;
      dists.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    dists.sort((a, b) => a - b);
    cc.r = dists[Math.floor(dists.length * 0.9)] || 20;
  }
  // 跨社区边权重矩阵
  const C = comms.length;
  const crossW = new Array(C).fill(0).map(() => new Array(C).fill(0));
  for (const [s, t] of edgePairs) {
    const sc = nodeComm[s], tc = nodeComm[t];
    if (sc < 0 || tc < 0 || sc === tc) continue;
    const sa = commMap.get(sc)?.idx, ta = commMap.get(tc)?.idx;
    if (sa === undefined || ta === undefined) continue;
    crossW[sa][ta]++; crossW[ta][sa]++;
  }
  const FACTOR = 2.1;
  const ITERS = 40;
  const ATT_STR = 0.008; // 跨边引力强度
  for (let iter = 0; iter < ITERS; iter++) {
    const deltas = comms.map(() => ({ dx: 0, dy: 0, dz: 0 }));
    let hadOverlap = false;
    for (let a = 0; a < C; a++) {
      for (let b = a + 1; b < C; b++) {
        const ca = comms[a], cb = comms[b];
        const dx = cb.cx - ca.cx, dy = cb.cy - ca.cy, dz = cb.cz - ca.cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < 0.01) continue;
        const nx = dx / dist, ny = dy / dist, nz = dz / dist;
        // 斥力: 重叠时推开
        const minDist = (ca.r + cb.r) * FACTOR;
        if (dist < minDist) {
          hadOverlap = true;
          const push = (minDist - dist) / 2;
          deltas[a].dx -= nx * push; deltas[a].dy -= ny * push; deltas[a].dz -= nz * push;
          deltas[b].dx += nx * push; deltas[b].dy += ny * push; deltas[b].dz += nz * push;
        }
        // 引力: 有跨边的关系拉近, 力度随边数增长但封顶防塌
        const w = crossW[a][b];
        if (w > 0) {
          const pull = Math.min(w * ATT_STR, dist * 0.3);
          deltas[a].dx += nx * pull; deltas[a].dy += ny * pull; deltas[a].dz += nz * pull;
          deltas[b].dx -= nx * pull; deltas[b].dy -= ny * pull; deltas[b].dz -= nz * pull;
        }
      }
    }
    if (!hadOverlap && iter > 10) break;
    for (let a = 0; a < C; a++) {
      const cc = comms[a], d = deltas[a];
      cc.cx += d.dx; cc.cy += d.dy; cc.cz += d.dz;
      for (const i of cc.nodes) {
        pos[i * 3] += d.dx; pos[i * 3 + 1] += d.dy; pos[i * 3 + 2] += d.dz;
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

  // Batched rendering (ponytail: 1 InstancedMesh + 2 Points = 3 draw calls vs 210K individual objects)
  private nodeCoresInstanced!: THREE.InstancedMesh;
  private nodeGlowsPoints!: THREE.Points;
  private nodeGlows2Points!: THREE.Points;
  // CPU-side buffers (uploaded to GPU each frame)
  private _coreScales: Float32Array = new Float32Array(0);
  private _glowRgba: Float32Array = new Float32Array(0);
  private _glow2Rgba: Float32Array = new Float32Array(0);
  private _glowSizes: Float32Array = new Float32Array(0);   // per-point size (twinkle variation)
  private _glow2Sizes: Float32Array = new Float32Array(0);  // outer glow size
  private _nodeMagCache: Float32Array = new Float32Array(0); // pre-computed log1p ratio
  private _overrideFlags: Float32Array = new Float32Array(0); // 0=shader animated, 1=CPU overridden
  private _prevOverrideSet: Set<number> = new Set(); // nodes overridden last frame (for reset)
  private _nodeCount = 0;
  // Reference colors (unchanged API)
  private nodeGlowColors: number[] = [];
  private nodeCoreColors: number[] = [];
  // Edge rendering (unchanged)
  private edgeLineGroups: LineSegments2[] = [];
  private scaleMode: 'degree' | 'coupling' = 'degree';

  // Full-FX extras
  private _nodeBaseHSL: Array<{ h: number; s: number; l: number }> = [];
  private edgeParticles!: THREE.Points;
  private edgeParticleData: { edgeIdx: number; t: number; speed: number; dir: number }[] = [];

  // Minimap
  private minimapContainer!: HTMLDivElement;
  private minimapCanvas!: HTMLCanvasElement;
  private minimapCtx!: CanvasRenderingContext2D;
  private minimapTooltip!: HTMLDivElement;
  private _mmDragging = false;
  private _mmOffX = 0; private _mmOffY = 0;
  private _mmHoveredNode = -1;
  private _mmNodeColors: string[] = [];  // precomputed rgba color strings per node

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
  // ponytail: 总览关 bloom 防边密集区雾化; 聚焦开 bloom 让 hover 发光鲜明。滞回防抖。
  private _bloomFar = false;
  private _bloomHysteresis = 0; // 0=稳态, 正值刚切换倒计时防回弹

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
  // ponytail: 统一飞行规划 — focusTarget 语义改为"相机终点"，_focusLookTarget 是看向的点
  private _focusLookTarget = new THREE.Vector3();
  private _focusStartTime = 0;
  private _focusDurationMs = 600;
  private _userInteracting = false;
  private _flyDebounce: ReturnType<typeof setTimeout> | null = null;

  // File highlight (from file tree)
  private _fileHighlight = false;
  private _fileHighlightIndices = new Set<number>();
  private _fileOpacityOriginal = new Map<number, number>();
  private _agentHighlightIndices = new Set<number>();
  private _edgeTypeFilter: string | null = null;
  private _nodeKindFilter: string | null = null;

  // Step 2: Agent lens & trail
  private _lensActive = false;
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
  private galaxyGlows: THREE.Object3D[] = [];

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
    // ponytail: 用户手动操作即放弃自动 fly，避免抢镜头
    this.controls.addEventListener('start', () => {
      this._userInteracting = true;
      this.focusActive = false;
      if (this._flyDebounce) { clearTimeout(this._flyDebounce); this._flyDebounce = null; }
    });
    this.controls.addEventListener('end', () => { this._userInteracting = false; });
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

    // Minimap — draggable radar overview with title bar + hover tooltip
    const mmc = document.createElement('div');
    mmc.id = 'graph-minimap-container';
    mmc.style.cssText = 'position:absolute;bottom:12px;right:12px;z-index:10;transition:opacity 0.25s;';
    // Title bar
    const mmTitle = document.createElement('div');
    mmTitle.id = 'minimap-titlebar';
    mmTitle.innerHTML = `${iconHtml('focus', 11)} <span style="font-size: calc(10px * var(--font-scale));letter-spacing:0.04em;">小地图</span>`;
    mmTitle.style.cssText = 'display:flex;align-items:center;gap:4px;padding:3px 8px;color:rgba(255,255,255,0.55);background:rgba(3,8,18,0.75);border:1px solid rgba(255,255,255,0.1);border-bottom:none;border-radius:8px 8px 0 0;font-family:system-ui,sans-serif;pointer-events:none;';
    // Canvas
    const mmCanvas = document.createElement('canvas');
    mmCanvas.id = 'graph-minimap';
    mmCanvas.width = 280; mmCanvas.height = 190;
    mmCanvas.style.cssText = 'display:block;border:1px solid rgba(255,255,255,0.12);border-radius:0 0 8px 8px;background:radial-gradient(ellipse at center,rgba(6,16,36,0.92) 0%,rgba(2,6,16,0.96) 100%);cursor:grab;box-shadow:0 0 12px rgba(60,120,220,0.12),0 0 2px rgba(0,0,0,0.6);';
    // Tooltip
    const mmTip = document.createElement('div');
    mmTip.id = 'minimap-tooltip';
    mmTip.style.cssText = 'position:absolute;pointer-events:none;padding:2px 7px;font-size: calc(10px * var(--font-scale));color:#eef;background:rgba(2,5,16,0.9);border:1px solid rgba(255,255,255,0.18);border-radius:4px;white-space:nowrap;display:none;font-family:system-ui,sans-serif;top:0;left:0;';
    mmc.appendChild(mmTitle);
    mmc.appendChild(mmCanvas);
    mmc.appendChild(mmTip);
    this.container.appendChild(mmc);
    this.minimapContainer = mmc;
    this.minimapCanvas = mmCanvas;
    this.minimapCtx = mmCanvas.getContext('2d')!;
    this.minimapTooltip = mmTip;
    this._setupMinimapDrag();
    this._setupMinimapInteraction();

    this.buildLegend();
    this.buildFocusBanner();

    // Rebuild legend + focus banner on language change
    this._langHandler = ({ lang }: { lang: string }) => {
      setLang(lang as 'zh' | 'en');
      // Remove old DOM elements before rebuilding
      if (this.legendEl) { this.legendEl.remove(); }
      this.buildLegend();
      if (this._nodeCount > 0) this.legendEl.style.display = '';
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
    if (this.hoveredIdx < 0 || this.hoveredIdx >= this._nodeCount) { this.tooltipEl.classList.remove('visible'); return; }
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
      '<div class="dc-header">' +
        '<div class="dc-name"></div>' +
        `<button class="dc-close">${iconHtml('close', 14)}</button>` +
      '</div>' +
      '<div class="dc-meta"><span class="dc-kind"></span><span class="dc-degree"></span></div>' +
      '<div class="dc-location"></div>' +
      '<div class="dc-divider"></div>' +
      '<div class="dc-section-title">耦合层级</div>' +
      '<div class="dc-coupling"></div>' +
      '<div class="dc-divider"></div>' +
      '<div class="dc-actions">' +
        `<button class="dc-open-btn">${iconHtml('file', 11)} 打开</button>` +
        `<button class="dc-agent-btn">${iconHtml('agent', 11)} 问 Agent</button>` +
        `<button class="dc-blast-btn">${iconHtml('blast', 11)} 波及</button>` +
        `<button class="dc-focus-btn">${iconHtml('focus', 11)} 聚焦</button>` +
      '</div>' +
      '<div class="dc-blast-filters">' +
        '<div class="dc-filter-label">边类型过滤</div>' +
        '<div class="dc-filter-btns">' +
          '<button class="dc-filter-btn active" data-type="all">全部</button>' +
          '<button class="dc-filter-btn" data-type="structural">结构</button>' +
          '<button class="dc-filter-btn" data-type="data">数据</button>' +
          '<button class="dc-filter-btn" data-type="temporal">时间</button>' +
        '</div>' +
        '<div class="dc-filter-label">方向过滤</div>' +
        '<div class="dc-filter-btns">' +
          '<button class="dc-filter-btn active" data-dir="both">双向</button>' +
          '<button class="dc-filter-btn" data-dir="outbound">出向</button>' +
          '<button class="dc-filter-btn" data-dir="inbound">入向</button>' +
        '</div>' +
      '</div>';
    this.container.appendChild(this.detailCard);

    // Close
    this.detailCard.querySelector('.dc-close')!.addEventListener('click', (e) => {
      e.stopPropagation(); this.hideDetail();
    });
    // Focus subgraph
    this.detailCard.querySelector('.dc-focus-btn')!.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (this.selectedIdx >= 0) { const idx = this.selectedIdx; this.hideDetail(); this.enterFocusSubgraph(idx); }
    });
    // Blast radius
    this.detailCard.querySelector('.dc-blast-btn')!.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (this.selectedIdx >= 0) this.startBlastMode(this.selectedIdx);
    });
    this.detailCard.querySelector('.dc-blast-btn')!.addEventListener('contextmenu', (e) => {
      e.stopPropagation(); e.preventDefault();
      const panel = this.detailCard.querySelector('.dc-blast-filters') as HTMLElement;
      if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    // Open file
    this.detailCard.querySelector('.dc-open-btn')!.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (this.selectedIdx >= 0) {
        const node = this.graphNodes[this.selectedIdx];
        if (node.location) {
          const loc = node.location;
          const lastColon = loc.lastIndexOf(':');
          const filePath = lastColon > 1 ? loc.substring(0, lastColon) : loc;
          shell.navigateToFile(filePath);
        }
      }
    });
    // Ask Agent
    this.detailCard.querySelector('.dc-agent-btn')!.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (this.selectedIdx >= 0) {
        const node = this.graphNodes[this.selectedIdx];
        const kind = ((node.type || node.kind || 'symbol') as string).toLowerCase();
        const question = `分析节点 "${node.name}" (${TYPE_LABELS[kind] || kind}, 度=${this.deg[this.selectedIdx]}, ${node.location || '未知位置'})。它和其他模块的关系如何？改它会有什么影响？`;
        shell.queryAgent(question);
      }
    });
    // Blast filter: edge type
    this.detailCard.querySelectorAll('.dc-blast-filters .dc-filter-btn[data-type]').forEach(btn => {
      btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        this.blastEdgeType = (btn as HTMLElement).dataset.type || 'all';
        this.detailCard.querySelectorAll('.dc-blast-filters .dc-filter-btn[data-type]').forEach(b => {
          b.classList.toggle('active', b === btn);
        });
        if (this.blastMode) { this.computeBlastDistances(); this.buildBlastEdges(); this.updateBlastNodeColors(); }
      });
    });
    // Blast filter: direction
    this.detailCard.querySelectorAll('.dc-blast-filters .dc-filter-btn[data-dir]').forEach(btn => {
      btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        this.blastDirection = (btn as HTMLElement).dataset.dir || 'both';
        this.detailCard.querySelectorAll('.dc-blast-filters .dc-filter-btn[data-dir]').forEach(b => {
          b.classList.toggle('active', b === btn);
        });
        if (this.blastMode) { this.computeBlastDistances(); this.buildBlastEdges(); this.updateBlastNodeColors(); }
      });
    });
  }

  private onClick(e: MouseEvent): void {
    if (this._nodeCount === 0) return;
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
    const hits = this.raycaster.intersectObject(this.nodeCoresInstanced);
    const idx = hits.length > 0 ? (hits[0].instanceId ?? -1) : -1;

    if (idx >= 0 && idx !== this.selectedIdx) this.showDetail(idx);
    else if (idx < 0) this.hideDetail();
    else if (idx < 0) this.hideDetail();

    // Step 3: Emit graph:node-clicked (for external interaction handlers)
    if (idx >= 0 && idx < this._nodeCount) {
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
    // Emit file path for file tree <-> graph linking
    if (node.location) {
      const filePath = node.location.indexOf(':') >= 0
        ? node.location.substring(0, node.location.lastIndexOf(':'))
        : node.location;
      window.dispatchEvent(new CustomEvent('graph:node-selected', { detail: filePath }));
    }
    const kind = ((node.type || node.kind || 'symbol') as string).toLowerCase();
    // Coupling distance counts
    const dist = [0, 0, 0, 0, 0];
    for (const e of this.edgeDataList) { if (e.s === idx || e.t === idx) dist[e.couplingDepth] = (dist[e.couplingDepth] || 0) + 1; }
    const maxDist = Math.max(...dist, 1);

    // Header: name
    this.detailCard.querySelector('.dc-name')!.textContent = node.name;

    // Meta: kind + degree
    const kindColors: Record<string, string> = {
      symbol: 'var(--signal)', function: 'var(--signal)', method: 'var(--signal)',
      class: 'var(--signal)', module: 'var(--signal)', variable: 'var(--signal)',
      interface: 'var(--signal)', constant: 'var(--signal)',
      medium: 'var(--sol)', file: 'var(--sol)', database: 'var(--sol)',
      cache: 'var(--sol)', queue: 'var(--sol)',
      temporal: 'var(--nebula)', thread: 'var(--nebula)', timer: 'var(--nebula)', trigger: 'var(--nebula)',
    };
    const kindEl = this.detailCard.querySelector('.dc-kind') as HTMLElement;
    kindEl.textContent = TYPE_LABELS[kind] || kind.toUpperCase();
    kindEl.style.color = kindColors[kind] || 'var(--signal)';
    const degEl = this.detailCard.querySelector('.dc-degree') as HTMLElement;
    degEl.textContent = `度 ${this.deg[idx]}${this.deg[idx] >= 10 ? ' · Hub 节点' : ''}`;

    // Location
    this.detailCard.querySelector('.dc-location')!.textContent = node.location || '';

    // Coupling bars — always show all 4
    const bars = [
      { label: 'L1 公开API', v: dist[1], cls: 'l1' },
      { label: 'L2 内部导入', v: dist[2], cls: 'l2' },
      { label: 'L3 共享数据', v: dist[3], cls: 'l3' },
      { label: 'L4 封装穿透', v: dist[4], cls: 'l4' },
    ];
    this.detailCard.querySelector('.dc-coupling')!.innerHTML = bars.map(b => {
      const pct = Math.round((b.v / maxDist) * 100);
      const zero = b.v === 0 ? ' dc-zero' : '';
      const warn = b.v > 0 && (b.cls === 'l3' || b.cls === 'l4')
        ? ` <span class="dc-bar-warn">${iconHtml(b.cls === 'l3' ? 'alert' : 'block', 10)}</span>` : '';
      return `<div class="dc-bar-row${zero}"><span class="dc-bar-label">${b.label}</span><span class="dc-bar-count">${b.v}</span><span class="dc-bar-track"><span class="dc-bar-fill ${b.cls}" style="width:${pct}%"></span></span>${warn}</div>`;
    }).join('');

    // Open button: hide if no location
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
    if (left + 290 > this.container.clientWidth - 10) left = x - 310;
    if (top < 10) top = 10;
    if (top + 300 > this.container.clientHeight - 10) top = this.container.clientHeight - 310;
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
    const n = this._nodeCount;
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
    for (let i = 0; i < this._nodeCount; i++) {
      const onPath = this._pathNodes.has(i) || i === src;
      this._overrideFlags[i] = 1; // all nodes overridden during path mode
      if (i < this._nodeCount) {
        this._setGlowAlpha(i, onPath ? 0.9 : (this._pathNodes.size > 0 ? 0.06 : 0.55));
        if (onPath) {
          this._setGlowColor(i,
            i === src ? 0x44ffdd : i === this._pathTarget ? 0xff8844 : 0x44ddff);
        }
      }
      if (i < this._nodeCount) {
        { let _v=onPath || this._pathNodes.size === 0; this._setCoreVisible(i, _v); }
      }
    }
    this._flushOverrideAttrs();
    // Dim/hide non-path edges
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).opacity =
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
    // Restore normal appearance — clear override flags, shader takes over
    for (let i = 0; i < this._nodeCount; i++) {
      this._overrideFlags[i] = 0;
      if (i < this._nodeCount) {
        this._setGlowAlpha(i, 0.55);
        this._setGlowColor(i, this.nodeGlowColors[i]);
      }
      this._setCoreVisible(i, true);
    }
    this._flushOverrideAttrs();
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).opacity =
        edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
    }
    while (this.highlightEdgeGroup.children.length) this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);
    const st = document.getElementById('status-text');
    if (st && st.innerHTML?.includes('link')) st.innerHTML = '就绪';
  }

  // ── Step 3: Shift+click quick path mode ──────────────────

  /** Get node index from a pointer event, or -1 if no node hit. Checks ALL cores. */
  private _hitNode(e: PointerEvent | MouseEvent): number {
    if (this._nodeCount === 0) return -1;
    const rect = this.container.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(mx, my), this.camera);
    const hits = this.raycaster.intersectObject(this.nodeCoresInstanced);
    return hits.length > 0 ? hits.length > 0 ? (hits[0].instanceId ?? -1) : -1 : -1;
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
      if (idx < this._nodeCount) {
        this._setGlowColor(idx, 0x44ffdd);
        this._setGlowAlpha(idx, 0.9);
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
    if (this._shiftSourceIdx >= 0 && this._shiftSourceIdx < this._nodeCount) {
      this._setGlowColor(this._shiftSourceIdx, this.nodeGlowColors[this._shiftSourceIdx], 0.55);
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

    for (let i = 0; i < this._nodeCount; i++) {
      if (!(this._coreScales[i] > 0)) continue;
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
      'font-family:var(--font-mono);font-size: calc(10px * var(--font-scale));color:var(--starlight-dim,#c3daf8);white-space:nowrap;' +
      'opacity:0;transition:opacity 0.16s;';
    this._promptTitleEl = document.createElement('span');
    this._promptTitleEl.style.cssText = 'max-width:420px;overflow:hidden;text-overflow:ellipsis;';
    this._promptBarEl.appendChild(this._promptTitleEl);
    this._promptBtnEl = document.createElement('button');
    this._promptBtnEl.textContent = 'Ask Agent';
    // Mirror detail-card button template (dc-agent-btn)
    this._promptBtnEl.style.cssText =
      'font-family:var(--font-hud);font-size: calc(8px * var(--font-scale));font-weight:600;' +
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
        shell.queryAgent(this._promptQuestion);
      }
      this._hidePrompt();
    });
    this._promptBarEl.appendChild(this._promptBtnEl);
    // Dismiss button — mirrors dc-close
    const dismissBtn = document.createElement('button');
    dismissBtn.innerHTML = iconHtml('close', 11);
    dismissBtn.style.cssText =
      'padding:2px 4px;border:none;background:none;color:rgba(120,160,215,0.5);' +
      'cursor:pointer;font-size: calc(11px * var(--font-scale));line-height:0;transition:color var(--snap);';
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
    if (this._nodeCount === 0) return -1;
    if (!this.nodeCoresInstanced) return -1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObject(this.nodeCoresInstanced);
    if (hits.length === 0) return -1;
    return hits[0].instanceId ?? -1;
  }

  private updateHover(): void {
    if (this._nodeCount === 0) return;
    if (!isFinite(this.mouse.x) || !isFinite(this.mouse.y)) return;

    // Cloud hover: fold mode with visible galaxy clouds (nodes hidden intentionally)
    const cloudViewActive = this.foldMode && this.galaxyGlows.length > 0;
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
      // Restore previous hovered node — brightness only, no scale change
      if (this.hoveredIdx >= 0 && this.hoveredIdx < this._nodeCount) {
        // Restore original core color
        this._setCoreColor(this.hoveredIdx, this.nodeCoreColors[this.hoveredIdx]);
        if (this.hoveredIdx >= 0 && this.hoveredIdx < this._nodeCount) {
          this._setGlowAlpha(this.hoveredIdx, 0.55);
        }
      }
      this.hoveredIdx = newIdx;
      this.targetHoverScale = newIdx >= 0 ? 1 : 0;
      this.rebuildHighlightEdges(newIdx);
    }
  }

  private rebuildHighlightEdges(nodeIdx: number): void {
    if (this.blastMode) return;
    // In focus subgraph mode, rebuild both focus edges + hover edges together
    if (this.focusSubgraphActive) {
      this._buildFocusSubgraphEdges();
      if (nodeIdx >= 0 && nodeIdx < this._nodeCount) {
        const edges = this.edgeIndexOf[nodeIdx];
        if (edges.length > 0) {
          const pos = this.nodePositions, verts: number[] = [], colors: number[] = [];
          const degNorm = 1 / Math.pow(edges.length, 0.25);
          for (const ei of edges) {
            const d = this.edgeDataList[ei];
            verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
            const c = edgeColorByType(d.edgeType, d.direction, d.crossFile);
            const nearB = 2.5 * degNorm * 0.3;
            const farB  = 2.5 * degNorm;
            if (d.s === nodeIdx) {
              colors.push(Math.min(1, c.r * nearB), Math.min(1, c.g * nearB), Math.min(1, c.b * nearB),
                          Math.min(1, c.r * farB),  Math.min(1, c.g * farB),  Math.min(1, c.b * farB));
            } else {
              colors.push(Math.min(1, c.r * farB),  Math.min(1, c.g * farB),  Math.min(1, c.b * farB),
                          Math.min(1, c.r * nearB), Math.min(1, c.g * nearB), Math.min(1, c.b * nearB));
            }
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
          geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
          this.highlightEdgeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending })));
        }
      }
      return;
    }
    while (this.highlightEdgeGroup.children.length) this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);
    if (nodeIdx < 0 || nodeIdx >= this._nodeCount) return;
    const edges = this.edgeIndexOf[nodeIdx];
    if (edges.length === 0) return;
    const pos = this.nodePositions, verts: number[] = [], colors: number[] = [];
    // ponytail: degree-normalized brightness + per-vertex gradient.
    // Dim at hovered node (30%), bright at far end (100%). Prevents hub
    // over-exposure while keeping low-degree nodes clearly visible.
    const degNorm = 1 / Math.pow(edges.length, 0.25);
    for (const ei of edges) {
      const d = this.edgeDataList[ei];
      verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
      const c = edgeColorByType(d.edgeType, d.direction, d.crossFile);
      const nearB = 2.5 * degNorm * 0.3;
      const farB  = 2.5 * degNorm;
      if (d.s === nodeIdx) {
        colors.push(Math.min(1, c.r * nearB), Math.min(1, c.g * nearB), Math.min(1, c.b * nearB),
                    Math.min(1, c.r * farB),  Math.min(1, c.g * farB),  Math.min(1, c.b * farB));
      } else {
        colors.push(Math.min(1, c.r * farB),  Math.min(1, c.g * farB),  Math.min(1, c.b * farB),
                    Math.min(1, c.r * nearB), Math.min(1, c.g * nearB), Math.min(1, c.b * nearB));
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.highlightEdgeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending })));
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
      div.style.fontSize = focused ? '13px' : '11px';
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
    const n = this._nodeCount;
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
    this.highlightEdgeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending })));
  }

  private exitBlastMode(): void {
    this.blastMode = false; this.blastSource = -1; this.blastDistances = [];
    while (this.highlightEdgeGroup.children.length) this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);
    // ponytail: reset override flags so shader resumes animation.
    // Core colors need explicit reset (InstancedMesh, not shader-driven).
    for (let i = 0; i < this._nodeCount; i++) {
      this._overrideFlags[i] = 0;
      this._setCoreColor(i, this.nodeCoreColors[i]);
      const base = this.getNodeBaseScale(i);
      this._setCoreScale(i, base * 0.35);
    }
    // Restore glow colors to defaults so when override is cleared,
    // the base color attribute has correct values for shader to animate from
    for (let i = 0; i < this._nodeCount; i++) {
      const gc = new THREE.Color(this.nodeGlowColors[i]);
      this._setGlowRgba(i, gc.r, gc.g, gc.b, 0.85);
      if (this._glow2Rgba.length > 0) this._setGlow2Rgba(i, gc.r, gc.g, gc.b, 0.55);
    }
    this._flushOverrideAttrs();
    const st = document.getElementById('status-text');
    if (st && st.innerHTML?.includes('blast')) st.innerHTML = '就绪';
  }

  private updateBlastNodeColors(): void {
    if (!this.blastMode) return;
    for (let i = 0; i < this._nodeCount; i++) {
      const d = this.blastDistances[i];
      if (d >= 0) {
        this._overrideFlags[i] = 1;
        const c = new THREE.Color();
        if (d === 0) c.set(0xffffff); else if (d === 1) c.set(0xff4422); else if (d === 2) c.set(0xff8800); else if (d === 3) c.set(0xffcc00); else c.setHSL(0.55 - (d / this.blastMaxDist) * 0.3, 0.6, 0.4 + (1 - d / this.blastMaxDist) * 0.3);
        this._setGlowColor(i, c);
        this._setGlowAlpha(i, 0.7);
        this._setCoreColor(i, c);
        const base = this.getNodeBaseScale(i);
        this._setCoreScale(i, base * (d === 0 ? 2 : 1));
      } else {
        this._overrideFlags[i] = 1;
        this._setGlowAlpha(i, 0.12);
      }
    }
    // Flush override flags to GPU
    this._flushOverrideAttrs();
  }

  private _flushOverrideAttrs(): void {
    if (this.nodeGlowsPoints?.geometry.attributes['override']) {
      this.nodeGlowsPoints.geometry.attributes['override'].needsUpdate = true;
    }
    if (this.nodeGlows2Points?.geometry.attributes['override']) {
      this.nodeGlows2Points.geometry.attributes['override'].needsUpdate = true;
    }
  }

  // ── Focus ────────────────────────────────────────────────

  private flyToNode(idx: number): void {
    const px = this.nodePositions[idx * 3], py = this.nodePositions[idx * 3 + 1], pz = this.nodePositions[idx * 3 + 2];
    const dist = 30 + (this.deg[idx] || 0) * 4;
    this._planFlight(new THREE.Vector3(px, py, pz), dist);
    this.focusNodeIdx = idx; this.focusFlash = 1;
  }

  // ponytail: 保持当前视线方向飞向 target，不横穿场景；delayMs>0 去抖，连击只飞最后一次
  private _planFlight(targetPos: THREE.Vector3, dist: number, delayMs = 150): void {
    if (this._flyDebounce) { clearTimeout(this._flyDebounce); this._flyDebounce = null; }
    const run = () => {
      const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
      if (dir.lengthSq() < 1e-4) dir.set(0.5, 0.4, 0.7);
      dir.normalize();
      this.focusTarget.copy(targetPos).add(dir.multiplyScalar(dist));
      this._focusLookTarget.copy(targetPos);
      this.focusStartCam.copy(this.camera.position);
      this.focusStartLook.copy(this.controls.target);
      this.focusActive = true; this.focusProgress = 0;
      this._focusStartTime = performance.now();
    };
    if (delayMs > 0 && !this._userInteracting) {
      this._flyDebounce = setTimeout(run, delayMs);
    } else {
      run();
    }
  }

  private _resettingCamera = false;

  /** Reset camera to the default overview position with smooth animation. */
  resetCamera(): void {
    if (this._initCamPos.lengthSq() < 1) return; // not initialized
    if (this._flyDebounce) { clearTimeout(this._flyDebounce); this._flyDebounce = null; }
    this.focusStartCam.copy(this.camera.position);
    this.focusStartLook.copy(this.controls.target);
    this.focusTarget.copy(this._initCamPos);
    this.focusActive = true; this.focusProgress = 0; this.focusNodeIdx = -1; this.focusFlash = 0;
    this._focusStartTime = performance.now();
    this._resettingCamera = true;
  }

  /** Return all visible node names for autocomplete / search. */
  getNodeNames(): string[] {
    return this.graphNodes.map(n => n.name);
  }

  focusNode(query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q || this._nodeCount === 0) return false;
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

    for (let i = 0; i < this._nodeCount; i++) {
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

    for (let i = 0; i < this._nodeCount; i++) {
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

  /** Highlight only edges of one type, dim all others. null = clear filter. */
  setEdgeTypeFilter(edgeType: string | null): void {
    this._edgeTypeFilter = edgeType;
    if (edgeType === null) {
      for (const lines of this.edgeLineGroups) {
        (lines.material as LineMaterial).opacity = edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
      }
    } else {
      // ponytail: 按选中类边数分档 opacity, 防 AdditiveBlending 密集叠加过曝
      const et = edgeType.toLowerCase();
      const selCount = this.edgeDataList.reduce((n, d) => n + (d.edgeType.toLowerCase() === et ? 1 : 0), 0);
      const selOp = selCount > 2000 ? 0.08 : selCount > 200 ? 0.2 : 0.45;
      for (const lines of this.edgeLineGroups) {
        const mat = lines.material as LineMaterial;
        const letype = (lines.userData['edgeType'] as string) || '';
        mat.opacity = letype === edgeType ? selOp : 0.005;
      }
    }
    this._updateLegendActive(edgeType, this._nodeKindFilter);
  }

  /** Dim all nodes except those matching a kind filter. null = clear. */
  setNodeKindFilter(filter: string | null): void {
    this._nodeKindFilter = filter;
    if (filter === null) {
      for (let i = 0; i < this._nodeCount; i++) {
        this._overrideFlags[i] = 0;
        this._setGlowAlpha(i, 0.55);
        this._setCoreVisible(i, true);
      }
      this._flushOverrideAttrs();
      this._updateLegendActive(this._edgeTypeFilter, null);
      return;
    }
    // ponytail: function/method 同色同语义, 点任一都亮两者; medium/temporal 是组匹配
    const matches = (kind: string): boolean => {
      const k = kind.toLowerCase();
      if (filter === 'function' || filter === 'method') return k === 'function' || k === 'method';
      if (filter === 'medium') return ['file', 'database', 'cache', 'queue', 'medium'].includes(k);
      if (filter === 'temporal') return ['thread', 'timer', 'trigger', 'temporal'].includes(k);
      return k === filter;
    };
    for (let i = 0; i < this._nodeCount; i++) {
      const kind = ((this.graphNodes[i]?.type || this.graphNodes[i]?.kind || 'symbol') as string);
      const hit = matches(kind);
      this._overrideFlags[i] = hit ? 1 : 1; // ALL nodes overridden — shader would animate non-matching
      if (hit) {
        this._setGlowAlpha(i, 0.88);
        if (this._glow2Rgba.length > 0) this._setGlow2Alpha(i, 0.48);
      } else {
        this._setGlowAlpha(i, 0);
        if (this._glow2Rgba.length > 0) this._setGlow2Alpha(i, 0);
      }
      this._setCoreVisible(i, hit);
    }
    this._flushOverrideAttrs();
    this._updateLegendActive(this._edgeTypeFilter, filter);
  }

  private _updateLegendActive(activeEdge: string | null, activeNode: string | null = null): void {
    this.legendEl.querySelectorAll<HTMLElement>('.legend-edge-row').forEach(row => {
      const et = row.dataset['edgeType'] || '';
      row.classList.toggle('active', activeEdge !== null && et === activeEdge);
      row.style.opacity = activeEdge === null ? '1' : (et === activeEdge ? '1' : '0.35');
    });
    this.legendEl.querySelectorAll<HTMLElement>('.legend-node-row').forEach(row => {
      const nk = row.dataset['nodeFilter'] || '';
      row.classList.toggle('active', activeNode !== null && nk === activeNode);
      row.style.opacity = activeNode === null ? '1' : (nk === activeNode ? '1' : '0.35');
    });
  }

  // ── Color mode switching ──────────────────────────────────

  /** Cycle node coloring mode. Returns the new mode's display label. */
  // ── Node scale mode ──────────────────────────────────────

  private getNodeBaseScale(i: number): number {
    const val = this.scaleMode === 'degree' ? this.deg[i] : (this.l34Count[i] || 0);
    const maxVal = this.scaleMode === 'degree' ? this.maxDeg : Math.max(1, ...this.l34Count);
    return 0.6 + (val / maxVal) * 2.8;
  }

  // ── Batched GPU helpers (ponytail: write to InstancedMesh/Points buffers) ──

  private _setCoreColor(i: number, c: number | THREE.Color): void {
    if (!this.nodeCoresInstanced || i >= this._nodeCount) return;
    const cc = c instanceof THREE.Color ? c : new THREE.Color(c);
    this.nodeCoresInstanced.setColorAt(i, cc);
    if (this.nodeCoresInstanced.instanceColor) this.nodeCoresInstanced.instanceColor.needsUpdate = true;
  }

  private _setCoreScale(i: number, s: number): void {
    if (!this.nodeCoresInstanced || i >= this._nodeCount) return;
    this._coreScales[i] = s;
    const m = new THREE.Matrix4();
    this.nodeCoresInstanced.getMatrixAt(i, m);
    const p = new THREE.Vector3(); m.decompose(p, new THREE.Quaternion(), new THREE.Vector3());
    m.compose(p, new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    this.nodeCoresInstanced.setMatrixAt(i, m);
    this.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
  }

  private _setCoreVisible(i: number, v: boolean): void {
    this._setCoreScale(i, v ? (this._coreScales[i] || this._getCoreBaseScale(i)) : 0);
  }

  private _getCoreBaseScale(i: number): number { return this.getNodeBaseScale(i) * 0.35; }

  private _setGlowRgba(i: number, r: number, g: number, b: number, a: number): void {
    if (!this.nodeGlowsPoints || i >= this._nodeCount) return;
    this._glowRgba[i * 4] = r; this._glowRgba[i * 4 + 1] = g;
    this._glowRgba[i * 4 + 2] = b; this._glowRgba[i * 4 + 3] = a;
    this.nodeGlowsPoints.geometry.attributes['color'].needsUpdate = true;
  }

  private _setGlowColor(i: number, c: THREE.Color | number, a?: number): void {
    const cc = c instanceof THREE.Color ? c : new THREE.Color(c);
    this._setGlowRgba(i, cc.r, cc.g, cc.b, a ?? this._glowRgba[i * 4 + 3]);
  }

  private _setGlowAlpha(i: number, a: number): void {
    if (i < this._nodeCount) {
      this._glowRgba[i * 4 + 3] = a;
      if (this.nodeGlowsPoints) this.nodeGlowsPoints.geometry.attributes['color'].needsUpdate = true;
    }
  }

  private _setGlow2Rgba(i: number, r: number, g: number, b: number, a: number): void {
    if (!this.nodeGlows2Points || i >= this._nodeCount) return;
    this._glow2Rgba[i * 4] = r; this._glow2Rgba[i * 4 + 1] = g;
    this._glow2Rgba[i * 4 + 2] = b; this._glow2Rgba[i * 4 + 3] = a;
    this.nodeGlows2Points.geometry.attributes['color'].needsUpdate = true;
  }

  private _setGlow2Alpha(i: number, a: number): void {
    if (i < this._nodeCount && this._glow2Rgba.length > 0) {
      this._glow2Rgba[i * 4 + 3] = a;
      if (this.nodeGlows2Points) this.nodeGlows2Points.geometry.attributes['color'].needsUpdate = true;
    }
  }

  private _flushBatch(): void {
    if (this.nodeCoresInstanced) {
      this.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
      if (this.nodeCoresInstanced.instanceColor) this.nodeCoresInstanced.instanceColor.needsUpdate = true;
    }
    if (this.nodeGlowsPoints?.geometry.attributes['color']) {
      this.nodeGlowsPoints.geometry.attributes['color'].needsUpdate = true;
    }
    if (this.nodeGlowsPoints?.geometry.attributes['size']) {
      this.nodeGlowsPoints.geometry.attributes['size'].needsUpdate = true;
    }
    if (this.nodeGlows2Points?.geometry.attributes['color']) {
      this.nodeGlows2Points.geometry.attributes['color'].needsUpdate = true;
    }
    if (this.nodeGlows2Points?.geometry.attributes['size']) {
      this.nodeGlows2Points.geometry.attributes['size'].needsUpdate = true;
    }
  }

  /** Magnitude factor 0.15–1.0: hub nodes shine bright, leaf nodes barely visible. Pre-computed cache. */
  private _nodeMag(i: number): number {
    return this._nodeMagCache[i] ?? 0.15;
  }

  // ── Agent highlight (Agent ↔ 星图联动) ──────────────────

  /** Highlight a set of nodes by name (fuzzy match). Matched nodes glow in the given color; others dim. */
  highlightNodeNames(names: string[], colorHex?: string): void {
    if (this.focusSubgraphActive) this.exitFocusSubgraph();
    this._clearAgentHighlightState();
    if (!names.length || this._nodeCount === 0) return;

    const color = colorHex ? parseInt(colorHex.replace('#', ''), 16) : 0xf0b848; // default sol
    const lowerNames = names.map(n => n.trim().toLowerCase());

    for (let i = 0; i < this._nodeCount; i++) {
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
    for (let i = 0; i < this._nodeCount; i++) {
      this._overrideFlags[i] = 1;
      if (this._agentHighlightIndices.has(i)) {
        this._setGlowColor(i, color);
        this._setGlowAlpha(i, 0.88);
        this._setCoreVisible(i, true);
      } else {
        this._setGlowAlpha(i, 0.025);
      }
    }
    this._flushOverrideAttrs();
    // Dim non-path edges
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = 0.008;
    }
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
    // Restore original glows for previously highlighted nodes + clear override
    for (const i of this._agentHighlightIndices) {
      if (i < this._nodeCount) {
        this._overrideFlags[i] = 0;
        this._setGlowColor(i, this.nodeGlowColors[i]);
        this._setGlowAlpha(i, 0.55);
      }
      this._setCoreVisible(i, true);
    }
    // Restore non-highlighted dimmed nodes (opacity + visibility)
    for (let i = 0; i < this._nodeCount; i++) {
      if (!this._agentHighlightIndices.has(i)) {
        this._overrideFlags[i] = 0;
        this._setGlowAlpha(i, 0.55);
        this._setCoreVisible(i, true);
      }
    }
    this._flushOverrideAttrs();
    // Restore edge opacities
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).opacity =
        edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
    }
    this._agentHighlightIndices.clear();
  }

  // ── P6: Hotspot highlighting — 复发热点着色 ──

  private _hotspotFiles: Map<string, number> = new Map(); // filePath → recurrence count

  /** Color nodes belonging to hotspot files with intensity proportional to L4 recurrence count. */
  highlightHotspots(hotspots: Array<{ file: string; count: number }>): void {
    this.clearHotspots();
    if (!hotspots.length || this._nodeCount === 0) return;

    // Build a map of filename → count
    for (const hs of hotspots) {
      const key = (hs.file || '').replace(/\\/g, '/').toLowerCase();
      const prev = this._hotspotFiles.get(key) || 0;
      this._hotspotFiles.set(key, Math.max(prev, hs.count));
    }

    // Apply coloring: intensity from 0.3 (count=2) to 1.0 (count≥8)
    for (let i = 0; i < this._nodeCount; i++) {
      const loc = (this.graphNodes[i].location || '').toLowerCase();
      if (!loc) continue;
      for (const [hsPath, count] of this._hotspotFiles) {
        if (loc.includes(hsPath) || hsPath.includes(loc)) {
          const intensity = Math.min(1, 0.3 + (count - 2) * 0.12);
          if (i < this._nodeCount) {
            this._overrideFlags[i] = 1;
            const r = 0.85, g = 0.2 + (1 - intensity) * 0.3, b = 0.2 + (1 - intensity) * 0.3;
            this._setGlowRgba(i, r, g, b, 0.35 + intensity * 0.55);
          }
          break;
        }
      }
    }
    this._flushOverrideAttrs();
  }

  clearHotspots(): void {
    if (this._hotspotFiles.size === 0) return;
    this._hotspotFiles.clear();
    // Restore original glow colors and clear override flags
    for (let i = 0; i < this._nodeCount; i++) {
      if (i < this._nodeCount) {
        this._overrideFlags[i] = 0;
        this._setGlowColor(i, this.nodeGlowColors[i] || 0x5588cc);
        this._setGlowAlpha(i, 0.55);
      }
    }
    this._flushOverrideAttrs();
  }

  // ── Agent Lens (Step 2) — dim everything except visited nodes ──

  /** Dim all nodes except those matching the given names to 1% opacity. */
  setAgentLens(nodeNames: Set<string>): void {
    if (!nodeNames || nodeNames.size === 0 || this._nodeCount === 0) {
      this.clearAgentLens();
      return;
    }

    // Build set of matched node indices
    const lensIndices = new Set<number>();
    const lowerNames = Array.from(nodeNames).map(n => n.trim().toLowerCase());

    for (let i = 0; i < this._nodeCount; i++) {
      const nodeName = (this.graphNodes[i].name || '').toLowerCase();
      const shortName = nodeName.split('.').pop() || '';
      const found = lowerNames.some(q =>
        nodeName === q || nodeName.startsWith(q) || nodeName.includes(q) || shortName === q
      );
      if (found) lensIndices.add(i);
    }

    if (lensIndices.size === 0) return;

    // Apply lens: visited nodes stay bright, others dim to 1%
    for (let i = 0; i < this._nodeCount; i++) {
      this._overrideFlags[i] = 1;
      if (lensIndices.has(i)) {
        this._setGlowAlpha(i, 0.88);
        this._setCoreVisible(i, true);
      } else {
        this._setGlowAlpha(i, 0.01);
      }
    }
    this._flushOverrideAttrs();

    // Dim all edges
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = 0.005;
    }

    this._lensActive = true;
  }

  /** Restore normal rendering from agent lens mode. */
  clearAgentLens(): void {
    if (!this._lensActive) return;
    this._lensActive = false;

    for (let i = 0; i < this._nodeCount; i++) {
      this._overrideFlags[i] = 0;
      this._setGlowAlpha(i, 0.55);
      this._setCoreVisible(i, true);
    }
    this._flushOverrideAttrs();

    // Restore edge opacities
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).opacity =
        edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
    }

    this._clearTrailLine();
  }

  // ── Agent Trail (Step 2) — dashed line through visited nodes ──

  /**
   * Draw a dashed line through the sequence of node names (max 20 steps).
   * Most recent nodes are brighter. Earlier nodes fade out.
   */
  updateAgentTrail(nodeNames: string[]): void {
    this._clearTrailLine();

    if (!nodeNames || nodeNames.length < 2 || this._nodeCount === 0) return;

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
    if (!q || this._nodeCount === 0) return -1;
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
    const mx = cx / n, my = cy / n, mz = cz / n;
    // ponytail: 用包围盒半径算自适应距离，密集星团不贴脸、稀疏区域不偏远
    let r = 0;
    for (const i of indices) {
      const dx = this.nodePositions[i * 3] - mx, dy = this.nodePositions[i * 3 + 1] - my, dz = this.nodePositions[i * 3 + 2] - mz;
      r = Math.max(r, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    this._planFlight(new THREE.Vector3(mx, my, mz), Math.max(40, r * 3.2));
  }

  private _applyFileHighlight(): void {
    const hl = this._fileHighlight;
    const idxs = this._fileHighlightIndices;

    // Nodes: dim non-highlighted, set override so shader doesn't animate over
    for (let i = 0; i < this._nodeCount; i++) {
      const visible = !hl || idxs.has(i);
      if (hl && !visible) {
        this._overrideFlags[i] = 1;
        this._setGlowAlpha(i, 0.03);
      } else if (!hl) {
        this._overrideFlags[i] = 0;
        this._setGlowAlpha(i, 0.55);
      }
    }
    if (hl || this._fileOpacityOriginal.size > 0) {
      this._flushOverrideAttrs();
      this._fileOpacityOriginal.clear();
    }

    // Edges: dim all when highlighting
    for (const lines of this.edgeLineGroups) {
      const mat = lines.material as LineMaterial;
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

  // ponytail: 总览(相机距 target > graphRadius*2.2)关 bloom 防边密集叠加区被 bloom 扩散成雾;
  // 聚焦(< graphRadius*1.6)开 bloom 让 hover/选中节点发光鲜明。滞回 30 帧防阈值抖动回弹。
  private _updateBloomByDistance(): void {
    if (this._graphRadius < 1 || this.foldMode) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const farThresh = this._graphRadius * 2.2;
    const nearThresh = this._graphRadius * 1.6;
    const hasBloom = this.composer.passes.indexOf(this.bloomPass) !== -1;
    if (this._bloomHysteresis > 0) { this._bloomHysteresis--; return; }
    if (this._bloomFar) {
      if (dist < nearThresh) {
        this._bloomFar = false;
        if (!hasBloom) this.composer.addPass(this.bloomPass);
        this._bloomHysteresis = 30;
      }
    } else {
      if (dist > farThresh) {
        this._bloomFar = true;
        if (hasBloom) this.composer.removePass(this.bloomPass);
        this._bloomHysteresis = 30;
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

    for (let i = 0; i < this._nodeCount; i++) {
      const nid = this.graphNodes[i].id;
      let diffColor: number | null = null;
      if (this.diffAddedIds.has(nid)) diffColor = GREEN;
      else if (this.diffRemovedIds.has(nid)) diffColor = RED;
      else if (this.diffModifiedIds.has(nid)) diffColor = ORANGE;

      if (diffColor !== null && i < this._nodeCount) {
        this._setGlowColor(i, diffColor);
        this._setGlowAlpha(i, 0.85);
      }
    }

    // Pulse effect on diff nodes: slightly increase scale
    for (let i = 0; i < this._nodeCount; i++) {
      if (this.diffAddedIds.has(this.graphNodes[i].id) && i < this._nodeCount) {
        this._setCoreScale(i, (this._coreScales[i] || 1) * 1.3);
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
    for (let i = 0; i < this._nodeCount; i++) {
      const kind = ((this.graphNodes[i].type || this.graphNodes[i].kind || 'symbol') as string).toLowerCase();
      const glowColor = GLOW_COLORS[kind] || 0x4488cc;
      if (i < this._nodeCount) {
        this._setGlowColor(i, glowColor);
        this._setGlowAlpha(i, false ? 0 : 0.55);
      }
      if (i < this._nodeCount) {
        const coreColor = NODE_COLORS[kind] || 0x6ab0ff;
        this._setCoreColor(i, coreColor);
        const baseScale = this.getNodeBaseScale(i);
        this._setCoreScale(i, isFull ? baseScale * 0.4 : baseScale);
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
    if (this.hoveredIdx >= 0 && this.hoveredIdx < this._nodeCount) {
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
    for (let i = 0; i < this._nodeCount; i++) {
      this._setCoreVisible(i, false);
      if (i < this._nodeCount) this._setGlowAlpha(i, 0);
      if (this._glow2Rgba.length > 0) this._setGlow2Alpha(i, 0);
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
    for (let i = 0; i < this._nodeCount; i++) {
      const kind = ((this.graphNodes[i].type || this.graphNodes[i].kind || 'symbol') as string).toLowerCase();
      const glowColor = GLOW_COLORS[kind] || 0x4488cc;
      const coreColor = glowColor; // dark-universe: type-colored core, not white-hot
      if (i < this._nodeCount) { this._setCoreVisible(i, true); this._setCoreColor(i, coreColor); }
      if (i < this._nodeCount) { this._setGlowAlpha(i, 0.55); this._setGlowColor(i, glowColor); }
          }
    for (const lines of this.edgeLineGroups) {
      lines.visible = true;
      (lines.material as any).opacity =
        edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
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
      if (mi < this._nodeCount) {
        this._setCoreVisible(mi, true);
        this._setCoreColor(mi, StarGraph.CONSTELLATION_COLOR);
      }
      if (mi < this._nodeCount) {
        this._setGlowAlpha(mi, 0.55);
        this._setGlowColor(mi, StarGraph.CONSTELLATION_COLOR);
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
          if (mi < this._nodeCount) {
            this._setCoreColor(mi, subColor);
          }
          if (mi < this._nodeCount) {
            this._setGlowColor(mi, subColor);
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
        this._focusStartTime = performance.now();
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
    for (let i = 0; i < this._nodeCount; i++) {
      this._setCoreVisible(i, false);
      if (i < this._nodeCount) this._setGlowAlpha(i, 0);
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
      this._focusStartTime = performance.now();
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
        'font-size: calc(18px * var(--font-scale));font-weight:700;letter-spacing:1px;pointer-events:none;' +
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
    label.style.cssText = 'position:absolute;z-index:12;pointer-events:none;font-size: calc(16px * var(--font-scale));font-weight:700;color:#ffe0a0;text-shadow:0 0 20px rgba(255,180,60,0.8),0 0 40px rgba(255,140,30,0.4);white-space:nowrap;opacity:0;transition:opacity 0.2s;';
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
    // Restore original galaxyMeta BEFORE applyFoldOverlay (it calls buildGalaxyClouds)
    if (this._savedGalaxyMeta) { this.galaxyMeta = this._savedGalaxyMeta; this._savedGalaxyMeta = null; }
    // Properly restore fold overlay — hides all nodes/edges, shows galaxy clouds
    this.applyFoldOverlay();
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
      for (let i = 0; i < this._nodeCount; i++) {
        this._setCoreVisible(i, false);
        if (i < this._nodeCount) this._setGlowAlpha(i, 0);
      }
      // Show only sub-community members
      const shownIndices: number[] = [];
      for (const nid of subComm.node_ids) {
        const idx = this.graphNodes.findIndex(n => n.id === nid);
        if (idx >= 0) {
          shownIndices.push(idx);
          if (idx < this._nodeCount) {
            this._setCoreVisible(idx, true);
            this._setCoreColor(idx, 0xffaa44);
          }
          if (idx < this._nodeCount) {
            this._setGlowAlpha(idx, 0.55);
            this._setGlowColor(idx, 0xffaa44);
            this._setGlowAlpha(idx, 0.7);
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
      this._focusStartTime = performance.now();
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
        for (let i = 0; i < this._nodeCount; i++) {
          this._setCoreVisible(i, false);
          if (i < this._nodeCount) this._setGlowAlpha(i, 0);
        }
        const shownIndices: number[] = [];
        for (const nid of parentSub.node_ids) {
          const idx = this.graphNodes.findIndex(n => n.id === nid);
          if (idx >= 0) {
            shownIndices.push(idx);
            if (idx < this._nodeCount) { this._setCoreVisible(idx, true); this._setCoreColor(idx, 0xffaa44); }
            if (idx < this._nodeCount) { this._setGlowAlpha(idx, 0.55); this._setGlowColor(idx, 0xffaa44); this._setGlowAlpha(idx, 0.7); }
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
    // ponytail: 实心球+薄晕 — 中心用 SphereGeometry+NormalBlending 有实体遮挡感不叠加过曝;
    // 外晕用 Sprite AdditiveBlending 但极淡只做边缘光; 配色复用 communityColor 全色环
    for (let gi = 0; gi < this.galaxyMeta.length; gi++) {
      const gm = this.galaxyMeta[gi];
      // ponytail: 球半径=cbrt(成员数)*系数, 体积∝节点数, 大小星团差距明显; 用 gm.radius 做上限防超出占地
      const sizeByCount = Math.cbrt(gm.memberIndices.length) * 8;
      const r = Math.min(sizeByCount, Math.max(20, gm.radius || 30) * 0.5);
      const colorHex = communityColor(gm.id);
      const color = new THREE.Color(colorHex);

      // 外晕 sprite (偶数位) — 略大于球体, 极淡边缘光
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTex, color, blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true, opacity: 0.1,
      }));
      halo.position.copy(gm.centroid);
      halo.scale.setScalar(r * 1.15);
      halo.userData = { galaxyIndex: gi, galaxyId: gm.id };
      this.commFoldGroup.add(halo); this.galaxyGlows.push(halo);

      // 中心实体球 (奇数位, hover raycast 命中) — fresnel 边缘发光, 中心暗, 全息能量体质感
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(r, 32, 24),
        new THREE.ShaderMaterial({
          uniforms: { uColor: { value: new THREE.Color(colorHex) }, uOpacity: { value: 1.0 } },
          vertexShader: /* glsl */ `
            varying vec3 vNormal;
            varying vec3 vViewDir;
            void main() {
              vec4 mv = modelViewMatrix * vec4(position, 1.0);
              gl_Position = projectionMatrix * mv;
              vNormal = normalize(normalMatrix * normal);
              vViewDir = normalize(-mv.xyz);
            }
          `,
          fragmentShader: /* glsl */ `
            uniform vec3 uColor;
            uniform float uOpacity;
            varying vec3 vNormal;
            varying vec3 vViewDir;
            void main() {
              float f = 1.0 - abs(dot(normalize(vNormal), normalize(vViewDir)));
              float edge = pow(f, 2.5);
              vec3 col = mix(uColor * 0.15, uColor * 1.6, edge);
              float alpha = (0.35 + edge * 0.55) * uOpacity;
              gl_FragColor = vec4(col, alpha);
            }
          `,
          transparent: true, depthWrite: false, side: THREE.FrontSide,
          blending: THREE.NormalBlending,
        }),
      );
      core.position.copy(gm.centroid);
      core.userData = { galaxyIndex: gi, galaxyId: gm.id };
      this.commFoldGroup.add(core); this.galaxyGlows.push(core);
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
      div.style.cssText = 'position:absolute;z-index:3;pointer-events:none;font-size: calc(10px * var(--font-scale));color:var(--starlight-dim,rgba(200,200,220,0.55));text-shadow:0 0 6px rgba(0,0,0,0.7);white-space:nowrap;transform:translate(-50%,-50%);';
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
    const t = easeInOutCubic(Math.min(1, (performance.now() - this._focusStartTime) / this._focusDurationMs));
    if (this._resettingCamera) {
      this.camera.position.lerpVectors(this.focusStartCam, this.focusTarget, t);
      this.controls.target.lerpVectors(this.focusStartLook, this._initCamTarget, t);
    } else if (this.enteredGalaxyId !== null) {
      this.camera.position.lerpVectors(this.focusStartCam, this.focusTarget, t);
      this.controls.target.lerpVectors(this.focusStartLook, this._constellationLookTarget, t);
    } else {
      // ponytail: focusTarget=相机终点(已含视线方向偏移), _focusLookTarget=看向的点
      this.camera.position.lerpVectors(this.focusStartCam, this.focusTarget, t);
      this.controls.target.lerpVectors(this.focusStartLook, this._focusLookTarget, t);
    }
    if (this.focusNodeIdx >= 0 && this.focusNodeIdx < this._nodeCount) {
      if (this.focusFlash === 1) {
        this._savedFocusGlowScale = 1.0 /* was glow scale */;
        this._savedFocusCoreScale = this._coreScales[this.focusNodeIdx];
      }
      const base = this.getNodeBaseScale(this.focusNodeIdx);
      const flashScale = 1 + Math.sin(t * Math.PI * 2) * 0.5 * this.focusFlash;
      
      this._setGlowAlpha(this.focusNodeIdx, 0.55 + 0.45 * this.focusFlash);
      this._setCoreScale(this.focusNodeIdx, base * flashScale);
      this.focusFlash *= 0.97;
    }
    if (t >= 1) {
      this.focusActive = false; this._resettingCamera = false;
      if (this.enteredGalaxyId === null && !this._resettingCamera && this.focusNodeIdx >= 0) {
        setTimeout(() => this.restoreFocusNode(), 800);
      }
    }
  }

  private _savedFocusGlowScale = 0;
  private _savedFocusCoreScale = 0;

  private restoreFocusNode(): void {
    if (this.focusNodeIdx < 0 || this.focusNodeIdx >= this._nodeCount) return;
    
    this._setGlowAlpha(this.focusNodeIdx, 0.55);
    this._setCoreScale(this.focusNodeIdx, this._savedFocusCoreScale || 1);
    this._savedFocusGlowScale = 0;
    this._savedFocusCoreScale = 0;
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
    // Prefer hierarchical (multi-level) over flat communities
    this.communities = ((graph as any).hierarchical_communities || (graph as any).communities || []) as CommunityData[];
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
    const effGroups = new Set(nodeCommArr.filter(c => c >= 0));
    // GPU path: N-body for macro structure, spiral for micro
    if (gpuLayout.ready) {
      // ── GPU N-body: macro structure from edge forces, spiral for micro ──
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
        if (effGroups.size > 1) {
          spiralGalaxies(rawPos, nodes.length, nodeCommArr, deg, shellRadius);
          layoutSource = 'GPU+spiral';
        }
      } else {
        rawPos = await layout3D(nodes.length, pairs, this._layoutAbort?.signal, nodeCommArr);
        layoutSource = 'CPU(fallback)';
      }
    } else {
      rawPos = await layout3D(nodes.length, pairs, this._layoutAbort?.signal, nodeCommArr);
    }
    // ponytail: 社区质心斥力后处理 — 推开重叠社区, 不碰内部布局
    if (effGroups.size > 1) {
      repelCommunityCentroids(rawPos, nodes.length, nodeCommArr, shellRadius, pairs);
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

    // ── Create batched GPU objects (1 InstancedMesh + 2 Points = 3 draw calls) ──
    this._nodeCount = nodes.length;
    this._coreScales = new Float32Array(nodes.length);
    this._glowRgba = new Float32Array(nodes.length * 4);
    this._glow2Rgba = true ? new Float32Array(nodes.length * 4) : new Float32Array(0);

    this.nodeCoresInstanced = new THREE.InstancedMesh(
      this.sphereGeo,
      this._makeCoreFresnelMaterial(),
      nodes.length,
    );
    this.nodeCoresInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.nodeCoresInstanced.count = 0;
    // ponytail: 10K+ instances spread across large volume → bounding sphere covers
    // the entire graph; frustum culling at the object level is harmful (entire mesh
    // disappears when camera zooms into a region far from the bounding sphere center).
    this.nodeCoresInstanced.frustumCulled = false;
    this.nodeGroup.add(this.nodeCoresInstanced);

    // ── Build scene geometry ──
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
    const BATCH_SIZE = Math.max(50, Math.floor(nodeCount / 40));
    const totalNodes = this._nodeCount;
    const totalEdgeGroups = this.edgeLineGroups.length;

    // Hide all batched objects
    this.nodeCoresInstanced.count = 0;
    this.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
    // ponytail: set override flags so shader passes through CPU alpha during reveal
    this._overrideFlags.fill(1);
    this._flushOverrideAttrs();
    // Zero all glow alpha — override=1 means shader uses these values directly
    this._glowRgba.fill(0);
    this.nodeGlowsPoints.geometry.attributes['color'].needsUpdate = true;
    if (this._glow2Rgba.length > 0) {
      this._glow2Rgba.fill(0);
      this.nodeGlows2Points.geometry.attributes['color'].needsUpdate = true;
    }
    // Save & clear edge opacities
    const edgeTargetOpacities: number[] = [];
    for (const lines of this.edgeLineGroups) {
      const mat = lines.material as LineMaterial;
      edgeTargetOpacities.push(mat.opacity);
      mat.opacity = 0;
    }
    this.labelsContainer.style.opacity = '0';

    this._revealRevealed = false;
    let revealedNodes = 0;
    let revealedEdges = 0;
    const edgeRevealBatch = Math.max(1, Math.ceil(totalEdgeGroups / 10));

    const revealFrame = () => {
      if (this._revealCancelled) return;
      const nodeEnd = Math.min(revealedNodes + BATCH_SIZE, totalNodes);
      // Reveal cores via InstancedMesh.count
      this.nodeCoresInstanced.count = nodeEnd;
      this.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
      // Restore glow alpha for revealed batch
      const gCol = this.nodeGlowsPoints.geometry.attributes['color'].array as Float32Array;
      const g2Col = this.nodeGlows2Points?.geometry.attributes['color']?.array as Float32Array;
      for (let i = revealedNodes; i < nodeEnd; i++) {
        gCol[i * 4 + 3] = 0.75;
        if (g2Col) g2Col[i * 4 + 3] = 0.48;
      }
      this.nodeGlowsPoints.geometry.attributes['color'].needsUpdate = true;
      if (this.nodeGlows2Points) this.nodeGlows2Points.geometry.attributes['color'].needsUpdate = true;
      revealedNodes = nodeEnd;

      const edgeEnd = Math.min(revealedEdges + edgeRevealBatch, totalEdgeGroups);
      for (let i = revealedEdges; i < edgeEnd; i++) {
        const lines = this.edgeLineGroups[i];
        if (lines) (lines.material as LineMaterial).opacity = edgeTargetOpacities[i];
      }
      revealedEdges = edgeEnd;

      if (revealedNodes >= totalNodes && revealedEdges >= totalEdgeGroups) {
        this._revealRevealed = true;
        // ponytail: clear override flags — shader resumes animation now that reveal is done
        this._overrideFlags.fill(0);
        this._flushOverrideAttrs();
        // ponytail: force bounding-sphere recompute now that count==totalNodes.
        this.nodeCoresInstanced.boundingSphere = null;
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
    if (this.nodeCoresInstanced) { (this.nodeCoresInstanced.material as THREE.Material)?.dispose(); }
    if (this.nodeGlowsPoints) { (this.nodeGlowsPoints.material as THREE.Material)?.dispose(); this.nodeGlowsPoints.geometry?.dispose(); }
    if (this.nodeGlows2Points) { (this.nodeGlows2Points.material as THREE.Material)?.dispose(); this.nodeGlows2Points.geometry?.dispose(); }
    for (const lines of this.edgeLineGroups) { lines.geometry?.dispose(); (lines.material as THREE.Material)?.dispose(); }
    this.labelsContainer.innerHTML = '';
    this.labelDivs = []; this.nodeLabelIdx = [];
    // batched: nodeCores/nodeGlows/nodeGlows2 replaced by InstancedMesh+Points this.nodeGlowColors = []; this.nodeCoreColors = []; this._nodeBaseHSL = []; this.edgeLineGroups = [];
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
    this._edgeTypeFilter = null;
    this._nodeKindFilter = null;
    this.blastMode = false; this.blastSource = -1; this.blastDistances = []; this.l34Count = [];
    this._diagMsg = '';
    if (this.legendEl) this.legendEl.style.display = 'none';
    this.focusSubgraphActive = false; this.focusSubgraphIdx = -1; this.focusSubgraphVisibleIndices.clear();
    if (this.focusSubgraphBanner) this.focusSubgraphBanner.style.display = 'none';
    this.tooltipEl?.classList.remove('visible');
    this.detailCard?.classList.remove('visible');
    // Step 2: Clear lens & trail state
    this._lensActive = false;
    this._clearTrailLine();
  }

  // ── Edges ────────────────────────────────────────────────

  private buildEdges(pos: Float32Array, data: EdgeData[]): void {
    if (data.length === 0) return;
    const key = (d: EdgeData) => `${d.edgeType}:${d.direction}:${d.couplingDepth}:${d.crossFile ? 1 : 0}`;
    const groups = new Map<string, { verts: number[]; colors: number[]; depth: number; crossFile: boolean; edgeType: string }>();
    for (const d of data) {
      const k = key(d);
      if (!groups.has(k)) { groups.set(k, { verts: [], colors: [], depth: d.couplingDepth, crossFile: d.crossFile, edgeType: d.edgeType.toLowerCase() }); }
      const g = groups.get(k)!;
      g.verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
      const c = edgeColorByType(d.edgeType, d.direction, d.crossFile);
      g.colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    const resolution = new THREE.Vector2(this.container.clientWidth, this.container.clientHeight);
    for (const [, g] of groups) {
      const B = 2000;
      for (let b = 0; b < g.verts.length; b += B * 6) {
        const v = g.verts.slice(b, b + B * 6), cl = g.colors.slice(b, b + B * 6);
        const geo = new LineSegmentsGeometry();
        geo.setPositions(v);
        geo.setColors(cl);
        const opacity = edgeOpacityByDepth(g.depth);
        const mat = new LineMaterial({
          vertexColors: true, transparent: true, opacity,
          linewidth: edgeWidthByDepth(g.depth),
          resolution, depthWrite: false, blending: THREE.AdditiveBlending,
        });
        const lines = new LineSegments2(geo, mat);
        lines.userData['edgeDepth'] = g.depth;
        lines.userData['edgeType'] = g.edgeType;
        lines.computeLineDistances();
        this.edgeGroup.add(lines); this.edgeLineGroups.push(lines);
      }
    }
  }

  // ── Nodes ────────────────────────────────────────────────

  private buildNodes(nodes: GraphNode[], pos: Float32Array, deg: number[]): void {
    const N = nodes.length;
    const isFull = true;

    // Glow Points geometry buffers (RGBA color + per-point size)
    const glowPosArr = new Float32Array(N * 3);
    const glow2PosArr = isFull ? new Float32Array(N * 3) : new Float32Array(0);
    this._glowSizes = new Float32Array(N);
    this._glow2Sizes = isFull ? new Float32Array(N) : new Float32Array(0);

    // ponytail: GPU-driven shader attributes — static, uploaded once
    const phaseArr = new Float32Array(N);
    const speedArr = new Float32Array(N);
    const magArr = new Float32Array(N);
    const riskArr = new Float32Array(N);
    const hslArr = new Float32Array(N * 3);
    this._overrideFlags = new Float32Array(N); // 0=shader animated, 1=CPU overridden
    // init twinkle data inline (ponytail: avoid separate initTwinkleData call)
    for (let i = 0; i < N; i++) {
      phaseArr[i] = Math.random() * Math.PI * 2;
      speedArr[i] = 0.5 + Math.random() * 2.5;
    }

    const _m = new THREE.Matrix4();
    const _v = new THREE.Vector3();
    const _q = new THREE.Quaternion();

    for (let i = 0; i < N; i++) {
      const kind = ((nodes[i].type || nodes[i].kind || 'symbol') as string).toLowerCase();
      const glowColor = GLOW_COLORS[kind] || 0x4488cc;
      const coreColor = NODE_COLORS[kind] || 0x6ab0ff;
      const baseScale = 0.8 + (deg[i] / this.maxDeg) * 2.8;
      const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];

      // Core InstancedMesh: position + scale in matrix, color in instanceColor
      this._coreScales[i] = baseScale * 0.35;
      this.nodeCoresInstanced.setMatrixAt(i, _m.compose(
        _v.set(px, py, pz), _q, new THREE.Vector3(1, 1, 1).multiplyScalar(this._coreScales[i]),
      ));
      this._setCoreColor(i, coreColor);
      this.nodeCoreColors[i] = coreColor;

      // Inner glow RGBA
      const gc = new THREE.Color(glowColor);
      glowPosArr[i * 3] = px; glowPosArr[i * 3 + 1] = py; glowPosArr[i * 3 + 2] = pz;
      this._glowRgba[i * 4] = gc.r;
      this._glowRgba[i * 4 + 1] = gc.g;
      this._glowRgba[i * 4 + 2] = gc.b;
      this._glowRgba[i * 4 + 3] = 0.85;
      this.nodeGlowColors[i] = glowColor;

      // HSL cache for twinkle
      this._nodeBaseHSL[i] = { h: 0, s: 0, l: 0 };
      gc.getHSL(this._nodeBaseHSL[i]);
      // GPU shader attributes (static, uploaded once)
      hslArr[i * 3] = this._nodeBaseHSL[i].h;
      hslArr[i * 3 + 1] = this._nodeBaseHSL[i].s;
      hslArr[i * 3 + 2] = this._nodeBaseHSL[i].l;

      // Outer glow RGBA + size
      if (isFull) {
        glow2PosArr[i * 3] = px; glow2PosArr[i * 3 + 1] = py; glow2PosArr[i * 3 + 2] = pz;
        this._glow2Rgba[i * 4] = gc.r;
        this._glow2Rgba[i * 4 + 1] = gc.g;
        this._glow2Rgba[i * 4 + 2] = gc.b;
        this._glow2Rgba[i * 4 + 3] = 0.55;
        this._glow2Sizes[i] = 0.8; // base outer glow size, twinkle modulates
      }
      this._glowSizes[i] = 1.0; // base inner glow size, twinkle modulates
    }

    // Pre-compute _nodeMag cache (ponytail: log1p ratio is static, avoid per-frame recalc)
    this._nodeMagCache = new Float32Array(N);
    const logMax = Math.log1p(this.maxDeg);
    for (let i = 0; i < N; i++) {
      this._nodeMagCache[i] = 0.15 + 0.85 * (Math.log1p(this.deg[i]) / logMax);
      magArr[i] = this._nodeMagCache[i];
      riskArr[i] = this.l34Count[i] || 0;
    }

    // Upload + create Points objects
    this.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
    if (this.nodeCoresInstanced.instanceColor) this.nodeCoresInstanced.instanceColor.needsUpdate = true;

    // ── Shared shader attribute helper ──
    const addAnimAttrs = (geo: THREE.BufferGeometry) => {
      geo.setAttribute('phase', new THREE.BufferAttribute(phaseArr, 1));
      geo.setAttribute('speed', new THREE.BufferAttribute(speedArr, 1));
      geo.setAttribute('mag', new THREE.BufferAttribute(magArr, 1));
      geo.setAttribute('risk', new THREE.BufferAttribute(riskArr, 1));
      geo.setAttribute('baseHSL', new THREE.BufferAttribute(hslArr, 3));
      geo.setAttribute('override', new THREE.BufferAttribute(this._overrideFlags, 1));
    };

    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', new THREE.BufferAttribute(glowPosArr, 3));
    glowGeo.setAttribute('color', new THREE.BufferAttribute(this._glowRgba, 4));
    glowGeo.setAttribute('size', new THREE.BufferAttribute(this._glowSizes, 1));
    addAnimAttrs(glowGeo);
    this.nodeGlowsPoints = new THREE.Points(glowGeo, this._makeGlowPointMaterial(1.5, 1.0));
    this.nodeGlowsPoints.frustumCulled = false;
    this.nodeGlowsPoints.renderOrder = 1;
    this.nodeGroup.add(this.nodeGlowsPoints);

    if (isFull) {
      const g2Geo = new THREE.BufferGeometry();
      g2Geo.setAttribute('position', new THREE.BufferAttribute(glow2PosArr, 3));
      g2Geo.setAttribute('color', new THREE.BufferAttribute(this._glow2Rgba, 4));
      g2Geo.setAttribute('size', new THREE.BufferAttribute(this._glow2Sizes, 1));
      addAnimAttrs(g2Geo);
      this.nodeGlows2Points = new THREE.Points(g2Geo, this._makeGlowPointMaterial(0.55, 0.85));
      this.nodeGlows2Points.frustumCulled = false;
      this.nodeGlows2Points.renderOrder = 1;
      this.nodeGroup.add(this.nodeGlows2Points);
    }
  }

  // ponytail: GPU-driven glow — all twinkle/sine/hue-shift math runs in vertex shader.
  // CPU sets uTime/uPulseTime uniforms each frame; per-vertex animData + baseHSL
  // attributes are static.  Override flag skips shader animation for hover/blast/path.
  // ── HSL→RGB in GLSL ──
  private static _GLSL_HSL2RGB = /* glsl */ `
    vec3 hsl2rgb(float h, float s, float l) {
      vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
      return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
    }
  `;

  private _makeGlowPointMaterial(alphaMul: number, sizeMul: number): THREE.ShaderMaterial {
    const hsl2rgb = StarGraph._GLSL_HSL2RGB;
    return new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: this.glowTex },
        uTime: { value: 0 },
        uPulseTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 color;
        attribute float size;
        attribute float phase;
        attribute float speed;
        attribute float mag;
        attribute float risk;
        attribute vec3  baseHSL;
        attribute float override;
        varying vec4 vColor;
        uniform float uTime;
        uniform float uPulseTime;
        ${hsl2rgb}
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float pointScale = 28.0 * (300.0 / -mv.z);
          if (override > 0.5) {
            vColor = color;
            gl_PointSize = size * pointScale;
          } else {
            float twinkle = 1.0 + sin(uTime * speed + phase) * 0.10;
            float riskFreq = 1.0 + risk * 0.7;
            float waveAmp = risk > 0.0 ? min(0.18, risk * 0.06) : 0.03;
            float wave = 1.0 + sin(uPulseTime * riskFreq) * waveAmp;
            float combined = twinkle * wave;
            float alpha = min(1.0, ${alphaMul.toFixed(2)} * combined * mag);
            float hueShift = sin(uTime * 0.3 + phase) * 0.05;
            float newH = mod(baseHSL.x + hueShift + 1.0, 1.0);
            float newS = min(1.0, baseHSL.y * 1.2);
            float newL = min(1.0, baseHSL.z * 1.3);
            vec3 rgb = hsl2rgb(newH, newS, newL);
            vColor = vec4(rgb, alpha);
            gl_PointSize = size * combined * ${sizeMul.toFixed(2)} * pointScale;
          }
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex;
        varying vec4 vColor;
        void main() { gl_FragColor = vColor * texture2D(uTex, gl_PointCoord); }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });
  }

  /** ponytail: restores Fresnel rim on InstancedMesh via onBeforeCompile injection.
   *  Uses sphere pos→normal trick (unit sphere: localNormal = normalize(position)),
   *  so we don't depend on a 'normal' attribute that MeshBasicMaterial may omit. */
  private _makeCoreFresnelMaterial(): THREE.MeshBasicMaterial {
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    mat.onBeforeCompile = (shader) => {
      // ── Vertex: varyings for world-normal, UV, world-pos ──
      shader.vertexShader = shader.vertexShader.replace(
        'void main()',
        `varying vec3 vFresnelWorldNormal;
         varying vec3 vFresnelWorldPos;
         varying vec2 vCoreUv;
         void main()`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `// Fresnel: sphere pos IS the local normal (unit sphere geometry)
         vec3 _fLocalN = normalize(position);
         vFresnelWorldNormal = normalize(mat3(instanceMatrix) * _fLocalN);
         vFresnelWorldPos = (instanceMatrix * vec4(position, 1.0)).xyz;
         vCoreUv = uv;
         #include <project_vertex>`,
      );

      // ── Fragment: center-glow (star-like) + crystalline surface detail ──
      shader.uniforms.uSpikeTex = { value: this.glowTex };
      shader.fragmentShader = shader.fragmentShader.replace(
        'void main()',
        `varying vec3 vFresnelWorldNormal;
         varying vec3 vFresnelWorldPos;
         varying vec2 vCoreUv;
         uniform sampler2D uSpikeTex;
         void main()`,
      );
      // ponytail: inverted Fresnel — luminous core, not plastic rim.
      // NdotV ≈ 1 at sphere center (normal faces camera), ≈ 0 at edge.
      // Center: white-hot 2.5x brighter; Edge: 0.45x dimmer → glowing orb illusion.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `vec3 _fViewDir = normalize(cameraPosition - vFresnelWorldPos);
         float _fNdotV = abs(dot(normalize(vFresnelWorldNormal), _fViewDir));
         float _fCore = pow(_fNdotV, 2.5);
         // Crystalline surface: subtle spike texture overlay for faceted sparkle
         float _fSpike = texture2D(uSpikeTex, vCoreUv * 2.5).r;
         outgoingLight = outgoingLight * (0.45 + _fCore * 2.1) * (1.0 + _fSpike * 0.12);
         #include <opaque_fragment>`,
      );
    };
    return mat;
  }

  // ── Legend (color key) ────────────────────────────────────

  private buildLegend(): void {
    this.legendEl = document.createElement('div');
    this.legendEl.id = 'graph-legend';
    this.legendEl.style.display = 'none';
    this.legendEl.innerHTML =
      `<div class="legend-section">
        <div class="legend-title">${t('legend.node')}</div>
        <div class="legend-row legend-node-row" data-node-filter="symbol" title="${t('legend.symbol.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0x6ab0ff)};color:${hexToCSS(0x6ab0ff)}"></span> ${t('legend.symbol')}</div>
        <div class="legend-row legend-node-row" data-node-filter="function" title="${t('legend.function.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0x4ad8c8)};color:${hexToCSS(0x4ad8c8)}"></span> ${t('legend.function')}</div>
        <div class="legend-row legend-node-row" data-node-filter="method" title="${t('legend.method.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0x4ad8c8)};color:${hexToCSS(0x4ad8c8)}"></span> ${t('legend.method')}</div>
        <div class="legend-row legend-node-row" data-node-filter="class" title="${t('legend.class.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0x7fd84a)};color:${hexToCSS(0x7fd84a)}"></span> ${t('legend.class')}</div>
        <div class="legend-row legend-node-row" data-node-filter="module" title="${t('legend.module.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xd8d84a)};color:${hexToCSS(0xd8d84a)}"></span> ${t('legend.module')}</div>
        <div class="legend-row legend-node-row" data-node-filter="interface" title="${t('legend.interface.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xf0a850)};color:${hexToCSS(0xf0a850)}"></span> ${t('legend.interface')}</div>
        <div class="legend-row legend-node-row" data-node-filter="variable" title="${t('legend.variable.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xf07070)};color:${hexToCSS(0xf07070)}"></span> ${t('legend.variable')}</div>
        <div class="legend-row legend-node-row" data-node-filter="constant" title="${t('legend.constant.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xd850b0)};color:${hexToCSS(0xd850b0)}"></span> ${t('legend.constant')}</div>
        <div class="legend-row legend-node-row" data-node-filter="medium" title="${t('legend.medium.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xf0c060)};color:${hexToCSS(0xf0c060)}"></span> ${t('legend.medium')}</div>
        <div class="legend-row legend-node-row" data-node-filter="temporal" title="${t('legend.temporal.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xc098ff)};color:${hexToCSS(0xc098ff)}"></span> ${t('legend.temporal')}</div>
      </div>
      <div class="legend-section">
        <div class="legend-title">${t('legend.edge')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="calls" title="${t('legend.calls.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4a9adf)}"></span> ${t('legend.calls')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="imports" title="${t('legend.imports.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4adfdf)}"></span> ${t('legend.imports')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="defines" title="${t('legend.defines.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4adf8a)}"></span> ${t('legend.defines')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="inherits" title="${t('legend.inherits.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff66dd)}"></span> ${t('legend.inherits')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="reads" title="${t('legend.dataRead.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x66dd66)}"></span> ${t('legend.dataRead')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="writes" title="${t('legend.dataWrite.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff5566)}"></span> ${t('legend.dataWrite')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="shares" title="${t('legend.shares.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xffaa44)}"></span> ${t('legend.shares')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="triggers" title="${t('legend.triggers.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff8833)}"></span> ${t('legend.triggers')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="awaits" title="${t('legend.awaits.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xc068ff)}"></span> ${t('legend.awaits')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="sequences" title="${t('legend.sequences.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x8866ff)}"></span> ${t('legend.sequences')}</div>
      </div>`;
    this.container.appendChild(this.legendEl);
    this.legendEl.querySelectorAll<HTMLElement>('.legend-edge-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const et = row.dataset['edgeType'] || '';
        this.setEdgeTypeFilter(this._edgeTypeFilter === et ? null : et);
      });
    });
    this.legendEl.querySelectorAll<HTMLElement>('.legend-node-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const nk = row.dataset['nodeFilter'] || '';
        this.setNodeKindFilter(this._nodeKindFilter === nk ? null : nk);
      });
    });
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
    if (idx < 0 || idx >= this._nodeCount) return;
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
    for (let i = 0; i < this._nodeCount; i++) {
      this.focusSubgraphSavedGlowOpacities.push(
        (i < this._nodeCount ? this._glowRgba[i*4+3] : 0.55));
      this.focusSubgraphSavedCoreVisible.push(
        (i < this._nodeCount ? this._coreScales[i] > 0 : true));

      if (!this.focusSubgraphVisibleIndices.has(i)) {
        if (i < this._nodeCount) {
          this._overrideFlags[i] = 1;
          this._setGlowAlpha(i, 0.02);
        }
        this._setCoreVisible(i, false);
      } else {
        this._overrideFlags[i] = 1;
      }
    }

    // Dim edges
    this.focusSubgraphSavedEdgeOpacities = this.edgeLineGroups.map(
      lines => (lines.material as LineMaterial).opacity);
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = 0.005;
    }

    // Build focus edges (only between visible nodes)
    this._buildFocusSubgraphEdges();

    // Highlight the focus node
    if (idx < this._nodeCount) {
      this._overrideFlags[idx] = 1;
      this._setGlowAlpha(idx, 0.92);
      this._setGlowColor(idx, 0xffffff);
    }

    this._flushOverrideAttrs();
    this.focusSubgraphActive = true;
    const node = this.graphNodes[idx];
    this.focusSubgraphBanner.innerHTML =
      `${iconHtml('focus', 14)} <b>${t('focus.title')}: ${node.name}</b> &middot; ${this.focusSubgraphVisibleIndices.size} ${t('focus.nodes')} &middot; ${t('focus.exit')}`;
    this.focusSubgraphBanner.style.display = 'flex';
    this.flyToNode(idx);
  }

  exitFocusSubgraph(): void {
    if (!this.focusSubgraphActive) return;

    // ponytail: 必须清 focusNodeIdx/focusActive/focusFlash, 否则 updateFocus 的 flash 分支
    // 持续套 scale×5.5+高 opacity 在 focus 节点, 且 restoreFocusNode 定时器恢复 scale 不管 color → 白点残留
    this.focusActive = false;
    this.focusFlash = 0;
    this.focusNodeIdx = -1;

    for (let i = 0; i < this._nodeCount; i++) {
      if (i < this.focusSubgraphSavedGlowOpacities.length && i < this._nodeCount) {
        this._setGlowAlpha(i, this.focusSubgraphSavedGlowOpacities[i]);
      }
      if (i < this.focusSubgraphSavedCoreVisible.length && i < this._nodeCount) {
        { let _v=this.focusSubgraphSavedCoreVisible[i]; this._setCoreVisible(i, _v); }
      }
      // ponytail: 恢复 core color — focus 期间节点可能被 enter 设白或被 hover 循环提白
      if (i < this._nodeCount && i < this.nodeCoreColors.length) {
        this._setCoreColor(i, this.nodeCoreColors[i]);
      }
      // 恢复 glow color — focus 节点被 enter 设成 0xffffff
      if (i < this._nodeCount && i < this.nodeGlowColors.length) {
        this._setGlowColor(i, this.nodeGlowColors[i]);
      }
    }
    for (let ei = 0; ei < this.edgeLineGroups.length; ei++) {
      if (ei < this.focusSubgraphSavedEdgeOpacities.length) {
        (this.edgeLineGroups[ei].material as LineMaterial).opacity =
          this.focusSubgraphSavedEdgeOpacities[ei];
      }
    }
    // Clear focus edges
    while (this.highlightEdgeGroup.children.length)
      this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);

    // ponytail: clear override flags — shader resumes animation
    for (let i = 0; i < this._nodeCount; i++) this._overrideFlags[i] = 0;
    this._flushOverrideAttrs();

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

    // ponytail: count edges first for degree-normalization — prevents
    // hub over-exposure when focus node has hundreds of neighbors.
    let edgeCount = 0;
    for (const d of this.edgeDataList) {
      if (visible.has(d.s) && visible.has(d.t)) edgeCount++;
    }
    if (edgeCount === 0) return;
    const degNorm = 1 / Math.pow(edgeCount, 0.2);

    for (const d of this.edgeDataList) {
      if (visible.has(d.s) && visible.has(d.t)) {
        verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2],
                    pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
        const c = edgeColorByType(d.edgeType, d.direction, d.crossFile);
        colors.push(c.r * degNorm, c.g * degNorm, c.b * degNorm,
                    c.r * degNorm, c.g * degNorm, c.b * degNorm);
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
    this.nodeLabelIdx = [];
  }

  // ── Minimap ───────────────────────────────────────────────

  private _setupMinimapDrag(): void {
    const c = this.minimapContainer;
    const canvas = this.minimapCanvas;
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement)?.id === 'minimap-titlebar') return;
      this._mmDragging = true;
      this._mmOffX = e.clientX - c.offsetLeft;
      this._mmOffY = e.clientY - c.offsetTop;
      c.style.cursor = 'grabbing'; canvas.style.cursor = 'grabbing';
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
      c.style.cursor = ''; canvas.style.cursor = 'grab';
    };
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointerleave', onUp);
  }

  private updateMinimap(): void {
    if (!this.minimapCtx || !this.nodePositions || this.nodePositions.length === 0) return;
    const ctx = this.minimapCtx;
    const W = 280, H = 190;
    const PAD = 14;
    ctx.clearRect(0, 0, W, H);

    // Compute 2D bounds (top-down: XZ plane → minimap XY)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const n = this._nodeCount;
    for (let i = 0; i < n; i++) {
      const x = this.nodePositions[i * 3], z = this.nodePositions[i * 3 + 2];
      if (isFinite(x) && isFinite(z)) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }
    const bw = maxX - minX || 1, bh = maxZ - minZ || 1;
    const scale = Math.min((W - PAD * 2) / bw, (H - PAD * 2) / bh);
    const ox = (W - bw * scale) / 2, oy = (H - bh * scale) / 2;
    const proj = (px: number, pz: number) => ({
      u: ox + (px - minX) * scale,
      v: oy + (pz - minZ) * scale,
    });

    // ── Ensure color cache ──
    if (this._mmNodeColors.length !== n) {
      this._mmNodeColors = new Array(n);
      for (let i = 0; i < n; i++) {
        const kind = this.graphNodes[i]?.kind || this.graphNodes[i]?.type || 'symbol';
        const hex = NODE_COLORS[kind] ?? NODE_COLORS['symbol']!;
        const r = (hex >> 16) & 0xff, g = (hex >> 8) & 0xff, b = hex & 0xff;
        this._mmNodeColors[i] = `${r},${g},${b}`;
      }
    }

    // ── Subtle grid dots ──
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    for (let gx = PAD; gx <= W - PAD; gx += 18) {
      for (let gy = PAD; gy <= H - PAD; gy += 14) {
        ctx.fillRect(gx, gy, 0.6, 0.6);
      }
    }

    // ── Edge lines (sampled, faint) ──
    const edges = this.edgeDataList;
    const maxEdges = 350;
    const edgeStride = edges.length > maxEdges ? Math.floor(edges.length / maxEdges) : 1;
    ctx.lineWidth = 0.4;
    for (let ei = 0; ei < edges.length; ei += edgeStride) {
      const e = edges[ei];
      const su = proj(this.nodePositions[e.s * 3], this.nodePositions[e.s * 3 + 2]);
      const tu = proj(this.nodePositions[e.t * 3], this.nodePositions[e.t * 3 + 2]);
      if (su.u < -4 && tu.u < -4) continue;
      const ec = e.edgeType.toLowerCase();
      let alpha = 0.10;
      if (ec === 'reads') { ctx.strokeStyle = `rgba(102,221,102,${alpha})`; }
      else if (ec === 'writes') { ctx.strokeStyle = `rgba(255,85,102,${alpha})`; }
      else if (ec === 'shares') { ctx.strokeStyle = `rgba(255,170,68,${alpha})`; }
      else if (ec === 'triggers') { ctx.strokeStyle = `rgba(255,136,51,${alpha})`; }
      else if (ec === 'awaits') { ctx.strokeStyle = `rgba(192,104,255,${alpha})`; }
      else if (ec === 'sequences') { ctx.strokeStyle = `rgba(136,102,255,${alpha})`; }
      else if (ec === 'inherits') { ctx.strokeStyle = `rgba(255,102,221,${alpha})`; }
      else if (ec === 'imports') { ctx.strokeStyle = `rgba(74,223,223,${alpha})`; }
      else if (ec === 'defines') { ctx.strokeStyle = `rgba(74,223,138,${alpha})`; }
      else { ctx.strokeStyle = `rgba(74,154,223,${alpha * 0.8})`; }
      ctx.beginPath();
      ctx.moveTo(su.u, su.v);
      ctx.lineTo(tu.u, tu.v);
      ctx.stroke();
    }

    // ── Nodes: glow halo + colored core, sized by degree ──
    const maxD = Math.max(this.maxDeg, 1);
    for (let i = 0; i < n; i++) {
      const { u, v } = proj(this.nodePositions[i * 3], this.nodePositions[i * 3 + 2]);
      if (u < -2 || u > W + 2 || v < -2 || v > H + 2) continue;
      const r = 1.0 + 2.8 * Math.log1p(this.deg[i] || 0) / Math.log1p(maxD);
      const rgb = this._mmNodeColors[i] || '126,184,255';
      // Glow halo
      ctx.fillStyle = `rgba(${rgb},0.18)`;
      ctx.beginPath(); ctx.arc(u, v, r * 2.0, 0, Math.PI * 2); ctx.fill();
      // Soft middle
      ctx.fillStyle = `rgba(${rgb},0.45)`;
      ctx.beginPath(); ctx.arc(u, v, r * 1.15, 0, Math.PI * 2); ctx.fill();
      // Core
      ctx.fillStyle = `rgba(${rgb},0.85)`;
      ctx.beginPath(); ctx.arc(u, v, r, 0, Math.PI * 2); ctx.fill();
    }

    // ── Camera frustum (filled gradient trapezoid) ──
    const cam = this.camera.position;
    const target = this.controls.target;
    const { u: cx, v: cz } = proj(cam.x, cam.z);
    const { u: tx, v: tz } = proj(target.x, target.z);
    const dx = tx - cx, dz = tz - cz;
    const dist = Math.sqrt(dx * dx + dz * dz) || 1;
    const ndx = dx / dist, ndz = dz / dist;
    const halfFov = (this.camera.fov * Math.PI / 180) / 2;
    const fw = Math.tan(halfFov) * dist * 0.35;
    const px = -ndz * fw, pz = ndx * fw;

    // Frustum fill gradient (camera→target fade)
    const grad = ctx.createLinearGradient(cx, cz, tx, tz);
    grad.addColorStop(0, 'rgba(255,200,100,0.22)');
    grad.addColorStop(0.6, 'rgba(255,180,60,0.10)');
    grad.addColorStop(1, 'rgba(255,160,40,0.03)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx - px, cz - pz);
    ctx.lineTo(cx + px, cz + pz);
    ctx.lineTo(tx + px, tz + pz);
    ctx.lineTo(tx - px, tz - pz);
    ctx.closePath();
    ctx.fill();
    // Frustum outline
    ctx.strokeStyle = 'rgba(255,200,100,0.5)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // Camera dot with glow
    ctx.fillStyle = 'rgba(255,200,100,0.22)';
    ctx.beginPath(); ctx.arc(cx, cz, 3.8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,220,140,0.9)';
    ctx.beginPath(); ctx.arc(cx, cz, 2.2, 0, Math.PI * 2); ctx.fill();
    // Small bright center
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.arc(cx, cz, 0.9, 0, Math.PI * 2); ctx.fill();
  }

  // ── Minimap Interaction (hover tooltip + click-to-navigate) ──

  private _setupMinimapInteraction(): void {
    const canvas = this.minimapCanvas;
    const tip = this.minimapTooltip;
    const container = this.minimapContainer;

    // Recompute the projection to map between screen coords and world XZ
    const getProj = () => {
      const W = 280, H = 190, PAD = 14;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < this._nodeCount; i++) {
        const x = this.nodePositions[i * 3], z = this.nodePositions[i * 3 + 2];
        if (isFinite(x) && isFinite(z)) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
      }
      const bw = maxX - minX || 1, bh = maxZ - minZ || 1;
      const scale = Math.min((W - PAD * 2) / bw, (H - PAD * 2) / bh);
      const ox = (W - bw * scale) / 2, oy = (H - bh * scale) / 2;
      return (px: number, pz: number) => ({
        u: ox + (px - minX) * scale,
        v: oy + (pz - minZ) * scale,
      });
    };

    canvas.addEventListener('mousemove', (e: MouseEvent) => {
      if (this._mmDragging || this._nodeCount === 0) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const proj = getProj();
      // Find nearest visible node
      let bestI = -1, bestD2 = 64; // 8px threshold
      for (let i = 0; i < this._nodeCount; i++) {
        const { u, v } = proj(this.nodePositions[i * 3], this.nodePositions[i * 3 + 2]);
        const d2 = (u - mx) ** 2 + (v - my) ** 2;
        if (d2 < bestD2) { bestD2 = d2; bestI = i; }
      }
      if (bestI >= 0) {
        this._mmHoveredNode = bestI;
        const node = this.graphNodes[bestI];
        const kind = node.kind || node.type || 'symbol';
        const deg = this.deg[bestI] || 0;
        tip.textContent = `${node.name} · ${kind} · 度${deg}`;
        tip.style.display = '';
        tip.style.left = `${Math.min(mx + 12, 280 - 120)}px`;
        tip.style.top = `${Math.max(my - 20, 0)}px`;
        canvas.style.cursor = 'pointer';
      } else {
        this._mmHoveredNode = -1;
        tip.style.display = 'none';
        canvas.style.cursor = this._mmDragging ? 'grabbing' : 'grab';
      }
    });

    canvas.addEventListener('mouseleave', () => {
      if (!this._mmDragging) {
        this._mmHoveredNode = -1;
        tip.style.display = 'none';
        canvas.style.cursor = 'grab';
      }
    });

    canvas.addEventListener('click', (e: MouseEvent) => {
      if (this._mmDragging || this._mmHoveredNode < 0) return;
      const idx = this._mmHoveredNode;
      const nx = this.nodePositions[idx * 3];
      const ny = this.nodePositions[idx * 3 + 1];
      const nz = this.nodePositions[idx * 3 + 2];
      if (!isFinite(nx) || !isFinite(ny) || !isFinite(nz)) return;
      // Animate camera to look at this node from a reasonable distance
      const dist = 80 + (this.deg[idx] || 0) * 4;
      const camTarget = new THREE.Vector3(nx, ny, nz);
      const camPos = new THREE.Vector3(nx + dist * 0.6, ny + dist * 0.55, nz + dist * 0.5);
      this._flyCameraTo(camPos, camTarget, 600);
    });
  }

  /** Smooth camera flight using GSAP-like tween with easing */
  private _flyCameraTo(targetPos: THREE.Vector3, lookTarget: THREE.Vector3, durationMs: number): void {
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const startTime = performance.now();
    const animate = () => {
      const elapsed = performance.now() - startTime;
      let t = Math.min(elapsed / durationMs, 1.0);
      // Ease-out cubic
      t = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(startPos, targetPos, t);
      this.controls.target.lerpVectors(startTarget, lookTarget, t);
      this.controls.update();
      if (t < 1.0) {
        requestAnimationFrame(animate);
      }
    };
    requestAnimationFrame(animate);
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

  // ponytail: twinkle data now generated inline in buildNodes (GPU buffer attrs).
  // Kept as no-op for backward compat — called from _renderImpl after init.
  private initTwinkleData(_n: number): void { /* no-op: phase/speed baked into GPU attrs in buildNodes */ }

  private initEdgeParticles(pos: Float32Array, data: EdgeData[]): void {
    // Remove old
    if (this.edgeParticles) { this.galaxyGroup.remove(this.edgeParticles); (this.edgeParticles.material as THREE.Material).dispose(); this.edgeParticles.geometry.dispose(); }
    this.edgeParticleData = [];
    if (data.length === 0) return;

    const isFull = true;
    const isMinimal = false;
    if (isMinimal) return; // no particles in minimal mode

    // Dense visible flow particles — data pulse along edges
    const count = isFull ? Math.min(5000, data.length * 6) : Math.min(2000, data.length * 3);
    const pPos = new Float32Array(count * 3);
    const pCol = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const ei = Math.floor(Math.random() * data.length);
      const d = data[ei];
      const t = Math.random();
      pPos[i * 3]     = pos[d.s * 3]     + (pos[d.t * 3]     - pos[d.s * 3])     * t;
      pPos[i * 3 + 1] = pos[d.s * 3 + 1] + (pos[d.t * 3 + 1] - pos[d.s * 3 + 1]) * t;
      pPos[i * 3 + 2] = pos[d.s * 3 + 2] + (pos[d.t * 3 + 2] - pos[d.s * 3 + 2]) * t;

      // Visible but not overpowering
      const c = edgeColorByType(d.edgeType, d.direction, d.crossFile);
      const bright = 0.5 + Math.random() * 0.7;
      pCol[i * 3] = Math.min(1, c.r * bright);
      pCol[i * 3 + 1] = Math.min(1, c.g * bright);
      pCol[i * 3 + 2] = Math.min(1, c.b * bright);

      this.edgeParticleData.push({
        edgeIdx: ei, t,
        speed: (isFull ? 0.004 : 0.002) + Math.random() * (isFull ? 0.014 : 0.006),
        dir: Math.random() > 0.5 ? 1 : -1,
      });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
    const mat = new THREE.PointsMaterial({
      size: isFull ? 2.2 : 1.3,
      map: this.glowTex, blending: THREE.AdditiveBlending,
      depthWrite: false, vertexColors: true, transparent: true,
      opacity: isFull ? 0.85 : 0.6,
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
      try { this._updateBloomByDistance(); } catch { /* bloom switch must never crash loop */ }
    }

    // ponytail: GPU-driven glow — set time uniforms, shader handles all animation.
    // CPU only touches hovered node + neighbors (~10 nodes).
    const galTime = performance.now() * 0.001;
    // Update shader time uniforms on both glow layers
    if (this.nodeGlowsPoints) {
      (this.nodeGlowsPoints.material as THREE.ShaderMaterial).uniforms['uTime'].value = galTime;
      (this.nodeGlowsPoints.material as THREE.ShaderMaterial).uniforms['uPulseTime'].value = this.pulseTime;
    }
    if (this.nodeGlows2Points) {
      (this.nodeGlows2Points.material as THREE.ShaderMaterial).uniforms['uTime'].value = galTime;
      (this.nodeGlows2Points.material as THREE.ShaderMaterial).uniforms['uPulseTime'].value = this.pulseTime;
    }

    // ── Hover overrides — reset previous, apply current ──
    // Track previously overridden nodes so we can release them back to shader
    if (!this._prevOverrideSet) this._prevOverrideSet = new Set<number>();
    for (const pi of this._prevOverrideSet) {
      if (pi < this._nodeCount) this._overrideFlags[pi] = 0;
    }
    this._prevOverrideSet.clear();
    if (this.nodeGlowsPoints?.geometry.attributes['override']) {
      this.nodeGlowsPoints.geometry.attributes['override'].needsUpdate = true;
    }
    if (this.nodeGlows2Points?.geometry.attributes['override']) {
      this.nodeGlows2Points.geometry.attributes['override'].needsUpdate = true;
    }

    // Hover effects — brightness-only, no size inflation
    this.hoverScale += (this.targetHoverScale - this.hoverScale) * 0.18;
    const neighborSet = new Set(this.hoveredIdx >= 0 ? this.neighborMap[this.hoveredIdx] || [] : []);
    if (this.hoveredIdx >= 0 && this.hoveredIdx < this._nodeCount) {
      this._overrideFlags[this.hoveredIdx] = 1;
      this._prevOverrideSet.add(this.hoveredIdx);
      this._setGlowAlpha(this.hoveredIdx, 0.65 + this.hoverScale * 0.35);
      // Brighten core color toward white on hover
      const origColor = this.nodeCoreColors[this.hoveredIdx];
      const brightColor = new THREE.Color(origColor).lerp(new THREE.Color(0xffffff), this.hoverScale * 0.6);
      this._setCoreColor(this.hoveredIdx, brightColor);
      for (const ni of neighborSet) {
        if (ni !== this.hoveredIdx && ni < this._nodeCount) {
          this._overrideFlags[ni] = 1;
          this._prevOverrideSet.add(ni);
          this._setGlowAlpha(ni, 0.55 + this.hoverScale * 0.10);
        }
      }
    }
    // Flush override flags to GPU (only when overrides changed)
    if (this._prevOverrideSet.size > 0) {
      if (this.nodeGlowsPoints?.geometry.attributes['override']) {
        this.nodeGlowsPoints.geometry.attributes['override'].needsUpdate = true;
      }
      if (this.nodeGlows2Points?.geometry.attributes['override']) {
        this.nodeGlows2Points.geometry.attributes['override'].needsUpdate = true;
      }
    }

    // ── Mode-driven override: blast/path/filter set once on mode change, not per-frame ──
    // ponytail: blast/path/filter modes already call updateBlastNodeColors / highlightPath / etc.
    // which set per-node colors AND override flags. The shader preserves those until reset.
    // We only need to handle the case where a mode was active but animate loop was
    // resetting nodes outside the mode ring back to animated state.
    // With shader-driven glow, no per-frame reset needed — shader animates non-overridden nodes.

    // Galaxy cloud breathe + hover ...
    if (this.foldMode && !this.enteredGalaxyId) {
      this.animateCrossEdgeFlow();
      for (let k = 0; k < this.galaxyGlows.length; k++) {
        const glow = this.galaxyGlows[k];
        if (!glow) continue;
        const gi = Math.floor(k / 2);
        const gm = this.galaxyMeta[gi];
        if (!gm) continue;
        const hovered = gi === this.hoveredGalaxyIdx;
        if (k % 2 === 0) {
          // 外晕 sprite — 缓慢呼吸, hover 提亮
          const w = 1 + Math.sin(this.pulseTime * 0.5 + k * 1.7) * 0.1;
          ((glow as THREE.Sprite).material as THREE.SpriteMaterial).opacity = (hovered ? 0.2 : 0.1) * w;
        } else {
          // 中心球 shader — 轻微脉冲, hover 提亮放大
          const hoverMul = hovered ? 1.2 : 1.0;
          const beat = 0.9 + 0.1 * Math.abs(Math.sin(this.pulseTime * (1.2 + gi * 0.37)));
          ((glow as THREE.Mesh).material as THREE.ShaderMaterial).uniforms['uOpacity'].value = beat * hoverMul;
          glow.scale.setScalar(hovered ? 1.15 : 1.0);
        }
      }
    }

    this.pulseTime += 0.03 * (isFull ? 1.5 : 1);

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
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).resolution.set(w, h);
    }
  };

  // ── Destroy ──────────────────────────────────────────────

  destroy(): void {
    cancelAnimationFrame(this.animId);
    this.minimapContainer?.remove();
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
    for (const glow of this.galaxyGlows) ((glow as THREE.Mesh).material as THREE.Material).dispose();
    if (this.nebulaDust) { this.nebulaDust.geometry.dispose(); (this.nebulaDust.material as THREE.Material).dispose(); }
    // Dispose InstancedMesh cores + glows
    if (this.nodeCoresInstanced) { (this.nodeCoresInstanced.material as THREE.Material)?.dispose(); }
    if (this.nodeGlowsPoints) { (this.nodeGlowsPoints.material as THREE.Material)?.dispose(); this.nodeGlowsPoints.geometry?.dispose(); }
    if (this.nodeGlows2Points) { (this.nodeGlows2Points.material as THREE.Material)?.dispose(); this.nodeGlows2Points.geometry?.dispose(); }
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
