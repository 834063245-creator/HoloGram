// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent 循环 — Run() → stream() → StreamingToolExecutor → 循环直到模型给出最终答案

import { currentPresetId } from '../composition/preset-assembly';
import { registerSeamScope } from '../composition/seam-scope';
import { activeSubagentProviders } from '../composition/subagent-service';
import { isImageUnsupportedError } from '../provider/error-catalog';
import { STREAM_IDLE_TIMEOUT_MS, streamWithIdleTimeout } from '../provider/idle-stream';
import type { StoredThinking } from '../provider/thinking';
import type {
  Chunk,
  Message,
  Provider,
  Request,
  ResponsesOutputItem,
  ToolCall,
  ToolSchema,
  Usage,
} from '../provider/types';
import { ApiError, apiErrorSummary, ChunkType } from '../provider/types';
import { resolveAgentLoop } from './agent-loop/agent-loop-active';
import { attachFirstPartyLoopObservability } from './agent-loop/observability';
import type { AgentLoop, AgentLoopHost } from './agent-loop/types';
import type { AgentRecord, AgentStore } from './agent-store';
// 共享类型 — 本文件内部也使用
import { type AgentEvent, type AgentUINotifier, EventKind, type EventSink, type ToolEvent } from './agent-types';
import { generateAssetId } from './asset-kinds';
import { rebuildAssetsFromSession } from './asset-store';
import {
  type CompactionConfig,
  type CompactionHost,
  DEFAULT_COMPACT_RATIO,
  DEFAULT_RETAIN_RATIO,
  SUMMARY_OUTPUT_BUDGET,
  type SummaryCall,
  type SummaryRun,
} from './compaction-contract';
import { requireCompactionImplementation } from './compaction-impl';
import { type CompactionSessionStats, CompactionTracker } from './compaction-tracker';
import type { AgentContext } from './context';
import {
  AgentEventBus,
  attachHookRegistry,
  attachPlanGate,
  attachPreflightRegistry,
  type ListenerOptions,
  type LoopEventName,
  type LoopEventPayload,
} from './events';
import { createExecState, type ExecStateInstance, type RunHandle, type RunKind } from './execution-state';
import type { GoalLoopHost, GoalRunResult } from './goal-contract';
import { activeGoalImplementation } from './goal-impl';
import type { GoalManager } from './goal-manager';
import type { HookRegistry, PreflightHookRegistry } from './hooks';
import type { Disposer } from './lifecycle';
import { log } from './logger';
import { batchStormSignature, type ToolOutcome } from './loop-helpers';
import { type PlanGate, planGateCheck } from './plan/plan-registry';
import type { PreStepRegistry } from './pre-step';
import {
  applyImageBudget,
  collectImageRefs,
  dropImagesOverBudget,
  overWireBudgetIds,
  projectImagesForTextModel,
  projectImagesUnsent,
  type RequestImagePayload,
  type RequestImageReader,
  resolveRequestImageData,
  wireImageChars,
} from './request-images';
import {
  backoffDelay,
  formatElapsed,
  INTERRUPTED_MARKER,
  isAbortFlavoured,
  isRetryable,
  isStallError,
  MAX_RETRIES,
  STALL_NOTICE_MARK,
  STALL_RETRY_BUDGET_MS,
  SUSPECT_PAYLOAD_MAX_ATTEMPTS,
  SUSPECT_PAYLOAD_MIN_WIRE_CHARS,
  sleepWithAbort,
  withinRetryBudget,
} from './retry';
import {
  beatPulse,
  isAbandoned,
  logWatchdogAbandon,
  logWatchdogWarn,
  pulseOf,
  RunDeadlineExceededError,
  RunPulse,
  watchdogAbandonText,
  watchdogWarnText,
} from './run-watchdog';
import { registerOwnerContext } from './session-context';
import { SessionLog, type SessionResetReason } from './session-log';
import type { StreamingToolExecutor } from './streaming-executor';
import { parseAssetEventOutput } from './streaming-executor';
import type { SubAgentSpawnHost } from './subagent-runtime-contract';
import { countMessages, countTexts, countToolSchemas } from './token-counter';
import { countImageTokens, type EnvelopeMeasure, measureEnvelope } from './token-meter';
import type { TokenLedger, TokenLedgerSnapshot, TokenMeasurement, TokenRequestRecord } from './token-meter/contract';
import { requireTokenMeter } from './token-meter/service';
import type { ToolRegistry } from './tool';
import { createStableSchemaSelector, type StableSchemaSelector, userContext } from './tool-select';
import { resolveGuardToolName } from './tools/domains';
import { truncateToolOutput } from './truncate';

// 批 7c-2：`wrapTool` / `buildSubAgentTools` 的值 re-export 退役（4c 裁定① 同款——
// 内核不聚合产物；实测零消费方）。

import type { DiscoveryBoard } from './discovery-board';
import type { FileOwnership } from './file-ownership';
import type { MessageBus } from './message-contract';
import type { TaskBoardFace } from './task-contract';

export { type AgentEvent, EventKind, type EventSink, type ToolEvent };

// ---- Agent 选项 ----

export interface AgentOptions {
  temperature?: number;
  /** 上下文窗口大小（token 数）。0 = 不压缩。 */
  contextWindow?: number;
  /** 触发自动压缩的 contextWindow 比例（默认 0.8 — 对齐 DSH thresholdRatio；
   *  2026-09 迭代：0.55 在前缀缓存计价下压的是仍会被反复读取的活跃中段，
   *  净亏）。 */
  compactRatio?: number;
  /** 手动压缩尾部保留的完整消息数下限（默认 4）。自动压缩改用
   *  retainRatio token 预算（见下），此值作为消息数兜底。 */
  recentKeep?: number;
  /** 自动压缩尾部保留的 token 预算，占 contextWindow 比例（默认 0.16 —
   *  对齐 DSH retainRatio）。computeCompactRegionImpl 从尾部往回累计 token
   *  到 ≥ 此预算并保留完整 user 回合。 */
  retainRatio?: number;
  /** 用于持久化的会话 ID。未提供则自动生成。 */
  sessionId?: string;
  /** 每次会话保存后调用（fire-and-forget，不阻塞循环）。 */
  onSessionPersisted?: (sessionId: string, messages: Message[]) => void;
  /** 子 Agent 嵌套深度（0 = 根，1 = 第一次 fork）。自动递增。 */
  subagentDepth?: number;
  /** 唯一 Agent 标识符。未提供则自动生成。 */
  agentId?: string;
  /** 派生此 Agent 的父 Agent ID。主 Agent 为 null。 */
  parentId?: string | null;
  /** 自定义事件 sink。设置后，Agent 事件发送到此处而非默认空操作。
   *  子 Agent 用它将输出捕获到 SubAgentPart。 */
  eventSink?: (ev: AgentEvent) => void;
  /** 执行状态实例（运行账）。会话装配面/子 Agent 派生面显式供账；两者都缺席时
   *  自铸一本私有账（见构造期注——不再回退全局单例）。 */
  execState?: ExecStateInstance;
  /** 每轮发给模型的工具 schema 上限（0 = 全量，默认 14）。 */
  visibleToolsLimit?: number;
  /** 工具结果批量折叠大小（默认 0 = 禁用）。tool 消息总数每超过
   *  折叠边界 + 2×batch 时，把最早一批（batch 条）折叠为占位符。
   *  默认禁用：在 DeepSeek 前缀缓存计价下，折叠省的（hit 1/50 价）与
   *  断的（边界后全价 miss）大致相抵甚至亏本；需要时再开启。 */
  toolResultWindow?: number;
  /** UI 通知端口 — 进度 / 工具完成 / 子 Agent 生命周期。
   *  由 workspace 注入；headless Agent 无。 */
  ui?: AgentUINotifier;
  /** 通信总线（可选 — 无则为 headless 无通信能力） */
  messageBus?: MessageBus;
  /** TaskBoardFace — 共享状态区，追踪异步子 Agent 的工作状态 */
  taskBoard?: TaskBoardFace;
  /** DiscoveryBoard — 共享发现区，Agent 间交换探索结果 */
  discoveryBoard?: DiscoveryBoard;
  /** agent loop 实现（平台化 Phase 5 · D13）——缺省 = builtin/default
   *  （逐字节一致）；runtime 装配经 ctx.agentLoop 注册表解析传入。 */
  agentLoop?: AgentLoop;
  /** 附图字节读取器（multimodal-image-plan B3 · D-5）——请求期把 ChatImageRef
   *  解析成**发放载荷**（规整后字节 + 实际编码媒型，2026-09-22 起）。
   *  注入层：app（工作区根拼 attachments 路径 → fs_cap read_base64 → wire 规整）；
   *  agent 层零 app 依赖。缺省 = 无读取器（附图请求期降级为 wire 缺图，不炸）。
   *  子 Agent 经 spawn 继承。 */
  imageReader?: import('./request-images').RequestImageReader;
  // gate 已移除 — 权限由 Rust 后端 has_permission_to_use_tool() 处理
}

const STORM_BREAK_THRESHOLD = 3;

/** 把「消费一个 chunk 流」与 signal 竞速（landmine L3：停止/作废必须真解旋）。
 *
 *  为什么需要它：`run()` 的硬截止竞速只让**调用方**收场，挂住的 `for await` 本身
 *  不会因此返回——那条 loop 就永留栈上（`_loopDepth > 0`）＝幽灵轮。这里把 signal
 *  的 abort 变成一次真实的**拒绝**，让 `for await` 走 catch/finally 正常退出。
 *
 *  语义细节：
 *  - 拒绝值是 `AbortError`（`DOMException`）——与「fetch 真被 abort」同形，
 *    上层 `streamOnce` 的 catch 会据 `signal.aborted` 事实分流（不读错误文本）；
 *  - `signal` 未中止时行为逐字节不变（每轮 `next()` 直接透传，无额外定时器）；
 *  - **不取消**底层迭代：记下来的 `next()` 若日后落定，其值被丢弃
 *    （`void p.catch()` 标记为已处理，不产生 unhandled rejection）；
 *  - 结束时摘监听，防泄漏。 */
