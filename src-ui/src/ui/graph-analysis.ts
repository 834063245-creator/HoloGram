// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// GraphAnalysis — 波及半径 + 路径查找
// 从 graph.ts 拆分，独立管理 blast/path 全流程
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { useShellStore } from '../app/shell-store';

// ── Types ────────────────────────────────────────────────────

interface GraphNode {
  id: string;
  name: string;
  type?: string;
  kind?: string;
  location?: string;
  properties?: Record<string, unknown>;
}
interface EdgeData {
  s: number;
  t: number;
  couplingDepth: number;
  edgeType: string;
  direction: string;
  crossFile: boolean;
  ambiguous: boolean;
}

// ── AnalysisHost — GraphAnalysis 需要从 StarGraph 访问的成员 ──

export interface AnalysisHost {
  // 图数据
  graphNodes: GraphNode[];
  nodePositions: Float32Array;
  edgeDataList: EdgeData[];
  _nodeCount: number;
  edgeIndexOf: number[][];
  neighborMap: number[][];

  // GPU 缓冲控制
  _overrideFlags: Float32Array;
  _glow2Rgba: Float32Array;
  _setGlowAlpha(i: number, a: number): void;
  _setGlowColor(i: number, c: number | THREE.Color): void;
  _setCoreColor(i: number, c: number | THREE.Color): void;
  _setCoreVisible(i: number, v: boolean): void;
  _setCoreScale(i: number, s: number): void;
  _setGlowRgba(i: number, r: number, g: number, b: number, a: number): void;
  _setGlow2Rgba(i: number, r: number, g: number, b: number, a: number): void;
  getNodeBaseScale(i: number): number;
  _flushOverrideAttrs(): void;

  // 场景
  highlightEdgeGroup: THREE.Group;
  edgeLineGroups: LineSegments2[];

  // 颜色缓存
  nodeGlowColors: number[];
  nodeCoreColors: number[];

  // 联动
  focusSubgraphActive: boolean;
  exitFocusSubgraph(): void;

  // 工具
  _hitNode(e: PointerEvent | MouseEvent): number;
  _findNodeIndexByName(query: string): number;
}

// ═══════════════════════════════════════════════════════════════
// GraphAnalysis
// ═══════════════════════════════════════════════════════════════

export class GraphAnalysis {
  // Blast 字段
  blastMode = false;
  blastSource = -1;
  blastDistances: number[] = [];
  blastMaxDist = 3;
  blastEdgeType: string = 'all';
  blastDirection: string = 'both';

  constructor(private host: AnalysisHost) {}

  // ═══════════════════════════════════════════════════════════
  // Blast radius
  // ═══════════════════════════════════════════════════════════

  startBlastMode(idx: number): void {
    if (this.host.focusSubgraphActive) this.host.exitFocusSubgraph();
    this.blastMode = true;
    this.blastSource = idx;
    this.computeBlastDistances();
    this.buildBlastEdges();
    const inRadius = this.blastDistances.filter((d) => d >= 0).length;
    useShellStore.getState().setStatusText(`波及: ${this.host.graphNodes[idx]?.name || '?'}  ·  ${inRadius} 节点  ·  B/ESC 退出`);
  }

  computeBlastDistances(): void {
    const n = this.host._nodeCount;
    this.blastDistances = new Array(n).fill(-1);
    if (this.blastSource < 0) return;
    this.blastDistances[this.blastSource] = 0;
    const queue = [this.blastSource];
    while (queue.length > 0) {
      const u = queue.shift()!,
        du = this.blastDistances[u];
      if (du >= this.blastMaxDist) continue;
      for (const v of this.host.neighborMap[u] || []) {
        if (this.blastDistances[v] === -1) {
          const passesFilter = this.host.edgeIndexOf[u].some((ei) => {
            const d = this.host.edgeDataList[ei];
            if ((d.s !== u || d.t !== v) && (d.s !== v || d.t !== u)) return false;
            if (this.blastEdgeType !== 'all' && d.edgeType !== this.blastEdgeType) return false;
            if (this.blastDirection === 'outbound' && d.s !== u) return false;
            if (this.blastDirection === 'inbound' && d.t !== u) return false;
            return true;
          });
          if (passesFilter) {
            this.blastDistances[v] = du + 1;
            queue.push(v);
          }
        }
      }
    }
  }

