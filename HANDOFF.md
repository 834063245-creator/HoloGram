# Handoff — HoloGram（2026-06-27）

## 当前状态

- **引擎**：全量 Linux kernel 压测预计 ~420s（rayon N-1 自适应），community 171s
- **前端**：InstancedMesh + Points 渲染已落地，draw call 从 210K → 3
- **构建**：引擎 `cargo build --release` 通过，前端 `npm run build` 通过，`cargo tauri build` 通过

---

## 本次变更（2026-06-27）

### 引擎：rayon 自适应

`engine/src/main.rs:27-33`：线程数从固定 N-2 改成自适应：
- 日常/N-1 模式：保留 1 核给 UI，4 核机器 3 线程（75%），32 核 31 线程（97%）
- stress 模式（`--stress`/`--stress-real`/`--stress-suite`）：用满全部核
- `engine-bin/hologram-engine.exe` 已同步更新

### 前端：InstancedMesh + Points 合批渲染

**文件：`src-ui/src/ui/graph.ts`**

问题：每个节点 3 个独立 GPU 对象（核心球 Mesh + 内辉光 Sprite + 外辉光 Sprite），7 万节点 = 21 万 draw call，总览卡死。

方案：
- 核心球 → `THREE.InstancedMesh`（1 draw call，MeshBasicMaterial 共享）
- 内辉光 → `THREE.Points` + 自定义 ShaderMaterial（per-point RGBA，additive blending）
- 外辉光 → 第二个 `THREE.Points`（renderOrder -1，更暗更大）

**关键数据结构（line 865-880）：**
```
nodeCoresInstanced: THREE.InstancedMesh     // 核心球
nodeGlowsPoints: THREE.Points               // 内辉光
nodeGlows2Points: THREE.Points              // 外辉光
_coreScales: Float32Array(N)                // CPU 侧每核心 scale
_glowRgba: Float32Array(N*4)                // CPU 侧每辉光 RGBA
_glow2Rgba: Float32Array(N*4)               // CPU 侧每外辉光 RGBA
_nodeCount: number                          // 总节点数
```

**Wrapper 函数（line ~2510）**——所有旧代码通过它们透明操作 batched buffer：
- `_setCoreColor(i, c)` — 写 InstancedMesh.instanceColor
- `_setCoreScale(i, s)` — 改 instance matrix scale（s=0 隐藏实例）
- `_setCoreVisible(i, v)` — 封装 scale=0 隐藏逻辑
- `_setGlowRgba(i, r, g, b, a)` / `_setGlowColor(i, c, a)` / `_setGlowAlpha(i, a)` — 写辉光 RGBA buffer
- `_setGlow2Rgba` / `_setGlow2Alpha` — 外辉光同上
- `_flushBatch()` — 标记所有 buffer needsUpdate

**已适配的消费者函数：**
- `buildNodes` — 完全重写，输出 InstancedMesh + Points
- `animate` 每帧节点循环 — 走 wrapper 写 buffer
- `onClick` raycaster — `intersectObject(instancedMesh)` 用 `instanceId` 定位
- `highlightPathNodes` / `clearPath`
- `updateBlastNodeColors` / `exitBlastMode`
- `applyFoldOverlay` / `clearFoldOverlay` / `_showConstellation`
- `updateFocus` / `restoreFocusNode`
- `rescaleByMode`
- `setAgentLens` / `clearAgentLens`
- `clearHotspots`
- `_applyFileHighlight`
- `_startProgressiveReveal` — 用 `InstancedMesh.count` 控制渐显进度
- `clearGraph` / `destroy` — dispose batched 对象

**已知退化（可接受）：**
- 核心球失掉了原来的菲涅尔 ShaderMaterial（白色中心 + 彩色边缘），现在是 MeshBasicMaterial 纯色。视觉效果略微不同，但 70K→1 draw call 值
- 辉光 per-point 尺寸现在是 uniform（Points shader 的 gl_PointSize），原来每个 Sprite 有独立 scale。twinkle 效果还在（alpha 变化），但大小不变
- `updateHover` 射线检测从 `intersectObjects(array)` 改为 `intersectObject(instancedMesh)`，返回 `instanceId` 替代 `indexOf`

---

## 测试

- TypeScript: `npx tsc --noEmit` — 零错误
- 前端构建: `npm run build` — 通过
- Tauri 全量构建: `cargo tauri build` — 通过
- 引擎: `cargo build --release` — 通过，warning 仅 unused
- `community::louvain`: 14/14 pass
- ⚠️ 实际渲染未做视觉测试——需要打开 app 加载项目确认星图正常

---

## 文件变动

| 文件 | 变更 |
|------|------|
| `engine/src/main.rs` | rayon 自适应（N-1 日常 / N stress） |
| `engine-bin/hologram-engine.exe` | 同步更新 |
| `src-ui/src/ui/graph.ts` | InstancedMesh + Points 合批（~200 行重写 + 80+ 处批量替换） |
| `.gitignore` | + `engine/tmplinux-stress/` |
| `HANDOFF.md` | 本文档 |

---

## 下一步

1. **视觉验证**：启动 app，加载一个项目，确认星图渲染正常（核心球、辉光、hover、点击、折叠模式）
2. **性能验证**：加载 hermes（7 万节点）或 kernel，观察总览 FPS——预期从 5-10fps → 30-60fps
3. **恢复菲涅尔（可选）**：如需原核心球效果，把 InstancedMesh 的 MeshBasicMaterial 换成支持 `instanceColor` 的自定义 ShaderMaterial
4. **Leiden refinement 调优（可选）**：`louvain.rs` 中 refinement 代码保留但未启用，启用方式：`detect_communities` 调用 `run_leiden` 替代 `run_louvain`
5. **LSP 优化（低优先级）**：LSP 阶段 ~140s 还有空间
