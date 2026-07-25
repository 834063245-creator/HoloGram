# 星图节点/边配色辨识度修复方案

> 给执行模型：本方案每处改动都给出 **文件:行号** + **当前代码** + **替换代码**。
> 严格按顺序执行。不要改方案外的代码。不加注释（除 `// ponytail:` 标记），保持原文件缩进（2 空格）。
> 路径前缀 `graph.ts` = `src-ui/src/ui/graph.ts`，`i18n.ts` = `src-ui/src/i18n.ts`。
> Three.js 版本：0.184.0（含 Line2/LineMaterial fat-line 支持）。

---

## 问题诊断（执行模型必读）

**节点**：`graph.ts:42-51` 的 NODE_COLORS 中，8 种代码符号（symbol/function/method/class/module/interface/variable/constant）色相全是 210°，明度差仅 7%，星空黑底+发光晕下肉眼无法区分。实际只呈现 3 大色系：代码(蓝)/存储(金)/时序(紫)。

**边**：`graph.ts:63-82` `edgeColorByType` 三个问题叠加：
1. 撞色 — triggers/awaits/sequences 三种时间边同色(0xffaa55)；imports/defines/calls 三种结构边色相 204-215° 无法区分；shares(30°)与 temporal(32°) 几乎同色。10 种边实际可见 ≈ 4-5 色。
2. 透明度抹杀颜色 — `edgeOpacityByDepth`(83-86) 把 opacity 压到 0.004~0.022（m=0.10），任何色相差异肉眼不可见。
3. 粗细维度从未工作 — 代码用 `LineSegments`+`LineBasicMaterial`，WebGL 下线宽固定 1px，`linewidth` 无效。

---

## 修复总览

| 档 | 内容 | 改动 |
|---|---|---|
| A | 节点配色：8 种代码符号各分色相 + 存储/时序子类型区分 | graph.ts 调色板表 |
| B | 边配色：10 种边 10 个真正不同色相 + 提高基础透明度 | graph.ts 边色函数 |
| C | 边粗细：换 Line2/LineMaterial 让线宽生效（按耦合深度分层） | graph.ts 边几何重建 |
| D | 图例升级为可点击筛选器（点一类边只高亮该类） | graph.ts 图例 + 筛选逻辑 |
| E | 小地图边色 + i18n 同步 | graph.ts minimap, i18n.ts |

执行顺序 **A→B→C→D→E**。A/B 是纯数据替换零风险；C 改几何需测试；D/E 收尾。
若想最小改动先看效果，只做 **A+B** 就能解决"颜色太少"的核心诉求（C 的粗线和 D 的筛选是增强）。

---

## A 档 — 节点配色（8 符号分色相 + 子类型区分）

### 设计原则
- 8 种代码符号在色相环上均匀分布（每 ~30°一档），保证可区分。
- 存储媒介(file/database/cache/queue)共用金系但明度递减区分。
- 时序(thread/timer/trigger)共用紫系但明度递减区分。
- glow(外晕)用更深的同色相，core(核心)在 full 模式下保持彩色（不再统一白心），让节点颜色真正可见。

### A1. 替换 NODE_COLORS 和 GLOW_COLORS

**位置** `graph.ts:42-61`。

当前：
```ts
const NODE_COLORS: Record<string, number> = {
  symbol: 0x7eb8ff, SYMBOL: 0x7eb8ff,
  function: 0x8ec8ff, method: 0x8ec8ff,
  class: 0x6aadff, module: 0x7eb8ff,
  interface: 0x7eb8ff, variable: 0x94d0ff, constant: 0x94d0ff,
  medium: 0xf0c060, MEDIUM: 0xf0c060,
  file: 0xf0c060, database: 0xe8b84c, cache: 0xe8b84c, queue: 0xe8b84c,
  temporal: 0xc098ff, TEMPORAL: 0xc098ff,
  thread: 0xc098ff, timer: 0xb888f8, trigger: 0xb888f8,
};
const GLOW_COLORS: Record<string, number> = {
  symbol: 0x4488cc, SYMBOL: 0x4488cc,
  function: 0x4499dd, method: 0x4499dd,
  class: 0x3377bb, module: 0x4488cc,
  interface: 0x4488cc, variable: 0x55aadd, constant: 0x55aadd,
  medium: 0xcc8800, MEDIUM: 0xcc8800,
  file: 0xcc8800, database: 0xbb7700, cache: 0xbb7700, queue: 0xbb7700,
  temporal: 0x8855cc, TEMPORAL: 0x8855cc,
  thread: 0x8855cc, timer: 0x7744bb, trigger: 0x7744bb,
};
```

