# 星图联动体验修复方案（A+B+C 全修）✅ 已完成 2026-06-26

> **执行结果：** A+B+C 全档实施完毕，`tsc --noEmit` 零错误。
> 修改文件：`src-ui/src/ui/graph.ts`、`src-ui/src/ui/agent-visualizer.ts`、`src-ui/src/ui/file-tree.ts`。
> 核心变更：相机沿视线方向飞行（时间驱动）、去抖+用户中断、文件/Agent 高亮不再飞相机、文件树面板内部滚动+精确匹配。

> 给执行模型：本方案每处改动都给出 **文件:行号** + **当前代码** + **替换代码**。
> 严格按顺序执行，每完成一档跑一次构建验证。不要改方案外的代码。
> 风格约定：不加注释（除 `// ponytail:` 标记），保持原文件缩进（2 空格）。
> 路径前缀 `graph.ts` = `src-ui/src/ui/graph.ts`，`file-tree.ts` = `src-ui/src/ui/file-tree.ts`，`agent-visualizer.ts` = `src-ui/src/ui/agent-visualizer.ts`。

---

## 修复总览

| 档 | 问题 | 改动文件 | 大致行数 |
|---|---|---|---|
| A | 相机物理：固定世界偏移导致横穿场景、动画时长绑定帧率、无中断/去抖 | graph.ts | ~50 |
| B | 过度联动：文件高亮/Agent 工具每次都飞相机 | graph.ts, agent-visualizer.ts | ~20 |
| C | 反向联动：scrollIntoView 滚整页、路径误匹配、定时器叠加 | file-tree.ts | ~15 |

执行顺序：**A → B → C**。A 改完后 B 才能干净地"删飞行"。

---

## A 档 — 相机物理（消除"乱飞"根因）

### A1. 新增字段声明

**位置** `graph.ts:830`，在 `private focusFlash = 0;` 这一行**之后**插入：

当前 815-830：
```ts
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
```

在 `private focusFlash = 0;` 之后追加这 5 行：
```ts
  private focusFlash = 0;
  // ponytail: 统一飞行规划 — focusTarget 语义改为"相机终点"，_focusLookTarget 是看向的点
  private _focusLookTarget = new THREE.Vector3();
  private _focusStartTime = 0;
  private _focusDurationMs = 600;
  private _userInteracting = false;
  private _flyDebounce: ReturnType<typeof setTimeout> | null = null;
```

> **语义变更（重要）**：`focusTarget` 字段从"节点/质心位置"改为"相机终点位置"。所有设置 `focusTarget` 的地方都要同步改成填相机终点，看向的点填 `_focusLookTarget`（node 分支）或沿用 `_initCamTarget`（reset）/`_constellationLookTarget`（galaxy）。

---

### A2. 监听 OrbitControls 中断飞行

**位置** `graph.ts:910`，`this.controls = new OrbitControls(this.camera, this.renderer.domElement);` 这一行**之后**插入：

当前 910：
```ts
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
```

替换为：
```ts
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // ponytail: 用户手动操作即放弃自动 fly，避免抢镜头
    this.controls.addEventListener('start', () => {
      this._userInteracting = true;
      this.focusActive = false;
      if (this._flyDebounce) { clearTimeout(this._flyDebounce); this._flyDebounce = null; }
    });
    this.controls.addEventListener('end', () => { this._userInteracting = false; });
```

---

### A3. 新增 `_planFlight` 统一飞行规划

**位置** `graph.ts:2140`，在 `flyToNode` 方法**结束之后**插入新方法。

先把 flyToNode（2136-2140）当前代码：
```ts
  private flyToNode(idx: number): void {
    const px = this.nodePositions[idx * 3], py = this.nodePositions[idx * 3 + 1], pz = this.nodePositions[idx * 3 + 2];
    this.focusTarget.set(px, py, pz); this.focusStartCam.copy(this.camera.position); this.focusStartLook.copy(this.controls.target);
    this.focusActive = true; this.focusProgress = 0; this.focusNodeIdx = idx; this.focusFlash = 1;
  }
```

