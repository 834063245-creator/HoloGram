// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// 深空全息星图 · Deep Space Holographic Star Chart
// 三模式：minimal | standard | full
//
// P4 拆解：本类为 facade —— 持有全部共享状态字段 + 公开 API 委托。
// 实现分布于：graph-node-renderer / graph-edge-renderer / graph-labels /
// graph-highlight / graph-interaction-controller / graph-focus-controller /
// graph-scene-lifecycle / graph-diff-overlay（外加既有卫星 graph-fold /
// graph-analysis / graph-tooltip）。布局参数 LOCKED —— 见 graph-layout.ts。
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { useShellStore } from '../app/shell-store';
import { setLang, t } from '../i18n';
import { bus } from './events';
import { gpuLayout } from './gpu-layout';
import { type AnalysisHost, GraphAnalysis } from './graph-analysis';
import { BG_COLOR } from './graph-colors';
import { type DiffOverlayHost, GraphDiffOverlay } from './graph-diff-overlay';
import { type EdgeRendererHost, GraphEdgeRenderer } from './graph-edge-renderer';
import { type FocusHost, GraphFocusController } from './graph-focus-controller';
import { type FoldHost, GraphFold } from './graph-fold';
import { buildHoloGrid as buildHoloGridFX } from './graph-fx';
import { GraphHighlight, type HighlightHost } from './graph-highlight';
import { GraphInteractionController, type InteractionHost } from './graph-interaction-controller';
import { GraphLabelSystem, type LabelHost } from './graph-labels';
import { GraphNodeRenderer, type NodeRendererHost } from './graph-node-renderer';
import * as Scene from './graph-scene';
import { GraphSceneLifecycle, type LifecycleHost } from './graph-scene-lifecycle';
import { createSpikeTexture } from './graph-textures';
import { GraphTooltip, type TooltipHost } from './graph-tooltip';
import type { EdgeData, GraphDiffJson, GraphJSON, GraphNode } from './graph-types';
import { buildLegend as buildLegendUI } from './graph-ui';
import { iconHtml } from './icons';

// ═══════════════════════════════════════════════════════════════
// StarGraph — 深空星图 (mode-aware from construction)
// ═══════════════════════════════════════════════════════════════

export class StarGraph {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private container: HTMLElement;
  private galaxyGroup = new THREE.Group(); // parent for full-mode rotation
  private nodeGroup = new THREE.Group();
  private edgeGroup = new THREE.Group();
  private highlightEdgeGroup = new THREE.Group();
  private legendEl!: HTMLDivElement;
  private glowTex: THREE.Texture;

  // Graph data
  private graphNodes: GraphNode[] = [];
  private edgeDataList: EdgeData[] = [];
  private _nodeCount = 0;
  private _deadIndices: Set<number> = new Set(); // ponytail: dead node indices (removed but kept for index stability)
  private hoveredIdx = -1;

  // Labels
  private labelsContainer!: HTMLDivElement;

  // Focus subgraph (detail-card button triggered)
  private focusSubgraphActive = false;
  private focusSubgraphIdx = -1;
  private focusSubgraphVisibleIndices = new Set<number>();
  private focusSubgraphBanner!: HTMLDivElement;
  focusActive = false;
  private _flyDebounce: ReturnType<typeof setTimeout> | null = null;
  private _trailActive = false;
  private _edgeTypeFilter: string | null = null;
  private _nodeKindFilter: string | null = null;
  private _userInteracting = false;
  private _renderInProgress = false;

  // Blast + Path — delegated to GraphAnalysis
  private _analysis: GraphAnalysis;

  // ── Community / Galaxy fold overlay ──────────────────────
  private _fold: GraphFold;

  // ── DOM 交互层（tooltip/detail card/select rect/prompt bar）─
  private _tooltip: GraphTooltip;

  // ── P4 拆分模块（共享状态经 host 反查本 facade）─────────
  private _diffOverlay: GraphDiffOverlay;
  private _nodes: GraphNodeRenderer;
  private _highlight: GraphHighlight;
  private _interaction: GraphInteractionController;
  private _focus: GraphFocusController;
  private _lifecycle: GraphSceneLifecycle;

