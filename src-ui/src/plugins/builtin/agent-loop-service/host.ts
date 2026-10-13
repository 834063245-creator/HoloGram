// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent-loop-service 产物 · 宿主依赖面 · 开发/测试/编译域（批 9h-2，2026-09-26）。
//
// 本包 = Agent 主循环注册表（`index.ts` 的 `AgentLoopService`）+ **出厂默认实现**
// （`default-loop.ts`，批 9h-2 自 `agent/agent-loop/default-loop.ts` 整件随包）。
// 默认实现仍要用内核的循环依赖面（全是无状态函数/类，桥真实例不造副本）：
//   - `typedRpcWithTimeout` / `kernelReadFile`：每步 best-effort RPC（后台通知 drain /
//     计划文件读取）与计划文件内容读取；
//   - `EventKind`（值）+ `AgentEvent`（类型）：事件面常量与形状；
//   - `log`：内核日志统一出口；
//   - `finishReasonMessage` / `parseFilePathArg`：loop helper（理由文案 / 路径参数解析）；
//   - `StreamingToolExecutor`：工具执行器**类**（内核单例语义——同一份实现，非副本）；
//   - `resolveGuardToolName`：域折叠表（工具名归一，字节契约的一部分）；
//   - `setActiveAgentLoop`：写内核活动面（`agent-loop-active.ts` 的 `resolveAgentLoop()` 读它）。
// 形状面（`AgentLoopHost`）留内核 `agent/agent-loop/types.ts`——loop seam 契约真源。

export { setActiveAgentLoop } from '../../../agent/agent-loop/agent-loop-active';
export type { AgentLoop, AgentLoopHost } from '../../../agent/agent-loop/types';
export { type AgentEvent, EventKind } from '../../../agent/agent-types';
export { log } from '../../../agent/logger';
export { finishReasonMessage, parseFilePathArg } from '../../../agent/loop-helpers';
// 步骤钩子注入/裁决类型（agent-hooks-plan 二期）：loop 本地挂起批与裁决变量的
// 类型注解用（turn-stopping continue 的注入在下一轮注入链尾落地）。
export type {
  PreStepDecision,
  PreStepMessage,
  PreStepReminder,
  TurnStopDecision,
} from '../../../agent/steps';
export { StreamingToolExecutor } from '../../../agent/streaming-executor';
export { resolveGuardToolName } from '../../../agent/tools/domains';
export { ContributionChannel } from '../../../composition/contribution-channel';
export { Service } from '../../../cordis';
export { kernelReadFile, typedRpcWithTimeout } from '../../../rpc-contract';