替换为（含新增的 `_planFlight`）：
```ts
  private flyToNode(idx: number): void {
    const px = this.nodePositions[idx * 3], py = this.nodePositions[idx * 3 + 1], pz = this.nodePositions[idx * 3 + 2];
    const dist = 30 + (this.deg[idx] || 0) * 4;
    this._planFlight(new THREE.Vector3(px, py, pz), dist);
    this.focusNodeIdx = idx; this.focusFlash = 1;
  }

  // ponytail: 保持当前视线方向飞向 target，不横穿场景；delayMs>0 去抖，连击只飞最后一次
  private _planFlight(targetPos: THREE.Vector3, dist: number, delayMs = 150): void {
    if (this._flyDebounce) { clearTimeout(this._flyDebounce); this._flyDebounce = null; }
    const run = () => {
      const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
      if (dir.lengthSq() < 1e-4) dir.set(0.5, 0.4, 0.7);
      dir.normalize();
      this.focusTarget.copy(targetPos).add(dir.multiplyScalar(dist));
      this._focusLookTarget.copy(targetPos);
      this.focusStartCam.copy(this.camera.position);
      this.focusStartLook.copy(this.controls.target);
      this.focusActive = true; this.focusProgress = 0;
      this._focusStartTime = performance.now();
    };
    if (delayMs > 0 && !this._userInteracting) {
      this._flyDebounce = setTimeout(run, delayMs);
    } else {
      run();
    }
  }
```

---

### A4. 重写 `updateFocus` —— 基于时间 + 统一视线方向

**位置** `graph.ts:3625-3656`，整段替换。

当前代码：
```ts
  private updateFocus(): void {
    if (!this.focusActive) return;
    this.focusProgress += 0.025;
    const t = easeInOutCubic(Math.min(1, this.focusProgress));
    if (this._resettingCamera) {
      // Camera reset: lerp camera position AND controls target to initial values
      this.camera.position.lerpVectors(this.focusStartCam, this.focusTarget, t);
      this.controls.target.lerpVectors(this.focusStartLook, this._initCamTarget, t);
    } else if (this.enteredGalaxyId !== null) {
      // Constellation fly-to: focusTarget is camera destination, lookTarget is centroid
      this.camera.position.lerpVectors(this.focusStartCam, this.focusTarget, t);
      this.controls.target.lerpVectors(this.focusStartLook, this._constellationLookTarget, t);
    } else {
      // Node fly-to: focusTarget is node position, camera offsets from it
      this.camera.position.lerpVectors(this.focusStartCam, this.focusTarget.clone().add(new THREE.Vector3(80, 60, 100)), t);
      this.controls.target.lerpVectors(this.focusStartLook, this.focusTarget, t);
    }
    if (this.focusNodeIdx >= 0 && this.focusNodeIdx < this.nodeGlows.length) {
      // Snapshot original scales on first flash frame so restore is exact
      if (this.focusFlash === 1) {
        this._savedFocusGlowScale = this.nodeGlows[this.focusNodeIdx].scale.x;
        this._savedFocusCoreScale = this.nodeCores[this.focusNodeIdx].scale.x;
      }
      const base = this.getNodeBaseScale(this.focusNodeIdx);
      const flashScale = 1 + Math.sin(this.focusProgress * 20) * 0.5 * this.focusFlash;
      this.nodeGlows[this.focusNodeIdx].scale.setScalar(base * 5.5 * flashScale);
      (this.nodeGlows[this.focusNodeIdx].material as THREE.SpriteMaterial).opacity = 0.55 + 0.45 * this.focusFlash;
      this.nodeCores[this.focusNodeIdx].scale.setScalar(base * flashScale);
      this.focusFlash *= 0.97;
    }
    if (t >= 1) { this.focusActive = false; this._resettingCamera = false; if (this.enteredGalaxyId === null && !this._resettingCamera) setTimeout(() => this.restoreFocusNode(), 800); }
  }
```

