# hologram-dsh · viewer — HoloGram 深空星图（阶段2）

一个自包含 3D 依赖星图查看器，**直接使用 HoloGram 完整的 `StarGraph` 渲染内核**
（vendor 副本在 `viewer/kernel/`），由引擎 `GraphJSON` 数据渲染。

## 这次改了什么（完整还原，不再简版）

上一版只有星场/星云装饰 + 简版点精灵。这次把 **`StarGraph` facade + 全部渲染子模块**
字节级复制进 `viewer/kernel/`：

- 节点渲染 `graph-node-renderer.ts`（菲涅尔渐变核心层 + glow 点 + 实例化辉光 `graph-glow-instanced.ts`）
- 边渲染 `graph-edge-renderer.ts`（three `LineSegments2` 流光线，按类型/深度/宽度着色）
- 布局 `graph-layout.ts`（LOCKED 参数，未动）+ `gpu-layout.ts`（WebGPU，含 CPU 回退）
- 自定义着色器 `graph-shaders.ts`
- 折叠星团 `graph-fold.ts`、聚焦 `graph-focus-controller.ts`、交互 `graph-interaction-controller.ts`
- 标签 `graph-labels.ts`、tooltip/详情卡 `graph-tooltip.ts`、图例 `graph-ui.ts`
- 深空装饰 `graph-scene.ts` / 贴图 `graph-textures.ts` / 颜色 `graph-colors.ts`
- 星图门面 `graph.ts`（StarGraph）

唯一的改动：把 HoloGram app 耦合的 4 处换成 `kernel/stubs/` 的轻量桩——`shell-store`
（只留 statusText/setStatusText/setGraphStats）、`events`（bus on/off/emit）、`i18n`
（`kernel-i18n.ts` 原样复制，本来就是纯翻译表）、`app-shell`（navigateToFile/queryAgent no-op）。
**渲染逻辑零改动。**

## 怎么跑

1. 已有引擎导出的 `data.graph.json`（`engine/fixtures/test_project` 37 节点/86 边）。
2. 起 Vite：

```sh
D:\HoloGramHG\src-ui\node_modules\.bin\vite.cmd --port 5180
cd D:\HoloGramHG\dsh-bundle\viewer
```

打开 **http://localhost:5180/**。换数据：`?data=<url>`；用 `scripts/dump-graph.mjs`
对任意项目重新导出。

## 数据契约

`GraphJSON`（nodes/edges/communities）来自引擎 `handle_analyze`/`handle_get_graph`，
与 `kernel/graph-types.ts` 对齐。

## 状态

- ✅ 完整 `StarGraph` 内核编译 + 生产构建通过（44 模块，dist/ ~746KB）
- ✅ 开发服务器 serving 全部内核模块（graph.ts 71KB、graph-layout 83KB…）
- ⏳ **视觉验收**：请打开 localhost:5180 看质感是否与 HoloGram 原版一致
- ⏳ 挂 DSH web 形态（A 嵌三栏 / B 独立视图）待定
> **大项目注意**：`?project=完整仓库` 时引擎全量分析可能耗时 20s+（如 `D:/HoloGramHG` 6528 节点约 20s）。
> viewer 已加进度提示（"正在分析项目…"）与 120s 超时，不再静默 loading。
> 默认项目是 `D:/HoloGramHG`，可从 `src/client/index.tsx` 的 `DEFAULT_PROJECT` 改。
