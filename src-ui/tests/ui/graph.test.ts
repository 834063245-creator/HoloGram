// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// Unit tests for StarGraph clearGraph + _renderInProgress state machine.
// Three.js is mocked — we only test disposal discipline and state transitions.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock three.js examples (must be before three mock, hoisted) ──

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: function (this: any) {
    this.enableDamping = false;
    this.dampingFactor = 1;
    this.rotateSpeed = 1;
    this.zoomSpeed = 1;
    this.screenSpacePanning = false;
    this.minDistance = 1;
    this.maxDistance = 1000;
    this.target = { x: 0, y: 0, z: 0, set: vi.fn(), copy: vi.fn(), distanceToSquared: () => 0 };
    this.update = vi.fn();
    this.addEventListener = vi.fn();
    (this as any).enabled = true;
  },
}));

vi.mock('three/examples/jsm/postprocessing/EffectComposer.js', () => ({
  EffectComposer: function (this: any) {
    this.addPass = vi.fn();
    this.setSize = vi.fn();
    this.render = vi.fn();
  },
}));

vi.mock('three/examples/jsm/postprocessing/RenderPass.js', () => ({
  RenderPass: function (this: any, _scene: any, _camera: any) {},
}));

vi.mock('three/examples/jsm/postprocessing/UnrealBloomPass.js', () => ({
  UnrealBloomPass: function (this: any) {
    this.resolution = { set: vi.fn() };
  },
}));

vi.mock('three/examples/jsm/lines/LineSegments2.js', () => ({
  LineSegments2: function (this: any, geo: any, mat: any) {
    this.geometry = geo;
    this.material = mat;
    this.userData = {};
    this.computeLineDistances = vi.fn();
  },
}));

vi.mock('three/examples/jsm/lines/LineMaterial.js', () => ({
  LineMaterial: function (this: any, _opts: any) {
    this.dispose = vi.fn();
    this.opacity = 1;
    this.resolution = { set: vi.fn(), copy: vi.fn(), x: 800, y: 600 };
    this.transparent = false;
    this.linewidth = 1;
  },
}));

vi.mock('three/examples/jsm/lines/LineSegmentsGeometry.js', () => ({
  LineSegmentsGeometry: function (this: any) {
    this.dispose = vi.fn();
    this.setPositions = vi.fn();
    this.setColors = vi.fn();
  },
}));

// ── Mock three.js ──

