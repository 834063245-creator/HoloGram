# 总览关 bloom / 聚焦开 bloom 方案（消除边密集区雾化模糊）

> 给执行模型：每处改动给 **文件:行号** + **当前代码** + **替换代码**。按顺序执行，不改方案外代码。不加注释（除 `// ponytail:`），保持 2 空格缩放。
> 文件：`graph.ts` = `src-ui/src/ui/graph.ts`。
> 不是 LOD —— 不减边几何、不切细节层次、不碰透明度/配色。只动态开关后期 bloom pass。

---

## 问题诊断（必读）

**模糊根因**：单条边 opacity 0.004-0.022 远低于 bloom threshold 0.85，但 `AdditiveBlending` 让重叠边亮度累加 —— 密集区几十上百条边交叠在同一像素，累加亮度突破 0.85，被 `UnrealBloomPass` 抓住扩散成光雾。这是"模糊"的来源：不是分辨率糊，是 bloom 把边密集区糊成发光雾团。透明度调多低都没用，边数量不减叠加总能突破阈值。

**解**：总览（相机远）关 bloom pass → 边叠加区不扩散，结构骨架锐利。聚焦（相机近）开 bloom → 节点 hover/选中高亮时发光鲜明。用相机到 target 距离 vs `_graphRadius` 判断，加滞回阈值防抖。

---

## 改动总览（3 步，约 25 行）

| 步 | 内容 | 位置 |
|---|---|---|
| G1 | 新增 bloom 状态字段 + 滞回阈值常量 | graph.ts 字段区 |
| G2 | 新增 _updateBloomByDistance 方法 | graph.ts |
| G3 | animate 循环调用 _updateBloomByDistance | graph.ts animate |

---

## G1 — 新增字段

**位置** `graph.ts:838`（`private _graphRadius = 1000;`）之后。

当前：
```ts
  private _graphRadius = 1000;
```

在其后追加：
```ts
  private _graphRadius = 1000;
  // ponytail: 总览关 bloom 防边密集区雾化; 聚焦开 bloom 让 hover 发光鲜明。滞回防抖。
  private _bloomFar = false;
  private _bloomHysteresis = 0; // 0=稳态, 正值刚切换倒计时防回弹
```

> `_bloomFar` = 当前是否处于"远距离 bloom 关闭"态。`_bloomHysteresis` = 切换后若干帧内不再反向切换，防相机在阈值附近抖动时反复加/删 pass。

---

## G2 — 新增 _updateBloomByDistance 方法

**位置** `graph.ts:2810` 附近（`setFoldMode` 方法里两处 bloom 管理之后，`toggleFold` 之前）。找一个稳定的位置插入 —— 在 `toggleFold` 方法定义之前插入。

搜索 `toggleFold(): void { this.setFoldMode(!this.foldMode); }` 这行，在它**之前**插入新方法：

```ts
  // ponytail: 总览(相机距 target > graphRadius*2.2)关 bloom 防边密集叠加区被 bloom 扩散成雾;
  // 聚焦(< graphRadius*1.6)开 bloom 让 hover/选中节点发光鲜明。滞回 30 帧防阈值抖动回弹。
  private _updateBloomByDistance(): void {
    if (this._graphRadius < 1 || this.foldMode) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const farThresh = this._graphRadius * 2.2;
    const nearThresh = this._graphRadius * 1.6;
    const hasBloom = this.composer.passes.indexOf(this.bloomPass) !== -1;
    if (this._bloomHysteresis > 0) { this._bloomHysteresis--; return; }
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

```

> 两个阈值（far 2.2 / near 1.6）形成滞回带：从远拉近需到 1.6× 才开 bloom，从近拉远需到 2.2× 才关。带内不切换，防抖。`_bloomHysteresis=30`（约 0.5s @60fps）切换后锁定，防阈值附近反复加/删 pass。
>
> `this.foldMode` 时直接 return —— fold 模式有自己的 bloom 管理（`setFoldMode` 2805/2825），不抢它的控制权。
>
> 初始态：bloom 默认在（`946` 行构造时已 addPass），`_bloomFar=false`。首次总览若 `dist > farThresh` 会在第一帧切到关 —— 符合"总览关 bloom"的预期。

