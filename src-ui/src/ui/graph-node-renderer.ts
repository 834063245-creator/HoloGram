// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// GraphNodeRenderer — 节点批渲染（1 InstancedMesh + 2 Points）
// 从 graph.ts 拆分（P4）：core/glow GPU 缓冲写入、buildNodes、
// 增量更新的缓冲扩容/追加/同步。状态字段仍由 facade 持有。
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { GLOW_COLORS, NODE_COLORS } from './graph-colors';
import { makeCoreFresnelMaterial, makeGlowPointMaterial } from './graph-shaders';
import type { CommunityData, GraphJSON, GraphNode } from './graph-types';

// ── NodeRendererHost — GraphNodeRenderer 需要从 StarGraph 访问的成员 ──

export interface NodeRendererHost {
  // 场景对象
  nodeGroup: THREE.Group;
  sphereGeo: THREE.SphereGeometry;
  glowTex: THREE.Texture;
  nodeCoresInstanced: THREE.InstancedMesh;
  nodeGlowsPoints: THREE.Points;
  nodeGlows2Points: THREE.Points;

  // CPU 侧缓冲
  _coreScales: Float32Array;
  _glowRgba: Float32Array;
  _glow2Rgba: Float32Array;
  _glowSizes: Float32Array;
  _glow2Sizes: Float32Array;
  _nodeMagCache: Float32Array;
  _overrideFlags: Float32Array;
  _nodeCount: number;
  _nodeCapacity: number;
  _deadIndices: Set<number>;
  nodeGlowColors: number[];
  nodeCoreColors: number[];
  _nodeBaseHSL: Array<{ h: number; s: number; l: number }>;

  // 图数据
  graphNodes: GraphNode[];
  nodePositions: Float32Array;
  deg: number[];
  l34Count: number[];
  maxDeg: number;
  scaleMode: 'degree' | 'coupling';
  nodeCommMap: Map<number, string>;
  _graphRadius: number;
}

// ═══════════════════════════════════════════════════════════════
// GraphNodeRenderer
// ═══════════════════════════════════════════════════════════════

export class GraphNodeRenderer {
  constructor(private host: NodeRendererHost) {}

  // ── Node scale mode ──────────────────────────────────────

  getNodeBaseScale(i: number): number {
    const val = this.host.scaleMode === 'degree' ? this.host.deg[i] : this.host.l34Count[i] || 0;
    const maxVal = this.host.scaleMode === 'degree' ? this.host.maxDeg : Math.max(1, ...this.host.l34Count);
    const sizeMul = Math.max(1, this.host._graphRadius / 400);
    return (0.6 + (val / maxVal) * 2.8) * sizeMul;
  }

  // ── Batched GPU helpers (ponytail: write to InstancedMesh/Points buffers) ──

  _setCoreColor(i: number, c: number | THREE.Color): void {
    if (!this.host.nodeCoresInstanced || i >= this.host._nodeCount) return;
    if (c == null || (typeof c === 'number' && !Number.isFinite(c))) return; // ponytail: reject NaN/undefined → would render black
    const cc = c instanceof THREE.Color ? c : new THREE.Color(c);
    this.host.nodeCoresInstanced.setColorAt(i, cc);
    if (this.host.nodeCoresInstanced.instanceColor) this.host.nodeCoresInstanced.instanceColor.needsUpdate = true;
  }