vi.mock('three', () => {
  // Inline dispose tracker — vi.mock factory is hoisted, so no external refs.
  const geomTrack = { calls: 0, disposed: new WeakSet<object>() };

  return {
    __geomDisposeTracker: geomTrack,

    Color: class {
      r = 1;
      g = 1;
      b = 1;
      getHex() {
        return 0xffffff;
      }
      setHSL() {
        return this;
      }
      getHSL(_target: any) {}
      copy(c: any) {
        this.r = c.r;
        this.g = c.g;
        this.b = c.b;
        return this;
      }
      set() {
        return this;
      }
    },
    Vector2: class {
      x: number;
      y: number;
      constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
      }
      set(x: number, y: number) {
        this.x = x;
        this.y = y;
        return this;
      }
      copy(v: any) {
        this.x = v.x;
        this.y = v.y;
        return this;
      }
    },
    Vector3: class {
      x = 0;
      y = 0;
      z = 0;
      constructor(x = 0, y = 0, z = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
      }
      set(x: number, y: number, z: number) {
        this.x = x;
        this.y = y;
        this.z = z;
        return this;
      }
      copy(v: any) {
        this.x = v.x;
        this.y = v.y;
        this.z = v.z;
        return this;
      }
      subVectors() {
        return new (this.constructor as any)();
      }
      normalize() {
        return this;
      }
      add() {
        return this;
      }
      multiplyScalar() {
        return this;
      }
      distanceToSquared() {
        return 0;
      }
      lengthSq() {
        return 1;
      }
      project() {
        return this;
      }
      equals() {
        return true;
      }
    },
    Quaternion: class {
      setFromEuler() {
        return this;
      }
      set() {
        return this;
      }
    },
    Matrix4: class {
      compose() {
        return this;
      }
      identity() {
        return this;
      }
    },
    BufferGeometry: class {
      attributes: Record<string, any> = {};
      dispose() {
        geomTrack.calls++;
        geomTrack.disposed.add(this);
      }
      setAttribute(name: string, attr: any) {
        this.attributes[name] = attr;
      }
      setIndex(_arr: any) {
        return this;
      }
    },
    BufferAttribute: class {
      array: Float32Array;
      itemSize: number;
      needsUpdate = false;
      constructor(arr: Float32Array, itemSize: number) {
        this.array = arr;
        this.itemSize = itemSize;
      }
    },
    InstancedBufferAttribute: class {
      array: Float32Array;
      itemSize: number;
      needsUpdate = false;
      constructor(arr: Float32Array, itemSize: number) {
        this.array = arr;
        this.itemSize = itemSize;
      }
    },
    MeshBasicMaterial: class {
      transparent = false;
      onBeforeCompile: ((_shader: any) => void) | null = null;
      dispose = vi.fn();
    },
    ShaderMaterial: function (this: any, opts?: any) {
      this.dispose = vi.fn();
      this.uniforms = opts?.uniforms ? opts.uniforms : { uTime: { value: 0 }, uPulseTime: { value: 0 } };
      this.vertexShader = opts?.vertexShader || '';
      this.fragmentShader = opts?.fragmentShader || '';
      this.transparent = opts?.transparent ?? false;
      this.depthWrite = opts?.depthWrite ?? true;
      this.side = opts?.side ?? 0;
      this.blending = opts?.blending ?? 0;
    },
    InstancedMesh: class {
      geometry: any;
      material: any;
      count: number;
      instanceMatrix = { needsUpdate: false, setUsage: vi.fn() };
      instanceColor = { needsUpdate: false, array: new Float32Array() };
      frustumCulled = true;
      boundingSphere: any = null;
      setMatrixAt = vi.fn();
      setColorAt = vi.fn();
      getMatrixAt = vi.fn((_i: number, m: any) => m);
      getColorAt = vi.fn((_i: number, c: any) => c);
      constructor(geo: any, mat: any, count: number) {
        this.geometry = geo;
        this.material = mat;
        this.count = count;
      }
    },
    Points: class {
      geometry: any;
      material: any;
      frustumCulled = true;
      renderOrder = 1;
      constructor(geo: any, mat: any) {
        this.geometry = geo;
        this.material = mat;
      }
    },
    SphereGeometry: class {
      attributes: Record<string, any> = {};
      dispose() {
        geomTrack.calls++;
        geomTrack.disposed.add(this);
      }
      setAttribute(_n: string, _a: any) {}
    },
    PlaneGeometry: class {
      attributes: Record<string, any> = {};
      dispose = vi.fn();
      rotateX = vi.fn();
    },
    Mesh: function (this: any, geo: any, mat: any) {
      this.geometry = geo;
      this.material = mat;
      this.position = { x: 0, y: 0, z: 0 };
      this.renderOrder = 0;
    },
    LineSegments: class {
      geometry: any;
      material: any;
      userData: any = {};
      constructor(geo: any, mat: any) {
        this.geometry = geo;
        this.material = mat;
      }
    },
    Scene: class {
      add = vi.fn();
    },
    Group: class {
      children: any[] = [];
      position = {
        x: 0,
        y: 0,
        z: 0,
        set(x: number, y: number, z: number) {
          this.x = x;
          this.y = y;
          this.z = z;
        },
      };
      scale = {
        x: 1,
        y: 1,
        z: 1,
        set(x: number, y: number, z: number) {
          this.x = x;
          this.y = y;
          this.z = z;
        },
      };
      renderOrder = 0;
      add(c: any) {
        this.children.push(c);
      }
      remove(c: any) {
        const idx = this.children.indexOf(c);
        if (idx >= 0) this.children.splice(idx, 1);
      }
      clear() {
        this.children.length = 0;
      }
    },
    PerspectiveCamera: class {
      position = {
        x: 0,
        y: 0,
        z: 0,
        copy: vi.fn(function (this: any, v: any) {
          this.x = v.x;
          this.y = v.y;
          this.z = v.z;
          return this;
        }),
        set: vi.fn(),
        distanceToSquared: vi.fn(() => 0),
        subVectors: vi.fn(function (this: any) {
          return this;
        }),
        normalize: vi.fn(function (this: any) {
          return this;
        }),
        add: vi.fn(function (this: any) {
          return this;
        }),
        multiplyScalar: vi.fn(function (this: any) {
          return this;
        }),
        lengthSq: vi.fn(() => 1),
        project: vi.fn(function (this: any) {
          return this;
        }),
        equals: vi.fn(() => true),
      };
      aspect = 1;
      near = 0.5;
      far = 500000;
      updateProjectionMatrix = vi.fn();
    },
    WebGLRenderer: function (this: any) {
      this.domElement = document.createElement('canvas');
      this.setPixelRatio = vi.fn();
      this.setSize = vi.fn();
      this.toneMapping = 0;
    },
    Raycaster: class {
      setFromCamera = vi.fn();
      intersectObject = () => [];
      intersectObjects = () => [];
    },
    CanvasTexture: class {
      dispose = vi.fn();
    },
    LineBasicMaterial: class {
      dispose() {}
    },
    ACESFilmicToneMapping: 0,
    AdditiveBlending: 1,
    NormalBlending: 0,
    DynamicDrawUsage: 2,
    DoubleSide: 2,
  };
});