替换为：
```ts
  private updateFocus(): void {
    if (!this.focusActive) return;
    const t = easeInOutCubic(Math.min(1, (performance.now() - this._focusStartTime) / this._focusDurationMs));
    if (this._resettingCamera) {
      this.camera.position.lerpVectors(this.focusStartCam, this.focusTarget, t);
      this.controls.target.lerpVectors(this.focusStartLook, this._initCamTarget, t);
    } else if (this.enteredGalaxyId !== null) {
      this.camera.position.lerpVectors(this.focusStartCam, this.focusTarget, t);
      this.controls.target.lerpVectors(this.focusStartLook, this._constellationLookTarget, t);
    } else {
      // ponytail: focusTarget=相机终点(已含视线方向偏移), _focusLookTarget=看向的点
      this.camera.position.lerpVectors(this.focusStartCam, this.focusTarget, t);
      this.controls.target.lerpVectors(this.focusStartLook, this._focusLookTarget, t);
    }
    if (this.focusNodeIdx >= 0 && this.focusNodeIdx < this.nodeGlows.length) {
      if (this.focusFlash === 1) {
        this._savedFocusGlowScale = this.nodeGlows[this.focusNodeIdx].scale.x;
        this._savedFocusCoreScale = this.nodeCores[this.focusNodeIdx].scale.x;
      }
      const base = this.getNodeBaseScale(this.focusNodeIdx);
      const flashScale = 1 + Math.sin(t * Math.PI * 2) * 0.5 * this.focusFlash;
      this.nodeGlows[this.focusNodeIdx].scale.setScalar(base * 5.5 * flashScale);
      (this.nodeGlows[this.focusNodeIdx].material as THREE.SpriteMaterial).opacity = 0.55 + 0.45 * this.focusFlash;
      this.nodeCores[this.focusNodeIdx].scale.setScalar(base * flashScale);
      this.focusFlash *= 0.97;
    }
    if (t >= 1) {
      this.focusActive = false; this._resettingCamera = false;
      if (this.enteredGalaxyId === null && !this._resettingCamera && this.focusNodeIdx >= 0) {
        setTimeout(() => this.restoreFocusNode(), 800);
      }
    }
  }
```

> 变更点：① 删除 `focusProgress += 0.025`，t 改用 `performance.now()`；② else 分支不再 `.clone().add(固定偏移)`，直接用 `focusTarget`（已是相机终点）+ `_focusLookTarget`；③ flashScale 用 `t` 替代 `focusProgress`；④ 结束判定加 `focusNodeIdx >= 0` 避免无谓定时器。

---

### A5. `resetCamera` 加时间戳与去抖清理

**位置** `graph.ts:2145-2152`。

当前：
```ts
  resetCamera(): void {
    if (this._initCamPos.lengthSq() < 1) return; // not initialized
    this.focusStartCam.copy(this.camera.position);
    this.focusStartLook.copy(this.controls.target);
    this.focusTarget.copy(this._initCamPos);
    this.focusActive = true; this.focusProgress = 0; this.focusNodeIdx = -1; this.focusFlash = 0;
    this._resettingCamera = true;
  }
```

替换为：
```ts
  resetCamera(): void {
    if (this._initCamPos.lengthSq() < 1) return; // not initialized
    if (this._flyDebounce) { clearTimeout(this._flyDebounce); this._flyDebounce = null; }
    this.focusStartCam.copy(this.camera.position);
    this.focusStartLook.copy(this.controls.target);
    this.focusTarget.copy(this._initCamPos);
    this.focusActive = true; this.focusProgress = 0; this.focusNodeIdx = -1; this.focusFlash = 0;
    this._focusStartTime = performance.now();
    this._resettingCamera = true;
  }
```

---

### A6. `_flyToCentroid` 改用 `_planFlight` + 包围盒自适应距离

**位置** `graph.ts:2607-2622`。

