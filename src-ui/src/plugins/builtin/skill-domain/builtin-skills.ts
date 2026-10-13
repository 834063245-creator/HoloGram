// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 出厂技能（builtin skills）——随 exe 分发的第三发现根（2026-09-08）。
//
// 背景：技能系统只扫两个磁盘根（项目 .lantai/skills + 用户 ~/.lantai/skills）
// ——分发 exe 给用户时两个根都是空的，Agent 手里的兰台特有知识只剩这里。
// 本模块把第一方技能编译进 bundle：随 exe 逐位分发、无磁盘种子、无版本
// 漂移（exe 更新即同步更新；skill-domain 随包后改内容 = 换产物热更）。
//
// 当前三门（2026-10-13）：
//   - lantai-plugin-dev：给兰台写插件（动态 cordis / 静态 manifest / MCP /
//     软件级插件）——分发环境下「扩展兰台」的唯一权威手册；
//   - officecli：office 域工具动作面手册（自 examples/office-cli/SKILL.md
//     收编）——模型的 shell 里没有 officecli，本手册是唯一正确姿势；
//   - lantai-guide：兰台产品地图（入口 / 设置页 / 扩展生效时机 / 数据与
//     日志 / 排障对照）——「用户问兰台本身怎么用」的缺省知识。
//
// 优先级：项目 > 用户 > 出厂（scanSkills 收集序实现同名去重——用户/
// 项目可用同名技能覆盖出厂版，出厂面不可删不可改）。
// 形状对齐 SkillDef（name/description/whenToUse/prompt）；无 dir（不在
// 盘上——${LANTAI_SKILL_DIR} 占位符不适用，内容必须自包含）。

/** 出厂技能条目（SkillDef 的构造材料——source/dir 由 scanSkills 补全）。 */
export interface BuiltinSkillDef {
  name: string;
  description: string;
  whenToUse?: string;
  prompt: string;
}

