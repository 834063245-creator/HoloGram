# 图例 Panel 升级方案（配色同步 + 节点/边全展开 + 双向点击筛选 + 激活反馈）

> 给执行模型：每处改动给 **文件:行号** + **当前代码** + **替换代码**。按顺序执行，不改方案外代码。不加注释（除 `// ponytail:`），保持 2 空格缩进。
> 前置：A 档节点 8 色相已执行（`graph.ts:46-63`），B 档边 10 色相已执行（`graph.ts:71-89`），D 档边行点击筛选已执行（`graph.ts:4324-4330`）。本方案把这些同步到图例 UI 并补齐节点侧。
> 路径：`graph.ts`=`src-ui/src/ui/graph.ts`，`i18n.ts`=`src-ui/src/i18n.ts`，`index.html`=`src-ui/index.html`。

---

## 问题诊断（必读）

1. **节点图例色值过期** `graph.ts:4311-4313` 用旧三色 `0x7eb8ff/0xf0c060/0xc098ff`，与 A 档 8 色相脱节。
2. **节点图例只 3 大类**，A 档 8 种代码符号各一色（蓝/青/绿/黄/橙/红/品红）没体现，用户无法对照。
3. **节点行不可点击** `4324-4330` 只给边行绑了筛选；节点行纯展示，交互不对称。
4. **边图例只 5 行聚合**，B 档 10 种边 10 色相，图例只展示 structure/dataRead/dataWrite/shareTemporal/inherits，imports/defines/triggers/awaits/sequences 被吞进聚合行无独立色块。
5. **点击反馈弱** `_updateLegendActive`(2313-2319) 用 inline `opacity`+`outline`，CSS 无 `.active` 态，选中无持久视觉。

---

## 修复总览

| 步 | 内容 | 文件 |
|---|---|---|
| F1 | 节点图例扩到 10 行（8 代码符号+存储+时序）+ 色值同步 A 档 + data-node-filter | graph.ts |
| F2 | 边图例扩到 10 行（10 种边各独立）+ 色值同步 B 档 | graph.ts |
| F3 | 节点筛选字段 + setNodeKindFilter 方法 | graph.ts |
| F4 | 节点行点击绑定 | graph.ts |
| F5 | _updateLegendActive 改用 class + 支持节点行 + 边/节点可共存 | graph.ts |
| F6 | CSS .active 激活态 | index.html |
| F7 | i18n 补 14 个 key（8 节点 + 6 边） | i18n.ts |
| F8 | clearGraph 清节点筛选 | graph.ts |

---

## F1 + F2 — 重写 buildLegend 的 innerHTML（节点 10 行 + 边 10 行）

**位置** `graph.ts:4308-4322`（`this.legendEl.innerHTML = ...` 整段）。

