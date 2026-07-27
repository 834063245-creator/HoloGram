// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import * as THREE from 'three';

// ── Color Palette ────────────────────────────────────────────
// ponytail: 8 代码符号色相均分(210/180/150/120/90/60/30/0°)，存储金系明度递减，时序紫系明度递减

export const NODE_COLORS: Record<string, number> = {
  symbol: 0x6ab0ff,
  SYMBOL: 0x6ab0ff,
  function: 0x4ad8c8,
  FUNCTION: 0x4ad8c8,
  method: 0x4ad8c8,
  METHOD: 0x4ad8c8,
  class: 0x7fd84a,
  CLASS: 0x7fd84a,
  module: 0xd8d84a,
  MODULE: 0xd8d84a,
  interface: 0xf0a850,
  INTERFACE: 0xf0a850,
  variable: 0xf07070,
  VARIABLE: 0xf07070,
  constant: 0xd850b0,
  CONSTANT: 0xd850b0,
  medium: 0xf0c060,
  MEDIUM: 0xf0c060,
  file: 0xf0c060,
  FILE: 0xf0c060,
  database: 0xe0a040,
  DATABASE: 0xe0a040,
  cache: 0xd09030,
  CACHE: 0xd09030,
  queue: 0xc08020,
  QUEUE: 0xc08020,
  temporal: 0xc098ff,
  TEMPORAL: 0xc098ff,
  thread: 0xc098ff,
  THREAD: 0xc098ff,
  timer: 0xa880ff,
  TIMER: 0xa880ff,
  trigger: 0x9068ff,
  TRIGGER: 0x9068ff,
};

export const GLOW_COLORS: Record<string, number> = {
  symbol: 0x2a6acc,
  SYMBOL: 0x2a6acc,
  function: 0x1a9888,
  FUNCTION: 0x1a9888,
  method: 0x1a9888,
  METHOD: 0x1a9888,
  class: 0x4a982a,
  CLASS: 0x4a982a,
  module: 0x98982a,
  MODULE: 0x98982a,
  interface: 0xc07028,
  INTERFACE: 0xc07028,
  variable: 0xc03838,
  VARIABLE: 0xc03838,
  constant: 0x983070,
  CONSTANT: 0x983070,
  medium: 0xcc8800,
  MEDIUM: 0xcc8800,
  file: 0xcc8800,
  FILE: 0xcc8800,
  database: 0xb07000,
  DATABASE: 0xb07000,
  cache: 0x905800,
  CACHE: 0x905800,
  queue: 0x704000,
  QUEUE: 0x704000,
  temporal: 0x7855cc,
  TEMPORAL: 0x7855cc,
  thread: 0x7855cc,
  THREAD: 0x7855cc,
  timer: 0x6040bb,
  TIMER: 0x6040bb,
  trigger: 0x4830aa,
  TRIGGER: 0x4830aa,
};

const _EDGE_COLORS: Record<string, number> = {
  calls: 0x4a9adf,
  imports: 0x4adfdf,
  defines: 0x4adf8a,
  inherits: 0xff66dd,
  reads: 0x66dd66,
  writes: 0xff5566,
  shares: 0xffaa44,
  triggers: 0xff8833,
  awaits: 0xc068ff,
  sequences: 0x8866ff,
  usage: 0x88aacc,
  throws: 0xff4466,
  data: 0xff5566,
  temporal: 0xff8833,
  structural: 0x4a9adf,
  /** Resolver couldn't uniquely resolve target — amber warning. */
  ambiguous: 0xf0a030,
};

export function edgeColorByType(edgeType: string, direction: string, crossFile = false, ambiguous = false): THREE.Color {
  if (ambiguous) return new THREE.Color(_EDGE_COLORS.ambiguous);
  const et = edgeType.toLowerCase();
  if (et === 'data') return new THREE.Color(direction === 'write' ? _EDGE_COLORS.writes : _EDGE_COLORS.reads);
  if (et === 'structural') return new THREE.Color(_EDGE_COLORS.calls);
  if (et === 'inherits' || (crossFile && direction === 'inherit')) return new THREE.Color(_EDGE_COLORS.inherits);
  const hex = _EDGE_COLORS[et] ?? _EDGE_COLORS.calls;
  return new THREE.Color(hex);
}

export function edgeOpacityByDepth(depth: number): number {
  const m = 0.02;
  switch (depth) {
    case 1:
      return 0.04 * m;
    case 2:
      return 0.11 * m;
    case 3:
      return 0.17 * m;
    case 4:
      return 0.22 * m;
    default:
      return 0.08 * m;
  }
}

export function edgeWidthByDepth(depth: number): number {
  switch (depth) {
    case 1:
      return 1.0;
    case 2:
      return 1.4;
    case 3:
      return 1.8;
    case 4:
      return 2.4;
    default:
      return 1.2;
  }
}

export function hexToCSS(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

export function communityColor(communityId: string): number {
  let hash = 0;
  for (let i = 0; i < communityId.length; i++) {
    hash = (hash << 5) - hash + communityId.charCodeAt(i);
    hash |= 0;
  }
  const hue = ((hash & 0x7fffffff) % 360) / 360;
  const color = new THREE.Color();
  color.setHSL(hue, 0.55, 0.52);
  return color.getHex();
}

export const BG_COLOR = 0x030812;

export const TYPE_LABELS: Record<string, string> = {
  symbol: 'SYM',
  function: 'FN',
  method: 'MTH',
  class: 'CLS',
  module: 'MOD',
  variable: 'VAR',
  constant: 'CST',
  interface: 'IFC',
  medium: 'MED',
  file: 'FILE',
  database: 'DB',
  cache: 'CACHE',
  queue: 'Q',
  temporal: 'TMP',
  thread: 'THR',
  timer: 'TIM',
  trigger: 'TRG',
};