  // Post-processing (full mode only)
  private composer!: EffectComposer;
  private bloomPass!: UnrealBloomPass;

  // Reusable geometry
  sphereGeo!: THREE.SphereGeometry;
  private _labels!: GraphLabelSystem;
  private _edges!: GraphEdgeRenderer;
  raycaster!: THREE.Raycaster;

  // ponytail: 生产构建时 constructor 内 handleResize/setupHover 先于
  // render 执行，这些字段在渲染时才赋值。显式初始化为安全值防崩。
  mouse = new THREE.Vector2();
  edgeLineGroups: any[] = [];
  nodeLabelIdx: number[] = [];
  labelDivs: HTMLDivElement[] = [];
  nodePositions = new Float32Array(0);
  tmpVec3 = new THREE.Vector3();
  nodeCommMap = new Map<number, string>();
  _initCamPos = new THREE.Vector3();
  _initCamTarget = new THREE.Vector3();
  _focusDurationMs = 800;
  focusTarget = new THREE.Vector3();
  focusStartCam = new THREE.Vector3();
  focusStartLook = new THREE.Vector3();
  _focusLookTarget = new THREE.Vector3();
  focusProgress = 0;
  focusNodeIdx = -1;
  focusFlash = 0;
  _focusStartTime = 0;

  // Nebula + HoloGrid
  private nebulaDust!: THREE.Points;
  nebulaPhases: number[] | null = null;
  holoGrid: THREE.Mesh | null = null;
  holoGridY = 0;

  // Animation
  private pulseTime = 0;