  _setCoreScale(i: number, s: number): void {
    if (!this.host.nodeCoresInstanced || i >= this.host._nodeCount) return;
    this.host._coreScales[i] = s;
    const m = new THREE.Matrix4();
    this.host.nodeCoresInstanced.getMatrixAt(i, m);
    const p = new THREE.Vector3();
    m.decompose(p, new THREE.Quaternion(), new THREE.Vector3());
    m.compose(p, new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    this.host.nodeCoresInstanced.setMatrixAt(i, m);
    this.host.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
  }

  _setCoreVisible(i: number, v: boolean): void {
    this._setCoreScale(i, v ? this.host._coreScales[i] || this._getCoreBaseScale(i) : 0);
  }

  _getCoreBaseScale(i: number): number {
    return this.getNodeBaseScale(i) * 0.35;
  }

  _setGlowRgba(i: number, r: number, g: number, b: number, a: number): void {
    if (!this.host.nodeGlowsPoints || i >= this.host._nodeCount) return;
    this.host._glowRgba[i * 4] = r;
    this.host._glowRgba[i * 4 + 1] = g;
    this.host._glowRgba[i * 4 + 2] = b;
    this.host._glowRgba[i * 4 + 3] = a;
    this.host.nodeGlowsPoints.geometry.attributes.color.needsUpdate = true;
  }

  _setGlowColor(i: number, c: THREE.Color | number, a?: number): void {
    const cc = c instanceof THREE.Color ? c : new THREE.Color(c);
    this._setGlowRgba(i, cc.r, cc.g, cc.b, a ?? this.host._glowRgba[i * 4 + 3]);
  }

  _setGlowAlpha(i: number, a: number): void {
    if (i < this.host._nodeCount) {
      this.host._glowRgba[i * 4 + 3] = a;
      if (this.host.nodeGlowsPoints) this.host.nodeGlowsPoints.geometry.attributes.color.needsUpdate = true;
    }
  }

  _setGlow2Rgba(i: number, r: number, g: number, b: number, a: number): void {
    if (!this.host.nodeGlows2Points || i >= this.host._nodeCount) return;
    this.host._glow2Rgba[i * 4] = r;
    this.host._glow2Rgba[i * 4 + 1] = g;
    this.host._glow2Rgba[i * 4 + 2] = b;
    this.host._glow2Rgba[i * 4 + 3] = a;
    this.host.nodeGlows2Points.geometry.attributes.color.needsUpdate = true;
  }

  _setGlow2Alpha(i: number, a: number): void {
    if (i < this.host._nodeCount && this.host._glow2Rgba.length > 0) {
      this.host._glow2Rgba[i * 4 + 3] = a;
      if (this.host.nodeGlows2Points) this.host.nodeGlows2Points.geometry.attributes.color.needsUpdate = true;
    }
  }

  _flushBatch(): void {
    if (this.host.nodeCoresInstanced) {
      this.host.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
      if (this.host.nodeCoresInstanced.instanceColor) this.host.nodeCoresInstanced.instanceColor.needsUpdate = true;
    }
    if (this.host.nodeGlowsPoints?.geometry.attributes.color) {
      this.host.nodeGlowsPoints.geometry.attributes.color.needsUpdate = true;
    }
    if (this.host.nodeGlowsPoints?.geometry.attributes.size) {
      this.host.nodeGlowsPoints.geometry.attributes.size.needsUpdate = true;
    }
    if (this.host.nodeGlows2Points?.geometry.attributes.color) {
      this.host.nodeGlows2Points.geometry.attributes.color.needsUpdate = true;
    }
    if (this.host.nodeGlows2Points?.geometry.attributes.size) {
      this.host.nodeGlows2Points.geometry.attributes.size.needsUpdate = true;
    }
  }

  /** Magnitude factor 0.15–1.0: hub nodes shine bright, leaf nodes barely visible. Pre-computed cache. */
  _nodeMag(i: number): number {
    return this.host._nodeMagCache[i] ?? 0.15;
  }

  _flushOverrideAttrs(): void {
    if (this.host.nodeGlowsPoints?.geometry.attributes.override) {
      this.host.nodeGlowsPoints.geometry.attributes.override.needsUpdate = true;
    }
    if (this.host.nodeGlows2Points?.geometry.attributes.override) {
      this.host.nodeGlows2Points.geometry.attributes.override.needsUpdate = true;
    }
  }

  // ── Nodes ────────────────────────────────────────────────

  buildNodes(nodes: GraphNode[], pos: Float32Array, deg: number[]): void {
    const N = nodes.length;
    const isFull = true;

    // Glow Points geometry buffers (RGBA color + per-point size)
    const glowPosArr = new Float32Array(N * 3);
    const glow2PosArr = isFull ? new Float32Array(N * 3) : new Float32Array(0);
    this.host._glowSizes = new Float32Array(N);
    this.host._glow2Sizes = isFull ? new Float32Array(N) : new Float32Array(0);

    // ponytail: GPU-driven shader attributes — static, uploaded once
    const phaseArr = new Float32Array(N);
    const speedArr = new Float32Array(N);
    const magArr = new Float32Array(N);
    const riskArr = new Float32Array(N);
    const hslArr = new Float32Array(N * 3);
    this.host._overrideFlags = new Float32Array(N); // 0=shader animated, 1=CPU overridden
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
      const baseScale = this.getNodeBaseScale(i);
      const px = pos[i * 3],
        py = pos[i * 3 + 1],
        pz = pos[i * 3 + 2];

      // Core InstancedMesh: position + scale in matrix, color in instanceColor
      this.host._coreScales[i] = baseScale * 0.35;
      this.host.nodeCoresInstanced.setMatrixAt(
        i,
        _m.compose(_v.set(px, py, pz), _q, new THREE.Vector3(1, 1, 1).multiplyScalar(this.host._coreScales[i])),
      );
      this._setCoreColor(i, coreColor);
      this.host.nodeCoreColors[i] = coreColor;

      // Inner glow RGBA
      const gc = new THREE.Color(glowColor);
      glowPosArr[i * 3] = px;
      glowPosArr[i * 3 + 1] = py;
      glowPosArr[i * 3 + 2] = pz;
      this.host._glowRgba[i * 4] = gc.r;
      this.host._glowRgba[i * 4 + 1] = gc.g;
      this.host._glowRgba[i * 4 + 2] = gc.b;
      this.host._glowRgba[i * 4 + 3] = 0.85;
      this.host.nodeGlowColors[i] = glowColor;

      // HSL cache for twinkle
      this.host._nodeBaseHSL[i] = { h: 0, s: 0, l: 0 };
      gc.getHSL(this.host._nodeBaseHSL[i]);
      // GPU shader attributes (static, uploaded once)
      hslArr[i * 3] = this.host._nodeBaseHSL[i].h;
      hslArr[i * 3 + 1] = this.host._nodeBaseHSL[i].s;
      hslArr[i * 3 + 2] = this.host._nodeBaseHSL[i].l;

      // Outer glow RGBA + size
      if (isFull) {
        glow2PosArr[i * 3] = px;
        glow2PosArr[i * 3 + 1] = py;
        glow2PosArr[i * 3 + 2] = pz;
        this.host._glow2Rgba[i * 4] = gc.r;
        this.host._glow2Rgba[i * 4 + 1] = gc.g;
        this.host._glow2Rgba[i * 4 + 2] = gc.b;
        this.host._glow2Rgba[i * 4 + 3] = 0.55;
        this.host._glow2Sizes[i] = this.host._coreScales[i] * 2.4; // outer glow tied to core scale
      }
      this.host._glowSizes[i] = this.host._coreScales[i] * 3.0; // inner glow tied to core scale
    }

    // Pre-compute _nodeMag cache (ponytail: log1p ratio is static, avoid per-frame recalc)
    this.host._nodeMagCache = new Float32Array(N);
    const logMax = Math.log1p(this.host.maxDeg);
    for (let i = 0; i < N; i++) {
      this.host._nodeMagCache[i] = 0.15 + 0.85 * (Math.log1p(this.host.deg[i]) / logMax);
      magArr[i] = this.host._nodeMagCache[i];
      riskArr[i] = this.host.l34Count[i] || 0;
    }

    // Upload + create Points objects
    this.host.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
    if (this.host.nodeCoresInstanced.instanceColor) this.host.nodeCoresInstanced.instanceColor.needsUpdate = true;

    // ── Shared shader attribute helper ──
    const addAnimAttrs = (geo: THREE.BufferGeometry) => {
      geo.setAttribute('phase', new THREE.BufferAttribute(phaseArr, 1));
      geo.setAttribute('speed', new THREE.BufferAttribute(speedArr, 1));
      geo.setAttribute('mag', new THREE.BufferAttribute(magArr, 1));
      geo.setAttribute('risk', new THREE.BufferAttribute(riskArr, 1));
      geo.setAttribute('baseHSL', new THREE.BufferAttribute(hslArr, 3));
      geo.setAttribute('override', new THREE.BufferAttribute(this.host._overrideFlags, 1));
    };

    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', new THREE.BufferAttribute(glowPosArr, 3));
    glowGeo.setAttribute('color', new THREE.BufferAttribute(this.host._glowRgba, 4));
    glowGeo.setAttribute('size', new THREE.BufferAttribute(this.host._glowSizes, 1));
    addAnimAttrs(glowGeo);
    this.host.nodeGlowsPoints = new THREE.Points(glowGeo, makeGlowPointMaterial(this.host.glowTex, 1.5, 1.0));
    this.host.nodeGlowsPoints.frustumCulled = false;
    this.host.nodeGlowsPoints.renderOrder = 1;
    this.host.nodeGroup.add(this.host.nodeGlowsPoints);

    if (isFull) {
      const g2Geo = new THREE.BufferGeometry();
      g2Geo.setAttribute('position', new THREE.BufferAttribute(glow2PosArr, 3));
      g2Geo.setAttribute('color', new THREE.BufferAttribute(this.host._glow2Rgba, 4));
      g2Geo.setAttribute('size', new THREE.BufferAttribute(this.host._glow2Sizes, 1));
      addAnimAttrs(g2Geo);
      this.host.nodeGlows2Points = new THREE.Points(g2Geo, makeGlowPointMaterial(this.host.glowTex, 0.55, 0.85));
      this.host.nodeGlows2Points.frustumCulled = false;
      this.host.nodeGlows2Points.renderOrder = 1;
      this.host.nodeGroup.add(this.host.nodeGlows2Points);
    }
  }

