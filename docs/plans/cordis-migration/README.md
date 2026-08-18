# Cordis 内核化改造（cordis-migration）

> 立项：2026-08-18 · 完工：2026-08-18 · 状态：**Done — P0-P4 全部落地**
> 关联工程：[agent-core-convergence](../agent-core-convergence/)（HoloGram 自有运行时已收敛到四原语，本工程是它的内核归宗）

## 一句话

把 HoloGram 前端的运行时骨架从「手写四原语 + 各处自管生命周期」迁到 vendored cordis 内核
（Context / Fiber / Service / Registry），消灭双范式，直到全部子系统跑在同一棵 fiber 树上。

## 决策记录（用户已拍板，锁定）

| 决策 | 结论 | 依据 |
|---|---|---|
| Cordis 来源 | **Vendor 源码进仓库**（同 DSH 做法），不走 npm | 用户选择；内核 ~100KB 可读源码在仓，升级 = 重新拷贝，不受上游发版节奏绑架 |
| 迁移范围 | **全量迁移**，含冻结四件套（chat-session / chat-stream / part-mutator / execution-state） | 用户：做工程就做到底，彻底消灭双范式，未来维护像插件热插拔 |
| 双范式共存期 | **不存在**——一直推进到无双范式残留再做别的事 | 用户原话；阶段按依赖方向排序（P0→P4），每阶段全绿才进下一阶段 |
| EventsService | **不采用**。zustand 仍是状态层；`ui/events.ts` 冻结旧总线的既有决策延续 | HoloGram 的状态纪律（createScopedStore / shell-store）与 cordis 事件总线各管各的，不重复造层 |
| blueprint 字节契约 | **不变**——capability 表序 = 工具面字节契约（前缀缓存依赖），迁移不得重排 | agent-core-convergence Phase 6 立规，P2 迁移时以 baseline 快照守护 |
| Rust 侧 | 不在范围——engine/ 与 src-tauri/ 不动 | Cordis 是 JS 内核，IPC 契约（typedRpc）不受影响 |

## 阶段划分

每阶段契约：**commit 前全绿**（`npm run build` + `npx vitest run` + biome 改动文件零新增 +
涉及 agent 时 `npm run verify:convergence`）。convergence baseline（8 快照）不动；
确需变更走 `docs/plans/agent-core-convergence/baseline-change-request.md` 流程。

### P0 — 内核落地（本提交，已完成）

内核源码进仓库 + 根 Context 引导 + 冒烟测试。**不接任何业务**——只证明内核在本项目工具链
（tsc strict / vitest jsdom / biome / vite）下可编译可运行。

验收（2026-08-18 实测，数字会漂移以复测为准）：

- `npx tsc --noEmit` 全绿；`npx vitest run` 全量 exit 0（含新增
  `tests/cordis-kernel.test.ts` 5 用例：Context 品牌 / boot 单例语义 / fiber+effect LIFO /
  Service 提供与解除 / fiber 内 global 事件监听随 dispose 移除）；
- `npm run build` 全绿；`npm run verify:convergence` exit 0；
- biome：改动文件零新增（vendor 文件整体豁免，见下）。

落地物：

- `src-ui/src/cordis/`：内核 9 文件（context/events/fiber/index/logger/reflect/registry/
  service/utils）+ `cosmokit.ts`（子集）+ `standard-schema.ts`（类型拷贝）+ `boot.ts`
  （自有代码：initCordisKernel / getCordisRoot，幂等 + 未初始化显式抛错）+ `README.md`
  （溯源与升级纪律）+ `LICENSE`（上游 MIT）。
- `src-ui/src/main.ts`：React 壳引导前 `initCordisKernel()`。
- `src-ui/tsconfig.json`：`lib: ES2022`（内核真实使用 `Object.hasOwn` ×4，声明 API 地板）。
- `src-ui/biome.json`：vendor 文件显式清单豁免（formatter/linter/assist 全关，frozen 拷贝保持上游原样）。

### P1 — Workspace 根容器 fiber 化（已落地）

**设计要点（落地时发现并修正的两点）**：

1. **fiber unload 是并发的**（`_unload` 用 `Promise.all` 跑清理器，上游 cordis 4.x 改过
   这个语义），而 HoloGram 的拆除链有文档化的顺序依赖（先拆 runtime 再清缓存、aura 晚于
   runtime、timers 最后清）。因此不能把 17 个 bag 条目平铺成 17 个平级 effect：
   - constructor/open 的**独立**清理器（checkTimer / 快照刷新 / 两个监听器）→ 直接 effect；
   - setupAgent 的**有序**拆除组（9 条）→ 每次调用打包一个 DisposerBag、作为**单个**
     effect 登记（组内串行逆序契约原样保留）。
2. **epoch 保留**（原设想「epoch → fiber dispose-to-quiescence」修正）：epoch 管的是
   逃逸所有权的在途回调，消费方含冻结文件 chat-session.ts（P4 才解冻）——fiber 管所有权、
   epoch 管代际，两者不重叠。deactivate/forceClearState 仍 bumpWorkspaceEpoch()。

