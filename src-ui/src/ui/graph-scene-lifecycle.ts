// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// GraphSceneLifecycle — 场景生命周期
// 从 graph.ts 拆分（P4）：render/增量更新/渐进揭示/清场/动画循环/
// resize/destroy。共享状态字段仍由 facade 持有，经 host 反查。
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { bus } from './events';
import { gpuLayout } from './gpu-layout';
import type { GraphAnalysis } from './graph-analysis';
import { GLOW_COLORS, NODE_COLORS } from './graph-colors';
import type { GraphDiffOverlay } from './graph-diff-overlay';
import type { GraphEdgeRenderer } from './graph-edge-renderer';
import type { GraphFocusController } from './graph-focus-controller';
import { GraphFold } from './graph-fold';
import type { GraphHighlight } from './graph-highlight';
import type { GraphInteractionController } from './graph-interaction-controller';
import type { GraphLabelSystem } from './graph-labels';
import { fibonacciSphere, layout3D, relaxNewNodes, repelCommunityCentroids, spiralGalaxies } from './graph-layout';
import type { GraphNodeRenderer } from './graph-node-renderer';
import { makeCoreFresnelMaterial } from './graph-shaders';
import type { GraphTooltip } from './graph-tooltip';
import type { CommunityData, EdgeData, GraphDiffJson, GraphJSON, GraphNode } from './graph-types';

// ── LifecycleHost — GraphSceneLifecycle 需要从 StarGraph 访问的成员 ──

export interface LifecycleHost {
  // 场景基础设施
  container: HTMLElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: any; // OrbitControls
  composer: any; // EffectComposer
  bloomPass: any; // UnrealBloomPass
  animId: number;
  holoGrid: THREE.Mesh;
  holoGridY: number;
  nebulaDust: THREE.Points;
  sphereGeo: THREE.SphereGeometry;
  glowTex: THREE.Texture;
  pulseTime: number;

  // 组
  nodeGroup: THREE.Group;
  edgeGroup: THREE.Group;
  highlightEdgeGroup: THREE.Group;
  edgeLineGroups: LineSegments2[];

  // 图数据
  graphNodes: GraphNode[];
  nodePositions: Float32Array;
  deg: number[];
  edgeDataList: EdgeData[];
  maxDeg: number;
  neighborMap: number[][];
  edgeIndexOf: number[][];
  nodeLabelIdx: number[];
  l34Count: number[];
  communities: CommunityData[];
  nodeCommMap: Map<number, string>;

  // GPU 缓冲
  nodeCoresInstanced: THREE.InstancedMesh;
  nodeGlowsPoints: THREE.Points;
  nodeGlows2Points: THREE.Points;
  _coreScales: Float32Array;
  _glowRgba: Float32Array;
  _glow2Rgba: Float32Array;
  _overrideFlags: Float32Array;
  _nodeCount: number;
  _nodeCapacity: number;
  _deadIndices: Set<number>;
  nodeGlowColors: number[];
  nodeCoreColors: number[];
  _nodeBaseHSL: Array<{ h: number; s: number; l: number }>;
  _prevOverrideSet: Set<number>;

  // 渲染守卫 / 空间尺度
  _renderInProgress: boolean;
  _graphRadius: number;
  _initCamPos: THREE.Vector3;
  _initCamTarget: THREE.Vector3;

  // Hover / focus（facade 持有的共享状态）
  mouse: THREE.Vector2;
  hoveredIdx: number;
  hoveredGalaxyIdx: number;
  hoverScale: number;
  targetHoverScale: number;
  focusActive: boolean;
  focusProgress: number;
  focusNodeIdx: number;
  focusSubgraphActive: boolean;
  focusSubgraphIdx: number;
  focusSubgraphVisibleIndices: Set<number>;
  focusSubgraphBanner: HTMLDivElement;
  _lensActive: boolean;
  _trailActive: boolean;
  _edgeTypeFilter: string | null;
  _nodeKindFilter: string | null;

  // DOM
  legendEl: HTMLDivElement;
  labelsContainer: HTMLDivElement;
  labelDivs: HTMLDivElement[];

  // 兄弟模块
  _fold: GraphFold;
  _analysis: GraphAnalysis;
  _tooltip: GraphTooltip;
  _diffOverlay: GraphDiffOverlay;
  _labels: GraphLabelSystem;
  _nodes: GraphNodeRenderer;
  _edges: GraphEdgeRenderer;
  _highlight: GraphHighlight;
  _interaction: GraphInteractionController;
  _focus: GraphFocusController;

  // facade 方法
  render(graph: GraphJSON): Promise<void>;
  updateStatus(nodeCount: number, edgeCount: number, meta?: Record<string, unknown>): void;
  positionGrid(pos: Float32Array): void;
  initEdgeParticles(pos: Float32Array, data: EdgeData[]): void;
  initTwinkleData(n: number): void;
  onResize: () => void;
  _onKeyDown?: (e: KeyboardEvent) => void;
  _langHandler: ((data: { lang: string }) => void) | null;
}

// ═══════════════════════════════════════════════════════════════
// GraphSceneLifecycle
// ═══════════════════════════════════════════════════════════════

export class GraphSceneLifecycle {
  // Incremental-update abort: cancel in-flight layout when new data arrives
  private _layoutAbort: AbortController | null = null;

  // Diagnostics
  private _diagMsg = '';

