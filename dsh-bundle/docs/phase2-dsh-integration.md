# 阶段2 · 3D 视图接进 DSH web —— client-plugin 集成规格（唯一事实来源）

> 状态：渲染 + 实时数据链 + 侧边栏入口全部跑通并内嵌 DSH（/hologram 同源自托管）。
> 本文件是机制事实来源与恢复步骤。

## DSH client-plugin 机制（已验证的事实）

bundle 的浏览器包按以下契约接入：
1. 包 `package.json` 声明 `"dsh": { "client": { "inject": [...], "platform": "web" } }`
2. host 侧 `client-modules` node half 扫描 Loader 条目里声明 `dsh.client` 的包，
   把包导出 `./client` 作为浏览器包，serve 于 `/plugins/<id>/client.js`
3. 浏览器包是 **closure-factory** 形态（例 `@deepseek-ai/dsh-client-ui-sidebar/lib/client.js`）：
   ```js
   window.__ModuleLoader__.load({
     id: "<包名>",
     factory: (require) => { var module = {exports:{}}; /* require("react/jsx-runtime"), require("@deepseek-ai/...") 都在模块表里解析 */ ... return module.exports }
   })
   ```
4. 插件 body 用 `ctx.slots.inject('sidebar.<key>', () => ctx.slots.register({...}, ReactComponent))`
   注册侧边栏条目（参考 `ui-workspace` / `ui-settings`）。

## dsh-bundle 需要的产物
- `lib/client.js`：closure-factory 浏览器包（含「侧边栏入口 → 全屏 3D」逻辑）
- 侧边栏入口点击后：全屏打开 3D 视图。
  3D 视图实现方式二选一：
  - **嵌入 iframe**：iframe 指向 serve-graph+viewer 服务（最省事）
  - **原生 Canvas**：在 client 包里直接 bundle viewer 内核（重，但无独立服务依赖）

## 验收
在一个 `dsh web` boot 里：
- `/plugins/hologram-dsh/client.js` 可 fetch（200）
- 侧边栏出现该入口，点击全屏出 3D 星图，数据来自 `/graph?project=<当前 workspace>`

## 待定决策（实现前定）
1. client-plugin 源码放哪：`dsh-bundle/` 下自建 vs DSH checkout 内
2. 3D 视图嵌入方式：iframe 套独立服务 vs 原生 bundle 内核
3. 「当前 workspace」从哪来：**client 侧读 `ctx.sessions.list` 快照取当前会话 `cwd`**（点开按钮瞬间解析），无会话时回退 `FALLBACK_PROJECT`。✅ 已实现
## 关键发现（layout 槽位研究）
- `sidebar` 槽是 **single 占用**：谁注册谁整列替换（ui-sidebar 的 SidebarRoot 占着）。
  ui-sidebar 只在内部声明了 `workspace` / `settings` 两个座位。
  ⇒ **没有干净的「侧边栏加一个 3D 图标」的空槽**。要"加"而不是"替换"，得进内层座位
  （workspace/settings 面板内部），或改用 frame 级**可加性槽** `shell.overlay`
  （list、root 作用域、可点穿之上加浮层）——放一个「打开 3D 全屏」的浮动按钮。
- 全屏 3D 视图本身仍是 iframe 套 viewer / 或原生 Canvas 二选一。
## 如何激活（GUI 重启，含恢复 web profile 的 hologram-dsh）

> 因 running GUI 持有已装包文件句柄，web profile 的 `hologram-dsh` 无法在运行中重装
> （EPERM: rename）。机制本身已验证（web boot 能解析 clientPath）。激活需重启：

```sh
# 1. 停掉 dsh web（Ctrl+C / 结束进程）
# 2. 在 DSH checkout 重新安装（拿回 web profile 里的 hologram-dsh + 侧边栏入口）：
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add file:D:/HoloGramHG/dsh-bundle
# 3. 确认 manifests 含 hologram-dsh（bundles 列表）
node --import tsx/esm apps/cli/src/bin.ts --profile web --dump-config | findstr hologram
# 4. 重启 dsh web
```

重启后：
- 阶段1 引擎工具回来（mcp__hologram__*）
- 侧边栏底部出现「3D 星图 / 🌌」按钮 → 全屏打开 viewer（?project= 实时分析）

