// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// GraphSceneLifecycle — 场景生命周期
// 从 graph.ts 拆分（P4）：render/增量更新/渐进揭示/清场/动画循环/
// resize/destroy。共享状态字段仍由 facade 持有，经 host 反查。
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { bus } from './stubs/events';
import { gpuLayout } from './gpu-layout';
import { useShellStore } from './stubs/shell-store';
import type { GraphAnalysis } from './graph-analysis';
import { GLOW_COLORS, NODE_COLORS } from './graph-colors';
import type { GraphDiffOverlay } from './graph-diff-overlay';
import type { GraphEdgeRenderer } from './graph-edge-renderer';
import type { GraphFocusController } from './graph-focus-controller';
import { GraphFold } from './graph-fold';
import { disposeGlowInstanced, type GlowPointsLike } from './graph-glow-instanced';
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
  controls: OrbitControls;
  composer: EffectComposer;
  bloomPass: UnrealBloomPass;
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
  // WebKitGTK 上为 InstancedMesh（graph-glow-instanced），其余平台为 THREE.Points —— 接口一致
  nodeGlowsPoints: GlowPointsLike;
  nodeGlows2Points: GlowPointsLike;
  _coreScales: Float32Array;
  _nodeMagCache: Float32Array;
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
  _langHandler: ((data: { lang: string }) => void) | null;
}

// ═══════════════════════════════════════════════════════════════
// GraphSceneLifecycle
// ═══════════════════════════════════════════════════════════════

export class GraphSceneLifecycle {
  // 增量更新中止：新数据到达时取消进行中的布局
  private _layoutAbort: AbortController | null = null;

  // 诊断
  private _diagMsg = '';
  private _revealCancelled = false;
  private _revealGeneration = 0; // ponytail: 每次新揭示递增；旧 rAF 回调自行退出
  private _revealRevealed = false;

  // 动画循环状态
  private _lastFrameTime = 0;
  private _idleCounter = 0;
  private _lastCamPos = new THREE.Vector3();
  private _lastCamTarget = new THREE.Vector3();
  private _lastMouseX = -999;
  private _lastMouseY = -999;

  constructor(private host: LifecycleHost) {}

  // ── 渲染 ───────────────────────────────────────────────

