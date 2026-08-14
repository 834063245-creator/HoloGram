// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// GraphFocusController — 相机飞行/聚焦/聚焦子图
// 从 graph.ts 拆分（P4）。飞行状态字段仍由 facade 持有
// （GraphFold 经 FoldHost 直接读写），本模块只持有私有保存槽。
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { t } from './kernel-i18n';
import { edgeColorByType } from './graph-colors';
import type { GraphFold } from './graph-fold';
import type { EdgeData, GraphNode } from './graph-types';
import { buildFocusBanner } from './graph-ui';
import { iconHtml } from './icons';

// ── FocusHost — GraphFocusController 需要从 StarGraph 访问的成员 ──

export interface FocusHost {
  container: HTMLElement;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;

  // 飞行/聚焦状态（facade 持有，GraphFold 也直接读写）
  focusTarget: THREE.Vector3;
  focusActive: boolean;
  focusProgress: number;
  focusNodeIdx: number;
  focusFlash: number;
  focusStartCam: THREE.Vector3;
  focusStartLook: THREE.Vector3;
  _focusLookTarget: THREE.Vector3;
  _focusStartTime: number;
  _focusDurationMs: number;
  _userInteracting: boolean;
  _flyDebounce: ReturnType<typeof setTimeout> | null;
  _initCamPos: THREE.Vector3;
  _initCamTarget: THREE.Vector3;

  // 图数据
  graphNodes: GraphNode[];
  nodePositions: Float32Array;
  deg: number[];
  neighborMap: number[][];
  edgeDataList: EdgeData[];
  nodeCommMap: Map<number, string>;
  _nodeCount: number;
  _deadIndices: Set<number>;

  // GPU 缓冲
  _overrideFlags: Float32Array;
  _glowRgba: Float32Array;
  _coreScales: Float32Array;
  nodeCoreColors: number[];
  nodeGlowColors: number[];

  // 场景
  edgeLineGroups: LineSegments2[];
  highlightEdgeGroup: THREE.Group;

  // 聚焦子图状态（facade 持有，analysis/tooltip/edge-renderer 也读）
  focusSubgraphActive: boolean;
  focusSubgraphIdx: number;
  focusSubgraphVisibleIndices: Set<number>;
  focusSubgraphBanner: HTMLDivElement;

  _fold: GraphFold;

  _setGlowAlpha(i: number, a: number): void;
  _setGlowColor(i: number, c: number | THREE.Color, a?: number): void;
  _setCoreColor(i: number, c: number | THREE.Color): void;
  _setCoreScale(i: number, s: number): void;
  _setCoreVisible(i: number, v: boolean): void;
  _flushOverrideAttrs(): void;
  getNodeBaseScale(i: number): number;
}

// ═══════════════════════════════════════════════════════════════
// GraphFocusController
// ═══════════════════════════════════════════════════════════════

export class GraphFocusController {
  private _resettingCamera = false;
  private _savedFocusCoreScale = 0;
  private _savedFocusGlowScale = 1.0;
  private focusSubgraphSavedGlowOpacities: number[] = [];
  private focusSubgraphSavedCoreVisible: boolean[] = [];
  private focusSubgraphSavedEdgeOpacities: number[] = [];

  constructor(private host: FocusHost) {}

  // ── 聚焦 ────────────────────────────────────────────────

  private flyToNode(idx: number): void {
    const px = this.host.nodePositions[idx * 3],
      py = this.host.nodePositions[idx * 3 + 1],
      pz = this.host.nodePositions[idx * 3 + 2];
    const dist = 30 + (this.host.deg[idx] || 0) * 4;
    this._planFlight(new THREE.Vector3(px, py, pz), dist);
    this.host.focusNodeIdx = idx;
    this.host.focusFlash = 1;
  }

