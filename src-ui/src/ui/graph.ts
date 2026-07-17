// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// 深空全息星图 · Deep Space Holographic Star Chart
// 三模式：minimal | standard | full
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { getLang, setLang, t } from '../i18n';
import { shell } from './app-shell';
import { bus } from './events';
import { gpuLayout } from './gpu-layout';
import { type AnalysisHost, GraphAnalysis } from './graph-analysis';
import {
  BG_COLOR,
  communityColor,
  edgeColorByType,
  edgeOpacityByDepth,
  edgeWidthByDepth,
  GLOW_COLORS,
  hexToCSS,
  NODE_COLORS,
  TYPE_LABELS,
} from './graph-colors';
import { type FoldHost, type GalaxyMeta, GraphFold } from './graph-fold';
import {
  buildHoloGrid as buildHoloGridFX,
  buildStarfield as buildStarfieldFX,
  positionGrid as positionGridFX,
} from './graph-fx';
import { fibonacciSphere, layout3D, relaxNewNodes, repelCommunityCentroids, spiralGalaxies } from './graph-layout';
import * as Scene from './graph-scene';
import { _GLSL_HSL2RGB, makeCoreFresnelMaterial, makeGlowPointMaterial } from './graph-shaders';
import { createGlowTexture, createSpikeTexture } from './graph-textures';
import { GraphTooltip, type TooltipHost } from './graph-tooltip';
import { buildFocusBanner, buildLegend } from './graph-ui';
import { iconHtml } from './icons';

// ── Types ────────────────────────────────────────────────────

interface GraphNode {
  id: string;
  name: string;
  type?: string;
  kind?: string;
  location?: string;
  properties?: Record<string, unknown>;
}
interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  properties?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
interface GraphJSON {
  nodes: GraphNode[] | Record<string, GraphNode>;
  edges: GraphEdge[] | Record<string, GraphEdge>;
  meta?: Record<string, unknown>;
}

interface EdgeData {
  s: number;
  t: number;
  couplingDepth: number;
  edgeType: string;
  direction: string;
  crossFile: boolean;
}
interface CommunityData {
  id: string;
  label: string;
  node_ids: string[];
  level?: number;
  parent_id?: string | null;
}

// ponytail: diff payload from watcher — added/removed/changed nodes and edges
interface GraphDiffJson {
  added_nodes: GraphNode[];
  removed_nodes: Array<{ id: string; name: string; type?: string }>;
  modified_nodes: Array<{ node_id: string; name: string; old_kind: string; new_kind: string }>;
  added_edges: GraphEdge[];
  removed_edges: Array<{ id: string; source: string; target: string }>;
}

// ═════ Colors + Textures moved to graph-colors.ts / graph-textures.ts ═══