当前：
```ts
  private _flyToCentroid(indices: Set<number>): void {
    if (indices.size === 0) return;
    let cx = 0, cy = 0, cz = 0;
    for (const i of indices) {
      cx += this.nodePositions[i * 3];
      cy += this.nodePositions[i * 3 + 1];
      cz += this.nodePositions[i * 3 + 2];
    }
    const n = indices.size;
    this.focusTarget.set(cx / n, cy / n, cz / n);
    this.focusStartCam.copy(this.camera.position);
    this.focusStartLook.copy(this.controls.target);
    this.focusActive = true;
    this.focusProgress = 0;
    this.focusFlash = 0;
  }
```

替换为：
```ts
  private _flyToCentroid(indices: Set<number>): void {
    if (indices.size === 0) return;
    let cx = 0, cy = 0, cz = 0;
    for (const i of indices) {
      cx += this.nodePositions[i * 3];
      cy += this.nodePositions[i * 3 + 1];
      cz += this.nodePositions[i * 3 + 2];
    }
    const n = indices.size;
    const mx = cx / n, my = cy / n, mz = cz / n;
    // ponytail: 用包围盒半径算自适应距离，密集星团不贴脸、稀疏区域不偏远
    let r = 0;
    for (const i of indices) {
      const dx = this.nodePositions[i * 3] - mx, dy = this.nodePositions[i * 3 + 1] - my, dz = this.nodePositions[i * 3 + 2] - mz;
      r = Math.max(r, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    this._planFlight(new THREE.Vector3(mx, my, mz), Math.max(40, r * 3.2));
  }
```

---

### A7. `_applyFileHighlight` 末尾飞行改用 `_planFlight`

**位置** `graph.ts:2659-2674`。

当前（`// Fly to centroid of highlighted nodes` 那块）：
```ts
    // Fly to centroid of highlighted nodes
    if (hl && idxs.size > 0) {
      let cx = 0, cy = 0, cz = 0;
      for (const i of idxs) {
        cx += this.nodePositions[i * 3];
        cy += this.nodePositions[i * 3 + 1];
        cz += this.nodePositions[i * 3 + 2];
      }
      const n = idxs.size;
      this.focusTarget.set(cx / n, cy / n, cz / n);
      this.focusStartCam.copy(this.camera.position);
      this.focusStartLook.copy(this.controls.target);
      this.focusActive = true;
      this.focusProgress = 0;
      this.focusFlash = 0;
    }
```

替换为：
```ts
    // Fly to centroid of highlighted nodes
    if (hl && idxs.size > 0) {
      const tmp = new Set<number>();
      idxs.forEach(i => tmp.add(i));
      this._flyToCentroid(tmp);
    }
```

> 复用 A6 的 `_flyToCentroid`，避免重复包围盒计算。**B 档会删掉这整块**（文件高亮不再飞），此处先统一为 B 档做准备。

---

### A8. Galaxy 进入飞行加时间戳（3 处）

Galaxy 飞行的 `focusTarget` 已是相机终点（符合新语义），只需补 `_focusStartTime`，否则 A4 的新 `updateFocus` 会读到旧时间戳导致瞬移。

**位置 1** `graph.ts:3034`，当前：
```ts
        this.focusActive = true; this.focusProgress = 0; this.focusNodeIdx = -1; this.focusFlash = 0;
```
替换为：
```ts
        this.focusActive = true; this.focusProgress = 0; this.focusNodeIdx = -1; this.focusFlash = 0;
        this._focusStartTime = performance.now();
```

**位置 2** `graph.ts:3104`，当前：
```ts
      this.focusActive = true; this.focusProgress = 0; this.focusNodeIdx = -1; this.focusFlash = 0;
```
替换为：
```ts
      this.focusActive = true; this.focusProgress = 0; this.focusNodeIdx = -1; this.focusFlash = 0;
      this._focusStartTime = performance.now();
```