  // ponytail: 保持当前视线方向飞向 target，不横穿场景；delayMs>0 去抖，连击只飞最后一次
  private _planFlight(targetPos: THREE.Vector3, dist: number, delayMs = 150): void {
    if (this.host._flyDebounce) {
      clearTimeout(this.host._flyDebounce);
      this.host._flyDebounce = null;
    }
    const run = () => {
      const dir = new THREE.Vector3().subVectors(this.host.camera.position, this.host.controls.target);
      if (dir.lengthSq() < 1e-4) dir.set(0.5, 0.4, 0.7);
      dir.normalize();
      this.host.focusTarget.copy(targetPos).add(dir.multiplyScalar(dist));
      this.host._focusLookTarget.copy(targetPos);
      this.host.focusStartCam.copy(this.host.camera.position);
      this.host.focusStartLook.copy(this.host.controls.target);
      this.host.focusActive = true;
      this.host.focusProgress = 0;
      this.host._focusStartTime = performance.now();
    };
    if (delayMs > 0 && !this.host._userInteracting) {
      this.host._flyDebounce = setTimeout(run, delayMs);
    } else {
      run();
    }
  }

  /** 将相机重置到默认概览位置，带平滑动画。 */
  resetCamera(): void {
    if (this.host._initCamPos.lengthSq() < 1) return; // 未初始化
    if (this.host._flyDebounce) {
      clearTimeout(this.host._flyDebounce);
      this.host._flyDebounce = null;
    }
    this.host.focusStartCam.copy(this.host.camera.position);
    this.host.focusStartLook.copy(this.host.controls.target);
    this.host.focusTarget.copy(this.host._initCamPos);
    this.host.focusActive = true;
    this.host.focusProgress = 0;
    this.host.focusNodeIdx = -1;
    this.host.focusFlash = 0;
    this.host._focusStartTime = performance.now();
    this._resettingCamera = true;
  }

