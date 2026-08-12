// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// GraphFold — 星系折叠 (社区视图)
// 从 graph.ts 拆分，独立管理 fold/unfold/enter/exit 全流程
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { communityColor, edgeColorByType, edgeOpacityByDepth, GLOW_COLORS } from './graph-colors';
import { useShellStore } from '../app/shell-store';
import type { CommunityData, EdgeData, GraphNode } from './graph-types';

export interface GalaxyMeta {
  id: string;
  label: string;
  centroid: THREE.Vector3;
  memberIndices: number[];
  radius: number;
}

// ── FoldHost — GraphFold 需要从 StarGraph 访问的成员 ────────

export interface FoldHost {
  // 数据
  graphNodes: GraphNode[];
  nodePositions: Float32Array;
  edgeDataList: EdgeData[];
  _nodeCount: number;
  communities: CommunityData[];
  nodeCommMap: Map<number, string>;

  // GPU 缓冲控制方法
  _setCoreVisible(i: number, v: boolean): void;
  _setGlowAlpha(i: number, a: number): void;
  _setGlowColor(i: number, c: number): void;
  _setCoreColor(i: number, c: number): void;
  _setGlow2Alpha(i: number, a: number): void;
  _glow2Rgba: Float32Array;

  // 场景对象
  edgeLineGroups: LineSegments2[];
  highlightEdgeGroup: THREE.Group;
  galaxyGroup: THREE.Group;
  scene: THREE.Scene;

  // 相机
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;

  // 渲染
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloomPass: UnrealBloomPass;
  glowTex: THREE.Texture;

  // DOM
  container: HTMLElement;
  tooltipEl: HTMLDivElement;

  // 飞行/聚焦状态
  focusActive: boolean;
  focusProgress: number;
  focusStartCam: THREE.Vector3;
  focusStartLook: THREE.Vector3;
  _focusStartTime: number;
  _focusDurationMs: number;
  focusTarget: THREE.Vector3;
  _focusLookTarget: THREE.Vector3;
  focusNodeIdx: number;
  focusFlash: number;
  _userInteracting: boolean;
  _flyDebounce: ReturnType<typeof setTimeout> | null;

  // 空间
  _graphRadius: number;

  // Hover
  hoveredIdx: number;
  hoveredGalaxyIdx: number;

  // 工具
  tmpVec3: THREE.Vector3;
}

// ═══════════════════════════════════════════════════════════════
// GraphFold
// ═══════════════════════════════════════════════════════════════

export class GraphFold {
  static readonly CONSTELLATION_COLOR = 0xffaa44;
  /** Communities with fewer members than this are hidden from the galaxy view. */
  static readonly MIN_GALAXY_SIZE = 5;

