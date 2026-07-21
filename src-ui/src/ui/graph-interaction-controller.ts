// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// GraphInteractionController — 指针交互（hover / 点击派发）
// 从 graph.ts 拆分（P4）。状态字段仍由 facade 持有。
//
// 拾取方式：屏幕空间距离拾取（与原型一致）。
// 将所有节点投影到屏幕，取鼠标 18px 内最近的节点。
// 比 raycast 更精准——小节点也能命中。
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { bus } from './events';
import type { GraphAnalysis } from './graph-analysis';
import type { GraphEdgeRenderer } from './graph-edge-renderer';
import type { GraphFold } from './graph-fold';
import type { GraphTooltip } from './graph-tooltip';
import type { EdgeData, GraphNode } from './graph-types';

// ── InteractionHost ──

export interface InteractionHost {
  container: HTMLElement;
  camera: THREE.PerspectiveCamera;
  raycaster: THREE.Raycaster;
  mouse: THREE.Vector2;
  tmpVec3: THREE.Vector3;

  _nodeCount: number;
  _deadIndices: Set<number>;
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

export class GraphInteractionController {
  private reticleEl: HTMLDivElement | null = null;

  constructor(private host: InteractionHost) {}

  // ── Hover ──

  setupHover(): void {
    this.reticleEl = document.createElement('div');
    this.reticleEl.id = 'graph-reticle';
    this.reticleEl.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      width: 56px;
      height: 56px;
      margin-left: -28px;
      margin-top: -28px;
      pointer-events: none;
      z-index: 50;
      opacity: 0;
      transition: opacity 0.12s ease;
    `;
    this.reticleEl.innerHTML = `
      <svg width="56" height="56" viewBox="0 0 56 56" style="display:block;overflow:visible">
        <!-- Outer arc segments (bracket marks) -->
        <path d="M 28 4 A 24 24 0 0 1 48 14" fill="none" stroke="rgba(232,200,135,0.9)" stroke-width="1.4" stroke-linecap="round"/>
        <path d="M 48 42 A 24 24 0 0 1 28 52" fill="none" stroke="rgba(232,200,135,0.9)" stroke-width="1.4" stroke-linecap="round"/>
        <path d="M 8 42 A 24 24 0 0 1 8 14" fill="none" stroke="rgba(232,200,135,0.9)" stroke-width="1.4" stroke-linecap="round"/>
        <path d="M 8 14 A 24 24 0 0 1 28 4" fill="none" stroke="rgba(232,200,135,0.9)" stroke-width="1.4" stroke-linecap="round"/>
        <!-- Inner ring -->
        <circle cx="28" cy="28" r="14" fill="none" stroke="rgba(232,200,135,0.35)" stroke-width="0.8"/>
        <!-- Crosshair lines (gapped at center) -->
        <line x1="28" y1="10" x2="28" y2="17" stroke="rgba(232,200,135,0.9)" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="28" y1="39" x2="28" y2="46" stroke="rgba(232,200,135,0.9)" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="10" y1="28" x2="17" y2="28" stroke="rgba(232,200,135,0.9)" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="39" y1="28" x2="46" y2="28" stroke="rgba(232,200,135,0.9)" stroke-width="1.2" stroke-linecap="round"/>
        <!-- Center dot -->
        <circle cx="28" cy="28" r="1.2" fill="rgba(232,200,135,0.8)"/>
      </svg>
    `;
    this.host.container.appendChild(this.reticleEl);

    this.host.container.addEventListener('pointermove', (e: PointerEvent) => {
      // 鼠标在图例面板等覆盖层上时，不更新坐标，防止穿透 raycasting
      const target = e.target as HTMLElement | null;
      if (target?.closest('#graph-legend')) return;
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

  /** Screen-space picking: project all nodes, find nearest within radius. */
  _pickNode(): number {
    if (this.host._nodeCount === 0) return -1;
    if (!Number.isFinite(this.host.mouse.x) || this.host.mouse.x <= -100) return -1;

    const rect = this.host.container.getBoundingClientRect();
    // Mouse position in pixels
    const mxPx = (this.host.mouse.x * 0.5 + 0.5) * rect.width;
    const myPx = (-this.host.mouse.y * 0.5 + 0.5) * rect.height;

    const cam = this.host.camera;
    const pos = this.host.nodePositions;
    const n = this.host._nodeCount;
    const dead = this.host._deadIndices;

    let bestIdx = -1;
    let bestDist = 18 * 18; // 18px pick radius

    const v = this.host.tmpVec3;
    for (let i = 0; i < n; i++) {
      if (dead.has(i)) continue;
      v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      v.project(cam);
      if (v.z > 1 || v.z < -1) continue; // behind camera or clipped
      const sx = (v.x * 0.5 + 0.5) * rect.width;
      const sy = (-v.y * 0.5 + 0.5) * rect.height;
      const dx = sx - mxPx;
      const dy = sy - myPx;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist) {
        bestDist = d2;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  /** Update reticle position to follow hovered node's screen position. */
  private _updateReticle(): void {
    if (!this.reticleEl) return;
    if (this.host.hoveredIdx < 0 || this.host.hoveredIdx >= this.host._nodeCount) {
      this.reticleEl.style.opacity = '0';
      return;
    }
    const pos = this.host.nodePositions;
    const idx = this.host.hoveredIdx;
    this.host.tmpVec3.set(pos[idx * 3], pos[idx * 3 + 1], pos[idx * 3 + 2]);
    this.host.tmpVec3.project(this.host.camera);
    if (this.host.tmpVec3.z > 1) {
      this.reticleEl.style.opacity = '0';
      return;
    }
    const rect = this.host.container.getBoundingClientRect();
    const sx = (this.host.tmpVec3.x * 0.5 + 0.5) * rect.width;
    const sy = (-this.host.tmpVec3.y * 0.5 + 0.5) * rect.height;
    this.reticleEl.style.left = `${sx}px`;
    this.reticleEl.style.top = `${sy}px`;
    this.reticleEl.style.opacity = '1';
  }

  updateHover(): void {
    if (this.host._nodeCount === 0) return;
    if (!Number.isFinite(this.host.mouse.x) || !Number.isFinite(this.host.mouse.y)) return;

    // Cloud hover: fold mode with visible galaxy clouds
    const cloudViewActive = this.host._fold.foldMode && this.host._fold.galaxyGlows.length > 0;
    if (cloudViewActive) {
      if (this.host.hoveredIdx >= 0) {
        this.host.hoveredIdx = -1;
        this.host.targetHoverScale = 0;
        this.host._edges.rebuildHighlightEdges(-1);
      }
      this._updateReticle();
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

    // Standard view: screen-space picking
    const newIdx = this._pickNode();
    if (newIdx !== this.host.hoveredIdx) {
      // ponytail: hover is now GPU-native (uHoveredIdx uniform in shader).
      // No more CPU-side _overrideFlags / _glowRgba manipulation needed.
      this.host.hoveredIdx = newIdx;
      this.host.targetHoverScale = newIdx >= 0 ? 1 : 0;
      this.host._edges.rebuildHighlightEdges(newIdx);
    }
    this._updateReticle();
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

    // Inside a galaxy or sub-community
    if (this.host._fold.foldMode && this.host._fold.enteredGalaxyId) {
      const activeParentId =
        this.host._fold._drillStack.length > 0
          ? this.host._fold._drillStack[this.host._fold._drillStack.length - 1]
          : this.host._fold.enteredGalaxyId;

      if (this.host._fold._hasVisibleSubCommunities(activeParentId)) {
        const cid = hitCloudId();
        if (cid) {
          this.host._fold.enterSubCommunity(cid);
        }
        return;
      }
    }

    // Use screen-space picking for click too (consistent with hover)
    const savedMx = this.host.mouse.x;
    const savedMy = this.host.mouse.y;
    this.host.mouse.x = mx;
    this.host.mouse.y = my;
    const idx = this._pickNode();
    this.host.mouse.x = savedMx;
    this.host.mouse.y = savedMy;

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