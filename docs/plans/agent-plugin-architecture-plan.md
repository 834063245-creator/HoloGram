# Agent 插件化：执行原语 + 工具面单一真源（DSH 对标）计划

> 立项：2026-08-19（岛层退休 + 总线归零立项当日）
> 状态：**Proposed（方向性立项，执行窗口未定——建议在 eventbus-zero-and-ui-split 完成后开）**
> 性质：本计划是能力建设（capability plan），不是还债（debt plan）——每阶段独立可停，
> P1 半天即可单独兑现收益。
> 参照系：DeepSeek Harness 源码（D:\useful\deepseek-harness，下称 DSH）；所有「DSH 实证」
> 均给出文件路径供执行者直接查阅。

## 1. 背景与问题

HoloGram 的 Agent 工具面（ToolRegistry + defineTool/zod + blueprint capability 表 +
domains 折叠）在**声明层**已是 DSH 同级。差距集中在两处半：

1. **缺执行原语**（结构性）：模型一次只能发一个 JSON 工具调用，组合逻辑活在下一 token
   预测里——烧上下文、无循环、无 try/catch、无并发。agent 今天绕路的「写脚本→shell 跑
   node→读输出」三步，本质是一个未坍缩的原语。
2. **缺声明即文档**（半个）：工具 schema 与面向模型的说明分离，「加工具」要三处同步。
   项目里已有同纪律先例：`gen-rpc-contract-md.cjs` 从 RpcContract 生成文档。
3. **缺第三方插件边界**：一切能力都是编译期 import，外部无法挂载。

### cordis 与本计划的关系（重要澄清）

cordis 解决的是**开发者侧组装**（Service 注册/依赖注入/生命周期）；DSH 级插件性要的是
**模型侧运行时能力边界**。两者正交——但 DSH 源码给出了关键的正面证据：

> **DSH 的 CodeRuntime 本身就是 cordis Service**
> （`packages/code-runtime/code-runtime/src/index.ts`：`export abstract class CodeRuntime
> extends Service` + `declare module '@deepseek-ai/cordis' { interface Context { codeRuntime } }`）。
> workflow 工具同样是标准 cordis 插件（`packages/workflow/tool-workflow/src/index.ts`：
> `export const name/inject/Config`）。

即：cordis 化不是白做，它是插件化的**装配层**；本计划补的是它上面缺的两块——执行腰和
文档发电机。HoloGram vendored 的 cordis 与 DSH 同宗，模式可以直接平移。

## 2. DSH 实证速查（执行者先读这五个文件）

| # | DSH 文件 | 教的东西 | HoloGram 对应物 |
|---|---|---|---|
| 1 | `packages/code-runtime/code-runtime/src/index.ts` | CodeRuntime = cordis Service；「runtime 不知道工具/会话，消费者自己管」的接缝纪律；跨语言保留字/保留全局的**可移植契约** | 未来 `ctx.codeRuntime` 的接口形状 |
| 2 | `packages/code-runtime/code-runtime-worker-thread/src/protocol.ts` | 窄腰线协议：worker 只拿**函数名清单**（namespaces），函数本体留宿主；correlation-id 应答；**宿主视入站流量为敌意**（模型代码可伪造 parentPort 消息） | 沙箱协议规范（无论后端选哪个都适用） |
| 3 | 同包 `bootstrap.ts` | 输出预算（logs+完成值合并上限）、无损 JSON 才能过线、日志先行流式（中途被杀也不丢）、完成值 snapshot+detach 双份（调度与日志互不干扰） | 预算与日志纪律 |
| 4 | `packages/core/tools/src/code-mode.ts` | run_code 工具本体：程序经 `await tools.name(args)` 调注册表工具=**原生并发契约下的嵌套执行**；子分发全部落日志可重建，只有外层策展结果进模型历史；`CodeRunFailedError`→结构化 isError 结果（模型可自我修正） | 与 ToolRegistry/executor 的桥接设计 |
| 5 | `packages/workflow/tool-workflow/src/index.ts` | 编排=薄 cordis 插件：模型面 schema 与执行引擎分离（`ctx.workflowEngine` 可整体换硬），提示词指导注册为工具自己的 prompt section | 未来 workflow 工具的形态模板 |

另：`packages/typert` 是工具面跨进程类型协议（merge-extensible declaration maps）——
HoloGram 单进程内暂不需要，P4 插件边界时再评估。