替换为：
```ts
// ponytail: 8 代码符号色相均分(210/180/150/120/90/60/30/0°)，存储金系明度递减，时序紫系明度递减
const NODE_COLORS: Record<string, number> = {
  symbol: 0x6ab0ff, SYMBOL: 0x6ab0ff,     // 210° 蓝 — 通用符号
  function: 0x4ad8c8, FUNCTION: 0x4ad8c8, // 175° 青 — 函数
  method: 0x4ad8c8, METHOD: 0x4ad8c8,     // 175° 青 — 方法(同函数，method 是 function 的类内变体)
  class: 0x7fd84a, CLASS: 0x7fd84a,       // 105° 绿 — 类
  module: 0xd8d84a, MODULE: 0xd8d84a,     // 60°  黄 — 模块
  interface: 0xf0a850, INTERFACE: 0xf0a850, // 30° 橙 — 接口
  variable: 0xf07070, VARIABLE: 0xf07070, // 0°   红 — 变量
  constant: 0xd850b0, CONSTANT: 0xd850b0, // 320° 品红 — 常量
  medium: 0xf0c060, MEDIUM: 0xf0c060,
  file: 0xf0c060, FILE: 0xf0c060,         // 40° 金
  database: 0xe0a040, DATABASE: 0xe0a040, // 35° 暗金
  cache: 0xd09030, CACHE: 0xd09030,       // 30° 更暗
  queue: 0xc08020, QUEUE: 0xc08020,       // 25° 最暗
  temporal: 0xc098ff, TEMPORAL: 0xc098ff,
  thread: 0xc098ff, THREAD: 0xc098ff,     // 270° 紫
  timer: 0xa880ff, TIMER: 0xa880ff,       // 260° 蓝紫
  trigger: 0x9068ff, TRIGGER: 0x9068ff,   // 250° 更蓝紫
};
const GLOW_COLORS: Record<string, number> = {
  symbol: 0x2a6acc, SYMBOL: 0x2a6acc,
  function: 0x1a9888, FUNCTION: 0x1a9888,
  method: 0x1a9888, METHOD: 0x1a9888,
  class: 0x4a982a, CLASS: 0x4a982a,
  module: 0x98982a, MODULE: 0x98982a,
  interface: 0xc07028, INTERFACE: 0xc07028,
  variable: 0xc03838, VARIABLE: 0xc03838,
  constant: 0x983070, CONSTANT: 0x983070,
  medium: 0xcc8800, MEDIUM: 0xcc8800,
  file: 0xcc8800, FILE: 0xcc8800,
  database: 0xb07000, DATABASE: 0xb07000,
  cache: 0x905800, CACHE: 0x905800,
  queue: 0x704000, QUEUE: 0x704000,
  temporal: 0x7855cc, TEMPORAL: 0x7855cc,
  thread: 0x7855cc, THREAD: 0x7855cc,
  timer: 0x6040bb, TIMER: 0x6040bb,
  trigger: 0x4830aa, TRIGGER: 0x4830aa,
};
```

> 色相分布：symbol 210° / function·method 175° / class 105° / module 60° / interface 30° / variable 0° / constant 320°。method 复用 function 的色相（语义上 method 就是类内 function，强行分两色反而增加认知负担；用 `MTH` 缩写标签区分）。

### A2. full 模式核心保持彩色（不再白心）

当前 full 模式核心统一白色，节点颜色只在外晕可见，辨识度被发光稀释。

**位置** `graph.ts:4168`。

当前：
```ts
      const coreColor = isFull ? glowColor : (NODE_COLORS[kind] || 0x7eb8ff); // dark-universe: type-colored core, white-hot only on hover
```