  constructor(container: HTMLElement) {
    this.container = container;

    const bg = false ? 0x000005 : BG_COLOR;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(bg);
    // No fog — dark-universe rendering handles depth through contrast, not distance blur

    this.camera = new THREE.PerspectiveCamera(40, 2, 0.5, 500000); // near/far widened after layout

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.4;
    container.appendChild(this.renderer.domElement);

    // ── Post-processing pipeline ──
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // ponytail: bloom at 1/4 resolution — full-res bloom on 4K pixelRatio=2
    // is ~16M pixels × 5 blur passes = GPU murder. Quarter-res fixes it.
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.floor(container.clientWidth / 4), Math.floor(container.clientHeight / 4)),
      0.35, // strength — low default, bright objects still bloom on hover
      0.3, // radius — tight bloom, no global glow fog
      0.85, // threshold — only bright things bloom (hover highlights)
    );
    this.composer.addPass(this.bloomPass);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // ponytail: 用户手动操作即放弃自动 fly，避免抢镜头
    this.controls.addEventListener('start', () => {
      this._userInteracting = true;
      this.focusActive = false;
      if (this._flyDebounce) {
        clearTimeout(this._flyDebounce);
        this._flyDebounce = null;
      }
    });
    this.controls.addEventListener('end', () => {
      this._userInteracting = false;
    });
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15; // quick stop
    this.controls.rotateSpeed = 0.5; // halved — no whip
    this.controls.zoomSpeed = 1.0; // responsive zoom
    this.controls.screenSpacePanning = true; // right-drag to pan = recenter orbit target
    this.controls.minDistance = 5;
    this.controls.maxDistance = 12000;
    this.controls.maxDistance = 4000;

    this.glowTex = createSpikeTexture();
    this.sphereGeo = new THREE.SphereGeometry(1, 24, 16);

    // ── P4 拆分模块 — 仅存 host 引用，构造期不触发任何 facade 调用 ──
    this._diffOverlay = new GraphDiffOverlay(this as unknown as DiffOverlayHost);
    this._labels = new GraphLabelSystem(this as unknown as LabelHost);
    this._nodes = new GraphNodeRenderer(this as unknown as NodeRendererHost);
    this._edges = new GraphEdgeRenderer(this as unknown as EdgeRendererHost);
    this._highlight = new GraphHighlight(this as unknown as HighlightHost);
    this._interaction = new GraphInteractionController(this as unknown as InteractionHost);
    this._focus = new GraphFocusController(this as unknown as FocusHost);
    this._lifecycle = new GraphSceneLifecycle(this as unknown as LifecycleHost);
    this._fold = new GraphFold(this as unknown as FoldHost);
    this._analysis = new GraphAnalysis(this as unknown as AnalysisHost);
    this._tooltip = new GraphTooltip(this as unknown as TooltipHost);

    // starfield disabled
    // if (true) this.buildStarfield();
    // nebulaDust disabled
    // if (mode === 'full') this.buildNebulaDust();

    // Holographic grid removed — natural 3D star field doesn't need a floor

    this.galaxyGroup.add(this.edgeGroup);
    this.galaxyGroup.add(this.highlightEdgeGroup);
    this.galaxyGroup.add(this.nodeGroup);
    this.galaxyGroup.add(this._fold.commFoldGroup);
    this.galaxyGroup.add(this._fold.communityRingGroup);
    this.scene.add(this.galaxyGroup);

    this.raycaster = new THREE.Raycaster();
    this._interaction.setupHover();
    this._tooltip.setupTooltip();
    this._tooltip.setupDetailCard();
    this._tooltip.setupPromptBar();

    // Labels container (not in minimal mode — but always create, hide via CSS)
    this.labelsContainer = document.createElement('div');
    this.labelsContainer.id = 'graph-labels';
    if (false) this.labelsContainer.style.display = 'none';
    this.container.appendChild(this.labelsContainer);

    this.buildLegend();
    this._focus.buildFocusBanner();

    // Rebuild legend + focus banner on language change
    this._langHandler = ({ lang }: { lang: string }) => {
      setLang(lang as 'zh' | 'en');
      // Remove old DOM elements before rebuilding
      if (this.legendEl) {
        this.legendEl.remove();
      }
      this.buildLegend();
      if (this._nodeCount > 0) this.legendEl.style.display = '';
      if (this.focusSubgraphBanner) {
        this.focusSubgraphBanner.remove();
      }
      this._focus.buildFocusBanner();
      if (this.focusSubgraphActive && this.focusSubgraphIdx >= 0) {
        // Refresh focus banner text while staying in focus mode
        const node = this.graphNodes[this.focusSubgraphIdx];
        this.focusSubgraphBanner.innerHTML = `${iconHtml('focus', 12)}<span class="fb-name">${t('focus.title')} · ${node.name}</span><span class="fb-meta">${this.focusSubgraphVisibleIndices.size} ${t('focus.nodes')} · ${t('focus.exit')}</span>`;
        this.focusSubgraphBanner.style.display = 'flex';
      }
    };
    bus.on('lang:changed', this._langHandler);
    const pointerDown = new THREE.Vector2();
    let pointerDragged = false;
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      pointerDown.set(e.clientX, e.clientY);
      pointerDragged = false;
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (Math.abs(e.clientX - pointerDown.x) > 4 || Math.abs(e.clientY - pointerDown.y) > 4) {
        pointerDragged = true;
      }
    });
    canvas.addEventListener('pointerup', (e: PointerEvent) => {
      if (pointerDragged) return;
      this._interaction.onClick(e);
    });
    // Prevent browser context menu on canvas
    canvas.addEventListener('contextmenu', (e: Event) => e.preventDefault());

    this.onResize();
    window.addEventListener('resize', this.onResize);
    this._lifecycle.animate();

    // Kick off WebGPU compute pipeline init (non-blocking)
    gpuLayout
      .init()
      .then((ready) => {
        if (ready) console.log('[StarGraph] GPU layout ready');
      })
      .catch(() => {
        /* GPU init failure is non-critical; CPU fallback used */
      });
  }

  // ── Starfield ────────────────────────────────────────────

  // ── Nebula dust → graph-scene.ts ──

  private buildNebulaDust(): void {
    const res = Scene.buildNebulaDust(this.scene, this.glowTex);
    this.nebulaDust = res.points;
    this.nebulaPhases = res.phases;
  }

  private animateNebulaDust(): void {
    Scene.animateNebulaDust(this.nebulaDust, this.pulseTime);
  }

  private buildHoloGrid(): void {
    const result = buildHoloGridFX(this.scene);
    this.holoGrid = result.mesh;
    this.holoGridY = result.gridY;
  }

  // ponytail: LifecycleHost 要求的方法，P4 拆分时漏实现
  positionGrid(pos: Float32Array): void {
    Scene.positionGrid(this.holoGrid!, pos, this.holoGridY);
  }
  // ponytail: edge particles / twinkle 计划中未实现，空桩防崩
  initEdgeParticles(_pos: Float32Array, _data: import('./graph-types').EdgeData[]): void {}
  initTwinkleData(_n: number): void {}

  // ── Path finding — delegated to GraphAnalysis ──────────────

  // ── i18n ──
  private _langHandler: ((data: { lang: string }) => void) | null = null;

  // ── Step 3: Alt+drag rectangle selection → graph-tooltip.ts ──

  // ── GPU 缓冲委托（fold/analysis/tooltip host 契约 + 兄弟模块共用）──

  private _setCoreColor(i: number, c: number | THREE.Color): void {
    this._nodes._setCoreColor(i, c);
  }

  private _setCoreScale(i: number, s: number): void {
    this._nodes._setCoreScale(i, s);
  }

  private _setCoreVisible(i: number, v: boolean): void {
    this._nodes._setCoreVisible(i, v);
  }

  private _setGlowRgba(i: number, r: number, g: number, b: number, a: number): void {
    this._nodes._setGlowRgba(i, r, g, b, a);
  }

  private _setGlowColor(i: number, c: THREE.Color | number, a?: number): void {
    this._nodes._setGlowColor(i, c, a);
  }

  private _setGlowAlpha(i: number, a: number): void {
    this._nodes._setGlowAlpha(i, a);
  }

  private _setGlow2Rgba(i: number, r: number, g: number, b: number, a: number): void {
    this._nodes._setGlow2Rgba(i, r, g, b, a);
  }

  private _setGlow2Alpha(i: number, a: number): void {
    this._nodes._setGlow2Alpha(i, a);
  }

  private _flushOverrideAttrs(): void {
    this._nodes._flushOverrideAttrs();
  }

  private getNodeBaseScale(i: number): number {
    return this._nodes.getNodeBaseScale(i);
  }

  /** Find a node's array index by name (fuzzy). Returns -1 if not found. */
  private _findNodeIndexByName(query: string): number {
    return this._highlight._findNodeIndexByName(query);
  }

  // ── Camera / focus public API → graph-focus-controller ─────

  /** Reset camera to the default overview position with smooth animation. */
  resetCamera(): void {
    this._focus.resetCamera();
  }

  /** Return all visible node names for autocomplete / search. */
  getNodeNames(): string[] {
    const names: string[] = [];
    for (let i = 0; i < this._nodeCount; i++) {
      if (this._deadIndices.has(i) || !this.graphNodes[i]) continue;
      names.push(this.graphNodes[i].name);
    }
    return names;
  }

  focusNode(query: string): boolean {
    return this._focus.focusNode(query);
  }

  // ── Highlight / filter / lens / trail → graph-highlight ────

  /** Highlight all nodes belonging to a file (match by location prefix). */
  highlightFile(filePath: string): void {
    this._highlight.highlightFile(filePath);
  }

  /** Highlight all nodes under a directory (recursive prefix match). */
  highlightFolder(folderPath: string): void {
    this._highlight.highlightFolder(folderPath);
  }

  clearFileHighlight(): void {
    this._highlight.clearFileHighlight();
  }

  /** Highlight only edges of one type, dim all others. null = clear filter. */
  setEdgeTypeFilter(edgeType: string | null): void {
    this._highlight.setEdgeTypeFilter(edgeType);
  }

  /** Dim all nodes except those matching a kind filter. null = clear. */
  setNodeKindFilter(filter: string | null): void {
    this._highlight.setNodeKindFilter(filter);
  }

  /** Highlight a set of nodes by name (fuzzy match). Matched nodes glow in the given color; others dim. */
  highlightNodeNames(names: string[], colorHex?: string): void {
    this._highlight.highlightNodeNames(names, colorHex);
  }

  /** Clear all Agent-triggered highlights (path + node highlight). */
  clearAgentHighlight(): void {
    this._highlight.clearAgentHighlight();
  }

  /** Color nodes belonging to hotspot files with intensity proportional to L4 recurrence count. */
  highlightHotspots(hotspots: Array<{ file: string; count: number }>): void {
    this._highlight.highlightHotspots(hotspots);
  }

  clearHotspots(): void {
    this._highlight.clearHotspots();
  }

  /** Dim all nodes except those matching the given names to 1% opacity. */
  setAgentLens(nodeNames: Set<string>): void {
    this._highlight.setAgentLens(nodeNames);
  }

  /** Restore normal rendering from agent lens mode. */
  clearAgentLens(): void {
    this._highlight.clearAgentLens();
  }

  /** Activate retrospective trail mode: highlight all visited nodes, dim others
   *  to 30% (not 2.5% — still visible, just backgrounded), draw a thick glowing
   *  trail line through the exploration sequence, and fly camera to the centroid. */
  showAgentTrail(visitedNames: Set<string>, trailNames: string[]): void {
    this._highlight.showAgentTrail(visitedNames, trailNames);
  }

  /** Restore normal rendering from trail mode. */
  hideAgentTrail(): void {
    this._highlight.hideAgentTrail();
  }

  get isTrailActive(): boolean {
    return this._trailActive;
  }

  // ══════════════════════════════════════════════════════════
  // Community / Galaxy fold overlay — delegated to GraphFold
  // ══════════════════════════════════════════════════════════

  get isFolded(): boolean {
    return this._fold.isFolded;
  }
  get isInsideGalaxy(): boolean {
    return this._fold.isInsideGalaxy;
  }
  get communityCount(): number {
    return this._fold.communityCount;
  }

  setFoldMode(on: boolean): void {
    this._fold.setFoldMode(on);
  }
  toggleFold(): void {
    this._fold.toggleFold();
  }
  enterGalaxy(galaxyId: string): void {
    this._fold.enterGalaxy(galaxyId);
  }
  exitGalaxy(): void {
    this._fold.exitGalaxy();
  }
  enterSubCommunity(subCommId: string): void {
    this._fold.enterSubCommunity(subCommId);
  }
  exitSubCommunity(): void {
    this._fold.exitSubCommunity();
  }
  showGalaxyLabel(gm: { id: string; label: string; centroid: THREE.Vector3 } | undefined): void {
    this._fold.showGalaxyLabel(gm);
  }

  // ── Diff overlay → graph-diff-overlay ─────────────────────

  /** Apply diff coloring: green=added, red=removed, orange=modified. */
  showDiff(diffJson: {
    added_nodes?: Array<{ id: string }>;
    removed_nodes?: Array<{ id: string }>;
    modified_nodes?: Array<{ node_id: string }>;
  }): void {
    this._diffOverlay.showDiff(diffJson);
  }

  /** Remove diff coloring, restore normal colors. */
  clearDiff(): void {
    this._diffOverlay.clearDiff();
  }

  get hasDiff(): boolean {
    return this._diffOverlay.diffActive;
  }
  get hasGraph(): boolean {
    return this._nodeCount > 0;
  }

  /**
   * Apply a graph diff incrementally — no layout recalc, no camera reset,
   * no progressive reveal. Preserves hover/selected/blast/filter/diff state.
   * Falls back to full render() if no existing graph.
   */
  async applyGraphDiff(diff: GraphDiffJson, fullGraph: GraphJSON): Promise<void> {
    return this._lifecycle.applyGraphDiff(diff, fullGraph);
  }

  // ── Render ───────────────────────────────────────────────

  async render(graph: GraphJSON): Promise<void> {
    try {
      await this._lifecycle.renderImpl(graph);
      bus.emit('graph:rendered');
    } catch (e) {
      console.error('[StarGraph] render crashed:', e);
      this._renderInProgress = false;
      try {
        this._lifecycle.clearGraph();
      } catch {
        /* best effort */
      }
      this.updateStatus(0, 0);
    }
  }

  // ── Legend (color key) — 实现委托 graph-ui.buildLegend（P5 单源化）──

  private buildLegend(): void {
    this.legendEl = buildLegendUI(
      this.container,
      (et) => this.setEdgeTypeFilter(et),
      (nk) => this.setNodeKindFilter(nk),
      () => this._edgeTypeFilter,
      () => this._nodeKindFilter,
    );
  }

  // ── Focus subgraph (detail-card button triggered) ────────────

  private enterFocusSubgraph(idx: number): void {
    this._focus.enterFocusSubgraph(idx);
  }

  exitFocusSubgraph(): void {
    this._focus.exitFocusSubgraph();
  }

  /** 处理 Escape 键（由 escLayer 统一调度）。返回 true 表示已消费，不再继续冒泡。 */
  handleEscape(): boolean {
    if (this.focusSubgraphActive) { this.exitFocusSubgraph(); return true; }
    if (this._tooltip._promptBarEl?.style.display === 'flex') { this._tooltip._hidePrompt(); return true; }
    if (this._fold.enteredSubCommunityId) { this._fold.exitSubCommunity(); return true; }
    if (this._fold.enteredGalaxyId) { this._fold.exitGalaxy(); return true; }
    if (this._fold.foldMode) { this._fold.setFoldMode(false); return true; }
    if (this._analysis.blastMode) { this._analysis.exitBlastMode(); return true; }
    return false;
  }

  /** 切换 Blast 模式（B 键）。依赖于当前 hover/选中节点。 */
  handleBlastToggle(): void {
    if (this._analysis.blastMode) {
      this._analysis.exitBlastMode();
    } else if (this.hoveredIdx >= 0) {
      this._analysis.startBlastMode(this.hoveredIdx);
    } else if (this._tooltip.selectedIdx >= 0) {
      this._analysis.startBlastMode(this._tooltip.selectedIdx);
    }
  }

  // ── Status ───────────────────────────────────────────────

  // P1：状态写入 shell-store（StatusBar 遥测区），不再直接操作 DOM。
  private updateStatus(nodeCount: number, edgeCount: number, meta?: Record<string, unknown>): void {
    let sCount = 0,
      dCount = 0,
      tCount = 0;
    for (const e of this.edgeDataList) {
      if (e.edgeType === 'structural' || e.edgeType === 'STRUCTURAL') sCount++;
      else if (e.edgeType === 'data' || e.edgeType === 'DATA') dCount++;
      else if (e.edgeType === 'temporal' || e.edgeType === 'TEMPORAL') tCount++;
    }
    const coup = (meta?.coupling || {}) as Record<string, number>;
    const l3 = coup.total_l3 || 0,
      l4 = coup.total_l4 || 0;
    useShellStore.getState().setGraphStats({
      nodes: nodeCount,
      edges: edgeCount,
      s: sCount,
      d: dCount,
      t: tCount,
      l3,
      l4,
      galaxies: this._fold.foldMode && this._fold.galaxyMeta.length > 0 ? this._fold.galaxyMeta.length : 0,
    });
  }

  // ── Resize ───────────────────────────────────────────────

  /** Public resize — call after CSS layout changes (e.g. --font-scale, --toolbar-h) */
  resize(): void {
    this.onResize();
  }

  private onResize = (): void => {
    this._lifecycle.handleResize();
  };

  // ── Destroy ──────────────────────────────────────────────

  destroy(): void {
    this._lifecycle.destroy();
  }
}