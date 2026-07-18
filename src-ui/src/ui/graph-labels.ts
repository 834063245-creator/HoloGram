// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// GraphLabelSystem — 节点/星系标签投影
// 从 graph.ts 拆分（P4），DOM 标签 div 仍由 facade 持有
// ═══════════════════════════════════════════════════════════════

import type * as THREE from 'three';
import type { GraphFold } from './graph-fold';
import type { GraphTooltip } from './graph-tooltip';
import type { GraphNode } from './graph-types';

// ── LabelHost — GraphLabelSystem 需要从 StarGraph 访问的成员 ──

export interface LabelHost {
  container: HTMLElement;
  camera: THREE.PerspectiveCamera;
  tmpVec3: THREE.Vector3;

  nodeLabelIdx: number[];
  labelDivs: HTMLDivElement[];
  nodePositions: Float32Array;
  hoveredIdx: number;
  hoveredGalaxyIdx: number;

  _tooltip: GraphTooltip;
  _fold: GraphFold;
}

// ═══════════════════════════════════════════════════════════════
// GraphLabelSystem
// ═══════════════════════════════════════════════════════════════

export class GraphLabelSystem {
  constructor(private host: LabelHost) {}

  buildLabels(_nodes: GraphNode[], _deg: number[]): void {
    this.host.nodeLabelIdx = [];
  }

  updateLabels(): void {
    const halfW = this.host.container.clientWidth * 0.5,
      halfH = this.host.container.clientHeight * 0.5;
    const hoverI = this.host.hoveredIdx;
    const selI = this.host._tooltip.selectedIdx;
    for (let k = 0; k < this.host.nodeLabelIdx.length; k++) {
      const i = this.host.nodeLabelIdx[k],
        div = this.host.labelDivs[k];
      if (!div) continue;
      this.host.tmpVec3.set(
        this.host.nodePositions[i * 3],
        this.host.nodePositions[i * 3 + 1],
        this.host.nodePositions[i * 3 + 2],
      );
      this.host.tmpVec3.project(this.host.camera);
      const behind = this.host.tmpVec3.z > 1;
      if (behind || this.host._fold.foldMode) {
        div.style.display = 'none';
        continue;
      }
      const focused = i === hoverI || i === selI;
      div.style.display = '';
      div.style.left = `${this.host.tmpVec3.x * halfW + halfW}px`;
      div.style.top = `${-this.host.tmpVec3.y * halfH + halfH}px`;
      div.style.opacity = focused ? '1' : '0.18';
      div.style.fontSize = focused ? '13px' : '11px';
    }
    // Galaxy labels — no distance fade, hover brightens
    for (let k = 0; k < this.host._fold.galaxyLabelDivs.length; k++) {
      const div = this.host._fold.galaxyLabelDivs[k];
      const gIdx = Number(div.dataset['galaxyIndex']);
      if (gIdx === undefined || gIdx >= this.host._fold.galaxyMeta.length) continue;
      const gm = this.host._fold.galaxyMeta[gIdx];
      this.host.tmpVec3.copy(gm.centroid);
      this.host.tmpVec3.project(this.host.camera);
      const behind = this.host.tmpVec3.z > 1;
      const hovered = gIdx === this.host.hoveredGalaxyIdx;
      div.style.display = !behind && this.host._fold.foldMode && !this.host._fold.enteredGalaxyId ? '' : 'none';
      div.style.left = `${this.host.tmpVec3.x * halfW + halfW}px`;
      div.style.top = `${-this.host.tmpVec3.y * halfH + halfH}px`;
      div.style.opacity = hovered ? '0.9' : '0.3';
      div.style.color = hovered ? 'rgba(255,220,160,0.95)' : '';
      div.style.fontSize = hovered ? '12px' : '10px';
      div.style.textShadow = hovered ? '0 0 14px rgba(255,180,60,0.9), 0 0 30px rgba(255,120,20,0.5)' : '';
    }
  }
}