const PLUGIN_DEV_PROMPT = `# 为兰台写插件——Agent 操作手册

兰台（Lantai）是插件化架构：**九条贡献通道**（面板 / 命令 / 模型工具 / LLM 协议
适配器 / 块渲染器 / system-prompt 段 / 管道钩子 / 会话能力 / 画布覆盖层）+ **五条
可换后端 seam**（fs / shell / sessionPersistence / subagents / agentLoop）——全部经
同一套注册机制（同一个 \`ContributionChannel\` 内核：id 寻址 + 重名装载期拒绝 +
幂等 disposer + 声明式生效时机），第一方与第三方一致。
用户让你「加个功能 / 写个插件 / 接个工具」时，按本手册动手。

## 0. 先选形态（四条路，按需求定）

| 用户要什么 | 用哪条路 |
|---|---|
| 本会话内 Agent 自己用的工具/能力（快速、临时） | **动态插件**（§1）——cordis 工具当场 define→run，无文件落盘 |
| 面板、命令、重启后仍在的持久功能 | **静态插件**（§2）——写 manifest.json + entry.js 落盘安装 |
| 接一个现成的 MCP server（Node/Python 进程或远程 HTTP） | **MCP 挂接**（§2.6）——零插件代码，声明即接 |
| 一个**能开窗的软件形态**（自己的窗口界面 + 自己的工具，像独立小软件住进兰台） | **软件级插件**（§2.7）——manifest 声明 \`app\`（相对 HTML 或环回 URL），宿主给窗口注册表 + 设施 API + 受治进程随窗开合 |

判断不了时问用户一句：这个功能是「以后一直要有」还是「现在先用一下」。
形态可以叠加：一个插件能同时有面板 + 命令 + 工具 + MCP + 窗口。

## 1. 动态插件（cordis 工具族——最快路径）

你手里有 \`cordis\` 域工具：define（定义不执行）/ run（激活，首次要用户批准，
拒绝即终局不再重问）/ stop / undefine / inspect_list / inspect_self（诊断）。

- \`code\` 是**纯 JS 函数体**：\`return { name?, apply(ctx) { ... } }\`。
  无 TypeScript、无 import、无 JSX。
- 沙箱：window/fetch/document/eval/Function/localStorage/require/process 等
  23 个危险全局在源码内恒为 undefined——拿不到 DOM/网络/存储/动态求值。
- 预算：源码 ≤256KB；apply ≤10 秒；贡献总数 ≤64 条，超限取消并回收。
- \`apply(ctx)\` 收**守卫代理**，只有两个面：
  - \`ctx.effect(fn, label)\`——fn 返回 disposer；
  - \`ctx.<服务>.register(def)\`——**守卫白名单**里的注册面（\`agent/dynamic-runner/sandbox.ts\`
    的 \`GUARDED_SERVICES\`，2026-09-14 校准后 = 九条贡献通道 + 五条 seam 全量 14 面）：
    tools / panels / commands / llm / prompts / hooks / capabilities / renderers /
    overlays / fs / shell / sessionPersistence / subagents / agentLoop。
    白名单与真装配同集由测试对拍（列了平台没有的服务即红），照它写不会踩空。
  - 白名单外的属性访问、任何赋值 → 响亮报错。直调 register 不包 effect
    是合法的（disposer 由宿主回收袋管理）。
- 贡献 def 形状与静态插件完全同构（见 §2.3）——def 缺 id / 缺函数成员
  在 register 时被拒。
- 工具贡献生效时机：**下次 Agent 装配**（新会话）；面板/命令即时。

最小样例（注册一个工具）：

\`\`\`js
return {
  name: 'my-dynamic',
  apply(ctx) {
    ctx.tools.register({ id: 'my/dynamic-tool', factory: () => ({
      name: () => 'my_dynamic_tool',
      description: () => '示例动态工具',
      parameters: () => ({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }),
      readOnly: () => true,
      execute: async (args) => '结果: ' + String(args.q),
    }) });
  },
};
\`\`\`

流程：\`cordis(define)\`（kind=new，idPrefix 3-6 个小写字母）→ \`cordis(run)\`
（用户批准）→ 失败用 \`cordis(inspect_self)\` 看诊断 → 改新版用
kind=existing 追加包 + mode=update 切换（旧包可回滚）。

## 2. 静态插件（持久形态）

### 2.1 文件结构与 manifest

一个目录 + 两个文件，目录名必须等于 manifest 的 \`name\`：

    <插件目录>/
    ├── manifest.json
    └── entry.js

manifest.json 字段（\`name\`/\`version\`/\`entry\` 必填）：

| 字段 | 说明 |
|---|---|
| \`name\` | npm scope 风格 id，≤2 段（\`hello\` 或 \`acme/foo\`），小写字母数字连字符；必须等于目录名 |
| \`version\` | semver 字符串（\`1.0.0\`） |
| \`entry\` | 相对路径 \`.js\`/\`.mjs\`，禁绝对路径与 \`..\` |
| \`description\` | 插件列表展示的一句话 |
| \`inject\` | 依赖的 ctx 服务名数组（如 \`["panels","commands","tools"]\`）——缺依赖时插件挂起等待，装载审计可见 |
| \`permissions\` | 权限类声明数组（\`read\`/\`edit\`/\`bash\`/\`git\`/\`web\`），未获用户授予则不装载（blocked，设置页可见缺哪些） |
| \`tools\` | 声明式工具（§2.4） |
| \`mcpServers\` | 声明式 MCP 挂接（§2.6） |
| \`dataDir\` | \`true\` = 装载即分配专属数据目录（\`<数据根>/<插件名>/ \`，经宿主桥 fs 面读写，卸载随插件回收进 .trash） |
| \`app\` | **软件级插件**（§2.7）：窗内容入口 + 窗模式——\`{ entry: './app/index.html' }\`（插件自包含 HTML）**或** \`{ url: 'http://127.0.0.1:PORT' }\`（环回页；仅本机、禁凭据）；\`mode\`: \`floating\`（缺省）/ \`dock\` / \`fullscreen\`（环回 URL 形态禁 fullscreen） |
| \`displace\` | \`true\` = 位移式装载：与同名内置插件共享行 id（贡献面单活互换）；第三方同名产物声明 true 可覆盖同名内置插件 |

### 2.2 entry.js 规则与宿主桥

- \`export default { name, inject?, apply(ctx) { ... } }\`（或命名导出同形状
  对象；\`toolHandlers\` 是声明式工具的保留命名导出）。
- \`apply(ctx)\` **只做注册动作**——装载期禁止任何 UI 副作用。
- 每个注册返回的 disposer 必须
  \`ctx.effect(() => disposer, '标签')\` 登记——这是生命周期纪律：插件
  卸载即链式回收全部贡献。
- **自包含，零裸 import**：插件运行时没有包管理器也没有 import map，
  \`import 'react'\` 这类解析不了。要 UI/能力走全局宿主桥
  \`globalThis.__lantai_plugin_host__\`：

| 桥键 | 用途 |
|---|---|
| \`createElement\` | React.createElement（无 JSX 构造组件） |
| \`react\` | React 全量（jsx-runtime 形态） |
| \`hooks\` | useState/useEffect/useRef/useCallback/useContext/useId/useImperativeHandle/useLayoutEffect/useMemo/useReducer/useSyncExternalStore |
| \`Overlay\` | 浮层组件 |
| \`rpc\` | \`(method, params) => Promise\` 调宿主 RPC |
| \`notify\` | \`(text)\` 状态栏通知 |
| \`loadCss\` | \`(url)\` 幂等注入插件 CSS |
| \`fs\` | 插件数据目录面（ensure/list/read/write/delete——manifest.dataDir 声明后用） |
| \`windows\` | 开/关/聚焦插件窗口（manifest.app 声明的软件形态） |
| \`deferred\` | 后台唤醒：\`complete(taskId, status, message?)\`（async 工具用） |
| \`mods\` | 宿主模块真实例注册表（进阶） |

### 2.3 贡献通道与 def 形状（全部经 \`ctx.<服务>.register(def)\`）

**panels**（面板，即时生效）：

\`\`\`js
ctx.panels.register({
  id: 'my-panel',            // 稳定 id；同 id 撞名装载期拒绝（不静默覆盖）
  side: 'right',             // 'left' | 'right' | null（null = 不上轨道）
  title: '我的面板',
  icon: 'chat',              // 宿主图标集键名（'agent'/'chat'/'check'/'settings'/'folder-open' 等天文几何图标键）
  askAgent: true,            // 可选：面板内提供「问 Agent」入口
  component: () => ce('div', { style: { padding: 16 } }, '内容'),
});
\`\`\`

**commands**（命令，即时生效，Ctrl+K 可搜）：

\`\`\`js
ctx.commands.register({
  id: 'my/say-hi',           // 惯例 '<插件名>/<动作>'
  label: '打个招呼',
  description: '示例命令',
  group: '插件',
  slash: '/hi',              // 斜杠触发词（可选；缺省 = 不可斜杠触达，只进 Ctrl+K 面板）
  kbd: 'ctrl H',             // 键位提示（可选，仅展示——真实绑定在全局快捷键层）
  action: { type: 'local', handler: (arg) => host.notify('👋' + arg) },
  // action 四型：{ type:'send', text, displayLabel } 发消息给 Agent
  //           { type:'local', handler(arg) } 本地执行（arg = 斜杠参数，无参为空串）
  //           { type:'fill', text } 填充输入框
  //           { type:'skill', skillName } 执行技能
});
\`\`\`

**tools**（模型工具，**下次 Agent 装配生效**——在途会话看不到，是前缀缓存纪律）：

\`\`\`js
ctx.tools.register({
  id: 'my/query',            // 折算后行 id = 'plugin/my/query'；两个插件前缀不同不撞
  factory: () => ({
    name: () => 'my_query',  // 模型可见工具名（重名装载期拒绝）
    description: () => '做什么',
    parameters: () => ({ type: 'object', properties: {}, required: [] }),  // JSON Schema
    readOnly: () => true,
    execute: async (args) => '结果',   // 返回字符串
  }),
  // noCache: true,          // 依赖装配期真值时用——每装配重调 factory
});
\`\`\`

**renderers**（块渲染器，即时，后注册胜）：

\`\`\`js
ctx.renderers.register({
  id: 'my/kind',             // 惯例 '<源>/<kind>'
  kind: 'my-block-kind',     // 目标块类型字符串；'*' = 兜底渲染器
  component: (props) => ce('div', null, '块内容'),  // props: { block, folded?, ... }
});
\`\`\`

**prompts**（system-prompt 段，下次装配生效）：

\`\`\`js
ctx.prompts.register({
  id: 'my/section',
  applicable: (c) => !!c.projectPath,   // 可选：返回 false 跳过本段
  render: (c) => '\\n\\n## 本项目须知\\n…',   // 产出含自身前导分隔符的完整文本
});
\`\`\`

**hooks**（工具管道钩子，下次装配生效，进阶）：\`{ id, kind: 'enrich' | 'preflight', hook }\`——enrich 富化工具输出、preflight 工具预检。

**capabilities**（会话级能力，下次装配生效，进阶）：

\`\`\`js
ctx.capabilities.register({
  id: 'my/capability',       // 行 id（九条通道统一身份；历史名 key 已退役）
  phase: 'agent',            // 'context' | 'agent'
  when: (scope) => true,     // 可选：返回 false 跳过安装
  install: (scope) => { /* 注册工具/接线；不得做 teardown（归 ctx.effect） */ },
});
\`\`\`

**overlays**（画布覆盖层，即时）：\`{ id, slot: 'composer' | 'right-edge', component }\`。

**llm**（LLM 协议适配器，进阶）：\`{ id, kind: '<协议kind>', label?, create(rt) }\`——为 settings 的自定义协议提供 Provider 工厂，同 kind 后注册胜。

**seam provider**（后端替换，进阶）：\`ctx.fs\`/\`ctx.shell\`/\`ctx.sessionPersistence\`/\`ctx.subagents\`/\`ctx.agentLoop\` 各注册一个替换默认后端的实现——写这个等于换掉兰台的默认引擎，非必要不碰。（\`ctx.graph\` 图分析 seam 随图谱功能全量退役，2026-09-09。）

### 2.4 声明式工具（manifest.tools——更小的信任面）

工具声明放 manifest（数据），执行函数放 entry 的 \`toolHandlers\` 命名导出，
一一对应：

\`\`\`json
"tools": [ { "name": "hello_status", "description": "状态一句话", "parameters": { "type": "object", "properties": {} }, "readOnly": true } ]
\`\`\`

\`\`\`js
export const toolHandlers = { hello_status: async () => '装载正常' };
\`\`\`

加 \`"async": true\` 声明 = 执行即返卡片、宿主登记发起者，插件后台完成后经
宿主桥 \`deferred.complete(taskId, status, message?)\` 唤醒发起 Agent。

### 2.5 权限门禁

\`manifest.permissions\` 声明（\`read\`/\`edit\`/\`bash\`/\`git\`/\`web\`）未被
\`~/.lantai/plugins.json\` 的 granted 段全覆盖 → 不装载（blocked 状态，设置页
可见缺哪些授权）。无声明 = 零摩擦直接装载。

### 2.6 MCP server 挂接（零插件代码）

manifest 声明（或用户级 \`~/.lantai/mcp.json\`，形状同）：

\`\`\`json
"mcpServers": [
  { "name": "engine", "transport": "stdio", "command": "./server.cjs", "args": ["--serve"], "failurePolicy": "lazy", "readOnly": true }
]
\`\`\`

- \`transport\`：\`stdio\`（本地进程，command/args）| \`http\`（远程，url）；
- 相对路径 \`./\` 相对插件目录解析；用户级 mcp.json 的裸名 command 走 PATH
  （npx/node/...），相对形态相对 ~/.lantai 解析；
- \`failurePolicy\`：\`lazy\`（缺省：首装配连接，失败下次重试）|
  \`startup-error\`（装载期急连接，失败 = 插件 error）；
- 可选治理字段 \`restart: 'off' | 'on-crash'\` 与
  \`lifecycle: 'lazy' | 'eager' | 'with-window'\`（声明任一 = 进受治面：
  就绪握手带时限、崩溃退避重启、空闲回收；http 条目声明治理字段会被拒）。
- server 的工具经机器桥折算成宿主工具行（\`plugin/<名>/mcp/<server>\` 寻址，
  组合可禁用）。
- 可选 \`readOnly: true\`：**只读担保**（该 server 全部工具）。缺省不表态——
  按远端 \`annotations.readOnlyHint\` 判，仍无声明则 fail-closed **视为写**
  （plan 模式拦截 + 不进只读并行组）。只读 server 请显式声明；写型 server
  误声明 true 会重现「写动作绕过 plan 门禁」的洞。
- ⚠️ 挂接的子进程是**全权用户进程**（不经 fs 能力口、不受沙箱约束，可写
  任意路径）——需要沙箱/权限类/审计的动作走 shell 域，不挂 MCP。

### 2.7 软件级插件（app shell——带窗口的软件形态）

插件想「像一个小软件一样住进兰台」：有自己的窗口界面 + 自己的工具。manifest 只需
多一个 \`app\` 字段，窗内容**完全归插件**（iframe 真隔离，宿主不实现窗内语义）：

\`\`\`json
"app": { "entry": "./app/index.html", "mode": "floating", "title": "我的小软件" }
\`\`\`

入口二态（互斥，必给其一）：

| 形态 | 写法 | 隔离与能力 |
|---|---|---|
| 资产 HTML | \`"entry": "./app/index.html"\`（\`./\` 相对插件目录；须以 \`.html\` 结尾） | iframe 走 opaque origin，**宿主桥是它唯一的能力通道** |
| 环回远端页 | \`"url": "http://127.0.0.1:PORT"\`（只许本机 127.0.0.1/localhost/::1，禁凭据） | 给 \`allow-same-origin\`（远端页保住自己 origin，同源 SSE/fetch 才通）且**不绑宿主桥**；禁 \`fullscreen\` |

- \`mode\`：\`floating\`（缺省，画布浮动窗）/ \`dock\`（右停靠栏）/ \`fullscreen\`（盖满视口）。
- 窗内要宿主能力走 **postMessage 白名单桥**：默认最小集 = 数据目录 fs 面 + \`notify\`（\`manifest.dataDir: true\` + \`app\` 搭配最顺）。
- 宿主桥 \`windows\` 设施面（插件的工具执行体里调，工具语义归插件）：
  \`open(pluginName) → windowId|null\`（已开则聚焦返回原窗；v1 每插件单窗）、
  \`close(windowId)\`、\`focus(windowId)\`、\`setMode(windowId, mode)\`、
  \`list()\`、\`isOpen(pluginName)\`。
- **与受治进程联动**（S2×S3）：真开新窗才通知治理器——\`lifecycle: 'with-window'\`
  的 MCP server 随之拉起、关窗计数归零即杀；lazy 档有窗时不回收。所以「插件窗口 +
  自带后端进程」的软件形态 = \`app\` + \`mcpServers\`（带 \`lifecycle\`）两条一起声明。
- 卸载收口：定义注销 + 开着窗口全关（受治进程随关窗杀）。
- **当前没有窗口管理 UI 面**（启动器/任务栏形态待用户设计定稿）：开窗靠插件自己的
  工具（如范本 \`notes_open\`）——你写软件级插件时，记得给一个开窗工具，否则用户
  没有入口。
- 完整范本：\`examples/plugins/notes-app/\`（窗口 + 数据目录 + MCP 后端 + async 工具
  五件齐全）；指南：\`docs/cookbook/plugin-as-software.md\`；契约：\`docs/plugins/README.md\`
  §10。

## 3. 装载与验证（你的动作序列）

1. **写文件**：把插件目录写到用户指定位置（问用户或选项目内子目录——
   注意你的 fs 工具有工作区沙箱，写不进 ~/.lantai 时就写在项目里，让用户
   从那里装）。
2. **装载**：指引用户「设置 → 插件 → 安装框填目录绝对路径 → 安装」；
   或让用户把目录放进 ~/.lantai/plugins/（Windows 是
   %USERPROFILE%\\.lantai\\plugins）后重启。安装是**热装载**：面板/命令
   立刻出现，工具/段在**下次 Agent 装配**（新会话）生效。
3. **验证**：设置 → 插件 → 「已安装」组看状态。装载失败显示 error + 错误
   信息（失败隔离——单个插件失败不炸应用）；\`blocked\` = 权限未授予；
   挂起 = inject 依赖未就绪。改 entry.js 后：卸载再装（同版本重装被
   版本守卫拒绝）。
4. **工具面验证**：开新会话让用户确认工具可用。在途会话看不到新工具是
   纪律不是 bug。

## 4. 发布（可选）

插件目录加 \`package.json\`（\`"files": ["manifest.json", "entry.js"]\`）→
\`npm pack\` 产 tarball → \`npm publish --access public\`。用户安装三源：
本地目录路径 / tarball（URL 或 .tgz 路径）/ npm 包名（registry 缺省
registry.npmjs.org）。同名重装升级 = 原子换装；同版本/降级拒绝。

## 5. 红线清单（写插件前自查）

- entry.js **自包含**：零裸 import；React 经宿主桥 createElement/hooks。
- apply **只注册**，无 UI 副作用；disposer 全部经 ctx.effect 登记。
- 同 id 撞名装载期拒绝（throw，不静默覆盖）——选 id 用插件名做前缀防撞。
- 静态插件是**完全信任模型**：装进来 = 本机账户全权限。给用户装第三方
  插件前必须提醒供应链风险（npm 上的包 ≠ 审核过的包）。
- 动态插件是审批 + 沙箱模型：首次激活必须经用户批准；沙箱无进程级硬
  隔离，安全面 = 实现质量——写动态插件时不要试图绕守卫面。
- 图谱引擎（Rust 侧）扩展是源码仓库的事，不走本手册的插件系统。`;

