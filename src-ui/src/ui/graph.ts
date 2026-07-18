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
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { useShellStore } from '../app/shell-store';
import { setLang, t } from '../i18n';
import { bus } from './events';
import { gpuLayout } from './gpu-layout';
import { type AnalysisHost, GraphAnalysis } from './graph-analysis';
import { BG_COLOR, hexToCSS } from './graph-colors';
import { type DiffOverlayHost, GraphDiffOverlay } from './graph-diff-overlay';
import { type EdgeRendererHost, GraphEdgeRenderer } from './graph-edge-renderer';
import { type FocusHost, GraphFocusController } from './graph-focus-controller';
import { type FoldHost, GraphFold } from './graph-fold';
import {
  buildHoloGrid as buildHoloGridFX,
  buildStarfield as buildStarfieldFX,
  positionGrid as positionGridFX,
} from './graph-fx';
import { GraphHighlight, type HighlightHost } from './graph-highlight';
import { GraphInteractionController, type InteractionHost } from './graph-interaction-controller';
import { GraphLabelSystem, type LabelHost } from './graph-labels';
import { GraphNodeRenderer, type NodeRendererHost } from './graph-node-renderer';
import * as Scene from './graph-scene';
import { GraphSceneLifecycle, type LifecycleHost } from './graph-scene-lifecycle';
import { createSpikeTexture } from './graph-textures';
import { GraphTooltip, type TooltipHost } from './graph-tooltip';
import type { CommunityData, EdgeData, GraphDiffJson, GraphJSON, GraphNode } from './graph-types';
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
  private animId = 0;
  private starfield!: THREE.Points;
  private galaxyGroup = new THREE.Group(); // parent for full-mode rotation
  private nodeGroup = new THREE.Group();
  private edgeGroup = new THREE.Group();
  private highlightEdgeGroup = new THREE.Group();
  private legendEl!: HTMLDivElement;
  private sphereGeo: THREE.SphereGeometry;
  private glowTex: THREE.Texture;

  // Graph data
  private graphNodes: GraphNode[] = [];
  private nodePositions: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private deg: number[] = [];
  private edgeDataList: EdgeData[] = [];
  private maxDeg = 1;
  private neighborMap: number[][] = [];
  private edgeIndexOf: number[][] = [];
  private nodeLabelIdx: number[] = [];
  private l34Count: number[] = [];

  // Batched rendering (ponytail: 1 InstancedMesh + 2 Points = 3 draw calls vs 210K individual objects)
  private nodeCoresInstanced!: THREE.InstancedMesh;
  private nodeGlowsPoints!: THREE.Points;
  private nodeGlows2Points!: THREE.Points;
  // CPU-side buffers (uploaded to GPU each frame)
  private _coreScales: Float32Array = new Float32Array(0);
  private _glowRgba: Float32Array = new Float32Array(0);
  private _glow2Rgba: Float32Array = new Float32Array(0);
  private _glowSizes: Float32Array = new Float32Array(0); // per-point size (twinkle variation)
  private _glow2Sizes: Float32Array = new Float32Array(0); // outer glow size
  private _nodeMagCache: Float32Array = new Float32Array(0); // pre-computed log1p ratio
  private _overrideFlags: Float32Array = new Float32Array(0); // 0=shader animated, 1=CPU overridden
  private _prevOverrideSet: Set<number> = new Set(); // nodes overridden last frame (for reset)
  private _nodeCount = 0;
  private _nodeCapacity = 0; // ponytail: InstancedMesh/Points capacity (>= _nodeCount)
  private _deadIndices: Set<number> = new Set(); // ponytail: dead node indices (removed but kept for index stability)
  // Reference colors (unchanged API)
  private nodeGlowColors: number[] = [];
  private nodeCoreColors: number[] = [];
  // Edge rendering (unchanged)
  private edgeLineGroups: LineSegments2[] = [];
  private scaleMode: 'degree' | 'coupling' = 'degree';

  // Full-FX extras
  private _nodeBaseHSL: Array<{ h: number; s: number; l: number }> = [];
  // Edge flow handled inside edgeLineGroups — dashed overlays animated via dashOffset

  // Hover
  private raycaster: THREE.Raycaster;
  private mouse = new THREE.Vector2(-999, -999);
  private hoveredIdx = -1;
  private hoveredGalaxyIdx = -1;
  private hoverScale = 0;
  private targetHoverScale = 0;

  // Labels
  private labelsContainer!: HTMLDivElement;
  private labelDivs: HTMLDivElement[] = [];

  // Tooltip & Detail card → graph-tooltip.ts

  // Graph spatial scale — p95 radius from center, set after layout.
  // Used for camera zoom range only (no LOD).
  private _graphRadius = 1000;

  // Camera reset — store initial view
  private _initCamPos = new THREE.Vector3();
  private _initCamTarget = new THREE.Vector3(0, 0, 0);

  // Focus
  private focusTarget = new THREE.Vector3();
  private focusActive = false;
  private focusProgress = 0;
  private focusNodeIdx = -1;

  // Focus subgraph (detail-card button triggered)
  private focusSubgraphActive = false;
  private focusSubgraphIdx = -1;
  private focusSubgraphVisibleIndices = new Set<number>();
  private focusSubgraphBanner!: HTMLDivElement;
  private focusStartCam = new THREE.Vector3();
  private focusStartLook = new THREE.Vector3();
  private focusFlash = 0;
  // ponytail: 统一飞行规划 — focusTarget 语义改为"相机终点"，_focusLookTarget 是看向的点
  private _focusLookTarget = new THREE.Vector3();
  private _focusStartTime = 0;
  private _focusDurationMs = 600;
  private _userInteracting = false;
  private _flyDebounce: ReturnType<typeof setTimeout> | null = null;

  // Filter / lens / trail 开关状态（实现已迁 graph-highlight；字段留 facade 供多模块共享）
  private _lensActive = false;
  private _trailActive = false;
  private _edgeTypeFilter: string | null = null;
  private _nodeKindFilter: string | null = null;

  // Blast + Path — delegated to GraphAnalysis
  private _analysis: GraphAnalysis;

  // Guard: true while _renderImpl is rebuilding the scene. Animation loop skips
  // rendering to avoid accessing disposed GPU resources (causes ghost artifacts
  // and cold-start blank screen on slow machines).
  private _renderInProgress = false;

  // ── Community / Galaxy fold overlay ──────────────────────
  private _fold: GraphFold;
  private communities: CommunityData[] = [];
  private nodeCommMap = new Map<number, string>(); // nodeIdx → communityId

  // ── DOM 交互层（tooltip/detail card/select rect/prompt bar）─
  private _tooltip: GraphTooltip;

  // ── P4 拆分模块（共享状态经 host 反查本 facade）─────────
  private _diffOverlay: GraphDiffOverlay;
  private _labels: GraphLabelSystem;
  private _nodes: GraphNodeRenderer;
  private _edges: GraphEdgeRenderer;
  private _highlight: GraphHighlight;
  private _interaction: GraphInteractionController;
  private _focus: GraphFocusController;
  private _lifecycle: GraphSceneLifecycle;

  // Post-processing (full mode only)
  private composer!: EffectComposer;
  private bloomPass!: UnrealBloomPass;

  // Animation
  private pulseTime = 0;
  private tmpVec3 = new THREE.Vector3();

  private readonly mode = 'full';

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

    if (true) this.buildHoloGrid();

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
        this.focusSubgraphBanner.innerHTML = `${iconHtml('focus', 14)} <b>${t('focus.title')}: ${node.name}</b> &middot; ${this.focusSubgraphVisibleIndices.size} ${t('focus.nodes')} &middot; ${t('focus.exit')}`;
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
    this._onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (this.focusSubgraphActive) {
          this.exitFocusSubgraph();
          return;
        }
        if (this._tooltip._promptBarEl?.style.display === 'flex') {
          this._tooltip._hidePrompt();
          return;
        }
        if (this._fold.enteredSubCommunityId) {
          this._fold.exitSubCommunity();
          return;
        }
        if (this._fold.enteredGalaxyId) {
          this._fold.exitGalaxy();
          return;
        }
        // In universe fold view: ESC exits fold mode
        if (this._fold.foldMode) {
          this._fold.setFoldMode(false);
          return;
        }
        if (this._analysis.blastMode) {
          this._analysis.exitBlastMode();
          return;
        }
      }
      if (e.key === 'b' || e.key === 'B') {
        if (this._analysis.blastMode) {
          this._analysis.exitBlastMode();
        } else if (this.hoveredIdx >= 0) {
          this._analysis.startBlastMode(this.hoveredIdx);
        } else if (this._tooltip.selectedIdx >= 0) {
          this._analysis.startBlastMode(this._tooltip.selectedIdx);
        }
      }
    };
    window.addEventListener('keydown', this._onKeyDown);

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
  private nebulaDust!: THREE.Points;
  private nebulaPhases: number[] = [];

  private buildNebulaDust(): void {
    const res = Scene.buildNebulaDust(this.scene, this.glowTex);
    this.nebulaDust = res.points;
    this.nebulaPhases = res.phases;
  }

  private animateNebulaDust(): void {
    Scene.animateNebulaDust(this.nebulaDust, this.pulseTime);
  }

  private buildStarfield(): void {
    this.starfield = buildStarfieldFX(this.scene, this.glowTex);
  }

  // ── Infinite holographic grid (shader-based) ──────────────
  private holoGrid!: THREE.Mesh;
  private holoGridY = -60;

  private buildHoloGrid(): void {
    const result = buildHoloGridFX(this.scene);
    this.holoGrid = result.mesh;
    this.holoGridY = result.gridY;
  }

  private positionGrid(pos: Float32Array): void {
    this.holoGridY = positionGridFX(this.holoGrid, pos);
  }

  // ── Path finding — delegated to GraphAnalysis ──────────────

  // ── Step 3: Shift+click quick path mode — delegated to GraphAnalysis ──
  private _onKeyDown?: (e: KeyboardEvent) => void;

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

  /** Render sub-community clouds — clickable "mini galaxies" inside a parent galaxy. */
  private _gaussRand(): number {
    let u = 0,
      v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.min(3, Math.max(-3, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v))) / 3;
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

  // ── Legend (color key) ────────────────────────────────────

  private buildLegend(): void {
    this.legendEl = document.createElement('div');
    this.legendEl.id = 'graph-legend';
    this.legendEl.style.display = 'none';
    this.legendEl.innerHTML = `<div class="legend-section">
        <div class="legend-title">${t('legend.node')}</div>
        <div class="legend-row legend-node-row" data-node-filter="function" title="${t('legend.function.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0x4ad8c8)};color:${hexToCSS(0x4ad8c8)}"></span> ${t('legend.function')}</div>
        <div class="legend-row legend-node-row" data-node-filter="class" title="${t('legend.class.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0x7fd84a)};color:${hexToCSS(0x7fd84a)}"></span> ${t('legend.class')}</div>
        <div class="legend-row legend-node-row" data-node-filter="module" title="${t('legend.module.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xd8d84a)};color:${hexToCSS(0xd8d84a)}"></span> ${t('legend.module')}</div>
        <div class="legend-row legend-node-row" data-node-filter="interface" title="${t('legend.interface.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xf0a850)};color:${hexToCSS(0xf0a850)}"></span> ${t('legend.interface')}</div>
        <div class="legend-row legend-node-row" data-node-filter="file" title="${t('legend.file.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xf0c060)};color:${hexToCSS(0xf0c060)}"></span> ${t('legend.file')}</div>
        <div class="legend-row legend-node-row" data-node-filter="symbol" title="${t('legend.symbol.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0x6ab0ff)};color:${hexToCSS(0x6ab0ff)}"></span> ${t('legend.symbol')}</div>
      </div>
      <div class="legend-section">
        <div class="legend-title">${t('legend.edge')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="calls" title="${t('legend.calls.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4a9adf)}"></span> ${t('legend.calls')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="imports" title="${t('legend.imports.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4adfdf)}"></span> ${t('legend.imports')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="defines" title="${t('legend.defines.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4adf8a)}"></span> ${t('legend.defines')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="inherits" title="${t('legend.inherits.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff66dd)}"></span> ${t('legend.inherits')}</div>
      </div>`;
    this.container.appendChild(this.legendEl);
    this.legendEl.querySelectorAll<HTMLElement>('.legend-edge-row').forEach((row) => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const et = row.dataset['edgeType'] || '';
        this.setEdgeTypeFilter(this._edgeTypeFilter === et ? null : et);
      });
    });
    this.legendEl.querySelectorAll<HTMLElement>('.legend-node-row').forEach((row) => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const nk = row.dataset['nodeFilter'] || '';
        this.setNodeKindFilter(this._nodeKindFilter === nk ? null : nk);
      });
    });
  }

  // ── Focus subgraph (detail-card button triggered) ────────────

  private enterFocusSubgraph(idx: number): void {
    this._focus.enterFocusSubgraph(idx);
  }

  exitFocusSubgraph(): void {
    this._focus.exitFocusSubgraph();
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

  // ── Full-FX: edge particle flow ──────────────────────────

  // ponytail: twinkle data now generated inline in buildNodes (GPU buffer attrs).
  // Kept as no-op for backward compat — called from _renderImpl after init.
  private initTwinkleData(_n: number): void {
    /* no-op: phase/speed baked into GPU attrs in buildNodes */
  }

  // ── Edge flow: built into edgeLineGroups as dashed overlay in buildEdges() ──
  // ponytail: no separate particle system — dashOffset animation on LineMaterial handles flow.
  private initEdgeParticles(_pos: Float32Array, _data: EdgeData[]): void {
    /* no-op: flow dashes built in buildEdges */
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
