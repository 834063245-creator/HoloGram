# 兰台（Lantai）插件开发指南

> 给所有想写插件、贡献插件的人——不管你是兰台仓库内的开发者，还是只想
> 基于已装好的应用写一个自己的插件。**从这里开始，最快 15 分钟跑通。**
>
> 本文件是「入门 + 路径」文档：自包含到能照着写一个最小插件，深水区全部
> 链到权威文档（单一事实源，不在这里复制正文）。
> 权威契约全集：`docs/plugins/README.md` · 各 seam 指南：`docs/cookbook/`
> · 发布路径：`docs/user/develop/publishing-plugins.md`。
> 想扩展的是**图谱引擎**（Rust 侧，非兰台插件系统）→ 免编译扩展面
> `examples/engine-plugins/`（manifest 声明语言/框架/工具，契约 `docs/agents/engine-plugin-contract.md`）。

## 插件是什么（30 秒）

兰台是插件化架构。**面板、命令、工具、LLM 协议适配器、块渲染器、system-prompt
段、管道钩子、会话级能力、画布覆盖层、App 外壳视图槽、工作区接线、壳行
——全部贡献通道**（**计数与完整清单见 `docs/agents/service-catalog.md`**）**加上五条可换实现的后端
seam（fs/shell/sessionPersistence/subagents/agentLoop）——全部是插件贡献**，
第一方和第三方走同一套通道（**同一个注册表内核** `ContributionChannel`：
id 寻址 + 重名装载期拒绝 + 幂等 disposer + 声明式生效时机）。你写一个插件 =
一个目录 + 两个文件，经设置面板「插件」tab 或磁盘目录装载，就能向宿主注册这些
贡献。

插件形态两种，任选：

| 形态 | 是什么 | 典型用途 |
|---|---|---|
| **自包含 ESM 插件** | `manifest.json` + `entry.js`（自包含模块） | 面板 / 命令 / 工具 / LLM adapter / 块渲染器 / prompt 段 / 钩子 / capability / 覆盖层 / seam provider |
| **外部 MCP server** | manifest 声明式挂接 `mcpServers` | 把已有的 MCP server（Node/Python/任意进程）接进来，零插件代码 |

## 最快路径：从零到跑通（15 分钟）

最小插件就两个文件。目录名 = `manifest.json` 里的 `name`：

```
~/.lantai/plugins/quick-panel/
├── manifest.json
└── entry.js
```

`manifest.json`：

```json
{
  "name": "quick-panel",
  "version": "1.0.0",
  "description": "一个面板 + 一条命令的最小插件",
  "entry": "entry.js",
  "inject": ["panels", "commands"]
}
```

`entry.js`（**必须自包含：零裸 import**——插件运行时没有包管理器也没有
import map，`import 'react'` 这类解析不了。需要 UI 或通知走宿主桥）：

```js
// 宿主桥：createElement 构造 React 组件（无 JSX）；notify 弹状态栏通知
const host = globalThis.__lantai_plugin_host__;
const ce = host?.createElement ?? ((type, props, ...children) => ({ type, props: { ...props, children } }));

export default {
  name: 'quick-panel',
  inject: ['panels', 'commands'],
  apply(ctx) {
    // 通道 1：面板（装载后即时生效）
    ctx.effect(
      () =>
        ctx.panels.register({
          id: 'quick-panel',
          side: 'right',
          title: '快捷',
          icon: 'agent',
          component: () => ce('div', { style: { padding: 16 } }, 'Hello from quick-panel'),
        }),
      'quick-panel',
    );
    // 通道 2：命令（装载后即时生效；命令面板 Ctrl+K 可搜到）
    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'quick/say-hi',
          label: '快捷：打个招呼',
          group: '插件',
          shortcut: '/hi',
          action: { type: 'local', handler: () => { if (host?.notify) host.notify('👋 来自 quick-panel'); } },
        }),
      'quick-command',
    );
  },
};
```

**装载**（三选一）：

1. 设置面板 →「插件」→ 安装框填这个目录的绝对路径 → 安装 → 重启应用；
2. 或把 `quick-panel/` 整个放进 `~/.lantai/plugins/`，重启应用；
3. 或打包成 tarball / 发布到 npm，安装框填路径 / 包名。