  focusNode(query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q || this.host._nodeCount === 0) return false;
    const isAlive = (n: GraphNode | undefined, i: number) => !!n && !this.host._deadIndices.has(i);
    let idx = this.host.graphNodes.findIndex((n, i) => isAlive(n, i) && n.name.toLowerCase() === q);
    if (idx < 0) idx = this.host.graphNodes.findIndex((n, i) => isAlive(n, i) && n.name.toLowerCase().startsWith(q));
    if (idx < 0) idx = this.host.graphNodes.findIndex((n, i) => isAlive(n, i) && n.name.toLowerCase().includes(q));
    if (idx < 0) return false;
    // 如果折叠模式开启，进入该星系而非飞向节点
    if (this.host._fold.foldMode) {
      const cid = this.host.nodeCommMap.get(idx);
      if (cid) {
        this.host._fold.enterGalaxy(cid);
        return true;
      }
      // 孤立节点 — 无法进入，直接飞向
      this.flyToNode(idx);
      return true;
    }
    this.flyToNode(idx);
    return true;
  }

  /** 将相机飞向一组节点索引的质心。 */
  _flyToCentroid(indices: Set<number>): void {
    if (indices.size === 0) return;
    let cx = 0,
      cy = 0,
      cz = 0;
    for (const i of indices) {
      cx += this.host.nodePositions[i * 3];
      cy += this.host.nodePositions[i * 3 + 1];
      cz += this.host.nodePositions[i * 3 + 2];
    }
    const n = indices.size;
    const mx = cx / n,
      my = cy / n,
      mz = cz / n;
    // ponytail: 用包围盒半径算自适应距离，密集星团不贴脸、稀疏区域不偏远
    let r = 0;
    for (const i of indices) {
      const dx = this.host.nodePositions[i * 3] - mx,
        dy = this.host.nodePositions[i * 3 + 1] - my,
        dz = this.host.nodePositions[i * 3 + 2] - mz;
      r = Math.max(r, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    this._planFlight(new THREE.Vector3(mx, my, mz), Math.max(40, r * 3.2));
  }

  updateFocus(): void {
    if (!this.host.focusActive) return;
    const t = easeInOutCubic(Math.min(1, (performance.now() - this.host._focusStartTime) / this.host._focusDurationMs));
    if (this._resettingCamera) {
      this.host.camera.position.lerpVectors(this.host.focusStartCam, this.host.focusTarget, t);
      this.host.controls.target.lerpVectors(this.host.focusStartLook, this.host._initCamTarget, t);
    } else if (this.host._fold.enteredGalaxyId !== null) {
      this.host.camera.position.lerpVectors(this.host.focusStartCam, this.host.focusTarget, t);
      this.host.controls.target.lerpVectors(this.host.focusStartLook, this.host._fold._constellationLookTarget, t);
    } else {
      // ponytail: focusTarget=相机终点(已含视线方向偏移), _focusLookTarget=看向的点
      this.host.camera.position.lerpVectors(this.host.focusStartCam, this.host.focusTarget, t);
      this.host.controls.target.lerpVectors(this.host.focusStartLook, this.host._focusLookTarget, t);
    }
    if (this.host.focusNodeIdx >= 0 && this.host.focusNodeIdx < this.host._nodeCount) {
      if (this.host.focusFlash === 1) {
        this._savedFocusGlowScale = 1.0 /* was glow scale */;
        this._savedFocusCoreScale = this.host._coreScales[this.host.focusNodeIdx];
      }
      const base = this.host.getNodeBaseScale(this.host.focusNodeIdx);
      const flashScale = 1 + Math.sin(t * Math.PI * 2) * 0.5 * this.host.focusFlash;

      this.host._setGlowAlpha(this.host.focusNodeIdx, 0.55 + 0.45 * this.host.focusFlash);
      this.host._setCoreScale(this.host.focusNodeIdx, base * flashScale);
      this.host.focusFlash *= 0.97;
    }
    if (t >= 1) {
      this.host.focusActive = false;
      this._resettingCamera = false;
      if (this.host._fold.enteredGalaxyId === null && !this._resettingCamera && this.host.focusNodeIdx >= 0) {
        setTimeout(() => this.restoreFocusNode(), 800);
      }
    }
  }

  private restoreFocusNode(): void {
    if (this.host.focusNodeIdx < 0 || this.host.focusNodeIdx >= this.host._nodeCount) return;

    this.host._setGlowAlpha(this.host.focusNodeIdx, 0.55);
    this.host._setCoreScale(this.host.focusNodeIdx, this._savedFocusCoreScale || 1);
    this._savedFocusGlowScale = 0;
    this._savedFocusCoreScale = 0;
    this.host.focusNodeIdx = -1;
  }

  // ── 聚焦子图（详情卡片按钮触发）────────────

  buildFocusBanner(): void {
    this.host.focusSubgraphBanner = buildFocusBanner(this.host.container, () => this.exitFocusSubgraph());
  }

  enterFocusSubgraph(idx: number): void {
    if (idx < 0 || idx >= this.host._nodeCount) return;
    if (this.host.focusSubgraphActive) this.exitFocusSubgraph();

    this.host.focusSubgraphIdx = idx;
    this.host.focusSubgraphVisibleIndices.clear();
    this.host.focusSubgraphVisibleIndices.add(idx);
    for (const ni of this.host.neighborMap[idx] || []) {
      this.host.focusSubgraphVisibleIndices.add(ni);
    }

    // 保存当前状态
    this.focusSubgraphSavedGlowOpacities = [];
    this.focusSubgraphSavedCoreVisible = [];
    for (let i = 0; i < this.host._nodeCount; i++) {
      this.focusSubgraphSavedGlowOpacities.push(i < this.host._nodeCount ? this.host._glowRgba[i * 4 + 3] : 0.55);
      this.focusSubgraphSavedCoreVisible.push(i < this.host._nodeCount ? this.host._coreScales[i] > 0 : true);

      if (!this.host.focusSubgraphVisibleIndices.has(i)) {
        if (i < this.host._nodeCount) {
          this.host._overrideFlags[i] = 1;
          this.host._setGlowAlpha(i, 0.02);
        }
        this.host._setCoreVisible(i, false);
      } else {
        this.host._overrideFlags[i] = 1;
      }
    }

    // 调暗边线
    this.focusSubgraphSavedEdgeOpacities = this.host.edgeLineGroups.map(
      (lines) => (lines.material as LineMaterial).opacity,
    );
    for (const lines of this.host.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = 0.005;
    }

    // 构建聚焦边（仅在可见节点之间）
    this._buildFocusSubgraphEdges();

    // 高亮聚焦节点
    if (idx < this.host._nodeCount) {
      this.host._overrideFlags[idx] = 1;
      this.host._setGlowAlpha(idx, 0.92);
      this.host._setGlowColor(idx, 0xffffff);
    }

    this.host._flushOverrideAttrs();
    this.host.focusSubgraphActive = true;
    const node = this.host.graphNodes[idx];
    this.host.focusSubgraphBanner.innerHTML = `${iconHtml('focus', 12)}<span class="fb-name">${t('focus.title')} · ${node.name}</span><span class="fb-meta">${this.host.focusSubgraphVisibleIndices.size} ${t('focus.nodes')} · ${t('focus.exit')}</span>`;
    this.host.focusSubgraphBanner.style.display = 'flex';
    this.flyToNode(idx);
  }

  exitFocusSubgraph(): void {
    if (!this.host.focusSubgraphActive) return;

    // ponytail: 必须清 focusNodeIdx/focusActive/focusFlash, 否则 updateFocus 的 flash 分支
    // 持续套 scale×5.5+高 opacity 在 focus 节点, 且 restoreFocusNode 定时器恢复 scale 不管 color → 白点残留
    this.host.focusActive = false;
    this.host.focusFlash = 0;
    this.host.focusNodeIdx = -1;

    for (let i = 0; i < this.host._nodeCount; i++) {
      if (i < this.focusSubgraphSavedGlowOpacities.length && i < this.host._nodeCount) {
        this.host._setGlowAlpha(i, this.focusSubgraphSavedGlowOpacities[i]);
      }
      if (i < this.focusSubgraphSavedCoreVisible.length && i < this.host._nodeCount) {
        {
          const _v = this.focusSubgraphSavedCoreVisible[i];
          this.host._setCoreVisible(i, _v);
        }
      }
      // ponytail: 恢复 core color — focus 期间节点可能被 enter 设白或被 hover 循环提白
      if (i < this.host._nodeCount && i < this.host.nodeCoreColors.length) {
        this.host._setCoreColor(i, this.host.nodeCoreColors[i]);
      }
      // 恢复 glow color — focus 节点被 enter 设成 0xffffff
      if (i < this.host._nodeCount && i < this.host.nodeGlowColors.length) {
        this.host._setGlowColor(i, this.host.nodeGlowColors[i]);
      }
    }
    for (let ei = 0; ei < this.host.edgeLineGroups.length; ei++) {
      if (ei < this.focusSubgraphSavedEdgeOpacities.length) {
        (this.host.edgeLineGroups[ei].material as LineMaterial).opacity = this.focusSubgraphSavedEdgeOpacities[ei];
      }
    }
    // 清除聚焦边
    while (this.host.highlightEdgeGroup.children.length)
      this.host.highlightEdgeGroup.remove(this.host.highlightEdgeGroup.children[0]);

    // ponytail: 清除 override 标志 — shader 恢复动画
    for (let i = 0; i < this.host._nodeCount; i++) this.host._overrideFlags[i] = 0;
    this.host._flushOverrideAttrs();

    this.host.focusSubgraphActive = false;
    this.host.focusSubgraphIdx = -1;
    this.host.focusSubgraphVisibleIndices.clear();
    this.host.focusSubgraphBanner.style.display = 'none';
  }

  _buildFocusSubgraphEdges(): void {
    while (this.host.highlightEdgeGroup.children.length)
      this.host.highlightEdgeGroup.remove(this.host.highlightEdgeGroup.children[0]);
    const visible = this.host.focusSubgraphVisibleIndices;
    const verts: number[] = [];
    const colors: number[] = [];
    const pos = this.host.nodePositions;

    // ponytail: 先统计边数用于度归一化 — 防止
    // 聚焦节点有数百邻居时中心节点过度曝光。
    let edgeCount = 0;
    for (const d of this.host.edgeDataList) {
      if (visible.has(d.s) && visible.has(d.t)) edgeCount++;
    }
    if (edgeCount === 0) return;
    const degNorm = 1 / edgeCount ** 0.2;

    for (const d of this.host.edgeDataList) {
      if (visible.has(d.s) && visible.has(d.t)) {
        verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
        const c = edgeColorByType(d.edgeType, d.direction, d.crossFile, d.ambiguous);
        colors.push(c.r * degNorm, c.g * degNorm, c.b * degNorm, c.r * degNorm, c.g * degNorm, c.b * degNorm);
      }
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
          opacity: 0.55,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      ),
    );
  }
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
