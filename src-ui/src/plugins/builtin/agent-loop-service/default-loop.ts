// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 默认 agent loop（平台化 Phase 5 · D13，2026-08-28）——Agent 流式循环的
// 第一方默认实现。机械迁移自 agent.ts runLoop（行为逐字节一致）：
//   - `this.X` → `host.X`（宿主面 = AgentLoopHost，由 Agent._loopHost()
//     以闭包构建——私有成员不出类，活性由引用/get·set 闭包保证）；
//   - 模块级依赖（typedRpcWithTimeout / EventKind / StreamingToolExecutor /
//     finishReasonMessage / resolveGuardToolName / parseFilePathArg / log）
//     经包内宿主桥 `./host` 取用；
//   - 行为钉子：convergence phase-5 session-projection trace + phase-2
//     trace fixture + 全量 agent 测试组（turn/step/request 事件序、
//     session 溯源、压缩埋点、storm breaker 语义不变）。
//
// 替换契约：ctx.agentLoop 注册表后注册胜——替换实现只需满足 AgentLoop
// 接口（拿到同一宿主面即可接管全生命周期）。
//
// 批 9h-2（2026-09-26）：本件随 `agent-loop-service` 产物包（原
// `agent/agent-loop/default-loop.ts` 整件搬移）——注册表（`AgentLoopService`）
// 与本实现在同包；内核 `agent-loop-active.ts` 只留活动面 + `resolveAgentLoop()`
// 查表（无服务 = 具名 fail-loud，内核不再持有兜底实现）。

import {
  type AgentEvent,
  type AgentLoop,
  type AgentLoopHost,
  EventKind,
  finishReasonMessage,
  kernelReadFile,
  log,
  parseFilePathArg,
  resolveGuardToolName,
  StreamingToolExecutor,
  typedRpcWithTimeout,
} from './host';

/** 默认实现寻址 id（ctx.agentLoop 注册表；后注册的替换实现胜出）。 */
export const DEFAULT_AGENT_LOOP_ID = 'builtin/default';

/** 每步 best-effort RPC 的超时兜底。本地 sqlite/文件读取正常毫秒级；
 *  3s 只在 Rust 侧卡死或回包丢失时触发——落回各自的跳过分支，
 *  循环不死等在无界 await 上（run() 永不 settle = UI 永卡运行态）。 */
const STEP_RPC_TIMEOUT_MS = 3_000;

/** promise 超时兜底（fs 域收口后 kernelReadFile 等 helper 直呼不经
 *  typedRpcWithTimeout——需保持超时的调用点本地包一层）。超时后底层
 *  promise 仍可能在途：调用方须保证超时分支的跳过是安全的（同
 *  typedRpcWithTimeout 语义）。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 默认 agent loop（出厂实现——AgentOptions 缺省 + ctx.agentLoop 构造期登记）。 */
export const defaultAgentLoop: AgentLoop = {
  id: DEFAULT_AGENT_LOOP_ID,
  run: runDefaultLoop,
};