**验证**：重启后右侧 dock 出现「快捷」面板；Ctrl+K 搜「快捷」执行命令弹通知。
然后到设置面板「插件」tab，你会看到它列在「已安装」里，可禁用/卸载。

完整三通道 + 声明式工具的示例：`examples/plugins/hello/`（它的 README 声明
「只读这一个文件就能装上、看到、干净卸载」——卡在哪一步就是文档缺口）。

## 平台契约速览

### manifest.json 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | npm scope 风格 id，≤2 段（`hello` / `acme/foo`），小写字母数字连字符 |
| `version` | ✅ | semver（`1.0.0`） |
| `entry` | ✅ | 相对 ESM 路径，`.js`/`.mjs` 结尾，禁绝对路径/`..` |
| `description` | | 插件列表展示的一句话 |
| `inject` | | 依赖的 ctx 服务名（如 `["panels","commands","tools"]`），装载期校验存在性 |
| `permissions` | | 声明所需权限类（`read`/`edit`/`bash`/`git`/`web`），未授予 → 不装载（blocked） |
| `tools` | | 声明式工具（见下），执行函数在 `entry.js` 的 `toolHandlers` 命名导出 |
| `mcpServers` | | 声明式挂接外部 MCP server（见下） |

### entry.js 的规则

- `export default { name, inject?, apply(ctx) }`（或命名导出同形状对象；`toolHandlers` 是声明式工具的保留命名导出）。
- `apply(ctx)` **只做注册动作**（装载期禁止任何 UI 副作用）。
- 每个注册的返回值（disposer）必须经 **`ctx.effect(() => disposer, '标签')` 登记**——这是插件生命周期的全部纪律：fiber 卸载即链式回收全部贡献。
- **自包含**：零裸 import；需要 React 用 `window.__lantai_plugin_host__.createElement`（无 JSX、无 hook）；需要状态栏通知用 `.notify(text)`。

### 贡献通道（九条）与可换后端（seam，五条）

| ctx 通道 | 贡献什么 | 生效时机（各通道声明的 `timing`） |
|---|---|---|
| `ctx.panels` | 面板（右侧 dock / 全屏覆盖） | 装载后即时（`immediate`） |
| `ctx.commands` | 命令（命令面板 Ctrl+K） | 装载后即时（`immediate`） |
| `ctx.overlays` | 画布覆盖层（视口固定槽位：创作坞 / 右缘窄条） | 装载后即时（`immediate`） |
| `ctx.renderers` | 块渲染器（纸壳块体渲染，后注册胜 + `*` 兜底） | 渲染期每帧重取（`frame`） |
| `ctx.tools` | 模型工具（Agent 可调用） | 下次 Agent 装配（`next-assembly`） |
| `ctx.prompts` | system-prompt 段 | 下次 Agent 装配（`next-assembly`） |
| `ctx.hooks` | 工具管道钩子（enrich 富化 / preflight 预检） | 下次 Agent 装配（`next-assembly`） |
| `ctx.capabilities` | 会话级能力（`AgentCapability`，行 id = `.id`） | 下次 Agent 装配（`next-assembly`） |
| `ctx.llm` | LLM 协议适配器（`{ id, kind, label?, create(rt) }`；同 kind 后注册胜） | 请求期解析（`request`） |

**可换实现的后端（seam）**：`ctx.fs` / `ctx.shell` / `ctx.sessionPersistence` /
`ctx.subagents` / `ctx.agentLoop` —— 与上面九条**同一内核**（`ContributionChannel`），
差别只在消费语义：写一个 provider 就替换兰台的默认后端（Rust/engine 只是默认实现）。
各 seam 的注册 API 见 `docs/cookbook/`。
（`ctx.graph` 图分析 seam 随图谱功能全量退役，2026-09-09——同批删除了它的 cookbook。）