落地物：Workspace._fiber（constructor 经 `initCordisKernel().plugin(workspaceScopePlugin)`
创建，placeholder 也持有）+ `cordisCtx` getter（P2/P3 挂子 fiber 的入口）；
deactivate → `await fiber.dispose()`（dispose-to-quiescence）；forceClearState →
`void fiber.dispose()`（快通道，sync 清理器首个微任务内执行完）。

验收（2026-08-18 实测）：tsc 全绿；workspace 三件套 17/17（新增
`tests/workspace-fiber.test.ts` 4 运行时用例：Context 品牌 / 快通道释放+epoch 推进 /
deactivate quiescence / dispose 后拒绝新增 effect）；T0 静态断言（workspace-lifecycle /
workspace-scope）同步换钉 fiber 机制；INVARIANTS #12、CONVENTIONS §1.10、AGENTS.md §6
同步改写。

### P2 — agent 装配迁移

**关系定案：保留 AgentContext 外壳，挂 cordis fiber 身份。** 摸底后修正原方案的三点：

1. **AgentContext._bag 保留 DisposerBag，不换 fiber**。phase-4 T1 spec 钉死同步快通道
   （`_disposeAgent` 注释原文：「effects 全 sync 链经 DisposerBag 同步快通道在返回前完成，
   listAgents / bus 注册状态调用后立即可观测」）；cordis fiber unload 是异步跨微任务 + 并发，
   直接替换会炸 spec 且语义降级。fiber 做**身份与挂树**，bag 继续做**有序清理**。
2. **child() 平级挂载**。agent-context 规约钉死「effect 所有权独立——父 dispose 不动子」；
   cordis fiber 树的父 dispose 连带子销毁。因此子 AgentContext 的 fiber 挂同一 cordisParent
   （兄弟关系），不嵌套在父 fiber 下。
3. **blueprint.ts 零改动**。capability 表序 = 工具面字节契约（Phase 6 立规），装配循环保持
   同步顺序执行；capability 本就不是生命周期单元（Phase 6 铁律 3：teardown 留 ctx.effect）。
   P2 的产出是：每个 Agent 的生命周期在 cordis 树上可见（fiber state LOADING→ACTIVE→DISPOSED），
   为 P3 服务化提供挂载点。

**MCP client 插件化：顺延**。摸底发现 `mcpClients` 是 agent-builder 的预留插口（生产路径
不传、`new McpClient` 全仓零调用）——fiber 化一个未启用的死插口是投机设计，待真实启用时按
DSH `inject: ['tools']` 模式与真实需求一起定。

落地物（已实施）：AgentContext 增 `cordisParent?` 构造参 + `_fiber` 身份（plugin 名
`hologram/agent`，共享插件对象）+ `cordisCtx` getter + dispose 桥接（bag 先行、fiber 收尾）；
AgentRuntime 构造器增 `cordisParent?` 透传（`_contextFromConfig` 注入）；workspace 传
`this._fiber.ctx`（Agent fiber 挂在工作区 fiber 下）。子 Agent 经 `child()` 继承 cordisParent
→ 与父平级（兄弟 fiber），「父 dispose 不动子」契约保持。

钉面调研（subagent 报告）确认的护城河，全部落实：
- phase-4 T1 同步快通道 / dispose 聚合抛错 / 中文文案断言 → bag 保留，全部存活（**零测试修改**）；
- phase-3 T0「AgentContext 公共成员必须有 JSDoc」→ `cordisCtx` getter 带 JSDoc；
- 8 个 baseline 快照零漂移（specs 全绿实测）；wiring 提取器只看 `createAgent`/`_disposeAgent`
  方法体——P2 不动这两处。

**红线**：capability 表序字节不变（baseline 快照对拍守护）；`verify:convergence` 全绿。

### P3 — 面板/子系统 Service 化

**代表性落地：`ui/lsp-client.ts` → `LspService`（服务名 `'lsp'`）。** 摸底修正了原设想：
dock/settings/graph 的状态本就在 zustand（唯一状态层的架构决策不动），真正的双范式
残留是 lsp-client 的**模块级可变单例**（会话表/4 组 provider 数组/诊断缓存/监听器全是
模块全局，生命周期靠 file-viewer 人肉 stopAllLsp）。

设计（状态进服务、函数面薄转发）：

1. 全部可变状态收进 `LspService extends Service` 私有字段；13 个模块级导出函数保留为
   薄转发（file-viewer 10 处调用 / workspace / agent-builder 消费面**零改动**，两个既有
   LSP 测试**零改动**全绿 = 转发等价性实证）。
2. Workspace 构造时 `new LspService(this._fiber.ctx)` 挂工作区 fiber — 生命周期随
   fiber（deactivate/forceClear → provider/监听器释放、缓存清空、lsp_stop 发后即忘），
   `Workspace.lsp` 便捷入口。未挂载时（单测）惰性建游离兜底实例，行为与旧模块态等价。