替换为：
```ts
      const coreColor = NODE_COLORS[kind] || 0x6ab0ff;
```

> 核心(nodeCores)用 NODE_COLORS 的亮色，外晕(nodeGlows)用 GLOW_COLORS 的深色，形成"亮心+深晕"对比，节点类型一眼可辨。hover/选中时核心变白的逻辑在别处(`_setCoreColor` hover 分支)保留不动。

**位置** `graph.ts:2799`（`clearDiff` 里的同样模式）。

当前：
```ts
        const coreColor = isFull ? 0xffffff : (NODE_COLORS[kind] || 0x7eb8ff);
```

替换为：
```ts
        const coreColor = NODE_COLORS[kind] || 0x6ab0ff;
```

**位置** `graph.ts:2281`（`recolorByMode` type 模式分支）。

当前：
```ts
        coreColor = isFull ? 0xffffff : (NODE_COLORS[kind] || 0x7eb8ff);
        glowColor = GLOW_COLORS[kind] || 0x4488cc;
```

替换为：
```ts
        coreColor = NODE_COLORS[kind] || 0x6ab0ff;
        glowColor = GLOW_COLORS[kind] || 0x2a6acc;
```

### A 档验证

```powershell
cd src-ui; npx tsc --noEmit
```
运行后看星图：8 种代码符号应呈现蓝/青/绿/黄/橙/红/品红不同色相；存储节点金黄系、时序节点紫系，子类型明度递减可辨。

---

## B 档 — 边配色（10 种边 10 色相 + 提高基础透明度）

### 设计原则
- 10 种边各给独立色相，HSL 均分覆盖全色环，相邻类型色相拉开 ≥30°。
- 语义聚类：结构边(inherits/calls/imports/defines)偏冷色，数据边(reads/writes/shares)偏暖色，时间边(triggers/awaits/sequences)用紫橙区分。
- 基础透明度从 m=0.10 提到 0.40，让默认状态下颜色就可见（仍保持暗淡不喧宾夺主）。
- 耦合深度仍影响透明度（L1 最淡 L4 最浓），但乘数提高。

### B1. 替换 edgeColorByType

**位置** `graph.ts:63-82`。

当前：
```ts
function edgeColorByType(edgeType: string, direction: string, crossFile = false): THREE.Color {
  const et = edgeType.toLowerCase();
  // Data edges — green read, red write, amber share
  if (et === 'reads') return new THREE.Color(0x66dd66);
  if (et === 'writes') return new THREE.Color(0xff7777);
  if (et === 'shares') return new THREE.Color(0xffaa44);
  // Temporal edges — orange
  if (et === 'triggers' || et === 'awaits' || et === 'sequences') return new THREE.Color(0xffaa55);
  // Backward-compat: old Python engine keywords
  if (et === 'data') return direction === 'write' ? new THREE.Color(0xff7777) : new THREE.Color(0x66dd66);
  if (et === 'temporal') return new THREE.Color(0xffaa55);
  // Inheritance — magenta
  if (et === 'inherits' || (crossFile && direction === 'inherit')) return new THREE.Color(0xff66ff);
  // Imports — subtle teal-blue
  if (et === 'imports') return new THREE.Color(0x5599cc);
  // Defines — slightly brighter blue
  if (et === 'defines') return new THREE.Color(0x5588cc);
  // Calls and everything else — structural blue
  return new THREE.Color(0x6699cc);
}
```

