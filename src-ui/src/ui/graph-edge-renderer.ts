// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// GraphEdgeRenderer — 边批渲染（LineSegments2 分组 + hover 高亮边）
// 从 graph.ts 拆分（P4）。状态字段仍由 facade 持有。
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { GraphAnalysis } from './graph-analysis';
import { edgeColorByType, edgeOpacityByDepth, edgeWidthByDepth } from './graph-colors';
import type { GraphFocusController } from './graph-focus-controller';
import type { EdgeData, GraphJSON, GraphNode } from './graph-types';

// ── EdgeRendererHost — GraphEdgeRenderer 需要从 StarGraph 访问的成员 ──

export interface EdgeRendererHost {
  container: HTMLElement;
  edgeGroup: THREE.Group;
  highlightEdgeGroup: THREE.Group;
  edgeLineGroups: LineSegments2[];

  graphNodes: GraphNode[];
  nodePositions: Float32Array;
  edgeDataList: EdgeData[];
  edgeIndexOf: number[][];
  neighborMap: number[][];
  deg: number[];
  l34Count: number[];
  maxDeg: number;
  _nodeCount: number;
  _deadIndices: Set<number>;
  _nodeMagCache: Float32Array;
  nodeGlowsPoints: THREE.Points;
  nodeGlows2Points: THREE.Points;

  _analysis: GraphAnalysis;
  focusSubgraphActive: boolean;
  _focus: GraphFocusController;

  initEdgeParticles(pos: Float32Array, data: EdgeData[]): void;
  positionGrid(pos: Float32Array): void;
}

// ═══════════════════════════════════════════════════════════════
// GraphEdgeRenderer
// ═══════════════════════════════════════════════════════════════

export class GraphEdgeRenderer {
  constructor(private host: EdgeRendererHost) {}

  // ── Edges ────────────────────────────────────────────────

