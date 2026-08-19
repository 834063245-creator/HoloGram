// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import * as THREE from 'three';

// ── Glow Textures ─────────────────────────────────────────────
// Canvas-generated radial gradient textures for GPU point sprites.

export function createGlowTexture(): THREE.Texture {
  const size = 128,
    c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const h = size / 2;
  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.02, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.08, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.18)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.03)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.004)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

export function createSpikeTexture(): THREE.Texture {
  const size = 256,
    c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const cx = size / 2,
    cy = size / 2;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.03, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.1, 'rgba(255,255,255,0.5)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.15)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.02)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3,
      sx = Math.cos(a),
      sy = Math.sin(a);
    const w = ctx.createLinearGradient(cx, cy, cx + sx * size * 0.45, cy + sy * size * 0.45);
    w.addColorStop(0, 'rgba(255,255,255,0.7)');
    w.addColorStop(0.15, 'rgba(255,240,220,0.4)');
    w.addColorStop(0.5, 'rgba(255,200,150,0.08)');
    w.addColorStop(1, 'transparent');
    ctx.fillStyle = w;
    ctx.beginPath();
    ctx.moveTo(cx + sx * 3, cy + sy * 3);
    ctx.lineTo(cx + sx * size * 0.48, cy + sy * size * 0.48);
    ctx.lineTo(cx - sy * 1.5, cy + sx * 1.5);
    ctx.lineTo(cx + sy * 1.5, cy - sx * 1.5);
    ctx.fill();
    const cg = ctx.createLinearGradient(cx, cy, cx - sx * size * 0.35, cy - sy * size * 0.35);
    cg.addColorStop(0, 'rgba(255,255,255,0.5)');
    cg.addColorStop(0.15, 'rgba(200,220,255,0.3)');
    cg.addColorStop(0.5, 'rgba(150,180,255,0.05)');
    cg.addColorStop(1, 'transparent');
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.moveTo(cx - sx * 3, cy - sy * 3);
    ctx.lineTo(cx - sx * size * 0.38, cy - sy * size * 0.38);
    ctx.lineTo(cx + sy * 1.2, cy - sx * 1.2);
    ctx.lineTo(cx - sy * 1.2, cy + sx * 1.2);
    ctx.fill();
  }
  return new THREE.CanvasTexture(c);
}