替换为：
```ts
// ponytail: 10 边各独立色相 — 结构系冷色, 数据系暖色, 时序系紫橙; 旧引擎 data/temporal 兼容映射
const _EDGE_COLORS: Record<string, number> = {
  calls: 0x4a9adf,       // 210° 蓝
  imports: 0x4adfdf,     // 180° 青
  defines: 0x4adf8a,     // 150° 青绿
  inherits: 0xff66dd,    // 315° 品红
  reads: 0x66dd66,       // 120° 绿
  writes: 0xff5566,      // 355° 红
  shares: 0xffaa44,      // 35° 橙
  triggers: 0xff8833,    // 22° 橙红
  awaits: 0xc068ff,      // 280° 紫
  sequences: 0x8866ff,   // 250° 蓝紫
  data: 0xff5566,        // 兼容旧引擎: 按方向覆盖见下
  temporal: 0xff8833,
  structural: 0x4a9adf,
};
function edgeColorByType(edgeType: string, direction: string, crossFile = false): THREE.Color {
  const et = edgeType.toLowerCase();
  if (et === 'data') return new THREE.Color(direction === 'write' ? _EDGE_COLORS.writes : _EDGE_COLORS.reads);
  if (et === 'structural') return new THREE.Color(_EDGE_COLORS.calls);
  if (et === 'inherits' || (crossFile && direction === 'inherit')) return new THREE.Color(_EDGE_COLORS.inherits);
  const hex = _EDGE_COLORS[et] ?? _EDGE_COLORS.calls;
  return new THREE.Color(hex);
}
```

> 色相表：calls 210 / imports 180 / defines 150 / inherits 315 / reads 120 / writes 355 / shares 35 / triggers 22 / awaits 280 / sequences 250。每对相邻 ≥25°，10 种边 10 个真正不同颜色。`_EDGE_COLORS` 表也供 D 档图例和筛选复用。

### B2. 默认透明度保持低（总览清爽）—— 不提高

**位置** `graph.ts:83-86`：**不改，保持 m=0.10**。

> **为什么不能提高**：总览视角下全量边（数千~数万条）叠加 `AdditiveBlending`，透明度一旦提到 0.04+ 就过曝成毛线团，整个图没法看。总览要看的是社区结构和节点分布，不是单条边。
>
> **颜色辨识策略**：默认边保持极淡（m=0.10，0.004~0.022，只看到结构骨架）；颜色在**交互时**才显现 —— hover/focus 临时高亮边提亮（见 B3），D 档筛选时选中类提亮。这样总览清爽，聚焦时颜色鲜明。这是"总览看结构、聚焦看类型"的正确分工。

### B3. hover/focus 高亮边提亮（补偿默认低透明度）

默认边极淡，hover 时必须提亮到能看清颜色。当前 hover 临时高亮边 opacity 偏低（0.30~0.35），提到 0.6。

**位置 1** `graph.ts:1984`，当前：
```ts
          this.highlightEdgeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending })));
```
替换 `opacity: 0.35` → `opacity: 0.6`：
```ts
          this.highlightEdgeGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending })));
```

**位置 2** `graph.ts:2003`，同样 `opacity: 0.35` → `opacity: 0.6`。

**位置 3** `graph.ts:2111`，当前 `opacity: 0.30` → `opacity: 0.6`。

> hover 节点时其关联边 opacity 0.6，B1 的 10 种边色相在此时一眼可辨。这是默认低透明度下保证辨识度的关键补偿 —— 不动默认值，只在交互时让颜色"亮出来"。
>
> `graph.ts:2611` 的 agent trail（opacity 0.6）和 `2962/3376/3549/4380` 的 fold/path 高亮边保持原样，不在这轮改。

### B 档验证

```powershell
npx tsc --noEmit
```
运行后验证：
- **总览**：边极淡，只看到结构骨架，**不**过曝成毛线团（和改前一样清爽）。
- **hover 节点**：该节点关联边提亮到 0.6，10 种边色相一眼可辨（结构蓝/数据绿红橙/时序紫橙红）。
- 如果 hover 时颜色仍不够鲜明，把 B3 的 0.6 调到 0.7；如果太刺眼调到 0.5。**不要**调 B2 的默认 m。

---

## C 档 — 边粗细（Line2 fat lines，按耦合深度分层）

> **风险提示**：C 档改边几何构建，是本方案唯一有回归风险的档。如果只想解决"颜色辨识度"，A+B 已足够，C 可跳过。Line2 性能比 LineSegments 略低（多一次屏幕空间线段几何着色），边数 >2万时需测试帧率。

### 设计
- 用 `Line2`+`LineMaterial` 替代 `LineSegments`+`LineBasicMaterial`，支持 `linewidth`（屏幕像素）。
- 线宽按耦合深度分层：L1=1.0px / L2=1.4px / L3=1.8px / L4=2.4px。L4 穿透边最粗最显眼。
- 需要从 `three/examples/jsm/lines/` 导入 `Line2`/`LineLineGeometry`/`LineMaterial`。

