// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// GraphDiffOverlay — 变更回看着色（绿=新增 红=删除 橙=修改）
// 从 graph.ts 拆分（P4），状态自持有，GPU 写入经 host 委托
// ═══════════════════════════════════════════════════════════════

import { GLOW_COLORS, NODE_COLORS } from './graph-colors';
import type { GraphNode } from './graph-types';

// ── DiffOverlayHost — GraphDiffOverlay 需要从 StarGraph 访问的成员 ──

export interface DiffOverlayHost {
  graphNodes: GraphNode[];
  _nodeCount: number;
  _deadIndices: Set<number>;
  _overrideFlags: Float32Array;
  _glow2Rgba: Float32Array;
  _coreScales: Float32Array;

  _setGlowColor(i: number, c: number): void;
  _setGlowAlpha(i: number, a: number): void;
  _setGlow2Alpha(i: number, a: number): void;
  _setCoreColor(i: number, c: number): void;
  _setCoreScale(i: number, s: number): void;
  _setCoreVisible(i: number, v: boolean): void;
  getNodeBaseScale(i: number): number;
  _flushOverrideAttrs(): void;
}

// ═══════════════════════════════════════════════════════════════
// GraphDiffOverlay
// ═══════════════════════════════════════════════════════════════

export class GraphDiffOverlay {
  // Diff overlay (P4: 变更回看着色)
  diffActive = false;
  diffAddedIds = new Set<string>();
  diffRemovedIds = new Set<string>();
  diffModifiedIds = new Set<string>();

  constructor(private host: DiffOverlayHost) {}

  /** Apply diff coloring: green=added, red=removed, orange=modified. */
  showDiff(diffJson: {
    added_nodes?: Array<{ id: string }>;
    removed_nodes?: Array<{ id: string }>;
    modified_nodes?: Array<{ node_id: string }>;
  }): void {
    this.diffActive = true;
    this.diffAddedIds = new Set((diffJson.added_nodes || []).map((n) => n.id));
    this.diffRemovedIds = new Set((diffJson.removed_nodes || []).map((n) => n.id));
    this.diffModifiedIds = new Set((diffJson.modified_nodes || []).map((n) => n.node_id));

    const GREEN = 0x44dd44,
      RED = 0xee4444,
      ORANGE = 0xf0a020;

    for (let i = 0; i < this.host._nodeCount; i++) {
      if (!this.host.graphNodes[i]) continue;
      const nid = this.host.graphNodes[i].id;
      let diffColor: number | null = null;
      if (this.diffAddedIds.has(nid)) diffColor = GREEN;
      else if (this.diffRemovedIds.has(nid)) diffColor = RED;
      else if (this.diffModifiedIds.has(nid)) diffColor = ORANGE;

      if (diffColor !== null) {
        // ponytail: override=1 forces shader to use CPU-set color instead of animated twinkle
        this.host._overrideFlags[i] = 1;
        this.host._setGlowColor(i, diffColor);
        this.host._setGlowAlpha(i, 0.85);
        if (this.host._glow2Rgba.length > 0) this.host._setGlow2Alpha(i, 0.5);
      }
    }
    this.host._flushOverrideAttrs();

    // Pulse effect on added diff nodes: slightly increase scale
    for (let i = 0; i < this.host._nodeCount; i++) {
      if (this.host.graphNodes[i] && this.diffAddedIds.has(this.host.graphNodes[i].id)) {
        this.host._setCoreScale(i, (this.host._coreScales[i] || 1) * 1.3);
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
    for (let i = 0; i < this.host._nodeCount; i++) {
      if (!this.host.graphNodes[i]) continue;
      if (this.host._deadIndices.has(i)) {
        // ponytail: dead nodes stay invisible when diff is cleared
        this.host._setGlowAlpha(i, 0);
        if (this.host._glow2Rgba.length > 0) this.host._setGlow2Alpha(i, 0);
        this.host._setCoreVisible(i, false);
        continue;
      }
      const kind = ((this.host.graphNodes[i].type || this.host.graphNodes[i].kind || 'symbol') as string).toLowerCase();
      const glowColor = GLOW_COLORS[kind] || 0x4488cc;
      this.host._overrideFlags[i] = 0; // restore shader animation
      this.host._setGlowColor(i, glowColor);
      this.host._setGlowAlpha(i, 0.55);
      if (this.host._glow2Rgba.length > 0) this.host._setGlow2Alpha(i, 0.55);
      const coreColor = NODE_COLORS[kind] || 0x6ab0ff;
      this.host._setCoreColor(i, coreColor);
      const baseScale = this.host.getNodeBaseScale(i);
      this.host._setCoreScale(i, isFull ? baseScale * 0.4 : baseScale);
    }
    this.host._flushOverrideAttrs();
  }
}