> **生效时差是平台契约，且由通道自己声明**（`timing` 四档：`immediate` /
> `next-assembly` / `request` / `frame`——2026-09-14 起是数据不是注释）。面板/命令/
> 覆盖层装载后即时；工具/prompt/hook/capability 等下次 Agent 装配（工具面变更 =
> 前缀缓存边界，只发生在会话边界）；LLM adapter 在请求期解析；渲染器每帧重取。
> 旧会话看不到新工具是纪律不是 bug——开新会话即可。
>
> **行的身份统一是 `id`**（npm scope 风格 `'<插件名>/<行名>'`）：全部贡献通道一律 `id`，
> capability 的历史字段名 `key` 已于 2026-09-14 退役（不留别名）。

### 声明式工具（manifest.tools，C11-1）

工具声明是可序列化的数据（装载期即知工具面、信任面更小），执行函数在
`entry.js` 的 `toolHandlers` 命名导出（name → 执行函数，一一对应）：

```json
"tools": [
  { "name": "hello_status", "description": "一句话状态", "parameters": { "type": "object", "properties": {} }, "readOnly": true }
]
```

```js
export const toolHandlers = { hello_status: async () => '装载正常' };
```

### 外部 MCP server（manifest.mcpServers）

声明式挂接外部进程，零插件代码：

```json
"mcpServers": [
  { "name": "engine", "transport": "stdio", "command": "./server.cjs", "args": ["--serve"], "failurePolicy": "lazy", "readOnly": true }
]
```

- `transport`：`stdio`（本地进程，command/args）| `http`（远程，url）；
- 相对路径（`./`）相对插件目录解析；
- `failurePolicy`：`lazy`（缺省，首装配连接，失败下次重试）| `startup-error`（装载期急连接，失败 = 插件 error）。
- `readOnly`：**可选**，该 server 全部工具的只读担保。缺省**不表态**——按远端
  `annotations.readOnlyHint` 判，远端也无声明则 **fail-closed 视为写**（plan 模式
  拦截 + 不进只读并行组）。写型 server 误声明 `true` 会重现「写动作绕过 plan 门禁」
  的旧洞；确为只读的 server 建议显式声明（判定真源 `resolveMcpToolReadOnly`）。
- 端到端例子：`examples/plugins/dataflow-mcp/`（声明了 `"readOnly": true`）；指南：`docs/cookbook/adding-an-mcp-server.md`。

## 本地开发与测试