### C1. 导入 Line2 模块

**位置** `graph.ts` 顶部 import 区（搜索现有 `import * as THREE` 行，在其后加）。

在主 import 行之后追加：
```ts
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
```

> three 0.184 的 jsm 路径用 `.js` 后缀。若 tsc 报找不到模块，改成 `three/examples/jsm/lines/Line2`（去 .js），或确认 `src-ui/node_modules/three/examples/jsm/lines/` 目录存在。

### C2. 边线宽函数

在 `edgeOpacityByDepth` 函数（B2 改后）之后追加：
```ts
function edgeWidthByDepth(depth: number): number {
  switch (depth) { case 1: return 1.0; case 2: return 1.4; case 3: return 1.8; case 4: return 2.4; default: return 1.2; }
}
```

### C3. 改 edgeLineGroups 类型与 buildEdges

**位置** `graph.ts:758`。

当前：
```ts
  private edgeLineGroups: THREE.LineSegments[] = [];
```

替换为：
```ts
  private edgeLineGroups: Line2[] = [];
```

**位置** `graph.ts:4133-4159`，整段 `buildEdges` 替换。

当前：
```ts
  private buildEdges(pos: Float32Array, data: EdgeData[]): void {
    if (data.length === 0) return;
    const key = (d: EdgeData) => `${d.edgeType}:${d.direction}:${d.couplingDepth}:${d.crossFile ? 1 : 0}`;
    const groups = new Map<string, { verts: number[]; colors: number[]; depth: number; crossFile: boolean }>();
    for (const d of data) {
      const k = key(d);
      if (!groups.has(k)) { const c = edgeColorByType(d.edgeType, d.direction, d.crossFile); groups.set(k, { verts: [], colors: [], depth: d.couplingDepth, crossFile: d.crossFile }); }
      const g = groups.get(k)!;
      g.verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
      const c = edgeColorByType(d.edgeType, d.direction, d.crossFile);
      g.colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    for (const [, g] of groups) {
      const B = 2000;
      for (let b = 0; b < g.verts.length; b += B * 6) {
        const v = g.verts.slice(b, b + B * 6), cl = g.colors.slice(b, b + B * 6);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(cl, 3));
        const opacity = edgeOpacityByDepth(g.depth);
        const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
        const lines = new THREE.LineSegments(geo, mat);
        lines.userData['edgeDepth'] = g.depth;
        this.edgeGroup.add(lines); this.edgeLineGroups.push(lines);
      }
    }
  }
```

替换为：
```ts
  private buildEdges(pos: Float32Array, data: EdgeData[]): void {
    if (data.length === 0) return;
    const key = (d: EdgeData) => `${d.edgeType}:${d.direction}:${d.couplingDepth}:${d.crossFile ? 1 : 0}`;
    const groups = new Map<string, { verts: number[]; colors: number[]; depth: number; crossFile: boolean }>();
    for (const d of data) {
      const k = key(d);
      if (!groups.has(k)) { groups.set(k, { verts: [], colors: [], depth: d.couplingDepth, crossFile: d.crossFile }); }
      const g = groups.get(k)!;
      g.verts.push(pos[d.s * 3], pos[d.s * 3 + 1], pos[d.s * 3 + 2], pos[d.t * 3], pos[d.t * 3 + 1], pos[d.t * 3 + 2]);
      const c = edgeColorByType(d.edgeType, d.direction, d.crossFile);
      g.colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    const resolution = new THREE.Vector2(this.container.clientWidth, this.container.clientHeight);
    for (const [, g] of groups) {
      const B = 2000;
      for (let b = 0; b < g.verts.length; b += B * 6) {
        const v = g.verts.slice(b, b + B * 6), cl = g.colors.slice(b, b + B * 6);
        const geo = new LineSegmentsGeometry();
        geo.setPositions(v);
        geo.setColors(cl);
        const opacity = edgeOpacityByDepth(g.depth);
        const mat = new LineMaterial({
          vertexColors: true, transparent: true, opacity,
          linewidth: edgeWidthByDepth(g.depth),
          resolution, depthWrite: false, blending: THREE.AdditiveBlending,
        });
        const lines = new Line2(geo, mat);
        lines.userData['edgeDepth'] = g.depth;
        lines.computeLineDistances();
        this.edgeGroup.add(lines); this.edgeLineGroups.push(lines);
      }
    }
  }
```

