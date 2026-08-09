# 四个 BUG/体验修复（fold 退出边残留 / focus subgraph 退出白点 / 边透明度 / 节点筛选消失度）

> 给执行模型：每处改动给 **文件:行号** + **当前代码** + **替换代码**。按顺序执行，不改方案外代码。不加注释（除 `// ponytail:`），保持 2 空格缩进。
> 文件：`graph.ts` = `src-ui/src/ui/graph.ts`。

---

## 问题诊断（必读）

**问题 1（fold 退出边变显眼）**：`clearFoldOverlay`(3023-3025) 退出 fold 时只设 `lines.visible=true`，**没恢复 edge opacity**。`setFoldMode(false)`(2821-2830) 恢复了 bloom/tone mapping 但**完全没碰 edgeLineGroups 的 opacity**。退出后边用着进入 fold 前最后一刻的 opacity 值（可能被 focus/highlight/fold 内 constellation 提亮过），不是 `edgeOpacityByDepth` 的稳态低值 → 重新变得显眼。

**问题 2（focus subgraph 退出白点残留）**：`exitFocusSubgraph`(4476-4508) 恢复了 glow opacity 和 core visible，但：
- ① 没设 `this.focusNodeIdx = -1` → `updateFocus`(3642-3653) 的 flash 分支持续作用在 focus 节点，每帧套 scale×5.5 + 高 opacity；
- ② `restoreFocusNode`(3661-3668) 的 800ms 定时器在 exit 后触发，只恢复 scale/opacity 不管 color；
- ③ focus 节点 glow color 在 enter 时被设白(4465)，exit 时 4496 恢复了，但 flash 分支持续提亮 opacity 让它仍是"大白点"；
- ④ 波及到的邻居节点 core color 可能在 focus 期间被 hover 循环提白(4914)，exit 没恢复 core color。
→ 所有波及节点停留"大白点"效果。

**问题 3（总览边仍太显眼）**：`edgeOpacityByDepth`(109-112) `m=0.10`，范围 0.004~0.022。用户反馈仍太高。既然现在有图例点击筛选指定边类型（D 档已实现），总览默认可以更淡。降 m 到 0.05（范围 0.002~0.011）。

**问题 4（节点筛选未选消失不彻底）**：`setNodeKindFilter`(2339) 未命中节点 glow opacity=0.04，**但 core 仅 `visible=false` 而 glow 仍以 0.04 可见**，且 glow2（外层大光晕）完全没处理仍可见 → 0.04 + 外晕叠加仍能看出未选节点轮廓。需把 glow 也降到更低 + 隐藏 glow2。

---

## 修复总览

| 步 | 问题 | 改动 |
|---|---|---|
| H1 | fold 退出边残留 | clearFoldOverlay 恢复 edge opacity |
| H2 | focus 退出白点 | exitFocusSubgraph 清 focusNodeIdx + 恢复 core color |
| H3 | 边仍太显眼 | edgeOpacityByDepth m 0.10→0.05 |
| H4 | 节点筛选消失不彻底 | setNodeKindFilter 未命中 glow 0.04→0.008 + 隐藏 glow2 |

---

## H1 — clearFoldOverlay 恢复 edge opacity

**位置** `graph.ts:3023-3025`。

当前：
```ts
    for (const lines of this.edgeLineGroups) {
      lines.visible = true;
    }
```

替换为：
```ts
    for (const lines of this.edgeLineGroups) {
      lines.visible = true;
      (lines.material as THREE.LineBasicMaterial).opacity =
        edgeOpacityByDepth((lines.userData['edgeDepth'] as number) ?? 0);
    }
```

> 退出 fold 时把每条边的 opacity 重置回 `edgeOpacityByDepth` 稳态低值，而不是保留 fold 进入前可能被提亮的值。`LineBasicMaterial` 和 `LineMaterial` 都有 `opacity` 字段，cast 用 `THREE.LineBasicMaterial`（LineMaterial 继承自它）或 `any` 均可——若 tsc 报错改 `as any`。

---

## H2 — exitFocusSubgraph 清 focusNodeIdx + 恢复 core color

**位置** `graph.ts:4476-4508`，整段替换。