async function* streamWithAbort(chunks: AsyncGenerator<Chunk>, signal: AbortSignal): AsyncGenerator<Chunk> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {}); // 正常路径下这条腿不会有人 await
  try {
    for (;;) {
      const p = chunks.next();
      p.catch(() => {}); // 竞速败者：底层 await 若日后落定，值丢弃且不留 rejection
      const r = await Promise.race([p, aborted]);
      if (r.done) return;
      yield r.value;
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
// 默认发全量可见工具 schema（0 = 全量）。DeepSeek 前缀缓存对 tools 段敏感：
// 按用户消息重打分选子集会让 tools 段漂移，整段历史缓存失效按全价计费
// （实测单次 ~10 万 tokens）。全量目录 ~46 工具 ≈ 10k tokens，逐字节稳定后
// 常驻缓存按 1/14 命中价计费，远低于一次全量 miss。设 >0 回退打分子集模式。
const DEFAULT_VISIBLE_TOOLS_LIMIT = 0;

// ---- Agent ----

export class Agent {
  private prov: Provider;
  private tools: ToolRegistry;
  private session: Message[];
  /** Phase 5：会话事件溯源日志 — 模型可见事实先入日志，this.session 为投影。 */
  private _sessionLog: SessionLog;
  /** token 计量器（2026-09-13）：每卷一本账 — 分桶用量 / 压力 / 投影占用 /
   *  构成 / 逐轮。录入点 = streamOnce（请求信封 + 用量），读数面 = UI。
   *  §4-6 A（2026-09-26）：账本由内核 service `ctx.tokenMeter` 制造（缺服务 =
   *  具名 fail-loud；不在此自建实例——那正是「计量面无 owner」的旧账）。 */
  private _tokenMeter: TokenLedger = requireTokenMeter().createLedger();
  /** 轮次序号（run() 入口递增）——逐轮用量的分组键。 */
  private _turnSeq = 0;
  /** 最近一次请求的信封测量（构成细分的单一 tokenization 通道：计量与
   *  诊断日志共用，不重复分词一遍载荷）。 */
  private _envelope: EnvelopeMeasure | undefined;
  private temperature: number;
  private _visibleToolsLimit: number;
  _toolResultWindow: number;
  /** 工具结果折叠边界（session tool 消息序号维度）— 批量前移，保持载荷前缀稳定 */
  _toolFoldBoundary = 0;
  _agentOpts: AgentOptions;
  /** agent loop 实现（D13）——构造期解析（显式注入优先，缺省 = builtin/default）。 */
  private readonly _loop: AgentLoop;

  // 装配 context — 身份/服务唯一来源；setBus/setSubAgentPool/setGoalManager
  // 经 write-through 把后续注入同步回 ctx（ctx 是服务真源）。
  private _ctx: AgentContext;

  /** 装配用组合产物（S4-1a）— ctx 路径从服务表读（runtime 装配期写入；
   *  child() 继承白名单成员，子 Agent 与父同一组合面）。
   *  消费面：spawnSubAgent 透传子 Agent（ctx 路径）、诊断/测试只读。 */
  private readonly _composition: import('../composition/roster').ResolvedComposition | null = null;

  /** 附图字节读取器 — 请求期 IO 腰（app 注入；null = 无读取器，附图降级缺图）。
   *  ⚡ 2026-09-22：产物从裸 base64 改为 {mediaType, data}——wire 规整可能换编码
   *  （PNG → WebP 压进单图发送带），媒型必须由读取器回报而非沿用 ref。 */
  _imageReader: RequestImageReader | null = null;
  /** 已实测拒绝图片输入的模型 id 集合（2026-09-19 起能力戳不再作发送硬闸门）。
   *  按**模型 id** 键控——换模型（含会话级覆盖切换）自动重试发图，不把「某模型
   *  不收图」的实测记忆错误地延续到另一个模型上。空集 = 一律先发（默认）。 */
  private _imageUnsupportedModels = new Set<string>();
  /** 附图解析缓存（ref.id → 规整后载荷）——实例级，同图跨回合零重读。 */
  private _imageDataCache = new Map<string, RequestImagePayload>();
  /** 最近一次请求实际带上的附图 base64 字符数（挂起分账判据——见 stream 重试循环
   *  的 suspectPayload）。0 = 本轮无图。 */
  private _wireImageChars = 0;

  /** 会话创建时点生效的 preset id（S4-1b 首事件的事实源镜像——构造期读
   *  currentPresetId()；空白会话期经 selectPreset() 改选并追加同名事件）。
   *  子 Agent 经 ctx composition 继承组合面，但各 Agent 各自记首事件。 */
  private _presetId: string = 'standard';

  /** 装配用组合产物（只读面）。 */
  get composition(): import('../composition/roster').ResolvedComposition | null {
    return this._composition;
  }

  // 上下文管理
  private contextWindow: number;
  private compactRatio: number;
  private recentKeep: number;
  /** 自动压缩尾部保留 token 预算比例（0.16 默认，见 agent-compaction.ts）。 */
  private retainRatio: number;
  /** 摘要调用的输出上限（token）——缺省 SUMMARY_OUTPUT_BUDGET（8192），
   *  配置面 = .lantai/compaction-config.json 的 summaryMaxTokens。 */
  private summaryMaxTokens: number;
  // 真卡死闩锁 — 仅在"折叠后载荷仍 >95% 窗口"时置位（此时压缩确实
  // 无能为力，只有 /new 能解决）。瞬时失败不再使用它 — 见下方退避门控。
  compactStuck = false;
  // 压缩退避门控: session 长度未涨到此值不重试。空区域（对话太短）和
  // 失败后都通过它延迟重试 — 增长足够后自动恢复，无永久闩锁。
  compactRetryAfterLen = 0;
  // 连续失败计数 — 决定退避步长与是否升级用户告警
  compactFailCount = 0;

  // 子 Agent 深度追踪: 0 = 根，1 = 第一次 fork，2 = 孙 Agent，以此类推
  // MAX_SUBAGENT_DEPTH 随 spawn 实现迁 subagent-spawn.ts（宿主模式消费）
  _subagentDepth = 0;

  /** 只读深度访问器 — runtime/UI 观测用（agent_status 列表、后台活动过滤） */
  get subagentDepth(): number {
    return this._subagentDepth;
  }

  // Agent 身份 — 持久化用于生命周期追踪、会话恢复、谱系
  readonly id: string;
  readonly parentId: string | null;
  private agentStore: AgentStore | null = null;
  /** Goal 管理器 — goal-loop.ts 经 GoalLoopHost 接口读取（11c 拆分后跨模块消费）。 */
  goalManager: GoalManager | null = null;

  // 子 Agent 的隔离 ID — 注入到工具参数中，使 Rust 后端
  // 能通过 forward_map_path 解析 worktree 路径。
  _isolationId?: string;

  // Goal 循环实现已迁 goal-loop.ts（MAX_GOAL_ITERATIONS / MAX_STALL_ROUNDS 随迁）
  // PreToolUse hooks — 用图上下文增强工具结果
  private hooks: HookRegistry | null = null;

  // Preflight hooks — 破坏性写入前告警（edit_file / write_file）
  private preflightHooks: PreflightHookRegistry | null = null;

  // 步前裁决面 — 每步进入前的 enter/reject + 注入（agent-hooks-plan 一期；
  // 装配经 setPreStep 注入，loop 经 host.preStep 直读；子 Agent 不接 ⇒ null）
  private preStep: PreStepRegistry | null = null;

  // Storm breaker — 检测重复失败的工具调用
  stormSig = '';
  stormCount = 0;

  // 缓存累积
  private cacheHitTotal = 0;
  private cacheMissTotal = 0;

  // 事件 sink — 父 Agent 使用全局总线；子 Agent 使用自定义 sink
  private _sink: (ev: AgentEvent) => void;
  // UI 通知端口（workspace 注入；headless 时为空操作）
  private _ui: AgentUINotifier;

  /** UI 会话 ID — 由 ChatCore 在运行前设置，使子 Agent 通知
   *  能更新正确的会话存储（而非仅活跃的）。子 Agent 派生域经宿主接口读取。 */
  _uiSessionId: number = 0;

  // code_execution 嵌套分发面（P2 执行原语）：blueprint capability 装配时
  // 写入（工具创建需要）；getter 供 capability 读取 agent 的门禁/hook/审计上下文。
  // 形状对齐 code-run/host.ts 的 ToolDispatchFn（输出 {output, isError}）。
  _codeDispatch:
    | ((name: string, args: Record<string, unknown>) => Promise<{ output: string; isError: boolean }>)
    | null = null;

  /** code_execution 的嵌套分发面 — 工具装配（blueprint）注入。null = 未接线
   * （工具注册面照常，运行时报「未接线」错误，不留静默死路）。 */
  setCodeDispatch(
    fn: ((name: string, args: Record<string, unknown>) => Promise<{ output: string; isError: boolean }>) | null,
  ): void {
    this._codeDispatch = fn;
  }
  getCodeDispatch():
    | ((name: string, args: Record<string, unknown>) => Promise<{ output: string; isError: boolean }>)
    | null {
    return this._codeDispatch;
  }

  /** 会话事件日志只读访问（P2：code_execution 子分发审计追加面）。 */
  get sessionLog(): SessionLog {
    return this._sessionLog;
  }

  /** code_execution 的嵌套分发器 — executor 语义等价体（P2 C5/C6）。
   *
   *  复刻 streaming-executor.executeTool 的语义链（不 new executor：那套是
   *  流式边界专用，带 pending 管理与 UI 事件；这里只要单次调用的语义）。
   *  顺序：领域名解析（guardName）→ planGate → preflight HIGH → 元信息注入
   *  （_agent_id/_owner_id）→ execute → hooks 富化 → 预检警告前置 → 截断。
   *  嵌套调用不豁免任何门禁（P2 施工序 6）；isError 语义靠返回值区分
   *  （false = 成功 output；true = output 即错误文本）。 */
  dispatchNestedTool(name: string, args: Record<string, unknown>): Promise<{ output: string; isError: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return Promise.resolve({ output: `error: unknown tool "${name}"`, isError: true });
    }
    if (this.tools.isHidden(name)) {
      return Promise.resolve({ output: `[已淘汰] ${name} — 请用领域工具动作。`, isError: true });
    }
    const guardName = resolveGuardToolName(this.tools, name, args);

    // Plan 门禁（嵌套不豁免——与 executor 同规则）
    const blocked = this._planGate(guardName, args, tool);
    if (blocked) return Promise.resolve({ output: blocked, isError: true });

    // 预检钩子（HIGH 风险拦截至 _forceGate 语义——嵌套调用无 _forceGate 通道，
    // 高危写入在 code run 内一律打回：用户应直接调用工具走显式确认）
    let preflightWarning: string | null = null;
    if (this.preflightHooks) {
      try {
        preflightWarning = this.preflightHooks.check(guardName, args);
      } catch {
        preflightWarning = null; // 钩子异常不阻断（与 executor 同降级）
      }
    }
    if (preflightWarning?.includes('风险等级: HIGH')) {
      return Promise.resolve({
        output: `${preflightWarning}\n\n🚫 高风险写入不允许经 code_execution 嵌套执行——请直接调用工具并带 _forceGate: true。`,
        isError: true,
      });
    }

    // 元信息注入（与 executor 同序）：隔离 id + owner id（嵌套调用与直接调用
    // 同权限面——_agent_id 缺失会直写主仓，2026-08-13 事故防御）
    const enriched: Record<string, unknown> = { ...args };
    if (this._isolationId) enriched._agent_id = this._isolationId;
    if (this.id) enriched._owner_id = this.id;

    // 资产通道（executor 同款三件：assetId 注入 / onProgress→AssetDelta /
    // 终值→Asset 事件）。缺失时嵌套调用的 show_asset/update_asset 只落
    // asset-store 孤儿记录，聊天流永不渲染（2026-08-30 工具链路审计 C2）。
    const assetChannel = tool.assetChannel === true;
    if (assetChannel) enriched._asset_id = generateAssetId();
    const nestedAssetId = typeof enriched._asset_id === 'string' ? enriched._asset_id : '';
    const nestedAssetKind = typeof enriched.kind === 'string' ? enriched.kind : '';
    const onProgress = assetChannel
      ? (chunk: string) => {
          this._sink({
            kind: EventKind.AssetDelta,
            assetDelta: { assetId: nestedAssetId, kind: nestedAssetKind, chunk },
          });
        }
      : undefined;

    return tool
      .execute(enriched, onProgress, this._currentRunSignal ?? undefined)
      .then(async (raw) => {
        let output = raw;
        if (assetChannel) {
          const assetEvent = parseAssetEventOutput(output);
          if (assetEvent) {
            this._sink({ kind: EventKind.Asset, asset: assetEvent });
          } else if (output?.trim()) {
            // 终值非资产 JSON = 工具异常路径，留痕不静默（与 executor 同降级）
            log.warn('agent', '[dispatchNestedTool] assetChannel tool returned non-asset output', { tool: name });
          }
        }
        // 工具后钩子富化（与 executor 同降级语义）
        if (this.hooks) {
          try {
            output = await this.hooks.apply(guardName, enriched, output);
          } catch {
            /* 富化失败不破坏结果 */
          }
        }
        if (preflightWarning) {
          output = `${preflightWarning}\n\n${'─'.repeat(40)}\n\n${output}`;
        }
        const trunc = truncateToolOutput(guardName, output);
        return { output: trunc.content, isError: false };
      })
      .catch((e: unknown) => {
        const eMsg = (e as { message?: string })?.message;
        const errMsg = eMsg ? eMsg.split('\n')[0] : String(e);
        return { output: `error: ${errMsg}`, isError: true };
      });
  }

  // 最近一次用量（用于状态显示）
  private lastUsage: Usage | undefined;

  // 执行状态 — 每个 Agent 实例独立（多窗口阶段 1）
  private _execState: ExecStateInstance;

  // 待插入的用户消息（工具执行期间排队，在安全边界应用）
  private _pendingInserts: string[] = [];

  // 待处理的记忆更新（从 memory:saved 事件排队，在安全边界应用）
  private _pendingMemoryUpdates: string[] = [];

  // 追踪本轮 runLoop 已注入的 inbox 消息 — 防止 LLM 不 ack/reply 时
  // 无限唤醒循环（消息留在 inbox，finally 块会不断重新触发 _onMessageDelivered）。
  private _injectedMsgIds = new Set<string>();

  // 当前活跃 runLoop 的 signal — 从工具调用派生的子 Agent
  // 将其合并到自己的 abort signal 中，使用户停止能级联到子 Agent。
  // 子 Agent 派生域（subagent-spawn.ts）经宿主接口读取。
  _currentRunSignal: AbortSignal | null = null;

  // runLoop 是否正在运行 — **派生值**（2026-09-20 运行态收口）：运行账上有没有活的
  // 运行记录。不再有第二个写者：旧实现 `_isRunning` 布尔 + `_runGen` 代数守卫，都是
  // 「声明」——旧轮收尾清掉新轮标志那一族病灶的载体（见 execution-state.ts 头注）。
  /** runLoop 是否正在运行（账上有活运行记录） */
  get isRunning(): boolean {
    return this._execState.isRunning;
  }

  /** loop 深度（执行面事实）：同一 Agent 有几条 runLoop 在栈上。**只用于并发闸门与
   *  唤醒重入判定**——不表示 UI 的运行态（那是运行账的记录，含收尾窗口）。
   *  两个问题的答案本就不同：「这 Agent 在跑吗」（账）vs「现在能不能再进一条 loop」（栈）。 */
  private _loopDepth = 0;

  /** 本轮运行的栅栏（被看门狗作废后，迟到的事实一律不进 session 投影）。
   *  **不是第二本账**：「还在不在跑」的唯一事实仍是运行账（execution-state 的
   *  RunRecord）；这里只表达「这一轮被硬截止作废过」（用户按停是另一回事——
   *  停止后已收到的部分输出照常入卷，历史行为不变）。生命周期 = `run()` 的
   *  try 段：起 watch 时挂上、finally 里摘掉（只摘自己那面）。 */
  private _runFence: RunPulse | null = null;

  // TaskBoardFace — 异步子 Agent 追踪的共享状态区
  // （子 Agent 派生域经宿主接口读取 — 11c 拆分）
  _taskBoard: TaskBoardFace | null = null;

  // DiscoveryBoard — Agent 间知识共享的共享发现区
  // （子 Agent 派生域经宿主接口读取 — 11c 拆分）
  _discoveryBoard: DiscoveryBoard | null = null;

  // 追踪已注入的 discovery ID — 防止同一 runLoop 内重复注入
  private _injectedDiscoveryIds = new Set<string>();

  // 临时提醒 — 每轮 <system-reminder> 注入，发送给 LLM
  // 但不持久化到 this.session。每个 runLoop 步骤开始时清除。
  // 保持会话历史干净以获得稳定的缓存前缀。
  private _transientReminders: string[] = [];

  // 文件所有权 — 并行子 Agent 的运行时写保护。
  // 仅 fresh 子 Agent（无 worktree 隔离）受声明约束。
  // （子 Agent 派生域经宿主接口读写 — 11c 拆分）
  _fileOwnership: FileOwnership | null = null;

  // 会话持久化
  sessionId: string;
  private _onSessionPersisted: ((sessionId: string, messages: Message[]) => void) | undefined;

  // 压缩成本模型追踪器
  private compactionTracker = new CompactionTracker();
  _compactionConfigPath: string | null = null;
  _compactionTrackerPath: string | null = null;

  // ── 压缩折叠状态（根治: session = 完整历史，压缩只影响发送载荷）──
  // session 永不被压缩动作替换 — UI 渲染与磁盘存档始终完整。
  // 压缩 = 生成摘要 + 记录折叠点；payloadMessages() 据此构造发送载荷。
  _compactSummary: string | null = null;
  _compactTailStart = -1;

  constructor(ctx: AgentContext, systemPrompt: string, opts: AgentOptions = {}) {
    this._ctx = ctx;
    this.prov = ctx.resolve('provider');
    this.tools = ctx.resolve('tools');
    this._sink = opts.eventSink ?? ctx.get('eventSink') ?? (() => {});
    this._ui = opts.ui ?? {};
    this._agentOpts = opts;
    // D13：loop 实现 = 显式注入优先，缺省 = ctx.agentLoop 注册表当前实现
    // （批 9h-2：出厂默认实现已随 agent-loop-service 包，内核不再持兜底引用；
    //  无服务 = 具名 fail-loud，见 agent-loop-active.ts）
    this._loop = opts.agentLoop ?? resolveAgentLoop();
    // 附图读取器（multimodal-image-plan B3）：请求期 ref→base64 的 IO 腰；
    // 缓存按 id 键控——同图跨回合零重读。子 Agent 经 spawn 继承读取器。
    this._imageReader = opts.imageReader ?? null;
    // Phase 5：planGate 常驻经 eventBus tool/guard 监听（构造期挂——
    // executor 收到 eventBus 后优先 bus；缺 guard 监听 = plan 门禁失效，
    // 故守卫监听必须无条件先于任何 bus 使用）
    attachPlanGate(this._loopEvents, this._planGate);
    // Phase 5 施工②：第一方 loop 可观测监听器（turn/start → 'turn started'
    // 日志——重表达自 default-loop 散点；disposer 随 bus 生命周期）
    attachFirstPartyLoopObservability(this._loopEvents);
    this.temperature = opts.temperature ?? 0.7;
    this._visibleToolsLimit = opts.visibleToolsLimit ?? DEFAULT_VISIBLE_TOOLS_LIMIT;
    // 默认禁用折叠 — 见 toolResultWindow 注释（DeepSeek 缓存计价下不划算）
    this._toolResultWindow = opts.toolResultWindow ?? 0;
    this.contextWindow = opts.contextWindow || 1000000; // 1M tokens 默认值; || 捕获零值（设置默认值），使压缩永不被静默禁用
    this._tokenMeter.setContextWindow(this.contextWindow);
    // ponytail: 0.8 对齐 DSH thresholdRatio（2026-09 迭代）。
    // 0.55 是旧 1M 窗口时代的经验值——真实窗口按模型热同步后（per-model
    // 覆盖 → 目录值 → 200K 缺省），0.55×200K = 110K 就触发，把仍会反复
    // 读取的活跃中段过早换成摘要，在前缀缓存计价（hit 1/50 价）下净亏。
    // 触发点前移到 step 前同步判定（default-loop pre-flight），0.8 线保证
    // 只在压力真高、压缩有净收益时动手。积累足够样本后自动调优
    // （compaction-model.ts 夹取 [0.7, 0.85]）。
    this.compactRatio = opts.compactRatio ?? DEFAULT_COMPACT_RATIO;
    this.recentKeep = opts.recentKeep ?? 4;
    // 自动压缩尾部 token 预算（对齐 DSH retainRatio 0.16）— 从尾部往回
    // 累计 token 保留完整 user 回合，工具密集会话里保证模型有足够近期现场。
    this.retainRatio = opts.retainRatio ?? DEFAULT_RETAIN_RATIO;
    // 摘要输出上限（2026-09-23）：4096 会被思考吃光（摘要与主会话同模型同思考
    // 档位，共用这一份输出预算）→ 空摘要 → 静默退化。8192 对齐 DSH 缺省；
    // 压缩配置里的 summaryMaxTokens 在 applyAutoTuneConfig 时覆盖它。
    this.summaryMaxTokens = SUMMARY_OUTPUT_BUDGET;
    this._subagentDepth = ctx.subagentDepth ?? opts.subagentDepth ?? 0;
    this.id = ctx.agentId ?? opts.agentId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.parentId = ctx.parentId ?? opts.parentId ?? null;
    // 运行账（「这 Agent 在不在跑」的唯一事实，2026-09-20 收口）：会话装配面
    // （workspace 会话工厂 → 卷级账）/ 子 Agent 派生面（subagent-spawn → 私账）都显式
    // 供账；两处都缺席 = 非会话装配路径（测试直构 / headless 驱动）→ 自铸一本**私有**账
    // 并留 debug 痕。**不再有模块级单例兜底**——那本共享账会让「谁在跑」跨 Agent 串味
    //（UI 读卷级账、Agent 记在单例上 = 运行态丢失的经典形状）。
    this._execState = opts.execState ?? ctx.get('execState') ?? this._mintPrivateExec();
    this._bus = ctx.get('messageBus') ?? opts.messageBus ?? null;
    this._taskBoard = ctx.get('taskBoard') ?? opts.taskBoard ?? null;
    this._discoveryBoard = ctx.get('discoveryBoard') ?? opts.discoveryBoard ?? null;
    this.agentStore = ctx.get('agentStore') ?? null;
    this.goalManager = ctx.get('goalManager') ?? null;
    this._subAgentPool = ctx.get('subAgentPool') ?? null;
    this._composition = ctx.get('composition') ?? null;
    // S6 P2a：本 Agent 的组合裁剪面灌进自己的 loop 事件总线——emit 调用点
    // （default-loop 7 处 + spawnSubAgent 3 处）零改动，总线自己回答「本组合
    // 禁了哪些观测事件」。无组合产物（未接线的 ctx / 单测）= null ⇒ 读全局
    // 当前选择（P2 前语义）。
    this._loopEvents.setSeamView(this._composition?.seamDisabled ?? null);

    this.sessionId = opts.sessionId || `session-${Date.now()}`;
    this._onSessionPersisted = opts.onSessionPersisted;

    // Phase 5 双写：日志先于 session 初始化（构造期的 system prompt 也走事件入口）。
    this._sessionLog = ctx.get('sessionLog') ?? new SessionLog();
    this.session = [];
    if (systemPrompt) {
      this._replaceSession([{ role: 'system', content: systemPrompt }], 'init');
    }
    // S4-1b 首事件：构造（init reset）后必发 preset/selected——创建时点事实
    // （「模型可见 ⟺ 已记录」：preset 决定模型看到的 schema/段，必须可重建）。
    this._presetId = currentPresetId();
    this._sessionLog.append('preset/selected', { presetId: this._presetId });

    // bus 注册与隔离接线在构造内完成（ctx 为唯一入口）。
    if (this._bus) {
      const bus = this._bus;
      this.setBus(bus);
      // Phase 4：bus 注册的对称清理归 ctx 所有权——runtime _disposeAgent 经
      // ctx.dispose() 逆序统一释放（flush 前置顺序在 _disposeAgent 内保持）。
      ctx.effect(() => () => bus.unregister(this.id), 'bus-unregister');
    }
    if (ctx.isolationId) this._isolationId = ctx.isolationId;
    // 会话上下文注册（tool-ergonomics design-1 rev2）：owner id → 工作区根，供域工具
    // 参数预处理腰（相对路径解析/省缺填充/焦点态）读取。child() 派生继承 projectPath
    // → 子 Agent 自动注册；对称清理归 ctx 所有权（bus-unregister 同款纪律）。
    if (ctx.projectPath) {
      ctx.effect(() => registerOwnerContext(this.id, ctx.projectPath), 'session-context');
    }
    // S6 P2a：装配期登记本 Agent 的组合裁剪面（键 = owner id = 上面同一个
    // this.id）——工具族在请求期按 executor 注入的 _owner_id 查表取「本卷的
    // seam 视图」（composition/seam-scope.ts；携带路径的裁定与证据见该文件头注）。
    // 对称清理归 ctx 所有权（session-context 同款）；无组合产物 = 不登记 ⇒
    // 消费点落全局当前选择（零漂移）。与 projectPath 判面无关：零目录工作区
    // 同样按本卷组合裁剪。
    const composition = this._composition;
    if (composition) {
      ctx.effect(() => registerSeamScope(this.id, composition.seamDisabled), 'seam-scope');
    }
  }

  /** 由 workspace 在会话中途保存记忆时调用 — 排队并在
   *  下一个安全边界作为 system-reminder 注入。 */
  notifyMemorySaved(text: string): void {
    this._pendingMemoryUpdates.push(text);
  }

  setHooks(hooks: HookRegistry): void {
    this.hooks = hooks;
    // Phase 5：hooks 经 eventBus tool/around 监听运行（executor 优先 bus）
    if (!this._hookAttached) {
      this._hookAttached = true;
      attachHookRegistry(this._loopEvents, hooks);
    }
  }

  setPreflightHooks(hooks: PreflightHookRegistry): void {
    this.preflightHooks = hooks;
    // Phase 5：preflight 经 eventBus tool/preflight 监听运行
    if (!this._preflightAttached) {
      this._preflightAttached = true;
      attachPreflightRegistry(this._loopEvents, hooks);
    }
  }

  /** 步前裁决面接线（agent-hooks-plan 一期）——只存引用：loop 经
   *  host.preStep 直读，不经 eventBus（装配期折叠的贡献注册进同一 registry 实例）。 */
  setPreStep(registry: PreStepRegistry): void {
    this.preStep = registry;
  }

  /** preflight 注册表只读访问 — 子 Agent 装配继承门禁用（subagent-spawn.ts）。 */
  getPreflightHooks(): PreflightHookRegistry | null {
    return this.preflightHooks;
  }
  private _hookAttached = false;
  private _preflightAttached = false;

  /** Plan 模式状态 + 注入器 — 由 Runtime 在 createAgent 时设置。
   *  2026-08-10 起不再按 plan 状态切换工具注册表（schema 跨模式恒定，
   *  DeepSeek 前缀缓存不被 enter/exit 击穿）；写约束在执行层按
   *  planState 运行时拦截（planGateCheck → StreamingToolExecutor）。 */
  private _planState: import('./plan/plan-state').PlanStateManager | null = null;
  private _planInjector: import('./plan/plan-contract').PlanReminderInjector | null = null;
  /** 项目路径 — plan 模式 enter 需要（UI 按钮切换路径） */
  private _projectPath = '';

  /** Plan 门禁委托 — 稳定引用供 executor 构造时注入；运行时读取最新 _planState。 */
  private _planGate: PlanGate = (name, args, tool) => planGateCheck(this._planState, name, args, tool);

  setPlanState(
    state: import('./plan/plan-state').PlanStateManager,
    injector: import('./plan/plan-contract').PlanReminderInjector,
    projectPath = '',
  ): void {
    this._planState = state;
    this._planInjector = injector;
    this._projectPath = projectPath;
  }

  /** UI 按钮路径 — 运行时切换 plan 模式，不重建 Agent。 */
  setPlanMode(active: boolean): void {
    if (!this._planState) return;
    if (active && !this._planState.state.active) {
      if (!this._projectPath) return;
      this._planState.enter(this._projectPath);
    } else if (!active && this._planState.state.active) {
      this._planState.exit();
    }
  }

  /** UI 按钮路径 — 运行时更新思考策略（ModelSwitcher 切档位/深思考开关），
   *  不重建 Agent。子 Agent 共享 this.prov，自动一并生效。 */
  setThinking(cfg: StoredThinking | undefined): void {
    this.prov.setThinking?.(cfg);
  }

  /** UI 路径 — 运行时切换 provider（模型/提供方/协议），不重建 Agent。
   *  正在进行的请求已持有旧引用，继续完成后下一轮起用新 provider；
   *  子 Agent 共享 this.prov，自动一并生效。
   *  ⚡ 2026-09-06 价格表拆除：pricing 参数退役（同批删 setPricing）。 */
  setProvider(prov: Provider): void {
    this.prov = prov;
    // write-through：子 Agent 从 ctx 服务表继承 provider（context.ts child()）。
    // 不写则热切换后新 spawn 的子 Agent 仍持有旧 provider/旧 Key ——
    // 2026-08-16 全链路断链审计（provider 切换 不生效 的根因之一）。
    try {
      this._ctx.set('provider', prov);
    } catch {
      /* ctx 已 dispose —— 忽略写入 */
    }
  }

  /** 从持久化快照恢复 plan 状态 — 在 agent load 后调用 */
  restorePlanState(
    snapshot: import('./plan/plan-state').PlanStateSnapshot | null | undefined,
    projectPath: string,
  ): void {
    if (this._planState) {
      this._planState.fromSnapshot(snapshot ?? null, projectPath);
    }
  }

  setUiSessionId(sid: number): void {
    this._uiSessionId = sid;
  }

  /** 私账自铸（非会话装配路径：测试直构 / headless 驱动）。
   *  刻意**不是**模块级单例（旧实现的 `?? execState` 兜底）：共享账会让「谁在跑」
   *  跨 Agent 串味——UI 读卷级账、Agent 记在单例上 = 运行态丢失的经典形状。
   *  留 debug 痕（生产不该走到这里；真走了可从 ui.log 认出来）。 */
  private _mintPrivateExec(): ExecStateInstance {
    const exec = createExecState();
    log.debug('agent', `Agent ${this.id} 未接运行账——自铸私有账（非会话装配路径）`);
    return exec;
  }

  /** 认领本次运行的账上记录：调用方（chat-core 起轮 / 唤醒自起）通常已经
   *  `beginRun` 过——按 signal 身份查得即**不由本层收尾**（谁起谁收）；
   *  查不到（子 Agent 派生 / 第三方驱动面递进来的 signal）则由本层登记并收尾。
   *  ⚠ 这一跳是「Agent 在跑 ⟺ 账上在跑」的兜底半边：少了它，外部驱动的轮次
   *  会在账上隐形（UI 说空闲）。 */
  private _claimRun(signal: AbortSignal, kind: RunKind): RunHandle | null {
    if (this._execState.runFor(signal)) return null;
    return this._execState.beginRun(kind, signal);
  }

  /** 会话层装配收尾回填本卷 exec 账本（`chat-session.bindSessionExec` → registry.bindExec）
   *  ——运行态单一权威源的绑定点。**账是卷级恒定的那一本**：本方法只换引用、不新铸，
   *  在跑的记录因此跨句柄重建仍然可见（2026-09-20 收口；旧实现每次装配换一本新账，
   *  在跑的记录被孤儿化 = 「会话在跑而 UI 说空闲」）。
   *  Agent 自起的轮次（`_onMessageDelivered`：总线唤醒 / 异步子 Agent 回件 / 后台任务 bg）
   *  也走这本账——两处读的必须是同一个对象。 */
  setExecState(exec: ExecStateInstance): void {
    this._execState = exec;
  }

  // ---- 公共 API ----

  getSession(): Message[] {
    return this.session;
  }

  /** Phase 5：本 Agent 的事件溯源日志（观测/差分/回放入口）。
   *  append 只发生在运行时边界（下方三个双写入口），外部不得直写。 */
  getSessionLog(): SessionLog {
    return this._sessionLog;
  }

  // ── Phase 5 双写入口：模型可见事实先 append 事件，同一消息对象进 session 投影 ──
  // 旧数组路径保留为真源（restore/UI/持久化读它）；等价性由 tests/session-differential.test.ts
  // 差分矩阵与 baseline/phase-5 契约快照钉住。agent.ts 内禁止绕过这三个入口直改 session。

  /** 追加一条模型可见消息（user / assistant / tool）。 */
  private _appendMessage(kind: 'user/message' | 'assistant/text' | 'tool/result', message: Message): void {
    // ⚡ 栅栏（landmine L3 遗弃语义）：本轮被看门狗作废之后，**迟到的事实不进投影**
    //   ——挂住的 stream 事后吐出的 chunk、迟到的工具结果都到此为止（审计面照旧：
    //  `tool/call` 早在分发时已落 session-log，盘上有事实、卷里不认账）。
    //   为什么在入口拦而不是在各自调用点拦：投影只有这一个写入口（phase-5 T0 钉死），
    //   拦这里 = 拦得住全部迟到路径，且不会漏掉将来新增的调用点。
    if (this._runFence?.abandoned) {
      log.warn('agent', '作废轮的迟到事实被栅栏拦下（只留审计，不进会话投影）', {
        runId: this._runFence.runId,
        kind,
        role: message.role,
      });
      return;
    }
    // 脉搏 ②（landmine L3 定义）：**工具结果落盘**即「这一轮在动」。
    // 为什么挂在本入口而不在各调用点：这是投影的唯一写入口（phase-5 T0 钉死），
    // 挂这里 = 全部落盘路径（含将来新增）自动带上脉搏，不会漏。
    // 只给 tool/result 计脉：user/assistant 文本不算「进展」（模型还在想）。
    if (kind === 'tool/result' && this._runFence) this._runFence.beat('tool');
    this._sessionLog.append(kind, { message });
    this.session.push(message);
  }

  /** 会话整体替换（构造 init / setSession 恢复 / newSession / goal 恢复与清场）。
   *  事件内携带深拷贝快照（调用方后续改动不得回写历史）；折叠失效与游标重置
   *  语义留在调用点，与替换来源一一对应。
   *  **reason='adopt'（Phase 3 权威翻转）例外**：本 log 已含磁盘历史（开卷时
   *  restoreInPlace 置回真源），此事件只重设头部 system 提示——内存投影从 log
   *  派生（deriveMessages），不是「只有 system」。整段替换的写法要把全部消息
   *  再写一遍（每次开卷 +1 份全文），与 append-only 增量相悖。 */
  private _replaceSession(messages: Message[], reason: SessionResetReason): void {
    this._sessionLog.append('session/reset', {
      messages: messages.map((m) => JSON.parse(JSON.stringify(m)) as Message),
      reason,
    });
    this.session = reason === 'adopt' ? this._sessionLog.deriveMessages() : messages;
    // 资产表随会话重建（索引镜像真源——四边界共用此点）：恢复后 update_asset
    // 对旧资产照常寻址（此前无重建路径，重启后 U 面断）；newSession/清场后表
    // 随会话归空。scope = 本 Agent 的 _owner_id（executor 注入语义同源）。
    rebuildAssetsFromSession(this.id, this.session);
  }

  /** 区间撤回（[fromIndex, toIndex) splice 语义 — retractTurnAt / goal 暂停裁剪）。
   *  **压实优先**（2026-09-19 A 案）：撤回落定时把区间的来源事件从日志里**物理抹除**
   *  （盘面整写 + 头行 erased 账），不可压实（无盘面 / 锚点不可抹 / 自校验不过）退回
   *  「只记区间」旧语义——降级原因在日志面可见（debug），设计见 session-tree-plan §12.9。 */
  private _retractSessionRange(fromIndex: number, toIndex: number): void {
    const outcome = this._sessionLog.retractRange(fromIndex, toIndex);
    if (outcome.erased === null && outcome.reason) {
      log.debug('agent', `撤回未压实（退回只记区间）：${outcome.reason}`, { fromIndex, toIndex });
    }
    this.session.splice(fromIndex, toIndex - fromIndex);
  }

  setSession(msgs: Message[]): void {
    this._replaceSession(msgs, 'restore');
    // 会话被替换（恢复/加载）→ 折叠状态失效，从完整历史重新开始
    this._compactSummary = null;
    this._compactTailStart = -1;
    this._execState.bumpVersion();
    this._ui.sessionReplaced?.(this.session);
  }

  /**
   * 采用日志里的磁盘历史（Phase 3 权威翻转，2026-09-15 换轨）——开卷路径专用。
   *
   * 与 `setSession` 的区别：`setSession` 是**替换**（事件携带全文，用于恢复快照/
   * goal 清场）；本方法是**采用**——本 Agent 的 `_sessionLog` 已被
   * `restoreInPlace` 置回磁盘真源，这里只发一条**头部重设**事件（reason='adopt'，
   * 小事件），内存投影 = `deriveMessages()`（磁盘历史 + 本轮 system）。
   *
   * 为什么不复用 setSession：那要把全部消息再写一遍（每次开卷 +1 份全文）。
   */
  adoptSessionLog(systemPrompt: string): void {
    this._replaceSession([{ role: 'system', content: systemPrompt }], 'adopt');
    this._compactSummary = null;
    this._compactTailStart = -1;
    this._execState.bumpVersion();
    this._ui.sessionReplaced?.(this.session);
  }

  /** 空白会话期改选 preset（S4-1b）：追加 preset/selected 事件（newest-wins
   *  重建的依据）+ 镜像字段更新。注意：**不重装配**——组合面在创建时点
   *  冻结（前缀缓存纪律；真正生效的下一次装配在会话边界）。本方法只服务
   *  「会话还没跑起来时改了默认 preset」的记录修正语义。 */
  selectPreset(presetId: string): void {
    this._presetId = presetId;
    this._sessionLog.append('preset/selected', { presetId });
  }

  /** 会话的 preset 选择重建（newest-wins；无事件 = undefined——S4-1b 前
   *  的旧会话文件兼容：调用方以 'standard' 缺省）。 */
  get sessionPresetId(): string | undefined {
    return this._sessionLog.resolveSessionPreset();
  }

  /** 本卷生效的组合 id（P0 记录闭环，2026-09-14）——ChatAgentHandle 的能力位
   *  实现：卷落盘写 `presetId` 时读它（真源 = 构造时点读的 preset id；空白会话期
   *  经 selectPreset 改选会同步更新）。与 `sessionPresetId`（事件流重建面）的分工：
   *  本 getter 是**当前事实**，那个是**日志重建**。 */
  get presetId(): string {
    return this._presetId;
  }

  getLastUsage(): Usage | undefined {
    return this.lastUsage;
  }

  getCacheTotals(): { hit: number; miss: number } {
    return { hit: this.cacheHitTotal, miss: this.cacheMissTotal };
  }

  /** 获取当前会话的压缩成本模型统计。 */
  getCompactionStats(): CompactionSessionStats {
    return this.compactionTracker.getStats();
  }

  /** 压缩统计工具的公共访问器。 */
  getCompactionTracker(): CompactionTracker {
    return this.compactionTracker;
  }
  getCompactRatio(): number {
    return this.compactRatio;
  }
  getRecentKeep(): number {
    return this.recentKeep;
  }
  /** 自动压缩尾部保留的 token 预算比例（agent-compaction.ts 消费）。 */
  getRetainRatio(): number {
    return this.retainRatio;
  }
  /** 摘要调用的输出上限（压缩统计工具/配置面消费）。 */
  getSummaryMaxTokens(): number {
    return this.summaryMaxTokens;
  }
  getContextWindow(): number {
    return this.contextWindow;
  }

  /** 运行时更新上下文窗口（压缩阈值）。设置面板改 contextWindow 后热切换，
   *  不重建 Agent — 所有压缩判定都是运行时读此字段，下次判定即生效。 */
  setContextWindow(n: number): void {
    this.contextWindow = n > 0 ? n : 1000000; // 与构造兜底同语义
    this._tokenMeter.setContextWindow(this.contextWindow); // 计量面热同步（占用分母换新）
  }

  // ── token 计量公共面（2026-09-13）——UI 读数 / 账本随卷落盘 ──

  /** 本卷计量读数（分桶用量 / 压力 / 投影占用 / 构成 / 逐轮）。纯读。 */
  getTokenStats(): TokenMeasurement {
    return this._tokenMeter.measure();
  }

  /** 账本快照（随卷落盘；空账本 null）。 */
  snapshotTokenLedger(): TokenLedgerSnapshot | null {
    return this._tokenMeter.snapshot();
  }

  /** 从卷文件恢复账本（毒化数据降级为缺省，绝不抛）。 */
  restoreTokenLedger(snapshot: TokenLedgerSnapshot | null | undefined): void {
    this._tokenMeter = requireTokenMeter().restoreLedger(snapshot);
    this._tokenMeter.setContextWindow(this.contextWindow);
  }

  /** 从**卷日志**恢复折叠状态（压缩摘要 + 尾部起点）—— 运行时态的重建面。
   *
   *  病灶（2026-09-24 实测）：`_compactSummary/_compactTailStart` 只在压缩时写
   *  （agent-compaction 的 applyCompactState），重开卷/重启后**没有恢复路径**：
   *  载荷回到满值，付过钱的摘要在下一次请求里白丢，随后还要再压一次。
   *  实证 = 卷 39 压缩后 postTokens 22,378，重建 exe + 重启后同一卷载荷 295,017。
   *
   *  真源 = `SessionLog.compactionState()`（`project()` 的唯一 fold：compaction 事件设置、
   *  非 adopt 的 reset 清除、retract 不清），不在本类里另算一份。调用点与账本恢复同规：
   *  开卷路径（loadSessionFromDisk）与惰性补建路径（ensureVolumeAgent）**都要**接
   *  ——「句柄是惰性资源」这条教训在账本那一批已经付过一次学费（efa8ddd0）。
   *
   *  幂等：无折叠状态 / 摘要为空 / tailStart < 0 ⇒ 保持现状（新卷语义）。 */
  restoreCompactionFromLog(): void {
    const state = this._sessionLog.compactionState();
    if (!state?.summary || state.tailStart < 0) return;
    this._compactSummary = state.summary;
    // 钳制与 applyCompactState 同规：头部偏移以下 / 会话长度以上都不是合法折叠点。
    const head = requireCompactionImplementation().foldHead(this as unknown as CompactionHost);
    this._compactTailStart = Math.max(head, Math.min(state.tailStart, this.session.length));
  }

  /** 设置自动调优压缩配置的持久化路径（委托 agent-compaction.ts）。 */
  setCompactionConfigPath(projectPath: string): void {
    requireCompactionImplementation().setCompactionConfigPath(this as unknown as CompactionHost, projectPath);
  }

  /** E5: 从磁盘加载持久化的 tracker 状态。 */
  async loadCompactionTracker(): Promise<void> {
    return requireCompactionImplementation().loadCompactionTracker(this as unknown as CompactionHost);
  }

  /** 尝试加载持久化的压缩配置。无保存则返回 null。 */
  async loadCompactionConfig(): Promise<CompactionConfig | null> {
    return requireCompactionImplementation().loadCompactionConfig(this as unknown as CompactionHost);
  }

  /** 应用自动调优的压缩参数。返回应用的配置。 */
  async applyAutoTuneConfig(): Promise<CompactionConfig | null> {
    return requireCompactionImplementation().applyAutoTuneConfig(this as unknown as CompactionHost);
  }

  /** 撤回一轮: 从 sessionIndex 开始移除用户消息 + 后续的 assistant + tool 消息。
   *  通过 SessionChanged 事件通知 UI。 */
  retractTurnAt(sessionIndex: number): void {
    let end = sessionIndex + 1;
    while (end < this.session.length && this.session[end].role !== 'user') {
      end++;
    }
    this._retractSessionRange(sessionIndex, end);
    this._execState.bumpVersion();
    this._sink({ kind: EventKind.SessionChanged });
    this._ui.sessionReplaced?.(this.session);
  }

  /** 预测下一次插入的会话索引。在 insertMessage 前调用获取索引。 */
  get nextInsertIndex(): number {
    return this.session.length + this._pendingInserts.length;
  }

  /** 将消息插入会话队列。安全排队；Agent 在下次循环迭代时看到。
   *  通知是可选的 — 系统调用方（onSessionPersisted）应传 silent=true。 */
  insertMessage(text: string, opts?: { silent?: boolean }): void {
    this._pendingInserts.push(text);
    if (!opts?.silent) {
      this._sink({ kind: EventKind.Notice, level: 'info', text: '消息已插入，Agent 将在下一轮看到' });
    }
  }

  // ── 子 Agent 生命周期 ──

  /** 子 Agent 池的引用。由 workspace 在构造后设置。 */
  private _subAgentPool: import('./subagent-runtime-contract').SubAgentPool | null = null;

  /** Agent 间通信的消息总线。由 runtime/spawnSubAgent 设置。 */
  private _bus: MessageBus | null = null;

  setSubAgentPool(pool: import('./subagent-runtime-contract').SubAgentPool): void {
    this._subAgentPool = pool;
    this._ctx.set('subAgentPool', pool);
  }

  /** 接线 Agent 间通信的消息总线。
   *  注册 Agent 地址 + 唤醒回调，当 Agent 空闲时消息到达会触发 runLoop。 */
  setBus(bus: MessageBus): void {
    this._bus = bus;
    this._ctx.set('messageBus', bus);
    bus.register({ agentId: this.id, parentId: this.parentId, depth: this._subagentDepth }, () => {
      void this._onMessageDelivered();
    });
  }

  /** 接线 discovery board 用于 Agent 间知识共享。
   *  由 runtime 调用，将共享 board 注入每个 Agent。 */
  setDiscoveryBoard(board: DiscoveryBoard): void {
    this._discoveryBoard = board;
  }

  /** 级联中止: 父 Agent 被中断时停止所有子 Agent。 */
  cascadeAbort(): void {
    const pool = this._subAgentPool;
    if (pool) {
      const stopped = pool.stopAll();
      if (stopped.length > 0) {
        log.info('agent', `cascade abort: stopped ${stopped.length} sub-agents`);
      }
    }
  }

  /** 接线文件所有权注册表，用于并行子 Agent 写保护。
   *  仅 fresh 子 Agent（无 worktree）受声明约束。 */
  setFileOwnership(fo: FileOwnership): void {
    this._fileOwnership = fo;
  }

  /** Bus 唤醒回调 — 当消息投递到此 Agent 的 inbox 时调用。
   *  若 Agent 空闲（未运行），启动新的 runLoop 处理消息。
   *  若正在运行，_injectInbox 会在下次迭代时拾取消息。 */
  private async _onMessageDelivered(): Promise<void> {
    // 重入判定 = **loop 是否在栈上**（不是「账上有没有记录」）：上一轮 loop 已返回、
    // 记录还在收尾窗口时，唤醒必须能进来（否则本轮结束时投递的那条消息要等到用户
    // 下次发言才被处理——延迟唤醒的意义就没了）。真正的并发由 runLoop 的深度守卫兜。
    if (this._loopDepth > 0) return;
    if (this._bus?.unreadCount(this.id) === 0) return;
    // 唤醒轮 = 本 Agent **自起**的运行：起一条记录（kind='wake'），句柄即收尾凭证。
    // ⚠ 旧实现是 `const signal = start()` + finally `done()`（不带令牌）——默认 loop 的
    //   「延迟唤醒」微任务排在轮内收尾之前，于是旧轮的 done() 会把新轮刚建立的运行态
    //   一起清空（会话在跑而创作坞说空闲 + 停钮空按）。新模型里 `run.end()` 只注销
    //   **自己这条记录**：新轮有它自己的记录，谁也清不掉谁（结构性，不靠守卫记得带令牌）。
    //   钉子：tests/session-exec-single-authority.test.ts ⑥/⑦。
    const run = this._execState.beginRun('wake');
    try {
      await this.run(run.signal, '');
    } catch {
      // 唤醒失败不致命——消息还在 inbox，下次 run() 会捡到
    } finally {
      run.end();
    }
  }

  /** 批量停止所有运行中的子 Agent。返回已停止的 Agent ID 列表。 */
  stopAllSubAgents(): string[] {
    return this._subAgentPool?.stopAll() ?? [];
  }

  /** 当前运行中的子 Agent 数量。 */
  runningSubAgentCount(): number {
    return this._subAgentPool?.runningCount ?? 0;
  }

  // ── Agent 身份与持久化 ──

  /** 接线持久化存储。主 Agent 从 Workspace 获取；
   *  子 Agent 从父 Agent 继承同一存储。 */
  setAgentStore(store: AgentStore): void {
    this.agentStore = store;
  }

  setGoalManager(mgr: GoalManager): void {
    this.goalManager = mgr;
    this._ctx.set('goalManager', mgr);
  }

  /** 将当前身份状态保存到内存注册表（2026-09-01 起不再落盘——见
   *  agent-store.ts 头注；会话全文由父会话消息层持久化）。Best-effort。 */
  async saveState(status: AgentRecord['status'] = 'running'): Promise<void> {
    if (!this.agentStore) return;
    try {
      await this.agentStore.save(this.id, {
        parentId: this.parentId,
        description: this.id === 'main' ? '主Agent' : `子Agent (depth ${this._subagentDepth})`,
        status,
        subagentDepth: this._subagentDepth,
        planSnapshot: this._planState?.toSnapshot() ?? undefined,
      });
    } catch {
      /* 尽力而为 — 绝不阻塞 agent 循环 */
    }
  }

  /** 在安全边界应用排队的插入（循环顶部，工具结果提交后）。 */
  private _applyPendingInserts(): void {
    if (this._pendingInserts.length === 0) return;
    for (const text of this._pendingInserts) {
      this._appendMessage('user/message', { role: 'user', content: text });
    }
    this._pendingInserts = [];
    // 通知 chat.ts 在新响应开始前完成当前轮次
    this._sink({ kind: EventKind.TurnStarted });
  }

  /** 在安全边界应用排队的记忆更新。
   *  作为临时 system-reminder 注入，使 Agent 在会话中途看到更新的记忆。
   *  不持久化到会话 — 记忆文件本身是持久层。 */
  private _applyPendingMemoryUpdates(): void {
    if (!this._pendingMemoryUpdates?.length) return;
    const text = this._pendingMemoryUpdates.join('\n');
    this._transientReminders.push(`<system-reminder>${text}</system-reminder>`);
    this._pendingMemoryUpdates = [];
  }

  /** 将未读 inbox 消息注入为 system-reminder。非破坏性 —
   *  消息留在 inbox 直到被显式 ack 或回复。
   *  追踪已注入的消息 ID 以防止同一轮内重复注入
   *  result/reply/bg 在注入时消费（从 inbox 移除）— 不需要回复。
   *  request 注入完整内容但留在 inbox（agent_reply 需要它在）。
   *  free 类型消息获得轻量通知；内容留在 inbox
   *  供 agent_inbox 查找。过期的 free 消息在注入前清除。 */
  private _injectInbox(): void {
    if (!this._bus) return;

    // 1. 清除过期的 free 类型消息
    this._bus.purgeExpired(this.id);

    // 2. 消费 result/reply/bg: 注入完整内容 + 从 inbox 移除
    //    （bg = 后台任务完成通知，owner 路由投递，含 jobId 指针 — 必须完整注入）
    const CONSUME_TYPES = ['result', 'reply', 'bg'];
    const { consumed, remaining } = this._bus.consumeByType(this.id, CONSUME_TYPES);

    // 3. 未消费的消息: 'request' 注入完整内容，其他注入轻量通知。
    //    'request' 留在 inbox 以便 agent_reply 找到并 ack。
    const newRemaining = remaining.filter((m) => !this._injectedMsgIds.has(m.id));
    for (const m of newRemaining) this._injectedMsgIds.add(m.id);

    const newRequests = newRemaining.filter((m) => m.type === 'request');
    const newFreeMsgs = newRemaining.filter((m) => m.type !== 'request');

    // 4. 强类型消息（result/reply/request）持久化到会话 — 它们
    //    从 inbox 消费或需要显式 ack，因此必须作为持久上下文
    //    保留供 Agent 处理。
    const durableParts: string[] = [];
    if (consumed.length > 0) {
      const formatted = consumed
        .map(
          (m) =>
            `[msg_id:${m.id}] from:${m.from} type:${m.type}\n${typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload)}`,
        )
        .join('\n\n');
      durableParts.push(`📬 消息 (${consumed.length} 条):\n${formatted}`);
    }
    if (newRequests.length > 0) {
      const formatted = newRequests
        .map(
          (m) =>
            `[msg_id:${m.id}] from:${m.from} type:${m.type}\n${typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload)}`,
        )
        .join('\n\n');
      durableParts.push(`📬 请求 (${newRequests.length} 条，用 agent_reply 回复):\n${formatted}`);
    }
    if (durableParts.length > 0) {
      this._appendMessage('user/message', {
        role: 'user',
        content: `<system-reminder>\n${durableParts.join('\n\n')}\n</system-reminder>`,
      });
    }

    // 5. free 类型消息是临时的（内容留在 inbox 供 agent_inbox 查找）
    if (newFreeMsgs.length > 0) {
      const summary = newFreeMsgs.map((m) => `- from:${m.from} type:${m.type} (msg_id:${m.id})`).join('\n');
      this._transientReminders.push(
        `<system-reminder>\n📬 未读消息 (${newFreeMsgs.length} 条，用 agent_inbox 查看详情):\n${summary}\n</system-reminder>`,
      );
    }

    // 6. 将 _injectedMsgIds 与实际 inbox 同步 — 移除自上次注入以来
    //    已 ack、过期或消费的消息 ID。
    const remainingIds = new Set(remaining.map((m) => m.id));
    for (const id of this._injectedMsgIds) {
      if (!remainingIds.has(id)) this._injectedMsgIds.delete(id);
    }
  }

  /** 将其他 Agent 的新发现注入为 system-reminder。
   *  仅注入本轮尚未见过 + 由其他 Agent 发布 + 5 分钟内的条目。
   *  使用 _injectedDiscoveryIds 防止重复注入。 */
  private _injectDiscoveries(): void {
    if (!this._discoveryBoard) return;
    const entries = this._discoveryBoard.query();
    if (entries.length === 0) return;
    // 仅注入来自其他 Agent、尚未见过、5 分钟内的 discoveries
    const recent = entries.filter(
      (e) => e.agentId !== this.id && !this._injectedDiscoveryIds.has(e.id) && Date.now() - e.ts < 5 * 60 * 1000,
    );
    if (recent.length === 0) return;
    for (const e of recent) this._injectedDiscoveryIds.add(e.id);
    const formatted = recent.map((e) => `[${e.category}] ${e.key}: ${e.value} (by ${e.agentId})`).join('\n');
    // 临时 — discoveries 可通过 agent_lookup 重新查询
    this._transientReminders.push(
      `<system-reminder>\n🔬 共享发现 (${recent.length} 条):\n${formatted}\n\n用 agent_discover 发布你的发现，agent_lookup 查询全部。\n</system-reminder>`,
    );
  }

  /** 开启全新对话 — 保留 system prompt，清除其他所有内容。 */
  newSession(): void {
    const sys = this.session.length > 0 && this.session[0].role === 'system' ? this.session[0] : null;
    this._replaceSession(sys ? [sys] : [], 'new-session');
    // S4-1b reset 语义：reset 开启新逻辑段——重发**当前生效选择**（重读默认
    // 值），不继承被清掉那个会话的改选（设计件 §2.4 三轮复审裁定：
    // 「reset 开启新段」与「首事件描述新段」是同一条纪律的两面）。
    this.selectPreset(currentPresetId());
    // 新会话 → 折叠状态失效
    this._compactSummary = null;
    this._compactTailStart = -1;
    this._execState.bumpVersion();
    this.cacheHitTotal = 0;
    this.cacheMissTotal = 0;
    this.lastUsage = undefined;
    this.stormSig = '';
    this.stormCount = 0;
    this.compactStuck = false;
    this.compactRetryAfterLen = 0;
    this.compactFailCount = 0;
    this.compactionTracker.reset();
    this._transientReminders = [];
    // token 账本随新会话归零（与 cacheHitTotal/lastUsage 同批——旧账不跨卷）
    this._tokenMeter = requireTokenMeter().createLedger();
    this._tokenMeter.setContextWindow(this.contextWindow);
    this._sink({ kind: EventKind.Notice, level: 'info', text: '已开启新会话' });
  }

  /** 从父会话提取最近的工具结果作为 fork 的上下文。
   *  去除 system prompt、assistant tool_calls，截取最近 N 条消息。
   *  每条消息截断到 1000 字符以保持 fork system prompt 精简。 */
  extractRecentContext(maxMessages: number): string {
    const recent = this.session
      .filter((m) => m.role !== 'system') // 不泄漏父 Agent 的 system prompt
      .slice(-maxMessages);
    if (recent.length === 0) return '(无父Agent上下文)';
    return recent
      .map((m) => {
        const roleLabel =
          m.role === 'assistant' ? '主Agent' : m.role === 'tool' ? `工具结果(${m.name || '?'})` : '用户';
        const MAX = 1000;
        const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        const content = raw.length > MAX ? raw.slice(0, MAX) + '…[截断]' : raw;
        return `[${roleLabel}] ${content}`;
      })
      .join('\n\n');
  }

  /** 运行一轮: 追加用户输入，驱动工具循环。
   *  空输入（bus 唤醒）跳过用户消息 — runLoop
   *  从 _injectInbox() 开始，将 inbox 消息作为唯一输入。 */
  // ── D4 loop 事件监听面（平台化 Phase 1）──
  // 发射点：runLoop 的 turn/step/request 边界 + spawnSubAgent 漏斗（能力域首批）。
  // 无监听器时零开销（ordered() 空集短路）；不改变既有 sink/sessionLog 双轨。
  private readonly _loopEvents = new AgentEventBus();

  /** 监听 loop 生命周期/能力域事件（平台化 Phase 1 · D4 监听面）。目录单一真源 =
   *  agent/events.ts AGENT_EVENT_MAP；载荷形状 = LoopEventPayload；R1 声明 =
   *  非模型可见、不进 session log（见 events.ts 头注）。返回 disposer。 */
  onLoopEvent<E extends LoopEventName>(
    event: E,
    fn: (payload: LoopEventPayload[E]) => void,
    opts?: ListenerOptions,
  ): Disposer {
    return this._loopEvents.onLoopEvent(event, fn, opts);
  }

  async run(signal: AbortSignal, input: string, images?: import('../provider/types').ChatImageRef[]): Promise<void> {
    // 运行记录（认领或自起，见 `_claimRun`）：本轮的「在跑」事实由账上这条记录承担，
    // 收尾只注销自己这条（`end()` 按 id 身份）——`this.isRunning` 也派生于此。
    // 子 Agent（自己那本私账）记 kind='subagent'，会话主 Agent 记 'turn'——读面据种类分策略。
    const myRun = this._claimRun(signal, this._subagentDepth > 0 ? 'subagent' : 'turn');
    // ⚡ 运行看门狗（2026-09-20 landmine L3 拆弹）：硬截止落点 = 本函数的收尾——
    //   哪怕 `runLoop` 挂在「不认 signal 的 await」上永不返回，`deadline` 仍会
    //   以 `RunDeadlineExceededError` 拒绝，本函数的 finally 照常跑完（saveState /
    //   记账注销 / 补唤醒判定）。为什么必须是竞速而不是「在 await 上加超时」：
    //   被挂住的那个 await 属于第三方/适配器内部，我们既改不到它、也无法取消它
    //   ——能做的只有「不等它了」，并让遗留的那条 loop 在栅栏后自我了断。
    const myPulse = new RunPulse({
      runId: this._runIdOf(signal),
      kind: this._subagentDepth > 0 ? 'subagent' : 'turn',
      // 到期动作（顺序要紧）：① 栅栏已由 RunPulse 打上（先于本回调）② abort
      //（既有停止语义，让认 signal 的等待方尽快解旋）③ 记账作废（点名自己的
      // runId —— 绝不误伤后来起的新轮；已被 stopAll 注销 = no-op）。
      onAbandon: (runId, sig) => {
        // abort 的**唯一合法通道是运行账**：signal 由谁铸谁有权中止——本账铸的
        // 走它的 controller；借用的（调用方 beginRun 铸的 / 第三方递进来的）由
        // 它的主人中止，本层不越权。`discardRuns` 正是这条纪律的既有实现
        // （`r.controller?.abort()`），顺带把记录指名作废（绝不误伤后来起的新轮；
        // 已被 stopAll 注销 = no-op）。
        this._execState.discardRuns([runId]);
        // 借用的 signal 主人若无中止路径（第三方驱动面），看门狗这一层不再补刀：
        // 栅栏（已由 RunPulse 打上）+ run() 的硬截止已足以让本轮收场，
        // 强行 abort 一个不属于本层的 signal 是越界（且 AbortSignal 只有
        // controller 能中止，本层拿不到它）。
        if (!sig.aborted) {
          log.warn('agent', '运行看门狗作废：signal 由调用方持有，abort 交由它的主人（本层只打栅栏 + 收场）', {
            runId,
          });
        }
        this._onRunAbandoned(runId, myPulse);
      },
      onWarn: (info) => {
        logWatchdogWarn(info);
        // UI 可见一口：走既有 Notice 通道（warn = 长显提示条），不新造 store。
        this._sink({ kind: EventKind.Notice, level: 'warn', text: watchdogWarnText(info) });
      },
    });
    myPulse.bindSignal(signal);
    // 还没人 await 的 `deadline` 在作废那一刻会拒绝——`Promise.race` 的两条腿里
    // 只有先到的那条被消费，另一条的拒绝若无 handler 会变成 unhandled rejection
    // （进程级噪音，且会被测试台当失败）。这里先挂一个 no-op handler 把它标记为
    // 「已处理」：竞速与 `_abandonedError` 照常拿到拒绝值（handler 只标记，不吞）。
    void myPulse.deadline.catch(() => {});
    this._runFence = myPulse;
    this._ui.onStatusChange?.(true);
    // token 计量：一轮 = 一次用户输入（含空 input 的唤醒轮——它同样会发请求）。
    // 计数点在循环之前，因此本轮所有 step（含重试）都归到同一个轮槽。
    this._turnSeq += 1;
    if (input) {
      // B3（multimodal-image-plan D-1）：附图引用随用户消息入 session（字节
      // 永不进卷）；空文本纯图轮 content 落空串占位。
      this._appendMessage('user/message', {
        role: 'user',
        content: input,
        ...(images !== undefined && images.length > 0 ? { images } : {}),
      });
      // 用户发新消息 → 重置 plan 提醒计数（下一轮注入全量提醒）
      this._planInjector?.resetOnUserInput();
    }
    try {
      // 硬截止竞速：`runLoop` 挂在「不认 signal 的 await」上时，`deadline` 到点
      // 拒绝 ⇒ 本函数 settle（拒绝值 = RunDeadlineExceededError，调用方据类型落
      // 墓碑）。挂住的那条 loop 不会因此复活：栅栏已打（RunPulse.abandoned），
      // 它的迟到 chunk / 工具结果一律不进投影，步骤边界与重试循环顶层也会退出。
      //
      // ⚡ 同一竞速还负责**用户停止**（landmine L3 的「停止钮语义升级」）：停止 =
      //   signal abort，而挂在「不认 signal 的 await」上的 loop 同样收不到 ——
      //   所以停止也必须让 `run()` settle。否则停止只清了账（v43 逃生舱），那条
      //   loop 永留栈上（`_loopDepth > 0`）＝幽灵轮：新轮与它并发、只留一行 log.error。
      //   停止路径的拒绝值仍是 `aborted`（与历史语义、与 chat-core 的静默分支一致）；
      //   作废路径才是具名硬截止错误。
      await Promise.race([this.runLoop(signal), myPulse.deadline, this._settleOnAbort(signal)]);
      // 触发 onSessionPersisted 回调（记忆 bundle 摄取、git 刷新、turn-start 块）
      if (this._onSessionPersisted) {
        try {
          this._onSessionPersisted(this.sessionId, this.session);
        } catch {
          /* 尽力而为 */
        }
      }
    } finally {
      // 异常/中止路径也必须落盘 — runLoop 中途注入的 inbox 消息（result/bg）
      // 此刻只存在于内存 session；saveState 若被 throw 跳过，崩溃时静默丢失。
      // 旧实现 saveState 在 await runLoop 之后，throw 路径直接绕过。
      this.saveState('running').catch(() => {});
      myRun?.end();
      // 作废轮不补唤醒（2026-09-20）：被硬截止作废的那一轮，inbox 里未注入的
      // 消息**留待下次**（用户重发 / 下一条唤醒）——由一条「结果未知」的作废轮
      // 顺手叫起新轮，等于把不知情的后续工作接到一个不知死活的上下文后面。
      // 正常收尾（含用户停止）语义不变。
      if (!myPulse.abandoned) this._wakeIfInboxHasNew(signal);
      myPulse.end();
      // ⚠ 栅栏**刻意不摘**（2026-09-20）：`_runFence` 只在下一轮 `run()` 里被换成
      //   新脉搏——若在这里清空，「作废之后、下一轮开始之前」那段时间里，孤儿
      //   loop 的迟到 append 就又能进卷了（本轮判死的事实不该因为收尾而失效）。
      //   替换语义天然安全：新轮的脉搏 `abandoned=false`，正常写入不受影响。
    }
  }

  /** 停止竞速腿：signal 被中止（用户停止 / 上层级联中止）即拒绝，让 `run()` 在
   *  「loop 挂在认不得 signal 的 await 上」时也能收场（否则 `_loopDepth` 永不清零）。
   *  与 `RunPulse.deadline` 一样先挂 no-op handler：另一条腿先到是常态，
   *  它的拒绝若无 handler 会变成 unhandled rejection。
   *  **拒绝值分流**：已作废（`RunPulse.abandoned`）→ 具名硬截止错误；否则（用户停止
   *  / 上层中止）→ `aborted`，与历史语义、与 chat-core 的「用户停止静默」分支一致。 */
  private _settleOnAbort(signal: AbortSignal): Promise<never> {
    const p = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(isAbandoned(signal) ? this._abandonedError(signal) : new Error('aborted'));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
    p.catch(() => {});
    return p;
  }

  /** 本轮运行号（看门狗日志与作废点名的身份）。认领不到（无主 signal）时
   *  以 -1 上报——诊断面诚实，不编造 id。 */
  private _runIdOf(signal: AbortSignal): number {
    return this._execState.runFor(signal)?.id ?? -1;
  }

  /** 硬截止到期后的可见化（顺序在 `RunPulse` 的栅栏与 abort 之后）：
   *  ① 日志一行（真机取证面：runId / 无进展时长 / 最后脉搏种类）；
   *  ② `run/abandoned` loop 事件（观测面 —— 组合层可据此做策略）；
   *  ③ error 级 Notice → 调用方（chat-core）落墓碑（「结果未知，勿当成功继续」）。 */
  private _onRunAbandoned(runId: number, pulse: RunPulse): void {
    const info = {
      runId,
      kind: pulse.kind,
      noProgressMs: pulse.noProgressMs,
      lastPulse: pulse.lastPulse,
    };
    logWatchdogAbandon(info);
    this._loopEvents.emitLoopEvent('run/abandoned', {
      agentId: this.id,
      runId,
      kind: pulse.kind,
      noProgressMs: pulse.noProgressMs,
      lastPulse: pulse.lastPulse,
    });
    this._sink({ kind: EventKind.Notice, level: 'error', text: watchdogAbandonText(info) });
  }

  /** 本轮被硬截止作废时构造同型错误 —— 三条出口（deadline 竞速 / 重试循环顶层 /
   *  步骤边界）共用同一组事实，调用方只需认 `RunDeadlineExceededError` 一个类型。 */
  private _abandonedError(signal: AbortSignal): RunDeadlineExceededError {
    const p = pulseOf(signal);
    return new RunDeadlineExceededError({
      runId: p?.runId ?? this._runIdOf(signal),
      kind: this._subagentDepth > 0 ? 'subagent' : 'turn',
      noProgressMs: p?.noProgressMs ?? 0,
      lastPulse: p?.lastPulse ?? 'step',
    });
  }

  /** 本轮是否已被看门狗作废（栅栏读法 —— loop 步骤边界与 executor 判据的统一入口）。 */
  isAbandoned(signal: AbortSignal): boolean {
    return isAbandoned(signal);
  }

  /** 记一次脉搏（有进展）。三个天然边界共用：① chunk 到达（streamOnce 的 chunk
   *  循环）② 工具结果落盘（tool/call · tool/result）③ loop 步骤边界（default-loop
   *  每步入场，经 `AgentLoopHost.stepBoundary`）。无登记（未经 `run()` 的驱动面 /
   *  压缩 / 子 Agent 内轮）= no-op。 */
  private _beat(signal: AbortSignal, kind: 'chunk' | 'tool' | 'step'): void {
    beatPulse(signal, kind);
  }

  /** 步骤边界脉搏的宿主面实现（default-loop 每步开头调）—— 顺带做**栅栏拒绝**：
   *  已作废的轮不许再往下走一步（否则它会在 abort 之后又发一次请求、又写一次卷）。 */
  private _stepBoundary(signal: AbortSignal): boolean {
    if (isAbandoned(signal)) return false;
    this._beat(signal, 'step');
    return true;
  }

  /** 收尾后补唤醒（契约 v43 —— 从 default-loop 的 finally 上移到 Agent 侧）：
   *  本轮/本目标**全部收尾之后**，inbox 里若还有「未注入」的消息，再叫一次唤醒入口
   *  （它按运行账的互斥语义决定起不起新轮）。
   *  为什么必须上移：默认 loop 的 finally 先于 `Agent.run()` 返回，在那里
   *  `queueMicrotask(onMessageDelivered)` = 新轮在**旧记录还活着**时被叫醒——
   *  正是「旧轮收尾清掉新轮运行态」那一族的温床。
   *  判据逐字沿用旧实现：已注入但未 ack 的消息不算（否则 request 类消息会让唤醒无限自转）。 */
  private _wakeIfInboxHasNew(signal: AbortSignal): void {
    if (signal.aborted || !this._bus) return;
    const hasNew = this._bus.peekInbox(this.id).some((m) => !this._injectedMsgIds.has(m.id));
    if (hasNew) queueMicrotask(() => void this._onMessageDelivered());
  }

  // ══════════════════════════════════════════════════════
  // Goal 循环 — 自主多轮执行（实现已归产物包 hologram/goal-mode，经登记表取用）
  // ══════════════════════════════════════════════════════

  /** 目标模式不可用时的具名失败原因（feature 语义：插件被禁用/未装载 = 显式降解）。 */
  private static readonly GOAL_MODE_UNAVAILABLE =
    '目标模式不可用：hologram/goal-mode 产物未装载或被禁用（设置 → 插件可重新启用）。';

  /** 自主运行目标: 规划 → 执行 → 验证 → 循环直到 goal_report。
   *  实现经 `agent/goal-impl.ts` 登记表取自产物包（feature 语义：未登记 = 具名失败，
   *  不静默——`/goal` 命令可见原因）。 */
  async runGoal(signal: AbortSignal, goal: string): Promise<GoalRunResult> {
    const run = this._claimRun(signal, 'goal');
    try {
      const impl = activeGoalImplementation();
      if (!impl) return { status: 'failed', summary: Agent.GOAL_MODE_UNAVAILABLE };
      return await impl.runGoal(this as unknown as GoalLoopHost, signal, goal);
    } finally {
      run?.end();
      this._wakeIfInboxHasNew(signal);
    }
  }

  /** 恢复活跃目标（暂停/受阻的，或崩溃遗留的活跃记录）。返回类型与 runGoal 相同。 */
  async resumeGoal(signal: AbortSignal, id?: string): Promise<GoalRunResult> {
    const run = this._claimRun(signal, 'goal');
    try {
      const impl = activeGoalImplementation();
      if (!impl) return { status: 'failed', summary: Agent.GOAL_MODE_UNAVAILABLE };
      return await impl.resumeGoal(this as unknown as GoalLoopHost, signal, id);
    } finally {
      run?.end();
      this._wakeIfInboxHasNew(signal);
    }
  }

  /** 驱动工具循环而不添加用户消息。用于 fork 子 Agent
   *  其会话已以 fork 指令结尾的情况。 */
  private async runLoop(signal: AbortSignal): Promise<void> {
    // D13（平台化 Phase 5）：流式循环降为第一方默认实现（agent/agent-loop/）
    // ——Agent 接口不变；解析 = ctx.agentLoop 注册表后注册胜，缺省 =
    // builtin/default（行为逐字节一致，钉子见包内注释）。
    // ⚡ v43（2026-09-20）：loop 契约不再有 `isRunning` 成员——「在跑」的唯一事实
    // 归运行账（RunRecord），loop 只管跑，不声明自己的运行状态（旧契约的
    // `host.isRunning = true/false` 正是「旧轮收尾清掉新轮」那一族病灶的载体）。
    // 并发闸门（执行面）：loop 深度 = 「同一 Agent 有几条 loop 在栈上」——正常恒为 0/1，
    // 两道并发就会让同一 session 被两条循环同时写。守卫本该在调用面拦住（chat-core /
    // 唤醒入口都有 isRunning 检查），漏了就**留痕**，不当静默并发。
    this._loopDepth += 1;
    if (this._loopDepth > 1) {
      log.error('agent', `并发轮次：Agent ${this.id} 已有 loop 在跑，第二条同时进入（守卫漏网）`, {
        depth: this._loopDepth,
      });
    }
    try {
      await this._loop.run(this._loopHost(), signal);
    } finally {
      this._loopDepth -= 1;
    }
  }

  /** loop 宿主面（D13）——私有成员以闭包暴露给 loop 包（不出类边界；
   *  稳定引用传引用、可变标量 get/set 闭包保活性）。 */
  private _loopHost(): AgentLoopHost {
    const self = this;
    return {
      id: this.id,
      prov: this.prov,
      tools: this.tools,
      hooks: this.hooks,
      preflightHooks: this.preflightHooks,
      preStep: this.preStep,
      isolationId: this._isolationId ?? null,
      planGate: this._planGate,
      loopEvents: this._loopEvents,
      sessionLog: this._sessionLog,
      bus: this._bus,
      injectedMsgIds: this._injectedMsgIds,
      ui: this._ui,
      planState: this._planState,
      planInjector: this._planInjector,
      compactionTracker: this.compactionTracker,
      contextWindow: this.contextWindow,
      // getter 暴露活引用：_applyPendingInserts 重绑 this._pendingInserts，
      // 快照引用会让 loop 的终止检查（pendingInserts.length===0）读到过期
      // 数组——插队消息应用后循环永转（session-differential OOM 根因）。
      get pendingInserts() {
        return self._pendingInserts;
      },
      sink: (ev: AgentEvent) => this._sink(ev),
      appendMessage: (kind, message) => this._appendMessage(kind, message),
      stream: (sig, turn, executor) => this.stream(sig, turn, executor),
      stepBoundary: (sig) => this._stepBoundary(sig),
      abandonedError: (sig) => this._abandonedError(sig),
      isAbandoned: (sig) => isAbandoned(sig),
      tokenCountWithEstimation: () => this.tokenCountWithEstimation(),
      compactNow: (sig) => this.compactNow(sig),
      compactIfNeeded: (sig) => this.compactIfNeeded(sig),
      compactRatioOf: () => this.compactRatio,
      maybeCompact: (usage) => this.maybeCompact(usage),
      stormNudge: (calls, resultsByCallId) => this._stormNudge(calls, resultsByCallId),
      diagTokenBreakdown: (usage) => this._diagTokenBreakdown(usage),
      toolReadOnly: (name) => this.toolReadOnly(name),
      applyPendingInserts: () => this._applyPendingInserts(),
      applyPendingMemoryUpdates: () => this._applyPendingMemoryUpdates(),
      injectInbox: () => this._injectInbox(),
      injectDiscoveries: () => this._injectDiscoveries(),
      onMessageDelivered: () => this._onMessageDelivered(),
      get currentRunSignal() {
        return self._currentRunSignal;
      },
      set currentRunSignal(v) {
        self._currentRunSignal = v;
      },
      get transientReminders() {
        return self._transientReminders;
      },
      set transientReminders(v) {
        self._transientReminders = v;
      },
      get compactStuck() {
        return self.compactStuck;
      },
      get compactRunning() {
        return self.compactRunning;
      },
      get cacheHitTotal() {
        return self.cacheHitTotal;
      },
      set cacheHitTotal(v) {
        self.cacheHitTotal = v;
      },
      get cacheMissTotal() {
        return self.cacheMissTotal;
      },
      set cacheMissTotal(v) {
        self.cacheMissTotal = v;
      },
      get lastUsage() {
        return self.lastUsage;
      },
      set lastUsage(v) {
        self.lastUsage = v;
      },
    };
  }

  // ---- 私有: stream（带重试）----

  private async stream(
    signal: AbortSignal,
    turn: number,
    executor?: StreamingToolExecutor,
  ): Promise<{
    text: string;
    reasoning: string;
    signature: string;
    calls: ToolCall[];
    usage: Usage | undefined;
    err: Error | undefined;
    /** 本次尝试的 token 计量记录（已入账；UI 侧经 Usage 事件收到）。 */
    token: TokenRequestRecord | undefined;
  }> {
    let lastErr: Error | undefined;
    // 总尝试次数（含首次）与首次尝试时刻：挂起走时间预算，重试次数是变量——
    // 收尾文案按**实数**报，不按预算常量报（旧文案写死「已重试 MAX_RETRIES 次」）。
    let attempts = 0;
    const startedAt = Date.now();

    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) {
        executor?.discard();
        // ⚡ 作废轮在**循环顶层**就退出（landmine L3）：被硬截止作废之后，
        //   「再试一次」等于把 abort 当成一次普通的失败又发一轮请求——那条请求
        //   同样会挂住，硬截止就白设了。具名错误上抛（run() 的 deadline 竞速与
        //   这里二选一先到，两条路径同一个错误类型/同一个 runId）。
        if (isAbandoned(signal)) throw this._abandonedError(signal);
        return {
          text: '',
          reasoning: '',
          signature: '',
          calls: [],
          usage: undefined,
          err: new Error('aborted'),
          token: undefined,
        };
      }

      const result = await this.streamOnce(signal, turn, executor);
      attempts++;

      // 成功 — 无错误，或错误已由 streamOnce 作为通知发出
      if (!result.err) return result;

      lastErr = result.err;

      // 响应式压缩: 如果错误是 "prompt too long"，压缩并重试，
      // 无论错误是否通常可重试。
      // 根治: 只有载荷确实接近窗口（>60%）时才响应式压缩 —
      // 错误文本匹配会误判（"400"+"token" 字样即可命中），
      // 低水位下不引发任何动作；也不再自动调低 contextWindow
      // （单次错误不能证明窗口大小，永久砍小会让压缩在荒谬
      // 的阈值反复触发，日志 2026-07-28 已实锤该恶性循环）。
      // 2026-09 迭代：走自动入口（auto 尾部 token 预算 + 摘要成本硬校验），
      // 与 step 前 pre-flight 同语义 —— 错误路径是 provider 已确认溢出，
      // 压缩策略应与自动压力路径一致（DSH context-overflow 同款）。
      const errAt = this.tokenCountWithEstimation();
      if (
        this.isContextLengthError(lastErr) &&
        !this.compactStuck &&
        !this.compactRunning &&
        this.session.length >= this.compactRetryAfterLen &&
        errAt > this.contextWindow * 0.6
      ) {
        log.info('agent', 'reactive compact triggered by context-length error', {
          estimated: errAt,
          ratio: (errAt / this.contextWindow).toFixed(2),
        });
        this._sink({ kind: EventKind.Notice, level: 'warn', text: '上下文过长，自动压缩后重试…' });
        try {
          await this.compactIfNeeded(signal);
          // compactIfNeeded 更新折叠状态（载荷变小）— 跳过退避，立即重试
          continue;
        } catch {
          // compactIfNeeded 失败 — 转入正常重试/中止逻辑
          this._sink({ kind: EventKind.Notice, level: 'warn', text: '自动压缩失败，尝试直接重试…' });
        }
      }

      // ── 图片输入被服务商拒绝 → 记档 + 去图重发（2026-09-19）──
      // 能力戳降级为 UI 提示后（见 streamOnce 附图分支注），代价是可能真撞上
      // 服务商明确的「不收图」拒绝。此时不能按不可重试直接失败：把该模型记进
      // 拒绝集（下次直接投影，不再白撞一次），然后**立即**去图重发一轮——
      // 用户侧表现为自动恢复，而不是「一贴图就报错」。
      // 记档键 = 模型 id：换模型自动重新尝试发图（不把旧模型的拒绝延续过去）。
      // 判据用 this.session 而非本轮 wire 载荷（保守方向）——只要历史含图且
      // 错误形态吻合就降级；降级本身是「不发图 + 明确提示」，不会更糟。
      const errModel = this.prov.model();
      if (
        !this._imageUnsupportedModels.has(errModel) &&
        collectImageRefs(this.session).length > 0 &&
        isImageUnsupportedError(lastErr)
      ) {
        this._imageUnsupportedModels.add(errModel);
        log.warn('agent', 'provider rejected image input — retrying without images', {
          model: errModel,
          error: String(lastErr.message || lastErr),
        });
        this._sink({
          kind: EventKind.Notice,
          level: 'warn',
          text: `模型「${errModel}」不接受图片输入——改用文字占位重发（本会话后续附图将自动转述）`,
        });
        executor?.discard();
        continue;
      }

      // 不可重试的错误不重试
      if (!isRetryable(lastErr)) return result;

      // 重试预算分账（2026-09-12 自愈修复；2026-09-22 加**载荷分账**）：
      //   - 载荷可疑（本轮刚带上 MB 级附图，见 _wireImageChars）= **计数预算**：
      //     挂起走时间预算是为「与载荷无关的出网链路瞬断」设计的；重发同一份大
      //     载荷不会自愈，只会把 6.4MB 图重传 28 次、把 15 分钟耗成「假挂起」
      //     （2026-09-22 实测事故）；
      //   - 流挂起（[响应超时]）= 链路级瞬态，可持续数分钟——走时间预算，
      //     窗口内持续重试，链路恢复即自动继续；
      //   - 其余可重试错误（限流/5xx/繁忙）= 计数预算，不该被无限重试。
      // 判定收在 retry.withinRetryBudget 单点（可单测，不再散在循环里）。
      const stalled = isStallError(lastErr);
      const suspectPayload = stalled && this._wireImageChars >= SUSPECT_PAYLOAD_MIN_WIRE_CHARS;
      if (!withinRetryBudget(lastErr, attempt, Date.now() - startedAt, { suspectPayload })) break;

      // 丢弃失败尝试的所有工具调用
      executor?.discard();

      // 重试前退避：服务商明示 retry-after 时听它的（封顶 30s——用户等不起
      // 60s+ 的干等）；没给才按指数退避猜（2026-08-31 错误码增强）。
      const summary = apiErrorSummary(lastErr);
      const codePart = summary ? `（${summary}）` : '';
      const hinted =
        lastErr instanceof ApiError && lastErr.retryAfter !== undefined
          ? Math.min(lastErr.retryAfter * 1000, 30_000)
          : undefined;
      const delay = hinted ?? backoffDelay(attempt);
      // 进度口径随预算分账：挂起报「已等待 / 上限」（次数无意义），
      // 其余错误报「第 n/N 次重试」；载荷可疑的挂起报「还剩 n 次」。
      const elapsed = Date.now() - startedAt;
      const imageMiB = (this._wireImageChars / 4 / 3 / 1024 / 1024).toFixed(1);
      const progress = suspectPayload
        ? `本轮附图约 ${imageMiB}MiB，服务商无响应——再试 ${SUSPECT_PAYLOAD_MAX_ATTEMPTS - attempt - 1} 次后停止`
        : stalled
          ? `仍未收到服务商数据，已等待 ${formatElapsed(elapsed)} / 上限 ${formatElapsed(STALL_RETRY_BUDGET_MS)}`
          : `第 ${attempt + 1}/${MAX_RETRIES} 次重试`;
      log.info('agent', `stream retry ${attempt + 1} in ${delay}ms`, {
        error: String(lastErr.message || lastErr),
        code: summary || undefined,
        budget: suspectPayload
          ? `suspect-payload:${attempt + 1}/${SUSPECT_PAYLOAD_MAX_ATTEMPTS}`
          : stalled
            ? `stall-time:${formatElapsed(elapsed)}/${formatElapsed(STALL_RETRY_BUDGET_MS)}`
            : `count:${attempt + 1}/${MAX_RETRIES}`,
        elapsed_ms: elapsed,
        wire_image_chars: this._wireImageChars || undefined,
      });
      this._sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: stalled
          ? attempt === 0
            ? // 首条不带计数：它会以卷内贴黄持久留痕（UI 按 STALL_NOTICE_MARK 落卷），
              // 计数写进去必然过期（2026-09-22：6.4s toast 消失后卷面只剩转圈）。
              `${STALL_NOTICE_MARK} 服务商 30 秒内未返回任何数据，已进入自动重试——期间卷面可能只有转圈，可随时停止。`
            : `${STALL_NOTICE_MARK} 服务商仍未返回数据，${(delay / 1000).toFixed(1)}s 后重试（${progress}）…`
          : `模型调用失败${codePart}，${(delay / 1000).toFixed(1)}s 后重试（${progress}）…`,
      });

      const aborted = await sleepWithAbort(delay, signal);
      if (aborted) {
        return {
          text: '',
          reasoning: '',
          signature: '',
          calls: [],
          usage: undefined,
          err: new Error('aborted'),
          token: undefined,
        };
      }
    }

    // 重试已耗尽——墓碑带原始错误码（第二行，pre-line 渲染）。
    // 挂起与非挂起分别给建议：挂起是链路/服务商侧无响应，与本地配置无关，
    // 说清楚「恢复后直接重发」比泛泛的「请检查网络连接和 API 设置」有用。
    // 载荷可疑的挂起再多说一句：这类失败重发同一张图不会变好（2026-09-22 事故）。
    const finalMsg = lastErr?.message || '未知错误';
    const finalCode = apiErrorSummary(lastErr);
    const finalWaited = formatElapsed(Date.now() - startedAt);
    const suspectPayload =
      lastErr !== undefined && isStallError(lastErr) && this._wireImageChars >= SUSPECT_PAYLOAD_MIN_WIRE_CHARS;
    const imageMiB = (this._wireImageChars / 4 / 3 / 1024 / 1024).toFixed(1);
    const hint =
      lastErr && isStallError(lastErr)
        ? suspectPayload
          ? `服务商连续 ${finalWaited} 未返回任何数据（共 ${attempts} 次尝试），已停止重试。本轮请求带约 ${imageMiB}MiB 附图——` +
            '此形态多为**载荷过大/该图服务商消化不了**，重发同一张图不会变好：请压缩图片后重发，或换更小的截图。'
          : `服务商连续 ${finalWaited} 未返回任何数据（共 ${attempts} 次尝试），已停止重试。` +
            '此形态多为出网链路或服务商侧故障，而非本地配置问题——链路恢复后直接重发即可。'
        : `请检查网络连接和 API 设置。`;
    this._sink({
      kind: EventKind.Notice,
      level: 'error',
      text: `模型调用失败（共 ${attempts} 次尝试，历时 ${finalWaited}）：${finalMsg}。${hint}${finalCode ? `\n（${finalCode}）` : ''}`,
    });
    return { text: '', reasoning: '', signature: '', calls: [], usage: undefined, err: lastErr, token: undefined };
  }

  /** 单次流式尝试 — 无重试逻辑。
   *  当提供 executor 时，工具调用立即添加到其中
   *  （在流式过程中开始执行，而非之后）。 */
  private async streamOnce(
    signal: AbortSignal,
    _turn: number,
    executor?: StreamingToolExecutor,
  ): Promise<{
    text: string;
    reasoning: string;
    signature: string;
    calls: ToolCall[];
    usage: Usage | undefined;
    err: Error | undefined;
    token: TokenRequestRecord | undefined;
    /** Responses 方言：本轮 output items 原样留档（见 Message.responses_items）。 */
    responses_items: ResponsesOutputItem[] | undefined;
  }> {
    // 将临时提醒作为 user 消息追加到末尾 — 它们
    // 本轮对 LLM 可见但不持久化到 this.session。
    // 载荷 = 完整历史的折叠视图（若已压缩）+ 临时提醒。
    const transientMsgs: Message[] = this._transientReminders.map((content) => ({
      role: 'user' as const,
      content,
    }));
    const payload = this.payloadMessages();
    // 工具 schema 本请求只解析一次（选择器带锁存，但没必要调两遍）——
    // 请求体与 token 计量共用同一份。
    const toolSchemas = this.requestToolSchemas();
    // ── token 计量（2026-09-13）：请求发出时刻测信封构成 ──
    // 一次分词同时喂两面：本请求的计量记录（构成 + 表面量）与诊断日志
    // （`_diagTokenBreakdown` 读 this._envelope，不再自己重算）。
    const envelope = measureEnvelope([...payload, ...transientMsgs], toolSchemas);
    this._envelope = envelope;
    const fullSession = transientMsgs.length > 0 ? [...payload, ...transientMsgs] : payload;

    // ── 附图发送面（multimodal-image-plan B3 · D-5/D-7/D-8③；2026-09-19 语义变更）──
    // 引用→wire 全部发生在发送边界：session 永持完整引用（INVARIANTS #14）。
    // ⚡ 语义变更（2026-09-19）：**能力戳不再作发送硬闸门**。
    //   旧行为：inputModalities 未声明 image → 直接投影成占位（图根本不发）。
    //   四层声明链末位默认 ['text']，声明缺失 / 过时 / 与实际端点不符时，附图
    //   **静默**送不出去——模型与用户都无从知晓（B3/B5 一族的失效形态）。
    //   新行为：**先发、被拒再降级**。除非本模型已实测拒过图
    //   （_imageUnsupportedModels），一律照发；真被服务商拒了才由 stream() 记档
    //   并去图重发（用户可见的自动恢复）。声明面（inputModalities）就此降级为
    //   **UI 提示**（选择器徽标 / 创作坞门禁），不再参与发送决策——
    //   「猜错了会响」优先于「猜对了省一次请求」。
    //   1. 本模型已实测拒图 → 全部图投影成文本占位（不报错）；
    //   2. 否则请求级预算降级（超限最旧先移除换占位）；
    //   3. 幸存引用经读取器解析成 Request.imageData（缓存键控 id；读取器负责 wire 规整）；
    //   4. 送不出去（无读取通道 / 读盘全失败）→ **响亮降级**：留占位 + 落日志，
    //      绝不静默丢图（2026-09-19 事故：读盘腰漏接线，图三天没到过模型而全链无痕）；
    //   5. **单图 wire 预算**（2026-09-22 读图挂起事故）：解析产物逐条量 base64，
    //      越界者摘除换占位——读取器已按带规整，本闸兜规整失败/别家读取器两条路。
    let wireSession = fullSession;
    let imageData: Request['imageData'];
    // 挂起分账判据先清零：本轮若没有图（或下面各行提前返回/抛错），绝不能沿用上一轮
    // 的体量把「链路瞬态」误判成「载荷可疑」。
    this._wireImageChars = 0;
    if (fullSession.some((m) => (m.images?.length ?? 0) > 0)) {
      if (this._imageUnsupportedModels.has(this.prov.model())) {
        wireSession = projectImagesForTextModel(fullSession);
      } else if (this._imageReader === null) {
        const n = collectImageRefs(fullSession).length;
        log.error('agent', '附图无读取通道（imageReader 未注入——装配漏接线）——本请求图降级为占位', { images: n });
        wireSession = projectImagesUnsent(fullSession, '本会话未接附图读取通道');
      } else {
        wireSession = applyImageBudget(fullSession);
        const wanted = collectImageRefs(wireSession);
        if (wanted.length > 0) {
          imageData = await resolveRequestImageData(wireSession, this._imageReader, this._imageDataCache);
          const missing = wanted.filter((ref) => imageData?.[ref.id] === undefined);
          if (missing.length > 0) {
            log.warn('agent', '附图读取失败——这些图本次不送达', {
              missing: missing.length,
              total: wanted.length,
              ids: missing.map((ref) => ref.id.slice(0, 12)),
            });
            if (missing.length === wanted.length) {
              wireSession = projectImagesUnsent(wireSession, '附图字节读取失败');
              imageData = undefined;
            }
          }
          // ── 单图 wire 预算闸（最后一道）──
          const over = overWireBudgetIds(imageData);
          if (over.size > 0) {
            const facts = wanted
              .filter((ref) => over.has(ref.id))
              .map((ref) => `${ref.width}×${ref.height} ${(ref.bytes / 1024 / 1024).toFixed(1)}MiB`);
            log.warn('agent', '附图超出单图发送预算——这些图本次摘除换占位（不发注定挂起的包）', {
              over: over.size,
              total: wanted.length,
              images: facts.join(' / '),
            });
            this._sink({
              kind: EventKind.Notice,
              level: 'warn',
              text: `附图过大，本次不送模型（${facts.join(' / ')}）——请压缩后重发，或改用更小的截图。`,
            });
            wireSession = dropImagesOverBudget(wireSession, over);
            for (const id of over) delete imageData?.[id];
          }
        }
      }
    }
    // 挂起分账判据：本轮实际带上线的附图体量（0 = 无图 → 挂起仍按链路瞬态处理）。
    this._wireImageChars = wireImageChars(imageData);

    // 流空闲超时：30s 无任何 chunk 视为挂起（与 callSummaryLLM / dataflow NL 解析
    // 共用 streamWithIdleTimeout）。超时 abort 后 sendWithRetry/readSSE 抛 aborted，
    // 此处转为可读的挂起提示——stream() 重试循环对 [响应超时] 走**时间预算**
    // （STALL_RETRY_BUDGET_MS），链路恢复即自动继续（2026-09-12 自愈修复）。
    // 外部 signal 只做转发，不直接传给 stream——避免超时 abort 连累调用方。
    // sanitizeToolPairing 不在此调用 — provider（openai/anthropic）是上线前的最终 gate。
    const stream = streamWithIdleTimeout(this.prov, signal, {
      messages: wireSession,
      tools: toolSchemas,
      temperature: this.temperature,
      // max_tokens 不开放设置 — 0 = provider 默认 32000，发送前按模型目录上限钳制
      max_tokens: 0,
      ...(imageData !== undefined && Object.keys(imageData).length > 0 ? { imageData } : {}),
    });

    let text = '';
    let reasoning = '';
    let signature = '';
    const calls: ToolCall[] = [];
    /** Responses 方言：本轮 output items 原样留档（reasoning 项回放必需）。 */
    let responsesItems: ResponsesOutputItem[] | undefined;
    let usage: Usage | undefined;
    let err: Error | undefined;

    try {
      // ⚡ 流消费与 signal **竞速**（landmine L3 拆弹的第二半：停止要真解旋）：
      //   只让 `run()` 收场还不够——那条 loop 若挂在「不认 signal 的 `for await`」上，
      //   它会永留在栈上（`_loopDepth` 永不清零）＝幽灵轮。竞速把它也拽出来：
      //   signal 一 aborted，这里立刻抛 AbortError，`finally` 清理订阅副作用、
      //   `runLoop` 的 finally 递减深度。**上游那个 await 仍然挂着**（我们改不到
      //   第三方内部），但这里已经不管它了：它的迟到产物由执行器栅栏与投影栅栏
      //   拦下（见 `_appendMessage` / `StreamingToolExecutor.addTool`）。
      const chunks = streamWithAbort(stream.chunks, signal);
      for await (const chunk of chunks) {
        // 脉搏 ①（landmine L3 定义）：**chunk 到达**即「这一轮在动」——每 4 分钟
        // 吐一个 token 的慢模型因此不会被误杀（脉搏定义错了会让慢模型被砍）。
        this._beat(signal, 'chunk');
        switch (chunk.type) {
          case ChunkType.Reasoning:
            reasoning += chunk.text || '';
            if (chunk.signature) signature = chunk.signature;
            if (chunk.text) {
              this._sink({ kind: EventKind.Reasoning, text: chunk.text });
            }
            break;

          case ChunkType.Text:
            text += chunk.text || '';
            this._sink({ kind: EventKind.Text, text: chunk.text });
            break;

          case ChunkType.ToolCallStart:
            if (chunk.tool_call) {
              this._sink({
                kind: EventKind.ToolDispatch,
                tool: {
                  id: chunk.tool_call.id,
                  name: chunk.tool_call.name,
                  args: '',
                  read_only: this.toolReadOnly(chunk.tool_call.name),
                  partial: true,
                },
              });
            }
            break;

          case ChunkType.ToolArgPreview:
            if (chunk.tool_arg_preview) {
              this._sink({
                kind: EventKind.ToolProgress,
                tool: {
                  id: chunk.tool_arg_preview.tool_id,
                  name: chunk.tool_arg_preview.tool_name,
                  output: chunk.tool_arg_preview.content,
                  read_only: true,
                },
              });
            }
            break;

          case ChunkType.ToolCall:
            if (chunk.tool_call) {
              calls.push(chunk.tool_call);
              // 流式执行: 立即启动工具，不等流结束
              executor?.addTool(chunk.tool_call);
            }
            break;

          case ChunkType.ResponsesItems:
            // Responses 方言：本轮 response.output 原样收下（含 reasoning 项的
            // encrypted_content）——下一轮请求必须把它拼回 input，否则带 tools
            // 的请求被服务端拒（见 Message.responses_items）。
            if (chunk.responses_items !== undefined && chunk.responses_items.length > 0) {
              responsesItems = chunk.responses_items;
            }
            break;

          case ChunkType.Usage:
            usage = chunk.usage;
            break;

          case ChunkType.Error:
            err = chunk.err;
            // 落入 Done 以停止迭代
            break;

          case ChunkType.Done:
            break;
        }

        if (err) break;
      }
    } catch (e) {
      const raw = e instanceof Error ? e : new Error(String(e));
      if (stream.idleTimedOut) {
        // 文案纪律（2026-09-12）：空闲守卫只知道「一个 chunk 都没来」，不知道原因
        // ——既可能是连接/首包没建起来，也可能是流中途停吐。措辞必须只说观测事实，
        // 不许写成「模型响应超时」（读起来像模型慢，实测把排查方向带偏了十几分钟）。
        // ⚠️ `[响应超时]` 前缀是分类标记（retry.ts 的 isRetryable / error-catalog
        // 的 TRANSIENT_MARKERS 消费），文案可改、前缀不可改。
        err = new Error(
          `[响应超时] ${STREAM_IDLE_TIMEOUT_MS / 1000} 秒内未收到服务商任何数据（连接未建立或流式输出中途停止），已中止本次请求`,
        );
      } else if (signal.aborted || !isAbortFlavoured(raw)) {
        // ① signal 已中止 = 用户/上层停止（本轮 signal 是唯一权威判据，不读错误文本）；
        // ② 与中止无关的普通失败 = 原样上抛交重试分类。
        err = raw;
      } else {
        // 非用户中止的「中止族」失败（2026-09-14）：流被平台/链路切断
        // （`BodyStreamBuffer was aborted`、`<provider>: aborted`）。
        // 旧实现把这形态当成用户按了停止（isRetryable 的 msg.includes('aborted')）
        // ——不重试 + 不落墓碑 + 静默吞掉，案卷里只剩一条悬空来文。
        // 现按链路级瞬态处理：可重试（计数预算），重试耗尽则落可见墓碑。
        err = new Error(`${INTERRUPTED_MARKER} 流式传输被切断（${raw.message}），非用户中止`);
      }
    }

    // ── token 计量入账（2026-09-13）：每次尝试一条，成败都记 ──
    // 失败尝试同样计入 attempts 与轮内步数（它确实发了出去），只是无账单——
    // 把失败从步数里抹掉会让「本轮几步」与实况对不上（DSH 同判：重试各自
    // 构成一次可计费尝试）。
    const token: TokenRequestRecord = {
      turn: this._turnSeq,
      step: _turn,
      breakdown: envelope.breakdown,
      surfaceTokens: envelope.surfaceTokens,
      contextWindow: this.contextWindow,
      ...(usage === undefined ? {} : { usage }),
    };
    this._tokenMeter.recordRequest(token);

    if (err) {
      // 2026-08-31 贴黄拆迁 + 墓碑语义：单次尝试失败不落墓碑（回合可能自动重试
      // 成功——墓碑残留会把完成的回合标成 error）。降为 warn 瞬时播报；
      // 最终结局由 stream() 收口：重试耗尽 sink error（→ 回合墓碑）或不可重试
      // 路径返回 err 由上层处理/UI catch 落墓碑。
      this._sink({ kind: EventKind.Notice, level: 'warn', text: `模型调用失败: ${err.message || err}` });
      // 交还已收集的 calls（不清空）：流失败时 executor 可能已实时执行部分工具
      // （资产生成等有副作用工具），default-loop 需要真实的 calls 才能把已执行
      // 的结果补 append 进上下文——否则 UI 已渲染、上下文无记录，Agent 下一轮
      // 会重复执行同一任务（会话 225 事故根因：流内错误丢资产生成结果）。
      return { text, reasoning, signature, calls, usage, err, token, responses_items: responsesItems };
    }

    // 关闭文本流
    if (text || reasoning) {
      this._sink({ kind: EventKind.Message, text, reasoning });
    }

    return { text, reasoning, signature, calls, usage, err: undefined, token, responses_items: responsesItems };
  }

  // ---- Storm breaker — 打断重复工具调用循环 ----

  /** 检测重复相同的工具调用失败。返回追加到第一个工具结果的提示字符串，
   *  或 null。Storm 状态（stormSig/stormCount）在压缩/newSession 时重置；
   *  一批调用中任何成功调用也会重置。 */
  private _stormNudge(
    calls: ToolCall[],
    resultsByCallId: Map<string, { output: string; err?: string }>,
  ): string | null {
    const outcomes: ToolOutcome[] = calls.map((c) => {
      const r = resultsByCallId.get(c.id);
      const output = r?.output ?? '';
      return {
        output,
        errMsg: r?.err,
        blocked: output.includes('架构门禁已阻止'),
        truncated: false,
      };
    });
    const { sig, ok } = batchStormSignature(calls, outcomes);
    if (!ok) {
      this.stormSig = '';
      this.stormCount = 0;
      return null;
    }
    if (sig !== this.stormSig) {
      this.stormSig = sig;
      this.stormCount = 1;
      return null;
    }
    this.stormCount++;
    if (this.stormCount < STORM_BREAK_THRESHOLD) return null;

    const subject = calls.length === 1 ? `"${calls[0].name}"` : `this batch of ${calls.length} tool calls`;
    const short = calls.length === 1 ? calls[0].name : `a batch of ${calls.length} calls`;

    this._sink({
      kind: EventKind.Notice,
      level: 'warn',
      text: `loop guard: ${short} failed ${this.stormCount}× the same way — nudging the model to change approach`,
    });

    return `\n\n[loop guard] ${subject} has now failed ${this.stormCount} times in a row with the same error. Re-sending it will not help. Change approach: if an argument is being truncated, write less in one call and split the work; otherwise fix the arguments, use a different tool, or explain the blocker in your final answer.`;
  }

  // ---- 上下文窗口管理 ----

  compactRunning = false;
  // ⚡ sessionGen migrated to ExecutionState.sessionVersion

  /** 使用 cl100k_base tokenizer 精确计算 token 数。
   *  替代旧的 chars/2.5 启发式（误差 30-60%）。
   *  Cl100k_base 匹配 GPT-4、DeepSeek 和大多数 OpenAI 兼容模型。
   *  Anthropic 的 tokenizer 略有差异（< 8% 误差），对压缩安全。
   *  按发送载荷（payloadMessages 折叠视图）计数 — 触发判定必须
   *  与真实 API 压力一致，而非完整历史大小。 */
  /** 每轮发给模型的工具 schema：默认全量（limit=0），保持 tools 段逐字节稳定，
   *  DeepSeek 前缀缓存才能跨用户消息命中；limit>0 时按上下文打分注入子集
   *  （见 tool-select.ts）。打分子集的稳定性契约：只由 user 消息驱动、带锁存——
   *  同一用户请求的整个工具循环内逐字节一致，但跨请求仍会漂移击穿缓存。 */
  private _schemaSelector: StableSchemaSelector = createStableSchemaSelector();

  private requestToolSchemas(): ToolSchema[] {
    return this._schemaSelector.select(this.tools, this._visibleToolsLimit, userContext(this.session));
  }

  private tokenCountWithEstimation(): number {
    const payload = this.payloadMessages();
    let total = countMessages(payload);
    // 附图视觉 token（2026-09-22 补账）：文本分词器看不见图——不计这一项，
    // 有图时的压力判定（step 前 pre-flight / 响应式压缩 / 压缩埋点）全部少算。
    total += countImageTokens(payload).tokens;
    // 计算临时提醒 token — 发送给 LLM 但不在会话中
    total += countTexts(this._transientReminders);
    // 计算工具 schema token — 每次请求都发送
    total += countToolSchemas(this.requestToolSchemas());
    // 载荷估算入库（projected 占用的表面基准）：本方法是所有压力判定的
    // 必经之路（step 前 pre-flight / 响应式压缩 / 压缩埋点），在此顺手刷新
    // 表面量 = 零额外开销的计量面更新（不重复分词）。
    this._tokenMeter.recordSurface(total);
    return total;
  }

  /** 诊断: 按组件分解 token 消耗。
   *  每轮后以结构化 NDJSON 记录到 .lantai/logs/ui.log。
   *  过滤: jq 'select(.module=="agent" and .message=="token breakdown") | .ctx'
   *
   *  2026-09-13：分词改为与 token-meter 共用**同一次**信封测量
   *  （streamOnce 请求前测的 this._envelope）——此前诊断自己再分词一遍
   *  整个载荷+全量 schema，每请求双份开销。 */
  private _diagTokenBreakdown(apiUsage: Usage | undefined): void {
    try {
      const env =
        this._envelope ?? measureEnvelope(this.payloadMessages(), this.requestToolSchemas(), this._transientReminders);

      const diag = {
        turn_session_msgs: env.messageCount,
        history_msgs: this.session.length,
        // ── 成本中心 ──
        system_prompt: { tokens: env.breakdown.systemTokens, msgs: env.systemMessages },
        user_real: { tokens: env.userTokens, msgs: env.userMessages },
        reminders: { tokens: env.reminderTokens, msgs: env.reminderMessages, inbox: env.inboxReminders },
        transient_reminders: { tokens: env.transientTokens, msgs: this._transientReminders.length },
        assistant: { tokens: env.assistantTokens, msgs: env.assistantMessages },
        tool_results: { tokens: env.toolResultTokens, msgs: env.toolResultMessages },
        // 附图细目（2026-09-22）：已并入 messageTokens（对话段），此处单列以便
        // 与 api_reported 对账——「差额」是这条口径的探针（见下 api_delta）。
        images: { tokens: env.imageTokens, count: env.imageCount },
        tool_schemas: { tokens: env.breakdown.toolsTokens, count: env.schemaCount },
        folded_tool_results: Math.min(this._toolFoldBoundary, env.toolResultMessages),
        // ── 汇总 ──
        estimated_total: env.surfaceTokens,
        api_reported: apiUsage
          ? { prompt: apiUsage.prompt_tokens, completion: apiUsage.completion_tokens, total: apiUsage.total_tokens }
          : null,
        // 本地估算 − 提供方回报（正 = 估高）。持续非零即说明构成口径该校（例如换到
        // 非 DeepSeek 血统的视觉路由：图价网格不再成立）；有图那几轮尤其要看它。
        api_delta: apiUsage ? env.surfaceTokens - apiUsage.prompt_tokens : null,
        cache: apiUsage ? { hit: apiUsage.cache_hit_tokens, miss: apiUsage.cache_miss_tokens } : null,
      };

      log.info('agent', 'token breakdown', diag);
    } catch {
      /* 诊断绝不抛异常 */
    }
  }

  /** 检查错误是否为上下文长度超限。 */
  private isContextLengthError(err: Error): boolean {
    const msg = (err.message || String(err)).toLowerCase();
    // 完成预算错误（"Invalid max_tokens value…"）是请求参数 bug，
    // 不是 prompt 溢出 — 压缩 prompt 无法修复它们，
    // 误分类会导致每次输入都陷入 compact→retry→400 循环。
    if (msg.includes('max_tokens') || msg.includes('max_output_tokens')) return false;
    return (
      msg.includes('prompt is too long') ||
      msg.includes('context length') ||
      msg.includes('too many tokens') ||
      msg.includes('maximum context') ||
      msg.includes('reduce the length') ||
      msg.includes('token limit') ||
      (msg.includes('400') && (msg.includes('token') || msg.includes('context') || msg.includes('prompt')))
    );
  }

  // ── 折叠视图 + 压缩状态机（实现已迁 agent-compaction.ts，宿主接口委托）──

  /** session 头部偏移: 若第一条是 system prompt 则为 1，否则为 0。 */
  _foldHead(): number {
    return requireCompactionImplementation().foldHead(this as unknown as CompactionHost);
  }

  /** 发送给 LLM 的载荷 — 完整历史 + 压缩折叠 + 工具结果滚动折叠。 */
  payloadMessages(): Message[] {
    return requireCompactionImplementation().payloadMessages(this as unknown as CompactionHost);
  }

  /** 计算本次要折叠的中间区域。返回 null = 无可折叠内容（stuck）。 */
  computeCompactRegion(): { region: Message[]; tailStart: number; priorSummary: string | null } | null {
    return requireCompactionImplementation().computeCompactRegion(this as unknown as CompactionHost);
  }

  /** 手动压缩触发器（来自 /compact 命令）。返回摘要文本或错误。 */
  async compactNow(signal: AbortSignal): Promise<string> {
    return requireCompactionImplementation().compactNow(this as unknown as CompactionHost, signal);
  }

  /** 自动压缩入口（step 前 pre-flight 调用）— 尾部按 retainRatio token 预算
   *  保留完整 user 回合（DSH 自动压力路径语义）。返回摘要文本或 'stuck'。 */
  async compactIfNeeded(signal: AbortSignal): Promise<string> {
    return requireCompactionImplementation().compactIfNeeded(this as unknown as CompactionHost, signal);
  }

  maybeCompact(usage: Usage | undefined): void {
    requireCompactionImplementation().maybeCompact(this as unknown as CompactionHost, usage);
  }

  /** 对消息区域生成摘要 — map-reduce 分块管线（测试经 as any 调用）。 */
  async summarizeRegion(signal: AbortSignal, msgs: Message[], priorSummary: string | null = null): Promise<SummaryRun> {
    return requireCompactionImplementation().summarizeRegion(
      this as unknown as CompactionHost,
      signal,
      msgs,
      priorSummary,
    );
  }

  /** 摘要模型解析 — 固定主模型（价格表拆除后摘要不再跨家比价）。 */
  async summaryProvider(): Promise<{ prov: Provider; window: number }> {
    return requireCompactionImplementation().summaryProvider(this as unknown as CompactionHost);
  }

  /** 单次摘要 LLM 调用 — 空闲超时守卫；返回文本 + 发出的 cap + 提供方 usage。
   *  形状由调用方声明：回放口径发「真前缀 + 指令」（+ 与主请求同一份 tools）。 */
  async callSummaryLLM(
    signal: AbortSignal,
    messages: Message[],
    shape: { replay: boolean; tools?: ToolSchema[] } = { replay: false },
  ): Promise<SummaryCall> {
    return requireCompactionImplementation().callSummaryLLM(this as unknown as CompactionHost, signal, messages, shape);
  }

  /** 滚动合并分段摘要（含 priorSummary）。 */
  async mergePartials(
    signal: AbortSignal,
    priorSummary: string | null,
    partials: string[],
    budgetTokens: number,
  ): Promise<SummaryRun> {
    return requireCompactionImplementation().mergePartials(
      this as unknown as CompactionHost,
      signal,
      priorSummary,
      partials,
      budgetTokens,
    );
  }

  private toolReadOnly(name: string): boolean {
    return this.tools.get(name)?.readOnly() ?? false;
  }

  // ══════════════════════════════════════════════════════
  // 子 Agent 派生 — 用于并行/委派工作
  // ══════════════════════════════════════════════════════

  /** 派生子 Agent 处理聚焦任务。阻塞直到子 Agent 完成；
   *  子 Agent 的最终报告（加合并备注）成为工具结果。
   *  消费面 = ctx.subagents 注册表（平台化 Phase 1 · D3）——后注册胜取默认
   *  provider；默认 in-process 实现逐字节透传进程内实现（见
   *  agent/subagent-provider.ts），完整语义仍见其文档。 */
  async spawnSubAgent(
    description: string,
    prompt: string,
    onProgress?: (chunk: string) => void,
    mode: 'fork' | 'fresh' = 'fork',
    toolAllowlist?: string[] | null,
    poolSignal?: AbortSignal,
    asyncMode?: boolean,
    agentIdOverride?: string,
    outputSchema?: Record<string, unknown> | null,
  ): Promise<{ text: string; err?: string }> {
    const providers = activeSubagentProviders(this._composition?.seamDisabled);
    const provider = providers[providers.length - 1];
    if (!provider) {
      throw new Error(
        'SUBAGENT_PROVIDER: 无已注册子代理 provider——请确认 subagents 通道装配（生产 = loadBuiltinPlugins）',
      );
    }
    this._loopEvents.emitLoopEvent('subagent/spawn', {
      parentId: this.id,
      agentId: agentIdOverride ?? null,
      mode,
      async: asyncMode ?? false,
    });
    try {
      const outcome = await provider.spawn(this as unknown as SubAgentSpawnHost, {
        description,
        prompt,
        onProgress,
        mode,
        toolAllowlist,
        poolSignal,
        asyncMode,
        agentIdOverride,
        outputSchema,
      });
      this._loopEvents.emitLoopEvent('subagent/done', {
        parentId: this.id,
        agentId: agentIdOverride ?? null,
        ok: !outcome.err,
        async: asyncMode ?? false,
      });
      return outcome;
    } catch (e) {
      this._loopEvents.emitLoopEvent('subagent/done', {
        parentId: this.id,
        agentId: agentIdOverride ?? null,
        ok: false,
        async: asyncMode ?? false,
      });
      throw e;
    }
  }
}

// 隔离合并/丢弃的序列化在 isolation-queue.ts 中
// （与 merge.ts 共享 — 并发 git 操作会争抢 index lock）。