  // Progressive reveal state
  private _revealRevealed = true; // false during animation
  private _revealCancelled = false;
  private _revealGeneration = 0; // ponytail: increment on each new reveal; old rAF callbacks discard themselves

  // Animation loop state
  private _lastFrameTime = 0;
  private _idleCounter = 0;
  private _lastCamPos = new THREE.Vector3();
  private _lastCamTarget = new THREE.Vector3();

  // ponytail: 总览关 bloom 防边密集区雾化; 聚焦开 bloom 让 hover 发光鲜明。滞回防抖。
  private _bloomFar = false;
  private _bloomHysteresis = 0; // 0=稳态, 正值刚切换倒计时防回弹

  constructor(private host: LifecycleHost) {}

  // ── Render ───────────────────────────────────────────────

  async renderImpl(graph: GraphJSON): Promise<void> {
    // Cancel any in-flight layout from a previous render
    if (this._layoutAbort) {
      this._layoutAbort.abort();
    }
    this._layoutAbort = new AbortController();
    // Block animation loop during scene rebuild — prevents access to
    // disposed GPU resources which causes ghost artifacts and cold-start
    // blank screens on slower machines.
    this.host._renderInProgress = true;
    this.clearGraph();
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : Object.values(graph.nodes);
    const edges = Array.isArray(graph.edges) ? graph.edges : Object.values(graph.edges);
    if (nodes.length === 0) {
      this.host.updateStatus(0, 0);
      this.host._renderInProgress = false;
      return;
    }
    this.host.graphNodes = nodes;

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
    this.host.deg = deg;
    this.host.edgeDataList = eData;
    this.host.maxDeg = Math.max(...deg, 1);

    this.host.neighborMap = Array.from({ length: nodes.length }, () => []);
    this.host.edgeIndexOf = Array.from({ length: nodes.length }, () => []);
    for (let ei = 0; ei < eData.length; ei++) {
      const { s, t } = eData[ei];
      this.host.neighborMap[s].push(t);
      this.host.neighborMap[t].push(s);
      this.host.edgeIndexOf[s].push(ei);
      this.host.edgeIndexOf[t].push(ei);
    }

    // ── Parse communities & build node→community index ──────
    // Prefer hierarchical (multi-level) over flat communities
    this.host.communities = ((graph as any).hierarchical_communities ||
      (graph as any).communities ||
      []) as CommunityData[];
    this.host.nodeCommMap.clear();
    // Debug: log community data
    const level0Comms = this.host.communities.filter((c) => !c.level || c.level === 0);
    const level1Comms = this.host.communities.filter((c) => c.level === 1);
    console.log(
      `[DEBUG] Total communities: ${this.host.communities.length}, Level 0: ${level0Comms.length}, Level 1: ${level1Comms.length}`,
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
        if (idx !== undefined) this.host.nodeCommMap.set(idx, comm.id);
      }
    }
    // Galaxy fold mode always uses Level 0 for top-level navigation
    const level0Communities = level0Comms;
    // Pre-compute galaxy members (centroids filled after layout)
    // Only keep communities above minimum size — single-node communities are noise
    this.host._fold.galaxyMeta = [];
    let skippedSingletons = 0;
    for (const comm of level0Communities) {
      const members: number[] = [];
      for (const nid of comm.node_ids) {
        const idx = nodeIdx.get(nid);
        if (idx !== undefined) members.push(idx);
      }
      if (members.length >= GraphFold.MIN_GALAXY_SIZE) {
        this.host._fold.galaxyMeta.push({
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
    this.host._fold.galaxyMeta.sort((a, b) => b.memberIndices.length - a.memberIndices.length);

    this.host.l34Count = new Array(nodes.length).fill(0);
    for (const e of eData) {
      if (e.couplingDepth >= 3) {
        this.host.l34Count[e.s]++;
        this.host.l34Count[e.t]++;
      }
    }

    // ── Force-directed layout: GPU compute (WebGPU) → CPU fallback ──
    const shellRadius = Math.cbrt(nodes.length) * 14;
    const sp = 0.006 + (nodes.length > 2000 ? 0.008 : 0) + (nodes.length > 4000 ? 0.006 : 0);
    const maxIter = Math.min(60, Math.max(15, 60 - Math.floor(nodes.length / 800)));
    let layoutSource = 'CPU';

    // Build numeric community index array for layout (0..C-1, -1 = unassigned)
    const commStrIds = [...new Set(this.host.nodeCommMap.values())];
    const commStrToIdx = new Map<string, number>();
    commStrIds.forEach((sid, i) => commStrToIdx.set(sid, i));
    const nodeCommArr = new Array<number>(nodes.length).fill(-1);
    for (const [nodeIdx, commStr] of this.host.nodeCommMap) {
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
    this.host.nodePositions = rawPos;

    // ── Radius = p95 distance from bounding-box center ──
    const dists: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const r2 = rawPos[i * 3] ** 2 + rawPos[i * 3 + 1] ** 2 + rawPos[i * 3 + 2] ** 2;
      if (isFinite(r2)) dists.push(Math.sqrt(r2));
    }
    dists.sort((a, b) => a - b);
    const radius = dists[Math.floor(dists.length * 0.95)] || 50;
    const absMax = dists[dists.length - 1] || 50;
    this.host._graphRadius = radius; // graph spatial scale — used for camera zoom range only

    // FOV-based camera distance — fills frame regardless of project size
    const fovRad = (this.host.camera.fov * Math.PI) / 180;
    const aspect = this.host.container.clientWidth / Math.max(1, this.host.container.clientHeight);
    const camDist = ((radius / Math.tan(fovRad / 2)) * 0.4) / Math.min(1, aspect);

    const shellR = Math.cbrt(nodes.length) * 14;
    const isoCount = deg.filter((d) => d === 0).length;
    this._diagMsg = `${layoutSource} shellR≈${shellR | 0} radius=${radius | 0} absMax=${absMax | 0} cam=${camDist | 0} iso=${isoCount}/${nodes.length} NaNfix=${fixed}`;

    // ── Camera zoom range — wide open, no LOD clamping ──
    this.host.controls.minDistance = Math.max(0.5, radius * 0.001);
    this.host.controls.maxDistance = Math.max(this.host.controls.maxDistance, camDist * 6);
    // Clip planes: match the actual zoom range so nothing gets hardware-culled
    this.host.camera.near = Math.max(0.05, this.host.controls.minDistance * 0.5);
    this.host.camera.far = this.host.controls.maxDistance * 2;

    // Flatter camera angle — less top-down, more natural
    const dir = new THREE.Vector3(0.3, 0.25, 1).normalize();
    this.host.camera.position.set(dir.x * camDist, dir.y * camDist, dir.z * camDist);
    this.host.controls.target.set(0, 0, 0);
    this.host._initCamPos.copy(this.host.camera.position);
    this.host._initCamTarget.set(0, 0, 0);
    this.host.camera.aspect = aspect;
    this.host.camera.updateProjectionMatrix();
    this.host.controls.update();

    // (standard mode: no bloom — bloom is full-mode only)

    // ── Create batched GPU objects (1 InstancedMesh + 2 Points = 3 draw calls) ──
    this.host._nodeCount = nodes.length;
    this.host._nodeCapacity = nodes.length;
    this.host._deadIndices.clear();
    this.host._coreScales = new Float32Array(nodes.length);
    this.host._glowRgba = new Float32Array(nodes.length * 4);
    this.host._glow2Rgba = true ? new Float32Array(nodes.length * 4) : new Float32Array(0);

    this.host.nodeCoresInstanced = new THREE.InstancedMesh(
      this.host.sphereGeo,
      makeCoreFresnelMaterial(this.host.glowTex),
      nodes.length,
    );
    this.host.nodeCoresInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.host.nodeCoresInstanced.count = 0;
    // ponytail: 10K+ instances spread across large volume → bounding sphere covers
    // the entire graph; frustum culling at the object level is harmful (entire mesh
    // disappears when camera zooms into a region far from the bounding sphere center).
    this.host.nodeCoresInstanced.frustumCulled = false;
    this.host.nodeGroup.add(this.host.nodeCoresInstanced);

    // ── Build scene geometry ──
    this.host._edges.buildEdges(rawPos, eData);
    this.host._nodes.buildNodes(nodes, rawPos, deg);
    this.host._labels.buildLabels(nodes, deg);
    this.host.positionGrid(rawPos);

    // Edge particle flow — full mode dense, standard mode subtle, minimal none
    if (true) {
      this.host.initEdgeParticles(rawPos, eData);
    }
    if (true) {
      this.host.initTwinkleData(nodes.length);
    }

    // ── Progressive reveal: nodes materialize in batches from center outward ──
    this._startProgressiveReveal(nodes.length);

    // ── Compute galaxy centroids + radii from layout ──────────
    for (const gm of this.host._fold.galaxyMeta) {
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
    this.host._fold._buildCommunityRings();

    // ── Apply fold overlay if active ─────────────────────────
    if (this.host._fold.foldMode) this.host._fold.applyFoldOverlay();

    this.host.updateStatus(nodes.length, edges.length, graph.meta);
    if (this.host.legendEl) this.host.legendEl.style.display = '';
    // Append layout diagnostics so user can report them (release build has no DevTools)
    if (this._diagMsg) {
      const st = document.getElementById('status-text');
      if (st) st.textContent = (st.textContent || '') + ' | ' + this._diagMsg;
    }
    // Fix: container may have been display:none during constructor onResize().
    // Defer resize one frame to ensure CSS layout has settled.
    requestAnimationFrame(() => this.handleResize());
    // ponytail: _renderInProgress stays TRUE until progressive reveal completes.
    // Animation loop skips rendering while InstancedMesh.count is still ramping up,
    // otherwise glow Points render at full count while cores are partially hidden
    // → ghost dots (reported as "鬼影").
    // The flag is cleared by _startProgressiveReveal's completion callback.
  }

  // ── Progressive reveal: materialize nodes in batches ────────

  private _startProgressiveReveal(nodeCount: number): void {
    this._revealCancelled = false;
    const myGen = ++this._revealGeneration; // ponytail: bump generation so old rAF callbacks from previous renders bail out
    const BATCH_SIZE = Math.max(50, Math.floor(nodeCount / 40));
    const totalNodes = this.host._nodeCount;
    const totalEdgeGroups = this.host.edgeLineGroups.length;

    // Hide all batched objects
    this.host.nodeCoresInstanced.count = 0;
    this.host.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
    // ponytail: set override flags so shader passes through CPU alpha during reveal
    this.host._overrideFlags.fill(1);
    this.host._nodes._flushOverrideAttrs();
    // Zero all glow alpha — override=1 means shader uses these values directly
    this.host._glowRgba.fill(0);
    this.host.nodeGlowsPoints.geometry.attributes['color'].needsUpdate = true;
    if (this.host._glow2Rgba.length > 0) {
      this.host._glow2Rgba.fill(0);
      this.host.nodeGlows2Points.geometry.attributes['color'].needsUpdate = true;
    }
    // Save & clear edge opacities
    const edgeTargetOpacities: number[] = [];
    for (const lines of this.host.edgeLineGroups) {
      const mat = lines.material as LineMaterial;
      edgeTargetOpacities.push(mat.opacity);
      mat.opacity = 0;
    }
    this.host.labelsContainer.style.opacity = '0';

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
        this.host._renderInProgress = false;
        return;
      }
      const nodeEnd = Math.min(revealedNodes + BATCH_SIZE, totalNodes);
      // Reveal cores via InstancedMesh.count
      this.host.nodeCoresInstanced.count = nodeEnd;
      this.host.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
      // Restore glow alpha for revealed batch
      const gCol = this.host.nodeGlowsPoints.geometry.attributes['color'].array as Float32Array;
      const g2Col = this.host.nodeGlows2Points?.geometry.attributes['color']?.array as Float32Array;
      for (let i = revealedNodes; i < nodeEnd; i++) {
        gCol[i * 4 + 3] = 0.75;
        if (g2Col) g2Col[i * 4 + 3] = 0.48;
      }
      this.host.nodeGlowsPoints.geometry.attributes['color'].needsUpdate = true;
      if (this.host.nodeGlows2Points) this.host.nodeGlows2Points.geometry.attributes['color'].needsUpdate = true;
      revealedNodes = nodeEnd;

      const edgeEnd = Math.min(revealedEdges + edgeRevealBatch, totalEdgeGroups);
      for (let i = revealedEdges; i < edgeEnd; i++) {
        const lines = this.host.edgeLineGroups[i];
        if (lines) (lines.material as LineMaterial).opacity = edgeTargetOpacities[i];
      }
      revealedEdges = edgeEnd;

      if (revealedNodes >= totalNodes && revealedEdges >= totalEdgeGroups) {
        this._revealRevealed = true;
        // ponytail: clear override flags — shader resumes animation now that reveal is done
        this.host._overrideFlags.fill(0);
        this.host._nodes._flushOverrideAttrs();
        // ponytail: force bounding-sphere recompute now that count==totalNodes.
        this.host.nodeCoresInstanced.boundingSphere = null;
        this.host.labelsContainer.style.transition = 'opacity 0.4s ease-in';
        this.host.labelsContainer.style.opacity = '1';
        setTimeout(() => {
          this.host.labelsContainer.style.transition = '';
        }, 500);
        // ponytail: unblock animation loop now that progressive reveal is done.
        // _renderInProgress was kept true since _renderImpl to prevent the
        // animation loop from rendering partial state (ghost dots).
        this.host._renderInProgress = false;
        return;
      }
      requestAnimationFrame(revealFrame);
    };
    requestAnimationFrame(revealFrame);
  }

  clearGraph(): void {
    this._revealCancelled = true; // cancel any in-flight progressive reveal
    ++this._revealGeneration; // ponytail: bump generation so old rAF callbacks bail silently
    // ── Explicit cleanup: each object type knows what to dispose.
    //     DO NOT use a blind disposeGroup walk — nodeCoresInstanced shares
    //     this.sphereGeo (created in constructor, reused across re-renders).
    //     disposeGroup would destroy sphereGeo's WebGL buffers, causing
    //     subsequent InstancedMesh renders to come out blank (cold-start + watcher race).

    // Node cores: dispose material only — sphereGeo is shared, built once in constructor.
    if (this.host.nodeCoresInstanced) {
      (this.host.nodeCoresInstanced.material as THREE.Material)?.dispose();
      this.host.nodeGroup.remove(this.host.nodeCoresInstanced);
    }
    // Glow Points: dispose geometry + material (rebuilt fresh each render).
    if (this.host.nodeGlowsPoints) {
      (this.host.nodeGlowsPoints.material as THREE.Material)?.dispose();
      this.host.nodeGlowsPoints.geometry?.dispose();
      this.host.nodeGroup.remove(this.host.nodeGlowsPoints);
    }
    if (this.host.nodeGlows2Points) {
      (this.host.nodeGlows2Points.material as THREE.Material)?.dispose();
      this.host.nodeGlows2Points.geometry?.dispose();
      this.host.nodeGroup.remove(this.host.nodeGlows2Points);
    }
    // Any remaining stray children in nodeGroup (shouldn't be any, but paranoia).
    while (this.host.nodeGroup.children.length) {
      this.host.nodeGroup.remove(this.host.nodeGroup.children[0]);
    }

    // Edge groups — dispose materials + geometries, clear children.
    for (const lines of this.host.edgeLineGroups) {
      lines.geometry?.dispose();
      (lines.material as THREE.Material)?.dispose();
    }
    while (this.host.edgeGroup.children.length) this.host.edgeGroup.remove(this.host.edgeGroup.children[0]);
    while (this.host.highlightEdgeGroup.children.length)
      this.host.highlightEdgeGroup.remove(this.host.highlightEdgeGroup.children[0]);
    while (this.host._fold.commFoldGroup.children.length)
      this.host._fold.commFoldGroup.remove(this.host._fold.commFoldGroup.children[0]);

    // Legacy: edgeLineGroups array may hold references already disposed above — clear.
    this.host.edgeLineGroups = [];
    this.host.labelsContainer.innerHTML = '';
    this.host.labelDivs = [];
    this.host.nodeLabelIdx = [];
    this.host.nodeGlowColors = [];
    this.host.nodeCoreColors = [];
    this.host._nodeBaseHSL = [];
    this.host._fold.galaxyClouds = [];
    this.host._fold.galaxyGlows = [];
    this.host._fold.galaxyMeta = [];
    this.host._fold.communityRingGroup.clear();
    this.host._fold._communityGlowSprites = [];
    this.host._fold._hoveredCommunityIdx = -1;
    this.host._fold.foldMode = false;
    this.host._fold.enteredGalaxyId = null;
    this.host._fold.enteredSubCommunityId = null;
    this.host._fold._drillStack = [];
    this.host._fold._subCommByNodeIdx.clear();
    this.host._fold._savedGalaxyMeta = null;
    this.host._fold.hideGalaxyTitle();
    this.host._tooltip._hidePrompt();
    for (const d of this.host._fold.galaxyLabelDivs) d.remove();
    this.host._fold.galaxyLabelDivs = [];
    this.host.neighborMap = [];
    this.host.edgeIndexOf = [];
    this.host._deadIndices.clear();
    this.host.hoveredIdx = -1;
    this.host.targetHoverScale = 0;
    this.host.focusActive = false;
    this.host.focusNodeIdx = -1;
    this.host._tooltip.selectedIdx = -1;
    this.host._edgeTypeFilter = null;
    this.host._nodeKindFilter = null;
    this.host._analysis.blastMode = false;
    this.host._analysis.blastSource = -1;
    this.host._analysis.blastDistances = [];
    this.host.l34Count = [];
    this._diagMsg = '';
    if (this.host.legendEl) this.host.legendEl.style.display = 'none';
    this.host.focusSubgraphActive = false;
    this.host.focusSubgraphIdx = -1;
    this.host.focusSubgraphVisibleIndices.clear();
    if (this.host.focusSubgraphBanner) this.host.focusSubgraphBanner.style.display = 'none';
    this.host._tooltip.tooltipEl?.classList.remove('visible');
    this.host._tooltip.detailCard?.classList.remove('visible');
    // Step 2: Clear lens & trail state
    this.host._lensActive = false;
    this.host._trailActive = false;
    this.host._highlight._clearTrailLine();
  }

  // ══════════════════════════════════════════════════════════
  // Incremental graph update — apply diff without full re-render
  // ══════════════════════════════════════════════════════════

  /**
   * Apply a graph diff incrementally — no layout recalc, no camera reset,
   * no progressive reveal. Preserves hover/selected/blast/filter/diff state.
   * Falls back to full render() if no existing graph.
   */
  async applyGraphDiff(diff: GraphDiffJson, fullGraph: GraphJSON): Promise<void> {
    if (this.host._nodeCount === 0) {
      this.host.render(fullGraph);
      return;
    }

    // Exit fold mode — incremental + fold is visually inconsistent
    if (this.host._fold.foldMode) this.host._fold.setFoldMode(false);

    // Build node ID → index map (alive nodes only)
    const nodeIdxMap = new Map<string, number>();
    for (let i = 0; i < this.host.graphNodes.length; i++) {
      if (!this.host._deadIndices.has(i) && this.host.graphNodes[i]) nodeIdxMap.set(this.host.graphNodes[i].id, i);
    }

    const newIndices = new Set<number>(); // track which nodes are new
    const neighborIndices = new Set<number>(); // neighbors of new nodes

    // 1. Removed nodes → mark dead
    for (const rn of diff.removed_nodes) {
      const idx = nodeIdxMap.get(rn.id);
      if (idx !== undefined) {
        this.host._nodes._markNodeDead(idx);
        nodeIdxMap.delete(rn.id);
      }
    }

    // 2. Modified nodes → update kind/color
    for (const mn of diff.modified_nodes) {
      const idx = nodeIdxMap.get(mn.node_id);
      if (idx === undefined) continue;
      this.host.graphNodes[idx].name = mn.name;
      this.host.graphNodes[idx].kind = mn.new_kind;
      this.host.graphNodes[idx].type = mn.new_kind;
      const kind = mn.new_kind.toLowerCase();
      const glowColor = GLOW_COLORS[kind] || 0x4488cc;
      const coreColor = NODE_COLORS[kind] || 0x6ab0ff;
      this.host._nodes._setGlowColor(idx, glowColor);
      this.host._nodes._setCoreColor(idx, coreColor);
      this.host.nodeGlowColors[idx] = glowColor;
      this.host.nodeCoreColors[idx] = coreColor;
    }

    // 3. Added nodes → extend buffers + append
    if (diff.added_nodes.length > 0) {
      const needed = this.host._nodeCount + diff.added_nodes.length;
      if (needed > this.host._nodeCapacity) {
        this.host._nodes._rebuildNodeBuffers(Math.ceil(needed * 1.2));
      }
      this.host._nodes._appendNodes(diff.added_nodes, fullGraph, nodeIdxMap);
      // Track new indices
      for (const n of diff.added_nodes) {
        const idx = nodeIdxMap.get(n.id);
        if (idx !== undefined) newIndices.add(idx);
      }
    }

    // 4. Rebuild edges if any changed — rebuilds edgeDataList, neighborMap, edgeIndexOf
    if (diff.added_edges.length > 0 || diff.removed_edges.length > 0) {
      this.host._edges._rebuildEdgeData(fullGraph, nodeIdxMap);
    }

    // 5. Collect neighbor indices for local layout relaxation
    for (const ni of newIndices) {
      for (const nb of this.host.neighborMap[ni] || []) {
        if (!newIndices.has(nb)) neighborIndices.add(nb);
      }
    }

    // 6. Local force relaxation — new nodes + their neighbors,
    //    treating neighbors as anchored (only new nodes move freely)
    if (newIndices.size > 0) {
      const affected = new Set([...newIndices, ...neighborIndices]);
      // Build edge pairs from edgeDataList
      const allPairs: [number, number][] = this.host.edgeDataList.map((e) => [e.s, e.t]);
      try {
        await relaxNewNodes(
          this.host.nodePositions,
          this.host._nodeCount,
          allPairs,
          affected,
          neighborIndices, // anchors: existing neighbors stay fixed
        );
      } catch (e) {
        console.warn('[StarGraph] local relax failed, positions may be suboptimal:', e);
      }
      // Sync updated positions to GPU buffers
      this.host._nodes._syncNodePositions([...affected]);
    }

    // 7. Sync GPU core positions for all modified nodes
    this.host._nodes._syncNodeCoreMatrices();

    // 8. Update communities from full graph
    this.host.communities = ((fullGraph as any).hierarchical_communities ||
      (fullGraph as any).communities ||
      []) as CommunityData[];

    // 9. Clear stale interaction state pointing to dead nodes
    if (this.host.hoveredIdx >= 0 && this.host._deadIndices.has(this.host.hoveredIdx)) {
      this.host.hoveredIdx = -1;
      this.host.targetHoverScale = 0;
    }
    if (this.host._tooltip.selectedIdx >= 0 && this.host._deadIndices.has(this.host._tooltip.selectedIdx))
      this.host._tooltip.selectedIdx = -1;
    if (this.host._analysis.blastSource >= 0 && this.host._deadIndices.has(this.host._analysis.blastSource)) {
      this.host._analysis.blastMode = false;
      this.host._analysis.blastSource = -1;
      this.host._analysis.blastDistances = [];
    }
    if (this.host.focusNodeIdx >= 0 && this.host._deadIndices.has(this.host.focusNodeIdx)) {
      this.host.focusActive = false;
      this.host.focusNodeIdx = -1;
    }

    // 10. Re-apply diff overlay if active (new nodes might be in the diff set)
    if (
      this.host._diffOverlay.diffActive &&
      this.host._diffOverlay.diffAddedIds.size +
        this.host._diffOverlay.diffRemovedIds.size +
        this.host._diffOverlay.diffModifiedIds.size >
        0
    ) {
      const saved = {
        added_nodes: [...this.host._diffOverlay.diffAddedIds].map((id) => ({ id })),
        removed_nodes: [...this.host._diffOverlay.diffRemovedIds].map((id) => ({ id })),
        modified_nodes: [...this.host._diffOverlay.diffModifiedIds].map((id) => ({ node_id: id })),
      };
      this.host._diffOverlay.clearDiff();
      this.host._diffOverlay.showDiff(saved);
    }

    // 11. Update status
    const aliveCount = this.host._nodeCount - this.host._deadIndices.size;
    this.host.updateStatus(aliveCount, this.host.edgeDataList.length);

    this.host._nodes._flushOverrideAttrs();
  }

  // ponytail: 总览(相机距 target > graphRadius*2.2)关 bloom 防边密集叠加区被 bloom 扩散成雾;
  // 聚焦(< graphRadius*1.6)开 bloom 让 hover/选中节点发光鲜明。滞回 30 帧防阈值抖动回弹。
  private _updateBloomByDistance(): void {
    if (this.host._graphRadius < 1 || this.host._fold.foldMode) return;
    const dist = this.host.camera.position.distanceTo(this.host.controls.target);
    const farThresh = this.host._graphRadius * 2.2;
    const nearThresh = this.host._graphRadius * 1.6;
    const hasBloom = this.host.composer.passes.indexOf(this.host.bloomPass) !== -1;
    if (this._bloomHysteresis > 0) {
      this._bloomHysteresis--;
      return;
    }
    if (this._bloomFar) {
      if (dist < nearThresh) {
        this._bloomFar = false;
        if (!hasBloom) this.host.composer.addPass(this.host.bloomPass);
        this._bloomHysteresis = 30;
      }
    } else {
      if (dist > farThresh) {
        this._bloomFar = true;
        if (hasBloom) this.host.composer.removePass(this.host.bloomPass);
        this._bloomHysteresis = 30;
      }
    }
  }

  // ── Animate ──────────────────────────────────────────────

  animate(): void {
    this.host.animId = requestAnimationFrame(() => this.animate());

    // ponytail: cap at 30fps — GTX 1060 can't hold 60 on 2846 nodes + 6193 edges
    const now = performance.now();
    if (now - this._lastFrameTime < 33.33) return;
    this._lastFrameTime = now;

    // Skip rendering while scene is being rebuilt — prevents WebGL errors
    // from accessing disposed InstancedMesh/Points geometry and eliminates
    // ghost artifacts on cold-start.
    if (this.host._renderInProgress) return;

    const isMinimal = false;
    const isFull = true;
    // Auto-rotation disabled

    // Infinite grid follows camera Y — always at viewer level, capped below nodes
    if (this.host.holoGrid) {
      const sMat = this.host.holoGrid.material as THREE.ShaderMaterial;
      sMat.uniforms['uCameraWorldPos'].value.copy(this.host.camera.position);
      this.host.holoGrid.position.y = Math.min(this.host.camera.position.y, this.host.holoGridY);
    }

    if (false) {
      // ponytail: minimal-mode fast path (disabled — isMinimal always false)
      this.host.controls.update();
      this.host.composer.render();
      return;
    }

    // ── Idle detection: throttle expensive work when scene is static ──
    const camMoved =
      this.host.camera.position.distanceToSquared(this._lastCamPos) > 0.0001 ||
      this.host.controls.target.distanceToSquared(this._lastCamTarget) > 0.0001;
    const mouseOnCanvas = this.host.mouse.x > -999;
    const isActive =
      camMoved ||
      mouseOnCanvas ||
      this.host.hoveredIdx >= 0 ||
      this.host.focusProgress > 0 ||
      this.host._analysis.blastMode;
    if (isActive) {
      this._idleCounter = 0;
    } else {
      this._idleCounter++;
    }
    this._lastCamPos.copy(this.host.camera.position);
    this._lastCamTarget.copy(this.host.controls.target);
    const IDLE = this._idleCounter > 60; // ~1s of no activity

    if (!IDLE || this._idleCounter % 4 === 0) {
      try {
        this.host._interaction.updateHover();
      } catch {
        /* hover must never crash the animation loop */
      }
      try {
        this.host._focus.updateFocus();
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
    if (this.host.nodeGlowsPoints) {
      (this.host.nodeGlowsPoints.material as THREE.ShaderMaterial).uniforms['uTime'].value = galTime;
      (this.host.nodeGlowsPoints.material as THREE.ShaderMaterial).uniforms['uPulseTime'].value = this.host.pulseTime;
    }
    if (this.host.nodeGlows2Points) {
      (this.host.nodeGlows2Points.material as THREE.ShaderMaterial).uniforms['uTime'].value = galTime;
      (this.host.nodeGlows2Points.material as THREE.ShaderMaterial).uniforms['uPulseTime'].value = this.host.pulseTime;
    }

    // ── Hover overrides — reset previous, apply current ──
    // Track previously overridden nodes so we can release them back to shader
    if (!this.host._prevOverrideSet) this.host._prevOverrideSet = new Set<number>();
    for (const pi of this.host._prevOverrideSet) {
      if (pi < this.host._nodeCount) this.host._overrideFlags[pi] = 0;
    }
    this.host._prevOverrideSet.clear();
    if (this.host.nodeGlowsPoints?.geometry.attributes['override']) {
      this.host.nodeGlowsPoints.geometry.attributes['override'].needsUpdate = true;
    }
    if (this.host.nodeGlows2Points?.geometry.attributes['override']) {
      this.host.nodeGlows2Points.geometry.attributes['override'].needsUpdate = true;
    }

    // Hover effects — brightness-only, no size inflation
    this.host.hoverScale += (this.host.targetHoverScale - this.host.hoverScale) * 0.18;
    const neighborSet = new Set(this.host.hoveredIdx >= 0 ? this.host.neighborMap[this.host.hoveredIdx] || [] : []);
    if (this.host.hoveredIdx >= 0 && this.host.hoveredIdx < this.host._nodeCount) {
      this.host._overrideFlags[this.host.hoveredIdx] = 1;
      this.host._prevOverrideSet.add(this.host.hoveredIdx);
      this.host._nodes._setGlowAlpha(this.host.hoveredIdx, 0.65 + this.host.hoverScale * 0.35);
      // Brighten core color toward white on hover
      const origColor = this.host.nodeCoreColors[this.host.hoveredIdx];
      const brightColor = new THREE.Color(origColor).lerp(new THREE.Color(0xffffff), this.host.hoverScale * 0.6);
      this.host._nodes._setCoreColor(this.host.hoveredIdx, brightColor);
      for (const ni of neighborSet) {
        if (ni !== this.host.hoveredIdx && ni < this.host._nodeCount) {
          this.host._overrideFlags[ni] = 1;
          this.host._prevOverrideSet.add(ni);
          this.host._nodes._setGlowAlpha(ni, 0.55 + this.host.hoverScale * 0.1);
        }
      }
    }
    // Flush override flags to GPU (only when overrides changed)
    if (this.host._prevOverrideSet.size > 0) {
      if (this.host.nodeGlowsPoints?.geometry.attributes['override']) {
        this.host.nodeGlowsPoints.geometry.attributes['override'].needsUpdate = true;
      }
      if (this.host.nodeGlows2Points?.geometry.attributes['override']) {
        this.host.nodeGlows2Points.geometry.attributes['override'].needsUpdate = true;
      }
    }

    // ── Mode-driven override: blast/path/filter set once on mode change, not per-frame ──
    // ponytail: blast/path/filter modes already call updateBlastNodeColors / highlightPath / etc.
    // which set per-node colors AND override flags. The shader preserves those until reset.
    // We only need to handle the case where a mode was active but animate loop was
    // resetting nodes outside the mode ring back to animated state.
    // With shader-driven glow, no per-frame reset needed — shader animates non-overridden nodes.

    // Galaxy cloud breathe + hover ...
    if (this.host._fold.foldMode && !this.host._fold.enteredGalaxyId) {
      this.host._fold.animateCrossEdgeFlow();
      for (let k = 0; k < this.host._fold.galaxyGlows.length; k++) {
        const glow = this.host._fold.galaxyGlows[k];
        if (!glow) continue;
        const gi = Math.floor(k / 2);
        const gm = this.host._fold.galaxyMeta[gi];
        if (!gm) continue;
        const hovered = gi === this.host.hoveredGalaxyIdx;
        if (k % 2 === 0) {
          // 外晕 sprite — 缓慢呼吸, hover 提亮
          const w = 1 + Math.sin(this.host.pulseTime * 0.5 + k * 1.7) * 0.1;
          ((glow as THREE.Sprite).material as THREE.SpriteMaterial).opacity = (hovered ? 0.2 : 0.1) * w;
        } else {
          // 中心球 shader — 轻微脉冲, hover 提亮放大
          const hoverMul = hovered ? 1.2 : 1.0;
          const beat = 0.9 + 0.1 * Math.abs(Math.sin(this.host.pulseTime * (1.2 + gi * 0.37)));
          ((glow as THREE.Mesh).material as THREE.ShaderMaterial).uniforms['uOpacity'].value = beat * hoverMul;
          glow.scale.setScalar(hovered ? 1.15 : 1.0);
        }
      }
    }

    this.host.pulseTime += 0.03 * (isFull ? 1.5 : 1);

    if (!IDLE || this._idleCounter % 3 === 0) {
      this.host._tooltip.updateTooltip(
        this.host.hoveredIdx,
        this.host.hoveredGalaxyIdx,
        this.host.communities,
        this.host.nodeCommMap,
        this.host._fold.foldMode,
        this.host._fold,
        this.host.container,
        this.host.camera,
        this.host._nodeCount,
        this.host.graphNodes,
        this.host.deg,
        this.host.nodePositions,
      );
      this.host._labels.updateLabels();
      this.host._fold._updateCommunityRingHover();
    }
    this.host.controls.update();
    this.host.composer.render();
  }

  // ── Resize ───────────────────────────────────────────────

  handleResize(): void {
    const w = this.host.container.clientWidth,
      h = this.host.container.clientHeight;
    if (h === 0 || w === 0) return;
    this.host.camera.aspect = w / h;
    this.host.camera.updateProjectionMatrix();
    this.host.renderer.setSize(w, h);
    this.host.composer.setSize(w, h);
    // ponytail: bloom at 1/4 res — composer.setSize resets it to full, clamp back
    this.host.bloomPass.resolution.set(Math.floor(w / 4), Math.floor(h / 4));
    for (const lines of this.host.edgeLineGroups) {
      (lines.material as LineMaterial).resolution.set(w, h);
    }
  }

  // ── Destroy ──────────────────────────────────────────────

  destroy(): void {
    cancelAnimationFrame(this.host.animId);
    this.host._fold.communityRingGroup.clear();
    // Cancel progressive reveal if in-flight (audit: prevent rAF leak after destroy)
    this._revealCancelled = true;
    // Clear prompt auto-hide timer (audit: prevent timeout after destroy)
    if (this.host._tooltip._promptTimer) {
      clearTimeout(this.host._tooltip._promptTimer);
      this.host._tooltip._promptTimer = null;
    }
    window.removeEventListener('resize', this.host.onResize);
    // Remove window keydown listener (audit HIGH fix — prevent stale reference)
    if (this.host._onKeyDown) window.removeEventListener('keydown', this.host._onKeyDown);
    // Unsubscribe EventBus handlers (audit: prevent stale bus listeners)
    if (this.host._langHandler) {
      bus.off('lang:changed', this.host._langHandler);
      this.host._langHandler = null;
    }
    if (this.host._tooltip._showPromptBound) {
      bus.off('graph:show-prompt', this.host._tooltip._showPromptBound);
      this.host._tooltip._showPromptBound = null;
    }
    // Dispose all GPU resources
    for (const cloud of this.host._fold.galaxyClouds) {
      if (cloud) {
        cloud.geometry.dispose();
        (cloud.material as THREE.Material).dispose();
      }
    }
    for (const glow of this.host._fold.galaxyGlows) ((glow as THREE.Mesh).material as THREE.Material).dispose();
    if (this.host.nebulaDust) {
      this.host.nebulaDust.geometry.dispose();
      (this.host.nebulaDust.material as THREE.Material).dispose();
    }
    // Dispose InstancedMesh cores + glows
    if (this.host.nodeCoresInstanced) {
      (this.host.nodeCoresInstanced.material as THREE.Material)?.dispose();
    }
    if (this.host.nodeGlowsPoints) {
      (this.host.nodeGlowsPoints.material as THREE.Material)?.dispose();
      this.host.nodeGlowsPoints.geometry?.dispose();
    }
    if (this.host.nodeGlows2Points) {
      (this.host.nodeGlows2Points.material as THREE.Material)?.dispose();
      this.host.nodeGlows2Points.geometry?.dispose();
    }
    for (const lines of this.host.edgeLineGroups) {
      lines.geometry?.dispose();
      (lines.material as THREE.Material)?.dispose();
    }
    this.host.bloomPass?.dispose();
    this.host.renderer.dispose();
    this.host.renderer.domElement.remove();
    this.host.glowTex.dispose();
    this.host.sphereGeo.dispose();
    for (const d of this.host._fold.galaxyLabelDivs) d.remove();
    this.host._fold.galaxyLabelDivs = [];
    this.host._fold.galaxyTitleEl?.remove();
    this.host._tooltip.tooltipEl?.remove();
    this.host.labelsContainer?.remove();
    this.host._tooltip.detailCard?.remove();
    this.host._tooltip._promptBarEl?.remove();
  }
}