## 3. 完成判据（按阶段分组，均可测）

### P1 工具面文档生成
| # | 判据 |
|---|---|
| C1 | `scripts/gen-tool-contract-md.cjs` 存在，从 `ToolRegistry` 装配产物生成模型可见工具面文档（含领域 action 枚举与参数说明） |
| C2 | 生成物纳入构建检查：catalog 变更而文档未再生成时 CI 红（对齐 gen-rpc-contract-md 纪律） |
| C3 | AGENTS/CLAUDE 中 agent 工具清单段改为指向生成物，消灭手写双源 |

### P2 执行原语（code_execution 工具）
| # | 判据 |
|---|---|
| C4 | 新模型工具 `code_execution`（或并入既有 `shell` 域作 action）：入参=程序体+description，出参=logs+完成值，走 defineTool+zod |
| C5 | 程序内以 `await tools.<name>(args)` 调用**当前 registry 全部可见工具**（含领域工具）；子分发逐条落 session-log 可重建（`derivePayload` 同步——见风险 R2） |
| C6 | 协议纪律：宿主侧敌意校验（correlation-id 一次性、参数无损 JSON 校验）、输出预算可配、超限/中止/崩溃分类报错 |
| C7 | 并发语义显式：文档写明程序内调用的并发契约（对齐 registry 现行 readOnly 并行规则） |
| C8 | 回归测试：嵌套调用的会话日志重建、预算超限、程序异常三条路径各一条 |

### P3 cordis 收口
| # | 判据 |
|---|---|
| C9 | `codeRuntime` 成为 vendored cordis 的 Service（`ctx.codeRuntime`），P2 的执行后端退为它的一个实现；领域工具（fs/shell/graph/...）装配改经 ctx 查询 |
| C10 | blueprint capability 表增加一个 `code-execution` 项即完成装配，AgentConfig 字段面不变（Phase 6 冻结不破） |

### P4 插件边界（远期，判据到时再细化）
| # | 判据 |
|---|---|
| C11 | 第三方插件 = manifest + 工具声明（zod schema 可序列化形态）+ capability 表项，运行时挂载无需重编译；权限声明接入 permissions.json 体系 |

## 4. 设计决策

- **D1 沙箱后端选 Web Worker 优先，不是 Node sidecar**。DSH 实证的关键洞察：worker 里
  **根本没有工具**——工具全是宿主侧的 proxy binding，程序只能经协议腰调用。HoloGram 的
  webview 里开 Web Worker，同样只暴露 `tools.*` 代理，能力面天然收窄到桥协议；攻击面
  是桥的实现质量，不是 worker 逃逸。诚实标注：这是**协议纪律沙箱**而非**基底沙箱**
  （同源 Web Worker 不是硬边界），与 DSH worker-thread 的安全定位实际等价（DSH 的
  worker 同样不是进程级隔离，靠的就是敌意校验+无损 JSON+预算）。
  sidecar Node / engine 嵌 deno_core 是后续硬化选项，接口不破即可换（C9 的意义）。
- **D2 单腰不加宽**。只加一个 `code_execution` 工具，schema 面增量=1（DeepSeek 前缀缓存
  友好）；不把几十个工具接口塞 system prompt（DSH 那样做是因为「代理即产品」；HoloGram
  是带代理的桌面应用，domains 折叠形态更适合——**别抄工具面预算**）。
- **D3 组合不进平台**。不造工作流引擎。若未来要 workflow，抄 DSH 形态：一个薄插件工具
  给 `agent()/parallel()/pipeline()` 几个钩子，编排语义由模型写的程序承担
  （`tool-workflow/src/index.ts` 即模板）。**平台笨、代理聪明**。
- **D4 声明即文档**：P1 复制 gen-rpc-contract-md 纪律到 ToolRegistry catalog；单一真源
  生成模型文档，杜绝 schema/提示词/文档三处漂移。
- **D5 子分发可重建**：P2 的嵌套工具调用必须落 session-log（对照 DSH 的 CodeDispatchLog
  「子分发全记录、外层结果才进历史」）。这直接触及 session 变异三入口纪律与
  `session-log.ts derivePayload`——执行时按 Phase 5 立规同步，不可绕。
