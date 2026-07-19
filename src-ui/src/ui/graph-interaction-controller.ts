// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// GraphInteractionController — 指针交互（hover raycast / 点击派发）
// 从 graph.ts 拆分（P4）。状态字段仍由 facade 持有。
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { bus } from './events';
import type { GraphAnalysis } from './graph-analysis';
import type { GraphEdgeRenderer } from './graph-edge-renderer';
import type { GraphFold } from './graph-fold';
import type { GraphTooltip } from './graph-tooltip';
import type { EdgeData, GraphNode } from './graph-types';

// ── InteractionHost — GraphInteractionController 需要从 StarGraph 访问的成员 ──

export interface InteractionHost {
  container: HTMLElement;
  camera: THREE.PerspectiveCamera;
  raycaster: THREE.Raycaster;
  mouse: THREE.Vector2;
  tmpVec3: THREE.Vector3;

  _nodeCount: number;
  nodeCoresInstanced: THREE.InstancedMesh;
  graphNodes: GraphNode[];
  nodePositions: Float32Array;
  edgeDataList: EdgeData[];
  deg: number[];
  nodeCoreColors: number[];

  hoveredIdx: number;
  hoveredGalaxyIdx: number;
  targetHoverScale: number;

  _fold: GraphFold;
  _tooltip: GraphTooltip;
  _analysis: GraphAnalysis;
  _edges: GraphEdgeRenderer;

  _setCoreColor(i: number, c: number | THREE.Color): void;
  _setGlowAlpha(i: number, a: number): void;
}

// ═══════════════════════════════════════════════════════════════
// GraphInteractionController
// ═══════════════════════════════════════════════════════════════

export class GraphInteractionController {
  constructor(private host: InteractionHost) {}

  // ── Hover ────────────────────────────────────────────────
  // Hover raycaster uses ALL nodeCores regardless of .visible state.
  // This is intentional: .visible is a visual/rendering concern, and many
  // features (agent highlight, path mode, blast) temporarily toggle it.
  // If a node exists in the graph, it should be hoverable and clickable.
  // The only exception is fold-mode cloud view, which intentionally restricts
  // interaction to galaxy clouds only.

  setupHover(): void {
    this.host.container.addEventListener('pointermove', (e: PointerEvent) => {
      const rect = this.host.container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      this.host.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.host.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    });
    this.host.container.addEventListener('pointerleave', () => {
      this.host.mouse.x = -999;
      this.host.mouse.y = -999;
    });
  }

  /** Raycast against node cores; returns index or -1. Uses ALL cores regardless of .visible. */
  _raycastNode(): number {
    if (this.host._nodeCount === 0) return -1;
    if (!this.host.nodeCoresInstanced) return -1;
    this.host.raycaster.setFromCamera(this.host.mouse, this.host.camera);
    const hits = this.host.raycaster.intersectObject(this.host.nodeCoresInstanced);
    if (hits.length === 0) return -1;
    return hits[0].instanceId ?? -1;
  }