  async renderImpl(graph: GraphJSON): Promise<void> {
    // 取消之前渲染的进行中布局
    if (this._layoutAbort) {
      this._layoutAbort.abort();
    }
    this._layoutAbort = new AbortController();
    // 场景重建期间阻止动画循环 — 防止访问已释放的 GPU 资源，
    // 避免鬼影和慢机器上的冷启动黑屏。
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
    // 从节点位置提取文件路径（如 "src/foo.py:10" → "src/foo.py"）
    const nodeFile = new Map<number, string>();
    for (let i = 0; i < nodes.length; i++) {
      const loc = nodes[i].location || '';
      // 去除行号后缀（如 ":10"）
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
          couplingDepth: e.coupling_depth || 0,
          edgeType: e.type || '',
          direction: e.direction || '',
          crossFile,
          ambiguous: !!e.metadata?.ambiguous,
        });
      }
    }
    // 调试：统计跨文件边数
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

    // ── 解析社区 & 构建 node→community 索引 ──────
    // 优先使用层级（多级）而非扁平社区
    // P0-2 修复：空数组在 JS 里是真值 — 分页空壳的 hierarchical_communities:[]
    // 会阻断回退到 communities，布局丢失社区分组（目录分组兜底 → 一锅粥）。
    const hc = graph.hierarchical_communities;
    this.host.communities = (Array.isArray(hc) && hc.length > 0 ? hc : graph.communities) || [];
    this.host.nodeCommMap.clear();
    // 调试：记录社区数据
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
    // 星系折叠模式始终使用 Level 0 进行顶层导航
    const level0Communities = level0Comms;
    // 预计算星系成员（质心在布局后填充）
    // 仅保留高于最小大小的社区 — 单节点社区是噪声
    this.host._fold.galaxyMeta = [];
    let _skippedSingletons = 0;
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
        _skippedSingletons += members.length;
      }
    }
    // 按大小降序排列星系，最大的先渲染
    this.host._fold.galaxyMeta.sort((a, b) => b.memberIndices.length - a.memberIndices.length);

    this.host.l34Count = new Array(nodes.length).fill(0);
    for (const e of eData) {
      if (e.couplingDepth >= 3) {
        this.host.l34Count[e.s]++;
        this.host.l34Count[e.t]++;
      }
    }

    // ── 力导向布局：GPU 计算（WebGPU）→ CPU 回退 ──
    const shellRadius = Math.cbrt(nodes.length) * 14;
    const sp = 0.006 + (nodes.length > 2000 ? 0.008 : 0) + (nodes.length > 4000 ? 0.006 : 0);
    const maxIter = Math.min(60, Math.max(15, 60 - Math.floor(nodes.length / 800)));
    let layoutSource = 'CPU';

    // 构建布局用的数值社区索引数组（0..C-1，-1 = 未分配）
    const commStrIds = [...new Set(this.host.nodeCommMap.values())];
    const commStrToIdx = new Map<string, number>();
    commStrIds.forEach((sid, i) => commStrToIdx.set(sid, i));
    const nodeCommArr = new Array<number>(nodes.length).fill(-1);
    for (const [nodeIdx, commStr] of this.host.nodeCommMap) {
      nodeCommArr[nodeIdx] = commStrToIdx.get(commStr) ?? -1;
    }

    // 回退：如 Louvain 仅给出 ≤1 个社区，按顶级目录分组
    if (commStrIds.length <= 1) {
      console.warn(
        `[StarGraph] Louvain only found ${commStrIds.length} communities — falling back to directory-based grouping`,
      );
      const dirGroups = new Map<string, number[]>();
      for (let i = 0; i < nodes.length; i++) {
        const loc = nodes[i].location || '';
        // 提取顶级目录："src/foo/bar.py" → "src", "engine/src/main.rs" → "engine"
        const topDir = loc.replace(/^[/\\]+/, '').split(/[/\\]/)[0] || '(root)';
        if (!dirGroups.has(topDir)) dirGroups.set(topDir, []);
        dirGroups.get(topDir)?.push(i);
      }
      console.warn(`[StarGraph] Directory-based groups: ${dirGroups.size} groups`, [...dirGroups.keys()]);
      // 仅在比 Louvain 得到更多组时使用
      if (dirGroups.size > 1) {
        let nextId = 0;
        for (const [_dir, members] of dirGroups) {
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
    // 确保 GPU 初始化完成后再选择布局路径 — 消除首次渲染用 CPU（初始化
    // 未完成）而后续渲染用 GPU 的竞争，避免视觉上不一致的布局。
    await gpuLayout.init();
    // GPU 路径：N-body 计算宏观结构，螺旋生成微观结构
    if (gpuLayout.ready) {
      // ── GPU N-body：边力产生宏观结构，螺旋产生微观结构 ──
      // 过滤跨社区边 — 它们产生丝状结构。
      // 社区放置由 repelCommunityCentroids 处理。
      const intraPairs = effGroups.size > 1
        ? pairs.filter(([s, t]) => nodeCommArr[s] === nodeCommArr[t])
        : pairs;
      const initPos = fibonacciSphere(nodes.length, shellRadius);
      const gpuResult = await gpuLayout.compute(
        nodes.length,
        intraPairs,
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
    // ── 安全：替换 NaN，安全质心 + 相机 ──
    let fixed = 0;
    for (let i = 0; i < rawPos.length; i++) {
      if (!Number.isFinite(rawPos[i])) {
        rawPos[i] = 0;
        fixed++;
      }
    }
    if (fixed > 0) console.warn(`[StarGraph] Fixed ${fixed} NaN position components`);
    // ── 包围盒居中（不受簇大小偏差影响）──
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
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
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

    // ── 半径 = 距包围盒中心的 p95 距离 ──
    const dists: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const r2 = rawPos[i * 3] ** 2 + rawPos[i * 3 + 1] ** 2 + rawPos[i * 3 + 2] ** 2;
      if (Number.isFinite(r2)) dists.push(Math.sqrt(r2));
    }
    dists.sort((a, b) => a - b);
    const radius = dists[Math.floor(dists.length * 0.95)] || 50;
    const absMax = dists[dists.length - 1] || 50;
    this.host._graphRadius = radius; // 图空间尺度 — 仅用于相机缩放范围

    // 基于 FOV 的相机距离 — 无论项目大小都填满画面
    const fovRad = (this.host.camera.fov * Math.PI) / 180;
    const aspect = this.host.container.clientWidth / Math.max(1, this.host.container.clientHeight);
    const camDist = ((radius / Math.tan(fovRad / 2)) * 0.6) / Math.min(1, aspect);

    const shellR = Math.cbrt(nodes.length) * 14;
    const isoCount = deg.filter((d) => d === 0).length;
    this._diagMsg = `${layoutSource} shellR≈${shellR | 0} radius=${radius | 0} absMax=${absMax | 0} cam=${camDist | 0} iso=${isoCount}/${nodes.length} NaNfix=${fixed}`;

    // ── 相机缩放范围 — 全开，无 LOD 裁剪 ──
    this.host.controls.minDistance = Math.max(0.5, radius * 0.001);
    this.host.controls.maxDistance = Math.max(this.host.controls.maxDistance, camDist * 6);
    // 裁剪面：匹配实际缩放范围，不被硬件裁剪
    this.host.camera.near = Math.max(0.05, this.host.controls.minDistance * 0.5);
    this.host.camera.far = this.host.controls.maxDistance * 2;

    // 更平的相机角度 — 减少俯视，更自然
    const dir = new THREE.Vector3(0.3, 0.25, 1).normalize();
    this.host.camera.position.set(dir.x * camDist, dir.y * camDist, dir.z * camDist);
    this.host.controls.target.set(0, 0, 0);
    this.host._initCamPos.copy(this.host.camera.position);
    this.host._initCamTarget.set(0, 0, 0);
    this.host.camera.aspect = aspect;
    this.host.camera.updateProjectionMatrix();
    this.host.controls.update();

    // （标准模式：无 bloom — bloom 仅全模式）

    // ── 创建批量 GPU 对象（1 InstancedMesh + 2 Points = 3 draw calls）──
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
    // ponytail: 10K+ 实例分散在大体积中 → 包围球覆盖整个图；
    // 对象级视锥裁剪有害（相机缩放到远离包围球中心的区域时
    // 整个 mesh 会消失）。
    this.host.nodeCoresInstanced.frustumCulled = false;
    this.host.nodeGroup.add(this.host.nodeCoresInstanced);

    // ── 构建场景几何 ──
    this.host._edges.buildEdges(rawPos, eData);
    this.host._nodes.buildNodes(nodes, rawPos, deg);
    this.host._labels.buildLabels(nodes, deg);
    this.host.positionGrid(rawPos);

    // 边粒子流 — 全模式密集，标准模式稀疏，最小模式无
    if (true) {
      this.host.initEdgeParticles(rawPos, eData);
    }
    if (true) {
      this.host.initTwinkleData(nodes.length);
    }

    // ── 渐进揭示：节点从中心向外分批物化 ──
    this._startProgressiveReveal(nodes.length);

    // ── 从布局计算星系质心 + 半径 ──────────
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
      // p90 半径
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

    // ── 如折叠覆盖激活则应用 ─────────────────────────
    if (this.host._fold.foldMode) this.host._fold.applyFoldOverlay();

    this.host.updateStatus(nodes.length, edges.length, graph.meta);
    if (this.host.legendEl) this.host.legendEl.style.display = '';
    // 附加布局诊断供用户报告（release 构建无 DevTools）
    if (this._diagMsg) {
      const cur = useShellStore.getState().statusText;
      useShellStore.getState().setStatusText(`${cur} | ${this._diagMsg}`);
    }
    // 修复：constructor 中 onResize() 执行时容器可能是 display:none。
    // 延迟一帧 resize 确保 CSS 布局已稳定。
    requestAnimationFrame(() => this.handleResize());
    // ponytail: _renderInProgress 保持 TRUE 直到渐进揭示完成。
    // 动画循环在 InstancedMesh.count 仍在递增时跳过渲染，
    // 否则辉光 Points 以完整数量渲染而核心部分隐藏
    // → 鬼影点（报告为"鬼影"）。
    // 该标志由 _startProgressiveReveal 的完成回调清除。
  }

  // ── 渐进揭示：分批物化节点 ────────

  private _startProgressiveReveal(nodeCount: number): void {
    this._revealCancelled = false;
    const myGen = ++this._revealGeneration; // ponytail: 递增代际，使旧渲染的 rAF 回调自行退出
    const BATCH_SIZE = Math.max(50, Math.floor(nodeCount / 40));
    const totalNodes = this.host._nodeCount;
    const totalEdgeGroups = this.host.edgeLineGroups.length;

    // 隐藏所有批量对象
    this.host.nodeCoresInstanced.count = 0;
    this.host.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
    // ponytail: 设置 override 标志使 shader 在揭示期间透传 CPU alpha
    this.host._overrideFlags.fill(1);
    this.host._nodes._flushOverrideAttrs();
    // 清零所有辉光 alpha — override=1 表示 shader 直接使用这些值。
    // ponytail: 仅清零 alpha 通道，保留 RGB — fill(0) 会清除 RGB，
    // 导致 hover 通过 override 路径读取 (0,0,0) 辉光颜色 → 黑点
    for (let i = 0; i < totalNodes; i++) {
      this.host._glowRgba[i * 4 + 3] = 0;
    }
    this.host.nodeGlowsPoints.geometry.attributes.color.needsUpdate = true;
    if (this.host._glow2Rgba.length > 0) {
      for (let i = 0; i < totalNodes; i++) {
        this.host._glow2Rgba[i * 4 + 3] = 0;
      }
      this.host.nodeGlows2Points.geometry.attributes.color.needsUpdate = true;
    }
    // 保存并清除边线透明度
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

    // 安全超时：如 rAF 链因任何原因中断（代际递增、崩溃、
    // 快速重渲染），强制清除 _renderInProgress 使动画循环
    // 不被永久阻塞。
    let safetyTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      safetyTimer = null;
      if (this.host._renderInProgress) {
        console.warn('[StarGraph] progressive reveal stuck — force-clearing _renderInProgress');
        this.host._renderInProgress = false;
      }
    }, 15000);

        const revealFrame = () => {
      // ponytail: 若更新的渲染已开始则退出 — 防止旧 rAF
      // 回调触碰新场景对象（鬼影点根因）。
      // 此处不触碰 _renderInProgress — 新渲染拥有该标志。
      if (this._revealGeneration !== myGen) return;
      if (this._revealCancelled) {
        if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
        this.host._renderInProgress = false;
        return;
      }
      const nodeEnd = Math.min(revealedNodes + BATCH_SIZE, totalNodes);
      // 通过 InstancedMesh.count 揭示核心
      this.host.nodeCoresInstanced.count = nodeEnd;
      this.host.nodeCoresInstanced.instanceMatrix.needsUpdate = true;
      // 恢复已揭示批次的辉光透明度
      const gCol = this.host.nodeGlowsPoints.geometry.attributes.color.array as Float32Array;
      const g2Col = this.host.nodeGlows2Points?.geometry.attributes.color?.array as Float32Array;
      for (let i = revealedNodes; i < nodeEnd; i++) {
        gCol[i * 4 + 3] = 0.75;
        if (g2Col) g2Col[i * 4 + 3] = 0.48;
      }
      this.host.nodeGlowsPoints.geometry.attributes.color.needsUpdate = true;
      if (this.host.nodeGlows2Points) this.host.nodeGlows2Points.geometry.attributes.color.needsUpdate = true;
      revealedNodes = nodeEnd;

      const edgeEnd = Math.min(revealedEdges + edgeRevealBatch, totalEdgeGroups);
      for (let i = revealedEdges; i < edgeEnd; i++) {
        const lines = this.host.edgeLineGroups[i];
        if (lines) (lines.material as LineMaterial).opacity = edgeTargetOpacities[i];
      }
      revealedEdges = edgeEnd;

      if (revealedNodes >= totalNodes && revealedEdges >= totalEdgeGroups) {
        this._revealRevealed = true;
        // ponytail: 清除 override 标志 — 揭示完成，shader 恢复动画
        this.host._overrideFlags.fill(0);
        this.host._nodes._flushOverrideAttrs();
        // ponytail: count==totalNodes 时强制重算包围球。
        this.host.nodeCoresInstanced.boundingSphere = null;
        this.host.labelsContainer.style.transition = 'opacity 0.4s ease-in';
        this.host.labelsContainer.style.opacity = '1';
        setTimeout(() => {
          this.host.labelsContainer.style.transition = '';
        }, 500);
        // ponytail: 渐进揭示完成后解除动画循环阻塞。
        // _renderInProgress 自 _renderImpl 起保持 true，防止
        // 动画循环渲染部分状态（鬼影点）。
        if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
        this.host._renderInProgress = false;
        return;
      }
      requestAnimationFrame(revealFrame);
    };
    requestAnimationFrame(revealFrame);
  }

  clearGraph(): void {
    this._revealCancelled = true; // 取消进行中的渐进揭示
    ++this._revealGeneration; // ponytail: 递增代际，使旧 rAF 回调静默退出
    // ── 显式清理：每种对象类型知道该释放什么。
    //     切勿盲目遍历 disposeGroup — nodeCoresInstanced 共享
    //     this.sphereGeo（在 constructor 中创建，跨重渲染复用）。
    //     disposeGroup 会销毁 sphereGeo 的 WebGL 缓冲，导致
    //     后续 InstancedMesh 渲染全白（冷启动 + watcher 竞争）。

    // 核心节点：仅释放材质 — sphereGeo 共享，constructor 中构建一次。
    if (this.host.nodeCoresInstanced) {
      (this.host.nodeCoresInstanced.material as THREE.Material)?.dispose();
      this.host.nodeGroup.remove(this.host.nodeCoresInstanced);
    }
    // 辉光 Points：释放几何 + 材质（每次渲染全新重建）。
    if (this.host.nodeGlowsPoints) {
      (this.host.nodeGlowsPoints.material as THREE.Material)?.dispose();
      this.host.nodeGlowsPoints.geometry?.dispose();
      disposeGlowInstanced(this.host.nodeGlowsPoints);
      this.host.nodeGroup.remove(this.host.nodeGlowsPoints);
    }
    if (this.host.nodeGlows2Points) {
      (this.host.nodeGlows2Points.material as THREE.Material)?.dispose();
      this.host.nodeGlows2Points.geometry?.dispose();
      disposeGlowInstanced(this.host.nodeGlows2Points);
      this.host.nodeGroup.remove(this.host.nodeGlows2Points);
    }
    // nodeGroup 中残留的杂散子对象（不应该有，但以防万一）。
    while (this.host.nodeGroup.children.length) {
      this.host.nodeGroup.remove(this.host.nodeGroup.children[0]);
    }

    // 边组 — 释放材质 + 几何，清除子对象。
    for (const lines of this.host.edgeLineGroups) {
      lines.geometry?.dispose();
      (lines.material as THREE.Material)?.dispose();
    }
    while (this.host.edgeGroup.children.length) this.host.edgeGroup.remove(this.host.edgeGroup.children[0]);
    while (this.host.highlightEdgeGroup.children.length)
      this.host.highlightEdgeGroup.remove(this.host.highlightEdgeGroup.children[0]);
    while (this.host._fold.commFoldGroup.children.length)
      this.host._fold.commFoldGroup.remove(this.host._fold.commFoldGroup.children[0]);

    // 遗留：edgeLineGroups 数组可能持有已释放的引用 — 清除。
    this.host.edgeLineGroups = [];
    this.host.labelsContainer.innerHTML = '';
    this.host.labelDivs = [];
    this.host.nodeLabelIdx = [];
    this.host.nodeGlowColors = [];
    this.host.nodeCoreColors = [];
    this.host._nodeCount = 0; // ponytail: 与 nodeCoreColors 保持一致 — 之前缺失，导致 hover 黑节点回归
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
    // Step 2: 清除透镜和轨迹状态
    this.host._lensActive = false;
    this.host._trailActive = false;
    this.host._highlight._clearTrailLine();
  }

  // ══════════════════════════════════════════════════════════
  // 增量图更新 — 应用 diff 而非全量重渲染
  // ══════════════════════════════════════════════════════════

  /**
   * 增量应用图 diff — 无布局重算、无相机重置、
   * 无渐进揭示。保留 hover/selected/blast/filter/diff 状态。
   * 无已有图时回退到全量 render()。
   */
  async applyGraphDiff(diff: GraphDiffJson, fullGraph: GraphJSON): Promise<void> {
    if (this.host._nodeCount === 0) {
      this.host.render(fullGraph);
      return;
    }

    // 退出折叠模式 — 增量 + 折叠视觉上不一致
    if (this.host._fold.foldMode) this.host._fold.setFoldMode(false);

    // 构建 node ID → index 映射（仅存活节点）
    const nodeIdxMap = new Map<string, number>();
    for (let i = 0; i < this.host.graphNodes.length; i++) {
      if (!this.host._deadIndices.has(i) && this.host.graphNodes[i]) nodeIdxMap.set(this.host.graphNodes[i].id, i);
    }

    const newIndices = new Set<number>(); // 跟踪哪些节点是新增的
    const neighborIndices = new Set<number>(); // 新节点的邻居

    // 1. 删除节点 → 标记为死亡
    for (const rn of diff.removed_nodes) {
      const idx = nodeIdxMap.get(rn.id);
      if (idx !== undefined) {
        this.host._nodes._markNodeDead(idx);
        nodeIdxMap.delete(rn.id);
      }
    }

    // 2. 修改节点 → 更新 kind/颜色
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

    // 3. 新增节点 → 扩展缓冲 + 追加
    if (diff.added_nodes.length > 0) {
      const needed = this.host._nodeCount + diff.added_nodes.length;
      if (needed > this.host._nodeCapacity) {
        this.host._nodes._rebuildNodeBuffers(Math.ceil(needed * 1.2));
      }
      this.host._nodes._appendNodes(diff.added_nodes, fullGraph, nodeIdxMap);
      // 跟踪新索引
      for (const n of diff.added_nodes) {
        const idx = nodeIdxMap.get(n.id);
        if (idx !== undefined) newIndices.add(idx);
      }
    }

    // 4. 如有变化则重建边 — 重建 edgeDataList、neighborMap、edgeIndexOf
    if (diff.added_edges.length > 0 || diff.removed_edges.length > 0) {
      this.host._edges._rebuildEdgeData(fullGraph, nodeIdxMap);
    }

    // 5. 收集邻居索引用于局部布局松弛
    for (const ni of newIndices) {
      for (const nb of this.host.neighborMap[ni] || []) {
        if (!newIndices.has(nb)) neighborIndices.add(nb);
      }
    }

    // 6. 局部力松弛 — 新节点 + 其邻居，
    //    邻居视为锚定（仅新节点自由移动）
    if (newIndices.size > 0) {
      const affected = new Set([...newIndices, ...neighborIndices]);
      // 从 edgeDataList 构建边对
      const allPairs: [number, number][] = this.host.edgeDataList.map((e) => [e.s, e.t]);
      try {
        await relaxNewNodes(
          this.host.nodePositions,
          this.host._nodeCount,
          allPairs,
          affected,
          neighborIndices, // 锚点：已有邻居保持固定
        );
      } catch (e) {
        console.warn('[StarGraph] local relax failed, positions may be suboptimal:', e);
      }
      // 将更新后的位置同步到 GPU 缓冲
      this.host._nodes._syncNodePositions([...affected]);
    }

    // 7. 同步所有修改节点的 GPU 核心位置
    this.host._nodes._syncNodeCoreMatrices();

    // 8. 从完整图更新社区（空数组是真值 — 分页中间页必须回退到 communities）
    const hcDiff = fullGraph.hierarchical_communities;
    this.host.communities = (Array.isArray(hcDiff) && hcDiff.length > 0 ? hcDiff : fullGraph.communities) || [];

    // 9. 清除指向死亡节点的过期交互状态
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

    // 10. 如 diff 覆盖激活则重新应用（新节点可能在 diff 集合中）
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

    // 11. 更新状态
    const aliveCount = this.host._nodeCount - this.host._deadIndices.size;
    this.host.updateStatus(aliveCount, this.host.edgeDataList.length);

    this.host._nodes._flushOverrideAttrs();
  }

  // ── 动画 ──────────────────────────────────────────────

  animate(): void {
    this.host.animId = requestAnimationFrame(() => this.animate());

    // ponytail: 限制 30fps — GTX 1060 在 2846 节点 + 6193 边上无法保持 60
    const now = performance.now();
    if (now - this._lastFrameTime < 33.33) return;
    this._lastFrameTime = now;

    // 场景重建期间跳过渲染 — 防止访问已释放的 InstancedMesh/Points
    // 几何体产生 WebGL 错误，并消除冷启动鬼影。
    if (this.host._renderInProgress) return;

    const _isMinimal = false;
    const isFull = true;
    // 自动旋转已禁用

    // 无限网格跟随相机 Y — 始终在观察者高度，限制在节点下方
    if (this.host.holoGrid) {
      const sMat = this.host.holoGrid.material as THREE.ShaderMaterial;
      sMat.uniforms.uCameraWorldPos.value.copy(this.host.camera.position);
      this.host.holoGrid.position.y = Math.min(this.host.camera.position.y, this.host.holoGridY);
    }

    if (false) {
      // ponytail: 最小模式快速路径（已禁用 — isMinimal 始终 false）
      this.host.controls.update();
      this.host.composer.render();
      return;
    }

    // ── 空闲检测：场景静止时节流高开销操作 ──
    const camMoved =
      this.host.camera.position.distanceToSquared(this._lastCamPos) > 0.0001 ||
      this.host.controls.target.distanceToSquared(this._lastCamTarget) > 0.0001;
    // ponytail: 鼠标"悬停在画布上"不算活动，坐标有变化才算。
    // 旧逻辑 mouse.x > -999 只在 pointerleave 时重置——指针静置画布
    // 会永远满帧渲染，GPU 空转烧核（CPU 100% 根因之一）。
    const mouseMoved =
      Math.abs(this.host.mouse.x - this._lastMouseX) > 1e-4 ||
      Math.abs(this.host.mouse.y - this._lastMouseY) > 1e-4;
    const isActive =
      camMoved ||
      mouseMoved ||
      this.host.hoveredIdx >= 0 ||
      this.host.focusActive ||
      this.host.focusProgress > 0 ||
      this.host._analysis.blastMode;
    if (isActive) {
      this._idleCounter = 0;
    } else {
      this._idleCounter++;
    }
    this._lastCamPos.copy(this.host.camera.position);
    this._lastCamTarget.copy(this.host.controls.target);
    this._lastMouseX = this.host.mouse.x;
    this._lastMouseY = this.host.mouse.y;
    const IDLE = this._idleCounter > 60; // 约 2 秒无活动（30fps tick）

    // ── 按需渲染（CPU 根治）：完全静止时降频到 ~5fps ──
    // 空闲场景每 6 tick 渲染一次。shader 闪烁/呼吸按真实时间驱动（uTime），
    // 低频采样肉眼无感；GPU 全屏合成负载降约 6x，不再空转。
    // 任何交互（相机/鼠标移动/悬停/聚焦/爆炸模式）→ _idleCounter 归零 →
    // 立即恢复 30fps。页面隐藏已由浏览器节流 rAF，document.hidden 兜底。
    if (document.hidden) return;
    if (IDLE && this._idleCounter % 6 !== 0) return;

    // 动画时钟按真实 tick 推进——渲染降频不影响相位（呼吸/脉冲速度恒定）
    this.host.pulseTime += 0.03 * (isFull ? 1.5 : 1);

    if (!IDLE || this._idleCounter % 4 === 0) {
      try {
        this.host._interaction.updateHover();
      } catch {
        /* hover 不得中断动画循环 */
      }
      try {
        this.host._focus.updateFocus();
      } catch {
        /* 同上 */
      }
    }

    // ── GPU 驱动辉光：time + hover uniform ──
    // Shader 处理所有动画（闪烁、波动、hsl）和 hover 增强。
    // CPU 不再为 hover 操作 _overrideFlags 或 _glowRgba。
    const galTime = performance.now() * 0.001;
    this.host.hoverScale += (this.host.targetHoverScale - this.host.hoverScale) * 0.18;
    const hIdx = this.host.hoveredIdx >= 0 && this.host.hoveredIdx < this.host._nodeCount ? this.host.hoveredIdx : -1;
    if (this.host.nodeGlowsPoints) {
      const um = (this.host.nodeGlowsPoints.material as THREE.ShaderMaterial).uniforms;
      um.uTime.value = galTime;
      um.uPulseTime.value = this.host.pulseTime;
      um.uHoveredIdx.value = hIdx;
      um.uHoverScale.value = this.host.hoverScale;
      // InstancedMesh 辉光（WebKitGTK）需要绘制缓冲高度做像素→世界换算
      if (um.uViewportH) um.uViewportH.value = this.host.renderer.domElement.height;
    }
    if (this.host.nodeGlows2Points) {
      const um = (this.host.nodeGlows2Points.material as THREE.ShaderMaterial).uniforms;
      um.uTime.value = galTime;
      um.uPulseTime.value = this.host.pulseTime;
      um.uHoveredIdx.value = hIdx;
      um.uHoverScale.value = this.host.hoverScale;
      if (um.uViewportH) um.uViewportH.value = this.host.renderer.domElement.height;
    }

    // ── Mode-driven override: blast/path/filter set once on mode change, not per-frame ──
    // ponytail: blast/path/filter 模式已调用 updateBlastNodeColors / highlightPath 等，
    // 设置每节点颜色和 override 标志。shader 保留这些直到重置。
    // 我们只需处理模式曾激活但动画循环在
    // 重置模式外节点回动画状态的情况。
    // 在 shader 驱动辉光下，无需每帧重置 — shader 动画化未覆盖的节点。

    // 星系云图呼吸 + hover ...
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
          ((glow as THREE.Mesh).material as THREE.ShaderMaterial).uniforms.uOpacity.value = beat * hoverMul;
          glow.scale.setScalar(hovered ? 1.15 : 1.0);
        }
      }
    }

    if (!IDLE || this._idleCounter % 3 === 0) {
      // ponytail: 无数据时跳过，animation loop 早于 render 执行
      if (this.host._nodeCount > 0) {
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
      } // _nodeCount > 0
    }
    this.host.controls.update();
    this.host.composer.render();
  }

  // ── 调整大小 ───────────────────────────────────────────────

  handleResize(): void {
    const w = this.host.container.clientWidth,
      h = this.host.container.clientHeight;
    if (h === 0 || w === 0) return;
    this.host.camera.aspect = w / h;
    this.host.camera.updateProjectionMatrix();
    this.host.renderer.setSize(w, h);
    this.host.composer.setSize(w, h);
    // ponytail: bloom 在 1/4 分辨率 — composer.setSize 会重置为全分辨率，需钳回
    this.host.bloomPass.resolution.set(Math.floor(w / 4), Math.floor(h / 4));
    for (const lines of this.host.edgeLineGroups) {
      (lines.material as LineMaterial).resolution.set(w, h);
    }
  }

  // ── 销毁 ──────────────────────────────────────────────

  destroy(): void {
    cancelAnimationFrame(this.host.animId);
    this.host._fold.communityRingGroup.clear();
    // 取消进行中的渐进揭示（审计：防止 destroy 后 rAF 泄漏）
    this._revealCancelled = true;
    // 清除提示自动隐藏定时器（审计：防止 destroy 后 timeout 泄漏）
    if (this.host._tooltip._promptTimer) {
      clearTimeout(this.host._tooltip._promptTimer);
      this.host._tooltip._promptTimer = null;
    }
    window.removeEventListener('resize', this.host.onResize);
    // 取消订阅 EventBus 处理器（审计：防止过期 bus 监听器）
    if (this.host._langHandler) {
      bus.off('lang:changed', this.host._langHandler);
      this.host._langHandler = null;
    }
    // 释放所有 GPU 资源
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
    // 释放 InstancedMesh 核心 + 辉光
    if (this.host.nodeCoresInstanced) {
      (this.host.nodeCoresInstanced.material as THREE.Material)?.dispose();
    }
    if (this.host.nodeGlowsPoints) {
      (this.host.nodeGlowsPoints.material as THREE.Material)?.dispose();
      this.host.nodeGlowsPoints.geometry?.dispose();
      disposeGlowInstanced(this.host.nodeGlowsPoints);
    }
    if (this.host.nodeGlows2Points) {
      (this.host.nodeGlows2Points.material as THREE.Material)?.dispose();
      this.host.nodeGlows2Points.geometry?.dispose();
      disposeGlowInstanced(this.host.nodeGlows2Points);
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