- **D6 与总线归零的关系**：本计划不依赖 eventbus-zero 完成，但**P3 的 ctx 查询装配**
  最好在 ui/ 拆分尘埃落定后做（避免两场大迁移叠 diff）。P1/P2 无此约束，随时可做。
- **D7 蓝图序即字节契约**：code_execution capability 插入位置显式选定（Phase 6 铁律），
  生效快照与缓存依赖表序，不追加到表尾了事。

## 5. 阶段

### P1 工具面文档生成（半天，独立收益，随时可做）
1. `ToolRegistry` 增加 catalog 导出（或复用 domains 装配现场）
2. `scripts/gen-tool-contract-md.cjs`：zod→JSON Schema→markdown 表（参照 rpc 版脚本）
3. CI 漂移检查 + AGENTS/CLAUDE 文档段替换
4. 门禁：build + vitest + 生成物 diff 检查

### P2 执行原语（2-4 天，产品决策级）
1. 协议层：correlation-id 腰线（照抄 protocol.ts 语义：一次性应答、敌意校验、无损 JSON、
   输出预算、日志先行）
2. Worker 侧：Web Worker bootstrap——类型剥离（HoloGram 无 ts 转译链，直接收 JS 程序体，
   限定 erasable 子集可后置）、`tools.*` proxy materialize、console 捕获
3. 宿主侧：桥接 registry（嵌套执行走现行 executor 并发契约 + dispatch log）
4. `code_execution` defineTool + blueprint capability + domains 归属（建议 shell 域新
   action 或独立 code 域，执行时定）
5. session-log `derivePayload` 同步 + 三条回归测试（C8）
6. 权限：程序内工具调用过现行 gate（plan 模式白名单同样生效于嵌套调用）
7. 门禁：全量 + verify:convergence（动了 agent/** 必过）

### P3 cordis 收口（1-2 天，建议在总线归零+ui拆分后）
1. `CodeRuntimeService extends Service`（vendored cordis），P2 实现挂到 `ctx.codeRuntime`
2. 领域工具装配改 ctx 查询；blueprint 加 capability 项
3. 文档回写：CONVENTIONS/AGENTS/ARCHITECTURE 插件化叙事

### P4 插件边界（远期方向，不排期）
- manifest 形态、zod schema 序列化、第三方加载沙箱（届时评估 sidecar/engine 嵌入）
- MCP 客户端方向：HoloGram 引擎已是 MCP server；反向消费外部 MCP 工具并入 registry，
  是比自造插件格式更标准的开放路径——两者可并存

## 6. 风险表

| # | 风险 | 缓解 |
|---|---|---|
| R1 | Web Worker 非硬隔离，桥协议漏洞=越权 | D1 的敌意校验纪律（correlation-id 一次性+参数白名单化）；敏感工具（fs write/shell）本就过 permissions gate，嵌套调用不豁免 |
| R2 | 嵌套执行的 session-log 语义（derivePayload 冻结面） | P2 第 5 步强制；先读 agent-core-convergence Phase 5 立规，变更走 baseline change request |
| R3 | schema 面变动破前缀缓存 | D2/D7：增量=1 工具；capability 表序显式插入；上线前后对拍 effective 快照 |
| R4 | 模型滥用 code_execution 绕过工具粒度审计 | 子分发全记录（D5）——审计粒度不变，只是换了调用者 |
| R5 | webview Worker 的 CSP/eval 限制（Tauri 配置） | P2 开工首日做 spike 验证（blob import vs Function 构造），失败即转 sidecar 方案，协议层不白做 |
| R6 | 并发契约不清晰（程序内 Promise.all 撞写工具） | C7：文档显式声明；readOnly 并行规则沿用，写工具串行 |

## 7. 明确不做（Non-goals）

- 不摊平工具面到 DSH 规模（前缀缓存 + 桌面应用定位，domains 折叠是更优形态）
- 不造工作流引擎/DSL（D3）
- 不在本计划内动 cordis 内核本体
- 不做 Python 后端（DSH 的可移植契约值得学，但 HoloGram 单语言足够）
- typert 式跨进程类型协议（P4 前无需求）

## 8. 与既有计划的关系

- 前置完成：ui-react-island-retirement（Done）；**建议先做**：eventbus-zero-and-ui-split
  （P0 已立项）——P3 之前完成即可，P1/P2 无依赖
- 本计划不动 ui/events.ts、不迁文件、不碰冻结四文件——与总线归零计划零冲突