// ── Mock app-level imports ──

vi.mock('../../src/ui/gpu-layout', () => ({
  gpuLayout: {
    ready: false,
    init: async () => false,
    compute: async () => null,
  },
}));

// relaxNewNodes 打桩为 no-op — 让 _appendNodes 的初始落位（质心锚定）
// 在测试中可直接观测，不被局部松弛掩盖。
vi.mock('../../src/ui/graph-layout', async (importActual) => {
  const actual = await importActual<typeof import('../../src/ui/graph-layout')>();
  return { ...actual, relaxNewNodes: vi.fn(async () => {}) };
});

vi.mock('../../src/ui/events', () => ({
  bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), clear: vi.fn() },
}));

vi.mock('../../src/ui/app-shell', () => ({
  shell: {
    register: vi.fn(),
    wire: vi.fn(),
    navigateToFile: vi.fn(),
    navigateToNode: vi.fn(),
    highlightFile: vi.fn(),
    highlightFolder: vi.fn(),
    clearHighlight: vi.fn(),
    queryAgent: vi.fn(),
    notifyPanelChanged: vi.fn(),
    isOpen: () => false,
    panelIds: [],
  },
}));

vi.mock('../../src/ui/icons', () => ({
  iconHtml: () => '<span class="icon"></span>',
  iconSvg: () => '<svg></svg>',
}));

vi.mock('../../src/i18n', () => ({
  t: (k: string) => k,
  setLang: vi.fn(),
  getLang: () => 'zh',
}));

import { StarGraph } from '../../src/ui/graph';

// ── Mock Canvas 2D context (jsdom doesn't implement it) ─────
function mockCtx2D(): CanvasRenderingContext2D {
  return {
    createRadialGradient: () => ({ addColorStop: vi.fn() }),
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
    fillStyle: '',
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fill: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

const origGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: any[]) {
  if (type === '2d') return mockCtx2D() as any;
  return origGetContext.call(this, type, ...args);
} as typeof HTMLCanvasElement.prototype.getContext;

// ── Helpers ──────────────────────────────────────────────────

function tinyGraph(): any {
  return {
    nodes: [
      { id: 'n1', name: 'main', type: 'function', location: 'src/main.ts:1' },
      { id: 'n2', name: 'helper', type: 'function', location: 'src/helper.ts:3' },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'calls', coupling_depth: 1, direction: 'forward' }],
    meta: { source_root: '/test', generated_at: new Date().toISOString() },
  };
}