  // ── Incremental update: buffer management ───────────────

  /** Mark a node as dead: invisible but kept in graphNodes for index stability. */
  _markNodeDead(idx: number): void {
    this.host._deadIndices.add(idx);
    this.host._overrideFlags[idx] = 1;
    this._setCoreVisible(idx, false);
    this._setGlowAlpha(idx, 0);
    if (this.host._glow2Rgba.length > 0) this._setGlow2Alpha(idx, 0);
  }

  /** Rebuild InstancedMesh + Points with larger capacity, copying old data. */
  _rebuildNodeBuffers(newCapacity: number): void {
    const oldCount = this.host._nodeCount;
    const extendF32 = (old: Float32Array, mul: number) => {
      const n = new Float32Array(newCapacity * mul);
      n.set(old);
      return n;
    };
    this.host._coreScales = extendF32(this.host._coreScales, 1);
    this.host._glowRgba = extendF32(this.host._glowRgba, 4);
    this.host._glow2Rgba = extendF32(this.host._glow2Rgba, 4);
    this.host._glowSizes = extendF32(this.host._glowSizes, 1);
    this.host._glow2Sizes = extendF32(this.host._glow2Sizes, 1);
    this.host._overrideFlags = extendF32(this.host._overrideFlags, 1);
    this.host._nodeMagCache = extendF32(this.host._nodeMagCache, 1);
    const newPos = new Float32Array(newCapacity * 3);
    newPos.set(this.host.nodePositions);
    this.host.nodePositions = newPos;
    const newHSL: Array<{ h: number; s: number; l: number }> = new Array(newCapacity);
    for (let i = 0; i < oldCount; i++) newHSL[i] = this.host._nodeBaseHSL[i];
    this.host._nodeBaseHSL = newHSL;
    while (this.host.deg.length < newCapacity) this.host.deg.push(0);

    // --- InstancedMesh ---
    const oldInst = this.host.nodeCoresInstanced;
    const newInst = new THREE.InstancedMesh(
      this.host.sphereGeo,
      makeCoreFresnelMaterial(this.host.glowTex),
      newCapacity,
    );
    newInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    newInst.count = oldCount;
    newInst.frustumCulled = false;
    const _m = new THREE.Matrix4();
    const _c = new THREE.Color();
    for (let i = 0; i < oldCount; i++) {
      oldInst.getMatrixAt(i, _m);
      newInst.setMatrixAt(i, _m);
      if (oldInst.instanceColor) {
        oldInst.getColorAt(i, _c);
        newInst.setColorAt(i, _c);
      }
    }
    newInst.instanceMatrix.needsUpdate = true;
    if (newInst.instanceColor) newInst.instanceColor.needsUpdate = true;
    (oldInst.material as THREE.Material)?.dispose();
    this.host.nodeGroup.remove(oldInst);
    this.host.nodeGroup.add(newInst);
    this.host.nodeCoresInstanced = newInst;

    // --- Points geometries ---
    const oldGlowGeo = this.host.nodeGlowsPoints.geometry;
    const phaseArr = new Float32Array(newCapacity);
    const speedArr = new Float32Array(newCapacity);
    const magArr = new Float32Array(newCapacity);
    const riskArr = new Float32Array(newCapacity);
    const hslArr = new Float32Array(newCapacity * 3);
    phaseArr.set(oldGlowGeo.attributes.phase.array as Float32Array);
    speedArr.set(oldGlowGeo.attributes.speed.array as Float32Array);
    magArr.set(oldGlowGeo.attributes.mag.array as Float32Array);
    riskArr.set(oldGlowGeo.attributes.risk.array as Float32Array);
    hslArr.set(oldGlowGeo.attributes.baseHSL.array as Float32Array);
    const glowPosArr = new Float32Array(newCapacity * 3);
    glowPosArr.set(oldGlowGeo.attributes.position.array as Float32Array);
    const glow2PosArr = new Float32Array(newCapacity * 3);
    if (this.host.nodeGlows2Points)
      glow2PosArr.set(this.host.nodeGlows2Points.geometry.attributes.position.array as Float32Array);

    const addAnimAttrs = (geo: THREE.BufferGeometry) => {
      geo.setAttribute('phase', new THREE.BufferAttribute(phaseArr, 1));
      geo.setAttribute('speed', new THREE.BufferAttribute(speedArr, 1));
      geo.setAttribute('mag', new THREE.BufferAttribute(magArr, 1));
      geo.setAttribute('risk', new THREE.BufferAttribute(riskArr, 1));
      geo.setAttribute('baseHSL', new THREE.BufferAttribute(hslArr, 3));
      geo.setAttribute('override', new THREE.BufferAttribute(this.host._overrideFlags, 1));
    };

    (this.host.nodeGlowsPoints.material as THREE.Material)?.dispose();
    oldGlowGeo.dispose();
    this.host.nodeGroup.remove(this.host.nodeGlowsPoints);
    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', new THREE.BufferAttribute(glowPosArr, 3));
    glowGeo.setAttribute('color', new THREE.BufferAttribute(this.host._glowRgba, 4));
    glowGeo.setAttribute('size', new THREE.BufferAttribute(this.host._glowSizes, 1));
    addAnimAttrs(glowGeo);
    this.host.nodeGlowsPoints = new THREE.Points(glowGeo, makeGlowPointMaterial(this.host.glowTex, 1.5, 1.0));
    this.host.nodeGlowsPoints.frustumCulled = false;
    this.host.nodeGlowsPoints.renderOrder = 1;
    this.host.nodeGroup.add(this.host.nodeGlowsPoints);

    if (this.host.nodeGlows2Points) {
      (this.host.nodeGlows2Points.material as THREE.Material)?.dispose();
      this.host.nodeGlows2Points.geometry.dispose();
      this.host.nodeGroup.remove(this.host.nodeGlows2Points);
      const g2Geo = new THREE.BufferGeometry();
      g2Geo.setAttribute('position', new THREE.BufferAttribute(glow2PosArr, 3));
      g2Geo.setAttribute('color', new THREE.BufferAttribute(this.host._glow2Rgba, 4));
      g2Geo.setAttribute('size', new THREE.BufferAttribute(this.host._glow2Sizes, 1));
      addAnimAttrs(g2Geo);
      this.host.nodeGlows2Points = new THREE.Points(g2Geo, makeGlowPointMaterial(this.host.glowTex, 0.55, 0.85));
      this.host.nodeGlows2Points.frustumCulled = false;
      this.host.nodeGlows2Points.renderOrder = 1;
      this.host.nodeGroup.add(this.host.nodeGlows2Points);
    }

    this.host._nodeCapacity = newCapacity;
  }