  buildBlastEdges(): void {
    while (this.host.highlightEdgeGroup.children.length)
      this.host.highlightEdgeGroup.remove(this.host.highlightEdgeGroup.children[0]);
    if (!this.blastMode) return;
    const pos = this.host.nodePositions,
      verts: number[] = [],
      colors: number[] = [];
    for (const d of this.host.edgeDataList) {
      const ds = this.blastDistances[d.s],
        dt = this.blastDistances[d.t];
      if (ds < 0 || dt < 0) continue;
      if (this.blastEdgeType !== 'all' && d.edgeType !== this.blastEdgeType) continue;
      if (this.blastDirection === 'outbound' && d.s !== this.blastSource && ds > dt) continue;
      if (this.blastDirection === 'inbound' && d.t !== this.blastSource && dt > ds) continue;
      verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
      const minD = Math.min(ds, dt);
      const c =
        minD === 0
          ? new THREE.Color(0xffffff)
          : minD === 1
            ? new THREE.Color(0xff6644)
            : minD <= 3
              ? new THREE.Color(0xffaa44)
              : new THREE.Color(0xffdd88);
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    if (verts.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.host.highlightEdgeGroup.add(
      new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.6,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      ),
    );
  }

  exitBlastMode(): void {
    this.blastMode = false;
    this.blastSource = -1;
    this.blastDistances = [];
    while (this.host.highlightEdgeGroup.children.length)
      this.host.highlightEdgeGroup.remove(this.host.highlightEdgeGroup.children[0]);
    const ncLen = this.host.nodeCoreColors.length;
    const ngLen = this.host.nodeGlowColors.length;
    for (let i = 0; i < this.host._nodeCount; i++) {
      this.host._overrideFlags[i] = 0;
      if (i < ncLen) {
        this.host._setCoreColor(i, this.host.nodeCoreColors[i]);
      }
      const base = this.host.getNodeBaseScale(i);
      this.host._setCoreScale(i, base * 0.35);
    }
    for (let i = 0; i < this.host._nodeCount; i++) {
      if (i < ngLen && this.host.nodeGlowColors[i] != null) {
        const gc = new THREE.Color(this.host.nodeGlowColors[i]);
        this.host._setGlowRgba(i, gc.r, gc.g, gc.b, 0.85);
        if (this.host._glow2Rgba.length > 0) this.host._setGlow2Rgba(i, gc.r, gc.g, gc.b, 0.55);
      }
    }
    this.host._flushOverrideAttrs();
    if (useShellStore.getState().statusText.includes('波及')) useShellStore.getState().setStatusText('就绪');
  }

  updateBlastNodeColors(): void {
    if (!this.blastMode) return;
    for (let i = 0; i < this.host._nodeCount; i++) {
      const d = this.blastDistances[i];
      if (d >= 0) {
        this.host._overrideFlags[i] = 1;
        const c = new THREE.Color();
        if (d === 0) c.set(0xffffff);
        else if (d === 1) c.set(0xff4422);
        else if (d === 2) c.set(0xff8800);
        else if (d === 3) c.set(0xffcc00);
        else c.setHSL(0.55 - (d / this.blastMaxDist) * 0.3, 0.6, 0.4 + (1 - d / this.blastMaxDist) * 0.3);
        this.host._setGlowColor(i, c);
        this.host._setGlowAlpha(i, 0.7);
        this.host._setCoreColor(i, c);
        const base = this.host.getNodeBaseScale(i);
        this.host._setCoreScale(i, base * (d === 0 ? 2 : 1));
      } else {
        this.host._overrideFlags[i] = 1;
        this.host._setGlowAlpha(i, 0.12);
      }
    }
    this.host._flushOverrideAttrs();
  }
}