**位置 3** `graph.ts:3258`，当前：
```ts
      this.focusActive = true; this.focusProgress = 0; this.focusNodeIdx = -1; this.focusFlash = 0;
```
替换为：
```ts
      this.focusActive = true; this.focusProgress = 0; this.focusNodeIdx = -1; this.focusFlash = 0;
      this._focusStartTime = performance.now();
```

> 这三处文本相同但缩进不同（位置1 多 2 空格）。按缩进分别替换，别用 replaceAll。如果编辑器要求唯一匹配，把上一行 `this._constellationLookTarget = ...` 一起带上以区分。

---

### A 档验证

```powershell
# 在 src-ui 目录
npx tsc --noEmit
```
应无类型错误。运行后手动测试：
1. 从不同视角点节点详情 → 镜头应沿当前视线方向靠近，不横穿场景。
2. 连点多个节点 → 150ms 去抖，只飞最后一次。
3. 飞行途中手动拖拽 → 飞行立即停止，不抢镜头。
4. 高刷屏（144Hz）飞行时长与 60Hz 一致（约 0.6s）。

---

## B 档 — 解耦过度联动（默认不飞，只高亮）

### B1. 文件高亮不再飞相机

**位置** `graph.ts:2659-2674`（A7 刚改过的块）。

把 A7 替换后的整块**删除**（包括 `// Fly to centroid of highlighted nodes` 注释和 `if (hl && idxs.size > 0) { ... }` 整块）。删除后 `_applyFileHighlight` 的结尾就是标签隐藏逻辑（`for (let k = 0; k < this.nodeLabelIdx.length; k++)` 那段）。

效果：点文件/展开文件夹时星图仍高亮对应节点（dim 其他），但相机不动。

---

### B2. `highlightNodeNames` 不再飞质心

**位置** `graph.ts:2349`。

当前：
```ts
    // Fly to centroid of highlighted nodes
    this._flyToCentroid(this._agentHighlightIndices);
  }
```

替换为：
```ts
  }
```

> 删除这两行（含注释）。Agent 高亮只 dim 其他+着色，不飞相机。

---

### B3. Agent 工具处理从 `focusNode` 改为 `highlightNodeNames`

**位置** `agent-visualizer.ts`，4 处 `this.graph.focusNode(node);` 改为只高亮。

`_handleImpact`（约 182 行）当前：
```ts
  private _handleImpact(args: Record<string, unknown>): void {
    const node = String(args['node_id'] || args['nodeId'] || '');
    dbg('agent-viz.impact', `node="${node}"`);
    if (!node) return;
    this.graph.focusNode(node);
  }
```
替换为：
```ts
  private _handleImpact(args: Record<string, unknown>): void {
    const node = String(args['node_id'] || args['nodeId'] || '');
    dbg('agent-viz.impact', `node="${node}"`);
    if (!node) return;
    this.graph.highlightNodeNames([node], '#60a0ff');
  }
```

`_handleNeighbors`（约 185-190 行）当前：
```ts
  private _handleNeighbors(args: Record<string, unknown>): void {
    const node = String(args['node_id'] || args['nodeId'] || '');
    dbg('agent-viz.neighbors', `node="${node}"`);
    if (!node) return;
    this.graph.focusNode(node);
  }
```
替换为：
```ts
  private _handleNeighbors(args: Record<string, unknown>): void {
    const node = String(args['node_id'] || args['nodeId'] || '');
    dbg('agent-viz.neighbors', `node="${node}"`);
    if (!node) return;
    this.graph.highlightNodeNames([node], '#60a0ff');
  }
```

`_handleCouplingReport`（约 192-197 行）当前：
```ts
  private _handleCouplingReport(args: Record<string, unknown>): void {
    const module = String(args['module'] || args['module_name'] || args['moduleName'] || '');
    dbg('agent-viz.coupling', `module="${module}"`);
    if (!module) return;
    this.graph.focusNode(module);
  }
```
替换为：
```ts
  private _handleCouplingReport(args: Record<string, unknown>): void {
    const module = String(args['module'] || args['module_name'] || args['moduleName'] || '');
    dbg('agent-viz.coupling', `module="${module}"`);
    if (!module) return;
    this.graph.highlightNodeNames([module], '#60a0ff');
  }
```