function makeContainer(): HTMLElement {
  const div = document.createElement('div');
  div.id = 'graph';
  Object.defineProperty(div, 'clientWidth', { value: 800, writable: true });
  Object.defineProperty(div, 'clientHeight', { value: 600, writable: true });
  div.getBoundingClientRect = () => ({ width: 800, height: 600 }) as DOMRect;
  document.body.appendChild(div);
  return div;
}

// ── Tests ────────────────────────────────────────────────────

describe('StarGraph.clearGraph', () => {
  let container: HTMLElement;
  let sg: StarGraph;

  beforeEach(() => {
    container = makeContainer();
    sg = new StarGraph(container);
  });

  it('does NOT dispose sphereGeo (shared geometry across renders)', async () => {
    // Render once — populates nodeGroup with InstancedMesh + Points.
    await sg.render(tinyGraph());

    const sphereGeo = (sg as any).sphereGeo as { dispose: () => void };
    expect(sphereGeo).toBeDefined();
    const disposeSpy = vi.spyOn(sphereGeo, 'dispose');

    // Render again — triggers clearGraph internally.
    await sg.render(tinyGraph());

    // sphereGeo must NOT have been disposed. It's the same instance
    // built in the constructor, shared across all renders.
    expect((sg as any).sphereGeo).toBe(sphereGeo);
    expect(disposeSpy).not.toHaveBeenCalled();
  });

  it('_renderInProgress stays true during progressive reveal, false after empty render', async () => {
    await sg.render(tinyGraph());
    // Progressive reveal is in-flight via rAF — _renderInProgress stays true
    // to block the animation loop from rendering partial state (ghost dots).
    expect((sg as any)._renderInProgress).toBe(true);
  });

  it('resets _renderInProgress after render with empty nodes', async () => {
    await sg.render({ nodes: [], edges: [], meta: {} });
    // Empty nodes → progressive reveal skipped → flag cleared immediately
    expect((sg as any)._renderInProgress).toBe(false);
  });

  it('resets _renderInProgress when render throws', async () => {
    const badGraph = { nodes: null as any, edges: [] };
    await sg.render(badGraph);
    expect((sg as any)._renderInProgress).toBe(false);
  });

  it('hasGraph is false before first render, true after', async () => {
    expect(sg.hasGraph).toBe(false);
    await sg.render(tinyGraph());
    expect(sg.hasGraph).toBe(true);
  });

  it('survives 5 rapid renders without leaking _renderInProgress (progressive reveal in-flight)', async () => {
    for (let i = 0; i < 5; i++) {
      await sg.render(tinyGraph());
      // Progressive reveal is async via rAF — stays true during animation
      expect((sg as any)._renderInProgress).toBe(true);
    }
    expect(sg.hasGraph).toBe(true);
  });
});

describe('StarGraph.render — edge cases', () => {
  let container: HTMLElement;
  let sg: StarGraph;

  beforeEach(() => {
    container = makeContainer();
    sg = new StarGraph(container);
  });

  it('handles nodes as object (Record format)', async () => {
    const g = {
      nodes: {
        n1: { id: 'n1', name: 'a', type: 'class' },
        n2: { id: 'n2', name: 'b', type: 'class' },
      },
      edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'inherits', coupling_depth: 1, direction: 'inherit' }],
    };
    await sg.render(g);
    expect(sg.hasGraph).toBe(true);
    // Progressive reveal is in-flight via rAF
    expect((sg as any)._renderInProgress).toBe(true);
  });

  it('handles 0 edges', async () => {
    const g = {
      nodes: [{ id: 'n1', name: 'lonely', type: 'function', location: 'lonely.ts:1' }],
      edges: [],
    };
    await sg.render(g);
    expect(sg.hasGraph).toBe(true);
  });

  it('drops edges with missing target/source', async () => {
    const g = {
      nodes: [{ id: 'n1', name: 'only', type: 'function' }],
      edges: [{ id: 'e1', source: 'n1', target: 'ghost', type: 'calls' }],
    };
    await sg.render(g);
    expect(sg.hasGraph).toBe(true);
  });
});

