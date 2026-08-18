# Cordis 内核化改造（cordis-migration）

> 立项：2026-08-18 · 状态：**In progress — P0 已落地**
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

blueprint capability 表迁移为 fiber 装配；MCP client 插件化（对齐 DSH `inject: ['tools']` 模式）；
AgentContext 与 cordis Context 的关系定案（保留外壳 or 直接替换）。
**红线**：capability 表序字节不变（baseline 快照对拍守护）；`verify:convergence` 全绿。

### P3 — 面板/子系统 Service 化

dock 面板、settings、graph 服务按 `Service extends` 模式挂到根 Context。zustand 仍是
唯一状态层（Service 不持 UI 状态）。验收：各面板既有测试全绿。

### P4 — 冻结四件套迁移 + 文档收口

冻结四件套（chat-session / chat-stream / part-mutator / execution-state）的迁移评估与
执行；CONVENTIONS / INVARIANTS / AGENTS.md 更新（新增 src/cordis 目录说明、双范式条款清除）；
全仓 grep 双范式残留清零。baseline 变更此时按 change request 流程申请重录。

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