  /** Append new nodes to existing buffers (capacity must be sufficient). */
  _appendNodes(nodes: GraphNode[], fullGraph: GraphJSON, nodeIdxMap: Map<string, number>): void {
    // ponytail: 只取 level0 社区 — 与 _renderImpl 的 nodeCommMap 层级一致
    const allComms = ((fullGraph as any).hierarchical_communities ||
      (fullGraph as any).communities ||
      []) as CommunityData[];
    const comms = allComms.filter((c) => !c.level || c.level === 0);
    const nodeComm = new Map<string, string>();
    for (const c of comms) for (const nid of c.node_ids) nodeComm.set(nid, c.id);

    // Community centroids from existing alive nodes
    const centroids = new Map<string, { x: number; y: number; z: number; n: number }>();
    for (let i = 0; i < this.host._nodeCount; i++) {
      if (this.host._deadIndices.has(i)) continue;
      const cid = this.host.nodeCommMap.get(i);
      if (!cid) continue;
      let c = centroids.get(cid);
      if (!c) {
        c = { x: 0, y: 0, z: 0, n: 0 };
        centroids.set(cid, c);
      }
      c.x += this.host.nodePositions[i * 3];
      c.y += this.host.nodePositions[i * 3 + 1];
      c.z += this.host.nodePositions[i * 3 + 2];
      c.n++;
    }
    for (const c of centroids.values()) {
      c.x /= c.n;
      c.y /= c.n;
      c.z /= c.n;
    }

    // Graph center fallback
    let bcx = 0,
      bcy = 0,
      bcz = 0,
      bn = 0;
    for (let i = 0; i < this.host._nodeCount; i++) {
      if (this.host._deadIndices.has(i)) continue;
      bcx += this.host.nodePositions[i * 3];
      bcy += this.host.nodePositions[i * 3 + 1];
      bcz += this.host.nodePositions[i * 3 + 2];
      bn++;
    }
    if (bn > 0) {
      bcx /= bn;
      bcy /= bn;
      bcz /= bn;
    }

    const _m = new THREE.Matrix4();
    const _v = new THREE.Vector3();
    const _q = new THREE.Quaternion();

    for (const node of nodes) {
      const i = this.host._nodeCount;
      const cid = nodeComm.get(node.id);
      const ct = cid ? centroids.get(cid) : null;
      const jitter = ct ? 15 : 40;
      const px = (ct ? ct.x : bcx) + (Math.random() - 0.5) * jitter;
      const py = (ct ? ct.y : bcy) + (Math.random() - 0.5) * jitter;
      const pz = (ct ? ct.z : bcz) + (Math.random() - 0.5) * jitter;

      this.host.nodePositions[i * 3] = px;
      this.host.nodePositions[i * 3 + 1] = py;
      this.host.nodePositions[i * 3 + 2] = pz;
      this.host.graphNodes[i] = node;

      const kind = ((node.type || node.kind || 'symbol') as string).toLowerCase();
      const glowColor = GLOW_COLORS[kind] || 0x4488cc;
      const coreColor = NODE_COLORS[kind] || 0x6ab0ff;
      const gc = new THREE.Color(glowColor);
      const hsl = { h: 0, s: 0, l: 0 };
      gc.getHSL(hsl);

      // Core
      this.host._coreScales[i] = 0.8 * 0.35;
      this.host.nodeCoresInstanced.setMatrixAt(
        i,
        _m.compose(
          _v.set(px, py, pz),
          _q,
          new THREE.Vector3(this.host._coreScales[i], this.host._coreScales[i], this.host._coreScales[i]),
        ),
      );
      this._setCoreColor(i, coreColor);
      this.host.nodeCoreColors[i] = coreColor;
      this.host.nodeGlowColors[i] = glowColor;
      this.host._nodeBaseHSL[i] = hsl;

      // Glow points (position+color+size are per-geometry; phase/speed/mag/risk/baseHSL/override are shared)
      const gAttr = this.host.nodeGlowsPoints.geometry.attributes;
      (gAttr.position.array as Float32Array)[i * 3] = px;
      (gAttr.position.array as Float32Array)[i * 3 + 1] = py;
      (gAttr.position.array as Float32Array)[i * 3 + 2] = pz;
      this.host._glowRgba[i * 4] = gc.r;
      this.host._glowRgba[i * 4 + 1] = gc.g;
      this.host._glowRgba[i * 4 + 2] = gc.b;
      this.host._glowRgba[i * 4 + 3] = 0.85;
      this.host._glowSizes[i] = this.host._coreScales[i] * 3.0; // 辉光始终基于核心球大小
      // Shared anim attrs (write once — both geometries share the same arrays)
      (gAttr.phase.array as Float32Array)[i] = Math.random() * Math.PI * 2;
      (gAttr.speed.array as Float32Array)[i] = 0.5 + Math.random() * 2.5;
      (gAttr.mag.array as Float32Array)[i] = 0.15;
      (gAttr.risk.array as Float32Array)[i] = 0;
      (gAttr.baseHSL.array as Float32Array)[i * 3] = hsl.h;
      (gAttr.baseHSL.array as Float32Array)[i * 3 + 1] = hsl.s;
      (gAttr.baseHSL.array as Float32Array)[i * 3 + 2] = hsl.l;
      this.host._overrideFlags[i] = 0;

      // Outer glow (separate position/color/size)
      if (this.host.nodeGlows2Points) {
        const g2Attr = this.host.nodeGlows2Points.geometry.attributes;
        (g2Attr.position.array as Float32Array)[i * 3] = px;
        (g2Attr.position.array as Float32Array)[i * 3 + 1] = py;
        (g2Attr.position.array as Float32Array)[i * 3 + 2] = pz;
        this.host._glow2Rgba[i * 4] = gc.r;
        this.host._glow2Rgba[i * 4 + 1] = gc.g;
        this.host._glow2Rgba[i * 4 + 2] = gc.b;
        this.host._glow2Rgba[i * 4 + 3] = 0.55;
        this.host._glow2Sizes[i] = this.host._coreScales[i] * 2.4; // 外层辉光始终基于核心球大小
      }

      if (cid) this.host.nodeCommMap.set(i, cid);
      nodeIdxMap.set(node.id, i);
      this.host._nodeCount++;
    }

    // Upload all
    this.host.nodeCoresInstanced.count = this.host._nodeCount;
    this.host.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
    if (this.host.nodeCoresInstanced.instanceColor) this.host.nodeCoresInstanced.instanceColor.needsUpdate = true;
    this.host.nodeCoresInstanced.boundingSphere = null;
    const markAll = (p: THREE.Points) => {
      const g = p.geometry;
      for (const k of Object.keys(g.attributes)) g.attributes[k].needsUpdate = true;
    };
    markAll(this.host.nodeGlowsPoints);
    if (this.host.nodeGlows2Points) markAll(this.host.nodeGlows2Points);
  }

