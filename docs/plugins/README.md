# 兰台插件指南（docs/plugins/README.md）

> S4 竣工（2026-08-20）；S3 第一方行化（2026-08-22）；P4 A-1 prompt 段贡献
> 通道（2026-08-23）；P4 B④ 第一方 prompt 段迁移收官（2026-08-23）；S4-4
> 甲：贡献行/段进组合解析域（2026-08-23）；S4-4 乙：MCP 机器桥（2026-08-23）；
> ①b：builtin 工具行表退役——十四族全量经 ctx.tools 贡献（2026-08-23）；
> P4 A-2：hooks/preflight 贡献通道（2026-08-24）；P4 A-3：capability
> 贡献通道（2026-08-24）；P4 B⑤ 收官（2026-08-24）。
> **2026-08-29：第一方插件收编插件列表**（43 个清单身份 + 设置面板）。
> **平台化 Phase 3-6（2026-08-27/28）：本文件为插件面唯一人类契约。**
> **2026-08-31（增补四）：kind='feature' 全量通道化（23 个产物 + 位移机制）。**
> **2026-09-03（plugin-bundle-retirement S2-S5 竣工）：bundle 双轨拆除**——

> 43 个第一方插件分家为 **内核 service**（exe 编译态：注册表/运行时 +
> agent-loop-service 暂缓）+ **出厂产物**（磁盘通道：6 供应商 + 5 既有 +
> 16 工具域 + 2 段贡献，真源全部在 plugins/builtin/&lt;name&gt;/ 目录）——
> 当时 29 条，**现计数见 `docs/facts.generated.md`**。
> displace 位移机制退役（产物是唯一装载面，无 bundle 兜底）；dev 模式走源码
> 路径（import.meta.env.DEV 分支，vite HMR），产物仅发布形态。
> 装载调度 = 依赖图 + boot 全 ACTIVE 审计（plugins/boot-gate.ts——
> cordis fiber PENDING 挂起语义 + fail-loud，不带病运行）。
> 插件 = 经
> webview 动态 import 装载的自包含 ES 模块，
> 向宿主注册**面板 / 命令 / 工具 / 块渲染器 / prompt 段 / 管道钩子 /
> capability / swappable seam provider / 动态插件包**贡献；
> 也可经 manifest 声明式挂接**外部 MCP server**（§3 机器桥）。
> 完全信任模型——安装前必读 §6。从零到跑通的最短路径：
> `examples/plugins/hello/README.md`；发布路径见
> `docs/user/develop/publishing-plugins.md`；各 seam cookbook 见 `docs/cookbook/`。
> 第一方插件先例（产物域真源目录 plugins/builtin/&lt;name&gt;/）：
> `paper-shell/`（面板 + 命令）、`settings-domain/`（面板 + 命令）、
> `fs-domain/`（工具域）、`llm-adapters/`（seam provider）、
> `prompt-segments/`（prompt 段）、`capability-segments/`（capability）。

## 目录

