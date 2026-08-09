# Handoff: Linux WebKitGTK 辉光放大 Bug

## 日期
2026-07-22

## 问题
HoloGram 在 Linux (Wayland + WebKitGTK + Mesa/RadeonSI) 上运行时，hover 节点的辉光（glow）会被放大到整个屏幕大小。Windows 上完全正常。

## 环境
- OS: Ubuntu 24.04, Wayland
- GPU: AMD Radeon Graphics (radeonsi, renoir, ACO), Mesa 25.2.8
- WebView: WebKitGTK (Tauri v2 wry)
- Three.js WebGL: THREE.Points + ShaderMaterial + AdditiveBlending

## 已排除的原因
1. **Shader hover boost** — 完全注释掉 hover 的 alpha/size boost，仍然炸
2. **gl_PointSize clamp** — 写死 `pointScale=20`、`maxPointSize=32`，仍然炸
3. **Bloom 后处理** — 在 WebKitGTK 上完全关闭 UnrealBloomPass，仍然炸

## 根因判断
**WebKitGTK 的 WebGL 实现不正确处理 `gl_PointSize`。** 无论 shader 里设什么值，渲染出来的 point sprite 都远超设定大小。这是 WebKitGTK + Mesa/RadeonSI 的已知兼容问题。

`THREE.Points` 使用的是 WebGL 的 `gl.POINTS` 渲染模式，依赖 `gl_PointSize`。WebKitGTK 在这个配置下似乎不尊重 shader 里设置的值。

## 代码位置
- 辉光 shader: `src-ui/src/ui/graph-shaders.ts` → `makeGlowPointMaterial()`
- 辉光创建: `src-ui/src/ui/graph-node-renderer.ts` → `buildNodes()` (L174-L290)
  - inner glow: `THREE.Points` + `makeGlowPointMaterial(glowTex, 1.5, 1.0)`
  - outer glow: `THREE.Points` + `makeGlowPointMaterial(glowTex, 0.55, 0.85)`
- bloom 后处理: `src-ui/src/ui/graph.ts` L157-L168
- hover 交互: `src-ui/src/ui/graph-interaction-controller.ts` → `updateHover()`
- animate 循环里传 uniform: `src-ui/src/ui/graph-scene-lifecycle.ts` L961-L980

## 数值链条
- `getNodeBaseScale(i)` = `(0.6 + ratio * 2.8) * sizeMul` → 0.6 ~ 3.4
- `coreScale` = `baseScale * 0.35` → 0.21 ~ 1.19
- `glowSize` (inner) = `coreScale * 3.0` → 0.63 ~ 3.57
- `glow2Size` (outer) = `coreScale * 2.4` → 0.50 ~ 2.86
- shader: `gl_PointSize = size * combined * sizeMul * pointScale`，`pointScale = 28.0 * (300.0 / -mv.z)`

## 建议的修复方向

### 方案 A: Linux 上用 InstancedMesh 替代 Points（推荐）
- 把 `THREE.Points` 改成 `THREE.InstancedMesh`（跟 node core 一样）
- 用 `Matrix4` 控制 scale，不依赖 `gl_PointSize`
- 平台检测：`navigator.userAgent.includes('WebKit') && !navigator.userAgent.includes('Chrome')` 时用 InstancedMesh
- 工作量：~200 行，需要新建一个 `GlowInstancedMesh` 渲染器
- 优点：根本解决，不影响 Win/macOS
- 缺点：InstancedMesh 的 shader 跟 Points 完全不同，需要重写 vertex/fragment shader

### 方案 B: 用 Sprite 替代 Points
- `THREE.Sprite` 不依赖 `gl_PointSize`，用 `scale` 控制大小
- 但数量多时性能差（每个 Sprite 是独立 drawcall 或需要 SpriteMaterial）
- 可以用 `THREE.InstancedMesh` + billboard shader 模拟

### 方案 C: 降级渲染
- Linux 上直接不渲染 glow points，只保留 node core（小球体）
- 最简单但视觉退化严重

## 本次会话完成的其他工作
1. ✅ Provider 抽象层重构（factory + retry + catalog + 59 tests）
2. ✅ ModelSelector UI 组件（设置页面模型搜索下拉）
3. ✅ Linux 凭据加密（Secret Service / secret-tool）
4. ✅ Bubblewrap 沙箱启用
5. ✅ Linux 路径安全检查（/proc /sys /dev /boot /etc）
6. ✅ aura.dll → aura.so 平台修复
7. ❌ WebKitGTK 辉光放大（未解决，见上方方案）

## 代码状态
所有代码已 revert 到原始状态（shader、bloom、graph.ts、graph-fold.ts）。aura 平台修复保留。未提交 shader/bloom 的实验性改动。
