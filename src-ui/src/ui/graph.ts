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
  private galaxyGroup = new THREE.Group(); // 全模式旋转的父容器
  private nodeGroup = new THREE.Group();
  private edgeGroup = new THREE.Group();
  private highlightEdgeGroup = new THREE.Group();
  private legendEl!: HTMLDivElement;
  private glowTex: THREE.Texture;

  // 图数据
  private graphNodes: GraphNode[] = [];
  private edgeDataList: EdgeData[] = [];
  private _nodeCount = 0;
  private _deadIndices: Set<number> = new Set(); // ponytail: 死亡节点索引（已删除但保留以维持索引稳定）
  private hoveredIdx = -1;

  // 标签
  private labelsContainer!: HTMLDivElement;

  // 聚焦子图（详情卡片按钮触发）
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

  // Blast + Path — 委托给 GraphAnalysis
  private _analysis: GraphAnalysis;

  // ── 社区 / 星系折叠覆盖 ──────────────────────
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

  // 后处理（仅全模式）
  private composer!: EffectComposer;
  private bloomPass!: UnrealBloomPass;

  // 可复用几何
  sphereGeo!: THREE.SphereGeometry;
  private _labels!: GraphLabelSystem;
  private _edges!: GraphEdgeRenderer;
  raycaster!: THREE.Raycaster;

  // ponytail: 生产构建时 constructor 内 handleResize/setupHover 先于
  // render 执行，这些字段在渲染时才赋值。显式初始化为安全值防崩。
  mouse = new THREE.Vector2();
  edgeLineGroups: LineSegments2[] = [];
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

  // 星云 + 全息网格
  private nebulaDust!: THREE.Points;
  nebulaPhases: number[] | null = null;
  holoGrid: THREE.Mesh | null = null;
  holoGridY = 0;

  // 动画
  private pulseTime = 0;

  constructor(container: HTMLElement) {
    this.container = container;

    const bg = false ? 0x000005 : BG_COLOR;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(bg);
    // 无雾 — 深空渲染通过对比度而非距离模糊处理深度

    this.camera = new THREE.PerspectiveCamera(40, 2, 0.5, 500000); // 布局后放宽 near/far

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.4;
    container.appendChild(this.renderer.domElement);

    // WebKitGTK GPU 进程崩溃后上下文不会自动恢复 — 盖层提示，避免画布永久黑屏
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (container.querySelector('.gl-fallback')) return;
      const tip = document.createElement('div');
      tip.className = 'gl-fallback';
      tip.textContent = '图形上下文已丢失（WebGL context lost）— 请重新加载窗口';
      container.appendChild(tip);
    });

    // 窗口跨屏移动（HiDPI↔普通屏）时 DPR 变化不触发 resize — 监听并重设，否则画布发虚
    this.watchDpr();

    // ── 后处理管线 ──
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // ponytail: bloom 在 1/4 分辨率 — 4K pixelRatio=2 下全分辨率 bloom
    // 约 1600 万像素 × 5 次模糊 = GPU 杀手。四分之一分辨率解决。
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.floor(container.clientWidth / 4), Math.floor(container.clientHeight / 4)),
      0.35, // 强度 — 低默认值，明亮物体在 hover 时仍有 bloom
      0.3, // 半径 — 紧凑 bloom，无全局辉光雾
      0.85, // 阈值 — 仅明亮物体有 bloom（hover 高亮）
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
    this.controls.dampingFactor = 0.15; // 快速停止
    this.controls.rotateSpeed = 0.5; // 减半 — 无甩鞭
    this.controls.zoomSpeed = 1.0; // 灵敏缩放
    this.controls.screenSpacePanning = true; // 右键拖拽平移 = 重新居中轨道目标
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

    // 星场已禁用
    // if (true) this.buildStarfield();
    // 星云尘埃已禁用
    // if (mode === 'full') this.buildNebulaDust();

    // 全息网格已移除 — 自然 3D 星场不需要地面

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

    // 标签容器（非最小模式 — 但始终创建，通过 CSS 隐藏）
    this.labelsContainer = document.createElement('div');
    this.labelsContainer.id = 'graph-labels';
    if (false) this.labelsContainer.style.display = 'none';
    this.container.appendChild(this.labelsContainer);

    this.buildLegend();
    this._focus.buildFocusBanner();

    // 语言变更时重建图例 + 聚焦横幅
    this._langHandler = ({ lang }: { lang: string }) => {
      setLang(lang as 'zh' | 'en');
      // 重建前移除旧 DOM 元素
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
        // 在聚焦模式下刷新聚焦横幅文本
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
    // 阻止画布上的浏览器右键菜单
    canvas.addEventListener('contextmenu', (e: Event) => e.preventDefault());

    this.onResize();
    window.addEventListener('resize', this.onResize);
    this._lifecycle.animate();

    // 启动 WebGPU 计算管线初始化（非阻塞）
    gpuLayout
      .init()
      .then((ready) => {
        if (ready) console.log('[StarGraph] GPU layout ready');
      })
      .catch(() => {
        /* GPU 初始化失败非关键；使用 CPU 回退 */
      });
  }

  // ── 星场 ────────────────────────────────────────────

  // ── 星云尘埃 → graph-scene.ts ──

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

  // ── 路径查找 — 委托给 GraphAnalysis ──────────────

  // ── i18n ──
  private _langHandler: ((data: { lang: string }) => void) | null = null;

  // ── Step 3: Alt+拖拽矩形选择 → graph-tooltip.ts ──

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

  /** 按名称模糊查找节点的数组索引。未找到返回 -1。 */
  private _findNodeIndexByName(query: string): number {
    return this._highlight._findNodeIndexByName(query);
  }

  // ── 相机 / 聚焦公共 API → graph-focus-controller ─────

  /** 将相机重置到默认概览位置，带平滑动画。 */
  resetCamera(): void {
    this._focus.resetCamera();
  }

  /** 返回所有可见节点名称，用于自动补全 / 搜索。 */
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

  // ── 高亮 / 过滤 / 透镜 / 轨迹 → graph-highlight ────

  /** 高亮属于某个文件的所有节点（按位置前缀匹配）。 */
  highlightFile(filePath: string): void {
    this._highlight.highlightFile(filePath);
  }

  /** 高亮某个目录下的所有节点（递归前缀匹配）。 */
  highlightFolder(folderPath: string): void {
    this._highlight.highlightFolder(folderPath);
  }

  clearFileHighlight(): void {
    this._highlight.clearFileHighlight();
  }

  /** 仅高亮一种边类型，其余调暗。null = 清除过滤。 */
  setEdgeTypeFilter(edgeType: string | null): void {
    this._highlight.setEdgeTypeFilter(edgeType);
  }

  /** 调暗所有不匹配类型过滤的节点。null = 清除。 */
  setNodeKindFilter(filter: string | null): void {
    this._highlight.setNodeKindFilter(filter);
  }

  /** 按名称高亮一组节点（模糊匹配）。匹配的节点以指定颜色发光；其余调暗。 */
  highlightNodeNames(names: string[], colorHex?: string): void {
    this._highlight.highlightNodeNames(names, colorHex);
  }

  /** 清除所有 Agent 触发的高亮（路径 + 节点高亮）。 */
  clearAgentHighlight(): void {
    this._highlight.clearAgentHighlight();
  }

  /** 按热点文件为节点着色，强度与 L4 复发次数成正比。 */
  highlightHotspots(hotspots: Array<{ file: string; count: number }>): void {
    this._highlight.highlightHotspots(hotspots);
  }

  clearHotspots(): void {
    this._highlight.clearHotspots();
  }

  /** 将不匹配给定名称的所有节点调暗至 1% 透明度。 */
  setAgentLens(nodeNames: Set<string>): void {
    this._highlight.setAgentLens(nodeNames);
  }

  /** 从 agent 透镜模式恢复正常渲染。 */
  clearAgentLens(): void {
    this._highlight.clearAgentLens();
  }

  /** 激活回溯轨迹模式：高亮所有已访问节点，其余调暗
   *  至 30%（非 2.5% — 仍可见，只是作为背景），绘制一条粗发光
   *  轨迹线穿过探索序列，并将相机飞向质心。 */
  showAgentTrail(visitedNames: Set<string>, trailNames: string[]): void {
    this._highlight.showAgentTrail(visitedNames, trailNames);
  }

  /** 从轨迹模式恢复正常渲染。 */
  hideAgentTrail(): void {
    this._highlight.hideAgentTrail();
  }

  get isTrailActive(): boolean {
    return this._trailActive;
  }

  // ══════════════════════════════════════════════════════════
  // 社区 / 星系折叠覆盖 — 委托给 GraphFold
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

  // ── Diff 覆盖 → graph-diff-overlay ─────────────────────

  /** 应用 diff 着色：绿色=新增，红色=删除，橙色=修改。 */
  showDiff(diffJson: {
    added_nodes?: Array<{ id: string }>;
    removed_nodes?: Array<{ id: string }>;
    modified_nodes?: Array<{ node_id: string }>;
  }): void {
    this._diffOverlay.showDiff(diffJson);
  }

  /** 移除 diff 着色，恢复正常颜色。 */
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
   * 增量应用图 diff — 无布局重算、无相机重置、
   * 无渐进揭示。保留 hover/selected/blast/filter/diff 状态。
   * 无已有图时回退到全量 render()。
   */
  async applyGraphDiff(diff: GraphDiffJson, fullGraph: GraphJSON): Promise<void> {
    return this._lifecycle.applyGraphDiff(diff, fullGraph);
  }

  // ── 渲染 ───────────────────────────────────────────────
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
        /* 尽力而为 */
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

  // ── 聚焦子图（详情卡片按钮触发）────────────
  private enterFocusSubgraph(idx: number): void {
    this._focus.enterFocusSubgraph(idx);
  }

  exitFocusSubgraph(): void {
    this._focus.exitFocusSubgraph();
  }

  /** 处理 Escape 键（由 escLayer 统一调度）。返回 true 表示已消费，不再继续冒泡。 */
  handleEscape(): boolean {
    if (this.focusSubgraphActive) {
      this.exitFocusSubgraph();
      return true;
    }
    if (this._tooltip._promptBarEl?.style.display === 'flex') {
      this._tooltip._hidePrompt();
      return true;
    }
    if (this._fold.enteredSubCommunityId) {
      this._fold.exitSubCommunity();
      return true;
    }
    if (this._fold.enteredGalaxyId) {
      this._fold.exitGalaxy();
      return true;
    }
    if (this._fold.foldMode) {
      this._fold.setFoldMode(false);
      return true;
    }
    if (this._analysis.blastMode) {
      this._analysis.exitBlastMode();
      return true;
    }
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

  // ── 状态 ───────────────────────────────────────────────

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

  // ── 调整大小 ───────────────────────────────────────────────

  /** 公共 resize — 在 CSS 布局变化后调用（如 --font-scale、--toolbar-h）*/
  resize(): void {
    this.onResize();
  }

  // DPR 监听：matchMedia 的 resolution query 一次性失效，变化后按新 DPR 重挂
  private watchDpr(): void {
    // jsdom 等非完整浏览器环境没有 matchMedia —— 跳过监听，渲染本身不受影响
    if (typeof matchMedia !== 'function') return;
    const q = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    q.addEventListener(
      'change',
      () => {
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.onResize();
        this.watchDpr();
      },
      { once: true },
    );
  }

  private onResize = (): void => {
    this._lifecycle.handleResize();
  };

  // ── 销毁 ──────────────────────────────────────────────

  destroy(): void {
    this._lifecycle.destroy();
  }
}