  updateHover(): void {
    if (this.host._nodeCount === 0) return;
    if (!Number.isFinite(this.host.mouse.x) || !Number.isFinite(this.host.mouse.y)) return;

    // Cloud hover: fold mode with visible galaxy clouds (nodes hidden intentionally)
    const cloudViewActive = this.host._fold.foldMode && this.host._fold.galaxyGlows.length > 0;
    if (cloudViewActive) {
      if (this.host.hoveredIdx >= 0) {
        this.host.hoveredIdx = -1;
        this.host.targetHoverScale = 0;
        this.host._edges.rebuildHighlightEdges(-1);
      }
      this.host.raycaster.setFromCamera(this.host.mouse, this.host.camera);
      const coreSprites = this.host._fold.galaxyGlows.filter((_, i) => i % 2 === 1);
      const galaxyHits = this.host.raycaster.intersectObjects(coreSprites);
      if (galaxyHits.length > 0 && this.host.mouse.x > -999) {
        this.host.container.style.cursor = 'pointer';
        const gIdx = galaxyHits[0].object.userData.galaxyIndex as number | undefined;
        if (gIdx !== undefined && gIdx < this.host._fold.galaxyMeta.length) {
          this.host.hoveredGalaxyIdx = gIdx;
          const gm = this.host._fold.galaxyMeta[gIdx];
          const shortName = (gm.label || gm.id).split('/')[0].replace(/_/g, ' ');
          const isSub = !!this.host._fold.enteredGalaxyId;
          this.host._tooltip.tooltipEl.querySelector('.tt-name')!.textContent = `${isSub ? '📁' : '🌌'} ${shortName}`;
          this.host._tooltip.tooltipEl.querySelector('.tt-meta')!.textContent =
            `${gm.memberIndices.length} 节点 · ${gm.memberIndices.length >= 30 ? '大型星团' : gm.memberIndices.length >= 10 ? '中型星团' : '小型星团'}`;
          this.host._tooltip.tooltipEl.querySelector('.tt-loc')!.textContent = isSub
            ? '点击钻入子社区'
            : '点击进入查看内部连线';
          this.host.tmpVec3.copy(gm.centroid);
          this.host.tmpVec3.project(this.host.camera);
          if (this.host.tmpVec3.z <= 1) {
            const x = (this.host.tmpVec3.x * 0.5 + 0.5) * this.host.container.clientWidth;
            const y = (-this.host.tmpVec3.y * 0.5 + 0.5) * this.host.container.clientHeight;
            this.host._tooltip.tooltipEl.style.left = `${x + 18}px`;
            this.host._tooltip.tooltipEl.style.top = `${y - 10}px`;
            this.host._tooltip.tooltipEl.classList.add('visible');
          }
        }
      } else {
        this.host.container.style.cursor = '';
        this.host._tooltip.tooltipEl.classList.remove('visible');
        this.host.hoveredGalaxyIdx = -1;
      }
      return;
    }

    // Standard / constellation view: raycast all cores (ignore .visible)
    const newIdx = this._raycastNode();
    if (newIdx !== this.host.hoveredIdx) {
      // Restore previous hovered node — brightness only, no scale change
      if (this.host.hoveredIdx >= 0 && this.host.hoveredIdx < this.host._nodeCount) {
        // Restore original core color
        this.host._setCoreColor(this.host.hoveredIdx, this.host.nodeCoreColors[this.host.hoveredIdx]);
        if (this.host.hoveredIdx >= 0 && this.host.hoveredIdx < this.host._nodeCount) {
          this.host._setGlowAlpha(this.host.hoveredIdx, 0.55);
        }
      }
      this.host.hoveredIdx = newIdx;
      this.host.targetHoverScale = newIdx >= 0 ? 1 : 0;
      this.host._edges.rebuildHighlightEdges(newIdx);
    }
  }

  onClick(e: MouseEvent): void {
    if (this.host._nodeCount === 0) return;
    const rect = this.host.container.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.host.raycaster.setFromCamera(new THREE.Vector2(mx, my), this.host.camera);

    // Helper: intersect galaxy core sprites and return the community id
    const hitCloudId = (): string | null => {
      const coreSprites = this.host._fold.galaxyGlows.filter((_, i) => i % 2 === 1);
      const hits = this.host.raycaster.intersectObjects(coreSprites);
      if (hits.length > 0) {
        return (hits[0].object.userData.galaxyId as string) || null;
      }
      return null;
    };

    // In universe view: click galaxy cloud → enterGalaxy
    if (this.host._fold.foldMode && !this.host._fold.enteredGalaxyId) {
      const cid = hitCloudId();
      if (cid) {
        this.host._fold.enterGalaxy(cid);
      }
      return;
    }

    // Inside a galaxy or sub-community: dispatch based on whether we're in cloud or constellation view
    if (this.host._fold.foldMode && this.host._fold.enteredGalaxyId) {
      // Current parent is the deepest sub-community, or the galaxy itself
      const activeParentId =
        this.host._fold._drillStack.length > 0
          ? this.host._fold._drillStack[this.host._fold._drillStack.length - 1]
          : this.host._fold.enteredGalaxyId;

      // Check if current parent has sub-communities (→ cloud view) or not (→ constellation view)
      if (this.host._fold._hasVisibleSubCommunities(activeParentId)) {
        // Cloud view: click sub-cloud → enterSubCommunity
        const cid = hitCloudId();
        if (cid) {
          this.host._fold.enterSubCommunity(cid);
        }
        return;
      }
    }

    // Intersect ALL node cores (ignore .visible — hover/click should always work)
    const hits = this.host.raycaster.intersectObject(this.host.nodeCoresInstanced);
    const idx = hits.length > 0 ? (hits[0].instanceId ?? -1) : -1;

    if (idx >= 0 && idx !== this.host._tooltip.selectedIdx)
      this.host._tooltip.showDetail(
        idx,
        this.host.edgeDataList,
        this.host.deg,
        this.host.nodePositions,
        this.host.container,
        this.host.camera,
        this.host.graphNodes,
      );
    else if (idx < 0) this.host._tooltip.hideDetail();

    // Step 3: Emit graph:node-clicked (for external interaction handlers)
    if (idx >= 0 && idx < this.host._nodeCount) {
      const node = this.host.graphNodes[idx];
      bus.emit('graph:node-clicked', {
        nodeName: node.name,
        nodeType: (node.type || node.kind || 'symbol') as string,
        nodeId: node.id,
        degree: this.host.deg[idx] || 0,
        location: node.location || '',
      });
    }
  }
}