  buildEdges(pos: Float32Array, data: EdgeData[]): void {
    if (data.length === 0) return;
    const key = (d: EdgeData) => `${d.edgeType}:${d.direction}:${d.couplingDepth}:${d.crossFile ? 1 : 0}`;
    const groups = new Map<
      string,
      { verts: number[]; colors: number[]; depth: number; crossFile: boolean; edgeType: string }
    >();
    for (const d of data) {
      const k = key(d);
      if (!groups.has(k)) {
        groups.set(k, {
          verts: [],
          colors: [],
          depth: d.couplingDepth,
          crossFile: d.crossFile,
          edgeType: d.edgeType.toLowerCase(),
        });
      }
      const g = groups.get(k)!;
      g.verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
      const c = edgeColorByType(d.edgeType, d.direction, d.crossFile);
      g.colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    const resolution = new THREE.Vector2(this.host.container.clientWidth, this.host.container.clientHeight);
    for (const [, g] of groups) {
      const B = 2000;
      for (let b = 0; b < g.verts.length; b += B * 6) {
        const v = g.verts.slice(b, b + B * 6),
          cl = g.colors.slice(b, b + B * 6);
        const opacity = edgeOpacityByDepth(g.depth);
        const lw = edgeWidthByDepth(g.depth);

        // ── Base: solid dim line with subtle flow breathing ──
        const baseGeo = new LineSegmentsGeometry();
        baseGeo.setPositions(v);
        baseGeo.setColors(cl);
        const baseMat = new LineMaterial({
          vertexColors: true,
          transparent: true,
          opacity,
          linewidth: lw,
          resolution,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        // ponytail: static edge opacity — no per-frame breathing, set once
        const baseLines = new LineSegments2(baseGeo, baseMat);
        baseLines.userData.edgeDepth = g.depth;
        baseLines.userData.edgeType = g.edgeType;
        baseLines.computeLineDistances();
        this.host.edgeGroup.add(baseLines);
        this.host.edgeLineGroups.push(baseLines);
      }
    }
  }

  /** Dispose all edge line groups and clear edgeGroup. */
  _disposeEdges(): void {
    for (const lines of this.host.edgeLineGroups) {
      lines.geometry?.dispose();
      (lines.material as THREE.Material)?.dispose();
      this.host.edgeGroup.remove(lines);
    }
    this.host.edgeLineGroups = [];
  }

  /** Rebuild edge data structures + edge geometry from full graph. */
  _rebuildEdgeData(fullGraph: GraphJSON, nodeIdxMap: Map<string, number>): void {
    const edges = Array.isArray(fullGraph.edges) ? fullGraph.edges : Object.values(fullGraph.edges);
    const eData: EdgeData[] = [];
    const deg = new Array<number>(this.host._nodeCount).fill(0);
    const nodeFile = new Map<number, string>();
    for (let i = 0; i < this.host._nodeCount; i++) {
      if (this.host._deadIndices.has(i)) continue;
      nodeFile.set(i, (this.host.graphNodes[i]?.location || '').replace(/:\d+$/, ''));
    }
    for (const e of edges) {
      const s = nodeIdxMap.get(e.source);
      const t = nodeIdxMap.get(e.target);
      if (s === undefined || t === undefined || s === t) continue;
      if (this.host._deadIndices.has(s) || this.host._deadIndices.has(t)) continue;
      deg[s]++;
      deg[t]++;
      eData.push({
        s,
        t,
        couplingDepth: ((e as any).coupling_depth as number) || 0,
        edgeType: e.type || '',
        direction: (e as any).direction || '',
        crossFile: nodeFile.get(s) !== nodeFile.get(t),
      });
    }
    this.host.deg = deg;
    this.host.edgeDataList = eData;
    this.host.maxDeg = Math.max(...deg, 1);

    this.host.neighborMap = Array.from({ length: this.host._nodeCount }, () => []);
    this.host.edgeIndexOf = Array.from({ length: this.host._nodeCount }, () => []);
    for (let ei = 0; ei < eData.length; ei++) {
      const { s, t } = eData[ei];
      this.host.neighborMap[s].push(t);
      this.host.neighborMap[t].push(s);
      this.host.edgeIndexOf[s].push(ei);
      this.host.edgeIndexOf[t].push(ei);
    }
    this.host.l34Count = new Array(this.host._nodeCount).fill(0);
    for (const e of eData) {
      if (e.couplingDepth >= 3) {
        this.host.l34Count[e.s]++;
        this.host.l34Count[e.t]++;
      }
    }

    // Update mag/risk GPU attrs for all nodes
    const logMax = Math.log1p(this.host.maxDeg);
    const gAttr = this.host.nodeGlowsPoints?.geometry.attributes;
    const g2Attr = this.host.nodeGlows2Points?.geometry.attributes;
    for (let i = 0; i < this.host._nodeCount; i++) {
      this.host._nodeMagCache[i] = 0.15 + 0.85 * (Math.log1p(this.host.deg[i]) / logMax);
      if (gAttr) {
        (gAttr.mag.array as Float32Array)[i] = this.host._nodeMagCache[i];
        (gAttr.risk.array as Float32Array)[i] = this.host.l34Count[i] || 0;
      }
    }
    if (gAttr) {
      gAttr.mag.needsUpdate = true;
      gAttr.risk.needsUpdate = true;
    }
    if (g2Attr) {
      g2Attr.mag.needsUpdate = true;
      g2Attr.risk.needsUpdate = true;
    }

    this._disposeEdges();
    this.buildEdges(this.host.nodePositions, eData);
    this.host.initEdgeParticles(this.host.nodePositions, eData);
    this.host.positionGrid(this.host.nodePositions);
  }

  /** Build hover edge verts+colors for a node — degree-normalized brightness gradient. */
  _buildHoverEdgeVerts(nodeIdx: number, verts: number[], colors: number[]): void {
    const edges = this.host.edgeIndexOf[nodeIdx];
    if (edges.length === 0) return;
    const pos = this.host.nodePositions;
    const degNorm = 1 / edges.length ** 0.25;
    for (const ei of edges) {
      const d = this.host.edgeDataList[ei];
      verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
      const c = edgeColorByType(d.edgeType, d.direction, d.crossFile);
      const nearB = 2.5 * degNorm * 0.3;
      const farB = 2.5 * degNorm;
      if (d.s === nodeIdx) {
        colors.push(
          Math.min(1, c.r * nearB),
          Math.min(1, c.g * nearB),
          Math.min(1, c.b * nearB),
          Math.min(1, c.r * farB),
          Math.min(1, c.g * farB),
          Math.min(1, c.b * farB),
        );
      } else {
        colors.push(
          Math.min(1, c.r * farB),
          Math.min(1, c.g * farB),
          Math.min(1, c.b * farB),
          Math.min(1, c.r * nearB),
          Math.min(1, c.g * nearB),
          Math.min(1, c.b * nearB),
        );
      }
    }
  }

  rebuildHighlightEdges(nodeIdx: number): void {
    if (this.host._analysis.blastMode) return;
    if (this.host.focusSubgraphActive) {
      this.host._focus._buildFocusSubgraphEdges();
      if (nodeIdx >= 0 && nodeIdx < this.host._nodeCount) {
        const verts: number[] = [],
          colors: number[] = [];
        this._buildHoverEdgeVerts(nodeIdx, verts, colors);
        if (verts.length > 0) {
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
      }
      return;
    }
    while (this.host.highlightEdgeGroup.children.length)
      this.host.highlightEdgeGroup.remove(this.host.highlightEdgeGroup.children[0]);
    if (nodeIdx < 0 || nodeIdx >= this.host._nodeCount) return;
    const verts: number[] = [],
      colors: number[] = [];
    this._buildHoverEdgeVerts(nodeIdx, verts, colors);
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
}