export async function runDefaultLoop(host: AgentLoopHost, signal: AbortSignal): Promise<void> {
  const turnStart = performance.now();
  let turnErr: unknown = null;

  try {
    host.currentRunSignal = signal; // 子 Agent 派生时合并此 signal 用于级联中止
    host.sink({ kind: EventKind.TurnStarted });
    // Phase 5：轮次边界事件（无消息投影 — 回放/审计用）
    host.sessionLog.append('turn/start', { provider: host.prov.name(), model: host.prov.model() });
    // D4：turn/start 监听面广播（可观测，非模型可见——见 events.ts R1 声明）
    host.loopEvents.emitLoopEvent('turn/start', {
      agentId: host.id,
      provider: host.prov.name(),
      model: host.prov.model(),
    });

    for (let step = 0; ; step++) {
      // ── 步骤边界：脉搏 + 栅栏（契约 v44，landmine L3 拆弹）──
      // 一次调用两件事：记一次「无进展看门狗」的脉搏（步骤边界是天然脉搏点），
      // 并裁决本轮是否已被硬截止作废。返回 false = **必须立刻停步**：那一轮已经被
      // 判死（看门狗已 abort + 记账作废），再走一步就是又发一次注定挂住的请求、
      // 又往卷里写一次没人要的事实。具名错误照抛——调用方（Agent.run 的 finally /
      // 上层 catch）认的是 RunDeadlineExceededError 这个类型，不是文案。
      if (!host.stepBoundary(signal)) throw host.abandonedError(signal);

      // ── 步前裁决（agent-hooks-plan 一期）——enter 放行（可附注入批）/ reject
      //    拦下本步（不开步、不发请求，本轮收尾）。未接面 / 无注册者 = 直通
      //    enter——空表不进异步调用，**连同步时序都零变化**。
      const preStepDecision =
        host.preStep && host.preStep.size > 0 ? await host.preStep.decide({ agentId: host.id, step, signal }) : null;
      if (preStepDecision?.action === 'reject') {
        host.sink({
          kind: EventKind.Notice,
          level: 'warn',
          text: preStepDecision.reason
            ? `本步被钩子拦下（未发送请求）：${preStepDecision.reason}`
            : '本步被钩子拦下（未发送请求）',
        });
        return; // 本轮收尾（turn/end 在 finally 照发；不开步、不记录 step/start）
      }

      host.loopEvents.emitLoopEvent('step/start', { agentId: host.id, step });
      // 清除上一步的临时提醒 — 提醒只应对本轮 LLM 可见。
      host.transientReminders = [];

      // Plan 模式提醒注入 — 去重逻辑在 PlanModeInjector 内部
      if (host.planState && host.planInjector) {
        let planContent = '';
        if (host.planState.state.active && host.planState.state.planFilePath) {
          try {
            // fs 域收口（kernel-capability-c3-design.md）：plan 文件读取从
            // tool_call 信封（builtin.fs.read_file_content）换 kernelReadFile
            // 直呼（fs_cap read，用户路径 is_agent=false）。超时兜底保留——
            // 读卡死只丢 plan 提醒不拖 run（本段 try/catch 已兜 skip）。
            const raw = await withTimeout(
              kernelReadFile(host.planState.state.planFilePath),
              STEP_RPC_TIMEOUT_MS,
              'plan 文件读取超时',
            );
            planContent = raw;
          } catch {
            /* plan 文件尚未写入 — 正常 */
          }
        }
        const reminder = host.planInjector.getReminder(step, host.planState.state, planContent);
        if (reminder) {
          host.transientReminders = [...host.transientReminders, `<system-reminder>\n${reminder}\n</system-reminder>`];
        }
      }

      // 中止检查 — signal 覆盖用户停止 + 会话替换（通过 execState.stop）
      if (signal.aborted) throw new Error('aborted');

      // 在安全边界应用待插入的用户消息（工具结果提交后）
      host.applyPendingInserts();
      host.applyPendingMemoryUpdates();

      host.ui.progress?.(step + 1, 'thinking');

      // 在每次 stream() 调用前排空后台任务通知（临时 —
      // 轮次结束后进度更新无价值）。按 agent_id 路由排干：全局排干会把
      // 其他 agent（含并行子 Agent）的后台任务通知吸进本 agent 上下文。
      try {
        // R3-d 信封退役：drain_bg_notifications 经 process_cap 能力口直呼
        const notes = await typedRpcWithTimeout(
          'process_cap',
          { action: 'drain_bg_notifications', agent_id: host.id },
          STEP_RPC_TIMEOUT_MS,
        );
        if (notes) {
          host.transientReminders = [...host.transientReminders, `<system-reminder>\n${notes}\n</system-reminder>`];
        }
      } catch {
        // 尽力而为 — 排空失败不阻塞循环
      }

      // 注入未读 inbox 消息（窥探 — 不消费）
      host.injectInbox();

      // 注入其他 Agent 的新发现
      host.injectDiscoveries();

      // ── 步前裁决的注入批（agent-hooks-plan 一期）——enter 时钩子贡献的消息
      //    作为落会话的 user/message 追加（durable；content 原样，贡献者自备
      //    文本形态）。位置 = 本步现有注入链之后、压缩预检之前。
      if (preStepDecision?.action === 'enter' && preStepDecision.messages && preStepDecision.messages.length > 0) {
        for (const m of preStepDecision.messages) {
          host.appendMessage('user/message', { role: 'user', content: m.content });
        }
      }

      // ── 预检上下文窗口（自动压缩主触发点，2026-09 迭代）──
      // 每 step 发送前用估算检查载荷压力；≥ compactRatio(默认 0.8，随模型
      // 窗口缩放) 即**同步**压缩后再发请求 —— 绝不带超压载荷上路。
      // 取代旧的「轮末异步 maybeCompact(0.55) + step 前 0.88 兜底」双线：
      // 轮末异步压完下一轮又涨回去（工具密集轮），且 0.55 在 DeepSeek 前缀
      // 缓存计价下压的是最便宜的活跃中段、净亏；0.8 + 发送前同步把触发
      // 收紧到压力真高、压缩有净收益的时刻（对齐 DSH thresholdRatio 0.8）。
      // 没有此检查，大量工具结果 + 注入会在下一轮导致 400 错误。
      if (host.contextWindow > 0) {
        const preFlight = host.tokenCountWithEstimation();
        const preFlightRatio = preFlight / host.contextWindow;
        if (preFlightRatio >= host.compactRatioOf()) {
          if (host.compactStuck) {
            log.warn('agent', 'pre-flight skipped: compact stuck', {
              estimated: preFlight,
              ratio: preFlightRatio.toFixed(2),
            });
            host.sink({
              kind: EventKind.Notice,
              level: 'warn',
              text: `上下文使用率 ${(preFlightRatio * 100).toFixed(0)}%，但压缩已卡住。建议 /new。`,
            });
          } else if (host.compactRunning) {
            log.info('agent', 'pre-flight skipped: compact already running', {
              estimated: preFlight,
              ratio: preFlightRatio.toFixed(2),
            });
          } else {
            log.info('agent', 'pre-flight compaction triggered', {
              estimated: preFlight,
              ratio: preFlightRatio.toFixed(2),
              contextWindow: host.contextWindow,
            });
            host.sink({
              kind: EventKind.Notice,
              level: 'warn',
              text: `上下文使用率 ${(preFlightRatio * 100).toFixed(0)}%，发送前压缩…`,
            });
            try {
              const outcome = await host.compactIfNeeded(signal);
              if (outcome === 'stuck') {
                host.sink({
                  kind: EventKind.Notice,
                  level: 'warn',
                  text: '压缩无法减少上下文——消息太少。建议 /new。',
                });
              }
            } catch {
              // compactIfNeeded 已发出自身错误 — 继续让 API 错误处理器
              // （stream 中的响应式压缩）捕获
              log.warn('agent', 'pre-flight compaction failed, falling through to API call');
            }
          }
        }
      }

      // ---- Stream（带流式工具执行器 + hooks）----
      host.compactionTracker.recordTurn();
      // 平台化 Phase 5：executor 收 eventBus（host.loopEvents）——planGate/
      // preflight/hooks 经 tool/guard·preflight·around 监听面运行（Agent
      // 构造期 attach* 接线），eventBus 是唯一管道。
      const executor = new StreamingToolExecutor(
        host.tools,
        (ev: AgentEvent) => host.sink(ev),
        host.isolationId,
        signal,
        host.loopEvents,
        // 通知路由身份（bus id）— bg job owner / bash_kill 所有权（executor 注入 _owner_id）
        host.id,
        // 工具副作用前检查点（换轨触发点 B）：**先把「模型宣布了这个调用」落进日志、
        // 再把队列推到盘上**，然后才让工具体落地副作用。
        //
        // 为什么宣布要先落（2026-09-15 用户批准 phase-5 基线变更后落地）：兰台的
        // 流式执行器在**流期间**就跑工具，而 assistant 消息（含 tool_calls）是流收尾
        // 才落的——不在这里补落，崩溃后恢复链看不到「已分发但无结果」的调用，
        // 模型会以为那次副作用从未发生（正是 docs/session-checkpoint-design.md §3.2
        // 点名的「工具副作用窗口」）。`tool/call` 无消息投影，故 deriveMessages 不变；
        // 事件序列因此变化（tool/call 前移到 assistant/text 之前）——已走
        // baseline-change-request 审批并重录两轨基线。
        // 失败语义：执行器内 fail-open + warn（磁盘故障不锁死工具链）。
        async (call) => {
          // 遗弃栅栏（v44）：已作废的一轮不该再产生新事实——连「模型宣布过它」
          // 这条审计补落也停（executor.addTool 侧同时拦执行，两处同一把钥匙）。
          if (host.isAbandoned(signal)) return;
          host.sessionLog.append('tool/call', { call });
          await host.sessionLog.flushPersistence();
        },
      );
      host.loopEvents.emitLoopEvent('request/start', {
        agentId: host.id,
        step: step + 1,
        provider: host.prov.name(),
        model: host.prov.model(),
      });
      let { text, reasoning, signature, calls, usage, err, token, responses_items } = await host.stream(
        signal,
        step + 1,
        executor,
      );
      host.loopEvents.emitLoopEvent('request/end', {
        agentId: host.id,
        step: step + 1,
        totalTokens: usage?.total_tokens ?? null,
        err: err ? String(err.message || err) : null,
      });
      if (err) {
        log.error('agent', 'stream error', { error: String(err.message || err) });
        // 流中途失败：executor 已实时执行了部分工具（资产生成等有副作用工具），
        // 其结果必须落进上下文——否则 UI 已渲染、session 无记录，Agent 下一轮
        // 会重复执行同一任务（会话 225 事故根因：流内错误丢资产生成结果）。
        // 先把已分发的工具调用与结果补 append 进 session，再抛 err 交上层处理。
        if (calls.length > 0) {
          log.info('agent', 'stream error: preserving executed tool results', {
            calls: calls.map((c) => c.name),
            error: String(err.message || err),
          });
          host.appendMessage('assistant/text', {
            role: 'assistant',
            content: text,
            reasoning_content: reasoning,
            reasoning_signature: signature,
            tool_calls: calls,
            ...(responses_items === undefined || responses_items.length === 0 ? {} : { responses_items }),
          });
          // 注：`tool/call` 审计事件已由执行器在**分发时**落（触发点 B 的宣布补落），
          // 此处不再重复追加——单一写入点，避免同一次调用两条记录。
          const pendingResults = await executor.awaitRemaining();
          const resultsByCallId = new Map(pendingResults.map((r) => [r.call.id, r]));
          for (const call of calls) {
            const r = resultsByCallId.get(call.id);
            const content = r
              ? r.output || `(工具 ${call.name} 执行成功，无输出)`
              : `error: tool "${call.name}" did not produce a result`;
            host.appendMessage('tool/result', {
              role: 'tool',
              content,
              tool_call_id: call.id,
              name: call.name,
              ...(r?.images && r.images.length > 0 ? { images: r.images } : {}),
            });
          }
        }
        throw err;
      }

      if (usage && usage.total_tokens > 0) {
        log.info('agent', 'llm response', {
          turn: step + 1,
          // 2026-09-12 拆碑：此处曾把 provider 名填进 `model` 字段——日志读起来
          // 像「模型 = commandcodegoat」，实际那是提供方身份。两字段分开报。
          provider: host.prov.name(),
          model: host.prov.model(),
          finish_reason: usage.finish_reason,
          total_tokens: usage.total_tokens,
          prompt_tokens: usage.prompt_tokens,
          cache_hit_tokens: usage.cache_hit_tokens,
          cache_miss_tokens: usage.cache_miss_tokens,
          cache_creation_tokens: usage.cache_creation_tokens,
          completion_tokens: usage.completion_tokens,
          reasoning_tokens: usage.reasoning_tokens,
          elapsed_ms: Math.round(performance.now() - turnStart),
        });
        host.diagTokenBreakdown(usage);
        host.cacheHitTotal += usage.cache_hit_tokens;
        host.cacheMissTotal += usage.cache_miss_tokens;
        host.lastUsage = usage;
        host.sink({
          kind: EventKind.Usage,
          usage,
          session_hit: host.cacheHitTotal,
          session_miss: host.cacheMissTotal,
          // token 计量记录随用量事件一并发往 UI（Agent 侧账本为真源，
          // 这里是它的投影面；无 token 时 UI 侧计量面不更新）。
          ...(token === undefined ? {} : { token }),
        });
      }

      // 异常完成原因告警
      const warnMsg = finishReasonMessage(usage);
      if (warnMsg) {
        host.sink({ kind: EventKind.Notice, level: 'warn', text: warnMsg });
      }

      // 保护: DeepSeek 拒绝既无 content 也无 tool_calls 的 assistant 消息。
      if (!text && calls.length === 0) {
        if (host.pendingInserts.length > 0 || reasoning) {
          text = reasoning ? '(思考完成)' : '(等待中)';
        } else {
          log.warn('agent', 'empty assistant turn — skipping push to avoid API 400');
          host.sink({
            kind: EventKind.Notice,
            level: 'warn',
            text: 'Provider 本次调用了但无内容返回，已跳过此轮。',
          });
          return;
        }
      }

      // 存储 assistant 轮次（reasoning + 签名一并留档：纸面显示与**下一轮回传**
      // 共用同一份事实——OpenAI 兼容方言带 tools 时必须回传 reasoning_content，
      // Anthropic 必须重放带签名的 thinking 块，Responses 必须把 response.output
      // 原样拼回 input；见 provider/openai.ts · anthropic.ts · responses.ts）
      host.appendMessage('assistant/text', {
        role: 'assistant',
        content: text,
        reasoning_content: reasoning,
        reasoning_signature: signature,
        tool_calls: calls,
        ...(responses_items === undefined || responses_items.length === 0 ? {} : { responses_items }),
      });
      // 工具调用审计事件（每调用一条）——**已由执行器在分发时落**（触发点 B 的
      // 宣布补落，2026-09-15）：那里是「模型宣布 → 落盘 → 才执行」的正确时点，
      // 此处不再重复追加（单一写入点 = 单一事实源）。

      if (calls.length === 0 && host.pendingInserts.length === 0) {
        host.loopEvents.emitLoopEvent('step/end', { agentId: host.id, step, toolCalls: 0 });
        return;
      }

      // ── 收集工具结果（流式执行器在 stream 期间已执行）----
      log.info('agent', 'collect streaming results', {
        tools: calls.map((c) => c.name),
        count: calls.length,
      });
      // ⚡ 遗弃语义（landmine L3）：本轮若已被硬截止作废，**不再等**这些工具——
      //   `awaitRemaining` 的 30 分钟 backstop 是「工具不返回时回合仍能往前」的
      //   兜底；已被判死的一轮没有「往前」可言。`discard()` 清掉 pending 面
      //  （迟到结果由此不再进会话投影；`tool/call` 审计事实早在分发时已落盘）。
      if (host.stepBoundary(signal) === false) {
        executor.discard();
        throw host.abandonedError(signal);
      }
      const pendingResults = await executor.awaitRemaining();
      // 按调用顺序构建结果
      const resultsByCallId = new Map(pendingResults.map((r) => [r.call.id, r]));

      // ── Storm breaker + 压缩埋点 ──
      // 两个调用点在 6e75046（StreamingToolExecutor 清理前）丢失；
      // 在此重新接线。Storm breaker 将模型从相同失败的循环中推开；
      // tracker 用真实损失数据喂给压缩自动调优。
      const stormNudge = host.stormNudge(calls, resultsByCallId);
      for (const call of calls) {
        // 领域调用（fs/shell/...）解析回旧语义名 — 压缩追踪按旧名统计
        let guardName: string;
        try {
          guardName = resolveGuardToolName(host.tools, call.name, JSON.parse(call.arguments || '{}'));
        } catch {
          guardName = call.name;
        }
        host.compactionTracker.recordToolCall(guardName, call.arguments || '{}');
        if (guardName === 'read_file_content' || guardName === 'read_file') {
          const fp = parseFilePathArg(call.arguments);
          if (fp) host.compactionTracker.recordFileRead(fp);
        }
      }

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        const r = resultsByCallId.get(call.id);
        // r 存在但 output 为空 = 工具执行成功但无输出(如 git add 成功、git diff 无差异)。
        // 空字符串是 falsy,若用 `r?.output || error` 会把成功误判成"工具没结果",
        // 导致 Agent 看到 "did not produce a result" 而困惑/重试。
        // 仅当 r 不存在(流式重试丢失、未分发)才算真正失败。
        let content = r
          ? r.output || `(工具 ${call.name} 执行成功，无输出)`
          : `error: tool "${call.name}" did not produce a result`;
        if (!r) {
          // 补发 ToolResult 终止 UI 卡片（执行器 abort 已覆盖主流路径，
          // 此处兜底任何残留缺口，防止卡片永久"执行中"——会话 223 事故）。
          host.sink({
            kind: EventKind.ToolResult,
            tool: {
              id: call.id,
              name: call.name,
              args: call.arguments,
              output: content,
              err: 'did not produce a result',
              read_only: host.toolReadOnly(call.name),
            },
          });
        }
        if (stormNudge && i === 0) content += stormNudge;
        host.appendMessage('tool/result', {
          role: 'tool',
          content,
          tool_call_id: call.id,
          name: call.name,
          // 工具附图（P0a）：引用随消息入卷，字节在盘上（INVARIANTS #14）
          ...(r?.images && r.images.length > 0 ? { images: r.images } : {}),
        });
        // 通知面板自动刷新（workspace 注入的端口）
        host.ui.toolDone?.(
          call.name,
          (() => {
            try {
              return JSON.parse(call.arguments || '{}');
            } catch {
              return {};
            }
          })(),
          r?.output || '',
        );
      }

      // 2026-09 迭代：轮末异步压缩退役 — 自动压缩主触发已前移到下轮
      // step 头（pre-flight 同步 ≥compactRatio 判定），此处不再按 usage
      // 异步触发（异步压完下一轮又涨回去，且 0.55 线在前缀缓存计价下净亏）。
      host.loopEvents.emitLoopEvent('step/end', { agentId: host.id, step, toolCalls: calls.length });
    }
  } catch (e) {
    turnErr = e;
    throw e;
  } finally {
    host.ui.onStatusChange?.(false);
    host.loopEvents.emitLoopEvent('turn/end', {
      agentId: host.id,
      ok: turnErr === null,
      aborted: signal.aborted,
    });
    // 「本轮结束时 inbox 还有未注入消息 ⇒ 补唤醒」已上移到 `Agent.run()` 的 finally
    //（契约 v43）：那里在**运行记录注销之后**——本函数先于 Agent.run 返回，原先在此
    // queueMicrotask 会让新轮在旧记录仍活着时被叫醒（旧轮收尾清掉新轮那一族）。
    // 判据（peekInbox 去掉已注入 id）逐字保留在 Agent 侧。
  }
}
