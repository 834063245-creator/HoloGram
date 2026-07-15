// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// GraphAnalysis — 波及半径 + 路径查找
// 从 graph.ts 拆分，独立管理 blast/path 全流程
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { edgeOpacityByDepth } from './graph-colors';
import { iconHtml } from './icons';

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
  edgeLineGroups: any[];

  // 颜色缓存
  nodeGlowColors: number[];
  nodeCoreColors: number[];

  // 联动
  focusSubgraphActive: boolean;
  exitFocusSubgraph(): void;

  // 工具
  _hitNode(e: PointerEvent | MouseEvent): number;
  _findNodeIndexByName(query: string): number;

  // DOM / 事件
  bus: any;
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

  // Path 字段
  _pathSource = -1;
  _pathTarget = -1;
  _pathNodes = new Set<number>();
  _pathEdges = new Set<number>();
  _shiftSourceIdx = -1;

  constructor(private host: AnalysisHost) {}

  // ═══════════════════════════════════════════════════════════
  // Path finding
  // ═══════════════════════════════════════════════════════════

  setPathSource(idx: number): void {
    if (this.host.focusSubgraphActive) this.host.exitFocusSubgraph();
    this._pathSource = idx;
    this._pathTarget = -1;
    this._pathNodes.clear();
    this._pathEdges.clear();
    this.highlightPathNodes();
    const st = document.getElementById('status-text');
    if (st)
      st.innerHTML = `${iconHtml('link', 11)} 路径起点: ${this.host.graphNodes[idx].name} · 右键目标节点选"路径"完成 · ESC 取消`;
  }

  setPathTarget(idx: number): void {
    this._pathTarget = idx;
    this.findShortestPath();
    const st = document.getElementById('status-text');
    const len = this._pathNodes.size;
    if (st)
      st.textContent =
        len > 0
          ? `${iconHtml('link', 11)} 路径: ${this.host.graphNodes[this._pathSource].name} → ${this.host.graphNodes[this._pathTarget].name} · ${len} 节点 · ESC 清除`
          : `${iconHtml('link', 11)} 未找到 ${this.host.graphNodes[this._pathSource].name} → ${this.host.graphNodes[this._pathTarget].name} 的路径`;
  }

  private findShortestPath(): void {
    this._pathNodes.clear();
    this._pathEdges.clear();
    const src = this._pathSource,
      dst = this._pathTarget;
    if (src < 0 || dst < 0) return;
    const n = this.host._nodeCount;
    const visited = new Array<boolean>(n).fill(false);
    const parent = new Array<number>(n).fill(-1);
    const parentEdge = new Array<number>(n).fill(-1);
    const queue = [src];
    visited[src] = true;
    let found = false;
    while (queue.length > 0 && !found) {
      const u = queue.shift()!;
      for (let ei = 0; ei < (this.host.edgeIndexOf[u]?.length || 0); ei++) {
        const edgeIdx = this.host.edgeIndexOf[u][ei];
        const d = this.host.edgeDataList[edgeIdx];
        const v = d.s === u ? d.t : d.s;
        if (!visited[v]) {
          visited[v] = true;
          parent[v] = u;
          parentEdge[v] = edgeIdx;
          queue.push(v);
          if (v === dst) {
            found = true;
            break;
          }
        }
      }
    }
    if (!found) return;
    let cur = dst;
    while (cur !== src) {
      this._pathNodes.add(cur);
      this._pathEdges.add(parentEdge[cur]);
      cur = parent[cur];
    }
    this._pathNodes.add(src);
    this.highlightPathNodes();
  }

  highlightPathNodes(): void {
    const src = this._pathSource;
    for (let i = 0; i < this.host._nodeCount; i++) {
      const onPath = this._pathNodes.has(i) || i === src;
      this.host._overrideFlags[i] = 1;
      if (i < this.host._nodeCount) {
        this.host._setGlowAlpha(i, onPath ? 0.9 : this._pathNodes.size > 0 ? 0.06 : 0.55);
        if (onPath) {
          this.host._setGlowColor(i, i === src ? 0x44ffdd : i === this._pathTarget ? 0xff8844 : 0x44ddff);
        }
      }
      if (i < this.host._nodeCount) {
        {
          const _v = onPath || this._pathNodes.size === 0;
          this.host._setCoreVisible(i, _v);
        }
      }
    }
    this.host._flushOverrideAttrs();
    for (const lines of this.host.edgeLineGroups) {
      (lines.material as any).opacity =
        this._pathNodes.size > 0 ? 0.01 : edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
    }
    this.rebuildPathEdges();
  }

  private rebuildPathEdges(): void {
    while (this.host.highlightEdgeGroup.children.length)
      this.host.highlightEdgeGroup.remove(this.host.highlightEdgeGroup.children[0]);
    if (this._pathEdges.size === 0) return;
    const pos = this.host.nodePositions;
    const verts: number[] = [];
    for (const ei of this._pathEdges) {
      const d = this.host.edgeDataList[ei];
      verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.host.highlightEdgeGroup.add(
      new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({
          color: 0x44ffcc,
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      ),
    );
  }

  clearPath(): void {
    this._pathSource = -1;
    this._pathTarget = -1;
    this._pathNodes.clear();
    this._pathEdges.clear();
    for (let i = 0; i < this.host._nodeCount; i++) {
      this.host._overrideFlags[i] = 0;
      if (i < this.host._nodeCount) {
        this.host._setGlowAlpha(i, 0.55);
        this.host._setGlowColor(i, this.host.nodeGlowColors[i]);
      }
      this.host._setCoreVisible(i, true);
    }
    this.host._flushOverrideAttrs();
    for (const lines of this.host.edgeLineGroups) {
      (lines.material as any).opacity = edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
    }
    while (this.host.highlightEdgeGroup.children.length)
      this.host.highlightEdgeGroup.remove(this.host.highlightEdgeGroup.children[0]);
    const st = document.getElementById('status-text');
    if (st && st.innerHTML?.includes('link')) st.innerHTML = '就绪';
  }

  showPathOnGraph(fromName: string, toName: string): boolean {
    const srcIdx = this.host._findNodeIndexByName(fromName);
    const dstIdx = this.host._findNodeIndexByName(toName);
    if (srcIdx < 0 || dstIdx < 0) return false;
    this.setPathSource(srcIdx);
    this.setPathTarget(dstIdx);
    return this._pathNodes.size > 0;
  }

  _handleShiftClick(e: PointerEvent): void {
    const idx = this.host._hitNode(e);
    if (idx < 0) {
      this._clearShiftPath();
      return;
    }
    if (this._shiftSourceIdx < 0) {
      this._shiftSourceIdx = idx;
      const node = this.host.graphNodes[idx];
      const st = document.getElementById('status-text');
      if (st) st.innerHTML = `${iconHtml('link', 11)} 路径起点: ${node.name} · Shift+点击目标节点完成 · ESC 取消`;
      if (idx < this.host._nodeCount) {
        this.host._setGlowColor(idx, 0x44ffdd);
        this.host._setGlowAlpha(idx, 0.9);
      }
    } else if (idx === this._shiftSourceIdx) {
      this._clearShiftPath();
    } else {
      const srcIdx = this._shiftSourceIdx;
      const srcNode = this.host.graphNodes[srcIdx];
      const tgtNode = this.host.graphNodes[idx];
      this.setPathSource(srcIdx);
      this.setPathTarget(idx);
      const pathNames = Array.from(this._pathNodes)
        .map((i) => this.host.graphNodes[i]?.name || '')
        .filter(Boolean);
      this.host.bus.emit('graph:path-selected', {
        from: { name: srcNode.name, id: srcNode.id, type: (srcNode.type || srcNode.kind || 'symbol') as string },
        to: { name: tgtNode.name, id: tgtNode.id, type: (tgtNode.type || tgtNode.kind || 'symbol') as string },
        pathLength: pathNames.length,
        pathNames,
      });
      this._shiftSourceIdx = -1;
    }
  }

  _clearShiftPath(): void {
    if (this._shiftSourceIdx >= 0 && this._shiftSourceIdx < this.host._nodeCount) {
      this.host._setGlowColor(this._shiftSourceIdx, this.host.nodeGlowColors[this._shiftSourceIdx]);
      this.host._setGlowAlpha(this._shiftSourceIdx, 0.55);
    }
    this._shiftSourceIdx = -1;
    const st = document.getElementById('status-text');
    if (st && st.innerHTML?.includes('link')) st.innerHTML = '就绪';
  }

  // ═══════════════════════════════════════════════════════════
  // Blast radius
  // ═══════════════════════════════════════════════════════════

  startBlastMode(idx: number): void {
    if (this.host.focusSubgraphActive) this.host.exitFocusSubgraph();
    this.blastMode = true;
    this.blastSource = idx;
    this.computeBlastDistances();
    this.buildBlastEdges();
    const st = document.getElementById('status-text');
    const inRadius = this.blastDistances.filter((d) => d >= 0).length;
    if (st)
      st.innerHTML = `${iconHtml('blast', 12)} 波及: ${this.host.graphNodes[idx]?.name || '?'}  ·  ${inRadius} 节点  ·  B/ESC 退出`;
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
    for (let i = 0; i < this.host._nodeCount; i++) {
      this.host._overrideFlags[i] = 0;
      this.host._setCoreColor(i, this.host.nodeCoreColors[i]);
      const base = this.host.getNodeBaseScale(i);
      this.host._setCoreScale(i, base * 0.35);
    }
    for (let i = 0; i < this.host._nodeCount; i++) {
      const gc = new THREE.Color(this.host.nodeGlowColors[i]);
      this.host._setGlowRgba(i, gc.r, gc.g, gc.b, 0.85);
      if (this.host._glow2Rgba.length > 0) this.host._setGlow2Rgba(i, gc.r, gc.g, gc.b, 0.55);
    }
    this.host._flushOverrideAttrs();
    const st = document.getElementById('status-text');
    if (st && st.innerHTML?.includes('blast')) st.innerHTML = '就绪';
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