## 重要约束（我跑在 GUI 里，无法自己重启它）

- 我已把更新后的 bundle（含 `lib/client.js` 侧边栏插件）在 **`hologram-cli` 测试 profile** 完整装好并验证
  （web boot → clientModules → clientPath 命中 `hologram-dsh/lib/client.js`）。
- **`web` 真实 profile**：运行中的 GUI 进程持有 `web/node_modules/hologram-dsh/` 的文件句柄，
  `lib/` 无法在运行中替换（EPERM）。而本 agent **跑在这个 GUI 里**，故不能自己重启它。
- 因此 `web` 的更新只能在 **用户下一次自然重启 GUI 时**落位。运行中的 GUI 因模块已缓存仍继续工作。

### 用户在下次重启时执行的恢复（一条/两条）
```sh
# 停掉 dsh web 后：
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add file:D:/HoloGramHG/dsh-bundle
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web remove hologram-dsh   # 若残留，再 add 一次
dsh web  # 重启
```
重启后：阶段1引擎工具回来 + 侧边栏底部「3D 星图/🌌」按钮全屏 3D。
## 发货形态：DSH 自托管 /hologram（已完成并验证 ✅）

不依赖独立的 viewer(:5180) / serve-graph(:5190) 进程，改由 **hologram-dsh 的 host 插件在 DSH webserver 里注册同源路由**：

| 路由 | 作用 | 验证 |
|------|------|------|
| `/hologram/` | 提供 viewer SPA（index.html） | 200 |
| `/hologram/assets/*.js` | viewer 主包（744KB） | 200 |
| `/hologram/api/graph?project=` | 实时 analyze 一个项目 → GraphJSON | 200，37/86 |

实现：`src/index.ts` 扩展 host 插件 ——
- `createStaticHandler(viewerDist)`：托管 `viewer/dist`（SPA 回退）
- `createGraphHandler(bin)`：起引擎 TCP analyze+get_graph 内联（移植自 serve-graph）
- `registerWebRoutes`：`ctx.webServer.register({kind:'prefix'|'exact', path, handler})`
- `inject = { webServer?: true }` 可选注入，headless profile 安全跳过

侧边栏入口 iframe → 同源 `/hologram/?project=`（无 CORS/端口依赖）。

> 发货前仍需用户重启 GUI 部署（live web profile 的 node_modules 拷贝需 remove+add 刷新，跑完 add 见后注）。


## 侧边栏入口：分析目标跟随当前会话工作区（2026-08-14 改进）

`src/client/index.tsx` 不再写死 DEFAULT_PROJECT，改为**点开按钮的瞬间**解析 `ctx.sessions.list`
快照里「当前会话的 cwd」作为 `?project=`（跟随正在工作的项目），取不到时回退到 `FALLBACK_PROJECT`
（默认 `D:/HoloGramHG`）。`viewer/main.ts` 同源调 `/hologram/api/graph?project=`。

## host 侧数据生命周期：单一长驻引擎（2026-08-14 重写）

早期实现每次 /hologram/api/graph 请求都临时 spawn 一个新引擎全量 analyze 再杀进程——
把引擎「分析一次、反复查询」的数据生命周期整个绕过了，每次打开都是 20s 全量扫描。
现改为与 Tauri 一致的长驻引擎模型：

- host 插件保持**一个长驻引擎进程**（TCP 9777）
- `analyze` 只在**首次 / 换项目 / `?refresh=1`** 时发生
- 其余请求直接 `get_graph`（读引擎内存，毫秒级）
- 请求串行化（同一时刻一个未完成请求），引擎崩溃自动重启

**需重启 GUI 让新 host 模块（lib/index.mjs）落位后才生效。**

### 与 MCP 引擎的关系（重要）

MCP 工具（34 个 mcp__hologram__*）走 `hologram-mcp` 的 stdio 长驻引擎；viewer 走 host
插件的 TCP 长驻引擎。两者是**独立进程、独立分析**——各自的 re-analyze 不互通。
但它们现在都遵守同一生命周期：分析一次、反复查询，不再每次请求全量重扫。