> Line2 用 `LineSegmentsGeometry.setPositions/setColors`（不是 BufferGeometry.setAttribute）。`resolution` 必须传否则线宽按默认视口算错。

### C4. resize 时更新 LineMaterial resolution

搜索 `graph.ts` 里的 resize 处理（`onResize` 或 `handleResize` 方法，通常设置 `renderer.setSize` / `camera.aspect`）。在那段里追加：

```ts
    for (const lines of this.edgeLineGroups) {
      (lines.material as LineMaterial).resolution.set(this.container.clientWidth, this.container.clientHeight);
    }
```

> 找不到具体方法名时，grep `setSize` 或 `clientWidth` 在 resize 上下文。如果项目用 ResizeObserver，在回调里加。

### C5. 清理边时类型适配

搜索所有 `this.edgeLineGroups` 的遍历，把 `THREE.LineBasicMaterial` cast 改成 `LineMaterial`，把 `.material` 属性访问保持（Line2 也有 `.material`）。关键位置：

`graph.ts:1603`、`1642`、`2427`、`2558` 当前都类似：
```ts
edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
```
这些只改 opacity，无需改（LineMaterial 也有 opacity）。但如果有 `(lines.material as THREE.LineBasicMaterial)` 的 cast，改成 `(lines.material as LineMaterial)`。grep 一下确认。

### C6. hover 高亮边的几何（可选，低风险）

`graph.ts:1984`、`2003`、`2111`、`2611`、`3376`、`4380` 等用 `new THREE.LineSegments(geo, new THREE.LineBasicMaterial(...))` 建临时高亮边。这些是 hover/focus 时的少量高亮边，1px 够用，**不必改 Line2**（性能更优）。保持原样。

### C 档验证

```powershell
npx tsc --noEmit
```
运行后：L4 耦合边应明显比 L1 粗（2.4px vs 1.0px）；缩放窗口时线宽不变形（C4 生效）。若帧率下降明显（边数多），回退 C 档保留 A+B，粗细维度放弃。

---

## D 档 — 图例升级为可点击筛选器

> 让用户点图例某类边 → 只高亮该类边，其他类降到 0.01。把"同时分辨 10 种"降成"每次只看一种"，是最有效的辨识增强。

### D1. 新增筛选状态字段

**位置** `graph.ts:836`（`_agentHighlightIndices` 声明附近）之后追加：
```ts
  private _edgeTypeFilter: string | null = null;
```

### D2. 新增筛选应用方法

在 `clearFileHighlight`(2224) 方法之后追加：
```ts
  /** Highlight only edges of one type, dim all others. null = clear filter. */
  setEdgeTypeFilter(edgeType: string | null): void {
    this._edgeTypeFilter = edgeType;
    for (const lines of this.edgeLineGroups) {
      const mat = lines.material as (THREE.LineBasicMaterial | LineMaterial);
      if (edgeType === null) {
        mat.opacity = edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
      } else {
        // ponytail: Line2 按组存, userData 没存 edgeType; 用颜色近似判断不可行, 改按组重建时打标
        const et = (lines.userData['edgeType'] as string) || '';
        // ponytail: 选中类直接给固定高值 0.5（不乘 edgeOpacityByDepth 的低默认值），其他类降到几乎不可见
        mat.opacity = et === edgeType ? 0.5 : 0.005;
      }
    }
    if (edgeType === null) this._updateLegendActive(null);
  }
```

### D3. buildEdges 给每个 Line2 打 edgeType 标签

C3 替换后的 `buildEdges` 里，`lines.userData['edgeDepth'] = g.depth;` 这行之后追加：
```ts
        lines.userData['edgeType'] = groups.size > 0 ? key_str : '';
```
但 `key` 是 `${edgeType}:${direction}:...`。需要存原始 edgeType。改 groups 的 value 加 `edgeType` 字段：