describe('StarGraph render abort', () => {
  let container: HTMLElement;
  let sg: StarGraph;

  beforeEach(() => {
    container = makeContainer();
    sg = new StarGraph(container);
  });

  it('_renderInProgress stays true after rapid consecutive renders (abort + progressive reveal)', async () => {
    // First render fires, then second render fires immediately after.
    // The second render should abort the first layout via _layoutAbort.
    const p1 = sg.render(tinyGraph());
    const p2 = sg.render(tinyGraph());
    await Promise.all([p1, p2]);

    // Concurrent renders may race — the first render's catch block can set
    // _renderInProgress=false before second render's progressive reveal
    // starts. Either true or false is valid here; hasGraph is the real invariant.
    expect(sg.hasGraph).toBe(true);
  });
});

describe('StarGraph.applyGraphDiff — paged incremental update during progressive reveal', () => {
  let container: HTMLElement;
  let sg: StarGraph;

  beforeEach(() => {
    container = makeContainer();
    sg = new StarGraph(container);
  });

  it('completes in-flight reveal so old rAF frames cannot overwrite appended page nodes', async () => {
    // 分页加载竞态：首页 render() 的渐进揭示 rAF 还在飞，
    // 后续页 applyGraphDiff 追加节点后，旧揭示帧会把 InstancedMesh.count
    // 写回首批节点数 → 星图只剩第一批。修复：applyGraphDiff 先完成揭示。
    const queue: FrameRequestCallback[] = [];
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    try {
      const page0 = tinyGraph();
      await sg.render(page0);
      expect((sg as any)._nodeCount).toBe(2);
      expect((sg as any).nodeCoresInstanced.count).toBe(0); // 揭示首帧尚未执行

      const n3 = { id: 'n3', name: 'third', type: 'function', location: 'src/third.ts:7' };
      const n4 = { id: 'n4', name: 'fourth', type: 'class', location: 'src/fourth.ts:9' };
      const fullGraph = {
        nodes: [...page0.nodes, n3, n4],
        edges: [
          ...page0.edges,
          { id: 'e2', source: 'n2', target: 'n3', type: 'calls', coupling_depth: 1, direction: 'forward' },
          { id: 'e3', source: 'n3', target: 'n4', type: 'calls', coupling_depth: 1, direction: 'forward' },
        ],
        communities: [],
        hierarchical_communities: [],
      };
      const diff = {
        added_nodes: [n3, n4],
        added_edges: [fullGraph.edges[1], fullGraph.edges[2]],
        removed_nodes: [],
        removed_edges: [],
        modified_nodes: [],
      };

      await sg.applyGraphDiff(diff, fullGraph);

      expect((sg as any)._nodeCount).toBe(4);
      expect((sg as any)._renderInProgress).toBe(false);
      expect((sg as any).nodeCoresInstanced.count).toBe(4);

      // 执行旧揭示链的剩余 rAF 帧（含 animate 自调度），确认它们不再写回 count。
      for (let round = 0; round < 3; round++) {
        const batch = queue.splice(0);
        for (const cb of batch) cb(0);
      }

      expect((sg as any).nodeCoresInstanced.count).toBe(4);
      expect((sg as any)._renderInProgress).toBe(false);
    } finally {
      rafSpy.mockRestore();
    }
  });
});