3. epoch 代际防护（H2）不动 — fiber 管所有权、epoch 管在途回调（INVARIANTS #12，P4 前不动）。

踩坑记录（cordis 内核语义，对后续 P3+ 消费方都是必修知识）：

- **fiber ctx 访问服务名必须声明 `inject`**（reflect.ts：防隐式依赖，否则抛
  "cannot get property without inject"）；**根 ctx 宽松**（无 runtime 走 optional 查找）。
- **服务可见性 = 挂载 fiber 的子树**（兄弟 fiber 互相不可见）。P2 的 agent fiber 挂在
  workspace fiber 下 → 未来 agent 侧声明 `inject: ['lsp']` 即可消费。
- **fiber 加载是异步的**：`ctx.plugin()` 返回后需 `await fiber` 才完成依赖解析
  （对齐 P0 冒烟姿势）。
- **`ctx.lsp` 出口是 traceable 包装**（方法调用看到 caller ctx 的设计）：原生
  `instanceof` 通过、身份 `!==` 原实例；vitest 匹配器（toBe/toBeInstanceOf）探测
  `asymmetricMatch` 会触发 shadow 路由误炸 — 测试用间接断言（`x instanceof Y` 先求值
  再 toBe(true)）。

验收：tsc 全绿；lsp 全家 16/16（新增 `tests/lsp-service.test.ts` 4 用例 + workspace-fiber
挂载断言）；biome 零新增。后续同模式候选（goal-manager / memory-bundle-client 等）按需
逐个迁，不追求一次性全量。

### P4 — 冻结四件套迁移 + 文档收口

**评估结论（2026-08-18 实测）：四件套零改动；双范式真实残留已在 P1-P3 清零。**

- **part-mutator（140 行）/ execution-state（187 行）**：零模块级可变态；后者已是
  zustand 工厂模式（createExecState）——即目标形态，无迁移需求。
- **chat-session（1216 行）**：唯一模块态 `_autoSaveTimers`（storeId 键控防抖表）+
  epoch ×2 守卫在途 autoSave。epoch 防护完整，冻结解除无必要——它是历史炸点集中地
  （INVARIANTS #1/#2/#3），动它的收益（挪一张防抖表）远小于风险。
- **chat-stream（460 行）**：唯一模块态 `_recentNotices`（storeId:text → 时间戳，纯
  去抖缓存，无回调无泄漏路径）。

**全仓残留扫描（44 处模块级可变态，全部有据保留）**：常量表 5（STOPWORDS/DOMAIN_NAMES
等同族）· 进程级基础设施 25（bridge/catalog/i18n/logger/main 等，生命周期=进程）·
键控自清理 6（streamId/agentId/storeId 键控对称清理）· 已收编 3（agent-builder 快照
timer 由 P1 fiber effect 持有；lsp-client 状态 P3 已进 Service）· 内核自有 2。
分级条款固化进 CONVENTIONS §1.10（模块态四级归属）。

**epoch 定案：永久保留**。3 个消费方（lsp-client startLsp / agent memory / chat-session
autoSave）全部是已出发的在途 promise 链，fiber dispose 无法撤销——代际校验是唯一正确
防护，与 fiber 所有权不重叠（P1 论证经 P4 复核成立）。

**baseline**：全程零漂移（8 快照未动），无需 change request。

文档收口：CONVENTIONS §1.10（epoch 定案 + 模块态四级归属）、AGENTS.md（目录树加
src/cordis、§6 补 Service 样板）、本 README、docs/plans/README.md 状态表。

## Vendor 纪律（`src-ui/src/cordis/README.md` 是权威细节）

- **禁止就地改内核逻辑**。升级 = 从上游（DSH vendor 或 cordis 上游）重新拷贝 + 同样的
  机械重写 + 全量门禁。
- 机械重写仅三项：相对 import 剥 `.ts`；`@deepseek-ai/cosmokit` → `./cosmokit`；
  `@standard-schema/spec` → `./standard-schema`。
- 每个内核文件头部带 `@ts-nocheck`：类型由上游自己的构建校验（DSH vendor/cordis 的
  tsconfig 恰好关闭 noImplicitAny/noImplicitThis/strictFunctionTypes——与本仓 strict 全开
  不兼容），本项目按 skipLibCheck 同款信任模型处理。**声明仍然生效**：模块增强
  （`declare module './context'`）照常合并进程序——冒烟测试里 `ctx.plugin/on` 的类型化
  调用即为其证明。
- biome 豁免用显式文件清单而非 glob：新增 vendor 文件必须显式登记（有意识的决策，防误伤
  自有代码）。

## 验证命令（本工程门禁）

```bash
cd src-ui
npx tsc --noEmit            # 类型
npx vitest run              # 全量测试
npm run build               # tsc + vite build
npm run verify:convergence  # agent 收敛（P2 起强制；P0/P1 因不触 agent 仍跑作保险）
npx biome check <改动文件>  # 零新增
```