  // State
  foldMode = false;
  enteredGalaxyId: string | null = null;
  enteredSubCommunityId: string | null = null;
  _drillStack: string[] = [];
  _subCommByNodeIdx = new Map<number, string>();
  commFoldGroup = new THREE.Group();
  communityRingGroup = new THREE.Group();
  galaxyMeta: GalaxyMeta[] = [];
  galaxyClouds: THREE.Points[] = [];
  galaxyGlows: THREE.Object3D[] = [];
  _communityGlowSprites: THREE.Sprite[] = [];
  _hoveredCommunityIdx = -1;
  galaxyTitleEl!: HTMLDivElement;
  galaxyLabelDivs: HTMLDivElement[] = [];
  _savedGalaxyMeta: GalaxyMeta[] | null = null;
  _constellationLookTarget = new THREE.Vector3();
  crossFlowParticles!: THREE.Points;
  crossFlowData: { segIdx: number; t: number; speed: number }[] = [];
  crossFlowSegments: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }[] = [];

  constructor(private host: FoldHost) {}

  // ── Internal helpers ──────────────────────────────────────

  /** Hide all node cores and glows. */
  private _hideAllNodes(): void {
    for (let i = 0; i < this.host._nodeCount; i++) {
      this.host._setCoreVisible(i, false);
      this.host._setGlowAlpha(i, 0);
    }
  }

  /** Show specific nodes as constellation (visible core + glow with color). */
  private _showNodes(indices: number[], color: number, glowAlpha = 0.55): void {
    for (const mi of indices) {
      if (mi < this.host._nodeCount) {
        this.host._setCoreVisible(mi, true);
        this.host._setCoreColor(mi, color);
        this.host._setGlowAlpha(mi, glowAlpha);
        this.host._setGlowColor(mi, color);
      }
    }
  }

  /** Build and add LineSegments to commFoldGroup. */
  private _addLineSegments(verts: number[], colors: number[], opacity: number): void {
    if (verts.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.commFoldGroup.add(
      new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      ),
    );
  }

  /** Set up camera fly-to animation targeting a centroid. */
  private _flyTo(centroid: THREE.Vector3, clusterRadius: number, viewDist: number,
    camOffset: [number, number, number] = [0.5, 0.4, 0.7]): void {
    this.host.focusTarget.copy(
      centroid.clone().add(new THREE.Vector3(viewDist * camOffset[0], viewDist * camOffset[1], viewDist * camOffset[2])),
    );
    this.host.focusStartCam.copy(this.host.camera.position);
    this.host.focusStartLook.copy(this.host.controls.target);
    this._constellationLookTarget = centroid.clone();
    this.host.focusActive = true;
    this.host.focusProgress = 0;
    this.host.focusNodeIdx = -1;
    this.host.focusFlash = 0;
    this.host._focusStartTime = performance.now();
    this.host.controls.target.copy(centroid);
    this.host.controls.minDistance = clusterRadius * 1.5;
    this.host.controls.maxDistance = clusterRadius * 8;
  }

  /** Filter sub-communities by parent ID and minimum level. */
  private _filterSubCommunities(parentId: string, minLevel: number): CommunityData[] {
    return this.host.communities.filter((c) => {
      if (!c.parent_id || c.parent_id !== parentId) return false;
      const lvl = Number(c.level);
      return !Number.isNaN(lvl) && lvl >= minLevel;
    });
  }

  // ── Getters ────────────────────────────────────────────────

  get isFolded(): boolean {
    return this.foldMode;
  }
  get isInsideGalaxy(): boolean {
    return this.enteredGalaxyId !== null;
  }
  get communityCount(): number {
    return this.host.communities.length;
  }

  // ═══════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════

  /** Toggle galaxy fold overlay on/off. Re-renders from stored data. */
  setFoldMode(on: boolean): void {
    if (on === this.foldMode) return;
    this.foldMode = on;
    this.enteredGalaxyId = null;
    if (on) {
      this.host.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.host.renderer.toneMappingExposure = 0.6;
      if (true) {
        if (this.host.composer.passes.indexOf(this.host.bloomPass) === -1) {
          this.host.composer.addPass(this.host.bloomPass);
        }
        this.host.bloomPass.strength = 0.2;
        this.host.bloomPass.threshold = 0.9;
      }
      this.applyFoldOverlay();
      this.initCrossEdgeFlow();
      useShellStore.getState().setStatusText(`${this.galaxyMeta.length} 星团 · 点击进入或搜索`);
    } else {
      this.clearFoldOverlay();
      if (true) {
        this.host.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.host.renderer.toneMappingExposure = 1.4;
        this.host.bloomPass.strength = 0.35;
        this.host.bloomPass.threshold = 0.85;
        if (this.host.composer.passes.indexOf(this.host.bloomPass) === -1) {
          this.host.composer.addPass(this.host.bloomPass);
        }
      } else {
        this.host.renderer.toneMapping = THREE.NoToneMapping;
        this.host.renderer.toneMappingExposure = 1.0;
      }
    }
  }

  toggleFold(): void {
    this.setFoldMode(!this.foldMode);
  }

  // ═══════════════════════════════════════════════════════════
  // Community rings + hover
  // ═══════════════════════════════════════════════════════════

  _buildCommunityRings(): void {
    while (this.communityRingGroup.children.length > 0) {
      this.communityRingGroup.remove(this.communityRingGroup.children[0]);
    }
    this._communityGlowSprites = [];
    const size = 128;
    const cvs = document.createElement('canvas');
    cvs.width = size;
    cvs.height = size;
    const ctx = cvs.getContext('2d')!;
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.75, 'rgba(255,255,255,0.06)');
    gradient.addColorStop(0.9, 'rgba(255,255,255,0.18)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const glowTex = new THREE.CanvasTexture(cvs);

    for (let gi = 0; gi < this.galaxyMeta.length; gi++) {
      const gm = this.galaxyMeta[gi];
      if (gm.radius <= 0) continue;
      const hue = ((gm.id.split('').reduce((h, c) => (h << 5) - h + c.charCodeAt(0), 0) & 0x7fffffff) % 360) / 360;
      const color = new THREE.Color().setHSL(hue, 0.3, 0.5);
      const mat = new THREE.SpriteMaterial({
        map: glowTex,
        color,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(gm.centroid);
      sprite.scale.setScalar(gm.radius * 2.5);
      this.communityRingGroup.add(sprite);
      this._communityGlowSprites.push(sprite);
    }
  }

  _updateCommunityRingHover(): void {
    const prev = this._hoveredCommunityIdx;
    let next = -1;
    if (this.host.hoveredIdx >= 0 && this.host.hoveredIdx < this.host._nodeCount) {
      for (let gi = 0; gi < this.galaxyMeta.length; gi++) {
        if (this.galaxyMeta[gi].memberIndices.includes(this.host.hoveredIdx)) {
          next = gi;
          break;
        }
      }
    }
    if (next === prev) return;
    if (prev >= 0 && this._communityGlowSprites[prev]) {
      (this._communityGlowSprites[prev].material as THREE.SpriteMaterial).opacity = 0;
    }
    if (next >= 0 && this._communityGlowSprites[next]) {
      (this._communityGlowSprites[next].material as THREE.SpriteMaterial).opacity = 0.25;
    }
    this._hoveredCommunityIdx = next;
  }

  // ═══════════════════════════════════════════════════════════
  // Fold overlay
  // ═══════════════════════════════════════════════════════════

  applyFoldOverlay(): void {
    this._hideAllNodes();
    if (this.host._glow2Rgba.length > 0) {
      for (let i = 0; i < this.host._nodeCount; i++) this.host._setGlow2Alpha(i, 0);
    }
    for (const lines of this.host.edgeLineGroups) {
      lines.visible = false;
    }
    while (this.host.highlightEdgeGroup.children.length) {
      this.host.highlightEdgeGroup.remove(this.host.highlightEdgeGroup.children[0]);
    }
    if (this.enteredGalaxyId) {
      this._showConstellation(this.enteredGalaxyId);
    } else {
      this.buildGalaxyClouds();
    }
  }

  clearFoldOverlay(): void {
    this.host.hoveredGalaxyIdx = -1;
    this.hideGalaxyTitle();
    for (let i = 0; i < this.host._nodeCount; i++) {
      const kind = ((this.host.graphNodes[i].type || this.host.graphNodes[i].kind || 'symbol') as string).toLowerCase();
      const glowColor = GLOW_COLORS[kind] || 0x4488cc;
      const coreColor = glowColor;
      this.host._setCoreVisible(i, true);
      this.host._setCoreColor(i, coreColor);
      this.host._setGlowAlpha(i, 0.55);
      this.host._setGlowColor(i, glowColor);
    }
    for (const lines of this.host.edgeLineGroups) {
      lines.visible = true;
      (lines.material as LineMaterial).opacity = edgeOpacityByDepth((lines.userData.edgeDepth as number) ?? 0);
    }
    this._disposeFoldChildren();
    this.clearCrossEdgeFlow();
    this.galaxyClouds = [];
    this.galaxyGlows = [];
  }

  _disposeFoldChildren(): void {
    while (this.commFoldGroup.children.length) {
      const child = this.commFoldGroup.children[0];
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material;
      if (mat) {
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
      this.commFoldGroup.remove(child);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Constellation (inside galaxy)
  // ═══════════════════════════════════════════════════════════

  _showConstellation(galaxyId: string): number {
    const gm = this.galaxyMeta.find((g) => g.id === galaxyId);
    if (!gm) return 0;
    const cc = new THREE.Color(GraphFold.CONSTELLATION_COLOR);
    this._showNodes(gm.memberIndices, GraphFold.CONSTELLATION_COLOR);
    const pos = this.host.nodePositions;
    const verts: number[] = [],
      colors: number[] = [];
    const memberSet = new Set(gm.memberIndices);
    for (let ei = 0; ei < this.host.edgeDataList.length; ei++) {
      const { s, t } = this.host.edgeDataList[ei];
      if (!memberSet.has(s) || !memberSet.has(t)) continue;
      verts.push(pos[s * 3], pos[s * 3 + 1], pos[s * 3 + 2], pos[t * 3], pos[t * 3 + 1], pos[t * 3 + 2]);
      colors.push(cc.r, cc.g, cc.b, cc.r, cc.g, cc.b);
    }
    this._addLineSegments(verts, colors, 0.06);

    const subCommunities = this._filterSubCommunities(galaxyId, 1);
    let subCount = 0;
    this._subCommByNodeIdx.clear();
    if (subCommunities.length > 0) {
      const subColors = [0x66aaff, 0xff66aa, 0x66ffaa, 0xffaa66, 0xaa66ff];
      subCommunities.forEach((subComm, idx) => {
        const subColor = new THREE.Color(subColors[idx % subColors.length]);
        const subMembers: number[] = [];
        for (const nid of subComm.node_ids) {
          const nodeIdx = this.host.graphNodes.findIndex((n) => n.id === nid);
          if (nodeIdx >= 0) {
            subMembers.push(nodeIdx);
            this._subCommByNodeIdx.set(nodeIdx, subComm.id);
          }
        }
        if (subMembers.length > 0) subCount++;
        for (const mi of subMembers) {
          if (mi < this.host._nodeCount) {
            this.host._setCoreColor(mi, subColor.getHex());
          }
          if (mi < this.host._nodeCount) {
            this.host._setGlowColor(mi, subColor.getHex());
          }
        }
      });
    }
    return subCount;
  }

  // ═══════════════════════════════════════════════════════════
  // Enter / Exit galaxy
  // ═══════════════════════════════════════════════════════════

  enterGalaxy(galaxyId: string): void {
    if (!this.foldMode || this.enteredGalaxyId === galaxyId) return;
    this.enteredGalaxyId = galaxyId;
    this.enteredSubCommunityId = null;
    this._drillStack = [];
    this.host.hoveredGalaxyIdx = -1;
    this.host.container.style.cursor = '';
    this.host.tooltipEl?.classList.remove('visible');
    this._disposeFoldChildren();
    this.galaxyClouds = [];
    this.galaxyGlows = [];

    const subCommunities = this._filterSubCommunities(galaxyId, 1);

    if (subCommunities.length > 0) {
      this._showSubCommunityClouds(subCommunities);
      const gm = this.galaxyMeta.find((g) => g.id === galaxyId);
      this.showGalaxyTitle(gm);
      useShellStore.getState().setStatusText(`${gm?.label || galaxyId} · ${subCommunities.length} 子星团 · 点击进入或 ESC 退回`);
    } else {
      this._showConstellation(galaxyId);
      const gm = this.galaxyMeta.find((g) => g.id === galaxyId);
      if (gm) {
        let clusterRadius = 30;
        for (const mi of gm.memberIndices) {
          const dx = this.host.nodePositions[mi * 3] - gm.centroid.x;
          const dy = this.host.nodePositions[mi * 3 + 1] - gm.centroid.y;
          const dz = this.host.nodePositions[mi * 3 + 2] - gm.centroid.z;
          clusterRadius = Math.max(clusterRadius, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        const viewDist = clusterRadius * 3.2;
        this._flyTo(gm.centroid, clusterRadius, viewDist, [0.55, 0.4, 0.7]);
        this.host.controls.enablePan = true;
      }
      this.showGalaxyTitle(gm);
      useShellStore.getState().setStatusText(`星座: ${gm?.label || galaxyId} · ${gm?.memberIndices.length || 0} 节点 · ESC 退回`);
    }
  }

  _showSubCommunityClouds(subCommunities: CommunityData[]): void {
    const subMeta: GalaxyMeta[] = [];
    for (const sc of subCommunities) {
      const memberIndices: number[] = [];
      let sx = 0,
        sy = 0,
        sz = 0;
      for (const nid of sc.node_ids) {
        const idx = this.host.graphNodes.findIndex((n) => n.id === nid);
        if (idx >= 0) {
          memberIndices.push(idx);
          sx += this.host.nodePositions[idx * 3];
          sy += this.host.nodePositions[idx * 3 + 1];
          sz += this.host.nodePositions[idx * 3 + 2];
        }
      }
      if (memberIndices.length === 0) continue;
      subMeta.push({
        id: sc.id,
        label: sc.label,
        centroid: new THREE.Vector3(sx / memberIndices.length, sy / memberIndices.length, sz / memberIndices.length),
        memberIndices,
        radius: 0,
      });
    }
    this._hideAllNodes();
    if (!this._savedGalaxyMeta) this._savedGalaxyMeta = this.galaxyMeta;
    this.galaxyMeta = subMeta;
    this.buildGalaxyClouds();
    for (let i = 0; i < this.galaxyGlows.length; i++) {
      this.galaxyGlows[i].scale.multiplyScalar(i % 2 === 1 ? 0.4 : 0.35);
    }
    for (const cloud of this.galaxyClouds) {
      cloud.scale.multiplyScalar(0.6);
    }

    if (subMeta.length > 0) {
      let cx = 0,
        cy = 0,
        cz = 0;
      for (const sm of subMeta) {
        cx += sm.centroid.x;
        cy += sm.centroid.y;
        cz += sm.centroid.z;
      }
      cx /= subMeta.length;
      cy /= subMeta.length;
      cz /= subMeta.length;
      let maxR = 30;
      for (const sm of subMeta) {
        const dx = sm.centroid.x - cx,
          dy = sm.centroid.y - cy,
          dz = sm.centroid.z - cz;
        maxR = Math.max(maxR, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
      const centroid = new THREE.Vector3(cx, cy, cz);
      const viewDist = Math.max(maxR * 3.0, 120);
      this._flyTo(centroid, maxR, viewDist);
      this.host.controls.maxDistance = maxR * 12;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Title / Label
  // ═══════════════════════════════════════════════════════════

  showGalaxyTitle(gm: { id: string; label: string } | undefined): void {
    if (!this.galaxyTitleEl) {
      this.galaxyTitleEl = document.createElement('div');
      this.galaxyTitleEl.id = 'galaxy-title';
      this.galaxyTitleEl.style.cssText =
        'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:15;' +
        'font-size: calc(18px * var(--font-scale));font-weight:700;letter-spacing:1px;pointer-events:none;' +
        'color:#ffcc80;text-shadow:0 0 20px rgba(255,160,40,0.6),0 0 40px rgba(255,100,20,0.3);' +
        'transition:opacity 0.3s;opacity:0;';
      this.host.container.appendChild(this.galaxyTitleEl);
    }
    const shortName = gm ? gm.label.split('/')[0].replace(/_/g, ' ') : '';
    this.galaxyTitleEl.textContent = `🌌 ${shortName}`;
    this.galaxyTitleEl.style.opacity = '1';
  }

  hideGalaxyTitle(): void {
    if (this.galaxyTitleEl) this.galaxyTitleEl.style.opacity = '0';
  }

  showGalaxyLabel(gm: { id: string; label: string; centroid: THREE.Vector3 } | undefined): void {
    if (!gm) return;
    const label = document.createElement('div');
    label.className = 'galaxy-flash-label';
    label.textContent = `🌌 ${gm.label || gm.id}`;
    label.style.cssText =
      'position:absolute;z-index:12;pointer-events:none;font-size: calc(16px * var(--font-scale));font-weight:700;color:#ffe0a0;text-shadow:0 0 20px rgba(255,180,60,0.8),0 0 40px rgba(255,140,30,0.4);white-space:nowrap;opacity:0;transition:opacity 0.2s;';
    const halfW = this.host.container.clientWidth * 0.5,
      halfH = this.host.container.clientHeight * 0.5;
    this.host.tmpVec3.copy(gm.centroid).project(this.host.camera);
    label.style.left = `${this.host.tmpVec3.x * halfW + halfW}px`;
    label.style.top = `${-this.host.tmpVec3.y * halfH + halfH}px`;
    label.style.transform = 'translate(-50%, -50%)';
    this.host.container.appendChild(label);
    requestAnimationFrame(() => {
      label.style.opacity = '1';
    });
    setTimeout(() => {
      label.style.opacity = '0';
      setTimeout(() => label.remove(), 300);
    }, 1800);
  }

  _hasVisibleSubCommunities(parentId: string): boolean {
    return this.host.communities.some((c) => {
      if (!c.parent_id || c.parent_id !== parentId) return false;
      const lvl = Number(c.level);
      return !Number.isNaN(lvl) && lvl >= 1 && c.node_ids.length >= 4;
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Exit galaxy
  // ═══════════════════════════════════════════════════════════

  exitGalaxy(): void {
    if (!this.foldMode || !this.enteredGalaxyId) return;
    this.enteredGalaxyId = null;
    this.enteredSubCommunityId = null;
    this._drillStack = [];
    this.hideGalaxyTitle();
    this.host.controls.enablePan = true;
    this.host.controls.minDistance = Math.max(1, this.host._graphRadius * 0.005);
    this.host.controls.maxDistance = this.host._graphRadius * 6;
    this.host.camera.near = Math.max(0.1, this.host.controls.minDistance * 0.5);
    this.host.camera.far = this.host.controls.maxDistance * 2;
    this.host.camera.updateProjectionMatrix();
    this._disposeFoldChildren();
    if (this._savedGalaxyMeta) {
      this.galaxyMeta = this._savedGalaxyMeta;
      this._savedGalaxyMeta = null;
    }
    this.applyFoldOverlay();
    useShellStore.getState().setStatusText(`${this.galaxyMeta.length} 星团 · 点击进入或搜索`);
  }

  // ═══════════════════════════════════════════════════════════
  // Sub-community drill
  // ═══════════════════════════════════════════════════════════

  enterSubCommunity(subCommId: string): void {
    if (!this.foldMode || !this.enteredGalaxyId || this.enteredSubCommunityId === subCommId) return;
    const subComm = this.host.communities.find((c) => c.id === subCommId);
    if (!subComm) return;
    this._drillStack.push(subCommId);
    this.enteredSubCommunityId = subCommId;
    this.host.hoveredGalaxyIdx = -1;
    this.host.container.style.cursor = '';
    this.host.tooltipEl?.classList.remove('visible');
    this._disposeFoldChildren();
    this.galaxyClouds = [];
    this.galaxyGlows = [];

    const deeperSubs = this._filterSubCommunities(subCommId, 2);

    if (deeperSubs.length > 0) {
      this._showSubCommunityClouds(deeperSubs);
      const shortName = subComm.label.split('/')[0].replace(/_/g, ' ');
      this.showGalaxyTitle({ id: subCommId, label: subComm.label });
      useShellStore.getState().setStatusText(`子社区: ${shortName} · ${deeperSubs.length} 子星团 · 点击进入或 ESC 退回`);
    } else {
      this._hideAllNodes();
      const shownIndices: number[] = [];
      for (const nid of subComm.node_ids) {
        const idx = this.host.graphNodes.findIndex((n) => n.id === nid);
        if (idx >= 0) {
          shownIndices.push(idx);
        }
      }
      this._showNodes(shownIndices, 0xffaa44, 0.7);
      this._buildSubCommunityEdges(subComm.node_ids);
      let sx = 0,
        sy = 0,
        sz = 0;
      for (const mi of shownIndices) {
        sx += this.host.nodePositions[mi * 3];
        sy += this.host.nodePositions[mi * 3 + 1];
        sz += this.host.nodePositions[mi * 3 + 2];
      }
      const centroid = new THREE.Vector3(sx / shownIndices.length, sy / shownIndices.length, sz / shownIndices.length);
      let clusterRadius = 30;
      for (const mi of shownIndices) {
        const dx = this.host.nodePositions[mi * 3] - centroid.x;
        const dy = this.host.nodePositions[mi * 3 + 1] - centroid.y;
        const dz = this.host.nodePositions[mi * 3 + 2] - centroid.z;
        clusterRadius = Math.max(clusterRadius, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
      const viewDist = clusterRadius * 3.5;
      this._flyTo(centroid, clusterRadius, viewDist);
      const shortName = subComm.label.split('/')[0].replace(/_/g, ' ');
      this.showGalaxyTitle({ id: subCommId, label: subComm.label });
      useShellStore.getState().setStatusText(`子社区: ${shortName} · ${shownIndices.length} 节点 · ESC 退回`);
    }
  }

  exitSubCommunity(): void {
    if (!this.foldMode || this._drillStack.length === 0) return;
    this._drillStack.pop();
    this._disposeFoldChildren();
    this.galaxyClouds = [];
    this.galaxyGlows = [];

    if (this._drillStack.length > 0) {
      const parentSubId = this._drillStack[this._drillStack.length - 1];
      this.enteredSubCommunityId = parentSubId;
      const parentSub = this.host.communities.find((c) => c.id === parentSubId);
      if (!parentSub) return;
      if (this._hasVisibleSubCommunities(parentSubId)) {
        const deeperSubs = this._filterSubCommunities(parentSubId, 2);
        this._showSubCommunityClouds(deeperSubs);
        const shortName = parentSub.label.split('/')[0].replace(/_/g, ' ');
        this.showGalaxyTitle({ id: parentSubId, label: parentSub.label });
        useShellStore.getState().setStatusText(`子社区: ${shortName} · ${deeperSubs.length} 子星团 · 点击进入或 ESC 退回`);
      } else {
        this._hideAllNodes();
        const shownIndices: number[] = [];
        for (const nid of parentSub.node_ids) {
          const idx = this.host.graphNodes.findIndex((n) => n.id === nid);
          if (idx >= 0) shownIndices.push(idx);
        }
        this._showNodes(shownIndices, 0xffaa44, 0.7);
        this._buildSubCommunityEdges(parentSub.node_ids);
        const shortName = parentSub.label.split('/')[0].replace(/_/g, ' ');
        this.showGalaxyTitle({ id: parentSubId, label: parentSub.label });
        useShellStore.getState().setStatusText(`子社区: ${shortName} · ${shownIndices.length} 节点 · ESC 退回`);
      }
    } else {
      this.enteredSubCommunityId = null;
      const galaxyId = this.enteredGalaxyId;
      if (!galaxyId) return;
      if (this._hasVisibleSubCommunities(galaxyId)) {
        const subCommunities = this._filterSubCommunities(galaxyId, 1);
        this._showSubCommunityClouds(subCommunities);
        const gm = this.galaxyMeta.find((g) => g.id === galaxyId);
        this.showGalaxyTitle(gm);
        useShellStore.getState().setStatusText(`${gm?.label || galaxyId} · ${subCommunities.length} 子星团 · 点击进入或 ESC 退回`);
      } else {
        this._showConstellation(galaxyId);
        const gm = this.galaxyMeta.find((g) => g.id === galaxyId);
        this.showGalaxyTitle(gm);
        useShellStore.getState().setStatusText(`星座: ${gm?.label || galaxyId} · ${gm?.memberIndices.length || 0} 节点 · ESC 退回`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Sub-community edges
  // ═══════════════════════════════════════════════════════════

  _buildSubCommunityEdges(nodeIds: string[]): void {
    const memberSet = new Set(nodeIds);
    const pos = this.host.nodePositions;
    const verts: number[] = [],
      colors: number[] = [];
    const cc = new THREE.Color(0xffaa44);
    for (const d of this.host.edgeDataList) {
      const nidS = this.host.graphNodes[d.s]?.id,
        nidT = this.host.graphNodes[d.t]?.id;
      if (!nidS || !nidT) continue;
      if (!memberSet.has(nidS) || !memberSet.has(nidT)) continue;
      verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
      colors.push(cc.r, cc.g, cc.b, cc.r, cc.g, cc.b);
    }
    this._addLineSegments(verts, colors, 0.08);
  }

  // ═══════════════════════════════════════════════════════════
  // Galaxy clouds + labels + cross edges
  // ═══════════════════════════════════════════════════════════

  buildGalaxyClouds(): void {
    this.galaxyClouds = [];
    this.galaxyGlows = [];
    for (let gi = 0; gi < this.galaxyMeta.length; gi++) {
      const gm = this.galaxyMeta[gi];
      const sizeByCount = Math.cbrt(gm.memberIndices.length) * 8;
      const r = Math.min(sizeByCount, Math.max(20, gm.radius || 30) * 0.5);
      const colorHex = communityColor(gm.id);
      const color = new THREE.Color(colorHex);

      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.host.glowTex,
          color,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
          opacity: 0.1,
        }),
      );
      halo.position.copy(gm.centroid);
      halo.scale.setScalar(r * 1.15);
      halo.userData = { galaxyIndex: gi, galaxyId: gm.id };
      this.commFoldGroup.add(halo);
      this.galaxyGlows.push(halo);

      const core = new THREE.Mesh(
        new THREE.SphereGeometry(r, 32, 24),
        new THREE.ShaderMaterial({
          uniforms: { uColor: { value: new THREE.Color(colorHex) }, uOpacity: { value: 1.0 } },
          vertexShader: /* glsl */ `
            varying vec3 vNormal;
            varying vec3 vViewDir;
            void main() {
              vec4 mv = modelViewMatrix * vec4(position, 1.0);
              gl_Position = projectionMatrix * mv;
              vNormal = normalize(normalMatrix * normal);
              vViewDir = normalize(-mv.xyz);
            }
          `,
          fragmentShader: /* glsl */ `
            uniform vec3 uColor;
            uniform float uOpacity;
            varying vec3 vNormal;
            varying vec3 vViewDir;
            void main() {
              float f = 1.0 - abs(dot(normalize(vNormal), normalize(vViewDir)));
              float edge = pow(f, 2.5);
              vec3 col = mix(uColor * 0.15, uColor * 1.6, edge);
              float alpha = (0.35 + edge * 0.55) * uOpacity;
              gl_FragColor = vec4(col, alpha);
            }
          `,
          transparent: true,
          depthWrite: false,
          side: THREE.FrontSide,
          blending: THREE.NormalBlending,
        }),
      );
      core.position.copy(gm.centroid);
      core.userData = { galaxyIndex: gi, galaxyId: gm.id };
      this.commFoldGroup.add(core);
      this.galaxyGlows.push(core);
    }
    this.buildCrossEdges();
    this.buildGalaxyLabels();
  }

  buildGalaxyLabels(): void {
    for (const d of this.galaxyLabelDivs) d.remove();
    this.galaxyLabelDivs = [];
    const maxLabels = Math.min(15, this.galaxyMeta.length);
    for (let gi = 0; gi < maxLabels; gi++) {
      const gm = this.galaxyMeta[gi];
      const div = document.createElement('div');
      div.className = 'galaxy-label';
      const shortName = gm.label
        .split('/')[0]
        .replace(/^test_/, '')
        .replace(/_/g, ' ');
      div.textContent = shortName.length > 24 ? shortName.slice(0, 22) + '\u2026' : shortName;
      div.style.cssText =
        'position:absolute;z-index:3;pointer-events:none;font-size: calc(10px * var(--font-scale));color:var(--obs-text,rgba(200,200,220,0.55));text-shadow:0 0 6px rgba(0,0,0,0.7);white-space:nowrap;transform:translate(-50%,-50%);';
      this.host.container.appendChild(div);
      div.dataset.galaxyIndex = String(gi);
      div.dataset.galaxyId = gm.id;
      this.galaxyLabelDivs.push(div);
    }
  }

  buildCrossEdges(): void {
    const seen = new Set<string>();
    const verts: number[] = [],
      colors: number[] = [];
    const _pos = this.host.nodePositions;
    for (const d of this.host.edgeDataList) {
      const sc = this.host.nodeCommMap.get(d.s),
        tc = this.host.nodeCommMap.get(d.t);
      if (!sc && !tc) continue;
      if (sc === tc) continue;
      const key =
        [sc || '', tc || ''].sort((a, b) => a.localeCompare(b)).join('::') + `::${d.edgeType}::${d.direction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const gs = sc ? this.galaxyMeta.find((g) => g.id === sc) : null;
      const gt = tc ? this.galaxyMeta.find((g) => g.id === tc) : null;
      if (!gs || !gt) continue;
      verts.push(gs.centroid.x, gs.centroid.y, gs.centroid.z, gt.centroid.x, gt.centroid.y, gt.centroid.z);
      const c = edgeColorByType(d.edgeType, d.direction, d.crossFile, d.ambiguous);
      colors.push(c.r * 1.2, c.g * 1.2, c.b * 1.2, c.r * 1.2, c.g * 1.2, c.b * 1.2);
    }
    this._addLineSegments(verts, colors, 0.08);
  }

  // ═══════════════════════════════════════════════════════════
  // Cross-edge energy flow
  // ═══════════════════════════════════════════════════════════

  initCrossEdgeFlow(): void {
    if (this.crossFlowParticles) {
      this.commFoldGroup.remove(this.crossFlowParticles);
      this.crossFlowParticles.geometry.dispose();
      (this.crossFlowParticles.material as THREE.Material).dispose();
    }
    this.crossFlowSegments = [];
    const seen = new Set<string>();
    for (const d of this.host.edgeDataList) {
      const sc = this.host.nodeCommMap.get(d.s),
        tc = this.host.nodeCommMap.get(d.t);
      if (!sc || !tc || sc === tc) continue;
      const gs = this.galaxyMeta.find((g) => g.id === sc);
      const gt = this.galaxyMeta.find((g) => g.id === tc);
      if (!gs || !gt) continue;
      const key = [sc, tc].sort((a, b) => a.localeCompare(b)).join('::');
      if (seen.has(key)) continue;
      seen.add(key);
      this.crossFlowSegments.push({
        x1: gs.centroid.x,
        y1: gs.centroid.y,
        z1: gs.centroid.z,
        x2: gt.centroid.x,
        y2: gt.centroid.y,
        z2: gt.centroid.z,
      });
    }
    if (this.crossFlowSegments.length === 0) return;
    const totalParticles = this.crossFlowSegments.length * 5;
    const pArr = new Float32Array(totalParticles * 3);
    const cArr = new Float32Array(totalParticles * 3);
    this.crossFlowData = [];
    for (let i = 0; i < totalParticles; i++) {
      const segIdx = i % this.crossFlowSegments.length;
      const seg = this.crossFlowSegments[segIdx];
      const t = Math.random();
      pArr[i * 3] = seg.x1 + (seg.x2 - seg.x1) * t;
      pArr[i * 3 + 1] = seg.y1 + (seg.y2 - seg.y1) * t;
      pArr[i * 3 + 2] = seg.z1 + (seg.z2 - seg.z1) * t;
      const colorChoice = Math.random();
      if (colorChoice < 0.4) {
        cArr[i * 3] = 0.12;
        cArr[i * 3 + 1] = 0.28;
        cArr[i * 3 + 2] = 0.32;
      } else if (colorChoice < 0.8) {
        cArr[i * 3] = 0.3;
        cArr[i * 3 + 1] = 0.24;
        cArr[i * 3 + 2] = 0.1;
      } else {
        cArr[i * 3] = 0.28;
        cArr[i * 3 + 1] = 0.26;
        cArr[i * 3 + 2] = 0.24;
      }
      this.crossFlowData.push({ segIdx, t, speed: 0.004 + Math.random() * 0.012 });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pArr, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(cArr, 3));
    const mat = new THREE.PointsMaterial({
      size: 2.0,
      map: this.host.glowTex,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.03,
    });
    this.crossFlowParticles = new THREE.Points(geo, mat);
    this.commFoldGroup.add(this.crossFlowParticles);
  }

  animateCrossEdgeFlow(): void {
    if (!this.crossFlowParticles || this.crossFlowSegments.length === 0) return;
    const pArr = this.crossFlowParticles.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < this.crossFlowData.length; i++) {
      const fd = this.crossFlowData[i];
      fd.t += fd.speed;
      if (fd.t > 1.1) fd.t = -0.1;
      if (fd.t < 0) fd.t += 1.1;
      const seg = this.crossFlowSegments[fd.segIdx];
      if (!seg) continue;
      const t = Math.max(0, Math.min(1, fd.t));
      pArr[i * 3] = seg.x1 + (seg.x2 - seg.x1) * t;
      pArr[i * 3 + 1] = seg.y1 + (seg.y2 - seg.y1) * t;
      pArr[i * 3 + 2] = seg.z1 + (seg.z2 - seg.z1) * t;
    }
    this.crossFlowParticles.geometry.attributes.position.needsUpdate = true;
  }

  clearCrossEdgeFlow(): void {
    if (this.crossFlowParticles) {
      this.commFoldGroup.remove(this.crossFlowParticles);
      this.crossFlowParticles.geometry.dispose();
      (this.crossFlowParticles.material as THREE.Material).dispose();
    }
    this.crossFlowData = [];
    this.crossFlowSegments = [];
  }
}