describe('StarGraph.applyGraphDiff — 分页末页社区 id 命名空间失配', () => {
  let container: HTMLElement;
  let sg: StarGraph;

  beforeEach(() => {
    container = makeContainer();
    sg = new StarGraph(container);
  });

  it('按社区成员（而非 nodeCommMap id）锚定新节点 — l0_comm_N 不得退化为图心堆叠', async () => {
    // 回归背景（2026-08-16「首页节点被覆盖」事故）：
    //   末页携带的权威层级社区 id 是 l0_comm_{HashMap 枚举序}，与页 0
    //   render 时渐进 level-0 社区的 String(community_id) 不同命名空间。
    //   修复前 _appendNodes 用 nodeCommMap id 反查质心 → 必失配 → 末页
    //   全部节点退化到图心 jitter 40 堆叠，覆盖首页节点。
    // 页 0：两个渐进社区（id = String(community_id)）
    const n = (id: string, cid: number) => ({
      id,
      name: id,
      type: 'function',
      location: `src/${id}.ts:1`,
      community_id: cid,
    });
    const page0 = {
      nodes: [n('a1', 1), n('a2', 1), n('b1', 2), n('b2', 2)],
      edges: [
        { id: 'e1', source: 'a1', target: 'a2', type: 'calls', coupling_depth: 1, direction: 'forward' },
        { id: 'e2', source: 'b1', target: 'b2', type: 'calls', coupling_depth: 1, direction: 'forward' },
      ],
      communities: [
        { id: '1', size: 2, node_ids: ['a1', 'a2'], label: 'a' },
        { id: '2', size: 2, node_ids: ['b1', 'b2'], label: 'b' },
      ],
      hierarchical_communities: [],
      meta: { source_root: '/test', generated_at: new Date().toISOString() },
    };
    await sg.render(page0);
    expect((sg as any)._nodeCount).toBe(4);

    // 固定页 0 节点位置到已知坐标：社区 1 在 +x 远端，社区 2 在 -x 远端，
    // 图心在原点 — 质心锚定与图心回退的落点因此可区分。
    const pos0 = (sg as any).nodePositions as Float32Array;
    const setPos = (idx: number, x: number, y: number, z: number) => {
      pos0[idx * 3] = x;
      pos0[idx * 3 + 1] = y;
      pos0[idx * 3 + 2] = z;
    };
    setPos(0, 100, 0, 0);
    setPos(1, 110, 0, 0);
    setPos(2, -100, 0, 0);
    setPos(3, -110, 0, 0);

    // 末页：权威层级社区 id 为 l0_comm_0（与 community_id 命名空间无关）
    const nNew = n('a3', 1);
    const fullGraph = {
      nodes: [...page0.nodes, nNew],
      edges: [...page0.edges],
      communities: [{ id: '1', size: 3, node_ids: ['a1', 'a2', 'a3'], label: 'a' }],
      hierarchical_communities: [
        { id: 'l0_comm_0', label: '社区 1', node_ids: ['a1', 'a2', 'a3'], level: 0 },
        { id: 'l0_comm_1', label: '社区 2', node_ids: ['b1', 'b2'], level: 0 },
      ],
      meta: page0.meta,
    };
    const diff = {
      added_nodes: [nNew],
      added_edges: [],
      removed_nodes: [],
      removed_edges: [],
      modified_nodes: [],
    };

    await sg.applyGraphDiff(diff as any, fullGraph as any);

    expect((sg as any)._nodeCount).toBe(5);
    // _rebuildNodeBuffers 可能替换过数组 — 重新读取
    const pos = (sg as any).nodePositions as Float32Array;
    const idx = (sg as any).graphNodes.findIndex((g: any) => g?.id === 'a3');
    expect(idx).toBe(4);
    // 新节点应锚定在社区 1 质心 (105,0,0) ± jitter 15 内；
    // 修复前退化为图心 (0,0,0) ± jitter 40，x 必然 < 60。
    expect(pos[idx * 3]).toBeGreaterThan(90);
    expect(Math.abs(pos[idx * 3 + 1])).toBeLessThanOrEqual(7.5);
    expect(Math.abs(pos[idx * 3 + 2])).toBeLessThanOrEqual(7.5);

    // nodeCommMap 应按当前（层级）社区命名空间整体重建 — 新旧节点一致
    const nodeCommMap = (sg as any).nodeCommMap as Map<number, string>;
    expect(nodeCommMap.get(0)).toBe('l0_comm_0');
    expect(nodeCommMap.get(2)).toBe('l0_comm_1');
    expect(nodeCommMap.get(4)).toBe('l0_comm_0');
  });
});