C3 的 groups Map 声明改成：
```ts
    const groups = new Map<string, { verts: number[]; colors: number[]; depth: number; crossFile: boolean; edgeType: string }>();
```
循环里 `groups.set(k, { verts: [], colors: [], depth: d.couplingDepth, crossFile: d.crossFile, edgeType: d.edgeType.toLowerCase() });`
建 Line2 后：`lines.userData['edgeType'] = g.edgeType;`

> 注意：一个 Line2 组对应一个 edgeType（key 已含 edgeType），所以 `g.edgeType` 整组一致。

### D4. 图例行改可点击

**位置** `graph.ts:4243-4261`（buildLegend 区）。

把每个 `.legend-row`（边部分）加 `data-edge-type` 和点击处理。当前边图例行（4255-4259）：
```ts
        <div class="legend-row" title="${t('legend.structure.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x6699cc)}"></span> ${t('legend.structure')}</div>
        <div class="legend-row" title="${t('legend.dataRead.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x66dd66)}"></span> ${t('legend.dataRead')}</div>
        <div class="legend-row" title="${t('legend.dataWrite.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff7777)}"></span> ${t('legend.dataWrite')}</div>
        <div class="legend-row" title="${t('legend.shareTemporal.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xffaa44)}"></span> ${t('legend.shareTemporal')}</div>
        <div class="legend-row" title="${t('legend.inherits.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff66ff)}"></span> ${t('legend.inherits')}</div>
```

替换为（用 B1 的 _EDGE_COLORS 色值，加 data-edge-type 和 cursor:pointer）：
```ts
        <div class="legend-row legend-edge-row" data-edge-type="calls" title="${t('legend.structure.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4a9adf)}"></span> ${t('legend.structure')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="reads" title="${t('legend.dataRead.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x66dd66)}"></span> ${t('legend.dataRead')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="writes" title="${t('legend.dataWrite.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff5566)}"></span> ${t('legend.dataWrite')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="shares" title="${t('legend.shareTemporal.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xffaa44)}"></span> ${t('legend.shareTemporal')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="inherits" title="${t('legend.inherits.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff66dd)}"></span> ${t('legend.inherits')}</div>
```

> shareTemporal 行对应 shares/triggers/awaits/sequences 四种，data-edge-type 只能挂一个。简化：挂 "shares"，或拆成多行（见 D5 可选）。

**位置** `graph.ts:4261`（`this.container.appendChild(this.legendEl);`）之后追加点击绑定：
```ts
    this.legendEl.querySelectorAll<HTMLElement>('.legend-edge-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const et = row.dataset['edgeType'] || '';
        this.setEdgeTypeFilter(this._edgeTypeFilter === et ? null : et);
      });
    });
```

### D5. 筛选激活态视觉

在 `setEdgeTypeFilter` 末尾调用 `_updateLegendActive`，在 setEdgeTypeFilter 上方加：
```ts
  private _updateLegendActive(activeType: string | null): void {
    this.legendEl.querySelectorAll<HTMLElement>('.legend-edge-row').forEach(row => {
      const et = row.dataset['edgeType'] || '';
      row.style.opacity = activeType === null ? '1' : (et === activeType ? '1' : '0.35');
      row.style.outline = et === activeType && activeType !== null ? '1px solid rgba(255,255,255,0.6)' : 'none';
    });
  }
```

### D6. 清图时清筛选

`graph.ts:4092`（clearGraph 里）当前：
```ts
    this.focusActive = false; this.focusNodeIdx = -1; this.selectedIdx = -1;
```
之后追加：
```ts
    this._edgeTypeFilter = null;
```

### D 档验证
点图例"数据写"→ 只有 writes 边亮，其他类降到几乎不可见；再点一次取消。激活行有白边框。

---

## E 档 — 小地图边色 + i18n 同步

### E1. 小地图边色用新色值

**位置** `graph.ts:4473-4479`。