当前：
```ts
  exitFocusSubgraph(): void {
    if (!this.focusSubgraphActive) return;

    for (let i = 0; i < this.graphNodes.length; i++) {
      if (i < this.focusSubgraphSavedGlowOpacities.length && this.nodeGlows[i]) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity =
          this.focusSubgraphSavedGlowOpacities[i];
      }
      if (i < this.focusSubgraphSavedCoreVisible.length && this.nodeCores[i]) {
        this.nodeCores[i].visible = this.focusSubgraphSavedCoreVisible[i];
      }
    }
    for (let ei = 0; ei < this.edgeLineGroups.length; ei++) {
      if (ei < this.focusSubgraphSavedEdgeOpacities.length) {
        (this.edgeLineGroups[ei].material as LineMaterial).opacity =
          this.focusSubgraphSavedEdgeOpacities[ei];
      }
    }
    // Restore focus node glow color
    if (this.focusSubgraphIdx >= 0 && this.focusSubgraphIdx < this.nodeGlows.length) {
      (this.nodeGlows[this.focusSubgraphIdx].material as THREE.SpriteMaterial).color.set(
        this.nodeGlowColors[this.focusSubgraphIdx]);
      (this.nodeGlows[this.focusSubgraphIdx].material as THREE.SpriteMaterial).opacity = 0.55;
    }
    // Clear focus edges
    while (this.highlightEdgeGroup.children.length)
      this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);

    this.focusSubgraphActive = false;
    this.focusSubgraphIdx = -1;
    this.focusSubgraphVisibleIndices.clear();
    this.focusSubgraphBanner.style.display = 'none';
  }
```

替换为：
```ts
  exitFocusSubgraph(): void {
    if (!this.focusSubgraphActive) return;

    // ponytail: 必须清 focusNodeIdx/focusActive/focusFlash, 否则 updateFocus 的 flash 分支
    // 持续套 scale×5.5+高 opacity 在 focus 节点, 且 restoreFocusNode 定时器恢复 scale 不管 color → 白点残留
    this.focusActive = false;
    this.focusFlash = 0;
    this.focusNodeIdx = -1;

    for (let i = 0; i < this.graphNodes.length; i++) {
      if (i < this.focusSubgraphSavedGlowOpacities.length && this.nodeGlows[i]) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity =
          this.focusSubgraphSavedGlowOpacities[i];
      }
      if (i < this.focusSubgraphSavedCoreVisible.length && this.nodeCores[i]) {
        this.nodeCores[i].visible = this.focusSubgraphSavedCoreVisible[i];
      }
      // ponytail: 恢复 core color — focus 期间节点可能被 enter 设白或被 hover 循环提白
      if (this.nodeCores[i] && i < this.nodeCoreColors.length) {
        this._setCoreColor(i, this.nodeCoreColors[i]);
      }
      // 恢复 glow color — focus 节点被 enter 设成 0xffffff
      if (this.nodeGlows[i] && i < this.nodeGlowColors.length) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).color.set(this.nodeGlowColors[i]);
      }
    }
    for (let ei = 0; ei < this.edgeLineGroups.length; ei++) {
      if (ei < this.focusSubgraphSavedEdgeOpacities.length) {
        (this.edgeLineGroups[ei].material as LineMaterial).opacity =
          this.focusSubgraphSavedEdgeOpacities[ei];
      }
    }
    // Clear focus edges
    while (this.highlightEdgeGroup.children.length)
      this.highlightEdgeGroup.remove(this.highlightEdgeGroup.children[0]);

    this.focusSubgraphActive = false;
    this.focusSubgraphIdx = -1;
    this.focusSubgraphVisibleIndices.clear();
    this.focusSubgraphBanner.style.display = 'none';
  }
```

> 变更点：① 开头清 `focusActive/focusFlash/focusNodeIdx` 终止 updateFocus flash 分支；② 循环里恢复所有节点的 core color（用 `nodeCoreColors[i]` 稳态值）和 glow color（用 `nodeGlowColors[i]`），不只 focus 节点；③ 删掉原来单独恢复 focus 节点 color 的块（已合并进循环，且原块设 opacity=0.55 会覆盖 saved 值，是 bug）。

> 验证 `nodeCoreColors` 和 `nodeGlowColors` 字段存在：搜索 `private nodeCoreColors` 和 `private nodeGlowColors` 确认。它们在 buildNodes 时 push（4254/4253 附近），长度 = 节点数，索引对齐。

---

## H3 — 边默认透明度再降

**位置** `graph.ts:109-112`。

当前：
```ts
function edgeOpacityByDepth(depth: number): number {
  const m = 0.10; // dark-universe: subtle web, brightens on hover/highlight
  switch (depth) { case 1: return 0.04 * m; case 2: return 0.11 * m; case 3: return 0.17 * m; case 4: return 0.22 * m; default: return 0.08 * m; }
}
```