- **开发目录**：`~/.lantai/plugins/<name>/`（Windows：`%USERPROFILE%\.lantai\plugins\`）。
- **安装三源**（设置面板「插件」tab）：本地目录路径 / tarball（URL 或 `.tgz` 路径）/ npm 包名（registry 缺省 `registry.npmjs.org`）。
- **运行时热重载（D6）**：装/卸/启用/禁用**即时生效**——面板/命令立刻出现或消失，工具在下次 Agent 装配体现；不用每次重启。
- **调试**：插件任何一步失败都不会炸应用（失败隔离），设置面板「插件」tab 会显示 `装载失败` 状态 + 错误信息；`blocked` 状态 = 权限声明未授予（见下）。
- **改 entry.js 后**：先卸载再重装（同版本重装被版本守卫拒绝），或手动删目录再放回。

## 发布

1. 插件目录加 `package.json`（`"files": ["manifest.json", "entry.js", "README.md"]`）。
2. `npm pack` 产 tarball → `npm publish --access public`。
3. 用户安装：设置面板输入包名 → registry 下载。
4. **版本守卫**：同名重装升级 = 原子换装；同版本/降级拒绝（`force` 显式逃生）。

完整路径：`docs/user/develop/publishing-plugins.md`。

## ⚠️ 安全（安装前必读）

- **完全信任模型（静态插件）**：装进来的插件 = 本机账户全权限（可读写文件、
  起子进程、调用全部 RPC）。**npm 上的包 ≠ 审核过的包**——只装你信任来源的
  插件。安装 UI 常驻供应链警告。
- **权限声明**：`manifest.permissions` 声明 + `plugins.json` granted 段授权门禁
  ——未授予的权限类 → 插件不装载（blocked，缺哪些授权可见）。这只是装载期
  主张；真正的强制在 Rust 权限咽喉逐调用生效。
- **动态插件（模型运行时定义的，cordis 域）**：首激活经用户批准 + 宿主半沙箱
  三层防线（`docs/cookbook/adding-a-dynamic-plugin.md`）。

## 深水区入口

| 要看什么 | 去哪 |
|---|---|
| 契约全集（通道 API / 生效语义 / 信任模型） | `docs/plugins/README.md` |
| 各 seam provider 怎么写 | `docs/cookbook/`（8 篇指南） |
| 最小示例 / MCP 端到端示例 | `examples/plugins/hello/` · `examples/plugins/dataflow-mcp/` |
| 活预览窗插件示例（环回远端视图，不挂 MCP） | `examples/plugins/office/`（OfficeCLI 活预览窗：`app.url` 指向本机 watch 服务 + `office_preview_open` 工具口；OfficeCLI 的读写能力已由内置 `office` 域工具承担——见 `examples/office-cli/`） |
| 发布到 registry | `docs/user/develop/publishing-plugins.md` |
| 契约版本（manifest schema 变更须升版） | `docs/agents/open-surface-contract.md` |

## 内部：给兰台仓库加第一方出厂产物

兰台内置的 58 个第一方插件（**19 内核 service + 39 出厂产物**）与第三方走同一套通道。
内核 19 件编译进 exe（注册表/运行时 + code-runtime + dynamic-runner + lsp-service + root-views + token-meter + workspaces + shellRows + steps——真源 =
`src-ui/src/plugins/service-plugins.ts`，loader 的 `BUILTIN_PLUGINS` 由它派生）；出厂产物 39 件真源在 `plugins/builtin/<name>/`
目录（磁盘通道装载，**改插件 = 换产物，不重编译 exe**）。设置面板
「插件」tab 三组陈列：**平台服务**（内核，不可禁）/ **内置插件**（产物，
可禁用）/ **已安装**（第三方）。

新增出厂产物 = **三步**（2026-09-20 校准——旧版「四步」的第 4 步早已不存在：
build 规格从名册派生、`plugin_assets.rs` 白名单 2026-09-06 删除；第 3 步也只在
「产物对象直接 import」时才需要）：

1. `src/plugins/builtin/<name>/` 建目录：`index.ts`（`LantaiPlugin` 插件对象）
   + 可选 `host.ts` / `host.aliased.ts`（产物域运行时依赖桥）。
   **不写 `manifest.json`**——产物 manifest 由 `scripts/build-builtin-plugins.mjs`
   从名册生成（2026-09-06 起源目录 manifest.json 已退役，名册是唯一真源），
   所以 `inject` 一类字段只许写在名册里。
2. `src/plugins/builtin-roster.json` 加条目（`dir` / `buildOrder` / `description` /
   `entry` / `hostModule` / `inject` / 可选 `face`）——**这是唯一真源**；
   构建脚本与 Rust 资产通道都不用动。
3. 插件对象进**出厂装配面**：直接 import 的产物在
   `src/plugins/factory-products.ts` 加 import + 一行（dev 模式源码域装载用；
   表序由名册 `buildOrder` 排出，不手写）；工具域 / prompt 段 / capability 段产物
   只进各自通道清单（`composition/first-party-tools.ts` / `-prompts.ts` /
   `-capabilities.ts`）。

`src/plugins/first-party-manifest.ts` 是**派生的**（身份元数据由名册 + 内核表算出），
**不需要手工加条目**——覆盖性由 `tests/first-party-manifest.test.ts` +
`tests/builtin-roster.test.ts`（含 factory-products 覆盖与序对拍）钉死，漏一步即红。

产物可禁用（`state/plugin-prefs.ts`，localStorage 持久化、下次启动生效）。
开发模式下产物走源码路径（`import.meta.env.DEV` 分支——改 `.ts/.tsx` 是整页 reload、
改 `.css` 是换 `<link>`，没有模块级热替换；源码域产物拒绝从产物通道重载，见
`docs/dev-workflow.md`「生产包热更」）。详细纪律见 `CONVENTIONS.md` §1.7 与 `AGENTS.md`。