当前：
```ts
      const ec = e.edgeType.toLowerCase();
      let alpha = 0.08;
      if (ec === 'reads') { ctx.strokeStyle = `rgba(102,221,102,${alpha})`; }
      else if (ec === 'writes') { ctx.strokeStyle = `rgba(255,130,130,${alpha})`; }
      else if (ec === 'shares') { ctx.strokeStyle = `rgba(255,170,68,${alpha})`; }
      else if (ec === 'temporal' || ec === 'TEMPORAL') { ctx.strokeStyle = `rgba(192,152,255,${alpha})`; }
      else { ctx.strokeStyle = `rgba(120,160,220,${alpha * 0.7})`; }
```

替换为：
```ts
      const ec = e.edgeType.toLowerCase();
      let alpha = 0.10;
      if (ec === 'reads') { ctx.strokeStyle = `rgba(102,221,102,${alpha})`; }
      else if (ec === 'writes') { ctx.strokeStyle = `rgba(255,85,102,${alpha})`; }
      else if (ec === 'shares') { ctx.strokeStyle = `rgba(255,170,68,${alpha})`; }
      else if (ec === 'triggers') { ctx.strokeStyle = `rgba(255,136,51,${alpha})`; }
      else if (ec === 'awaits') { ctx.strokeStyle = `rgba(192,104,255,${alpha})`; }
      else if (ec === 'sequences') { ctx.strokeStyle = `rgba(136,102,255,${alpha})`; }
      else if (ec === 'inherits') { ctx.strokeStyle = `rgba(255,102,221,${alpha})`; }
      else if (ec === 'imports') { ctx.strokeStyle = `rgba(74,223,223,${alpha})`; }
      else if (ec === 'defines') { ctx.strokeStyle = `rgba(74,223,138,${alpha})`; }
      else { ctx.strokeStyle = `rgba(74,154,223,${alpha * 0.8})`; }
```

### E2. i18n 图例文案补充（可选）

`i18n.ts:13-25` 当前图例只 5 类边文案。若 D5 拆出更多边类型行，补 key：
```ts
  'legend.trigger':  { zh: '触发', en: 'Trigger' },
  'legend.await':    { zh: '等待', en: 'Await' },
  'legend.sequence': { zh: '顺序', en: 'Sequence' },
```
若 D 档保持 5 行聚合（shareTemporal 不拆），E2 跳过。

### E 档验证
小地图边色与主图一致；图例文案无 undefined。

---

## 全局验证清单

```powershell
cd src-ui
npx tsc --noEmit
npx eslint src/ui/graph.ts src/i18n.ts
npm run build
```

体验验收：
- [ ] 8 种代码节点颜色明显不同（蓝/青/绿/黄/橙/红/品红）
- [ ] 存储节点金黄系、时序节点紫系，子类型明度可辨
- [ ] full 模式节点核心呈彩色（不再统一白心）
- [ ] 总览视角边极淡（不过曝成毛线团），只看到结构骨架
- [ ] hover 节点时关联边颜色鲜明可辨（10 种色相一眼区分）
- [ ] L4 边比 L1 边粗（若做了 C 档）
- [ ] 点图例边类型 → 只高亮该类边（若做了 D 档）
- [ ] 缩放窗口线宽不变形（若做了 C 档）
- [ ] 小地图边色与主图一致
- [ ] 帧率正常（边多时尤其确认 C 档 Line2 性能）

---

## 不在范围（明确不做）
- 不改边的粒子流颜色逻辑（`initEdgeParticles` 1978/1997 用 `edgeColorByType`，自动跟随新色值，无需改）。
- 不改 fold/galaxy 模式的社区边色（3376/4473 用固定 opacity 0.08，独立视觉层）。
- 不改 hover 临时高亮边的 LineSegments（C6，保持 1px 性能优）。
- 不改 agent trail / path 高亮边（青色固定，语义专用）。

---

## 回滚
- A/B：纯数据替换，还原两个函数/表即可。
- C：回退 `edgeLineGroups` 类型为 `THREE.LineSegments[]`，还原 `buildEdges`，删 Line2 import。
- D：删 `_edgeTypeFilter`/`setEdgeTypeFilter`/`_updateLegendActive`，图例行去 data-edge-type。
- E：还原 minimap strokeStyle 分支。

各档独立，A+B 是核心，C/D/E 是增强，可分别回滚。