/** office 域工具操作手册（出厂技能，2026-10-13 自 examples/office-cli/SKILL.md 收编）。
 *  officecli 后端二进制随安装包分发（宿主 exe 同级）；本手册是 office 域工具的
 *  权威动作面指引（模型的 shell 里没有 officecli，唯一正确姿势 = 域工具动作）。
 *  内容自包含（出厂技能无磁盘目录，${LANTAI_SKILL_DIR} 不适用）。 */
const OFFICECLI_PROMPT = `# office 域（OfficeCLI）——兰台一等工具的操作手册

兰台内置 **\`office\` 域工具**（\`office(action, …)\`），底层是 OfficeCLI 单二进制 Office 套件
（.docx/.xlsx/.pptx 读写 + 内置渲染/公式/透视引擎）。**执行面在强制层（Rust）**：命令由那边
拼装（二进制定位 + 引号 + 环境钉扎），经 \`process_cap\` 的 \`office_exec\` 动作在 os_sandbox 里
spawn；权限**只审你声明的目标文件**（\`file\` / \`out\`）——项目内直接放行，项目外或敏感路径才问
用户。plan 模式按动作分读写。

**你不需要写命令行**——动作与参数由工具层交成 argv，引号、路径、二进制定位都不归你管。
本手册讲的是"用哪个动作 + 参数怎么写才不出错"。

## 1. 动作面（12 个）

| 动作 | 干什么 | 关键参数 |
|---|---|---|
| \`view\` | 读数：\`mode\` = text / annotated / outline / stats / issues / html / svg / forms | \`file\` \`mode\` \`page\` \`json\` |
| \`get\` | 取某元素及其子节点 | \`file\` \`path\` \`depth\` \`json\` |
| \`query\` | CSS 式选择器查元素 | \`file\` \`selector\` \`json\` |
| \`validate\` | OpenXML schema 校验 | \`file\` |
| \`create\` | 建空白文件（类型由扩展名决定） | \`file\` |
| \`set\` | 改元素属性 | \`file\` \`path\` \`props\` |
| \`add\` | 加元素（可 \`parent\`/\`type\`） | \`file\` \`parent\` \`type\` \`props\` |
| \`remove\` | 删元素 | \`file\` \`path\` |
| \`batch\` | **≥3 处改动走它**：一次开关 + 原子回滚 | \`file\` \`items\` |
| \`merge\` | 模板 \`{{key}}\` 批量填充 | \`file\` \`out\` \`data\` |
| \`screenshot\` | 渲染成 PNG（页/整册） | \`file\` \`out\` \`page\` 或 \`grid\` |
| \`playbook\` | 载入逐格式构建指南（见 §6） | \`playbook\` |

**路径寻址**（\`path\`/\`selector\`）：1-based 本地名路径 \`/body/p[2]\`、\`/slide[1]/shape[@id=2]\`、
\`/Sheet1/A1\`；**优先用稳定形态** \`[@id=…]\` / \`[@paraId=…]\`（改完插删不漂）。\`file\`/\`out\` 支持
相对路径（按工作区根解析）。

## 2. 兰台侧铁律（违反必出错）

1. **落盘：不要手动 \`save\`，也不用管常驻进程**——域工具**不起**常驻进程（\`OFFICECLI_NO_AUTO_RESIDENT\`），每次调用自成一次 open/save，**字节当场写盘**（2026-09-15 实测：外来 resident 在场时本工具的写入也照常落盘、不被覆盖）。判定真源仍是 \`office(action:'view')\` 复核——不是因为它会丢，而是因为**你自己看不见图**、文案与字节可能不一致。
   · 若该文件早已被一个**外部**常驻进程持有（用户自己起的 \`watch\`、旧进程残留）：\`view\`/\`set\`/\`add\`/\`batch\` 都照常工作；只有 **\`create\` 会被那个进程的文件锁硬拒**（连 \`--force\` 也无效）——所以 \`create\` 之前工具会**自动先 close 掉它**，并在结果里告诉你（用户的活预览窗因此需要重新起 watch）。
   · 反过来：**外部程序**（Excel/WPS/兰台媒体回读）在那个 resident 持有期间读同一文件会被锁住——"改完别人看不到"多半是这个，不是你没保存。
2. **你自己看不到图**：\`screenshot\` 产出的是**盘上 PNG**，工具结果只回文本。要让用户看到效果：
   \`office(action:'screenshot', file, out:'<工作区绝对路径>.png')\` → 再
   \`show_asset(kind:'file', payload={filePath:'<该 png>', ext:'png', label:'第N页'})\`。
   **改完重截同一路径 + \`update_asset(assetId, …)\` 即可原地刷新纸面**（不必新开块）。
   你自己的机械自检走 \`validate\` + \`view issues\`（文本面）；视觉效果交人判，别替他下结论。
3. **不要在 shell 里手跑 \`officecli\`——本环境 shell 的 PATH 里没有它**（\`command not found\`）。二进制由**强制层**定位（\`$OFFICECLI_PATH\` → \`~/.lantai/tools/officecli/officecli.exe\` → 随包件（兰台安装目录，宿主 exe 同级）→ PATH 兜底），这是**有意**的：你自己下 shell 找二进制跑就开了**第二条通道**，两个常驻进程会互相覆盖写入（同上：报零失败、磁盘丢行）。\`install\` 子命令另会往别的 agent 目录写东西，更不要跑。**需要域工具没有的 CLI 能力时：如实告诉用户"这步本环境不可用"，不要绕路。**
   · 万一工具报「未找到 officecli 可执行文件」：本机缺后端（正常安装包自带）。如实告诉用户并建议重装兰台；**不要**自己去下载或找二进制。
4. **参数不合法时工具会直说**（如"set 需要至少一个 props"）——别硬试，按提示补参数。
5. **≥3 处改动一律 \`batch\`**：一次开关 + 原子回滚（默认任一失败整批回滚）。**单次别超 100 项 / 12KB**——超了工具会自动分批（批间不原子），而且一次塞太多会被命令行长度上限**静默**截断。
6. **失败就是失败**：工具结果以 \`[exit N]\` 起头、脚注只在 \`exit 0\` 时才说"已提交"。看到「未成功」就别当成功继续，按报错修参数。
7. Word/WPS 打开着目标文件时会写失败（文件锁）——请用户先关。

## 3. 三层读法：先大后小

\`\`\`
office(action:'view',  file, mode:'outline')     # L1：结构（文档/幻灯片大纲）
office(action:'view',  file, mode:'text')        # L1：全文（也用于扫占位符）
office(action:'view',  file, mode:'issues')      # L1：格式/内容/结构问题清单
office(action:'get',   file, path:'/body', depth:1)   # L2：某节点的子节点
office(action:'query', file, selector:'paragraph[style=Heading1]')  # L2：选择器
office(action:'set'|'add'|'remove'|'batch', …)   # L2：改
\`\`\`

需要裸 XML（\`raw\`/\`raw-set\`/\`add-part\`）时：域工具没有这些动作，**shell 里也没有 officecli** ⇒ 停下来把限制告诉用户（不要去找二进制跑）。

## 4. 交付门槛（报告"做完了"之前逐条过）

1. **Schema**：\`validate\` 干净；
2. **内容**：\`view issues\` 无溢出/格式/结构问题；并**必扫** \`view mode:'text'\` 找残留占位符
   （\`xxxx\`、\`lorem/ipsum\`、\`<TODO>\`、\`{{...}}\`、空 \`()\`/\`[]\`）；
3. **视觉**：布局敏感（幻灯片尤其）出 PNG 交人判（见铁律 2）；渲染不出来就如实说"未经视觉验证"。

### 4.1 \`view issues\` 抓什么（实测——决定你还要自己查什么）

**抓得到**（可信，别重复劳动）：

| 类 | 实测输出 |
|---|---|
| docx 格式 | \`[F1] Body paragraph missing first-line indent\` + \`Suggestion:\`（中文正文默认就报） |
| pptx 几何 | \`[O1] … extends 16.1cm past slide right edge\`（形状甩出画布） |
| pptx 溢出 | \`[O2] text overflow: 39 lines at 40.0pt need 1872pt, usable 21pt. suggest.height=66.3cm\`（**连改法都给**） |
| xlsx 公式错 | \`[F1] Formula error: #DIV/0!\` / \`[F2] … #VALUE!\`（带 \`Context:\` 原文） |
| xlsx 未求值 | \`[U3] Formula written but not evaluated\`——**求值器不认识的函数写了等于没值**（Excel 打开才现算） |

**抓不到**（盲区——**这些必须你自己查或交人判**）：

| 盲区 | 自检动作 |
|---|---|
| **占位符残留**（docx 与 pptx 都不报 \`{{x}}\`/\`<TODO>\`/\`xxxx\`） | 必扫 \`view text\`——**这一步是承重的**；\`merge\` 的失败形态就是**静默留下 \`{{key}}\`** |
| **图片缺 alt 文本** | 域工具没有这个动作、shell 里也没有 officecli ⇒ 如实说"未验证"，交人判 |
| **空白内容**（空文档/空段落/空标题页 → 0 issues，\`validate\` 也过） | 只能人判；**"干净"不等于"有东西"** |

> 三层分工：机械正确性交给 \`validate\` + \`issues\`；内容存在性与占位符残留自己扫；视觉交人判。

## 5. 四条高频工作流

### 5.1 卷 / 研究结果 → 交付物

\`\`\`
office(create, file:'报告.docx')
office(batch, file:'报告.docx', items:[
  { command:'add', parent:'/styles', type:'style',
    props:{ id:'Heading1', name:'heading 1', type:'paragraph', basedOn:'Normal' } },
  { command:'add', parent:'/body', type:'paragraph', props:{ text:'季度研究报告', style:'Heading1' } },
  { command:'add', parent:'/body', type:'paragraph', props:{ text:'本季度收入同比增长 25%。' } },
  { command:'add', parent:'/body', type:'table', props:{ rows:'3', cols:'3' } }
])
office(validate, file:'报告.docx')
office(view, file:'报告.docx', mode:'issues')
\`\`\`

- **新建 .docx 里只有 \`Normal\` 一个样式**（实测）——要用的样式**先定义**（上面 batch 第一项），
  否则 \`style=Heading1\` 会警告 \`not found in styles part\`。
- **中文正文必须设首行缩进**：默认 \`view issues\` 会报 \`[F1] Body paragraph missing first-line indent\`
  （而 \`validate\` 是干净的——**validate 通过 ≠ 可交付**）。修：
  \`office(set, file, path:'/body/p[2]', props:{ firstLineChars:'200' })\`（1/100 字符单位 = 2 字符）。

### 5.2 模板 → 批量交付（设计一次，灌 N 次）

\`\`\`
office(batch, file:'模板.docx', items:[{ command:'add', parent:'/body', type:'paragraph',
  props:{ text:'客户：{{client}}' } }])
office(merge, file:'模板.docx', out:'成品-001.docx', data:{ client:'Acme', total:'5,200' })
\`\`\`

- \`merge\` 回执带 \`Replaced keys: N\`（实测：2 个键 → \`Replaced keys: 2\`）。
- **灌完必扫 \`view text\` 确认没有残留 \`{{\`**——失败了它不报错（见 §4.1 盲区）。
- 想拿现成版式当模板：officecli 的 \`dump\` 蓝图流 + \`batch --input\` 回放**本环境用不了**（域工具无此动作、shell 无二进制）⇒ 手写 \`batch\` 复刻版式，或如实说明受此限制。

### 5.3 既有文档注疏 → 回写

\`\`\`
office(view,  file:'来文.docx', mode:'annotated')     # 带格式标注地读
office(add,   file:'来文.docx', parent:'/body/p[1]', type:'comment', props:{ text:'口径需与附件核对' })
office(set,   file:'来文.docx', path:'/body/p[2]/r[1]',
            props:{ 'revision.type':'ins', 'revision.author':'兰台' })
office(query, file:'来文.docx', selector:'revision', json:true)   # 读回（含 nativePath）
\`\`\`

- **批注不能用 \`view annotated\` 验**——它只给正文 + 格式；批注走 \`office(action:'get', path:'/comments')\` 或 \`office(action:'query', selector:'comment')\`。
- **一个 run 同时只能挂一个修订**：叠第二个会报 \`run is already inside a track-change wrapper\`。
- **⚠️ 读数陷阱（实测）**：**待决删除的文本在 \`view text\` 里不出现**（那段看起来是空的），
  而 \`view annotated\` 里**照常显示、且不标注**它处于修订态 ⇒ **判定修订状态只有一个真源：
  \`office(action:'query', selector:'revision')\`**。
  读带修订的来文时先跑它，否则你会以为某段不存在、或以为某段是原文。

### 5.4 幻灯片

\`\`\`
office(create, file:'汇报.pptx')
office(add, file:'汇报.pptx', parent:'/', type:'slide', props:{ title:'季度汇报', background:'1A1A2E' })
office(add, file:'汇报.pptx', parent:'/slide[1]', type:'shape',
       props:{ text:'收入增长 25%', x:'2cm', y:'5cm', size:'24', color:'FFFFFF' })
office(screenshot, file:'汇报.pptx', out:'<绝对路径>-第1页.png', page:1)
office(screenshot, file:'汇报.pptx', out:'<绝对路径>-全册.png', grid:true)   # 整册联系表
\`\`\`

标题是**占位符**（\`isTitle=true\`，positional \`shape[1]\`）；改标题请用稳定寻址 \`shape[@id=…]\`。

## 6. 专项构建指南（\`playbook\` 动作——按需载一个）

| 场景 | playbook |
|---|---|
| 研报 / 论文 / 学术报告（引用、公式、交叉引用、多栏） | \`academic-paper\` |
| 通用 Word（报告、信函、备忘录、方案） | \`word\` |
| 可填写表单（内容控件/表单域/邮件合并/文档保护） | \`word-form\` |
| 通用幻灯片（汇报、评审、发布） | \`pptx\` |
| 融资路演 | \`pitch-deck\` |
| 动效 / Morph / 3D 演示 | \`morph-ppt\` / \`morph-ppt-3d\` |
| 通用表格、公式、透视 | \`excel\` |
| 财务模型 / 预测 | \`financial-model\` |
| 数据看板（CSV → KPI/图表） | \`data-dashboard\` |

**实测体量 25–65 KB**（\`morph-ppt-3d\` 25.2 / \`data-dashboard\` 28.7 / \`excel\` 34.4 / \`word\` 41.8 /
\`pptx\` 43.6 / \`academic-paper\` 44.4 / \`word-form\` 46.1 / \`financial-model\` 46.7 / \`morph-ppt\` 47.8 /
**\`pitch-deck\` 64.9，最大**）。
⇒ **一件产物只载一个**（载入后规则持续有效，别每轮重载）；没把握时先载再动手，比试错便宜。

⚠️ **正文是 officecli 自带的命令行指南**（488 行里 101 条 \`officecli …\` 命令，含强制的
"Help-First Rule: 先查 help 再动手"）。**那些命令行在本环境一律不可执行**——工具返回时会
前置一段护栏头，照它把每条命令**翻译**成 \`office(action,…)\`；正文要你查 help 时，改用
**一条最小 batch（1 项）**试探属性名，**不要**下 shell。

## 7. 常见坑（实测/读码得出）

| 坑 | 正解 |
|---|---|
| 新建 docx 里 \`style=Heading1\` 报警告 | 新建文档只有 \`Normal\`，先 \`add /styles --type style\` 定义（§5.1） |
| \`view issues\` 报中文正文缺首行缩进 | \`props:{ firstLineChars:'200' }\`（2 字符） |
| 同一 run 上叠第二个修订被拒 | 一 run 一修订；换 run，或用 \`revision.type=format\` |
| 带修订的文档"少了一段" / 看不出哪段有修订 | \`view text\` 隐藏待决删除、\`annotated\` 不标注——真源是 \`query revision\` |
| 占位符残留没人报 | 自己扫 \`view text\`（§4.1） |
| 图片缺 alt 没人报 | 域工具无此动作、shell 无 officecli ⇒ 如实说"未验证" |
| 改完看不到效果 | \`screenshot\` 出 PNG + \`show_asset\` 给用户看（你看不到图） |
| xlsx 公式没有值 | 求值器不认识的函数写了等于没值——看 \`issues\` 的 \`[U3] not evaluated\` |
| 单位写成 \`%\` 被拒 | 长度只收 cm/mm/in/pt/pc/px/Q/裸 EMU；\`%\` 只在行距有效（§8） |
| Windows 文件锁 | Word/WPS 打开着目标文件时写失败——请用户先关 |
| 后端版本漂移 | 后端随兰台分发（pin 1.0.149）；工具行为以本手册为准，不要试图升级/替换后端 |

## 8. 单位与颜色（值一律写在 \`props\` 的字符串里）

**长度**：\`cm\` / \`mm\` / \`in\` / \`pt\` / \`pc\` / \`px\` / \`Q\` / **裸 EMU**（\`914400\` = 1 英寸）。
⚠️ **\`%\` 不是合法长度**——只在**行距**上有意义。

**颜色**：6 位 hex（\`FF0000\`）/ 3 位简写（\`F00\`）/ 8 位含 alpha（\`80FF0000\` = AARRGGBB）/
4 位简写（\`#F00A\`）/ 命名色（\`red\`）/ \`rgb()\` \`rgba()\` \`hsl()\` / \`transparent\` / 主题色 \`accent1\`..\`accent6\`。
回执会带归一化结果（\`rgb(255,0,0) → applied #FF0000\`；带 alpha 读回是 \`#RRGGBBAA\`）。

**行距**：倍数 \`1.5x\` / 百分比 \`150%\`（→ \`1.5x\`）/ 定值 \`18pt\` / 长度 \`0.5cm\`（→ 14.15pt）/ \`1in\`（→ 72pt）。
**字号**：\`14\` 或 \`14pt\`。

## 9. 活预览（可选，看纸面效果）

**本环境起不了 watch**（shell 里没有 officecli）⇒ 用 §5 的截图路：改完 → \`screenshot\` 出 PNG →
\`show_asset\` 给用户看。若用户想边改边看实时刷新，如实说明这一版还不支持。`;