// ═══════════ Layout moved to graph-layout.ts ═══════════ ═══════════

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

  // Diagnostics
  private _diagMsg = '';

  // Diff overlay (P4: 变更回看着色)
  private diffActive = false;
  private diffAddedIds = new Set<string>();
  private diffRemovedIds = new Set<string>();
  private diffModifiedIds = new Set<string>();

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
  // ponytail: 总览关 bloom 防边密集区雾化; 聚焦开 bloom 让 hover 发光鲜明。滞回防抖。
  private _bloomFar = false;
  private _bloomHysteresis = 0; // 0=稳态, 正值刚切换倒计时防回弹

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
  private focusSubgraphSavedGlowOpacities: number[] = [];
  private focusSubgraphSavedCoreVisible: boolean[] = [];
  private focusSubgraphSavedEdgeOpacities: number[] = [];
  private focusStartCam = new THREE.Vector3();
  private focusStartLook = new THREE.Vector3();
  private focusFlash = 0;
  // ponytail: 统一飞行规划 — focusTarget 语义改为"相机终点"，_focusLookTarget 是看向的点
  private _focusLookTarget = new THREE.Vector3();
  private _focusStartTime = 0;
  private _focusDurationMs = 600;
  private _userInteracting = false;
  private _flyDebounce: ReturnType<typeof setTimeout> | null = null;

  // File highlight (from file tree)
  private _fileHighlight = false;
  private _fileHighlightIndices = new Set<number>();
  private _fileOpacityOriginal = new Map<number, number>();
  private _agentHighlightIndices = new Set<number>();
  private _edgeTypeFilter: string | null = null;
  private _nodeKindFilter: string | null = null;

  // Step 2: Agent lens & trail
  private _lensActive = false;
  private _trailActive = false;
  private _trailLine: THREE.LineSegments | LineSegments2 | null = null;

  // Blast + Path — delegated to GraphAnalysis
  private _analysis: GraphAnalysis;

  // Incremental-update abort: cancel in-flight layout when new data arrives
  private _layoutAbort: AbortController | null = null;
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

  // Post-processing (full mode only)
  private composer!: EffectComposer;
  private bloomPass!: UnrealBloomPass;

  // Animation
  private pulseTime = 0;
  private tmpVec3 = new THREE.Vector3();
  // Idle detection — throttle expensive per-frame work when nothing changes
  private _idleCounter = 0;
  private _lastCamPos = new THREE.Vector3();
  private _lastCamTarget = new THREE.Vector3();

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

    // starfield disabled
    // if (true) this.buildStarfield();
    // nebulaDust disabled
    // if (mode === 'full') this.buildNebulaDust();

    if (true) this.buildHoloGrid();

    this._fold = new GraphFold(this as unknown as FoldHost);
    this._analysis = new GraphAnalysis(this as unknown as AnalysisHost);
    this._tooltip = new GraphTooltip(this as unknown as TooltipHost);
    this.galaxyGroup.add(this.edgeGroup);
    this.galaxyGroup.add(this.highlightEdgeGroup);
    this.galaxyGroup.add(this.nodeGroup);
    this.galaxyGroup.add(this._fold.commFoldGroup);
    this.galaxyGroup.add(this._fold.communityRingGroup);
    this.scene.add(this.galaxyGroup);

    this.raycaster = new THREE.Raycaster();
    this.setupHover();
    this._tooltip.setupTooltip();
    this._tooltip.setupDetailCard();
    this._tooltip.setupSelectRect();
    this._tooltip.setupPromptBar();

    // Labels container (not in minimal mode — but always create, hide via CSS)
    this.labelsContainer = document.createElement('div');
    this.labelsContainer.id = 'graph-labels';
    if (false) this.labelsContainer.style.display = 'none';
    this.container.appendChild(this.labelsContainer);

    this.buildLegend();
    this.buildFocusBanner();

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
      this.buildFocusBanner();
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
      // ponytail: prevent browser text-selection drag on canvas
      e.preventDefault();
      // Step 3: Alt+left-drag → rectangle selection
      if (e.altKey && e.button === 0) {
        this._tooltip._selecting = true;
        this._tooltip._selectStart.set(e.clientX, e.clientY);
        this._tooltip._selectEnd.set(e.clientX, e.clientY);
        this._tooltip._showSelectRect();
        this.controls.enabled = false;
        e.stopPropagation();
      }
    });
    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (this._tooltip._selecting) {
        this._tooltip._selectEnd.set(e.clientX, e.clientY);
        this._tooltip._updateSelectRect();
        return;
      }
      if (Math.abs(e.clientX - pointerDown.x) > 4 || Math.abs(e.clientY - pointerDown.y) > 4) {
        pointerDragged = true;
      }
    });
    canvas.addEventListener('pointerup', (e: PointerEvent) => {
      // Step 3: Alt+drag selection complete
      if (this._tooltip._selecting) {
        this._tooltip._selecting = false;
        this._tooltip._hideSelectRect();
        this.controls.enabled = true;
        this._tooltip._handleRegionSelect(
          this._nodeCount,
          this.nodePositions,
          this.graphNodes,
          this._coreScales,
          this.camera,
          this.container,
          this.highlightNodeNames.bind(this),
          this.clearAgentHighlight.bind(this),
          { blastMode: this._analysis.blastMode, _pathSource: this._analysis._pathSource },
          this._lensActive,
        );
        return;
      }
      if (pointerDragged) return;
      // Step 3: Shift+click → quick path mode
      if (e.shiftKey) {
        this._analysis._handleShiftClick(e);
        return;
      }
      this.onClick(e);
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
        if (this._tooltip._selecting) {
          this._tooltip._selecting = false;
          this._tooltip._hideSelectRect();
          this.controls.enabled = true;
          return;
        }
        if (this._analysis._shiftSourceIdx >= 0) {
          this._analysis._clearShiftPath();
          return;
        }
        if (this._analysis._pathSource >= 0) {
          this._analysis.clearPath();
          e.stopImmediatePropagation();
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
    this.animate();

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

  private onClick(e: MouseEvent): void {
    if (this._nodeCount === 0) return;
    const rect = this.container.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(mx, my), this.camera);

    // Helper: intersect galaxy core sprites and return the community id
    const hitCloudId = (): string | null => {
      const coreSprites = this._fold.galaxyGlows.filter((_, i) => i % 2 === 1);
      const hits = this.raycaster.intersectObjects(coreSprites);
      if (hits.length > 0) {
        return (hits[0].object.userData['galaxyId'] as string) || null;
      }
      return null;
    };

    // In universe view: click galaxy cloud → enterGalaxy
    if (this._fold.foldMode && !this._fold.enteredGalaxyId) {
      const cid = hitCloudId();
      if (cid) {
        this._fold.enterGalaxy(cid);
      }
      return;
    }

    // Inside a galaxy or sub-community: dispatch based on whether we're in cloud or constellation view
    if (this._fold.foldMode && this._fold.enteredGalaxyId) {
      // Current parent is the deepest sub-community, or the galaxy itself
      const activeParentId =
        this._fold._drillStack.length > 0
          ? this._fold._drillStack[this._fold._drillStack.length - 1]
          : this._fold.enteredGalaxyId;

      // Check if current parent has sub-communities (→ cloud view) or not (→ constellation view)
      if (this._fold._hasVisibleSubCommunities(activeParentId)) {
        // Cloud view: click sub-cloud → enterSubCommunity
        const cid = hitCloudId();
        if (cid) {
          this._fold.enterSubCommunity(cid);
        }
        return;
      }
    }

    // Intersect ALL node cores (ignore .visible — hover/click should always work)
    const hits = this.raycaster.intersectObject(this.nodeCoresInstanced);
    const idx = hits.length > 0 ? (hits[0].instanceId ?? -1) : -1;

    if (idx >= 0 && idx !== this._tooltip.selectedIdx)
      this._tooltip.showDetail(
        idx,
        this.edgeDataList,
        this.deg,
        this.nodePositions,
        this.container,
        this.camera,
        this.graphNodes,
      );
    else if (idx < 0) this._tooltip.hideDetail();

    // Step 3: Emit graph:node-clicked (for external interaction handlers)
    if (idx >= 0 && idx < this._nodeCount) {
      const node = this.graphNodes[idx];
      bus.emit('graph:node-clicked', {
        nodeName: node.name,
        nodeType: (node.type || node.kind || 'symbol') as string,
        nodeId: node.id,
        degree: this.deg[idx] || 0,
        location: node.location || '',
      });
    }
  }

  // ── Path finding — delegated to GraphAnalysis ──────────────

  // ── Step 3: Shift+click quick path mode — delegated to GraphAnalysis ──
  private _onKeyDown?: (e: KeyboardEvent) => void;

  // ── i18n ──
  private _langHandler: ((data: { lang: string }) => void) | null = null;

  // ── Step 3: Alt+drag rectangle selection → graph-tooltip.ts ──

  // ── Step 3: Shift+click quick path mode ──────────────────
  // ── Hover ────────────────────────────────────────────────
  // Hover raycaster uses ALL nodeCores regardless of .visible state.
  // This is intentional: .visible is a visual/rendering concern, and many
  // features (agent highlight, path mode, blast) temporarily toggle it.
  // If a node exists in the graph, it should be hoverable and clickable.
  // The only exception is fold-mode cloud view, which intentionally restricts
  // interaction to galaxy clouds only.

  private setupHover(): void {
    this.container.addEventListener('pointermove', (e: PointerEvent) => {
      const rect = this.container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    });
    this.container.addEventListener('pointerleave', () => {
      this.mouse.x = -999;
      this.mouse.y = -999;
    });
  }

  /** Raycast against node cores; returns index or -1. Uses ALL cores regardless of .visible. */
  private _raycastNode(): number {
    if (this._nodeCount === 0) return -1;
    if (!this.nodeCoresInstanced) return -1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObject(this.nodeCoresInstanced);
    if (hits.length === 0) return -1;
    return hits[0].instanceId ?? -1;
  }

  private updateHover(): void {
    if (this._nodeCount === 0) return;
    if (!isFinite(this.mouse.x) || !isFinite(this.mouse.y)) return;

    // Cloud hover: fold mode with visible galaxy clouds (nodes hidden intentionally)
    const cloudViewActive = this._fold.foldMode && this._fold.galaxyGlows.length > 0;
    if (cloudViewActive) {
      if (this.hoveredIdx >= 0) {
        this.hoveredIdx = -1;
        this.targetHoverScale = 0;
        this.rebuildHighlightEdges(-1);
      }
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const coreSprites = this._fold.galaxyGlows.filter((_, i) => i % 2 === 1);
      const galaxyHits = this.raycaster.intersectObjects(coreSprites);
      if (galaxyHits.length > 0 && this.mouse.x > -999) {
        this.container.style.cursor = 'pointer';
        const gIdx = galaxyHits[0].object.userData['galaxyIndex'] as number | undefined;
        if (gIdx !== undefined && gIdx < this._fold.galaxyMeta.length) {
          this.hoveredGalaxyIdx = gIdx;
          const gm = this._fold.galaxyMeta[gIdx];
          const shortName = (gm.label || gm.id).split('/')[0].replace(/_/g, ' ');
          const isSub = !!this._fold.enteredGalaxyId;
          this._tooltip.tooltipEl.querySelector('.tt-name')!.textContent = `${isSub ? '📁' : '🌌'} ${shortName}`;
          this._tooltip.tooltipEl.querySelector('.tt-meta')!.textContent =
            `${gm.memberIndices.length} 节点 · ${gm.memberIndices.length >= 30 ? '大型星团' : gm.memberIndices.length >= 10 ? '中型星团' : '小型星团'}`;
          this._tooltip.tooltipEl.querySelector('.tt-loc')!.textContent = isSub
            ? '点击钻入子社区'
            : '点击进入查看内部连线';
          this.tmpVec3.copy(gm.centroid);
          this.tmpVec3.project(this.camera);
          if (this.tmpVec3.z <= 1) {
            const x = (this.tmpVec3.x * 0.5 + 0.5) * this.container.clientWidth;
            const y = (-this.tmpVec3.y * 0.5 + 0.5) * this.container.clientHeight;
            this._tooltip.tooltipEl.style.left = `${x + 18}px`;
            this._tooltip.tooltipEl.style.top = `${y - 10}px`;
            this._tooltip.tooltipEl.classList.add('visible');
          }
        }
      } else {
        this.container.style.cursor = '';
        this._tooltip.tooltipEl.classList.remove('visible');
        this.hoveredGalaxyIdx = -1;
      }
      return;
    }

    // Standard / constellation view: raycast all cores (ignore .visible)
    const newIdx = this._raycastNode();
    if (newIdx !== this.hoveredIdx) {
      // Restore previous hovered node — brightness only, no scale change
      if (this.hoveredIdx >= 0 && this.hoveredIdx < this._nodeCount) {
        // Restore original core color
        this._setCoreColor(this.hoveredIdx, this.nodeCoreColors[this.hoveredIdx]);
        if (this.hoveredIdx >= 0 && this.hoveredIdx < this._nodeCount) {
          this._setGlowAlpha(this.hoveredIdx, 0.55);
        }
      }
      this.hoveredIdx = newIdx;
      this.targetHoverScale = newIdx >= 0 ? 1 : 0;
      this.rebuildHighlightEdges(newIdx);
    }
  }

  /** Build hover edge verts+colors for a node — degree-normalized brightness gradient. */
  private _buildHoverEdgeVerts(nodeIdx: number, verts: number[], colors: number[]): void {
    const edges = this.edgeIndexOf[nodeIdx];
    if (edges.length === 0) return;
    const pos = this.nodePositions;
    const degNorm = 1 / edges.length ** 0.25;
    for (const ei of edges) {
      const d = this.edgeDataList[ei];
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

  private rebuildHighlightEdges(nodeIdx: number): void {
    if (this._analysis.blastMode) return;
    if (this.focusSubgraphActive) {
      this._buildFocusSubgraphEdges();
      if (nodeIdx >= 0 && nodeIdx < this._nodeCount) {
        const verts: number[] = [],
          colors: number[] = [];
        this._buildHoverEdgeVerts(nodeIdx, verts, colors);
        if (verts.length > 0) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
          geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
          this.highlightEdgeGroup.add(
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
    while (this.highlightEdgeGroup.children.length) this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);
    if (nodeIdx < 0 || nodeIdx >= this._nodeCount) return;
    const verts: number[] = [],
      colors: number[] = [];
    this._buildHoverEdgeVerts(nodeIdx, verts, colors);
    if (verts.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.highlightEdgeGroup.add(
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

  // ── Labels ───────────────────────────────────────────────

  private updateLabels(): void {
    const halfW = this.container.clientWidth * 0.5,
      halfH = this.container.clientHeight * 0.5;
    const hoverI = this.hoveredIdx;
    const selI = this._tooltip.selectedIdx;
    for (let k = 0; k < this.nodeLabelIdx.length; k++) {
      const i = this.nodeLabelIdx[k],
        div = this.labelDivs[k];
      if (!div) continue;
      this.tmpVec3.set(this.nodePositions[i * 3], this.nodePositions[i * 3 + 1], this.nodePositions[i * 3 + 2]);
      this.tmpVec3.project(this.camera);
      const behind = this.tmpVec3.z > 1;
      if (behind || this._fold.foldMode) {
        div.style.display = 'none';
        continue;
      }
      const focused = i === hoverI || i === selI;
      div.style.display = '';
      div.style.left = `${this.tmpVec3.x * halfW + halfW}px`;
      div.style.top = `${-this.tmpVec3.y * halfH + halfH}px`;
      div.style.opacity = focused ? '1' : '0.18';
      div.style.fontSize = focused ? '13px' : '11px';
    }
    // Galaxy labels — no distance fade, hover brightens
    for (let k = 0; k < this._fold.galaxyLabelDivs.length; k++) {
      const div = this._fold.galaxyLabelDivs[k];
      const gIdx = Number(div.dataset['galaxyIndex']);
      if (gIdx === undefined || gIdx >= this._fold.galaxyMeta.length) continue;
      const gm = this._fold.galaxyMeta[gIdx];
      this.tmpVec3.copy(gm.centroid);
      this.tmpVec3.project(this.camera);
      const behind = this.tmpVec3.z > 1;
      const hovered = gIdx === this.hoveredGalaxyIdx;
      div.style.display = !behind && this._fold.foldMode && !this._fold.enteredGalaxyId ? '' : 'none';
      div.style.left = `${this.tmpVec3.x * halfW + halfW}px`;
      div.style.top = `${-this.tmpVec3.y * halfH + halfH}px`;
      div.style.opacity = hovered ? '0.9' : '0.3';
      div.style.color = hovered ? 'rgba(255,220,160,0.95)' : '';
      div.style.fontSize = hovered ? '12px' : '10px';
      div.style.textShadow = hovered ? '0 0 14px rgba(255,180,60,0.9), 0 0 30px rgba(255,120,20,0.5)' : '';
    }
  }

  // ── Blast ────────────────────────────────────────────────

  private _flushOverrideAttrs(): void {
    if (this.nodeGlowsPoints?.geometry.attributes['override']) {
      this.nodeGlowsPoints.geometry.attributes['override'].needsUpdate = true;
    }
    if (this.nodeGlows2Points?.geometry.attributes['override']) {
      this.nodeGlows2Points.geometry.attributes['override'].needsUpdate = true;
    }
  }

  // ── Focus ────────────────────────────────────────────────

  private flyToNode(idx: number): void {
    const px = this.nodePositions[idx * 3],
      py = this.nodePositions[idx * 3 + 1],
      pz = this.nodePositions[idx * 3 + 2];
    const dist = 30 + (this.deg[idx] || 0) * 4;
    this._planFlight(new THREE.Vector3(px, py, pz), dist);
    this.focusNodeIdx = idx;
    this.focusFlash = 1;
  }

  // ponytail: 保持当前视线方向飞向 target，不横穿场景；delayMs>0 去抖，连击只飞最后一次
  private _planFlight(targetPos: THREE.Vector3, dist: number, delayMs = 150): void {
    if (this._flyDebounce) {
      clearTimeout(this._flyDebounce);
      this._flyDebounce = null;
    }
    const run = () => {
      const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
      if (dir.lengthSq() < 1e-4) dir.set(0.5, 0.4, 0.7);
      dir.normalize();
      this.focusTarget.copy(targetPos).add(dir.multiplyScalar(dist));
      this._focusLookTarget.copy(targetPos);
      this.focusStartCam.copy(this.camera.position);
      this.focusStartLook.copy(this.controls.target);
      this.focusActive = true;
      this.focusProgress = 0;
      this._focusStartTime = performance.now();
    };
    if (delayMs > 0 && !this._userInteracting) {
      this._flyDebounce = setTimeout(run, delayMs);
    } else {
      run();
    }
  }

  private _resettingCamera = false;

  /** Reset camera to the default overview position with smooth animation. */
  resetCamera(): void {
    if (this._initCamPos.lengthSq() < 1) return; // not initialized
    if (this._flyDebounce) {
      clearTimeout(this._flyDebounce);
      this._flyDebounce = null;
    }
    this.focusStartCam.copy(this.camera.position);
    this.focusStartLook.copy(this.controls.target);
    this.focusTarget.copy(this._initCamPos);
    this.focusActive = true;
    this.focusProgress = 0;
    this.focusNodeIdx = -1;
    this.focusFlash = 0;
    this._focusStartTime = performance.now();
    this._resettingCamera = true;
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
    const q = query.trim().toLowerCase();
    if (!q || this._nodeCount === 0) return false;
    const isAlive = (n: any, i: number) => n && !this._deadIndices.has(i);
    let idx = this.graphNodes.findIndex((n, i) => isAlive(n, i) && n.name.toLowerCase() === q);
    if (idx < 0) idx = this.graphNodes.findIndex((n, i) => isAlive(n, i) && n.name.toLowerCase().startsWith(q));
    if (idx < 0) idx = this.graphNodes.findIndex((n, i) => isAlive(n, i) && n.name.toLowerCase().includes(q));
    if (idx < 0) return false;
    // If fold mode is on, enter that galaxy instead of flying to node
    if (this._fold.foldMode) {
      const cid = this.nodeCommMap.get(idx);
      if (cid) {
        this.enterGalaxy(cid);
        return true;
      }
      // Orphan node — can't enter, just fly
      this.flyToNode(idx);
      return true;
    }
    this.flyToNode(idx);
    return true;
  }

  // ── File highlight (文件树 → 星图联动) ────────────────────

  /** Highlight all nodes belonging to a file (match by location prefix). */
  highlightFile(filePath: string): void {
    if (this.focusSubgraphActive) this.exitFocusSubgraph();
    // Restore any previous highlight before applying new one
    if (this._fileHighlight) this.clearFileHighlight();

    const normalized = filePath.replace(/\\/g, '/');

    for (let i = 0; i < this._nodeCount; i++) {
      const loc = (this.graphNodes[i].location || '').replace(/\\/g, '/');
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

    for (let i = 0; i < this._nodeCount; i++) {
      const loc = (this.graphNodes[i].location || '').replace(/\\/g, '/');
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

  /** Highlight only edges of one type, dim all others. null = clear filter. */
  setEdgeTypeFilter(edgeType: string | null): void {
    this._edgeTypeFilter = edgeType;
    if (edgeType === null) {
      for (const lines of this.edgeLineGroups) {
        (lines.material as LineMaterial).opacity = edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
      }
    } else {
      // ponytail: 按选中类边数分档 opacity, 防 AdditiveBlending 密集叠加过曝
      const et = edgeType.toLowerCase();
      const selCount = this.edgeDataList.reduce((n, d) => n + (d.edgeType.toLowerCase() === et ? 1 : 0), 0);
      const selOp = selCount > 2000 ? 0.08 : selCount > 200 ? 0.2 : 0.45;
      for (const lines of this.edgeLineGroups) {
        const mat = lines.material as LineMaterial;
        const letype = (lines.userData['edgeType'] as string) || '';
        mat.opacity = letype === edgeType ? selOp : 0.005;
      }
    }
    this._updateLegendActive(edgeType, this._nodeKindFilter);
  }

  /** Dim all nodes except those matching a kind filter. null = clear. */
  setNodeKindFilter(filter: string | null): void {
    this._nodeKindFilter = filter;
    if (filter === null) {
      for (let i = 0; i < this._nodeCount; i++) {
        this._overrideFlags[i] = 0;
        this._setGlowAlpha(i, 0.55);
        this._setCoreVisible(i, true);
        if (this._glow2Rgba.length > 0) this._setGlow2Alpha(i, 0.55);
      }
      this._flushOverrideAttrs();
      this._updateLegendActive(this._edgeTypeFilter, null);
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
    for (let i = 0; i < this._nodeCount; i++) {
      const kind = (this.graphNodes[i]?.type || this.graphNodes[i]?.kind || 'symbol') as string;
      const hit = matches(kind);
      this._overrideFlags[i] = hit ? 0 : 1; // matching=let shader animate, non-matching=CPU freeze at alpha 0
      if (hit) {
        this._setGlowAlpha(i, 0.88);
        if (this._glow2Rgba.length > 0) this._setGlow2Alpha(i, 0.48);
      } else {
        this._setGlowAlpha(i, 0);
        if (this._glow2Rgba.length > 0) this._setGlow2Alpha(i, 0);
      }
      this._setCoreVisible(i, hit);
    }
    this._flushOverrideAttrs();
    this._updateLegendActive(this._edgeTypeFilter, filter);
  }

  private _updateLegendActive(activeEdge: string | null, activeNode: string | null = null): void {
    this.legendEl.querySelectorAll<HTMLElement>('.legend-edge-row').forEach((row) => {
      const et = row.dataset['edgeType'] || '';
      row.classList.toggle('active', activeEdge !== null && et === activeEdge);
      row.style.opacity = activeEdge === null ? '1' : et === activeEdge ? '1' : '0.35';
    });
    this.legendEl.querySelectorAll<HTMLElement>('.legend-node-row').forEach((row) => {
      const nk = row.dataset['nodeFilter'] || '';
      row.classList.toggle('active', activeNode !== null && nk === activeNode);
      row.style.opacity = activeNode === null ? '1' : nk === activeNode ? '1' : '0.35';
    });
  }

  // ── Color mode switching ──────────────────────────────────

  /** Cycle node coloring mode. Returns the new mode's display label. */
  // ── Node scale mode ──────────────────────────────────────

  private getNodeBaseScale(i: number): number {
    const val = this.scaleMode === 'degree' ? this.deg[i] : this.l34Count[i] || 0;
    const maxVal = this.scaleMode === 'degree' ? this.maxDeg : Math.max(1, ...this.l34Count);
    return 0.6 + (val / maxVal) * 2.8;
  }

  // ── Batched GPU helpers (ponytail: write to InstancedMesh/Points buffers) ──

  private _setCoreColor(i: number, c: number | THREE.Color): void {
    if (!this.nodeCoresInstanced || i >= this._nodeCount) return;
    const cc = c instanceof THREE.Color ? c : new THREE.Color(c);
    this.nodeCoresInstanced.setColorAt(i, cc);
    if (this.nodeCoresInstanced.instanceColor) this.nodeCoresInstanced.instanceColor.needsUpdate = true;
  }

  private _setCoreScale(i: number, s: number): void {
    if (!this.nodeCoresInstanced || i >= this._nodeCount) return;
    this._coreScales[i] = s;
    const m = new THREE.Matrix4();
    this.nodeCoresInstanced.getMatrixAt(i, m);
    const p = new THREE.Vector3();
    m.decompose(p, new THREE.Quaternion(), new THREE.Vector3());
    m.compose(p, new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    this.nodeCoresInstanced.setMatrixAt(i, m);
    this.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
  }

  private _setCoreVisible(i: number, v: boolean): void {
    this._setCoreScale(i, v ? this._coreScales[i] || this._getCoreBaseScale(i) : 0);
  }

  private _getCoreBaseScale(i: number): number {
    return this.getNodeBaseScale(i) * 0.35;
  }

  private _setGlowRgba(i: number, r: number, g: number, b: number, a: number): void {
    if (!this.nodeGlowsPoints || i >= this._nodeCount) return;
    this._glowRgba[i * 4] = r;
    this._glowRgba[i * 4 + 1] = g;
    this._glowRgba[i * 4 + 2] = b;
    this._glowRgba[i * 4 + 3] = a;
    this.nodeGlowsPoints.geometry.attributes['color'].needsUpdate = true;
  }

  private _setGlowColor(i: number, c: THREE.Color | number, a?: number): void {
    const cc = c instanceof THREE.Color ? c : new THREE.Color(c);
    this._setGlowRgba(i, cc.r, cc.g, cc.b, a ?? this._glowRgba[i * 4 + 3]);
  }

  private _setGlowAlpha(i: number, a: number): void {
    if (i < this._nodeCount) {
      this._glowRgba[i * 4 + 3] = a;
      if (this.nodeGlowsPoints) this.nodeGlowsPoints.geometry.attributes['color'].needsUpdate = true;
    }
  }

  private _setGlow2Rgba(i: number, r: number, g: number, b: number, a: number): void {
    if (!this.nodeGlows2Points || i >= this._nodeCount) return;
    this._glow2Rgba[i * 4] = r;
    this._glow2Rgba[i * 4 + 1] = g;
    this._glow2Rgba[i * 4 + 2] = b;
    this._glow2Rgba[i * 4 + 3] = a;
    this.nodeGlows2Points.geometry.attributes['color'].needsUpdate = true;
  }

  private _setGlow2Alpha(i: number, a: number): void {
    if (i < this._nodeCount && this._glow2Rgba.length > 0) {
      this._glow2Rgba[i * 4 + 3] = a;
      if (this.nodeGlows2Points) this.nodeGlows2Points.geometry.attributes['color'].needsUpdate = true;
    }
  }

  private _flushBatch(): void {
    if (this.nodeCoresInstanced) {
      this.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
      if (this.nodeCoresInstanced.instanceColor) this.nodeCoresInstanced.instanceColor.needsUpdate = true;
    }
    if (this.nodeGlowsPoints?.geometry.attributes['color']) {
      this.nodeGlowsPoints.geometry.attributes['color'].needsUpdate = true;
    }
    if (this.nodeGlowsPoints?.geometry.attributes['size']) {
      this.nodeGlowsPoints.geometry.attributes['size'].needsUpdate = true;
    }
    if (this.nodeGlows2Points?.geometry.attributes['color']) {
      this.nodeGlows2Points.geometry.attributes['color'].needsUpdate = true;
    }
    if (this.nodeGlows2Points?.geometry.attributes['size']) {
      this.nodeGlows2Points.geometry.attributes['size'].needsUpdate = true;
    }
  }

  /** Magnitude factor 0.15–1.0: hub nodes shine bright, leaf nodes barely visible. Pre-computed cache. */
  private _nodeMag(i: number): number {
    return this._nodeMagCache[i] ?? 0.15;
  }

  // ── Agent highlight (Agent ↔ 星图联动) ──────────────────

  /** Highlight a set of nodes by name (fuzzy match). Matched nodes glow in the given color; others dim. */
  highlightNodeNames(names: string[], colorHex?: string): void {
    if (this.focusSubgraphActive) this.exitFocusSubgraph();
    this._clearAgentHighlightState();
    if (!names.length || this._nodeCount === 0) return;

    const color = colorHex ? parseInt(colorHex.replace('#', ''), 16) : 0xf0b848; // default sol
    const lowerNames = names.map((n) => n.trim().toLowerCase());

    for (let i = 0; i < this._nodeCount; i++) {
      const nodeName = (this.graphNodes[i].name || '').toLowerCase();
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
    for (let i = 0; i < this._nodeCount; i++) {
      this._overrideFlags[i] = 1;
      if (this._agentHighlightIndices.has(i)) {
        this._setGlowColor(i, color);
        this._setGlowAlpha(i, 0.88);
        this._setCoreVisible(i, true);
      } else {
        this._setGlowAlpha(i, 0.025);
      }
    }
    this._flushOverrideAttrs();
    // Dim non-path edges
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = 0.008;
    }
  }

  /** Show the dependency path between two nodes on the graph. */

  /** Clear all Agent-triggered highlights (path + node highlight). */
  clearAgentHighlight(): void {
    this._clearAgentHighlightState();
    this._analysis.clearPath();
    // Also restore any file highlight if active
    if (this._fileHighlight) {
      this._applyFileHighlight();
    }
  }

  private _clearAgentHighlightState(): void {
    if (this._agentHighlightIndices.size === 0) return;
    // Restore original glows for previously highlighted nodes + clear override
    for (const i of this._agentHighlightIndices) {
      if (i < this._nodeCount) {
        this._overrideFlags[i] = 0;
        this._setGlowColor(i, this.nodeGlowColors[i]);
        this._setGlowAlpha(i, 0.55);
      }
      this._setCoreVisible(i, true);
    }
    // Restore non-highlighted dimmed nodes (opacity + visibility)
    for (let i = 0; i < this._nodeCount; i++) {
      if (!this._agentHighlightIndices.has(i)) {
        this._overrideFlags[i] = 0;
        this._setGlowAlpha(i, 0.55);
        this._setCoreVisible(i, true);
      }
    }
    this._flushOverrideAttrs();
    // Restore edge opacities
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
    }
    this._agentHighlightIndices.clear();
  }

  // ── P6: Hotspot highlighting — 复发热点着色 ──

  private _hotspotFiles: Map<string, number> = new Map(); // filePath → recurrence count

  /** Color nodes belonging to hotspot files with intensity proportional to L4 recurrence count. */
  highlightHotspots(hotspots: Array<{ file: string; count: number }>): void {
    this.clearHotspots();
    if (!hotspots.length || this._nodeCount === 0) return;

    // Build a map of filename → count
    for (const hs of hotspots) {
      const key = (hs.file || '').replace(/\\/g, '/').toLowerCase();
      const prev = this._hotspotFiles.get(key) || 0;
      this._hotspotFiles.set(key, Math.max(prev, hs.count));
    }

    // Apply coloring: intensity from 0.3 (count=2) to 1.0 (count≥8)
    for (let i = 0; i < this._nodeCount; i++) {
      const loc = (this.graphNodes[i].location || '').toLowerCase();
      if (!loc) continue;
      for (const [hsPath, count] of this._hotspotFiles) {
        if (loc.includes(hsPath) || hsPath.includes(loc)) {
          const intensity = Math.min(1, 0.3 + (count - 2) * 0.12);
          if (i < this._nodeCount) {
            this._overrideFlags[i] = 1;
            const r = 0.85,
              g = 0.2 + (1 - intensity) * 0.3,
              b = 0.2 + (1 - intensity) * 0.3;
            this._setGlowRgba(i, r, g, b, 0.35 + intensity * 0.55);
          }
          break;
        }
      }
    }
    this._flushOverrideAttrs();
  }

  clearHotspots(): void {
    if (this._hotspotFiles.size === 0) return;
    this._hotspotFiles.clear();
    // Restore original glow colors and clear override flags
    for (let i = 0; i < this._nodeCount; i++) {
      if (i < this._nodeCount) {
        this._overrideFlags[i] = 0;
        this._setGlowColor(i, this.nodeGlowColors[i] || 0x5588cc);
        this._setGlowAlpha(i, 0.55);
      }
    }
    this._flushOverrideAttrs();
  }

  // ── Agent Lens (Step 2) — dim everything except visited nodes ──

  /** Dim all nodes except those matching the given names to 1% opacity. */
  setAgentLens(nodeNames: Set<string>): void {
    if (!nodeNames || nodeNames.size === 0 || this._nodeCount === 0) {
      this.clearAgentLens();
      return;
    }

    // Build set of matched node indices
    const lensIndices = new Set<number>();
    const lowerNames = Array.from(nodeNames).map((n) => n.trim().toLowerCase());

    for (let i = 0; i < this._nodeCount; i++) {
      const nodeName = (this.graphNodes[i].name || '').toLowerCase();
      const shortName = nodeName.split('.').pop() || '';
      const found = lowerNames.some(
        (q) => nodeName === q || nodeName.startsWith(q) || nodeName.includes(q) || shortName === q,
      );
      if (found) lensIndices.add(i);
    }

    if (lensIndices.size === 0) return;

    // Apply lens: visited nodes stay bright, others dim to 1%
    for (let i = 0; i < this._nodeCount; i++) {
      this._overrideFlags[i] = 1;
      if (lensIndices.has(i)) {
        this._setGlowAlpha(i, 0.88);
        this._setCoreVisible(i, true);
      } else {
        this._setGlowAlpha(i, 0.01);
      }
    }
    this._flushOverrideAttrs();

    // Dim all edges
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = 0.005;
    }

    this._lensActive = true;
  }

  /** Restore normal rendering from agent lens mode. */
  clearAgentLens(): void {
    if (!this._lensActive) return;
    this._lensActive = false;

    for (let i = 0; i < this._nodeCount; i++) {
      this._overrideFlags[i] = 0;
      this._setGlowAlpha(i, 0.55);
      this._setCoreVisible(i, true);
    }
    this._flushOverrideAttrs();

    // Restore edge opacities
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
    }

    this._clearTrailLine();
  }

  // ── Agent Trail (retrospective mode) — thick glowing line + visited node highlight ──

  /** Activate retrospective trail mode: highlight all visited nodes, dim others
   *  to 30% (not 2.5% — still visible, just backgrounded), draw a thick glowing
   *  trail line through the exploration sequence, and fly camera to the centroid. */
  showAgentTrail(visitedNames: Set<string>, trailNames: string[]): void {
    if (this._nodeCount === 0) return;

    // 1. Find indices for visited nodes
    const visitedIndices = new Set<number>();
    for (const name of visitedNames) {
      const idx = this._findNodeIndexByName(name);
      if (idx >= 0) visitedIndices.add(idx);
    }
    if (visitedIndices.size === 0) return;

    // 2. Apply lens: visited at 80%, unvisited at 30% (readable backdrop)
    for (let i = 0; i < this._nodeCount; i++) {
      this._overrideFlags[i] = 1;
      if (visitedIndices.has(i)) {
        this._setGlowAlpha(i, 0.85);
        this._setCoreVisible(i, true);
      } else {
        this._setGlowAlpha(i, 0.3);
      }
    }
    this._flushOverrideAttrs();

    // 3. Dim edges so trail pops
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = 0.015;
    }

    // 4. Draw thick trail line
    this._drawAgentTrail(trailNames);

    // 5. Fly camera to trail centroid
    this._flyToCentroid(visitedIndices);

    this._trailActive = true;
  }

  /** Restore normal rendering from trail mode. */
  hideAgentTrail(): void {
    if (!this._trailActive) return;
    this._trailActive = false;

    for (let i = 0; i < this._nodeCount; i++) {
      this._overrideFlags[i] = 0;
      this._setGlowAlpha(i, 0.55);
      this._setCoreVisible(i, true);
    }
    this._flushOverrideAttrs();

    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
    }

    this._clearTrailLine();
  }

  get isTrailActive(): boolean {
    return this._trailActive;
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

    const pos = this.nodePositions;
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
    this.nodeGroup.add(this._trailLine);
  }

  /** Remove the existing trail line. Handles both LineSegments (old) and LineSegments2 (new). */
  private _clearTrailLine(): void {
    if (this._trailLine) {
      this.nodeGroup.remove(this._trailLine);
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
  private _findNodeIndexByName(query: string): number {
    const q = query.trim().toLowerCase();
    if (!q || this._nodeCount === 0) return -1;
    let idx = this.graphNodes.findIndex((n) => n.name.toLowerCase() === q);
    if (idx < 0) idx = this.graphNodes.findIndex((n) => n.name.toLowerCase().startsWith(q));
    if (idx < 0) idx = this.graphNodes.findIndex((n) => n.name.toLowerCase().includes(q));
    return idx;
  }

  /** Fly camera to the centroid of a set of node indices. */
  private _flyToCentroid(indices: Set<number>): void {
    if (indices.size === 0) return;
    let cx = 0,
      cy = 0,
      cz = 0;
    for (const i of indices) {
      cx += this.nodePositions[i * 3];
      cy += this.nodePositions[i * 3 + 1];
      cz += this.nodePositions[i * 3 + 2];
    }
    const n = indices.size;
    const mx = cx / n,
      my = cy / n,
      mz = cz / n;
    // ponytail: 用包围盒半径算自适应距离，密集星团不贴脸、稀疏区域不偏远
    let r = 0;
    for (const i of indices) {
      const dx = this.nodePositions[i * 3] - mx,
        dy = this.nodePositions[i * 3 + 1] - my,
        dz = this.nodePositions[i * 3 + 2] - mz;
      r = Math.max(r, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    this._planFlight(new THREE.Vector3(mx, my, mz), Math.max(40, r * 3.2));
  }

  private _applyFileHighlight(): void {
    const hl = this._fileHighlight;
    const idxs = this._fileHighlightIndices;

    // Nodes: dim non-highlighted, set override so shader doesn't animate over
    for (let i = 0; i < this._nodeCount; i++) {
      const visible = !hl || idxs.has(i);
      if (hl && !visible) {
        this._overrideFlags[i] = 1;
        this._setGlowAlpha(i, 0.03);
      } else if (!hl) {
        this._overrideFlags[i] = 0;
        this._setGlowAlpha(i, 0.55);
      }
    }
    if (hl || this._fileOpacityOriginal.size > 0) {
      this._flushOverrideAttrs();
      this._fileOpacityOriginal.clear();
    }

    // Edges: dim all when highlighting
    for (const lines of this.edgeLineGroups) {
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
    for (let k = 0; k < this.nodeLabelIdx.length; k++) {
      this.labelDivs[k].style.display = !hl || idxs.has(this.nodeLabelIdx[k]) ? '' : 'none';
    }
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

  // ponytail: 总览(相机距 target > graphRadius*2.2)关 bloom 防边密集叠加区被 bloom 扩散成雾;
  // 聚焦(< graphRadius*1.6)开 bloom 让 hover/选中节点发光鲜明。滞回 30 帧防阈值抖动回弹。
  private _updateBloomByDistance(): void {
    if (this._graphRadius < 1 || this._fold.foldMode) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const farThresh = this._graphRadius * 2.2;
    const nearThresh = this._graphRadius * 1.6;
    const hasBloom = this.composer.passes.indexOf(this.bloomPass) !== -1;
    if (this._bloomHysteresis > 0) {
      this._bloomHysteresis--;
      return;
    }
    if (this._bloomFar) {
      if (dist < nearThresh) {
        this._bloomFar = false;
        if (!hasBloom) this.composer.addPass(this.bloomPass);
        this._bloomHysteresis = 30;
      }
    } else {
      if (dist > farThresh) {
        this._bloomFar = true;
        if (hasBloom) this.composer.removePass(this.bloomPass);
        this._bloomHysteresis = 30;
      }
    }
  }

  // ── Diff overlay (P4: 变更回看着色) ──────────────────────

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

    for (let i = 0; i < this._nodeCount; i++) {
      if (!this.graphNodes[i]) continue;
      const nid = this.graphNodes[i].id;
      let diffColor: number | null = null;
      if (this.diffAddedIds.has(nid)) diffColor = GREEN;
      else if (this.diffRemovedIds.has(nid)) diffColor = RED;
      else if (this.diffModifiedIds.has(nid)) diffColor = ORANGE;

      if (diffColor !== null) {
        // ponytail: override=1 forces shader to use CPU-set color instead of animated twinkle
        this._overrideFlags[i] = 1;
        this._setGlowColor(i, diffColor);
        this._setGlowAlpha(i, 0.85);
        if (this._glow2Rgba.length > 0) this._setGlow2Alpha(i, 0.5);
      }
    }
    this._flushOverrideAttrs();

    // Pulse effect on added diff nodes: slightly increase scale
    for (let i = 0; i < this._nodeCount; i++) {
      if (this.graphNodes[i] && this.diffAddedIds.has(this.graphNodes[i].id)) {
        this._setCoreScale(i, (this._coreScales[i] || 1) * 1.3);
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
    for (let i = 0; i < this._nodeCount; i++) {
      if (!this.graphNodes[i]) continue;
      if (this._deadIndices.has(i)) {
        // ponytail: dead nodes stay invisible when diff is cleared
        this._setGlowAlpha(i, 0);
        if (this._glow2Rgba.length > 0) this._setGlow2Alpha(i, 0);
        this._setCoreVisible(i, false);
        continue;
      }
      const kind = ((this.graphNodes[i].type || this.graphNodes[i].kind || 'symbol') as string).toLowerCase();
      const glowColor = GLOW_COLORS[kind] || 0x4488cc;
      this._overrideFlags[i] = 0; // restore shader animation
      this._setGlowColor(i, glowColor);
      this._setGlowAlpha(i, 0.55);
      if (this._glow2Rgba.length > 0) this._setGlow2Alpha(i, 0.55);
      const coreColor = NODE_COLORS[kind] || 0x6ab0ff;
      this._setCoreColor(i, coreColor);
      const baseScale = this.getNodeBaseScale(i);
      this._setCoreScale(i, isFull ? baseScale * 0.4 : baseScale);
    }
    this._flushOverrideAttrs();
  }

  get hasDiff(): boolean {
    return this.diffActive;
  }
  get hasGraph(): boolean {
    return this._nodeCount > 0;
  }

  // ══════════════════════════════════════════════════════════
  // Incremental graph update — apply diff without full re-render
  // ══════════════════════════════════════════════════════════

  /** Mark a node as dead: invisible but kept in graphNodes for index stability. */
  private _markNodeDead(idx: number): void {
    this._deadIndices.add(idx);
    this._overrideFlags[idx] = 1;
    this._setCoreVisible(idx, false);
    this._setGlowAlpha(idx, 0);
    if (this._glow2Rgba.length > 0) this._setGlow2Alpha(idx, 0);
  }

  /** Dispose all edge line groups and clear edgeGroup. */
  private _disposeEdges(): void {
    for (const lines of this.edgeLineGroups) {
      lines.geometry?.dispose();
      (lines.material as THREE.Material)?.dispose();
      this.edgeGroup.remove(lines);
    }
    this.edgeLineGroups = [];
  }

  /** Rebuild InstancedMesh + Points with larger capacity, copying old data. */
  private _rebuildNodeBuffers(newCapacity: number): void {
    const oldCount = this._nodeCount;
    const extendF32 = (old: Float32Array, mul: number) => {
      const n = new Float32Array(newCapacity * mul);
      n.set(old);
      return n;
    };
    this._coreScales = extendF32(this._coreScales, 1);
    this._glowRgba = extendF32(this._glowRgba, 4);
    this._glow2Rgba = extendF32(this._glow2Rgba, 4);
    this._glowSizes = extendF32(this._glowSizes, 1);
    this._glow2Sizes = extendF32(this._glow2Sizes, 1);
    this._overrideFlags = extendF32(this._overrideFlags, 1);
    this._nodeMagCache = extendF32(this._nodeMagCache, 1);
    const newPos = new Float32Array(newCapacity * 3);
    newPos.set(this.nodePositions);
    this.nodePositions = newPos;
    const newHSL: Array<{ h: number; s: number; l: number }> = new Array(newCapacity);
    for (let i = 0; i < oldCount; i++) newHSL[i] = this._nodeBaseHSL[i];
    this._nodeBaseHSL = newHSL;
    while (this.deg.length < newCapacity) this.deg.push(0);

    // --- InstancedMesh ---
    const oldInst = this.nodeCoresInstanced;
    const newInst = new THREE.InstancedMesh(this.sphereGeo, this._makeCoreFresnelMaterial(), newCapacity);
    newInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    newInst.count = oldCount;
    newInst.frustumCulled = false;
    const _m = new THREE.Matrix4();
    const _c = new THREE.Color();
    for (let i = 0; i < oldCount; i++) {
      oldInst.getMatrixAt(i, _m);
      newInst.setMatrixAt(i, _m);
      if (oldInst.instanceColor) {
        oldInst.getColorAt(i, _c);
        newInst.setColorAt(i, _c);
      }
    }
    newInst.instanceMatrix.needsUpdate = true;
    if (newInst.instanceColor) newInst.instanceColor.needsUpdate = true;
    (oldInst.material as THREE.Material)?.dispose();
    this.nodeGroup.remove(oldInst);
    this.nodeGroup.add(newInst);
    this.nodeCoresInstanced = newInst;

    // --- Points geometries ---
    const oldGlowGeo = this.nodeGlowsPoints.geometry;
    const phaseArr = new Float32Array(newCapacity);
    const speedArr = new Float32Array(newCapacity);
    const magArr = new Float32Array(newCapacity);
    const riskArr = new Float32Array(newCapacity);
    const hslArr = new Float32Array(newCapacity * 3);
    phaseArr.set(oldGlowGeo.attributes['phase'].array as Float32Array);
    speedArr.set(oldGlowGeo.attributes['speed'].array as Float32Array);
    magArr.set(oldGlowGeo.attributes['mag'].array as Float32Array);
    riskArr.set(oldGlowGeo.attributes['risk'].array as Float32Array);
    hslArr.set(oldGlowGeo.attributes['baseHSL'].array as Float32Array);
    const glowPosArr = new Float32Array(newCapacity * 3);
    glowPosArr.set(oldGlowGeo.attributes['position'].array as Float32Array);
    const glow2PosArr = new Float32Array(newCapacity * 3);
    if (this.nodeGlows2Points)
      glow2PosArr.set(this.nodeGlows2Points.geometry.attributes['position'].array as Float32Array);

    const addAnimAttrs = (geo: THREE.BufferGeometry) => {
      geo.setAttribute('phase', new THREE.BufferAttribute(phaseArr, 1));
      geo.setAttribute('speed', new THREE.BufferAttribute(speedArr, 1));
      geo.setAttribute('mag', new THREE.BufferAttribute(magArr, 1));
      geo.setAttribute('risk', new THREE.BufferAttribute(riskArr, 1));
      geo.setAttribute('baseHSL', new THREE.BufferAttribute(hslArr, 3));
      geo.setAttribute('override', new THREE.BufferAttribute(this._overrideFlags, 1));
    };

    (this.nodeGlowsPoints.material as THREE.Material)?.dispose();
    oldGlowGeo.dispose();
    this.nodeGroup.remove(this.nodeGlowsPoints);
    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', new THREE.BufferAttribute(glowPosArr, 3));
    glowGeo.setAttribute('color', new THREE.BufferAttribute(this._glowRgba, 4));
    glowGeo.setAttribute('size', new THREE.BufferAttribute(this._glowSizes, 1));
    addAnimAttrs(glowGeo);
    this.nodeGlowsPoints = new THREE.Points(glowGeo, this._makeGlowPointMaterial(1.5, 1.0));
    this.nodeGlowsPoints.frustumCulled = false;
    this.nodeGlowsPoints.renderOrder = 1;
    this.nodeGroup.add(this.nodeGlowsPoints);

    if (this.nodeGlows2Points) {
      (this.nodeGlows2Points.material as THREE.Material)?.dispose();
      this.nodeGlows2Points.geometry.dispose();
      this.nodeGroup.remove(this.nodeGlows2Points);
      const g2Geo = new THREE.BufferGeometry();
      g2Geo.setAttribute('position', new THREE.BufferAttribute(glow2PosArr, 3));
      g2Geo.setAttribute('color', new THREE.BufferAttribute(this._glow2Rgba, 4));
      g2Geo.setAttribute('size', new THREE.BufferAttribute(this._glow2Sizes, 1));
      addAnimAttrs(g2Geo);
      this.nodeGlows2Points = new THREE.Points(g2Geo, this._makeGlowPointMaterial(0.55, 0.85));
      this.nodeGlows2Points.frustumCulled = false;
      this.nodeGlows2Points.renderOrder = 1;
      this.nodeGroup.add(this.nodeGlows2Points);
    }

    this._nodeCapacity = newCapacity;
  }

  /** Append new nodes to existing buffers (capacity must be sufficient). */
  private _appendNodes(nodes: GraphNode[], fullGraph: GraphJSON, nodeIdxMap: Map<string, number>): void {
    // ponytail: 只取 level0 社区 — 与 _renderImpl 的 nodeCommMap 层级一致
    const allComms = ((fullGraph as any).hierarchical_communities ||
      (fullGraph as any).communities ||
      []) as CommunityData[];
    const comms = allComms.filter((c) => !c.level || c.level === 0);
    const nodeComm = new Map<string, string>();
    for (const c of comms) for (const nid of c.node_ids) nodeComm.set(nid, c.id);

    // Community centroids from existing alive nodes
    const centroids = new Map<string, { x: number; y: number; z: number; n: number }>();
    for (let i = 0; i < this._nodeCount; i++) {
      if (this._deadIndices.has(i)) continue;
      const cid = this.nodeCommMap.get(i);
      if (!cid) continue;
      let c = centroids.get(cid);
      if (!c) {
        c = { x: 0, y: 0, z: 0, n: 0 };
        centroids.set(cid, c);
      }
      c.x += this.nodePositions[i * 3];
      c.y += this.nodePositions[i * 3 + 1];
      c.z += this.nodePositions[i * 3 + 2];
      c.n++;
    }
    for (const c of centroids.values()) {
      c.x /= c.n;
      c.y /= c.n;
      c.z /= c.n;
    }

    // Graph center fallback
    let bcx = 0,
      bcy = 0,
      bcz = 0,
      bn = 0;
    for (let i = 0; i < this._nodeCount; i++) {
      if (this._deadIndices.has(i)) continue;
      bcx += this.nodePositions[i * 3];
      bcy += this.nodePositions[i * 3 + 1];
      bcz += this.nodePositions[i * 3 + 2];
      bn++;
    }
    if (bn > 0) {
      bcx /= bn;
      bcy /= bn;
      bcz /= bn;
    }

    const _m = new THREE.Matrix4();
    const _v = new THREE.Vector3();
    const _q = new THREE.Quaternion();

    for (const node of nodes) {
      const i = this._nodeCount;
      const cid = nodeComm.get(node.id);
      const ct = cid ? centroids.get(cid) : null;
      const jitter = ct ? 15 : 40;
      const px = (ct ? ct.x : bcx) + (Math.random() - 0.5) * jitter;
      const py = (ct ? ct.y : bcy) + (Math.random() - 0.5) * jitter;
      const pz = (ct ? ct.z : bcz) + (Math.random() - 0.5) * jitter;

      this.nodePositions[i * 3] = px;
      this.nodePositions[i * 3 + 1] = py;
      this.nodePositions[i * 3 + 2] = pz;
      this.graphNodes[i] = node;

      const kind = ((node.type || node.kind || 'symbol') as string).toLowerCase();
      const glowColor = GLOW_COLORS[kind] || 0x4488cc;
      const coreColor = NODE_COLORS[kind] || 0x6ab0ff;
      const gc = new THREE.Color(glowColor);
      const hsl = { h: 0, s: 0, l: 0 };
      gc.getHSL(hsl);

      // Core
      this._coreScales[i] = 0.8 * 0.35;
      this.nodeCoresInstanced.setMatrixAt(
        i,
        _m.compose(
          _v.set(px, py, pz),
          _q,
          new THREE.Vector3(this._coreScales[i], this._coreScales[i], this._coreScales[i]),
        ),
      );
      this._setCoreColor(i, coreColor);
      this.nodeCoreColors[i] = coreColor;
      this.nodeGlowColors[i] = glowColor;
      this._nodeBaseHSL[i] = hsl;

      // Glow points (position+color+size are per-geometry; phase/speed/mag/risk/baseHSL/override are shared)
      const gAttr = this.nodeGlowsPoints.geometry.attributes;
      (gAttr['position'].array as Float32Array)[i * 3] = px;
      (gAttr['position'].array as Float32Array)[i * 3 + 1] = py;
      (gAttr['position'].array as Float32Array)[i * 3 + 2] = pz;
      this._glowRgba[i * 4] = gc.r;
      this._glowRgba[i * 4 + 1] = gc.g;
      this._glowRgba[i * 4 + 2] = gc.b;
      this._glowRgba[i * 4 + 3] = 0.85;
      this._glowSizes[i] = 1.0 * 0.8; // ponytail: 新节点 deg=0, baseScale=0.8; _rebuildEdgeData 后不回填, 跟 core 对齐足够
      // Shared anim attrs (write once — both geometries share the same arrays)
      (gAttr['phase'].array as Float32Array)[i] = Math.random() * Math.PI * 2;
      (gAttr['speed'].array as Float32Array)[i] = 0.5 + Math.random() * 2.5;
      (gAttr['mag'].array as Float32Array)[i] = 0.15;
      (gAttr['risk'].array as Float32Array)[i] = 0;
      (gAttr['baseHSL'].array as Float32Array)[i * 3] = hsl.h;
      (gAttr['baseHSL'].array as Float32Array)[i * 3 + 1] = hsl.s;
      (gAttr['baseHSL'].array as Float32Array)[i * 3 + 2] = hsl.l;
      this._overrideFlags[i] = 0;

      // Outer glow (separate position/color/size)
      if (this.nodeGlows2Points) {
        const g2Attr = this.nodeGlows2Points.geometry.attributes;
        (g2Attr['position'].array as Float32Array)[i * 3] = px;
        (g2Attr['position'].array as Float32Array)[i * 3 + 1] = py;
        (g2Attr['position'].array as Float32Array)[i * 3 + 2] = pz;
        this._glow2Rgba[i * 4] = gc.r;
        this._glow2Rgba[i * 4 + 1] = gc.g;
        this._glow2Rgba[i * 4 + 2] = gc.b;
        this._glow2Rgba[i * 4 + 3] = 0.55;
        this._glow2Sizes[i] = 0.8 * 0.8; // ponytail: 同 inner glow, baseScale=0.8
      }

      if (cid) this.nodeCommMap.set(i, cid);
      nodeIdxMap.set(node.id, i);
      this._nodeCount++;
    }

    // Upload all
    this.nodeCoresInstanced.count = this._nodeCount;
    this.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
    if (this.nodeCoresInstanced.instanceColor) this.nodeCoresInstanced.instanceColor.needsUpdate = true;
    this.nodeCoresInstanced.boundingSphere = null;
    const markAll = (p: THREE.Points) => {
      const g = p.geometry;
      for (const k of Object.keys(g.attributes)) g.attributes[k].needsUpdate = true;
    };
    markAll(this.nodeGlowsPoints);
    if (this.nodeGlows2Points) markAll(this.nodeGlows2Points);
  }

  /** Rebuild edge data structures + edge geometry from full graph. */
  private _rebuildEdgeData(fullGraph: GraphJSON, nodeIdxMap: Map<string, number>): void {
    const edges = Array.isArray(fullGraph.edges) ? fullGraph.edges : Object.values(fullGraph.edges);
    const eData: EdgeData[] = [];
    const deg = new Array<number>(this._nodeCount).fill(0);
    const nodeFile = new Map<number, string>();
    for (let i = 0; i < this._nodeCount; i++) {
      if (this._deadIndices.has(i)) continue;
      nodeFile.set(i, (this.graphNodes[i]?.location || '').replace(/:\d+$/, ''));
    }
    for (const e of edges) {
      const s = nodeIdxMap.get(e.source);
      const t = nodeIdxMap.get(e.target);
      if (s === undefined || t === undefined || s === t) continue;
      if (this._deadIndices.has(s) || this._deadIndices.has(t)) continue;
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
    this.deg = deg;
    this.edgeDataList = eData;
    this.maxDeg = Math.max(...deg, 1);

    this.neighborMap = Array.from({ length: this._nodeCount }, () => []);
    this.edgeIndexOf = Array.from({ length: this._nodeCount }, () => []);
    for (let ei = 0; ei < eData.length; ei++) {
      const { s, t } = eData[ei];
      this.neighborMap[s].push(t);
      this.neighborMap[t].push(s);
      this.edgeIndexOf[s].push(ei);
      this.edgeIndexOf[t].push(ei);
    }
    this.l34Count = new Array(this._nodeCount).fill(0);
    for (const e of eData) {
      if (e.couplingDepth >= 3) {
        this.l34Count[e.s]++;
        this.l34Count[e.t]++;
      }
    }

    // Update mag/risk GPU attrs for all nodes
    const logMax = Math.log1p(this.maxDeg);
    const gAttr = this.nodeGlowsPoints?.geometry.attributes;
    const g2Attr = this.nodeGlows2Points?.geometry.attributes;
    for (let i = 0; i < this._nodeCount; i++) {
      this._nodeMagCache[i] = 0.15 + 0.85 * (Math.log1p(this.deg[i]) / logMax);
      if (gAttr) {
        (gAttr['mag'].array as Float32Array)[i] = this._nodeMagCache[i];
        (gAttr['risk'].array as Float32Array)[i] = this.l34Count[i] || 0;
      }
    }
    if (gAttr) {
      gAttr['mag'].needsUpdate = true;
      gAttr['risk'].needsUpdate = true;
    }
    if (g2Attr) {
      g2Attr['mag'].needsUpdate = true;
      g2Attr['risk'].needsUpdate = true;
    }

    this._disposeEdges();
    this.buildEdges(this.nodePositions, eData);
    this.initEdgeParticles(this.nodePositions, eData);
    this.positionGrid(this.nodePositions);
  }

  /**
   * Apply a graph diff incrementally — no layout recalc, no camera reset,
   * no progressive reveal. Preserves hover/selected/blast/filter/diff state.
   * Falls back to full render() if no existing graph.
   */
  async applyGraphDiff(diff: GraphDiffJson, fullGraph: GraphJSON): Promise<void> {
    if (this._nodeCount === 0) {
      this.render(fullGraph);
      return;
    }

    // Exit fold mode — incremental + fold is visually inconsistent
    if (this._fold.foldMode) this.setFoldMode(false);

    // Build node ID → index map (alive nodes only)
    const nodeIdxMap = new Map<string, number>();
    for (let i = 0; i < this.graphNodes.length; i++) {
      if (!this._deadIndices.has(i) && this.graphNodes[i]) nodeIdxMap.set(this.graphNodes[i].id, i);
    }

    const newIndices = new Set<number>(); // track which nodes are new
    const neighborIndices = new Set<number>(); // neighbors of new nodes

    // 1. Removed nodes → mark dead
    for (const rn of diff.removed_nodes) {
      const idx = nodeIdxMap.get(rn.id);
      if (idx !== undefined) {
        this._markNodeDead(idx);
        nodeIdxMap.delete(rn.id);
      }
    }

    // 2. Modified nodes → update kind/color
    for (const mn of diff.modified_nodes) {
      const idx = nodeIdxMap.get(mn.node_id);
      if (idx === undefined) continue;
      this.graphNodes[idx].name = mn.name;
      this.graphNodes[idx].kind = mn.new_kind;
      this.graphNodes[idx].type = mn.new_kind;
      const kind = mn.new_kind.toLowerCase();
      const glowColor = GLOW_COLORS[kind] || 0x4488cc;
      const coreColor = NODE_COLORS[kind] || 0x6ab0ff;
      this._setGlowColor(idx, glowColor);
      this._setCoreColor(idx, coreColor);
      this.nodeGlowColors[idx] = glowColor;
      this.nodeCoreColors[idx] = coreColor;
    }

    // 3. Added nodes → extend buffers + append
    if (diff.added_nodes.length > 0) {
      const needed = this._nodeCount + diff.added_nodes.length;
      if (needed > this._nodeCapacity) {
        this._rebuildNodeBuffers(Math.ceil(needed * 1.2));
      }
      this._appendNodes(diff.added_nodes, fullGraph, nodeIdxMap);
      // Track new indices
      for (const n of diff.added_nodes) {
        const idx = nodeIdxMap.get(n.id);
        if (idx !== undefined) newIndices.add(idx);
      }
    }

    // 4. Rebuild edges if any changed — rebuilds edgeDataList, neighborMap, edgeIndexOf
    if (diff.added_edges.length > 0 || diff.removed_edges.length > 0) {
      this._rebuildEdgeData(fullGraph, nodeIdxMap);
    }

    // 5. Collect neighbor indices for local layout relaxation
    for (const ni of newIndices) {
      for (const nb of this.neighborMap[ni] || []) {
        if (!newIndices.has(nb)) neighborIndices.add(nb);
      }
    }

    // 6. Local force relaxation — new nodes + their neighbors,
    //    treating neighbors as anchored (only new nodes move freely)
    if (newIndices.size > 0) {
      const affected = new Set([...newIndices, ...neighborIndices]);
      // Build edge pairs from edgeDataList
      const allPairs: [number, number][] = this.edgeDataList.map((e) => [e.s, e.t]);
      try {
        await relaxNewNodes(
          this.nodePositions,
          this._nodeCount,
          allPairs,
          affected,
          neighborIndices, // anchors: existing neighbors stay fixed
        );
      } catch (e) {
        console.warn('[StarGraph] local relax failed, positions may be suboptimal:', e);
      }
      // Sync updated positions to GPU buffers
      this._syncNodePositions([...affected]);
    }

    // 7. Sync GPU core positions for all modified nodes
    this._syncNodeCoreMatrices();

    // 8. Update communities from full graph
    this.communities = ((fullGraph as any).hierarchical_communities ||
      (fullGraph as any).communities ||
      []) as CommunityData[];

    // 9. Clear stale interaction state pointing to dead nodes
    if (this.hoveredIdx >= 0 && this._deadIndices.has(this.hoveredIdx)) {
      this.hoveredIdx = -1;
      this.targetHoverScale = 0;
    }
    if (this._tooltip.selectedIdx >= 0 && this._deadIndices.has(this._tooltip.selectedIdx))
      this._tooltip.selectedIdx = -1;
    if (this._analysis.blastSource >= 0 && this._deadIndices.has(this._analysis.blastSource)) {
      this._analysis.blastMode = false;
      this._analysis.blastSource = -1;
      this._analysis.blastDistances = [];
    }
    if (this.focusNodeIdx >= 0 && this._deadIndices.has(this.focusNodeIdx)) {
      this.focusActive = false;
      this.focusNodeIdx = -1;
    }
    if (this._analysis._pathSource >= 0 && this._deadIndices.has(this._analysis._pathSource)) {
      this._analysis._pathSource = -1;
      this._analysis._pathNodes.clear();
      this._analysis._pathEdges.clear();
    }
    if (this._analysis._pathTarget >= 0 && this._deadIndices.has(this._analysis._pathTarget)) {
      this._analysis._pathTarget = -1;
      this._analysis._pathNodes.clear();
      this._analysis._pathEdges.clear();
    }

    // 10. Re-apply diff overlay if active (new nodes might be in the diff set)
    if (this.diffActive && this.diffAddedIds.size + this.diffRemovedIds.size + this.diffModifiedIds.size > 0) {
      const saved = {
        added_nodes: [...this.diffAddedIds].map((id) => ({ id })),
        removed_nodes: [...this.diffRemovedIds].map((id) => ({ id })),
        modified_nodes: [...this.diffModifiedIds].map((id) => ({ node_id: id })),
      };
      this.clearDiff();
      this.showDiff(saved);
    }

    // 11. Update status
    const aliveCount = this._nodeCount - this._deadIndices.size;
    this.updateStatus(aliveCount, this.edgeDataList.length);

    this._flushOverrideAttrs();
  }

  /**
   * Sync node positions from nodePositions to GPU buffers (glow Points).
   * Called after local layout relaxation updates positions.
   */
  private _syncNodePositions(indices: number[]): void {
    const _m = new THREE.Matrix4();
    const _v = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const gAttr = this.nodeGlowsPoints?.geometry.attributes;
    const g2Attr = this.nodeGlows2Points?.geometry.attributes;
    for (const i of indices) {
      if (i >= this._nodeCount) continue;
      const px = this.nodePositions[i * 3],
        py = this.nodePositions[i * 3 + 1],
        pz = this.nodePositions[i * 3 + 2];
      // Core matrix
      const s = this._coreScales[i] || 0.28;
      this.nodeCoresInstanced.setMatrixAt(i, _m.compose(_v.set(px, py, pz), _q, new THREE.Vector3(s, s, s)));
      // Glow point positions
      if (gAttr) {
        (gAttr['position'].array as Float32Array)[i * 3] = px;
        (gAttr['position'].array as Float32Array)[i * 3 + 1] = py;
        (gAttr['position'].array as Float32Array)[i * 3 + 2] = pz;
      }
      if (g2Attr) {
        (g2Attr['position'].array as Float32Array)[i * 3] = px;
        (g2Attr['position'].array as Float32Array)[i * 3 + 1] = py;
        (g2Attr['position'].array as Float32Array)[i * 3 + 2] = pz;
      }
    }
    this.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
    if (gAttr) gAttr['position'].needsUpdate = true;
    if (g2Attr) g2Attr['position'].needsUpdate = true;
  }

  /** Sync all core matrices — call after incremental update to flush positions. */
  private _syncNodeCoreMatrices(): void {
    const _m = new THREE.Matrix4();
    const _v = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    for (let i = 0; i < this._nodeCount; i++) {
      if (this._deadIndices.has(i)) continue;
      const s = this._coreScales[i] || 0.28;
      this.nodeCoresInstanced.setMatrixAt(
        i,
        _m.compose(
          _v.set(this.nodePositions[i * 3], this.nodePositions[i * 3 + 1], this.nodePositions[i * 3 + 2]),
          _q,
          new THREE.Vector3(s, s, s),
        ),
      );
    }
    this.nodeCoresInstanced.count = this._nodeCount;
    this.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
    this.nodeCoresInstanced.boundingSphere = null;
  }

  // ══════════════════════════════════════════════════════════
  // Fold overlay — two layers
  //   Layer 1 (universe): galaxy clouds at centroids, unique hues, nodes hidden
  //   Layer 2 (inside):   single constellation — member nodes + internal edges lit
  // ══════════════════════════════════════════════════════════

  /** Enter a galaxy: hide clouds, reveal its constellation. */

  /** Render sub-community clouds — clickable "mini galaxies" inside a parent galaxy. */
  private _gaussRand(): number {
    let u = 0,
      v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.min(3, Math.max(-3, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v))) / 3;
  }

  private updateFocus(): void {
    if (!this.focusActive) return;
    const t = easeInOutCubic(Math.min(1, (performance.now() - this._focusStartTime) / this._focusDurationMs));
    if (this._resettingCamera) {
      this.camera.position.lerpVectors(this.focusStartCam, this.focusTarget, t);
      this.controls.target.lerpVectors(this.focusStartLook, this._initCamTarget, t);
    } else if (this._fold.enteredGalaxyId !== null) {
      this.camera.position.lerpVectors(this.focusStartCam, this.focusTarget, t);
      this.controls.target.lerpVectors(this.focusStartLook, this._fold._constellationLookTarget, t);
    } else {
      // ponytail: focusTarget=相机终点(已含视线方向偏移), _focusLookTarget=看向的点
      this.camera.position.lerpVectors(this.focusStartCam, this.focusTarget, t);
      this.controls.target.lerpVectors(this.focusStartLook, this._focusLookTarget, t);
    }
    if (this.focusNodeIdx >= 0 && this.focusNodeIdx < this._nodeCount) {
      if (this.focusFlash === 1) {
        this._savedFocusGlowScale = 1.0 /* was glow scale */;
        this._savedFocusCoreScale = this._coreScales[this.focusNodeIdx];
      }
      const base = this.getNodeBaseScale(this.focusNodeIdx);
      const flashScale = 1 + Math.sin(t * Math.PI * 2) * 0.5 * this.focusFlash;

      this._setGlowAlpha(this.focusNodeIdx, 0.55 + 0.45 * this.focusFlash);
      this._setCoreScale(this.focusNodeIdx, base * flashScale);
      this.focusFlash *= 0.97;
    }
    if (t >= 1) {
      this.focusActive = false;
      this._resettingCamera = false;
      if (this._fold.enteredGalaxyId === null && !this._resettingCamera && this.focusNodeIdx >= 0) {
        setTimeout(() => this.restoreFocusNode(), 800);
      }
    }
  }

  private _savedFocusGlowScale = 0;
  private _savedFocusCoreScale = 0;

  private restoreFocusNode(): void {
    if (this.focusNodeIdx < 0 || this.focusNodeIdx >= this._nodeCount) return;

    this._setGlowAlpha(this.focusNodeIdx, 0.55);
    this._setCoreScale(this.focusNodeIdx, this._savedFocusCoreScale || 1);
    this._savedFocusGlowScale = 0;
    this._savedFocusCoreScale = 0;
    this.focusNodeIdx = -1;
  }

  // ── Render ───────────────────────────────────────────────

  async render(graph: GraphJSON): Promise<void> {
    try {
      await this._renderImpl(graph);
      bus.emit('graph:rendered');
    } catch (e) {
      console.error('[StarGraph] render crashed:', e);
      this._renderInProgress = false;
      try {
        this.clearGraph();
      } catch {
        /* best effort */
      }
      this.updateStatus(0, 0);
    }
  }

  private async _renderImpl(graph: GraphJSON): Promise<void> {
    // Cancel any in-flight layout from a previous render
    if (this._layoutAbort) {
      this._layoutAbort.abort();
    }
    this._layoutAbort = new AbortController();
    // Block animation loop during scene rebuild — prevents access to
    // disposed GPU resources which causes ghost artifacts and cold-start
    // blank screens on slower machines.
    this._renderInProgress = true;
    this.clearGraph();
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : Object.values(graph.nodes);
    const edges = Array.isArray(graph.edges) ? graph.edges : Object.values(graph.edges);
    if (nodes.length === 0) {
      this.updateStatus(0, 0);
      this._renderInProgress = false;
      return;
    }
    this.graphNodes = nodes;

    const nodeIdx = new Map<string, number>();
    const pairs: [number, number][] = [];
    const eData: EdgeData[] = [];
    const deg = new Array<number>(nodes.length).fill(0);
    for (let i = 0; i < nodes.length; i++) nodeIdx.set(nodes[i].id, i);
    // Extract file path from node location (e.g. "src/foo.py:10" → "src/foo.py")
    const nodeFile = new Map<number, string>();
    for (let i = 0; i < nodes.length; i++) {
      const loc = nodes[i].location || '';
      // Strip line number suffix (e.g. ":10")
      const filePath = loc.replace(/:\d+$/, '');
      nodeFile.set(i, filePath);
    }
    for (const e of edges) {
      const s = nodeIdx.get(e.source),
        t = nodeIdx.get(e.target);
      if (s !== undefined && t !== undefined && s !== t) {
        pairs.push([s, t]);
        deg[s]++;
        deg[t]++;
        const crossFile = nodeFile.get(s) !== nodeFile.get(t);
        eData.push({
          s,
          t,
          couplingDepth: ((e as any).coupling_depth as number) || 0,
          edgeType: e.type || '',
          direction: (e as any).direction || '',
          crossFile,
        });
      }
    }
    // Debug: count cross-file edges
    const crossFileCount = eData.filter((e) => e.crossFile).length;
    console.log(`[DEBUG] Total edges: ${eData.length}, cross-file edges: ${crossFileCount}`);
    this.deg = deg;
    this.edgeDataList = eData;
    this.maxDeg = Math.max(...deg, 1);

    this.neighborMap = Array.from({ length: nodes.length }, () => []);
    this.edgeIndexOf = Array.from({ length: nodes.length }, () => []);
    for (let ei = 0; ei < eData.length; ei++) {
      const { s, t } = eData[ei];
      this.neighborMap[s].push(t);
      this.neighborMap[t].push(s);
      this.edgeIndexOf[s].push(ei);
      this.edgeIndexOf[t].push(ei);
    }

    // ── Parse communities & build node→community index ──────
    // Prefer hierarchical (multi-level) over flat communities
    this.communities = ((graph as any).hierarchical_communities || (graph as any).communities || []) as CommunityData[];
    this.nodeCommMap.clear();
    // Debug: log community data
    const level0Comms = this.communities.filter((c) => !c.level || c.level === 0);
    const level1Comms = this.communities.filter((c) => c.level === 1);
    console.log(
      `[DEBUG] Total communities: ${this.communities.length}, Level 0: ${level0Comms.length}, Level 1: ${level1Comms.length}`,
    );
    if (level1Comms.length > 0) {
      console.log(
        `[DEBUG] Level 1 communities:`,
        level1Comms.map((c) => ({ id: c.id, parent_id: c.parent_id, node_count: c.node_ids.length })),
      );
    }

    // ponytail: layout + galaxyMeta 都用 level0 — 质心/ring/cloud/折叠视图统一层级,
    // 否则 level1 子盘被 spiralGalaxies+repelCommunityCentroids 推开后, level0 质心
    // 落在子盘空隙里 → 视觉上"飞出社区". level1 子结构在 fold view 进入 galaxy 后
    // 由 _showConstellation 的子社区高亮体现.
    const layoutComms = level0Comms;
    for (const comm of layoutComms) {
      for (const nid of comm.node_ids) {
        const idx = nodeIdx.get(nid);
        if (idx !== undefined) this.nodeCommMap.set(idx, comm.id);
      }
    }
    // Galaxy fold mode always uses Level 0 for top-level navigation
    const level0Communities = level0Comms;
    // Pre-compute galaxy members (centroids filled after layout)
    // Only keep communities above minimum size — single-node communities are noise
    this._fold.galaxyMeta = [];
    let skippedSingletons = 0;
    for (const comm of level0Communities) {
      const members: number[] = [];
      for (const nid of comm.node_ids) {
        const idx = nodeIdx.get(nid);
        if (idx !== undefined) members.push(idx);
      }
      if (members.length >= GraphFold.MIN_GALAXY_SIZE) {
        this._fold.galaxyMeta.push({
          id: comm.id,
          label: comm.label,
          centroid: new THREE.Vector3(),
          memberIndices: members,
          radius: 0,
        });
      } else if (members.length > 0 && members.length < GraphFold.MIN_GALAXY_SIZE) {
        skippedSingletons += members.length;
      }
    }
    // Sort galaxies by size descending so largest render first (OCD-friendly)
    this._fold.galaxyMeta.sort((a, b) => b.memberIndices.length - a.memberIndices.length);

    this.l34Count = new Array(nodes.length).fill(0);
    for (const e of eData) {
      if (e.couplingDepth >= 3) {
        this.l34Count[e.s]++;
        this.l34Count[e.t]++;
      }
    }

    // ── Force-directed layout: GPU compute (WebGPU) → CPU fallback ──
    const shellRadius = Math.cbrt(nodes.length) * 14;
    const sp = 0.006 + (nodes.length > 2000 ? 0.008 : 0) + (nodes.length > 4000 ? 0.006 : 0);
    const maxIter = Math.min(60, Math.max(15, 60 - Math.floor(nodes.length / 800)));
    let layoutSource = 'CPU';

    // Build numeric community index array for layout (0..C-1, -1 = unassigned)
    const commStrIds = [...new Set(this.nodeCommMap.values())];
    const commStrToIdx = new Map<string, number>();
    commStrIds.forEach((sid, i) => commStrToIdx.set(sid, i));
    const nodeCommArr = new Array<number>(nodes.length).fill(-1);
    for (const [nodeIdx, commStr] of this.nodeCommMap) {
      nodeCommArr[nodeIdx] = commStrToIdx.get(commStr) ?? -1;
    }

    // Fallback: if Louvain gave us ≤1 community, group by top-level directory
    if (commStrIds.length <= 1) {
      console.warn(
        `[StarGraph] Louvain only found ${commStrIds.length} communities — falling back to directory-based grouping`,
      );
      const dirGroups = new Map<string, number[]>();
      for (let i = 0; i < nodes.length; i++) {
        const loc = nodes[i].location || '';
        // Extract top-level dir: "src/foo/bar.py" → "src", "engine/src/main.rs" → "engine"
        const topDir = loc.replace(/^[/\\]+/, '').split(/[/\\]/)[0] || '(root)';
        if (!dirGroups.has(topDir)) dirGroups.set(topDir, []);
        dirGroups.get(topDir)!.push(i);
      }
      console.warn(`[StarGraph] Directory-based groups: ${dirGroups.size} groups`, [...dirGroups.keys()]);
      // Only use if we get more groups than Louvain
      if (dirGroups.size > 1) {
        let nextId = 0;
        for (const [dir, members] of dirGroups) {
          for (const mi of members) nodeCommArr[mi] = nextId;
          nextId++;
        }
        layoutSource = 'CPU(dirs)';
        console.warn(`[StarGraph] Using ${dirGroups.size} directory-based communities for layout`);
      } else {
        console.warn(
          `[StarGraph] Even directory grouping only found ${dirGroups.size} group — falling back to uniform`,
        );
      }
    } else {
      console.warn(`[StarGraph] Using ${commStrIds.length} Louvain communities for layout`);
      layoutSource = 'CPU(community)';
    }

    let rawPos: Float32Array;
    const effGroups = new Set(nodeCommArr.filter((c) => c >= 0));
    // GPU path: N-body for macro structure, spiral for micro
    if (gpuLayout.ready) {
      // ── GPU N-body: macro structure from edge forces, spiral for micro ──
      const initPos = fibonacciSphere(nodes.length, shellRadius);
      const gpuResult = await gpuLayout.compute(
        nodes.length,
        pairs,
        initPos,
        {
          n: nodes.length,
          rep: 600,
          att: 0.018,
          damp: 0.72,
          REP_CAP: shellRadius * 8,
          ATT_CAP: shellRadius,
          VEL_CAP: shellRadius * 0.25,
          shellRadius,
          sp,
          originStr: 0.0004,
        },
        maxIter,
      );
      if (gpuResult) {
        rawPos = gpuResult;
        layoutSource = 'GPU';
        if (effGroups.size > 1) {
          spiralGalaxies(rawPos, nodes.length, nodeCommArr, deg, shellRadius);
          layoutSource = 'GPU+spiral';
        }
      } else {
        rawPos = await layout3D(nodes.length, pairs, this._layoutAbort?.signal, nodeCommArr);
        layoutSource = 'CPU(fallback)';
      }
    } else {
      rawPos = await layout3D(nodes.length, pairs, this._layoutAbort?.signal, nodeCommArr);
    }
    // ponytail: 社区质心斥力后处理 — 推开重叠社区, 不碰内部布局
    if (effGroups.size > 1) {
      repelCommunityCentroids(rawPos, nodes.length, nodeCommArr, shellRadius, pairs);
    }
    // ── Safety: replace NaN, safe centroid + camera ──
    let fixed = 0;
    for (let i = 0; i < rawPos.length; i++) {
      if (!isFinite(rawPos[i])) {
        rawPos[i] = 0;
        fixed++;
      }
    }
    if (fixed > 0) console.warn(`[StarGraph] Fixed ${fixed} NaN position components`);
    // ── Bounding-box centering (immune to cluster-size bias) ──
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const x = rawPos[i * 3],
        y = rawPos[i * 3 + 1],
        z = rawPos[i * 3 + 2];
      if (isFinite(x) && isFinite(y) && isFinite(z)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    const bbcx = (minX + maxX) / 2,
      bbcy = (minY + maxY) / 2,
      bbcz = (minZ + maxZ) / 2;
    for (let i = 0; i < nodes.length; i++) {
      rawPos[i * 3] -= bbcx;
      rawPos[i * 3 + 1] -= bbcy;
      rawPos[i * 3 + 2] -= bbcz;
    }
    this.nodePositions = rawPos;

    // ── Radius = p95 distance from bounding-box center ──
    const dists: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const r2 = rawPos[i * 3] ** 2 + rawPos[i * 3 + 1] ** 2 + rawPos[i * 3 + 2] ** 2;
      if (isFinite(r2)) dists.push(Math.sqrt(r2));
    }
    dists.sort((a, b) => a - b);
    const radius = dists[Math.floor(dists.length * 0.95)] || 50;
    const absMax = dists[dists.length - 1] || 50;
    this._graphRadius = radius; // graph spatial scale — used for camera zoom range only

    // FOV-based camera distance — fills frame regardless of project size
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
    const camDist = ((radius / Math.tan(fovRad / 2)) * 0.4) / Math.min(1, aspect);

    const shellR = Math.cbrt(nodes.length) * 14;
    const isoCount = deg.filter((d) => d === 0).length;
    this._diagMsg = `${layoutSource} shellR≈${shellR | 0} radius=${radius | 0} absMax=${absMax | 0} cam=${camDist | 0} iso=${isoCount}/${nodes.length} NaNfix=${fixed}`;

    // ── Camera zoom range — wide open, no LOD clamping ──
    this.controls.minDistance = Math.max(0.5, radius * 0.001);
    this.controls.maxDistance = Math.max(this.controls.maxDistance, camDist * 6);
    // Clip planes: match the actual zoom range so nothing gets hardware-culled
    this.camera.near = Math.max(0.05, this.controls.minDistance * 0.5);
    this.camera.far = this.controls.maxDistance * 2;

    // Flatter camera angle — less top-down, more natural
    const dir = new THREE.Vector3(0.3, 0.25, 1).normalize();
    this.camera.position.set(dir.x * camDist, dir.y * camDist, dir.z * camDist);
    this.controls.target.set(0, 0, 0);
    this._initCamPos.copy(this.camera.position);
    this._initCamTarget.set(0, 0, 0);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.controls.update();

    // (standard mode: no bloom — bloom is full-mode only)

    // ── Create batched GPU objects (1 InstancedMesh + 2 Points = 3 draw calls) ──
    this._nodeCount = nodes.length;
    this._nodeCapacity = nodes.length;
    this._deadIndices.clear();
    this._coreScales = new Float32Array(nodes.length);
    this._glowRgba = new Float32Array(nodes.length * 4);
    this._glow2Rgba = true ? new Float32Array(nodes.length * 4) : new Float32Array(0);

    this.nodeCoresInstanced = new THREE.InstancedMesh(this.sphereGeo, this._makeCoreFresnelMaterial(), nodes.length);
    this.nodeCoresInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.nodeCoresInstanced.count = 0;
    // ponytail: 10K+ instances spread across large volume → bounding sphere covers
    // the entire graph; frustum culling at the object level is harmful (entire mesh
    // disappears when camera zooms into a region far from the bounding sphere center).
    this.nodeCoresInstanced.frustumCulled = false;
    this.nodeGroup.add(this.nodeCoresInstanced);

    // ── Build scene geometry ──
    this.buildEdges(rawPos, eData);
    this.buildNodes(nodes, rawPos, deg);
    this.buildLabels(nodes, deg);
    this.positionGrid(rawPos);

    // Edge particle flow — full mode dense, standard mode subtle, minimal none
    if (true) {
      this.initEdgeParticles(rawPos, eData);
    }
    if (true) {
      this.initTwinkleData(nodes.length);
    }

    // ── Progressive reveal: nodes materialize in batches from center outward ──
    this._startProgressiveReveal(nodes.length);

    // ── Compute galaxy centroids + radii from layout ──────────
    for (const gm of this._fold.galaxyMeta) {
      let sx = 0,
        sy = 0,
        sz = 0;
      for (const mi of gm.memberIndices) {
        sx += rawPos[mi * 3];
        sy += rawPos[mi * 3 + 1];
        sz += rawPos[mi * 3 + 2];
      }
      const cx = sx / gm.memberIndices.length,
        cy = sy / gm.memberIndices.length,
        cz = sz / gm.memberIndices.length;
      gm.centroid.set(cx, cy, cz);
      // p90 radius
      const dists: number[] = [];
      for (const mi of gm.memberIndices) {
        const dx = rawPos[mi * 3] - cx,
          dy = rawPos[mi * 3 + 1] - cy,
          dz = rawPos[mi * 3 + 2] - cz;
        dists.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
      dists.sort((a, b) => a - b);
      gm.radius = dists[Math.floor(dists.length * 0.9)] || 30;
    }
    this._fold._buildCommunityRings();

    // ── Apply fold overlay if active ─────────────────────────
    if (this._fold.foldMode) this._fold.applyFoldOverlay();

    this.updateStatus(nodes.length, edges.length, graph.meta);
    if (this.legendEl) this.legendEl.style.display = '';
    // Append layout diagnostics so user can report them (release build has no DevTools)
    if (this._diagMsg) {
      const st = document.getElementById('status-text');
      if (st) st.textContent = (st.textContent || '') + ' | ' + this._diagMsg;
    }
    // Fix: container may have been display:none during constructor onResize().
    // Defer resize one frame to ensure CSS layout has settled.
    requestAnimationFrame(() => this.onResize());
    // ponytail: _renderInProgress stays TRUE until progressive reveal completes.
    // Animation loop skips rendering while InstancedMesh.count is still ramping up,
    // otherwise glow Points render at full count while cores are partially hidden
    // → ghost dots (reported as "鬼影").
    // The flag is cleared by _startProgressiveReveal's completion callback.
  }

  // -- end of _renderImpl; render() wrapper is above --

  // ── Progressive reveal: materialize nodes in batches ────────
  private _revealRevealed = true; // false during animation
  private _revealCancelled = false;
  private _revealGeneration = 0; // ponytail: increment on each new reveal; old rAF callbacks discard themselves

  private _startProgressiveReveal(nodeCount: number): void {
    this._revealCancelled = false;
    const myGen = ++this._revealGeneration; // ponytail: bump generation so old rAF callbacks from previous renders bail out
    const BATCH_SIZE = Math.max(50, Math.floor(nodeCount / 40));
    const totalNodes = this._nodeCount;
    const totalEdgeGroups = this.edgeLineGroups.length;

    // Hide all batched objects
    this.nodeCoresInstanced.count = 0;
    this.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
    // ponytail: set override flags so shader passes through CPU alpha during reveal
    this._overrideFlags.fill(1);
    this._flushOverrideAttrs();
    // Zero all glow alpha — override=1 means shader uses these values directly
    this._glowRgba.fill(0);
    this.nodeGlowsPoints.geometry.attributes['color'].needsUpdate = true;
    if (this._glow2Rgba.length > 0) {
      this._glow2Rgba.fill(0);
      this.nodeGlows2Points.geometry.attributes['color'].needsUpdate = true;
    }
    // Save & clear edge opacities
    const edgeTargetOpacities: number[] = [];
    for (const lines of this.edgeLineGroups) {
      const mat = lines.material as LineMaterial;
      edgeTargetOpacities.push(mat.opacity);
      mat.opacity = 0;
    }
    this.labelsContainer.style.opacity = '0';

    this._revealRevealed = false;
    let revealedNodes = 0;
    let revealedEdges = 0;
    const edgeRevealBatch = Math.max(1, Math.ceil(totalEdgeGroups / 10));

    const revealFrame = () => {
      // ponytail: bail out if a newer render has started — prevents old rAF
      // callbacks from touching the new scene objects (ghost dots root cause).
      // Don't touch _renderInProgress here — the new render owns the flag.
      if (this._revealGeneration !== myGen) return;
      if (this._revealCancelled) {
        this._renderInProgress = false;
        return;
      }
      const nodeEnd = Math.min(revealedNodes + BATCH_SIZE, totalNodes);
      // Reveal cores via InstancedMesh.count
      this.nodeCoresInstanced.count = nodeEnd;
      this.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
      // Restore glow alpha for revealed batch
      const gCol = this.nodeGlowsPoints.geometry.attributes['color'].array as Float32Array;
      const g2Col = this.nodeGlows2Points?.geometry.attributes['color']?.array as Float32Array;
      for (let i = revealedNodes; i < nodeEnd; i++) {
        gCol[i * 4 + 3] = 0.75;
        if (g2Col) g2Col[i * 4 + 3] = 0.48;
      }
      this.nodeGlowsPoints.geometry.attributes['color'].needsUpdate = true;
      if (this.nodeGlows2Points) this.nodeGlows2Points.geometry.attributes['color'].needsUpdate = true;
      revealedNodes = nodeEnd;

      const edgeEnd = Math.min(revealedEdges + edgeRevealBatch, totalEdgeGroups);
      for (let i = revealedEdges; i < edgeEnd; i++) {
        const lines = this.edgeLineGroups[i];
        if (lines) (lines.material as LineMaterial).opacity = edgeTargetOpacities[i];
      }
      revealedEdges = edgeEnd;

      if (revealedNodes >= totalNodes && revealedEdges >= totalEdgeGroups) {
        this._revealRevealed = true;
        // ponytail: clear override flags — shader resumes animation now that reveal is done
        this._overrideFlags.fill(0);
        this._flushOverrideAttrs();
        // ponytail: force bounding-sphere recompute now that count==totalNodes.
        this.nodeCoresInstanced.boundingSphere = null;
        this.labelsContainer.style.transition = 'opacity 0.4s ease-in';
        this.labelsContainer.style.opacity = '1';
        setTimeout(() => {
          this.labelsContainer.style.transition = '';
        }, 500);
        // ponytail: unblock animation loop now that progressive reveal is done.
        // _renderInProgress was kept true since _renderImpl to prevent the
        // animation loop from rendering partial state (ghost dots).
        this._renderInProgress = false;
        return;
      }
      requestAnimationFrame(revealFrame);
    };
    requestAnimationFrame(revealFrame);
  }

  private clearGraph(): void {
    this._revealCancelled = true; // cancel any in-flight progressive reveal
    ++this._revealGeneration; // ponytail: bump generation so old rAF callbacks bail silently
    // ── Explicit cleanup: each object type knows what to dispose.
    //     DO NOT use a blind disposeGroup walk — nodeCoresInstanced shares
    //     this.sphereGeo (created in constructor, reused across re-renders).
    //     disposeGroup would destroy sphereGeo's WebGL buffers, causing
    //     subsequent InstancedMesh renders to come out blank (cold-start + watcher race).

    // Node cores: dispose material only — sphereGeo is shared, built once in constructor.
    if (this.nodeCoresInstanced) {
      (this.nodeCoresInstanced.material as THREE.Material)?.dispose();
      this.nodeGroup.remove(this.nodeCoresInstanced);
    }
    // Glow Points: dispose geometry + material (rebuilt fresh each render).
    if (this.nodeGlowsPoints) {
      (this.nodeGlowsPoints.material as THREE.Material)?.dispose();
      this.nodeGlowsPoints.geometry?.dispose();
      this.nodeGroup.remove(this.nodeGlowsPoints);
    }
    if (this.nodeGlows2Points) {
      (this.nodeGlows2Points.material as THREE.Material)?.dispose();
      this.nodeGlows2Points.geometry?.dispose();
      this.nodeGroup.remove(this.nodeGlows2Points);
    }
    // Any remaining stray children in nodeGroup (shouldn't be any, but paranoia).
    while (this.nodeGroup.children.length) {
      this.nodeGroup.remove(this.nodeGroup.children[0]);
    }

    // Edge groups — dispose materials + geometries, clear children.
    for (const lines of this.edgeLineGroups) {
      lines.geometry?.dispose();
      (lines.material as THREE.Material)?.dispose();
    }
    while (this.edgeGroup.children.length) this.edgeGroup.remove(this.edgeGroup.children[0]);
    while (this.highlightEdgeGroup.children.length) this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);
    while (this._fold.commFoldGroup.children.length)
      this._fold.commFoldGroup.remove(this._fold.commFoldGroup.children[0]);

    // Legacy: edgeLineGroups array may hold references already disposed above — clear.
    this.edgeLineGroups = [];
    this.labelsContainer.innerHTML = '';
    this.labelDivs = [];
    this.nodeLabelIdx = [];
    this.nodeGlowColors = [];
    this.nodeCoreColors = [];
    this._nodeBaseHSL = [];
    this._fold.galaxyClouds = [];
    this._fold.galaxyGlows = [];
    this._fold.galaxyMeta = [];
    this._fold.communityRingGroup.clear();
    this._fold._communityGlowSprites = [];
    this._fold._hoveredCommunityIdx = -1;
    this._fold.foldMode = false;
    this._fold.enteredGalaxyId = null;
    this._fold.enteredSubCommunityId = null;
    this._fold._drillStack = [];
    this._fold._subCommByNodeIdx.clear();
    this._fold._savedGalaxyMeta = null;
    this._fold.hideGalaxyTitle();
    this._analysis._pathSource = -1;
    this._analysis._pathTarget = -1;
    this._analysis._pathNodes.clear();
    this._analysis._pathEdges.clear();
    this._analysis._shiftSourceIdx = -1;
    this._tooltip._selecting = false;
    this._tooltip._hidePrompt();
    for (const d of this._fold.galaxyLabelDivs) d.remove();
    this._fold.galaxyLabelDivs = [];
    this.neighborMap = [];
    this.edgeIndexOf = [];
    this._deadIndices.clear();
    this.hoveredIdx = -1;
    this.targetHoverScale = 0;
    this.focusActive = false;
    this.focusNodeIdx = -1;
    this._tooltip.selectedIdx = -1;
    this._edgeTypeFilter = null;
    this._nodeKindFilter = null;
    this._analysis.blastMode = false;
    this._analysis.blastSource = -1;
    this._analysis.blastDistances = [];
    this.l34Count = [];
    this._diagMsg = '';
    if (this.legendEl) this.legendEl.style.display = 'none';
    this.focusSubgraphActive = false;
    this.focusSubgraphIdx = -1;
    this.focusSubgraphVisibleIndices.clear();
    if (this.focusSubgraphBanner) this.focusSubgraphBanner.style.display = 'none';
    this._tooltip.tooltipEl?.classList.remove('visible');
    this._tooltip.detailCard?.classList.remove('visible');
    // Step 2: Clear lens & trail state
    this._lensActive = false;
    this._trailActive = false;
    this._clearTrailLine();
  }

  // ── Edges ────────────────────────────────────────────────

  private buildEdges(pos: Float32Array, data: EdgeData[]): void {
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
    const resolution = new THREE.Vector2(this.container.clientWidth, this.container.clientHeight);
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
        baseLines.userData['edgeDepth'] = g.depth;
        baseLines.userData['edgeType'] = g.edgeType;
        baseLines.computeLineDistances();
        this.edgeGroup.add(baseLines);
        this.edgeLineGroups.push(baseLines);
      }
    }
  }

  // ── Nodes ────────────────────────────────────────────────

  private buildNodes(nodes: GraphNode[], pos: Float32Array, deg: number[]): void {
    const N = nodes.length;
    const isFull = true;

    // Glow Points geometry buffers (RGBA color + per-point size)
    const glowPosArr = new Float32Array(N * 3);
    const glow2PosArr = isFull ? new Float32Array(N * 3) : new Float32Array(0);
    this._glowSizes = new Float32Array(N);
    this._glow2Sizes = isFull ? new Float32Array(N) : new Float32Array(0);

    // ponytail: GPU-driven shader attributes — static, uploaded once
    const phaseArr = new Float32Array(N);
    const speedArr = new Float32Array(N);
    const magArr = new Float32Array(N);
    const riskArr = new Float32Array(N);
    const hslArr = new Float32Array(N * 3);
    this._overrideFlags = new Float32Array(N); // 0=shader animated, 1=CPU overridden
    // init twinkle data inline (ponytail: avoid separate initTwinkleData call)
    for (let i = 0; i < N; i++) {
      phaseArr[i] = Math.random() * Math.PI * 2;
      speedArr[i] = 0.5 + Math.random() * 2.5;
    }

    const _m = new THREE.Matrix4();
    const _v = new THREE.Vector3();
    const _q = new THREE.Quaternion();

    for (let i = 0; i < N; i++) {
      const kind = ((nodes[i].type || nodes[i].kind || 'symbol') as string).toLowerCase();
      const glowColor = GLOW_COLORS[kind] || 0x4488cc;
      const coreColor = NODE_COLORS[kind] || 0x6ab0ff;
      const baseScale = 0.8 + (deg[i] / this.maxDeg) * 2.8;
      const px = pos[i * 3],
        py = pos[i * 3 + 1],
        pz = pos[i * 3 + 2];

      // Core InstancedMesh: position + scale in matrix, color in instanceColor
      this._coreScales[i] = baseScale * 0.35;
      this.nodeCoresInstanced.setMatrixAt(
        i,
        _m.compose(_v.set(px, py, pz), _q, new THREE.Vector3(1, 1, 1).multiplyScalar(this._coreScales[i])),
      );
      this._setCoreColor(i, coreColor);
      this.nodeCoreColors[i] = coreColor;

      // Inner glow RGBA
      const gc = new THREE.Color(glowColor);
      glowPosArr[i * 3] = px;
      glowPosArr[i * 3 + 1] = py;
      glowPosArr[i * 3 + 2] = pz;
      this._glowRgba[i * 4] = gc.r;
      this._glowRgba[i * 4 + 1] = gc.g;
      this._glowRgba[i * 4 + 2] = gc.b;
      this._glowRgba[i * 4 + 3] = 0.85;
      this.nodeGlowColors[i] = glowColor;

      // HSL cache for twinkle
      this._nodeBaseHSL[i] = { h: 0, s: 0, l: 0 };
      gc.getHSL(this._nodeBaseHSL[i]);
      // GPU shader attributes (static, uploaded once)
      hslArr[i * 3] = this._nodeBaseHSL[i].h;
      hslArr[i * 3 + 1] = this._nodeBaseHSL[i].s;
      hslArr[i * 3 + 2] = this._nodeBaseHSL[i].l;

      // Outer glow RGBA + size
      if (isFull) {
        glow2PosArr[i * 3] = px;
        glow2PosArr[i * 3 + 1] = py;
        glow2PosArr[i * 3 + 2] = pz;
        this._glow2Rgba[i * 4] = gc.r;
        this._glow2Rgba[i * 4 + 1] = gc.g;
        this._glow2Rgba[i * 4 + 2] = gc.b;
        this._glow2Rgba[i * 4 + 3] = 0.55;
        this._glow2Sizes[i] = 0.8 * baseScale; // outer glow scales with degree — matches core
      }
      this._glowSizes[i] = 1.0 * baseScale; // inner glow scales with degree — matches core
    }

    // Pre-compute _nodeMag cache (ponytail: log1p ratio is static, avoid per-frame recalc)
    this._nodeMagCache = new Float32Array(N);
    const logMax = Math.log1p(this.maxDeg);
    for (let i = 0; i < N; i++) {
      this._nodeMagCache[i] = 0.15 + 0.85 * (Math.log1p(this.deg[i]) / logMax);
      magArr[i] = this._nodeMagCache[i];
      riskArr[i] = this.l34Count[i] || 0;
    }

    // Upload + create Points objects
    this.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
    if (this.nodeCoresInstanced.instanceColor) this.nodeCoresInstanced.instanceColor.needsUpdate = true;

    // ── Shared shader attribute helper ──
    const addAnimAttrs = (geo: THREE.BufferGeometry) => {
      geo.setAttribute('phase', new THREE.BufferAttribute(phaseArr, 1));
      geo.setAttribute('speed', new THREE.BufferAttribute(speedArr, 1));
      geo.setAttribute('mag', new THREE.BufferAttribute(magArr, 1));
      geo.setAttribute('risk', new THREE.BufferAttribute(riskArr, 1));
      geo.setAttribute('baseHSL', new THREE.BufferAttribute(hslArr, 3));
      geo.setAttribute('override', new THREE.BufferAttribute(this._overrideFlags, 1));
    };

    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', new THREE.BufferAttribute(glowPosArr, 3));
    glowGeo.setAttribute('color', new THREE.BufferAttribute(this._glowRgba, 4));
    glowGeo.setAttribute('size', new THREE.BufferAttribute(this._glowSizes, 1));
    addAnimAttrs(glowGeo);
    this.nodeGlowsPoints = new THREE.Points(glowGeo, this._makeGlowPointMaterial(1.5, 1.0));
    this.nodeGlowsPoints.frustumCulled = false;
    this.nodeGlowsPoints.renderOrder = 1;
    this.nodeGroup.add(this.nodeGlowsPoints);

    if (isFull) {
      const g2Geo = new THREE.BufferGeometry();
      g2Geo.setAttribute('position', new THREE.BufferAttribute(glow2PosArr, 3));
      g2Geo.setAttribute('color', new THREE.BufferAttribute(this._glow2Rgba, 4));
      g2Geo.setAttribute('size', new THREE.BufferAttribute(this._glow2Sizes, 1));
      addAnimAttrs(g2Geo);
      this.nodeGlows2Points = new THREE.Points(g2Geo, this._makeGlowPointMaterial(0.55, 0.85));
      this.nodeGlows2Points.frustumCulled = false;
      this.nodeGlows2Points.renderOrder = 1;
      this.nodeGroup.add(this.nodeGlows2Points);
    }
  }

  // ponytail: GPU-driven glow — all twinkle/sine/hue-shift math runs in vertex shader.
  // CPU sets uTime/uPulseTime uniforms each frame; per-vertex animData + baseHSL
  // attributes are static.  Override flag skips shader animation for hover/blast/path.
  // ── HSL→RGB in GLSL ──
  private static _GLSL_HSL2RGB = /* glsl */ `
    vec3 hsl2rgb(float h, float s, float l) {
      vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
      return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
    }
  `;

  private _makeGlowPointMaterial(alphaMul: number, sizeMul: number): THREE.ShaderMaterial {
    const hsl2rgb = StarGraph._GLSL_HSL2RGB;
    return new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: this.glowTex },
        uTime: { value: 0 },
        uPulseTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 color;
        attribute float size;
        attribute float phase;
        attribute float speed;
        attribute float mag;
        attribute float risk;
        attribute vec3  baseHSL;
        attribute float override;
        varying vec4 vColor;
        uniform float uTime;
        uniform float uPulseTime;
        ${hsl2rgb}
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float pointScale = 28.0 * (300.0 / -mv.z);
          if (override > 0.5) {
            vColor = color;
            gl_PointSize = size * pointScale;
          } else {
            float twinkle = 1.0 + sin(uTime * speed + phase) * 0.10;
            float riskFreq = 1.0 + risk * 0.7;
            float waveAmp = risk > 0.0 ? min(0.18, risk * 0.06) : 0.03;
            float wave = 1.0 + sin(uPulseTime * riskFreq) * waveAmp;
            float combined = twinkle * wave;
            float alpha = min(1.0, ${alphaMul.toFixed(2)} * combined * mag);
            float hueShift = sin(uTime * 0.3 + phase) * 0.05;
            float newH = mod(baseHSL.x + hueShift + 1.0, 1.0);
            float newS = min(1.0, baseHSL.y * 1.2);
            float newL = min(1.0, baseHSL.z * 1.3);
            vec3 rgb = hsl2rgb(newH, newS, newL);
            vColor = vec4(rgb, alpha);
            gl_PointSize = size * combined * ${sizeMul.toFixed(2)} * pointScale;
          }
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex;
        varying vec4 vColor;
        void main() { gl_FragColor = vColor * texture2D(uTex, gl_PointCoord); }`,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
  }

  /** ponytail: restores Fresnel rim on InstancedMesh via onBeforeCompile injection.
   *  Uses sphere pos→normal trick (unit sphere: localNormal = normalize(position)),
   *  so we don't depend on a 'normal' attribute that MeshBasicMaterial may omit. */
  private _makeCoreFresnelMaterial(): THREE.MeshBasicMaterial {
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    mat.onBeforeCompile = (shader) => {
      // ── Vertex: varyings for world-normal, UV, world-pos ──
      shader.vertexShader = shader.vertexShader.replace(
        'void main()',
        `varying vec3 vFresnelWorldNormal;
         varying vec3 vFresnelWorldPos;
         varying vec2 vCoreUv;
         void main()`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `// Fresnel: sphere pos IS the local normal (unit sphere geometry)
         vec3 _fLocalN = normalize(position);
         vFresnelWorldNormal = normalize(mat3(instanceMatrix) * _fLocalN);
         vFresnelWorldPos = (instanceMatrix * vec4(position, 1.0)).xyz;
         vCoreUv = uv;
         #include <project_vertex>`,
      );

      // ── Fragment: center-glow (star-like) + crystalline surface detail ──
      shader.uniforms.uSpikeTex = { value: this.glowTex };
      shader.fragmentShader = shader.fragmentShader.replace(
        'void main()',
        `varying vec3 vFresnelWorldNormal;
         varying vec3 vFresnelWorldPos;
         varying vec2 vCoreUv;
         uniform sampler2D uSpikeTex;
         void main()`,
      );
      // ponytail: inverted Fresnel — luminous core, not plastic rim.
      // NdotV ≈ 1 at sphere center (normal faces camera), ≈ 0 at edge.
      // Center: white-hot 2.5x brighter; Edge: 0.45x dimmer → glowing orb illusion.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `vec3 _fViewDir = normalize(cameraPosition - vFresnelWorldPos);
         float _fNdotV = abs(dot(normalize(vFresnelWorldNormal), _fViewDir));
         float _fCore = pow(_fNdotV, 2.5);
         // Crystalline surface: subtle spike texture overlay for faceted sparkle
         float _fSpike = texture2D(uSpikeTex, vCoreUv * 2.5).r;
         outgoingLight = outgoingLight * (0.45 + _fCore * 2.1) * (1.0 + _fSpike * 0.12);
         #include <opaque_fragment>`,
      );
    };
    return mat;
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

  private buildFocusBanner(): void {
    this.focusSubgraphBanner = buildFocusBanner(this.container, () => this.exitFocusSubgraph());
  }

  private enterFocusSubgraph(idx: number): void {
    if (idx < 0 || idx >= this._nodeCount) return;
    if (this.focusSubgraphActive) this.exitFocusSubgraph();

    this.focusSubgraphIdx = idx;
    this.focusSubgraphVisibleIndices.clear();
    this.focusSubgraphVisibleIndices.add(idx);
    for (const ni of this.neighborMap[idx] || []) {
      this.focusSubgraphVisibleIndices.add(ni);
    }

    // Save current state
    this.focusSubgraphSavedGlowOpacities = [];
    this.focusSubgraphSavedCoreVisible = [];
    for (let i = 0; i < this._nodeCount; i++) {
      this.focusSubgraphSavedGlowOpacities.push(i < this._nodeCount ? this._glowRgba[i * 4 + 3] : 0.55);
      this.focusSubgraphSavedCoreVisible.push(i < this._nodeCount ? this._coreScales[i] > 0 : true);

      if (!this.focusSubgraphVisibleIndices.has(i)) {
        if (i < this._nodeCount) {
          this._overrideFlags[i] = 1;
          this._setGlowAlpha(i, 0.02);
        }
        this._setCoreVisible(i, false);
      } else {
        this._overrideFlags[i] = 1;
      }
    }

    // Dim edges
    this.focusSubgraphSavedEdgeOpacities = this.edgeLineGroups.map((lines) => (lines.material as LineMaterial).opacity);
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).opacity = 0.005;
    }

    // Build focus edges (only between visible nodes)
    this._buildFocusSubgraphEdges();

    // Highlight the focus node
    if (idx < this._nodeCount) {
      this._overrideFlags[idx] = 1;
      this._setGlowAlpha(idx, 0.92);
      this._setGlowColor(idx, 0xffffff);
    }

    this._flushOverrideAttrs();
    this.focusSubgraphActive = true;
    const node = this.graphNodes[idx];
    this.focusSubgraphBanner.innerHTML = `${iconHtml('focus', 14)} <b>${t('focus.title')}: ${node.name}</b> &middot; ${this.focusSubgraphVisibleIndices.size} ${t('focus.nodes')} &middot; ${t('focus.exit')}`;
    this.focusSubgraphBanner.style.display = 'flex';
    this.flyToNode(idx);
  }

  exitFocusSubgraph(): void {
    if (!this.focusSubgraphActive) return;

    // ponytail: 必须清 focusNodeIdx/focusActive/focusFlash, 否则 updateFocus 的 flash 分支
    // 持续套 scale×5.5+高 opacity 在 focus 节点, 且 restoreFocusNode 定时器恢复 scale 不管 color → 白点残留
    this.focusActive = false;
    this.focusFlash = 0;
    this.focusNodeIdx = -1;

    for (let i = 0; i < this._nodeCount; i++) {
      if (i < this.focusSubgraphSavedGlowOpacities.length && i < this._nodeCount) {
        this._setGlowAlpha(i, this.focusSubgraphSavedGlowOpacities[i]);
      }
      if (i < this.focusSubgraphSavedCoreVisible.length && i < this._nodeCount) {
        {
          const _v = this.focusSubgraphSavedCoreVisible[i];
          this._setCoreVisible(i, _v);
        }
      }
      // ponytail: 恢复 core color — focus 期间节点可能被 enter 设白或被 hover 循环提白
      if (i < this._nodeCount && i < this.nodeCoreColors.length) {
        this._setCoreColor(i, this.nodeCoreColors[i]);
      }
      // 恢复 glow color — focus 节点被 enter 设成 0xffffff
      if (i < this._nodeCount && i < this.nodeGlowColors.length) {
        this._setGlowColor(i, this.nodeGlowColors[i]);
      }
    }
    for (let ei = 0; ei < this.edgeLineGroups.length; ei++) {
      if (ei < this.focusSubgraphSavedEdgeOpacities.length) {
        (this.edgeLineGroups[ei].material as LineMaterial).opacity = this.focusSubgraphSavedEdgeOpacities[ei];
      }
    }
    // Clear focus edges
    while (this.highlightEdgeGroup.children.length) this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);

    // ponytail: clear override flags — shader resumes animation
    for (let i = 0; i < this._nodeCount; i++) this._overrideFlags[i] = 0;
    this._flushOverrideAttrs();

    this.focusSubgraphActive = false;
    this.focusSubgraphIdx = -1;
    this.focusSubgraphVisibleIndices.clear();
    this.focusSubgraphBanner.style.display = 'none';
  }

  private _buildFocusSubgraphEdges(): void {
    while (this.highlightEdgeGroup.children.length) this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);
    const visible = this.focusSubgraphVisibleIndices;
    const verts: number[] = [];
    const colors: number[] = [];
    const pos = this.nodePositions;

    // ponytail: count edges first for degree-normalization — prevents
    // hub over-exposure when focus node has hundreds of neighbors.
    let edgeCount = 0;
    for (const d of this.edgeDataList) {
      if (visible.has(d.s) && visible.has(d.t)) edgeCount++;
    }
    if (edgeCount === 0) return;
    const degNorm = 1 / edgeCount ** 0.2;

    for (const d of this.edgeDataList) {
      if (visible.has(d.s) && visible.has(d.t)) {
        verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
        const c = edgeColorByType(d.edgeType, d.direction, d.crossFile);
        colors.push(c.r * degNorm, c.g * degNorm, c.b * degNorm, c.r * degNorm, c.g * degNorm, c.b * degNorm);
      }
    }
    if (verts.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.highlightEdgeGroup.add(
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

  private buildLabels(nodes: GraphNode[], deg: number[]): void {
    this.nodeLabelIdx = [];
  }

  // ── Status ───────────────────────────────────────────────

  private updateStatus(nodeCount: number, edgeCount: number, meta?: Record<string, unknown>): void {
    const ns = document.getElementById('status-nodes'),
      es = document.getElementById('status-edges'),
      st = document.getElementById('status-text');
    if (ns) ns.textContent = `${nodeCount} 节点`;
    if (es) es.textContent = `${edgeCount} 边`;
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
    if (st) {
      let text = `${nodeCount} 节点 · ${edgeCount} 边 · S${sCount} D${dCount} T${tCount}`;
      if (l4 > 0) text += ` · ${iconHtml('block', 10)} L4×${l4}`;
      else if (l3 > 0) text += ` · ${iconHtml('alert', 10)} L3×${l3}`;
      if (this._fold.foldMode && this._fold.galaxyMeta.length > 0)
        text += ` · ${iconHtml('galaxy', 10)} ${this._fold.galaxyMeta.length} 星座`;
      st.innerHTML = text;
    }
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

  // ── Animate ──────────────────────────────────────────────

  private _lastFrameTime = 0;

  private animate(): void {
    this.animId = requestAnimationFrame(() => this.animate());

    // ponytail: cap at 30fps — GTX 1060 can't hold 60 on 2846 nodes + 6193 edges
    const now = performance.now();
    if (now - this._lastFrameTime < 33.33) return;
    this._lastFrameTime = now;

    // Skip rendering while scene is being rebuilt — prevents WebGL errors
    // from accessing disposed InstancedMesh/Points geometry and eliminates
    // ghost artifacts on cold-start.
    if (this._renderInProgress) return;

    const isMinimal = false;
    const isFull = true;
    // Auto-rotation disabled

    // Infinite grid follows camera Y — always at viewer level, capped below nodes
    if (this.holoGrid) {
      const sMat = this.holoGrid.material as THREE.ShaderMaterial;
      sMat.uniforms['uCameraWorldPos'].value.copy(this.camera.position);
      this.holoGrid.position.y = Math.min(this.camera.position.y, this.holoGridY);
    }

    if (false) {
      // ponytail: minimal-mode fast path (disabled — isMinimal always false)
      this.controls.update();
      this.composer.render();
      return;
    }

    // ── Idle detection: throttle expensive work when scene is static ──
    const camMoved =
      this.camera.position.distanceToSquared(this._lastCamPos) > 0.0001 ||
      this.controls.target.distanceToSquared(this._lastCamTarget) > 0.0001;
    const mouseOnCanvas = this.mouse.x > -999;
    const isActive =
      camMoved ||
      mouseOnCanvas ||
      this.hoveredIdx >= 0 ||
      this.focusProgress > 0 ||
      this._analysis.blastMode ||
      this._analysis._pathSource >= 0 ||
      this._tooltip._selecting;
    if (isActive) {
      this._idleCounter = 0;
    } else {
      this._idleCounter++;
    }
    this._lastCamPos.copy(this.camera.position);
    this._lastCamTarget.copy(this.controls.target);
    const IDLE = this._idleCounter > 60; // ~1s of no activity

    if (!IDLE || this._idleCounter % 4 === 0) {
      try {
        this.updateHover();
      } catch {
        /* hover must never crash the animation loop */
      }
      try {
        this.updateFocus();
      } catch {
        /* ditto */
      }
      try {
        this._updateBloomByDistance();
      } catch {
        /* bloom switch must never crash loop */
      }
    }

    // ponytail: GPU-driven glow — set time uniforms, shader handles all animation.
    // CPU only touches hovered node + neighbors (~10 nodes).
    const galTime = performance.now() * 0.001;
    // Update shader time uniforms on both glow layers
    if (this.nodeGlowsPoints) {
      (this.nodeGlowsPoints.material as THREE.ShaderMaterial).uniforms['uTime'].value = galTime;
      (this.nodeGlowsPoints.material as THREE.ShaderMaterial).uniforms['uPulseTime'].value = this.pulseTime;
    }
    if (this.nodeGlows2Points) {
      (this.nodeGlows2Points.material as THREE.ShaderMaterial).uniforms['uTime'].value = galTime;
      (this.nodeGlows2Points.material as THREE.ShaderMaterial).uniforms['uPulseTime'].value = this.pulseTime;
    }

    // ── Hover overrides — reset previous, apply current ──
    // Track previously overridden nodes so we can release them back to shader
    if (!this._prevOverrideSet) this._prevOverrideSet = new Set<number>();
    for (const pi of this._prevOverrideSet) {
      if (pi < this._nodeCount) this._overrideFlags[pi] = 0;
    }
    this._prevOverrideSet.clear();
    if (this.nodeGlowsPoints?.geometry.attributes['override']) {
      this.nodeGlowsPoints.geometry.attributes['override'].needsUpdate = true;
    }
    if (this.nodeGlows2Points?.geometry.attributes['override']) {
      this.nodeGlows2Points.geometry.attributes['override'].needsUpdate = true;
    }

    // Hover effects — brightness-only, no size inflation
    this.hoverScale += (this.targetHoverScale - this.hoverScale) * 0.18;
    const neighborSet = new Set(this.hoveredIdx >= 0 ? this.neighborMap[this.hoveredIdx] || [] : []);
    if (this.hoveredIdx >= 0 && this.hoveredIdx < this._nodeCount) {
      this._overrideFlags[this.hoveredIdx] = 1;
      this._prevOverrideSet.add(this.hoveredIdx);
      this._setGlowAlpha(this.hoveredIdx, 0.65 + this.hoverScale * 0.35);
      // Brighten core color toward white on hover
      const origColor = this.nodeCoreColors[this.hoveredIdx];
      const brightColor = new THREE.Color(origColor).lerp(new THREE.Color(0xffffff), this.hoverScale * 0.6);
      this._setCoreColor(this.hoveredIdx, brightColor);
      for (const ni of neighborSet) {
        if (ni !== this.hoveredIdx && ni < this._nodeCount) {
          this._overrideFlags[ni] = 1;
          this._prevOverrideSet.add(ni);
          this._setGlowAlpha(ni, 0.55 + this.hoverScale * 0.1);
        }
      }
    }
    // Flush override flags to GPU (only when overrides changed)
    if (this._prevOverrideSet.size > 0) {
      if (this.nodeGlowsPoints?.geometry.attributes['override']) {
        this.nodeGlowsPoints.geometry.attributes['override'].needsUpdate = true;
      }
      if (this.nodeGlows2Points?.geometry.attributes['override']) {
        this.nodeGlows2Points.geometry.attributes['override'].needsUpdate = true;
      }
    }

    // ── Mode-driven override: blast/path/filter set once on mode change, not per-frame ──
    // ponytail: blast/path/filter modes already call updateBlastNodeColors / highlightPath / etc.
    // which set per-node colors AND override flags. The shader preserves those until reset.
    // We only need to handle the case where a mode was active but animate loop was
    // resetting nodes outside the mode ring back to animated state.
    // With shader-driven glow, no per-frame reset needed — shader animates non-overridden nodes.

    // Galaxy cloud breathe + hover ...
    if (this._fold.foldMode && !this._fold.enteredGalaxyId) {
      this._fold.animateCrossEdgeFlow();
      for (let k = 0; k < this._fold.galaxyGlows.length; k++) {
        const glow = this._fold.galaxyGlows[k];
        if (!glow) continue;
        const gi = Math.floor(k / 2);
        const gm = this._fold.galaxyMeta[gi];
        if (!gm) continue;
        const hovered = gi === this.hoveredGalaxyIdx;
        if (k % 2 === 0) {
          // 外晕 sprite — 缓慢呼吸, hover 提亮
          const w = 1 + Math.sin(this.pulseTime * 0.5 + k * 1.7) * 0.1;
          ((glow as THREE.Sprite).material as THREE.SpriteMaterial).opacity = (hovered ? 0.2 : 0.1) * w;
        } else {
          // 中心球 shader — 轻微脉冲, hover 提亮放大
          const hoverMul = hovered ? 1.2 : 1.0;
          const beat = 0.9 + 0.1 * Math.abs(Math.sin(this.pulseTime * (1.2 + gi * 0.37)));
          ((glow as THREE.Mesh).material as THREE.ShaderMaterial).uniforms['uOpacity'].value = beat * hoverMul;
          glow.scale.setScalar(hovered ? 1.15 : 1.0);
        }
      }
    }

    this.pulseTime += 0.03 * (isFull ? 1.5 : 1);

    if (!IDLE || this._idleCounter % 3 === 0) {
      this._tooltip.updateTooltip(
        this.hoveredIdx,
        this.hoveredGalaxyIdx,
        this.communities,
        this.nodeCommMap,
        this._fold.foldMode,
        this._fold,
        this.container,
        this.camera,
        this._nodeCount,
        this.graphNodes,
        this.deg,
        this.nodePositions,
      );
      this.updateLabels();
      this._fold._updateCommunityRingHover();
    }
    this.controls.update();
    this.composer.render();
  }

  // ── Resize ───────────────────────────────────────────────

  /** Public resize — call after CSS layout changes (e.g. --font-scale, --toolbar-h) */
  resize(): void {
    this.onResize();
  }

  private onResize = (): void => {
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    if (h === 0 || w === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    // ponytail: bloom at 1/4 res — composer.setSize resets it to full, clamp back
    this.bloomPass.resolution.set(Math.floor(w / 4), Math.floor(h / 4));
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).resolution.set(w, h);
    }
  };

  // ── Destroy ──────────────────────────────────────────────

  destroy(): void {
    cancelAnimationFrame(this.animId);
    this._fold.communityRingGroup.clear();
    // Cancel progressive reveal if in-flight (audit: prevent rAF leak after destroy)
    this._revealCancelled = true;
    // Clear prompt auto-hide timer (audit: prevent timeout after destroy)
    if (this._tooltip._promptTimer) {
      clearTimeout(this._tooltip._promptTimer);
      this._tooltip._promptTimer = null;
    }
    window.removeEventListener('resize', this.onResize);
    // Remove window keydown listener (audit HIGH fix — prevent stale reference)
    if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
    // Unsubscribe EventBus handlers (audit: prevent stale bus listeners)
    if (this._langHandler) {
      bus.off('lang:changed', this._langHandler);
      this._langHandler = null;
    }
    if (this._tooltip._showPromptBound) {
      bus.off('graph:show-prompt', this._tooltip._showPromptBound);
      this._tooltip._showPromptBound = null;
    }
    // Dispose all GPU resources
    for (const cloud of this._fold.galaxyClouds) {
      if (cloud) {
        cloud.geometry.dispose();
        (cloud.material as THREE.Material).dispose();
      }
    }
    for (const glow of this._fold.galaxyGlows) ((glow as THREE.Mesh).material as THREE.Material).dispose();
    if (this.nebulaDust) {
      this.nebulaDust.geometry.dispose();
      (this.nebulaDust.material as THREE.Material).dispose();
    }
    // Dispose InstancedMesh cores + glows
    if (this.nodeCoresInstanced) {
      (this.nodeCoresInstanced.material as THREE.Material)?.dispose();
    }
    if (this.nodeGlowsPoints) {
      (this.nodeGlowsPoints.material as THREE.Material)?.dispose();
      this.nodeGlowsPoints.geometry?.dispose();
    }
    if (this.nodeGlows2Points) {
      (this.nodeGlows2Points.material as THREE.Material)?.dispose();
      this.nodeGlows2Points.geometry?.dispose();
    }
    for (const lines of this.edgeLineGroups) {
      lines.geometry?.dispose();
      (lines.material as THREE.Material)?.dispose();
    }
    this.bloomPass?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.glowTex.dispose();
    this.sphereGeo.dispose();
    for (const d of this._fold.galaxyLabelDivs) d.remove();
    this._fold.galaxyLabelDivs = [];
    this._fold.galaxyTitleEl?.remove();
    this._tooltip.tooltipEl?.remove();
    this.labelsContainer?.remove();
    this._tooltip.detailCard?.remove();
    this._tooltip._selectRectEl?.remove();
    this._tooltip._promptBarEl?.remove();
  }
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
