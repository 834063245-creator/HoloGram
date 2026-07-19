// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// GraphHighlight — 高亮/滤镜/透镜/轨迹
// 从 graph.ts 拆分（P4）：文件树联动、Agent 联动、热点复发、
// 边类型/节点类型过滤、Agent lens、retrospective trail。
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { edgeOpacityByDepth } from './graph-colors';
import type { GraphFocusController } from './graph-focus-controller';
import type { EdgeData, GraphNode } from './graph-types';

// ── HighlightHost — GraphHighlight 需要从 StarGraph 访问的成员 ──

export interface HighlightHost {
  graphNodes: GraphNode[];
  nodePositions: Float32Array;
  edgeDataList: EdgeData[];
  _nodeCount: number;
  _overrideFlags: Float32Array;
  _glow2Rgba: Float32Array;
  nodeGlowColors: number[];
  nodeCoreColors: number[];
  edgeLineGroups: LineSegments2[];
  nodeGroup: THREE.Group;
  nodeLabelIdx: number[];
  labelDivs: HTMLDivElement[];
  legendEl: HTMLDivElement;

  // facade 持有的共享开关状态
  _lensActive: boolean;
  _trailActive: boolean;
  _edgeTypeFilter: string | null;
  _nodeKindFilter: string | null;
  focusSubgraphActive: boolean;

  _focus: GraphFocusController;

  exitFocusSubgraph(): void;
  _setGlowColor(i: number, c: number | THREE.Color, a?: number): void;
  _setGlowAlpha(i: number, a: number): void;
  _setGlowRgba(i: number, r: number, g: number, b: number, a: number): void;
  _setGlow2Alpha(i: number, a: number): void;
  _setCoreVisible(i: number, v: boolean): void;
  _flushOverrideAttrs(): void;
}

// ═══════════════════════════════════════════════════════════════
// GraphHighlight
// ═══════════════════════════════════════════════════════════════

export class GraphHighlight {
  // 自有状态（从 facade 迁入）
  private _fileHighlight = false;
  private _fileHighlightIndices = new Set<number>();
  private _fileOpacityOriginal = new Map<number, number>();
  private _agentHighlightIndices = new Set<number>();
  private _hotspotFiles: Map<string, number> = new Map(); // filePath → recurrence count
  private _trailLine: THREE.LineSegments | LineSegments2 | null = null;

  constructor(private host: HighlightHost) {}

  // ── File highlight (文件树 → 星图联动) ────────────────────