`_handleHistory`（约 249-254 行）当前：
```ts
  private _handleHistory(args: Record<string, unknown>): void {
    const node = String(args['node_id'] || args['nodeId'] || '');
    dbg('agent-viz.history', `node="${node}"`);
    if (!node) return;
    this.graph.focusNode(node);
  }
```
替换为：
```ts
  private _handleHistory(args: Record<string, unknown>): void {
    const node = String(args['node_id'] || args['nodeId'] || '');
    dbg('agent-viz.history', `node="${node}"`);
    if (!node) return;
    this.graph.highlightNodeNames([node], '#60a0ff');
  }
```

> 颜色 `#60a0ff`（蓝）= Agent 当前关注，区别于 fragile/cycle 的 sol/红。trail 照常画（`updateAgentTrail` 不动）。
>
> **可选增强（不在本方案必做项）**：若希望一个 Agent 回合结束飞一次到本回合 visited 节点质心，在 `agent-visualizer.ts` 监听 `bus.on('chat:turn-done', ...)`，对 `this._visitedNodes` 调一次 `this.graph.focusNode(最后一个)`。默认不做，避免重新引入"飞"。

---

### B 档验证

```powershell
npx tsc --noEmit
```
手动测试：
1. 点文件树文件 → 星图高亮该文件节点（其他 dim），**相机不动**。
2. 展开/折叠文件夹 → 星图高亮对应子树（其他 dim），**相机不动**。
3. Agent 跑 impact/neighbors/coupling → 星图高亮关注节点（蓝色），**相机不动**，trail 正常画。
4. 手动点节点详情卡"打开"按钮 → 仍能飞（走 `flyToNode`，这是用户主动操作，保留飞行）。

---

## C 档 — 反向联动（星图→文件树）副作用修复

### C1. `highlightPath` 精确匹配 + 面板可见再滚动 + 定时器去重

**位置** `file-tree.ts:275-305`，整段替换。

当前：
```ts
  /** Highlight and scroll to a file path in the tree. Used by graph→tree reverse linking. */
  highlightPath(filePath: string): void {
    const normalized = filePath.replace(/\\/g, '/');
    // Find all row elements and look for matching file path
    const rows = this.treeEl.querySelectorAll<HTMLElement>('div[data-file-path]');
    for (const row of rows) {
      const rowPath = (row.dataset['filePath'] || '').replace(/\\/g, '/');
      if (rowPath === normalized || rowPath.endsWith('/' + normalized) || normalized.endsWith('/' + rowPath)) {
        // Expand parent containers
        let parent = row.parentElement;
        while (parent && parent !== this.treeEl) {
          if (parent.style.display === 'none') {
            parent.style.display = 'block';
            // Update parent arrow icon
            const parentRow = parent.previousElementSibling as HTMLElement;
            const arrow = parentRow?.querySelector('.ft-arrow') as HTMLElement;
            if (arrow) arrow.textContent = '▾';
          }
          parent = parent.parentElement;
        }
        // Scroll into view and highlight
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.style.background = 'rgba(60, 100, 170, 0.45)';
        row.style.borderLeftColor = 'rgba(100, 160, 240, 0.8)';
        setTimeout(() => {
          row.style.background = '';
          row.style.borderLeftColor = 'transparent';
        }, 2000);
        break;
      }
    }
  }
```