当前：
```ts
    this.legendEl.innerHTML =
      `<div class="legend-section">
        <div class="legend-title">${t('legend.node')}</div>
        <div class="legend-row" title="${t('legend.symbol.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0x7eb8ff)};color:${hexToCSS(0x7eb8ff)}"></span> ${t('legend.symbol')}</div>
        <div class="legend-row" title="${t('legend.medium.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xf0c060)};color:${hexToCSS(0xf0c060)}"></span> ${t('legend.medium')}</div>
        <div class="legend-row" title="${t('legend.temporal.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xc098ff)};color:${hexToCSS(0xc098ff)}"></span> ${t('legend.temporal')}</div>
      </div>
      <div class="legend-section">
        <div class="legend-title">${t('legend.edge')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="calls" title="${t('legend.structure.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4a9adf)}"></span> ${t('legend.structure')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="reads" title="${t('legend.dataRead.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x66dd66)}"></span> ${t('legend.dataRead')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="writes" title="${t('legend.dataWrite.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff5566)}"></span> ${t('legend.dataWrite')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="shares" title="${t('legend.shareTemporal.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xffaa44)}"></span> ${t('legend.shareTemporal')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="inherits" title="${t('legend.inherits.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff66dd)}"></span> ${t('legend.inherits')}</div>
      </div>`;
```

替换为：
```ts
    this.legendEl.innerHTML =
      `<div class="legend-section">
        <div class="legend-title">${t('legend.node')}</div>
        <div class="legend-row legend-node-row" data-node-filter="symbol" title="${t('legend.symbol.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0x6ab0ff)};color:${hexToCSS(0x6ab0ff)}"></span> ${t('legend.symbol')}</div>
        <div class="legend-row legend-node-row" data-node-filter="function" title="${t('legend.function.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0x4ad8c8)};color:${hexToCSS(0x4ad8c8)}"></span> ${t('legend.function')}</div>
        <div class="legend-row legend-node-row" data-node-filter="method" title="${t('legend.method.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0x4ad8c8)};color:${hexToCSS(0x4ad8c8)}"></span> ${t('legend.method')}</div>
        <div class="legend-row legend-node-row" data-node-filter="class" title="${t('legend.class.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0x7fd84a)};color:${hexToCSS(0x7fd84a)}"></span> ${t('legend.class')}</div>
        <div class="legend-row legend-node-row" data-node-filter="module" title="${t('legend.module.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xd8d84a)};color:${hexToCSS(0xd8d84a)}"></span> ${t('legend.module')}</div>
        <div class="legend-row legend-node-row" data-node-filter="interface" title="${t('legend.interface.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xf0a850)};color:${hexToCSS(0xf0a850)}"></span> ${t('legend.interface')}</div>
        <div class="legend-row legend-node-row" data-node-filter="variable" title="${t('legend.variable.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xf07070)};color:${hexToCSS(0xf07070)}"></span> ${t('legend.variable')}</div>
        <div class="legend-row legend-node-row" data-node-filter="constant" title="${t('legend.constant.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xd850b0)};color:${hexToCSS(0xd850b0)}"></span> ${t('legend.constant')}</div>
        <div class="legend-row legend-node-row" data-node-filter="medium" title="${t('legend.medium.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xf0c060)};color:${hexToCSS(0xf0c060)}"></span> ${t('legend.medium')}</div>
        <div class="legend-row legend-node-row" data-node-filter="temporal" title="${t('legend.temporal.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xc098ff)};color:${hexToCSS(0xc098ff)}"></span> ${t('legend.temporal')}</div>
      </div>
      <div class="legend-section">
        <div class="legend-title">${t('legend.edge')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="calls" title="${t('legend.calls.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4a9adf)}"></span> ${t('legend.calls')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="imports" title="${t('legend.imports.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4adfdf)}"></span> ${t('legend.imports')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="defines" title="${t('legend.defines.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4adf8a)}"></span> ${t('legend.defines')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="inherits" title="${t('legend.inherits.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff66dd)}"></span> ${t('legend.inherits')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="reads" title="${t('legend.dataRead.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x66dd66)}"></span> ${t('legend.dataRead')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="writes" title="${t('legend.dataWrite.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff5566)}"></span> ${t('legend.dataWrite')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="shares" title="${t('legend.shares.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xffaa44)}"></span> ${t('legend.shares')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="triggers" title="${t('legend.triggers.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff8833)}"></span> ${t('legend.triggers')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="awaits" title="${t('legend.awaits.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xc068ff)}"></span> ${t('legend.awaits')}</div>
        <div class="legend-row legend-edge-row" data-edge-type="sequences" title="${t('legend.sequences.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x8866ff)}"></span> ${t('legend.sequences')}</div>
      </div>`;
```

> 色值与 A 档 `NODE_COLORS`(46-63)、B 档 `_EDGE_COLORS`(71-82) 完全一致。function/method 同色 `0x4ad8c8`（语义上 method 是类内 function，两行同色不同标签，用户能理解）。节点 swatch 用核心色(NODE_COLORS 亮色)非晕色，和实际节点核心呈现一致（A2 已改核心彩色）。

---

## F3 — 节点筛选字段 + setNodeKindFilter 方法

**位置** `graph.ts:873`（`private _edgeTypeFilter: string | null = null;`）之后追加：

```ts
  private _edgeTypeFilter: string | null = null;
  private _nodeKindFilter: string | null = null;
```

**位置** `graph.ts:2311`（`setEdgeTypeFilter` 方法结束的 `}` 之后）追加新方法：

```ts
  /** Dim all nodes except those matching a kind filter. null = clear. */
  setNodeKindFilter(filter: string | null): void {
    this._nodeKindFilter = filter;
    if (filter === null) {
      for (let i = 0; i < this.nodeGlows.length; i++) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.55;
        if (this.nodeCores[i]) this.nodeCores[i].visible = true;
      }
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
    for (let i = 0; i < this.nodeGlows.length; i++) {
      const kind = ((this.graphNodes[i]?.type || this.graphNodes[i]?.kind || 'symbol') as string);
      const hit = matches(kind);
      (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = hit ? 0.88 : 0.04;
      if (this.nodeCores[i]) this.nodeCores[i].visible = hit;
    }
    this._updateLegendActive(this._edgeTypeFilter, filter);
  }
```

> 恢复 opacity 用 0.55（与 `clearAgentLens`/`clearFileHighlight` 一致的稳态值）。命中节点提到 0.88 醒目，未命中降到 0.04。core 直接隐藏未命中的。边筛选与节点筛选独立，可共存（点节点行不影响边筛选态，反之亦然）。

---

## F4 — 节点行点击绑定

**位置** `graph.ts:4324-4330`（边行点击绑定那段）之后追加。

当前 4324-4330：
```ts
    this.legendEl.querySelectorAll<HTMLElement>('.legend-edge-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const et = row.dataset['edgeType'] || '';
        this.setEdgeTypeFilter(this._edgeTypeFilter === et ? null : et);
      });
    });
```

在其后追加：
```ts
    this.legendEl.querySelectorAll<HTMLElement>('.legend-node-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const nk = row.dataset['nodeFilter'] || '';
        this.setNodeKindFilter(this._nodeKindFilter === nk ? null : nk);
      });
    });
```

> 点击已激活行 = toggle 取消（同边行逻辑）。无需额外"清除"按钮，YAGNI。

---

## F5 — _updateLegendActive 改用 class + 支持节点行

**位置** `graph.ts:2313-2319`，整段替换。

当前：
```ts
  private _updateLegendActive(activeType: string | null): void {
    this.legendEl.querySelectorAll<HTMLElement>('.legend-edge-row').forEach(row => {
      const et = row.dataset['edgeType'] || '';
      row.style.opacity = activeType === null ? '1' : (et === activeType ? '1' : '0.35');
      row.style.outline = et === activeType && activeType !== null ? '1px solid rgba(255,255,255,0.6)' : 'none';
    });
  }
```

替换为：
```ts
  private _updateLegendActive(activeEdge: string | null, activeNode: string | null = null): void {
    this.legendEl.querySelectorAll<HTMLElement>('.legend-edge-row').forEach(row => {
      const et = row.dataset['edgeType'] || '';
      row.classList.toggle('active', activeEdge !== null && et === activeEdge);
      row.style.opacity = activeEdge === null ? '1' : (et === activeEdge ? '1' : '0.35');
    });
    this.legendEl.querySelectorAll<HTMLElement>('.legend-node-row').forEach(row => {
      const nk = row.dataset['nodeFilter'] || '';
      row.classList.toggle('active', activeNode !== null && nk === activeNode);
      row.style.opacity = activeNode === null ? '1' : (nk === activeNode ? '1' : '0.35');
    });
  }
```

> 保留 opacity 淡化未选中行（视觉分组），加 `.active` class 给选中行持久发光反馈（F6 CSS 定义）。边/节点各自独立 toggle，互不干扰。

**同步改 setEdgeTypeFilter 的调用** `graph.ts:2310`：

当前：
```ts
    if (edgeType === null) this._updateLegendActive(null);
```

替换为：
```ts
    this._updateLegendActive(edgeType, this._nodeKindFilter);
```

> 去掉 `if (edgeType === null)` 条件 —— 无论激活还是取消都要更新图例视觉，且要保留当前节点筛选态。原代码只在 null 时调，激活时图例无反馈，是 bug。

---

## F6 — CSS .active 激活态

**位置** `index.html:468`（`#graph-legend .legend-edge-swatch { ... }` 规则之后）。

在 `#graph-legend .legend-edge-swatch { ... }` 规则块结束后追加：
```css
    #graph-legend .legend-row.active {
      background: rgba(80, 140, 240, 0.16);
      border-radius: 4px;
      box-shadow: inset 0 0 0 1px rgba(120, 170, 255, 0.5), 0 0 14px rgba(80, 140, 240, 0.22);
      padding: 1px 4px;
      margin: -1px -4px;
    }
    #graph-legend .legend-row.active .legend-swatch,
    #graph-legend .legend-row.active .legend-edge-swatch {
      filter: brightness(1.3);
    }
```

> `.active` 行有蓝色半透明底+内边框+外发光，色块提亮 30%。padding/margin 负偏移补偿避免布局跳动。比 inline outline 精致且可被 hover 叠加。

---

## F7 — i18n 补 14 个 key

**位置** `i18n.ts:25`（`'legend.shareTemporal.desc'` 行之后，`'focus.title'` 行之前）插入。

在 `'legend.shareTemporal.desc': ...` 这行之后追加：
```ts
  'legend.function':  { zh: '函数', en: 'Function' },
  'legend.method':    { zh: '方法', en: 'Method' },
  'legend.class':     { zh: '类', en: 'Class' },
  'legend.module':    { zh: '模块', en: 'Module' },
  'legend.interface': { zh: '接口', en: 'Interface' },
  'legend.variable':  { zh: '变量', en: 'Variable' },
  'legend.constant':  { zh: '常量', en: 'Constant' },
  'legend.calls':     { zh: '调用', en: 'Calls' },
  'legend.imports':   { zh: '导入', en: 'Imports' },
  'legend.defines':   { zh: '定义', en: 'Defines' },
  'legend.shares':    { zh: '共享', en: 'Share' },
  'legend.triggers':  { zh: '触发', en: 'Trigger' },
  'legend.awaits':    { zh: '等待', en: 'Await' },
  'legend.sequences': { zh: '顺序', en: 'Sequence' },
  'legend.function.desc':  { zh: '独立函数 · 顶层函数', en: 'Standalone function · top-level function' },
  'legend.method.desc':    { zh: '类内方法 · 实例/静态方法', en: 'Class method · instance/static method' },
  'legend.class.desc':     { zh: '类声明', en: 'Class declaration' },
  'legend.module.desc':    { zh: '模块 · 命名空间', en: 'Module · namespace' },
  'legend.interface.desc': { zh: '接口 · 抽象类型', en: 'Interface · abstract type' },
  'legend.variable.desc':  { zh: '可变变量', en: 'Mutable variable' },
  'legend.constant.desc':  { zh: '不可变常量', en: 'Immutable constant' },
  'legend.calls.desc':     { zh: '函数/方法调用', en: 'Function/method call' },
  'legend.imports.desc':   { zh: '模块导入', en: 'Module import' },
  'legend.defines.desc':   { zh: '定义关系 · 包含', en: 'Defines · contains' },
  'legend.shares.desc':    { zh: '共享资源 · 共享变量', en: 'Shared resource · shared variable' },
  'legend.triggers.desc':  { zh: '事件触发', en: 'Event trigger' },
  'legend.awaits.desc':    { zh: '异步等待', en: 'Async await' },
  'legend.sequences.desc': { zh: '顺序执行约束', en: 'Sequence ordering' },
```

> 原 `legend.symbol` 改含义为"通用符号"（zh 仍是"代码实体"或改"符号"，en 保持 Code 或改 Symbol）。原 `legend.structure`/`legend.shareTemporal` 不再被图例引用（拆开了），但 key 保留不删（别处可能用，YAGNI 不主动清理）。

**可选**：`legend.symbol` zh 从"代码实体"改"符号"更贴合独立行。若改：
```ts
  'legend.symbol':   { zh: '符号', en: 'Symbol' },
```
不改也行，"代码实体"在单独一行不歧义。

---

## F8 — clearGraph 清节点筛选

**位置** `graph.ts:4172`（`this._edgeTypeFilter = null;`）之后。

当前：
```ts
    this._edgeTypeFilter = null;
```

替换为：
```ts
    this._edgeTypeFilter = null;
    this._nodeKindFilter = null;
```

> 重新渲染图时筛选态归零，避免新图带着旧筛选。

---

## 验证清单

```powershell
cd src-ui
npx tsc --noEmit
npx eslint src/ui/graph.ts src/i18n.ts
npm run build
```

体验验收：
- [ ] 图例节点列 10 行，每行色块与星图实际节点颜色一致（蓝/青/青/绿/黄/橙/红/品红/金/紫）
- [ ] 图例边列 10 行，每行色条与 hover 时边颜色一致
- [ ] 点节点行（如"类"）→ 星图只亮 class 节点，其他类 dim；点"函数"或"方法"都亮 function+method
- [ ] 点"存储介质"行 → 亮 file/database/cache/queue 全部
- [ ] 点边行（如"写入"）→ 只亮 writes 边，其他类边几乎消失
- [ ] 节点筛选和边筛选可同时生效（点一个节点行 + 一个边行，两者都筛）
- [ ] 选中行有蓝色底+发光边框（.active），未选中行淡化 opacity 0.35
- [ ] 再点已选中行 → 取消筛选，恢复全部
- [ ] 中英文切换图例文案正确（无 undefined）
- [ ] 重新加载图 → 筛选态清空

---

## 不在范围
- 不加"清除全部"按钮（点已激活行 toggle 即可，YAGNI）。
- 不改 panel 定位/尺寸（横向两列 10 行高度可接受；若太高后续单独加 max-height+scroll）。
- 不改 hover 临时高亮边色（B3 已处理）。
- 不删旧 i18n key（structure/shareTemporal 等保留，别处可能引用）。

## 回滚
- F1/F2：还原 innerHTML 到旧 3+5 行。
- F3-F5：删 _nodeKindFilter/setNodeKindFilter，还原 _updateLegendActive 签名，还原 setEdgeTypeFilter 末行。
- F6：删 .active CSS 块。
- F7：删新增 i18n key。
- F8：删 _nodeKindFilter=null 行。