替换为：
```ts
function edgeOpacityByDepth(depth: number): number {
  // ponytail: m 0.10→0.05 总览更淡; 现在有图例点击筛选指定边类型, 总览无需承担边类型辨识
  const m = 0.05;
  switch (depth) { case 1: return 0.04 * m; case 2: return 0.11 * m; case 3: return 0.17 * m; case 4: return 0.22 * m; default: return 0.08 * m; }
}
```

> 范围从 0.004~0.022 降到 0.002~0.011。总览边更淡，结构骨架仍可见但不喧宾夺主。边类型辨识靠图例点击筛选（D 档）+ hover 提亮（B3），不靠默认透明度。若仍觉得太显眼，m 调到 0.03；太淡看不清结构，m 调到 0.07。

---

## H4 — 节点筛选未选消失更彻底

**位置** `graph.ts:2336-2341`。

当前：
```ts
    for (let i = 0; i < this.nodeGlows.length; i++) {
      const kind = ((this.graphNodes[i]?.type || this.graphNodes[i]?.kind || 'symbol') as string);
      const hit = matches(kind);
      (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = hit ? 0.88 : 0.04;
      if (this.nodeCores[i]) this.nodeCores[i].visible = hit;
    }
```

替换为：
```ts
    for (let i = 0; i < this.nodeGlows.length; i++) {
      const kind = ((this.graphNodes[i]?.type || this.graphNodes[i]?.kind || 'symbol') as string);
      const hit = matches(kind);
      (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = hit ? 0.88 : 0.008;
      if (this.nodeCores[i]) this.nodeCores[i].visible = hit;
      // ponytail: 外层大光晕 glow2 也隐藏, 否则未选节点仍有可见的大圆轮廓
      if (this.nodeGlows2[i]) this.nodeGlows2[i].visible = hit;
    }
```

> 变更点：① 未命中 glow opacity 0.04→0.008（几乎不可见）；② 隐藏未命中节点的 `nodeGlows2`（外层大光晕，buildNodes 4241 创建，scale×16 很大，不隐藏会留明显圆轮廓）。命中节点 glow2 保持 visible=true（已在 fold 退出时恢复，或本就可见）。

**同步改 clear 分支**（filter === null 恢复时也要恢复 glow2）：

**位置** `graph.ts:2320-2324`。

当前：
```ts
    if (filter === null) {
      for (let i = 0; i < this.nodeGlows.length; i++) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.55;
        if (this.nodeCores[i]) this.nodeCores[i].visible = true;
      }
      this._updateLegendActive(this._edgeTypeFilter, null);
      return;
    }
```

替换为：
```ts
    if (filter === null) {
      for (let i = 0; i < this.nodeGlows.length; i++) {
        (this.nodeGlows[i].material as THREE.SpriteMaterial).opacity = 0.55;
        if (this.nodeCores[i]) this.nodeCores[i].visible = true;
        if (this.nodeGlows2[i]) this.nodeGlows2[i].visible = true;
      }
      this._updateLegendActive(this._edgeTypeFilter, null);
      return;
    }
```

---

## 验证清单

```powershell
cd src-ui
npx tsc --noEmit
npx eslint src/ui/graph.ts
npm run build
```

体验验收：
- [ ] **问题 1**：F 进 fold → ESC 退出 → 边恢复到淡的稳态（不比进 fold 前显眼）
- [ ] **问题 2**：点节点详情"波及图" → 进入 focus subgraph → 点 banner 或 ESC 退出 → 所有节点恢复正常颜色（无白点残留），focus 节点不再被持续放大
- [ ] **问题 3**：总览边比之前更淡（结构骨架仍可见但不抢眼）
- [ ] **问题 4**：图例点某节点类型（如"类"）→ 只剩 class 节点亮，其他节点**完全**看不出轮廓（无残留外晕）；再点取消 → 全部恢复
- [ ] hover 节点仍能提亮关联边（B3 的 0.6 opacity 不受 H3 默认降低影响）
- [ ] 图例点边类型筛选仍正常（setEdgeTypeFilter 用固定 0.5 不受 H3 影响）

---

## 不在范围
- 不改 fold 进入时的边处理（applyFoldOverlay 隐藏边是对的，问题只在退出恢复）。
- 不改 focus subgraph 进入逻辑（enter 的保存和 dim 逻辑正确，问题只在 exit 恢复不全）。
- 不改 bloom 总览/聚焦切换（G 档方案独立）。
- 不改边粗细（C 档 Line2 独立）。

## 回滚
- H1：还原 clearFoldOverlay 的边循环只设 visible=true。
- H2：还原 exitFocusSubgraph 到原版（删 focusNodeIdx 清除 + color 恢复循环）。
- H3：m 改回 0.10。
- H4：未选 opacity 改回 0.04，删 glow2 visible 处理。