  /** Highlight all nodes belonging to a file (match by location prefix). */
  highlightFile(filePath: string): void {
    if (this.host.focusSubgraphActive) this.host.exitFocusSubgraph();
    // Restore any previous highlight before applying new one
    if (this._fileHighlight) this.clearFileHighlight();

    const normalized = filePath.replace(/\\/g, '/');

    for (let i = 0; i < this.host._nodeCount; i++) {
      const loc = (this.host.graphNodes[i].location || '').replace(/\\/g, '/');
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

    for (let i = 0; i < this.host._nodeCount; i++) {
      const loc = (this.host.graphNodes[i].location || '').replace(/\\/g, '/');
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

  private _applyFileHighlight(): void {
    const hl = this._fileHighlight;
    const idxs = this._fileHighlightIndices;

    // Nodes: dim non-highlighted, set override so shader doesn't animate over
    for (let i = 0; i < this.host._nodeCount; i++) {
      const visible = !hl || idxs.has(i);
      if (hl && !visible) {
        this.host._overrideFlags[i] = 1;
        this.host._setGlowAlpha(i, 0.03);
      } else if (!hl) {
        this.host._overrideFlags[i] = 0;
        this.host._setGlowAlpha(i, 0.55);
      }
    }
    if (hl || this._fileOpacityOriginal.size > 0) {
      this.host._flushOverrideAttrs();
      this._fileOpacityOriginal.clear();
    }

    // Edges: dim all when highlighting
    for (const lines of this.host.edgeLineGroups) {
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
    for (let k = 0; k < this.host.nodeLabelIdx.length; k++) {
      this.host.labelDivs[k].style.display = !hl || idxs.has(this.host.nodeLabelIdx[k]) ? '' : 'none';
    }
  }

  /** Highlight only edges of one type, dim all others. null = clear filter. */
  setEdgeTypeFilter(edgeType: string | null): void {
    this.host._edgeTypeFilter = edgeType;
    if (edgeType === null) {
      for (const lines of this.host.edgeLineGroups) {
        (lines.material as LineMaterial).opacity = edgeOpacityByDepth((lines.userData.edgeDepth as number) ?? 0);
      }
    } else {
      // ponytail: 按选中类边数分档 opacity, 防 AdditiveBlending 密集叠加过曝
      const et = edgeType.toLowerCase();
      const selCount = this.host.edgeDataList.reduce((n, d) => n + (d.edgeType.toLowerCase() === et ? 1 : 0), 0);
      const selOp = selCount > 2000 ? 0.08 : selCount > 200 ? 0.2 : 0.45;
      for (const lines of this.host.edgeLineGroups) {
        const mat = lines.material as LineMaterial;
        const letype = (lines.userData.edgeType as string) || '';
        mat.opacity = letype === edgeType ? selOp : 0.005;
      }
    }
    this._updateLegendActive(edgeType, this.host._nodeKindFilter);
  }

  /** Dim all nodes except those matching a kind filter. null = clear. */
  setNodeKindFilter(filter: string | null): void {
    this.host._nodeKindFilter = filter;
    if (filter === null) {
      for (let i = 0; i < this.host._nodeCount; i++) {
        this.host._overrideFlags[i] = 0;
        this.host._setGlowAlpha(i, 0.55);
        this.host._setCoreVisible(i, true);
        if (this.host._glow2Rgba.length > 0) this.host._setGlow2Alpha(i, 0.55);
      }
      this.host._flushOverrideAttrs();
      this._updateLegendActive(this.host._edgeTypeFilter, null);
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
    for (let i = 0; i < this.host._nodeCount; i++) {
      const kind = (this.host.graphNodes[i]?.type || this.host.graphNodes[i]?.kind || 'symbol') as string;
      const hit = matches(kind);
      this.host._overrideFlags[i] = hit ? 0 : 1; // matching=let shader animate, non-matching=CPU freeze at alpha 0
      if (hit) {
        this.host._setGlowAlpha(i, 0.88);
        if (this.host._glow2Rgba.length > 0) this.host._setGlow2Alpha(i, 0.48);
      } else {
        this.host._setGlowAlpha(i, 0);
        if (this.host._glow2Rgba.length > 0) this.host._setGlow2Alpha(i, 0);
      }
      this.host._setCoreVisible(i, hit);
    }
    this.host._flushOverrideAttrs();
    this._updateLegendActive(this.host._edgeTypeFilter, filter);
  }

  private _updateLegendActive(activeEdge: string | null, activeNode: string | null = null): void {
    this.host.legendEl.querySelectorAll<HTMLElement>('.legend-edge-row').forEach((row) => {
      const et = row.dataset.edgeType || '';
      row.classList.toggle('active', activeEdge !== null && et === activeEdge);
      row.style.opacity = activeEdge === null ? '1' : et === activeEdge ? '1' : '0.35';
    });
    this.host.legendEl.querySelectorAll<HTMLElement>('.legend-node-row').forEach((row) => {
      const nk = row.dataset.nodeFilter || '';
      row.classList.toggle('active', activeNode !== null && nk === activeNode);
      row.style.opacity = activeNode === null ? '1' : nk === activeNode ? '1' : '0.35';
    });
  }

  // ── Agent highlight (Agent ↔ 星图联动) ──────────────────

  /** Highlight a set of nodes by name (fuzzy match). Matched nodes glow in the given color; others dim. */
  highlightNodeNames(names: string[], colorHex?: string): void {
    if (this.host.focusSubgraphActive) this.host.exitFocusSubgraph();
    this._clearAgentHighlightState();
    if (!names.length || this.host._nodeCount === 0) return;

    const color = colorHex ? parseInt(colorHex.replace('#', ''), 16) : 0xf0b848; // default sol
    const lowerNames = names.map((n) => n.trim().toLowerCase());

    for (let i = 0; i < this.host._nodeCount; i++) {
      const nodeName = (this.host.graphNodes[i].name || '').toLowerCase();
      const shortName = nodeName.split('.').pop() || '';
      const found = lowerNames.some(
        (q) => nodeName === q || nodeName.startsWith(q) || nodeName.includes(q) || shortName === q,
      );
      if (found) {
        this._agentHighlightIndices.add(i);
      }
    }

    if (this._agentHighlightIndices.size === 0) return;

    // Apply: dim non-highlighted, recolor highlighted
    for (let i = 0; i < this.host._nodeCount; i++) {
      this.host._overrideFlags[i] = 1;
      if (this._agentHighlightIndices.has(i)) {
        this.host._setGlowColor(i, color);
        this.host._setGlowAlpha(i, 0.88);
        this.host._setCoreVisible(i, true);
      } else {
        this.host._setGlowAlpha(i, 0.025);
      }
    }
    this.host._flushOverrideAttrs();
    // Dim non-path edges
    for (const lines of this.host.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = 0.008;
    }
  }

  /** Clear all Agent-triggered highlights (path + node highlight). */
  clearAgentHighlight(): void {
    this._clearAgentHighlightState();
    // Also restore any file highlight if active
    if (this._fileHighlight) {
      this._applyFileHighlight();
    }
  }

  private _clearAgentHighlightState(): void {
    if (this._agentHighlightIndices.size === 0) return;
    // Restore original glows for previously highlighted nodes + clear override
    for (const i of this._agentHighlightIndices) {
      if (i < this.host._nodeCount) {
        this.host._overrideFlags[i] = 0;
        this.host._setGlowColor(i, this.host.nodeGlowColors[i]);
        this.host._setGlowAlpha(i, 0.55);
      }
      this.host._setCoreVisible(i, true);
    }
    // Restore non-highlighted dimmed nodes (opacity + visibility)
    for (let i = 0; i < this.host._nodeCount; i++) {
      if (!this._agentHighlightIndices.has(i)) {
        this.host._overrideFlags[i] = 0;
        this.host._setGlowAlpha(i, 0.55);
        this.host._setCoreVisible(i, true);
      }
    }
    this.host._flushOverrideAttrs();
    // Restore edge opacities
    for (const lines of this.host.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = edgeOpacityByDepth((lines.userData.edgeDepth as number) ?? 0);
    }
    this._agentHighlightIndices.clear();
  }

  // ── P6: Hotspot highlighting — 复发热点着色 ──

  /** Color nodes belonging to hotspot files with intensity proportional to L4 recurrence count. */
  highlightHotspots(hotspots: Array<{ file: string; count: number }>): void {
    this.clearHotspots();
    if (!hotspots.length || this.host._nodeCount === 0) return;

    // Build a map of filename → count
    for (const hs of hotspots) {
      const key = (hs.file || '').replace(/\\/g, '/').toLowerCase();
      const prev = this._hotspotFiles.get(key) || 0;
      this._hotspotFiles.set(key, Math.max(prev, hs.count));
    }

    // Apply coloring: intensity from 0.3 (count=2) to 1.0 (count≥8)
    for (let i = 0; i < this.host._nodeCount; i++) {
      const loc = (this.host.graphNodes[i].location || '').toLowerCase();
      if (!loc) continue;
      for (const [hsPath, count] of this._hotspotFiles) {
        if (loc.includes(hsPath) || hsPath.includes(loc)) {
          const intensity = Math.min(1, 0.3 + (count - 2) * 0.12);
          if (i < this.host._nodeCount) {
            this.host._overrideFlags[i] = 1;
            const r = 0.85,
              g = 0.2 + (1 - intensity) * 0.3,
              b = 0.2 + (1 - intensity) * 0.3;
            this.host._setGlowRgba(i, r, g, b, 0.35 + intensity * 0.55);
          }
          break;
        }
      }
    }
    this.host._flushOverrideAttrs();
  }

  clearHotspots(): void {
    if (this._hotspotFiles.size === 0) return;
    this._hotspotFiles.clear();
    // Restore original glow colors and clear override flags
    for (let i = 0; i < this.host._nodeCount; i++) {
      if (i < this.host._nodeCount) {
        this.host._overrideFlags[i] = 0;
        this.host._setGlowColor(i, this.host.nodeGlowColors[i] || 0x5588cc);
        this.host._setGlowAlpha(i, 0.55);
      }
    }
    this.host._flushOverrideAttrs();
  }

  // ── Agent Lens (Step 2) — dim everything except visited nodes ──

  /** Dim all nodes except those matching the given names to 1% opacity. */
  setAgentLens(nodeNames: Set<string>): void {
    if (!nodeNames || nodeNames.size === 0 || this.host._nodeCount === 0) {
      this.clearAgentLens();
      return;
    }

    // Build set of matched node indices
    const lensIndices = new Set<number>();
    const lowerNames = Array.from(nodeNames).map((n) => n.trim().toLowerCase());

    for (let i = 0; i < this.host._nodeCount; i++) {
      const nodeName = (this.host.graphNodes[i].name || '').toLowerCase();
      const shortName = nodeName.split('.').pop() || '';
      const found = lowerNames.some(
        (q) => nodeName === q || nodeName.startsWith(q) || nodeName.includes(q) || shortName === q,
      );
      if (found) lensIndices.add(i);
    }

    if (lensIndices.size === 0) return;

    // Apply lens: visited nodes stay bright, others dim to 1%
    for (let i = 0; i < this.host._nodeCount; i++) {
      this.host._overrideFlags[i] = 1;
      if (lensIndices.has(i)) {
        this.host._setGlowAlpha(i, 0.88);
        this.host._setCoreVisible(i, true);
      } else {
        this.host._setGlowAlpha(i, 0.01);
      }
    }
    this.host._flushOverrideAttrs();

    // Dim all edges
    for (const lines of this.host.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = 0.005;
    }

    this.host._lensActive = true;
  }

  /** Restore normal rendering from agent lens mode. */
  clearAgentLens(): void {
    if (!this.host._lensActive) return;
    this.host._lensActive = false;

    for (let i = 0; i < this.host._nodeCount; i++) {
      this.host._overrideFlags[i] = 0;
      this.host._setGlowAlpha(i, 0.55);
      this.host._setCoreVisible(i, true);
    }
    this.host._flushOverrideAttrs();

    // Restore edge opacities
    for (const lines of this.host.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = edgeOpacityByDepth((lines.userData.edgeDepth as number) ?? 0);
    }

    this._clearTrailLine();
  }

  // ── Agent Trail (retrospective mode) — thick glowing line + visited node highlight ──

  /** Activate retrospective trail mode: highlight all visited nodes, dim others
   *  to 30% (not 2.5% — still visible, just backgrounded), draw a thick glowing
   *  trail line through the exploration sequence, and fly camera to the centroid. */
  showAgentTrail(visitedNames: Set<string>, trailNames: string[]): void {
    if (this.host._nodeCount === 0) return;

    // 1. Find indices for visited nodes
    const visitedIndices = new Set<number>();
    for (const name of visitedNames) {
      const idx = this._findNodeIndexByName(name);
      if (idx >= 0) visitedIndices.add(idx);
    }
    if (visitedIndices.size === 0) return;

    // 2. Apply lens: visited at 80%, unvisited at 30% (readable backdrop)
    for (let i = 0; i < this.host._nodeCount; i++) {
      this.host._overrideFlags[i] = 1;
      if (visitedIndices.has(i)) {
        this.host._setGlowAlpha(i, 0.85);
        this.host._setCoreVisible(i, true);
      } else {
        this.host._setGlowAlpha(i, 0.3);
      }
    }
    this.host._flushOverrideAttrs();

    // 3. Dim edges so trail pops
    for (const lines of this.host.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = 0.015;
    }

    // 4. Draw thick trail line
    this._drawAgentTrail(trailNames);

    // 5. Fly camera to trail centroid
    this.host._focus._flyToCentroid(visitedIndices);

    this.host._trailActive = true;
  }

  /** Restore normal rendering from trail mode. */
  hideAgentTrail(): void {
    if (!this.host._trailActive) return;
    this.host._trailActive = false;

    for (let i = 0; i < this.host._nodeCount; i++) {
      this.host._overrideFlags[i] = 0;
      this.host._setGlowAlpha(i, 0.55);
      this.host._setCoreVisible(i, true);
    }
    this.host._flushOverrideAttrs();

    for (const lines of this.host.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = edgeOpacityByDepth((lines.userData.edgeDepth as number) ?? 0);
    }

    this._clearTrailLine();
  }

  /** Draw the thick glowing trail line through visited nodes. Uses LineMaterial
   *  for variable width support. */
  private _drawAgentTrail(trailNames: string[]): void {
    this._clearTrailLine();

    if (!trailNames || trailNames.length < 2) return;

    const indices: number[] = [];
    for (const name of trailNames) {
      const idx = this._findNodeIndexByName(name);
      if (idx >= 0) {
        if (indices.length === 0 || indices[indices.length - 1] !== idx) {
          indices.push(idx);
        }
      }
    }
    if (indices.length < 2) return;

    const pos = this.host.nodePositions;
    const verts: number[] = [];
    const colors: number[] = [];
    for (let k = 0; k < indices.length - 1; k++) {
      const i = indices[k],
        j = indices[k + 1];
      verts.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]);
      const t = (k + 1) / (indices.length - 1);
      const bright = 0.4 + t * 0.6;
      colors.push(0.15 * bright, 0.9 * bright, bright, 0.15 * bright, 0.9 * bright, bright);
    }

    const geo = new LineSegmentsGeometry();
    geo.setPositions(verts);
    geo.setColors(colors);
    this._trailLine = new LineSegments2(
      geo,
      new LineMaterial({
        color: 0x33ccff,
        linewidth: 2.5,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        worldUnits: false,
      }),
    );
    this._trailLine.renderOrder = 999;
    this.host.nodeGroup.add(this._trailLine);
  }

  /** Remove the existing trail line. Handles both LineSegments (old) and LineSegments2 (new). */
  _clearTrailLine(): void {
    if (this._trailLine) {
      this.host.nodeGroup.remove(this._trailLine);
      if (this._trailLine.geometry) this._trailLine.geometry.dispose();
      const mat = this._trailLine.material;
      if (mat) {
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
      this._trailLine = null;
    }
  }

  /** Find a node's array index by name (fuzzy). Returns -1 if not found. */
  _findNodeIndexByName(query: string): number {
    const q = query.trim().toLowerCase();
    if (!q || this.host._nodeCount === 0) return -1;
    let idx = this.host.graphNodes.findIndex((n) => n.name.toLowerCase() === q);
    if (idx < 0) idx = this.host.graphNodes.findIndex((n) => n.name.toLowerCase().startsWith(q));
    if (idx < 0) idx = this.host.graphNodes.findIndex((n) => n.name.toLowerCase().includes(q));
    return idx;
  }
}