  /**
   * Sync node positions from nodePositions to GPU buffers (glow Points).
   * Called after local layout relaxation updates positions.
   */
  _syncNodePositions(indices: number[]): void {
    const _m = new THREE.Matrix4();
    const _v = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const gAttr = this.host.nodeGlowsPoints?.geometry.attributes;
    const g2Attr = this.host.nodeGlows2Points?.geometry.attributes;
    for (const i of indices) {
      if (i >= this.host._nodeCount) continue;
      const px = this.host.nodePositions[i * 3],
        py = this.host.nodePositions[i * 3 + 1],
        pz = this.host.nodePositions[i * 3 + 2];
      // Core matrix
      const s = this.host._coreScales[i] || 0.28;
      this.host.nodeCoresInstanced.setMatrixAt(i, _m.compose(_v.set(px, py, pz), _q, new THREE.Vector3(s, s, s)));
      // Glow point positions
      if (gAttr) {
        (gAttr.position.array as Float32Array)[i * 3] = px;
        (gAttr.position.array as Float32Array)[i * 3 + 1] = py;
        (gAttr.position.array as Float32Array)[i * 3 + 2] = pz;
      }
      if (g2Attr) {
        (g2Attr.position.array as Float32Array)[i * 3] = px;
        (g2Attr.position.array as Float32Array)[i * 3 + 1] = py;
        (g2Attr.position.array as Float32Array)[i * 3 + 2] = pz;
      }
    }
    this.host.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
    if (gAttr) gAttr.position.needsUpdate = true;
    if (g2Attr) g2Attr.position.needsUpdate = true;
  }

  /** Sync all core matrices — call after incremental update to flush positions. */
  _syncNodeCoreMatrices(): void {
    const _m = new THREE.Matrix4();
    const _v = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    for (let i = 0; i < this.host._nodeCount; i++) {
      if (this.host._deadIndices.has(i)) continue;
      const s = this.host._coreScales[i] || 0.28;
      this.host.nodeCoresInstanced.setMatrixAt(
        i,
        _m.compose(
          _v.set(
            this.host.nodePositions[i * 3],
            this.host.nodePositions[i * 3 + 1],
            this.host.nodePositions[i * 3 + 2],
          ),
          _q,
          new THREE.Vector3(s, s, s),
        ),
      );
    }
    this.host.nodeCoresInstanced.count = this.host._nodeCount;
    this.host.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
    this.host.nodeCoresInstanced.boundingSphere = null;
  }
}
