# hologram-dsh · viewer — HoloGram 深空星图

DSH web 的 3D 依赖星图查看器。**渲染内核不再维护副本**：`vite.config.ts` 通过
`@hologram-kernel` alias 直接构建 `src-ui/src/ui` 的 `StarGraph` 全套模块，
与 HoloGram 主应用同源，主仓改内核后这里自动跟随。

只把 4 处 app 耦合替换成 `kernel/stubs/` 的轻量桩：

- `shell-store`：statusText / setStatusText / setGraphStats 最小面
- `events`：bus on/off/emit
- `debug`：静默 dbg
- `app-shell`：navigateToFile / queryAgent no-op

`i18n` 是纯翻译表，直接使用 `src-ui/src/i18n.ts` 原件。

## 怎么跑

前置：`dsh-bundle` 已装好 devDeps（`npm install --ignore-scripts`），`src-ui` 已装好依赖。

```sh
# 开发
cd dsh-bundle/viewer
node ../../src-ui/node_modules/vite/bin/vite.js

# 生产构建（Release workflow 同款）
node ../../src-ui/node_modules/vite/bin/vite.js build
```

打开 **http://localhost:5180/**。默认读 `data.graph.json`；带 `?project=<path>` 时走
`/hologram/api/graph` 实时分析；`?data=<url>` 可换任意 GraphJSON。用
`dsh-bundle/scripts/dump-graph.mjs` 可重新导出 fixture 数据（路径自动推导，可用
`HOLOGRAM_ENGINE` / `HOLOGRAM_FIXTURE` 覆盖）。

## 数据契约

`GraphJSON`（nodes/edges/communities）来自引擎 `handle_analyze`/`handle_get_graph`，
类型定义就是 `src-ui/src/ui/graph-types.ts`（主仓唯一权威源）。

## 状态

- ✅ 渲染内核与主应用同源构建（44 模块，dist ~747KB）
- ✅ `?project` 同源 `/hologram/api/graph` + 会话缓存 + 120s 超时
- ⏳ 视觉验收与 DSH web 实测