---

## G3 — animate 循环调用

**位置** `graph.ts:4900`（`if (!IDLE || this._idleCounter % 4 === 0) {` 块）之后、`updateFocus` 之前或之后均可。

当前 4900-4903：
```ts
    if (!IDLE || this._idleCounter % 4 === 0) {
      try { this.updateHover(); } catch { /* hover must never crash the animation loop */ }
      try { this.updateFocus(); } catch { /* ditto */ }
    }
```

替换为：
```ts
    if (!IDLE || this._idleCounter % 4 === 0) {
      try { this.updateHover(); } catch { /* hover must never crash the animation loop */ }
      try { this.updateFocus(); } catch { /* ditto */ }
      try { this._updateBloomByDistance(); } catch { /* bloom switch must never crash loop */ }
    }
```

> 放在 `% 4` 节流块里（~15Hz），不需要每帧检查相机距离。try/catch 和 hover/focus 一致，bloom 切换崩溃不杀循环。

---

## 验证清单

```powershell
cd src-ui
npx tsc --noEmit
npx eslint src/ui/graph.ts
npm run build
```

体验验收：
- [ ] 总览（默认加载后）画面锐利，边密集区**不**发雾/模糊，能看到清晰的结构骨架
- [ ] 拉近到节点附近（< 1.6× graphRadius）→ bloom 开启，hover 节点发光晕扩散鲜明
- [ ] 拉远回到总览（> 2.2×）→ bloom 关闭，画面恢复锐利
- [ ] 在阈值附近缓慢推拉 → 不会反复闪烁（滞回 + 30 帧锁定生效）
- [ ] 进入 fold 模式 → bloom 行为不受本改动影响（仍由 setFoldMode 管理）
- [ ] 帧率正常（addPass/removePass 不应造成掉帧；若掉帧改用 G2-alt）

---

## 备选：G2-alt（不增减 pass，只调 bloom 参数）

若 G2 的 addPass/removePass 造成掉帧或闪烁，用参数动态调整替代（同样效果，不增减 pass）：

G1 字段改成：
```ts
  private _bloomFar = true; // 默认总览态先按"远"处理, 首帧调参
  private _bloomHysteresis = 0;
```

G2 方法替换为：
```ts
  private _updateBloomByDistance(): void {
    if (this._graphRadius < 1 || this.foldMode) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const farThresh = this._graphRadius * 2.2;
    const nearThresh = this._graphRadius * 1.6;
    if (this._bloomHysteresis > 0) { this._bloomHysteresis--; return; }
    if (this._bloomFar) {
      if (dist < nearThresh) {
        this._bloomFar = false;
        this.bloomPass.threshold = 0.85; this.bloomPass.strength = 0.35; this.bloomPass.radius = 0.3;
        this._bloomHysteresis = 30;
      }
    } else {
      if (dist > farThresh) {
        this._bloomFar = true;
        // ponytail: threshold 0.98 几乎禁用 bloom 抓取, strength 压到 0.05 兜底; 总览锐利
        this.bloomPass.threshold = 0.98; this.bloomPass.strength = 0.05; this.bloomPass.radius = 0.1;
        this._bloomHysteresis = 30;
      }
    }
  }
```

> 保留 pass 始终在链里，只调参数。总览 threshold 0.98 + strength 0.05 实际等于"几乎关 bloom"但不删 pass，避免 add/remove 的潜在帧抖。效果与 G2 主方案一致，性能更稳。**推荐先试 G2 主方案，有问题换 G2-alt。**

---

## 不在范围
- 不做边 LOD（用户明确拒绝）。
- 不改边透明度/配色（B 档已定 m=0.10 保持低）。
- 不改 fold 模式 bloom 逻辑（setFoldMode 独立管理）。
- 不改节点发光晕（Sprite AdditiveBlending 保留，总览无 bloom 时晕仍可见只是不扩散）。

## 回滚
- G3：删 animate 里的 `_updateBloomByDistance()` 调用行。
- G2：删 _updateBloomByDistance 方法。
- G1：删 _bloomFar/_bloomHysteresis 字段。
- bloom pass 回到构造时默认始终在链中。