0. [平台契约总览](#0-平台契约总览)
1. [五个概念](#1-五个概念)
2. [插件目录与 manifest](#2-插件目录与-manifest)
3. [通道 API](#3-通道-api)
4. [宿主桥（无裸 import 的平台契约）](#4-宿主桥无裸-import-的平台契约)
5. [安装 / 卸载 / 禁用](#5-安装--卸载--禁用)
6. [⚠️ 信任模型（安装前必读）](#6-️-信任模型安装前必读)
7. [KV-cache 注意事项](#7-kv-cache-注意事项)
8. [preset（行组合预设）](#8-preset行组合预设)
9. [未决项（如实声明）](#9-未决项如实声明)
10. [软件级插件（app shell 四件套）](#10-软件级插件app-shell-四件套)

## 0. 平台契约总览

**线外一切皆行 / 皆 seam**（宪法第五条平台边界）：强制层（权限咽喉 / 沙箱内核 /
审计 / IPC / cordis 内核 / 组合引擎 / Workspace 原语）特权且永不插件化；能力契约层
全开——Rust/engine 只是默认 provider。本文件 + 生成物目录（`docs/agents/`）+
cookbook（`docs/cookbook/`）+ 发布路径（`docs/user/develop/`）是平台的人类契约。

### 贡献通道（清单以生成物 `docs/agents/service-catalog.md` 为准）

| ctx 通道 | 贡献形状 | 生效时机 | 真源 |
|---|---|---|---|
| `ctx.panels` | PanelContribution | 即时 | composition/services.ts |
| `ctx.commands` | CommandContribution | 即时 | composition/services.ts |
| `ctx.tools` | ToolContribution（行） | 下次装配 | composition/services.ts |
| `ctx.prompts` | PromptSection（段） | 下次装配 | composition/prompt-service.ts |
| `ctx.renderers` | RendererContribution | 即时 | composition/renderer-service.tsx |
| `ctx.hooks` | Hook 贡献（enrich/preflight） | 下次装配 | composition/hook-service.ts |
| `ctx.capabilities` | AgentCapability（会话级） | 下次装配 | composition/capability-service.ts |
| `ctx.overlays` | 画布覆盖层 | 即时 | composition/overlay-service.ts |
| `ctx.rootViews` | App 外壳视图槽（`'home'` 主区 / `'overlay'` 根浮层——批 9e） | 即时 | composition/root-views-service.ts |
| `ctx.workspaces` | 工作区接线贡献（`onActivate(hook)`——工作区打开时按注册序**串行**回调；批 10） | 工作区激活期 | composition/workspaces-service.ts |
| `ctx.shellRows` | 壳行贡献（`register({ id, boot })`——boot 期内核行之后按注册序执行；批 10） | 启动期 `bootShell` | composition/shell-rows-service.ts |
| `ctx.llm` | LlmAdapterContribution（协议适配器；同 kind 后注册胜） | 请求期解析 | composition/services.ts |

### swappable seam（能力契约层——可换实现）

| ctx seam | 默认 provider | 消费面 | patch 域 |
|---|---|---|---|
| `ctx.llm`（**同时是上表的一条贡献通道**——同一个注册表，消费语义不同；位置随通道增删变动，勿按序号引用） | `builtin/anthropic` · `builtin/openai` | createProvider | `seam/llm` |
| `ctx.subagents` | `builtin/in-process` | Agent.spawnSubAgent | `seam/subagents` |
| `ctx.fs` | `builtin/rust-fs` | fsExecute（fs 域 11 动作） | `seam/fs` |
| `ctx.shell` | `builtin/rust-shell` | shellExecute（shell 域四动作；subprocess 并入） | `seam/shell` |
| `ctx.sessionPersistence` | `builtin/rust-sessions` | sessionExecute（会话卷四动作 read_volume/list_volumes/save_volume/delete_volume——chat-session/chat-core 产品会话持久化全链） | `seam/sessionPersistence` |
| `ctx.graph` ~~`builtin/rust-graph`~~ | —（随图谱功能全量退役，2026-09-09） | ~~graphExecute（hologram 域）~~ | ~~`seam/graph`~~ |
| `ctx.agentLoop` | `builtin/default` | Agent.runLoop | —（契约可替换，patch 域未开） |
| 事件面 | —（D4 表） | emitLoopEvent 开关 | `seam/loopEvents` |

> seam 语义：消费视图 = 活动注册表 − 组合禁用集（`seam/<域>` patch/preset 可寻址禁用/
> 换默认 provider；晚注册可见）。完整清单以生成物 `docs/agents/service-catalog.md` 为唯一
> 机器事实源（doc-sync 门禁对拍）。

### 运行时插件三形态

1. **外部 ESM 插件**（§2-4）：磁盘 JS + manifest，装/卸/启用/禁用**运行时生效**（D6）；
2. **动态插件**（cordis 域，D7）：模型运行时 define→run→stop→undefine，approval + 沙箱
   （见 `docs/cookbook/adding-a-dynamic-plugin.md`）；
3. **外部 MCP server**（§3）：manifest.mcpServers 声明式挂接（见
   `docs/cookbook/adding-an-mcp-server.md`）。

### 第四形态：第一方出厂产物（磁盘通道真源，S5 竣工 2026-09-03）

兰台的 39 个出厂插件（7 seam 供应商 + 5 既有 + 16 工具域 + 2 段贡献 + plan-mode + goal-mode + state-hooks + compaction + multiagent-comm + paper-renderers + sessions-home + ask-cards + bundled-engine）——
真源在仓库 `src-ui/src/plugins/builtin/<name>/` 目录，构建管线（esbuild，
`scripts/build-builtin-plugins.mjs`，接入 `npm run build`）产出 ESM 产物 +
manifest，随包携带（`tauri.conf.json` resources 目录映射
`"../src-ui/dist-plugins"`，目录 key 保结构；glob key 会压平，勿用）；运行时经
**与第三方同一条 D6 装载链路**装载（`/plugins/` 索引含内置根，Rust 资产通道
回退 `src-ui/dist-plugins` 或打包态 `resource_dir/builtin`），设置面板
「重新加载」→ 重装载（秒级生效，应用不重启；工具面下次装配生效）。

**改插件 = 换产物，永不重编译 exe**——编辑 `plugins/builtin/<name>/` 源码 →
`npm run watch:builtin-plugins`（保存即重建 + 逐文件 SHA256 自动镜像进 **exe 侧资源根** +
应用内自动重载）→ 秒级生效，无须重启应用。手工口径（`build:builtin-plugins` /
`check:builtin-plugins` / 设置面板「重新加载」）与三条仍需重建 exe 的边界见
`docs/dev-workflow.md`「生产包热更」。

- **装载形态（S5 后单一）**：产物从磁盘通道装载（exe 只留内核 service 装配台（计数见 docs/facts.generated.md）——
  displace 位移机制已退役，产物是唯一装载面，无 bundle 兜底行）。装载序 =
  `factoryProductPlugins()` 表序（贡献注册序 = 原 bundle 序——组合快照/
  前缀缓存依赖此序），用户插件按索引序殿后。
- **dev/prod 双态**：dev 模式经 `import.meta.env.DEV` 分支走源码路径
  （`plugins/factory-products.ts`——产物通道的磁盘副本被过滤防覆盖热重载）；
  生产端该分支经 vite define DCE 消除，产物只从磁盘通道装载。**dev 下的更新语义**：
  改 `.ts/.tsx` = **整页 reload**（本仓零 `import.meta.hot` accept 边界、未装
  `@vitejs/plugin-react` ⇒ 没有模块级热替换），改 `.css` = 换 `<link>` 不重跑 apply；
  源码域装载的出厂产物**拒绝**从产物通道重载（同一批贡献 id 会二次注册 ⇒ 注册表见同 id 即抛，
  装载器改为具名拒绝——`loader.isSourceDomainProduct`）。
- **装载调度（S4，2026-09-03）**：cordis fiber PENDING 挂起语义（manifest
  `inject` 缺依赖不拒载——等 provide）+ `plugins/boot-gate.ts` 全树 settle
  审计——全 ACTIVE 才放行 bootShell（fail-loud，不带病运行）。
- **产物形态**：全部产物 = 真源编译（插件对象代码在产物内，不薄重导出——
  S3 已拆薄壳）；UI 面 = 组件源码真迁移（项目内依赖经 `host.ts` /
  `host.aliased.ts` 宿主桥对拍面取**共享真实例**——zustand store/service
  单例不可内联副本；**无身份的纯函数/资产才随包内联**，名单 = 名册 `shared`，
  见下「产物模块图账本」；CSS 抽取为 entry.css 经 `loadCss` 注入（版本号 + 每产品一 link，
  见 `docs/dev-workflow.md` 的 CSS 边界段））；供应商/工具
  域 = 运行时依赖（工具工厂/RPC/seam 函数）经 faceDeps 桥取用。
- 产物构建：`--jsx=automatic --jsx-import-source=./<hostModule>` + onResolve
  重定向到 `*.aliased.ts` + `react` 别名桥（`react-bridge.cjs`——产物内全部
  react import 落到宿主注入的同一份 React，零副本）——产物自包含（零静态
  import / 零动态裸 import，构建断言）。
- **产物模块图账本（2026-09-28 账本合一）**——产物不是隔离带，是**同一进程里的第二份
  模块图**：只有静态 `./host` 被 onResolve 重定向，其它引用一律被 esbuild **整份内联成
  私有副本**（连模块级状态一起）。被内联者带状态（store / 缓存 / 发号器 / 计数器 /
  订阅表 / 账本）时，跨域调用就是「打在自己的影子上」。三道门禁：
  ① **源码级**——值位置的相对动态 import 一律拒建（`scripts/lib/artifact-dynamic-imports.mjs`）；
  ② **模块图级**——产物输入集（esbuild metafile）里出现「插件目录外且未登记」的源码即
  构建失败，**唯一豁免声明面 = 名册各条目的 `shared`**（无身份共享件：纯函数 / 只读冻结表 /
  类型 / 资产；另加三个构建全局件 `react-bridge.cjs` / `face-css.ts` / `contribution-helpers.ts`）；
  ③ **面键级**——`host-surface.baseline.json` + 产物 `face.json` 指纹。
  带模块级状态的欠账另在 `scripts/lib/stateful-kernel-modules.json`（构建时 ⚠ 点名）；
  **带状态者不得登记 `shared`**——共享状态的唯一合法通道是宿主桥。名册 `shared` 因此是
  **声明面而非快照**：删一条 = 声明本产物不再内联它，必须同批改 import 并验证产物字节
  （`blockSeq` / `logPath` 一类**定义**在产物里命中 0），否则构建立刻红——设计意图。
  台账与逐条销账见 `docs/landmine-map.md` 第十五批 A4。
- 宿主桥（P1a + 增补四扩面）：`window.__lantai_plugin_host__` 提供 `react`
  （React 全量）、hooks 全集、`Overlay`、`rpc`、`loadCss`（产物 CSS 注入：URL 带
  版本号、每产品一 link、停用即摘——2026-09-19 起，见 landmine H2/H3）、
  `mods`（faceDeps 依赖真实例 + toolDomains/segments 插件对象）——见 §4。

### 契约版本

- 开放面契约版本：`docs/agents/open-surface-contract.md`（seam 接口 / manifest schema /
  dynamic runner / agent loop 变更必须升版 + 记录——守护测试红着就是没改完）。
- 插件 manifest schema 真源：`src/plugins/types.ts`（zod——单一权威；`displace`
  为历史字段，S5 后已无装载语义——留作解析兼容）。

### 信任模型二分（详见 §6）

- 静态插件 = **完全信任（v1 已知债）**——装进来拥有本机账户全部能力；
- 动态插件 = **approval + 沙箱**（首激活用户批准 + 三层防线）。

## 1. 五个概念

| 概念 | 是什么 | 真源 |
|---|---|---|
| 插件 | 自包含 ESM 模块（`{ name, inject?, apply(ctx) }`） | 本文档 |
| 贡献通道 | **全部贡献通道**（计数以生成物 `docs/agents/service-catalog.md` 为准）：`ctx.panels` / `ctx.commands` / `ctx.tools` / `ctx.llm`（LLM adapter）/ `ctx.prompts`（prompt 段，P4 A-1）/ `ctx.hooks`（管道钩子，P4 A-2）/ `ctx.capabilities`（capability，P4 A-3）/ `ctx.renderers`（块渲染器，V3b）/ `ctx.overlays`（画布覆盖层）/ `ctx.rootViews`（App 外壳视图槽，批 9e）/ `ctx.workspaces`（工作区接线贡献，批 10）/ `ctx.shellRows`（壳行贡献，批 10）——**同一个注册表内核**（`contribution-channel.ts` 的 `ContributionChannel`，2026-09-14 M1 收口；`timing` 声明生效时机）；**五条 seam provider 注册表**：`ctx.subagents` / `ctx.fs` / `ctx.shell`（subprocess 并入）/ `ctx.sessionPersistence` / `ctx.agentLoop`（后端替换，平台化 Phase 1/2）；`ctx.graph` seam 随图谱功能全量退役（2026-09-09） | `src-ui/src/composition/contribution-channel.ts`（内核）+ `services.ts` / `renderer-service.tsx` / `prompt-service.ts` / `hook-service.ts` / `capability-service.ts` / `overlay-service.ts` / `root-views-service.ts` / `subagent-service.ts` / `fs-service.ts` / `shell-service.ts` / `session-persistence-service.ts`（各通道；**权威清单以生成物 `docs/agents/service-catalog.md` 为准**） |
| 行（row） | 组合的最小单元——工具族/prompt 段/capability/壳行各有 id | `src-ui/src/composition/*` |
| preset | 命名的行组合叠加层（standard/minimal 内置 + 用户目录） | §8 + `docs/composition/README.md` |
| patch | 四域行的增量数据（禁用/覆盖/插入） | `docs/composition/README.md` |

## 2. 插件目录与 manifest

```
~/.lantai/plugins/<插件名>/
├── manifest.json    # 必需——装载期校验
└── entry.js         # manifest.entry 指定的 ESM 入口
```

`manifest.json` 全部字段：

```json
{
  "name": "hello",                    // 必需。npm scope 风格 id（如 "acme/tools"），须与目录名一致
  "version": "1.0.0",                 // 必需。semver
  "description": "一句话描述",          // 可选。设置面板展示
  "entry": "entry.js",                // 必需。相对路径，.js/.mjs，禁绝对路径/回溯段
  "inject": ["panels", "commands", "tools"],  // 可选。依赖的 ctx 服务——装载期校验存在性
  "permissions": ["read", "bash"],     // 可选。C11-2 权限声明（枚举：read/edit/bash/git/web）——
                                      // 声明未被 plugins.json granted 段覆盖 → 插件不装载（待授权）
  "tools": [                          // 可选。C11-1 声明式工具（见 §3「manifest.tools」）：
    {
      "name": "todo_read",            // 模型可见工具名（全局唯一）
      "description": "读待办清单",      // 面向模型的描述
      "parameters": {                 // 参数 JSON Schema（draft-7，必须 type:"object"）
        "type": "object",
        "properties": { "q": { "type": "string", "description": "过滤词" } },
        "required": ["q"]
      },
      "readOnly": true                // 可选。只读（可安全并行）；缺省 false
    }
  ],
  "mcpServers": [                     // 可选。S4-4 乙机器桥：声明式挂接外部 MCP server
    {
      "name": "my-engine",            // server 名——工具名前缀 mcp__my-engine__* + 行 id 尾段
      "transport": "stdio",           // stdio | http
      "command": "./bin/engine",      // stdio：相对路径相对插件目录解析；裸名走 PATH
      "args": ["--serve"],            // stdio：命令参数（原样透传——相对路径不解析，用绝对路径）
      "failurePolicy": "lazy",        // 缺省 lazy：首装配连接，失败 = 空集 + warn（下次装配重试）；
                                      // startup-error：装载期急连接验证，失败 → 插件 error 记录
      "readOnly": true                // 可选。该 server 全部工具的只读担保（缺省**不表态**——
                                      // 按远端 annotations.readOnlyHint 判，仍无声明则 fail-closed 视为写）
    },
    {
      "name": "remote",               // http 形态：
      "transport": "http",
      "url": "http://127.0.0.1:9000/mcp",
      "headers": { "Authorization": "Bearer xxx" }  // 可选。明文进 manifest——插件目录是全信任区
    }
  ],
  "activation": {                     // 可选。S6 P3a：登记 ≠ 激活（见 §3「ctx.activation」）
    "lazy": true,                     // 显式懒激活——apply 只登记，组合装配期才启动副作用
    "resources": ["stdio"],           // 资源类型闭集：pty | stdio | port | listener | window
    "exclusive": ["port:9310"]        // 不可共享的资源实例名——同一时刻只允许一个组合持有
  }
}
```

装载管道（`src-ui/src/plugins/loader.ts`）：扫描目录 → manifest 校验 →
inject 依赖存在性 → webview 动态 import → `root.plugin(obj)`。任何一步
失败 → 插件状态 `error`（设置面板可见），**不炸应用**（失败隔离）。
声明 `tools` / `mcpServers` 时装载器包装插件（entry.apply 之后挂接声明
面——工具贡献注册 / 桥进程启动；贡献注销与进程 kill 挂同一 fiber——插件
卸载即链式停，见 §3「manifest.tools」与「MCP 机器桥」）。

软件级字段（`dataDir` / `app` / mcpServers 条目的 `restart`·`lifecycle` 治理
字段 / tools 条目的 `async`）见 **§10 软件级插件（app shell）**；
`activation`（S6 P3a 激活声明）见 **§3「ctx.activation」**。

## 3. 通道 API

通道在 `apply(ctx)` 里注册；**每个注册的返回值（disposer）必须经
`ctx.effect(() => disposer, '标签')` 登记**——这是插件生命周期纪律的全部
（fiber dispose 即干净退出）。

### ctx.panels —— 面板（即时生效）

```js
ctx.effect(
  () =>
    ctx.panels.register({
      id: 'my-panel',          // string 开集；与内置面板同 id → 内置胜（warn 可见）
      side: 'right',           // 'left' | 'right' | null（null = 不上轨道，命令唤起）
      title: '我的面板',
      icon: 'agent',           // ui/icons.ts 的图标名
      askAgent: false,          // 可选。面板内提供「问 Agent」入口
      unmountOnClose: true,     // 可选。关闭即卸载（默认常驻 + CSS 过渡）
      component: MyPanel,      // React 函数组件（经宿主桥 createElement——§4）
    }),
  'my-panel',
);
```

生效语义：register/dispose 即时（面板清单经信号 store bump，DockPanel/
命令面板当场重取）。

### ctx.commands —— 命令（即时生效；斜杠命令唯一真源）

```js
ctx.effect(
  () =>
    ctx.commands.register({
      id: 'acme/do-thing',     // 约定 '<插件名>/<动作>'
      label: '做一件事',
      group: '插件',            // 命令面板分组
      slash: '/dothing',        // 斜杠触发词（可选；缺省 = 只进 Ctrl+K 面板）
      kbd: 'ctrl D',            // 键位提示（可选；仅展示，真实绑定在全局快捷键层）
      action: {
        type: 'local',          // local（handler 直调）| send | fill | skill
        handler: (arg) => { /* arg = 斜杠参数（`/dothing x` → 'x'；无参为空串） */ },
      },
    }),
  'acme/do-thing',
);
```

`send`/`fill`/`skill` 型经聊天面板的命令执行面路由（需要 chat 面板在场）；
命令面板（Ctrl+K）里全部类型可见。

**命令清单唯一真源**（2026-09-19 契约 v42）：本通道 + 会话内建命令（`/new` `/compact`
`/export` `/goal` `/memory` `/remember` `/compact-stats`，由 `ChatCore.builtinCommands()`
提供）+ 技能候选（`/<技能名>`）在 `src/app/commands/command-catalog.ts` 合流——
`/` 内联面板与 Ctrl+K 面板消费同一份清单（差异只在过滤：`/` 触发只列有 `slash` 的条目）。
旧 `ui/command-registry` 单例已退役；`shortcut` 字段更名为 `slash`（旧名不留别名）。

### ctx.tools —— 工具（下次 Agent 装配生效）

```js
ctx.effect(
  () =>
    ctx.tools.register({
      id: 'acme/query',        // 约定 '<插件名>/<工具名>'——折算后行 id = 'plugin/acme/query'
      factory: () => ({        // 注册时调用一次，实例缓存（不随每次装配重建）
        name: () => 'acme_query',      // 模型可见工具名
        description: () => '做什么',
        parameters: () => ({ type: 'object', properties: { /* ... */ } }),
        readOnly: () => true,
        execute: async (args) => '结果',
      }),
    }),
  'acme/query',
);
```

关键语义：

- **生效时机是下次 Agent 装配**（新会话）——工具面变更 = 前缀缓存边界，
  只发生在会话边界（§7）。
- 行 id 折算：贡献 id → `plugin/<贡献 id>`。**S4-4 甲（2026-08-23）起
  贡献行进组合解析域**：`plugin/…` 行 id 可被 roster.patch.yml / preset
  寻址禁用（单工具粒度——`factoryComposition()` 快照收编当前贡献，
  贡献 register/dispose 后下次解析自动重取）。卸载/禁用整个插件仍走
  §5 的插件开关。
- 工具实例缓存：dispose 清缓存（被卸载的工具实例不再进装配）。
- **factory 可选收装配上下文**（2026-08-23 P4 B① 放宽）：折算装配时以
  `factory(rowCtx)` 传入（`ToolRowContext`——`codingExec` 等装配期依赖）。
  外部插件无参 factory 仍完全合法；收 ctx 的贡献自担「首装配实例跨装配
  复用」的语义等价责任（依赖装配期真值的能力不适用——实例缓存会锁存
  首装配真值）。
- 撞名语义：两个插件贡献同名 id → 前缀不同不撞；**真正的撞名**是两个
  工具 `Tool.name()` 相同 → 行表装载期拒绝（duplicate throw）。

### ctx.llm —— LLM adapter seam（平台化 Phase 1 · D2 修订版）

第一方 `plugins/builtin/llm-adapters/`（loadBuiltinPlugins 表序第二行）贡献内核
anthropic/openai 两条默认 adapter（`{ id, kind, create }`）；外部插件按同 kind
**后注册胜**覆盖（仪器化 wrapper / 替换协议实现），dispose 分层回落。消费入口 =
`createProvider(settings)` 方言解析器（provider/index.ts 只查本通道，零内核回落
分支）；未命中响亮报错 `PROVIDER_DIALECT` 并点名已注册方言。

> 历史注：原「预留不接线」状态自 2026-08-26 方言收口起终结；通道名
> ctx.providers 于 2026-08-27 平台化 Phase 1 升格更名为 ctx.llm
> （agent-platformization-plan §3 D2/D5 修订注记）。

### manifest.tools —— 声明式工具挂接（C11-1，2026-08-24）

工具声明可序列化（zod↔manifest 双向桥）：**声明是 manifest 数据**
（name/description/parameters JSON Schema/readOnly——与 DSH L1 契约同构的
模型面三字段 + readOnly），**执行是 entry 模块的 `toolHandlers` 命名导出**
（工具名 → 函数）。装载器挂接——插件不触碰 `ctx.tools`（信任面更小，
装载期即知工具面），每条声明折算一条工具贡献（行 id
`plugin/<插件名>/<工具名>`，patch/preset 可寻址禁用）。

```js
// manifest.json（声明——数据）
{
  "name": "acme/todo",
  "version": "1.0.0",
  "entry": "entry.js",
  "tools": [
    {
      "name": "todo_read",
      "description": "读待办清单",
      "parameters": { "type": "object", "properties": { "q": { "type": "string" } } },
      "readOnly": true
    }
  ]
}

// entry.js（执行——映射；apply 可省成空函数或完全不需要其它注册）
export const toolHandlers = {
  todo_read: async (args) => JSON.stringify(await loadTodos(args.q)),
};
export default { name: 'acme/todo', inject: ['tools'], apply() {} };
```

关键语义：

- **声明与实现一一对应**（all-or-nothing）：声明缺 handler / handler 未
  声明 / handler 非函数 / 无 `toolHandlers` 导出 → 插件 error 记录（失败
  隔离，一条不挂全部不挂）——「写了但什么都不发生」的字段是手误。
- **参数 schema 是纯数据**（draft-7 JSON Schema，`type:"object"` 必填）
  ——与宿主 `defineTool` 的 zod→JSON Schema 输出（`toInputJsonSchema`）
  同一规范；宿主侧反向桥 `declarationOf(tool)` 把任意第一方工具序列化为
  同一数据形状（自家工具清单数据化，DSH L1 compat 映射零成本）。
- **生效时机是下次 Agent 装配**（新会话）——与 ctx.tools 代码通道同时效；
  实例缓存语义同无状态族（声明 + 函数闭包无装配期依赖；handler 自担
  实例状态性）。
- 声明工具的 `Tool.name()` 撞名（与其它工具同名）→ 行装载期拒绝（既有
  duplicate 纪律）。
- 与 `mcpServers` 可并存（同一插件既有声明工具又挂 MCP server）。

### MCP 机器桥 —— manifest.mcpServers 声明式挂接（S4-4 乙，2026-08-23）manifest 声明 `mcpServers`（§2）→ 装载器把每个 server 折算成**一条工具
贡献**（行 id `plugin/<插件名>/mcp/<server名>`）——进组合解析域，
patch/preset 可寻址禁用单个 server（组合均匀性不破）。**不需要写任何
插件代码**——机器桥是纯声明面（entry.js 仍需存在，可与桥并存）。

关键语义：

- **工具命名**：远端工具以 `mcp__<server名>__<工具名>` 注册进 Agent
  工具面（与宿主自带的外部 MCP server 同一命名规则）。
- **惰性连接（lazy，缺省）**：首个 Agent 装配时连接（stdio 经 Rust
  `protocol_bridge_spawn` 起子进程；http 直连）+ `tools/list` 拉远端清单。
  连接失败 = 该 server 空集 + console warn——**不炸装载不炸装配**；空集
  不缓存，下次装配重试（服务器恢复后新会话即得工具面）。
- **装配时点纪律（2026-09-24 立规，两类 server 都受约束）**：**工具面在装配时点
  冻结**——行工厂的产物（`mcp__<server>__*` 清单）进了注册表就不再重取，而工作区
  **共享注册表**建一次即被所有同组合的卷复用，**不存在「下次装配」**。因此
  「装配这一刻还没握手完 ⇒ 空集 ⇒ 下次装配重试」这条老语义在受治档上等于
  **永久没有工具**（实测：任何声明 `restart`/`lifecycle` 的 server 全部命中；旧形态
  条目因为是在装配期自己连接并 await，故不受影响）。现行语义：
  `ASSEMBLY_READY_WAIT_MS`（10s）内**有界等待就绪**再取面；失败仍留空集 + 可见
  warn（真因照抄治理器原文）。回归 `tests/third-party-mcp-assembly.test.ts`
  （两条路 × 真 Workspace 装配腰，判据 = Agent 注册表里有 `mcp__*`）。
- **startup-error**：装载期急连接验证——失败 → 插件 error 记录
  （设置面板可见）。
- **进程生命周期**：kill 归插件 fiber disposer——插件卸载/禁用（重启
  生效）→ spawn 的进程链式停。断线感知（2026-09-07，Commit 6b）：进程
  意外退出 → client isConnected 翻 false + 工具快照清 + 在途判负——下次
  装配 factory 走重连/重建（受治面 restart:on-crash 指数退避自动重启）。
- **stdio command 解析**：相对路径（含分隔符）相对插件目录（`plugin_dir`
  RPC 解析锚点）；裸名走 PATH。`args` 原样透传（相对路径不解析）。
  ⚠ **Windows 上裸名不认 `.cmd` shim**（2026-09-24 用 Rust `std::process::Command`
  实测，与应用 `spawn_process` 同款 API）：`"command": "npx"` → `program not found`
  （Rust 只补 `.exe`），而 `"command": "npx.cmd"` ✅ 正常起（显式后缀走 PATHEXT +
  CreateProcess 的 shim 关联）。**故 Windows 上配 npx 型 server 请写 `npx.cmd`**，
  或 `"command": "cmd", "args": ["/c", "npx", …]`，或 `"command": "node"` + 脚本
  绝对路径（`notes-app` 范本即此形态）。裸名照抄网上教程会在 Windows 上静默拿不到
  工具（失败只落一行 warn）。
- **只读语义（P0，2026-09-13；契约 v27）**：远端工具的 `readOnly` = 条目级
  声明 `mcpServers[].readOnly` > 远端 `annotations.readOnlyHint === true` >
  **缺省 false（fail-closed）**。判定真源 =
  `src-ui/src/agent/mcp/registry.ts` 的 `resolveMcpToolReadOnly`（registry 与
  mcp-bridge 两处工具构造共用，不各判各的）。**旧行为是两处硬编码
  `readOnly: true`**——写型 MCP 工具因此在 plan 模式被放行（`plan-registry.ts`
  首行只读短路）、并入只读并行组；远端不表态即视为写是本洞的根治。确为只读的
  server 请在条目上声明 `"readOnly": true`（或让 server 自己发 `readOnlyHint`），
  否则该 server 的工具在 plan 模式会被拦、且串行执行。
- **边界**（ADR §5 维持）：这是「插件挂外部机器」，不是「进程内宿主
  插件」——后者永久关闭。

> **用户级直配（skills-mcp-production-plan，2026-09-07）**：除插件
> `manifest.mcpServers` 外，用户可写 `~/.lantai/mcp.json` 声明跨项目个人
> MCP server（同构条目，boot 期装载为工具贡献，行 id `plugin/user/mcp/
> <server>`；设置面板「MCP」tab 管理）。详见
> `docs/archive/kernel-tooling-line/skills-mcp-production-plan.md` §3.2。

### ctx.renderers —— 块渲染器（纸壳，即时生效）

第五贡献通道（paper-shell V3b，2026-08-22）：向纸视图注册块**体**渲染器——
纸壳的块协议（语义声明 + 可插拔渲染器）的插件面。渲染器只渲染块体
（kind 特定内容）；块壳（头部/拖拽手柄/收回按钮）是纸壳结构件，不开放。

```js
ctx.effect(
  () =>
    ctx.renderers.register({
      id: 'acme/markdown',      // 惯例 '<源>/<kind>'；与内置同 kind 并存时后注册胜
      kind: 'markdown',          // 块类型，或 '*'（兜底渲染器）
      component: MyRenderer,     // React 组件，入参 { block }（block.payload 按 kind 取内容）
    }),
  'acme/markdown',
);
```

出厂行（十一 kind 全谱 + `'*'` 兜底）= 产物 `paper-renderers`（名册 `required: true`，
**不可禁用**——禁用它等于纸壳裸奔）；内核 `renderer-service` 只做通道（批 8b 起零出厂行）。

#### 重依赖才留应用 bundle（判据，2026-09-25 批 8 契约化）

产物域有两条硬约束（`scripts/build-builtin-plugins.mjs` 的自包含闸）：**禁静态 import、
禁动态裸 import**。因此：

- **轻依赖**（hljs / katex / zod / yaml …）**内联进产物**——换来「零新依赖 + 只换产物热更」，
  代价是产物体积（`renderers` 产物 ≈2.8 MB，含 hljs）；
- **重依赖**（pdfjs / mermaid / three——MB 级且须按需分片）**组件本体留应用 bundle**，
  产物侧只留「认领 + 降级 + 取件」逻辑，组件经宿主桥取用：
  - 文件查看器：`ViewerDef.heavy = '<id>'` + 宿主桥 `loadViewer(id)`
    （`app/paper/viewers/` **目录即白名单**，现存 `pdf` / `model3d`）；
  - 块渲染器：faceDeps 桥（先例：`paper-renderers` 的 `MermaidBlock`——mermaid 围栏
    「码 → 图」那一段留应用 bundle，认领与降级随产物）。
- 判据一句话：**能在产物里跑的（零依赖/自绘/复用既有原语/轻依赖内联）一律留产物（可热更）；
  只有真重依赖才进应用 bundle（代价：该批要重建 exe）**。

### ctx.prompts —— system-prompt 段落（下次 Agent 装配生效）

第六贡献通道（P4 A-1，2026-08-23）：向 Agent 系统提示词追加段落——工具指导、
领域约定、团队规范等静态文本面。

第一方同走此通道（P4 B④ 收官，2026-08-23；S3 产物化 2026-09-03）：**全部 13 段**出厂段（试点
memory/claude-md → 续批 graph-snapshot → 收官批剩余 10 段）已迁
`src-ui/src/plugins/builtin/prompt-segments/` 经 `ctx.prompts` 贡献
（装载 `firstPartyPromptSections()`，贡献序 = 迁移前出厂表序，拼装字节
零漂移；定义留 `prompt-sections.ts` 单一真源；出厂段表
`builtinPromptSections()` 已退役，本通道是出厂段唯一来源）——全部
第一方段脱离组合 patch 寻址域（寻址它们的旧 patch 整体拒绝，错误可见）。

```js
ctx.effect(
  () =>
    ctx.prompts.register({
      id: 'acme/conventions',       // 约定 '<插件名>/<段名>'
      applicable: (ctx) => true,     // 可选。返回 false 时本段跳过（如按有无图分流）
      render: (ctx) => `

## 团队约定
- 提交信息用中文
- 不改 docs/archive/ 下任何文件`,   // 产出含自身前导分隔符的完整文本（与内置段同契约）
    }),
  'acme/conventions',
);
```

关键语义：

- **生效时机是下次 Agent 装配**（新会话）——system prompt 在会话创建时点
  拼装，在途会话保持创建时点的段落面不变（前缀缓存纪律，§7）。
- **S4-4 甲（2026-08-23）起贡献段进组合解析域**：patch/preset 可
  disable/text 覆盖/insert 锚定贡献段 id（含全部 13 第一方段——第一方
  同走此通道）；拼装位序由组合解析产物统一决定（insert 锚定可落在
  贡献段之间，缺省锚 = 全表尾）。
- 段形状与内置段同一契约：`render` 产出**含自身前导分隔符**的完整文本
  （首段用 `\n\n## 标题` 开头；缺前导换行会与上一段粘连——字节面纪律）。
- `applicable` 收全量 `PromptSectionContext`（graphData/projectPath/providerName/
  memorySection 等）——可按装配环境条件参与。
- 重名 id 装载期拒绝（throw）；disposer 经 ctx.effect 登记（同全部通道）。

### ctx.hooks —— 工具管道钩子（下次 Agent 装配生效）

第七贡献通道（P4 A-2，2026-08-24）：向 Agent 工具管道注册钩子——
**富化**（工具结果进模型历史前改写/追加）或**预检**（写操作前注入警告，
含 HIGH 风险等级的架构门禁语义）。钩子形状与宿主内置钩子（graph hooks /
state hooks）完全同一接口——插件与第一方在同一管道上竞争。

```js
ctx.effect(
  () =>
    ctx.hooks.register({
      id: 'acme/lint-preflight',     // 约定 '<插件名>/<钩子名>'
      kind: 'preflight',              // 'preflight'（pre-tool 预检）| 'enrich'（post-tool 富化）
      hook: {
        name: 'acme-lint',
        shouldCheck: (toolName) => toolName === 'edit_file',  // 哪些工具触发
        check: (toolName, args) => {
          // 返回警告字符串（注入结果顶部），或 null 表示无风险
          return isLintDirty(args.filePath) ? '⚠️ [ACME] 该文件有未修复 lint 项' : null;
        },
      },
    }),
  'acme/lint-preflight',
);
```

关键语义：

- **两类钩子**：`kind: 'enrich'` 注册进 Agent 的 HookRegistry（`shouldEnrich`/
  `enrich`——输出流过各钩子，可异步）；`kind: 'preflight'` 注册进
  PreflightHookRegistry（`shouldCheck`/`check`——同步聚合警告）。警告文案
  含 `风险等级: HIGH` 时沿用架构门禁语义（无 `_forceGate` 的直接调用被
  拦截，code_execution 嵌套调用一律打回）。
- **生效时机是下次 Agent 装配**（新会话）——装配创建全新 registry 折叠
  当前清单；在途会话保持创建时点的钩子面不变（§7）。
- **装配序**：第一方 capability 钩子（state-hooks/board-tracking）先注册，
  通道贡献随后——enrich 链中插件钩子看到的是已富化的输出，preflight
  聚合序同理。
- **消费面**：StreamingToolExecutor 直调路径与 eventBus 管道路径（Phase 2
  attach* 适配器）都消费同一 registry——插件钩子自动对两路径生效。
- 钩子崩溃静默降级（HookRegistry 既有语义——不破坏工具结果）；贡献实例
  跨装配复用（插件自担实例状态性）。
- **子 Agent 不自动继承**（spawnSubAgent 手工建 registry 只挂 board-tracking
  ——与 graph hooks 不下放子 Agent 的既有语义一致）。
- 重名 id 装载期拒绝（throw）；disposer 经 ctx.effect 登记（同全部通道）。

### ctx.capabilities —— capability 贡献（下次 Agent 装配生效）

第八贡献通道（P4 A-3，2026-08-24；B⑤ 收官同日——十四项第一方 capability 也
经本通道贡献，出厂 builtinCapabilities() 退役）：向 Agent 装配表贡献
**capability**——会话级能力的组合单元（工具 + hooks + ctx 服务 + Agent 接线一把抓）。
这是**深集成通道**：install 拿到与第一方 capability 完全同一的装配视图
（BlueprintScope——ctx/inputs/tools/hooks/preflightHooks/deps/agent），与
`firstPartyCapabilities()` 十四项（B⑤ 起同样经通道注册——真源
`plugins/builtin/capability-segments/`）在同一张 blueprint 表上竞争。设计件：
`docs/archive/composition-architecture/designs/A3-capability-contribution-channel.md`。

```js
ctx.effect(
  () =>
    ctx.capabilities.register({
      id: 'acme/secret-scanner',    // id 即寻址行；推荐 '<插件名>/<能力名>'
      phase: 'agent',                // 'context'（Agent 构造前，可写 ctx 服务）| 'agent'（构造后）
      install: (scope) => {
        // 与内置 capability 同一视图：scope.tools / scope.hooks /
        // scope.preflightHooks / scope.ctx / scope.deps / scope.agent
        scope.tools.register(mySecretScanTool);
      },
    }),
  'acme/secret-scanner',
);
```

关键语义：

- **贡献序 = 注册序（B⑤ 后唯一行源）**：capabilities 域 = ctx.capabilities
  贡献快照——第一方十四项经 `hologram/capability-segments` 插件注册（注册序 =
  firstPartyCapabilities() 清单序 = 迁移前出厂表序，字节契约/前缀缓存纪律由
  清单序保住）；外部贡献接在第一方之后（装载序 = BUILTIN_PLUGINS 表尾在
  外部插件之前）。无通道环境 = 空能力表（B④ prompt 域同款注册面依赖——
  出厂面复现须经 withFirstPartyCapabilityChannel 腰，见
  `src/composition/first-party-capabilities.ts`）。
- **id 即寻址行**（2026-09-14 M1 前叫 `key`，已退役）：patch/preset 可按 id disable 贡献行
  （`capabilities: [{ id: 'acme/secret-scanner', disabled: true }]`）——插件
  开关与能力粒度裁剪两层正交（第一方行同寻址面——minimal 禁 state-hooks（原名 graph-hooks，2026-09-09 图谱退役时更名）
  既有消费者零变化）。**注意**：插件卸载后 patch 里残留的 id 会变
  未知 id → 整个用户层 patch 被拒（all-or-nothing 既有语义，处置 = 删失效
  条目）。
- **重名装载期拒绝**：撞注册表现有 id 即 throw——B⑤ 后第一方十四项本身在
  注册表里（装载序在先），撞第一方 id（如 `auto-tune`）同样走此径；畸形
  形状（id 空 / phase 非法 / install 缺函数）同样装载期拒绝（外部插件是纯
  JS——fail-fast，不潜伏到会话装配期）。
- **生效时机是下次 Agent 装配**（新会话）；在途会话不动（KV-cache 纪律，
  §7）。贡献 register/dispose = 组合输入变更（preset 缓存代数失效）。
- **普通工具加面走 ctx.tools**——本通道 install 里 `scope.tools.register`
  的工具落全表尾（converge-tools 之后，不进域折叠：DOMAIN_SPECS 是第一方
  收敛机制，外部插件不参与）。
- install 每装配重调（无实例缓存判断）；install 外的实例状态性由插件自担。
- **子 Agent 不自动继承**（spawnSubAgent 手工装配不经 blueprint——既有语义）。
- disposer 经 ctx.effect 登记（同全部通道）；服务 dispose 守卫式清空读取面。

关键语义：

- 内置灰框渲染器 = 默认行（七 kind：user/markdown/reasoning/notice/diff/plan/tool，
  id 形如 `builtin/<kind>`）；插件贡献同 kind 的行 → **后注册胜**（显式覆盖）。
- `kind: '*'` 是兜底行——无专渲染器的 kind 落这里（专行优先，不劫持）。
- 即时生效（渲染期消费，每帧重取）——与 panels 同族，无需信号 store。
- 消费面：纸视图（PaperPanel）的 BlockView 经 `resolveRenderer(kind)` 解析。

### ctx.activation —— 插件激活账（S6 P3a，装配期生效）

**登记 ≠ 激活**：插件的**登记**（apply 期把行/段/capability 进注册表）与**副作用
启动**（起常驻进程 / 连端口 / 开 PTY）从此可以分开。声明了 `activation` 的插件在
`apply` 里**只登记**启动回调，真正的启动发生在**组合装配期**——有组合用到它（组合里
有它的存活工具行，或组合显式 `requires` 它）才 `start()`，按引用计数；所有持有它的
Agent 都关了（或切走组合）→ 计数归零 → `stop()`。

```jsonc
// manifest.json（策略面）
"activation": {
  "lazy": true,                 // 显式懒激活。缺省 false = 本块只作资源声明，行为不变
  "resources": ["stdio"],       // 占用的资源类型闭集：pty | stdio | port | listener | window
  "exclusive": ["port:9310"]    // 不可共享的资源实例名——同一时刻只允许一个组合持有
}
```

```js
// entry.js（机制面）—— apply 里只登记，不启动
export default {
  name: 'acme/res',
  apply(ctx) {
    ctx.activation.declare('acme/res', {
      resources: ['stdio'],
      exclusive: ['port:9310'],
      start: async () => { /* 起常驻进程 / 连端口 */ },
      stop: async () => { /* 停 */ },
    });
  },
};
```

规则与失败面：

- **kill switch**：manifest **不写** `activation` 块 ⇒ 本批全部新行为不发生
  （退回「登记即激活」的 P3 前语义，逐字节不变）。
- **`lazy: true` 与 `mcpServers[].lifecycle: "eager"` 互斥**：声明懒激活的插件
  不得在 apply 期起进程（装载期拒绝，manifest 级校验）。
- **声明-接线对齐**：`lazy: true` 但 apply 未调 `ctx.activation.declare` ⇒ 装载
  失败记录（error，设置面板可见）——「装了开关却没接线」不静默放过。
- 装载层为声明 `activation` 的插件自动补 `inject: ["activation"]`（与 `tools`
  同款并集纪律，插件作者不必两处同步）。
- 释放归 `ctx.effect` 所有权：账由装配面在 Agent 装配期 `retain`，句柄交给
  `ctx.effect` 的清理链 ⇒ Agent dispose / 切组合即归零 → `stop`（无泄漏面）。
- **声明 `activation` + 声明 `mcpServers` 的插件不必自己写 start/stop**（S6 P3d）：
  装载层会把受治进程**lazy 档**的拉起/停止推导成激活回调——净效果 = 「所有持有
  它的卷都关了 ⇒ 进程停」（不再等空闲回收）。另两档不经手（如实声明）：`eager`
  归装载期（装载即拉起、卸载才停），`with-window` 归窗口（开窗拉起、关窗即杀）。
- `start()` 抛错 = **激活失败可见**（不抛给装配面）——该插件的行不进本组合，
  失败原因经诊断面可见（第四栏「被跳过」）。

## 4. 宿主桥（无裸 import 的平台契约）

**插件模块经 webview 动态 import 装载——没有包管理器、没有 import map，
裸 import（`'react'`、`'zod'`…）不可解析。插件必须自包含。**

需要宿主能力时经全局桥：

```js
const host = globalThis.__lantai_plugin_host__;
// host.createElement —— React.createElement 形状（面板组件构造）
// host.notify —— 状态栏通知（命令动作的最小 UI 反馈）
```

桥由装载器在装载第一方插件前注入。无桥环境（旧版本/测试降级）时插件
应自行降级（hello 示例的标准写法：`ce = host?.createElement ?? 兜底`）。

工具 schema 的对应纪律：`defineTool` + zod 是**编译期**工具链，运行时
模块用不了——插件侧手写 JSON shape + 入参校验（`execute` 里自己做）。

## 5. 安装 / 卸载 / 禁用 / 授权

四个 RPC / 文件通道（设置面板「插件」tab 是 UI 面）：

| 动作 | 入口 | 语义 |
|---|---|---|
| 安装 | `plugin_install`（registry 名 / tarball URL·路径 / 本地目录） | 下载→解包→**tar-slip 防护**（绝对路径/`..`/空段/盘符/符号链接逐条拒绝）→版本守卫→`.tmp` 原子落盘 |
| 卸载 | `plugin_uninstall`（name） | 删目录（幂等；名字围栏防路径逃逸） |
| 禁用 | `plugin_set_enabled`（name, enabled） | plugins.json 读改写（只改 `disabled` 段——**granted 授权段原样保留**） |
| 授权 | `plugins.json` 手编 granted 段 | C11-2 权限声明门禁的授予面（见下） |

**四者运行时生效（平台化 Phase 4 · D6，2026-08-27）**：装/卸/启用/禁用即时装卸
插件 fiber（贡献链式回收/装载——工具面在下次 Agent 装配生效，面板/命令即时）。
**同名重装走版本守卫（平台化 P3，2026-08-27）**：比较
manifest.version——升级 = 原子换装（备份→rename，失败回滚）；同版本拒绝；
降级拒绝；任一端 version 缺失/不可解析拒绝；`force: true` 显式跳过比较。
开放面契约的版本机制见 `docs/agents/open-surface-contract.md`（契约文件变更
未升版 = 守护测试红）。

### ctx.workspaces —— 工作区接线贡献（批 10，2026-09-26）

```ts
// 产物 apply(ctx) 内（一次性登记；每次工作区激活按注册序回调）
ctx.effect(
  () =>
    ctx.workspaces.onActivate(async (scope) => {
      // scope.root       —— 工作区根（绝对路径）
      // scope.ctx        —— 该工作区的 fiber ctx（挂它的一切随 fiber dispose 回收，无需自写 teardown）
      // scope.report(r)  —— 接线回执（{ status: 'wired' | 'failed' | 'off', reason?, toolCount? }）
      await mountMyStuff(scope);
    }),
  'acme/workspace-hook',
);
```

- **调用时机**：工作区激活点、组合快照 / 注册表构建**之前**（工具行必须先于装配进注册表）；
  切换工作区 = 旧 fiber dispose → 新工作区重新回调；
- **调用序**：注册序**串行 await**；前一个抛错不影响后一个；
- **失败隔离**：贡献抛错**不阻断工作区打开**，错误经 `scope.report({status:'failed', reason})` 具名可见；
- **子 Agent 不自动继承**（与 hooks / capabilities 同款语义）；
- 真源 `composition/workspaces-service.ts`；守卫 `tests/host-lifecycle-channels.test.ts`。

### ctx.shellRows —— 壳行贡献通道（批 10，2026-09-26）

```ts
// boot 期副作用的落点（登记 ≠ 立即执行；由 bootShell 在内核行之后按注册序执行）
ctx.effect(
  () => ctx.shellRows.register({ id: 'plugin/acme/warm-cache', boot: (refs) => warmCache(refs) }),
  'acme/shell-row',
);
```

- **纪律**：boot 期代码走**产物 apply 期登记**、`bootShell` 期执行；行 id 自带命名空间
  （`plugin/<包名>/<行 id>`，与工具行同寻址惯例）；
- **引导序**：内核行（表序）→ 贡献行（注册序）；单行抛错不阻断后续行（与内核行同款失败隔离）；
- **kill switch**：贡献行的产物可经插件禁用面整体关闭（apply 不跑 = 行不登记）；
  **逐行 patch 寻址**（把贡献行并入组合 `shell` 域）尚未做——见 §9 未决项；
- 真源 `composition/shell-rows-service.ts` + `shell/boot.ts`。

### 第一方插件在插件列表（2026-08-29）

第一方插件同样进入设置面板「插件」tab——按三组陈列（**各组计数以生成物
[`docs/facts.generated.md`](../facts.generated.md) 为准，本文件不复述**）：

- **平台服务**（kind=`service`）：组合层 service / seam provider / 运行体
  本体——常驻，不提供禁用开关（禁了应用就散架）；
- **内置插件**（kind=`feature`）：出厂产物（域工具族 / 面板 / 段贡献 / 引擎接线）——
  可启用/禁用；
- **已安装**：第三方磁盘通道插件（D6 运行时生效）。

第一方身份单一真源 = `plugins/first-party-manifest.ts`（name →
version/description/kind），必须覆盖 `plugins/loader.ts` 的 `BUILTIN_PLUGINS`
全量（缺条目 = loader 跳过装载 + error 记录，错误不静默；守护
`tests/first-party-manifest.test.ts` 测试期拦死）。

第一方启用/禁用 = 用户偏好（`state/plugin-prefs.ts`，localStorage 持久化）——
**下次启动生效**（boot 期 loader 跳过被禁用的 feature 插件，记录
status=disabled）。与第三方差异：第三方走磁盘通道 + RPC + 运行时装卸（D6）；
第一方是编译期 bundle，不做运行时 fiber 手术——多数贡献面（工具/prompt/
capability）本就只能在下次 Agent 装配体现，boot 期跳过是最诚实、最安全的
生效点。装载结果统一收 `state/plugin-store.ts`（`builtin` 标志 + `meta`
元数据，`mergePlugins` 按 name 合并——第一方 boot 与第三方异步装载互不冲刷）。

### 示例：外部 MCP server 承载真实能力（平台化 P4 · D1 收口，P4-C5）

`examples/plugins/dataflow-mcp/`——**MCP 是能力加面路径之一（不是唯一）**
的活例子：dataflow 查询既可走进程外 MCP server（本例），也可走壳内 RPC 直呼
（图谱 seam `ctx.graph` 已于 2026-09-09 随图谱功能全量退役——本示例保留，
因为外部 MCP 路径与图谱退役无关）。插件 manifest 以 `mcpServers` 声明
`node ./server.cjs`（`./` 前缀 arg 相对插件目录解析），零依赖 Node 进程
直读 `<工作区>/.lantai/dataflow/*.json`（格式与 dataflow_service.rs 逐字段
对齐），经 MCP `tools/call` 应答——装载后模型可见工具名
`mcp__dataflow__dataflow_query`。端到端守护：
`tests/plugin-dataflow-mcp-e2e.test.ts`（真实 node 子进程 + 真实 stdio +
loader 同款挂接路径）。

### 权限声明与授权（C11-2，2026-08-24）

插件在 manifest 声明所需权限类（`permissions: ["read", "bash", ...]`——
枚举闭集 `read` / `edit` / `bash` / `git` / `web`，对应 Rust 权限咽喉的五个域）。
**装载期一票否决**：声明的类未被 `~/.lantai/plugins/plugins.json` 的 granted 段
全覆盖 → 插件不装载（设置面板「待授权」状态，缺哪些授权可见，不 import 插件代码）：

```json
{
  "disabled": ["old-thing"],
  "granted": {
    "acme/power": ["read", "bash", "edit"]
  }
}
```

无声明 = 零摩擦直接装载（纯 JS 插件，如 hello 示例）。

三层安全叙事（如实声明边界）：

1. **授予门禁（装载期）**——上面的 granted 段。不授予 = 代码不进进程。
2. **声明面（安装期）**——manifest.permissions 是插件的主张，安装前可审。
   主张是诚实约束不是强制约束：插件是任意 JS，声明「read」却调 bash RPC
   在语言层面拦不住（完全信任模型，§6）。
3. **逐调用强制（运行期）**——真正的强制层在 Rust 命令咽喉：插件工具调
   `exec_command`/`edit_file`/… 时，Bash/Edit/Git/WebFetch 权限规则
   （`.lantai/permissions.json` 的 deny/ask/allow + ask/auto/yolo 模式）
   **照常逐调用生效**——与声明与否无关。即：授予了 `bash` 不等于放行——
   具体命令仍受项目权限规则与模式门禁。

已知的边界（未决项如实列出）：`mcpServers` 挂接的子进程不在权限类闭集内
（进程 spawn 的信任面由 §6 完全信任模型 + 安装期审阅 manifest 承担）——
**注意这同时意味着该子进程不受 `fs_cap` 与 `os_sandbox` 约束**（全权用户进程，
可写任意路径）；需要沙箱/审计的动作应走 `process_cap`（shell 域）而非 MCP 路。
只读语义（plan 门禁 / 并行组）已由 `mcpServers[].readOnly` +
`annotations.readOnlyHint` + fail-closed 缺省接管（契约 v27）；
browser/desktop 命令域尚未接入 Rust 权限检查。

registry 缺省 `https://registry.npmjs.org`；镜像经 manifest 外的安装参数
`registry` 覆写（安装输入框暂只收包名——镜像参数走 RPC 直接调用）。

## 6. ⚠️ 信任模型（v1：静态插件完全信任 + 动态插件 approval+沙箱）

**静态插件是本机全信任代码：可读写文件、起子进程、调用全部 RPC。npm 上的
包 ≠ 审核过的包。**

- 不做签名、不做校验和、不做静态插件沙箱（v1 已拍板，ADR
  `docs/adr/composition-boundaries.md` §5 信任模型）。**这是 v1 已知债**：
  平台方向是第三方优先，完全信任只适合第一方/熟人插件——后续硬化项
  （静态插件沙箱化 / 签名 / 进程隔离）在列但不在 v1。
- 唯一边界是装载通道的路径安全（遍历防护）——那是防攻击面不是防恶意
  代码：恶意代码装进来之后**拥有你本机账户的全部能力**。
- 这与你手动改本机文件、跑 `npm install` 是同一信任级别。若你的 home
  目录不可信，问题不在插件层。

### 动态插件（cordis 工具族 · 平台化 P4 / D7+D12 已落地）——approval + 沙箱

与静态插件的「装进来 = 全信任」不同，模型经 `cordis(define|run|stop|
undefine|inspect_list|inspect_self)` 运行时定义的插件包走**双门**：

1. **审批门（D12）**——首激活必经用户批准（UI 审批卡，拒绝即终局，
   不得重复请求）；授权按「会话 × 插件 × 包」记账；无 UI 通道且未授权 =
   `APPROVAL_REQUIRED` 拒绝运行。
2. **沙箱（D7 三层防线）**——动态插件源码在受控环境求值：
   - **求值面阴影**：`window`/`fetch`/`document`/`eval`/`Function`/
     `localStorage`/`Worker`/`require`/`process` 等 23 个危险全局以形参
     阴影为 undefined（插件拿不到 DOM/网络/存储/动态求值逃逸面）；
   - **守卫注册面**：apply 收守卫代理——只暴露 effect 与 12 个可注册
     seam 的 register（def 形状逐个校验 + 贡献预算 64 条 + 取消后拒绝），
     白名单外访问/赋值响亮拒绝（错误不静默）。守卫代理不是真实 cordis
     ctx：服务解析由 runner 免 inject 代解析（`reflect.get` 直读根 store，
     2026-09-08 修复运行期 "without inject" 缺陷）——宿主有无 fiber runtime
     恒同路可解析，动态插件不需要也不存在 inject 声明面；未挂载服务在
     register 前响亮报「服务未装配」；
   - **预算**：源码 ≤256KB / apply ≤10s / 贡献 ≤64 条，超限取消并链式
     回收全部已注册贡献（disposer 袋归 runner 管理）。
- **边界如实声明**（R4）：浏览器主文档没有进程级硬边界——动态插件沙箱
  是「协议纪律沙箱」（与 code_execution worker 同一定位），安全面 =
  上述实现质量；进程外硬隔离是后续硬化项，不是 v1 承诺。
- 生命周期与所有权：包不可变（define 只追加）；跨会话不可见/不可操作；
  stop/undefine 链式回收贡献；审批通过后的重启免审批（会话内记账）。

## 7. KV-cache 注意事项

DeepSeek 前缀缓存对 tools 段逐字节敏感。组合层的事件面：

| 动作 | 缓存语义 |
|---|---|
| 装/卸/禁用插件（工具通道） | **主动缓存失效事件**——新会话的工具面变了，旧缓存按新面重算（预期成本，不是 bug） |
| preset 切换 | 同上（新组合 = 新表序） |
| 用户层 patch 热重载（S4-2） | 同上 |
| 在途会话 | **永不变**——工具面在会话创建时点冻结（前缀缓存纪律；表序变 = 边界事件，只发生在会话边界） |

## 8. preset（行组合预设）

Preset = 命名的行组合叠加层（S4-1a）。层序：

```
factory（出厂表，代码真源）
  → 用户层 patch（~/.lantai/composition/roster.patch.yml）
  → preset patch（叠加最上层——「这个会话的裁剪」叠在「这台机器的基线」之上）
```

- **内置 system preset**（代码常量，不落盘）：`standard`（零 patch =
  出厂组合）、`minimal`（禁 browser-desktop/web 工具行 + state-hooks
  capability 的精简面）。
- **用户 preset**：`~/.lantai/composition/presets/<id>/`：

  ```
  ~/.lantai/composition/presets/my-preset/
  ├── roster.patch.yml   # 组合本体（语法同用户层 patch——docs/composition/README.md）
  └── preset.yml         # 显示元数据（name/description/order——纯展示，坏文件降级不拒载）
  ```

- 选择与生效：设置 → Agent → 「组合」节选 preset（持久化到 settings）。
  **装配作用域**（tools/prompt/capabilities）：下次装配生效（新会话即见）；
  **壳作用域**（shell 域——V5 双装配挂点）：重启生效。
- **preset 不是分发单位**（2026-09-14 用户定调）：它是**用户自己配的环境**，
  不是出厂物，也不随插件分发——**manifest 不带 preset 字段**。平台提供的是
  **环境**：设置面板「组合」节的「打开目录 / 复制为模板 / 重新扫描」三个动作
  （目录按需创建、拒覆盖、免重启重扫），路径与用法见
  [`docs/composition/README.md`](../composition/README.md) §authoring。
  将来若要"分享一份 preset"，路径是**复制目录**（DSH copy-only authoring 同款），
  不是新打包通道。
- 同 id 内置胜（用户不可影子化内置 preset——内置 id 是部署事实）。
- 坏 preset（yml 语法错/校验失败）：发现层报 broken（设置面板可见），
  装配侧回退 factory——不炸发现。
- **组合可声明插件依赖与独占资源**（S6 P3b，2026-09-15）——两个可选顶层键：

  ```yaml
  requires:                    # 本组合依赖的插件（缺任一 ⇒ 组合不可用）
    - hologram/review-domain
  exclusive:                   # 本组合要独占的资源实例（同一时刻只允许一个组合持有）
    - port:9310
  ```

  失败面（两段式，都是**具名**的——比「未知行 id」可读）：`requires` 缺插件时
  在**选择期被拒**（「组合 X 需要插件 Y，但它未装载」；旧选择与设置不动），
  在解析期（开卷兜底路径）回退用户层组合 + 原因可见、**不阻断开卷**。
  「在册」判据两条任一即可：插件名下有存活工具行（`plugin/<插件名>/…`），或
  插件列表里有 `active` 记录（面板/命令类插件靠这条）。`exclusive` 声明的资源
  与插件 `activation.exclusive` 同等参与**装配期冲突检测**：两个插件同时要同一
  资源 ⇒ 后装配者被拒（fail loud、原因含双方 id），拒绝后装配者不留账；先装配者
  不受影响，一方释放后另一方即可装配。诊断面：设置面板「组合」节的**第四栏
  「被跳过」**显示激活失败的插件与原因（「某行不见了」的第四种原因）。

## 9. 未决项（如实声明）

- **贡献壳行的逐行 patch 寻址**（2026-09-26 如实记）：`ctx.shellRows` 的贡献行目前
  **只能随产物整体禁用**（kill switch = 插件禁用面），尚未并入组合 `shell` 域 ⇒
  不能在 preset/patch 里按行 id 单独禁用/启用；内核行（`hologram/shell-*`）照旧可寻址。

- ~~**插件 prompt-section 贡献通道**~~ ✅ 已落地（P4 A-1，2026-08-23）：
  `ctx.prompts`（`composition/prompt-service.ts`）——段贡献经
  factoryComposition 快照进组合解析域，下次装配生效；§3。
- ~~**贡献段/行的组合解析域**~~ ✅ 已落地（S4-4 甲，2026-08-23）：
  `plugin/…` 工具行与 prompt 贡献段（含 13 第一方段）全量进寻址域
  ——patch/preset 可禁用/覆盖/锚定（快照语义 + cache 代数失效，
  `composition/roster.ts` `factoryComposition()`）。
- ~~**机器桥（manifest mcpServers）**~~ ✅ 已落地（S4-4 乙，2026-08-23）：
  声明式挂接外部 MCP server——stdio（Rust 进程桥 + command 相对插件目录
  解析）/ http 双传输；lazy/startup-error 失败策略；行 id
  `plugin/<插件名>/mcp/<server名>` 进寻址域；kill 挂插件 fiber disposer；
  §3「MCP 机器桥」。
- **版本比较/更新提示**：~~安装期版本比较~~已落地（平台化 P3：同名重装
  semver 比较，升级换装 / 降级拒绝 / force 逃生——§5）；更新提示 UI
  （已装版本 vs registry latest 的角标）属增强。
- **preset 的 UI 选择面**：当前只有设置面板默认值 + 新会话携带默认
  （DSH 四面砍到最小——新会话 chip / 会话头标签 / 管理节留给 V5 壳）。
- **机器桥断线重连监督**：lazy 的装配期重试已落地；受治面（治理字段在场）
  已由 `restart: "on-crash"` 承担（S2）——旧形态（无治理字段）的定时退避
  重连 + 工具面动态重注册属增强（v1 未做，如实声明）。
- ~~**mcpServers http 传输鉴权**~~：headers 明文进 manifest——插件目录是
  全信任区，与 command 同级，不做加密仪式（既定立场维持）。
- **软件级插件的管理 UI 面**（启动器/任务栏）：窗口原语（§10）已落地，
  管理面（第一方产物形态，与 canvas-nav 并列走产物流）**待用户参与设计
  定稿后另批施工**——只 gate 该子件，装载/开窗/工具链路不依赖它（当前开窗
  走插件工具如 `notes_open` 或测试面）。

## 10. 软件级插件（app shell 四件套）

「贡献零件」（面板/命令/工具/prompt 段）之上的形态：**完整软件以插件形态
住进兰台**——装载即给数据地盘、开窗即视图、工具驱动即干活、卸载即整体
回收。软件插进来 = 在画布上开一扇窗，窗带三样契约：空间所有权、开合即
生命周期、窗后地盘（2026-09-03 形态判断）。全程范本：
`examples/plugins/notes-app/`（分步指南见
[`docs/cookbook/plugin-as-software.md`](../cookbook/plugin-as-software.md)）。

### 10.1 责任切分（协议面是插件作者的义务）

宿主只提供基础设施，不为「软件不配合」负责。插件作者可选择不开放协议面
（纯 GUI 软件）——**允许装载但不进 Agent 主路**（没工具 = Agent 驱动不了，
不承诺视觉兜底进编排；manifest 无 tools 时装载不告警不拦截）。

### 10.2 四件套（宿主基础设施 × manifest 字段）

| 件 | manifest 字段 | 宿主给什么 |
|---|---|---|
| **A 窗口原语** | `app: { entry: "./app/index.html" }`（资产 HTML）**或** `app: { url: "http://127.0.0.1:<port>/…" }`（**环回**远端页，二态互斥必给其一）；`mode?: "floating"\|"dock"\|"fullscreen"`（url 形态禁 fullscreen）；`title?` | 装载只登记窗口定义；开窗才实例化 iframe 视口。**入口二态（契约 v28，2026-09-13）**：①`entry` = 插件自包含 HTML——**真隔离**：sandbox 无 allow-same-origin，窗内容拿不到宿主桥，窗内向宿主要能力走 **postMessage 白名单桥**（协议 `lantai-plugin-bridge`，call/result 按 reqId 关联；默认最小集 `fs.list/read/write/delete` + `notify`，方法级白名单克制开面；**插件身份由容器侧绑定**——窗内消息不携带也不可信插件名）；宿主→窗广播限 `bridge-ready` / `window-closing` 两种。②`url` = **环回**远端页（本机服务，如 `officecli watch` 活预览）——iframe 给 `allow-same-origin`（跨源文档保住自己 origin，其同源 `EventSource`/`fetch` 才通；父页仍拿不到它的 DOM），**且不绑宿主桥**（远端文档不是插件代码）。白名单：host ∈ {127.0.0.1, localhost, ::1}、禁凭据、禁非 http(s)——远端文档能覆盖宿主视觉面，所以只许环回 + 禁全屏。窗口设施（开/关/聚焦/模式/查询）经宿主桥 `windows` 键暴露——**宿主能力面非工具面**：工具语义归插件（插件在 tools 声明「开窗」工具，执行体调设施） |
| **B 数据目录** | `dataDir: true` | 装载即分配 `<数据根>/<插件名>/`（幂等 ensure）；受治进程经 spawn env `LANTAI_PLUGIN_DATA_DIR` 拿到路径；窗经桥 fs 读写（Rust 侧名字 + rel 双围栏 + canonicalize 前缀锁死插件根）；卸载随 `plugin_uninstall` 整体挪 `.trash` 回收（备份一个目录全家走） |
| **C 受治进程** | `mcpServers` 条目 `restart?: "off"\|"on-crash"` / `lifecycle?: "lazy"\|"eager"\|"with-window"`（任一在场 = 受治面；皆缺席 = 旧形态不变；http 条目声明治理字段拒绝） | 就绪 = initialize 握手 + tools/list 限窗完成（缺省 60s，到点判启动失败 + 杀挂壁进程）；on-crash 指数退避重启（1s×2 封顶 30s）；三档生命周期（lazy：装配/调用/开窗拉起 + 空闲回收 5min，无窗才计时；eager：装载即拉起卸载才停；with-window：随窗开合，关窗默认杀）；未就绪调用立即报 `service_not_ready` + 触发拉起（宿主永不阻塞等待）；进程树终止（Windows taskkill /T；kill 挂插件 fiber） |
| **D 后台唤醒** | tools 条目 `async: true`（工具口） | 执行即返回卡片（宿主生成 taskId 注入 `args._task_id` + 登记发起者）；完成唤醒发起 Agent + **minimal 定位键 `{status, taskId, sessionId}`**（内容不进唤醒体——凭 taskId 调插件工具按需取）；MCP 路对位：server 完成通知 `lantai/deferred`（params.progressToken 回带调用期 token）由桥翻译成同一唤醒 |

### 10.3 两张门规则（决策 8——没有第三张门）

工具进 Agent 主路只有两张既有门：

- **工具口**（`manifest.tools` + entry 的 `toolHandlers`）：实现必须住在宿主
  webview（窗口设施这类宿主能力——Node 进程碰不到）；
- **MCP 路**（`mcpServers` + tools/list）：实现住在进程里——需要进程的软件，
  后端就是 MCP server（对宿主说 MCP，对自己的窗说自己的 HTTP API——
  **app 内部的事宿主不掺和**；纯 GUI 软件的后端 = 零工具 MCP server）。

不做的：「工具执行体 fetch 自己进程」的代理层、服务地址注入、raw（非 MCP）
进程形态——真出现拒绝 MCP 形状的后端需求再扩 manifest，不预建。

### 10.4 装载 / 回收语义

- **装载**：manifest 校验（软件级字段见上表）→ 数据目录 ensure（失败 = 插件
  error 记录）→ entry.apply → 工具声明挂接 → MCP 注册（eager 档装载期拉起
  到就绪，失败 = 插件 error）→ 窗口定义登记（纯数据，开窗才实例化）。
- **开窗 / 关窗**：开 = iframe 视口实例化 + 受治进程拉起（lazy/with-window）
  + 空闲回收计时清零（lazy）；关 = 实例回收 + with-window 计数归零即杀。
- **卸载**：fiber dispose 链式——工具贡献注销 + 受治进程树终止 + 窗全关 +
  定义摘除；数据目录随 `plugin_uninstall` 挪 `.trash`（回收失败降级 warn
  不阻断卸载——数据留原位是安全方向）。
- **契约版本**：软件级字段全在开放面契约（v14-v17 起，app 入口二态见 v28；
  `docs/agents/open-surface-contract.md` 变更记录逐版在案）。

---

**维护注**：本文件是插件面的人类契约——通道 API / 生效语义 / 信任模型
变更时必须同步更新（规则与代码现状同步铁律）。机器可读的真源：
`src-ui/src/plugins/types.ts`（manifest schema）、
`src-ui/src/composition/services.ts`（组合层 service 本体：panels/commands/tools/llm/activation）、
`src-ui/src/composition/renderer-service.tsx`（块渲染器）、
`src-ui/src/composition/prompt-service.ts`（prompt 段）、
`src-ui/src/composition/hook-service.ts`（管道钩子）、
`src-ui/src/composition/plugin-tool-rows.ts`（工具行折算）。