替换为：
```ts
  private _hlTimer: ReturnType<typeof setTimeout> | null = null;

  /** Highlight and scroll to a file path in the tree. Used by graph→tree reverse linking. */
  highlightPath(filePath: string): void {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    const rows = this.treeEl.querySelectorAll<HTMLElement>('div[data-file-path]');
    for (const row of rows) {
      const rowPath = (row.dataset['filePath'] || '').replace(/\\/g, '/').toLowerCase();
      // ponytail: 精确相等，去掉双向 endsWith 防止 a/b.ts 误命中 x/a/b.ts
      if (rowPath !== normalized) continue;
      // Expand parent containers
      let parent = row.parentElement;
      while (parent && parent !== this.treeEl) {
        if (parent.style.display === 'none') {
          parent.style.display = 'block';
          const parentRow = parent.previousElementSibling as HTMLElement;
          const arrow = parentRow?.querySelector('.ft-arrow') as HTMLElement;
          if (arrow) arrow.textContent = '▾';
        }
        parent = parent.parentElement;
      }
      // ponytail: 面板未打开时先打开，再滚面板内部，不滚整页
      const doScroll = () => {
        const rowTop = row.offsetTop;
        const view = this.treeEl;
        view.scrollTop = rowTop - view.clientHeight / 2 + row.clientHeight / 2;
        row.style.background = 'rgba(60, 100, 170, 0.45)';
        row.style.borderLeftColor = 'rgba(100, 160, 240, 0.8)';
        if (this._hlTimer) clearTimeout(this._hlTimer);
        this._hlTimer = setTimeout(() => {
          row.style.background = '';
          row.style.borderLeftColor = 'transparent';
        }, 2000);
      };
      if (!this.open) {
        this.show();
        requestAnimationFrame(doScroll);
      } else {
        doScroll();
      }
      break;
    }
  }
```

> 变更点：① 匹配改大小写无关精确相等；② `scrollIntoView` 改 `treeEl.scrollTop`（只滚面板内部，不滚整页）；③ 面板未打开先 `show()` 再 `rAF` 滚动；④ `_hlTimer` 实例字段去重，连续点节点不叠加定时器。

---

### C 档验证

```powershell
npx tsc --noEmit
```
手动测试：
1. 关闭文件树面板 → 点节点详情"打开"按钮 → 面板自动滑出并滚动到对应行，**星图不被滚出视口**。
2. 连续点不同节点的"打开"按钮 → 高亮只保留最后一个，不串色。
3. `a/b.ts` 不会误高亮 `x/a/b.ts`。

---

## 全局验证清单（A+B+C 完成后）

```powershell
# 1. 类型检查
cd src-ui; npx tsc --noEmit
# 2. 如项目有 lint
npx eslint src/ui/graph.ts src/ui/file-tree.ts src/ui/agent-visualizer.ts
# 3. 构建
npm run build
```

体验验收（在真实项目图上）：
- [ ] 从任意视角点节点 → 镜头沿当前视线方向靠近，不横穿场景
- [ ] 60Hz 与 144Hz 屏飞行时长一致（约 0.6s）
- [ ] 飞行中手动拖拽 → 飞行立即停止
- [ ] 连点多个节点 → 只飞最后一次（去抖生效）
- [ ] 点文件树文件 → 星图高亮但相机不动
- [ ] 展开/折叠文件夹 → 星图高亮但相机不动
- [ ] Agent 跑工具 → 星图高亮关注节点+画 trail，相机不动
- [ ] 点节点详情"打开" → 文件树面板可见、滚到对应行、星图不滚出视口
- [ ] 路径匹配精确，无误命中

---

## 不在本方案范围（明确不做）

- 不改 Agent 循环、不改 Python 引擎、不改 hooks.ts。
- 不加"跟随镜头"开关 UI（B 档直接默认不飞；如需开关后续单独加）。
- 不改 galaxy/constellation 进入的固定方向偏移（用户主动操作，保留原行为；A8 只补时间戳）。
- 不改 `_flyCameraTo`（minimap 专用，已正确）。
- 不新增测试文件（非平凡逻辑用 `updateFocus` 的运行时行为验证即可）。

---

## 回滚说明

每档独立。若 A 档出问题：还原 A1-A8（删新增字段、还原 `updateFocus` 的 `focusProgress += 0.025` 与固定偏移）。B/C 不依赖 A 的内部实现，只依赖 A 引入的 `_planFlight`/`_flyToCentroid`——若回滚 A，B1/B2 删除的飞行块需要一并还原。