/** 兰台产品地图（出厂技能，2026-10-13）：分发环境下 Agent 对「兰台是什么、入口在哪、
 *  什么时候生效」的缺省知识——命令 / 设置页 / 扩展三路 / 数据与日志 / 排障对照。内容自包含。 */
const LANTAI_GUIDE_PROMPT = `# 兰台——产品地图与操作手册（Agent 用）

兰台是桌面 Agent 软件：以「工作区」（打开的目录）为作用域，与你的对话写成**案卷**（会话），主界面「纸壳」按注疏版式呈现（来文＝用户 / 正文＝回答 / 夹注＝思考 / 脚注＝工具 / 抄录＝代码 / 贴黄＝通知）。随包另配 HoloGram 图谱引擎（独立进程、应用内默认关；开启后其工具以 \`mcp__hologram__*\` 出现）。

本手册回答：功能在哪、怎么操作、什么时候生效、出问题看哪里。写插件看 \`lantai-plugin-dev\` 技能；做 Office 文档看 \`officecli\` 技能。

## 1. 命令与快捷键（最快入口）

- **Ctrl+K** 命令面板（全部命令，可搜索）；**\`/\`** 斜杠命令面板（同一份清单的斜杠子集）。
- **Ctrl+P** 纸视图开合（回案卷首页）；**Ctrl+,** 设置面板；**Esc** 逐层关闭。
- 内建斜杠命令：\`/new\`（新开一卷 / 重置当前案卷）· \`/compact\`（压缩上下文）· \`/compact-stats\`（压缩统计）· \`/export\`（导出案卷为 Markdown）· \`/goal\`（自主目标：\`status\`/\`resume\`/\`cancel\`）· \`/memory\`（列出记忆）· \`/remember <事实>\`（存一条事实）。
- 面板命令：\`/settings\`（设置）· \`/paper\`（纸视图）· \`/sidebar\`（案卷侧边栏开合）· \`/dock\`（创作坞）。

## 2. 设置页（八个页签，用户配置的唯一入口）

| 页签 | 管什么 |
|---|---|
| 提供方 | 模型连接：端点 / 密钥 / 模型 / 思考档位；也读 YAML 文件（\`~/.lantai/providers.yml\`、\`<工作区>/.lantai/providers.yml\`，改动约 1 秒自动生效） |
| Agent | Agent 行为与组合（preset 诊断与选择） |
| 显示 | 外观与界面偏好 |
| 插件 | 插件安装 / 卸载 / 启停（安装＝目录绝对路径 / tarball / npm 包名） |
| 技能 | 技能列表（「内置」＝随应用分发的出厂技能，不可删改）/ 新建 / 删除 |
| MCP | 用户级 MCP server（存 \`~/.lantai/mcp.json\`）；变更需重启应用 |
| 诊断 | 日志级别开关＋一键导出诊断包 |
| 关于 | 版本与更新 |

## 3. 扩展三条路（选型 + 生效时机）

| 想做什么 | 走哪条 | 怎么装 |
|---|---|---|
| 让 Agent 以后按某套流程干活 | **技能** | 设置→技能 新建；或放 \`<工作区>/.lantai/skills/<名>/SKILL.md\`（项目级）/ \`~/.lantai/skills/<名>/SKILL.md\`（用户级） |
| 给兰台加界面能力（面板 / 命令 / 工具 / 渲染器 / MCP / 软件窗口） | **插件** | 设置→插件 安装（完整手册见 \`lantai-plugin-dev\` 技能） |
| 接一个现成 MCP server | **MCP** | 设置→MCP；或编辑 \`~/.lantai/mcp.json\` |

**生效时机纪律（最常被误解，先讲清再答）：**

- 面板 / 命令 / 设置项：生效即时。
- 模型工具 / 提示词段 / 技能目录：**下次 Agent 装配（新会话）**。在途会话看不到新工具，这是刻意的前缀缓存纪律，不是坏了。
- MCP server：重启应用后重装（boot 期读取）。

## 4. 数据在哪（帮用户找东西 / 排障用）

| 位置 | 内容 |
|---|---|
| \`<工作区>/.lantai/sessions/\` | 案卷数据（会话物理归属工作区） |
| \`<工作区>/.lantai/skills/\` | 项目级技能 |
| \`<工作区>/.lantai/logs/\` | 日志三份：\`ui.log\`（前端）· \`bridge.log\`（工作区期）· \`boot.log\`（启动期）；8 MiB 滚代、保 2 代（\`.1\` / \`.2\`） |
| \`<工作区>/.lantai/diag/\` | 诊断包导出（纯文本单文件，保最近 10 份） |
| \`<工作区>/.lantai/attachments/\` | 附图字节（内容寻址） |
| \`<工作区>/CLAUDE.md\` | 项目规范（每会话作为「项目规范」段注入） |
| \`~/.lantai/\` | \`skills/\`（用户级技能）· \`plugins/\`（插件代码）· \`plugins-data/\`（插件数据）· \`global_memory/\`（记忆库）· \`mcp.json\` · \`providers.yml\` · \`composition/\`（组合层用户 patch 与 presets） |

## 5. 排障对照（症状 → 先看什么）

| 症状 | 先看 |
|---|---|
| 刚装的能力「没反应」 | §3 生效时机：工具类要开新会话；MCP 要重启应用 |
| 模型调不动 / 答到一半停 / 报错 | 设置→诊断 → 导出诊断包（内含 ui / bridge / boot / engine 四通道＋可信度段），让用户把文件发你 |
| 插件装载失败 | 设置→插件：\`error\` 显示原因；\`blocked\` ＝权限未授予（\`~/.lantai/plugins.json\` 的 granted 段） |
| 技能没被想起 | 技能目录每步可见——先检查该技能 description 是否说清「什么时候用」；坏档在设置→技能 有诊断 |
| 桌面端整体异常 | \`<工作区>/.lantai/logs/\` 三份日志（滚代产物为 \`.log.1\` / \`.log.2\`） |

## 6. 给用户指路时的纪律（你自己遵守）

- 报位置用真实路径（工作区绝对路径拼 \`.lantai/...\`）；界面细节别猜（用户比你熟），给「设置页哪一签 / 命令名」的最短路径。
- 改设置优先说清「点哪里」或「改哪个文件」（\`providers.yml\` 人和 Agent 都可直接改）；涉及装 / 删 / 卸（插件、技能、工作区）先与用户确认。
- 排查先拿证据（日志 / 诊断包 / 设置页状态）再下结论，不凭印象说「兰台某功能坏了」。`;
/** 出厂技能表（scanSkills 第三发现根——随 bundle 分发）。
 *  新增出厂技能：本表加行；name 必须小写 kebab-case；内容自包含
 *  （出厂技能无磁盘目录，${LANTAI_SKILL_DIR} 不适用）。 */