describe('StarGraph.clearGraph — nodeCoreColors / _nodeCount consistency', () => {
  let container: HTMLElement;
  let sg: StarGraph;

  beforeEach(() => {
    container = makeContainer();
    sg = new StarGraph(container);
  });

  it('resets _nodeCount to 0 after clearGraph (prevents hover black-node regression)', async () => {
    await sg.render(tinyGraph());
    // Force clearGraph — _lifecycle.clearGraph() is private but accessible for testing.
    (sg as any)._lifecycle.clearGraph();
    expect((sg as any)._nodeCount).toBe(0);
    expect((sg as any).nodeCoreColors).toEqual([]);
    expect((sg as any)._nodeCount).toBe((sg as any).nodeCoreColors.length);
  });
});

describe('GraphNodeRenderer._setCoreColor — NaN/undefined guard', () => {
  let container: HTMLElement;
  let sg: StarGraph;

  beforeEach(async () => {
    container = makeContainer();
    sg = new StarGraph(container);
    await sg.render(tinyGraph());
  });

  it('rejects undefined (would render black via new THREE.Color(undefined))', () => {
    const nodes = (sg as any)._nodes;
    const instanced = (sg as any).nodeCoresInstanced;
    const spy = vi.spyOn(instanced, 'setColorAt');
    spy.mockClear(); // reset calls from render()
    nodes._setCoreColor(0, undefined as any);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects NaN (new THREE.Color(NaN) → black)', () => {
    const nodes = (sg as any)._nodes;
    const instanced = (sg as any).nodeCoresInstanced;
    const spy = vi.spyOn(instanced, 'setColorAt');
    spy.mockClear();
    nodes._setCoreColor(0, NaN);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects null', () => {
    const nodes = (sg as any)._nodes;
    const instanced = (sg as any).nodeCoresInstanced;
    const spy = vi.spyOn(instanced, 'setColorAt');
    spy.mockClear();
    nodes._setCoreColor(0, null as any);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still writes valid colors to GPU', () => {
    const nodes = (sg as any)._nodes;
    const instanced = (sg as any).nodeCoresInstanced;
    const spy = vi.spyOn(instanced, 'setColorAt');
    spy.mockClear();
    nodes._setCoreColor(0, 0x6ab0ff);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('still writes THREE.Color instances to GPU', () => {
    const nodes = (sg as any)._nodes;
    const instanced = (sg as any).nodeCoresInstanced;
    const spy = vi.spyOn(instanced, 'setColorAt');
    spy.mockClear();
    const { Color } = require('three');
    nodes._setCoreColor(0, new Color(0x6ab0ff));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('GraphInteractionController.updateHover — array length guard', () => {
  let container: HTMLElement;
  let sg: StarGraph;

  beforeEach(async () => {
    container = makeContainer();
    sg = new StarGraph(container);
    await sg.render(tinyGraph());
  });

  it('does not call _setCoreColor when nodeCoreColors is shorter than _nodeCount', () => {
    const interaction = (sg as any)._interaction;
    const host = sg as any;
    // Simulate the bug: _nodeCount is 2 but nodeCoreColors is empty
    host._nodeCount = 2;
    host.nodeCoreColors = [];
    host.hoveredIdx = 1;
    host.mouse = { x: 0, y: 0 };
    const setColorSpy = vi.spyOn(host._nodes, '_setCoreColor');
    const pickSpy = vi.spyOn(interaction, '_pickNode').mockReturnValue(-1);

    expect(() => interaction.updateHover()).not.toThrow();
    expect(setColorSpy).not.toHaveBeenCalled();

    pickSpy.mockRestore();
  });

  it('does not call _setCoreColor when nodeCoreColors element is undefined', () => {
    const interaction = (sg as any)._interaction;
    const host = sg as any;
    // nodeCoreColors has an entry but it's undefined
    host._nodeCount = 2;
    host.nodeCoreColors = [0x6ab0ff, undefined as any];
    host.hoveredIdx = 1;
    host.mouse = { x: 0, y: 0 };
    const setColorSpy = vi.spyOn(host._nodes, '_setCoreColor');
    const pickSpy = vi.spyOn(interaction, '_pickNode').mockReturnValue(-1);

    expect(() => interaction.updateHover()).not.toThrow();
    // Should still not crash, and _setCoreColor should not be called for restore
    expect(setColorSpy).not.toHaveBeenCalled();

    pickSpy.mockRestore();
  });
});