export const BUILTIN_SKILLS: readonly BuiltinSkillDef[] = [
  {
    name: 'lantai-plugin-dev',
    description:
      '为兰台写插件的完整操作手册——动态插件（cordis 工具）/ 静态插件（manifest+entry+宿主桥+全部贡献通道 def 形状）/ MCP server 挂接 / 装载验证 / 发布',
    whenToUse:
      '用户想给兰台写/装/改插件、加面板/命令/工具/块渲染器/MCP，或想让 Agent 当场扩展兰台能力时——动手前先读本技能',
    prompt: PLUGIN_DEV_PROMPT,
  },
  {
    name: 'officecli',
    description:
      '用内置 office 域工具读写 Word/Excel/PPT（.docx/.xlsx/.pptx）——创建、读取、结构化查询、修改、模板批量填充、渲染截图、载入逐格式构建指南。当用户要产出或修改 Office 文档、从既有文档取内容或查格式问题、把研究结果交付成 Office 文件时用。',
    prompt: OFFICECLI_PROMPT,
  },
  {
    name: 'lantai-guide',
    description:
      '兰台产品地图与操作手册——术语与界面构件、命令与快捷键、设置页八个页签、扩展三条路（技能/插件/MCP）的安装与生效时机、数据与日志位置、常见故障对照。用户问「xx 在哪 / 怎么操作 / 为什么没生效」、需要指引兰台界面、或排查兰台自身问题时用。',
    whenToUse: '用户遇到兰台软件本身的入口、用法、扩展、排障问题时——先读本技能再答',
    prompt: LANTAI_GUIDE_PROMPT,
  },
];
