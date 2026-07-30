// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 压缩成本模型 — 用可度量的数学替代硬编码的魔法数字。
//
// 决策变量（目前在 agent.ts 中硬编码）：
//   r = compactRatio  (0.7) — 触发阈值，占 contextWindow 的比例
//   k = recentKeep    (4)   — 尾部保留的完整消息数
//
// 模型：
//   NetBenefit = |R|·c_in·(T-1) - |S|·c_out - L·avg_turn_cost
//
//   |R|  = 被压缩区域的 token 数
//   |S|  = 生成的摘要 token 数
//   T    = 压缩后的剩余轮次
//   L    = 信息丢失导致的预期额外轮次
//   c_in = 每 1M input token 的成本
//   c_out = 每 1M output token 的成本
//
// 未知量：L（信息丢失 → 额外轮次）。
// 此追踪器监测 agent 循环来度量它。

import type { Pricing } from './agent-types';
import { log } from './logger';
import type { Tool } from './tool';

// ── 收集的指标 ──

export interface CompactionEvent {
  ts: number;
  /** 被压缩区域的消息数 */
  regionMsgCount: number;
  /** 压缩前区域的估算 token 数 */
  regionTokensEst: number;
  /** 摘要 LLM 调用实际消耗的 token 数（输入） */
  summaryInputTokens: number;
  /** 生成摘要的 token 数（输出） */
  summaryOutputTokens: number;
  /** 尾部保留的消息数（完整保留） */
  tailMsgCount: number;
  /** 压缩前估算的会话 token 数 */
  preTokens: number;
  /** 压缩后估算的会话 token 数 */
  postTokens: number;
  /** 结果: 'summary' | 'truncated' | 'stuck' */
  outcome: 'summary' | 'truncated' | 'stuck';
}

export interface CompactionSessionStats {
  events: CompactionEvent[];
  /** 摘要 LLM 总成本（输入 + 输出） */
  totalSummaryCost: number;
  /** 估算的跨所有剩余轮次节省的总 token 数 */
  estimatedTokensSaved: number;
  /** 压缩前读取的文件（用于检测重读） */
  filesReadPreCompact: Set<string>;
  /** 压缩后重读压缩前文件次数 */
  reReadCount: number;
  /** 压缩后重复的工具调用（同名 + 同参数签名） */
  duplicateToolCalls: number;
  /** 本会话总轮次 */
  totalTurns: number;
  /** 每次压缩后发生的轮次 */
  turnsAfterCompaction: number[];
}

// ── 成本常量（Claude Sonnet，每 1M tokens）──

const DEFAULT_C_IN = 3.0; // $3/1M 输入
const DEFAULT_C_OUT = 15.0; // $15/1M 输出

/** ponytail: 每次重读或压缩后重复工具调用计为
 *  0.25 个额外轮次 — agent 通常恢复很快，不到一整轮。 */
const LOSS_FACTOR_PER_EVENT = 0.25;

// ── 压缩成本模型 ──

export interface CompactionParams {
  regionTokens: number; // |R|
  summaryTokens: number; // |S|
  turnsRemaining: number; // T
  extraTurnsFromLoss: number; // L
  avgTurnCost: number; // avg_turn_cost（美元）
  cIn?: number; // 默认 $3
  cOut?: number; // 默认 $15
}

/** 计算单次压缩的净收益。
 *  正值 = 压缩省钱。负值 = 成本大于节省。 */
export function netBenefit(p: CompactionParams): number {
  const cIn = p.cIn ?? DEFAULT_C_IN;
  const cOut = p.cOut ?? DEFAULT_C_OUT;

  const savedTokens = p.regionTokens * (p.turnsRemaining - 1);
  const savedCost = (savedTokens * cIn) / 1_000_000;

  const summaryCost = (p.regionTokens * cIn + p.summaryTokens * cOut) / 1_000_000;

  const lossCost = p.extraTurnsFromLoss * p.avgTurnCost;

  return savedCost - summaryCost - lossCost;
}

/** 盈亏平衡轮次：压缩回本需要多少剩余轮次。
 *  忽略信息丢失（L=0）。如果摘要大于区域则返回 Infinity。 */
export function breakevenTurns(p: CompactionParams): number {
  const cIn = p.cIn ?? DEFAULT_C_IN;
  const cOut = p.cOut ?? DEFAULT_C_OUT;

  if (p.regionTokens <= 0) return Infinity;

  // 求解: |R|·c_in·(T-1) - |S|·c_out - L·avg = 0 中的 T
  // → T = 1 + (|S|·c_out + L·avg) / (|R|·c_in)
  const numerator = p.summaryTokens * cOut + p.extraTurnsFromLoss * p.avgTurnCost * 1_000_000;
  const denominator = p.regionTokens * cIn;

  return 1 + numerator / denominator;
}

// ── 最优 recentKeep 估算器 ──

/** 估算保留 k 条尾部消息的信息丢失。
 *  ponytail: 指数衰减模型 — 离当前轮次越远的消息
 *  相关性几何级递减。保留更多消息能减少丢失
 *  但增加每轮 token 成本。
 *
 *  loss(k) = base_loss * exp(-λ * k)
 *    其中 λ 控制相关性衰减速度（越大 = 衰减越快）
 *
 *  默认 λ ≈ 0.3 意味着每条消息的相关性约为前一条的 74%。
 */
export function estimateLoss(k: number, totalRegionMsgs: number, lambda = 0.3): number {
  // 尾部省略的每条消息都有一定概率后续需要。
  // 越早的消息被需要的概率越低。
  let cumulativeLoss = 0;
  for (let i = 0; i < totalRegionMsgs - k; i++) {
    // 距当前轮次 i 步的消息相关性
    cumulativeLoss += Math.exp(-lambda * (i + k));
  }
  // 缩放: 最大丢失约为每 50 条丢失消息 1 个额外轮次
  return cumulativeLoss * 0.02;
}

/** 保留 k 条尾部消息的预期每轮成本。
 *  avgMsgTokens = 每条消息的平均 token 数。 */
export function tailCost(k: number, avgMsgTokens: number, cIn?: number): number {
  const c = cIn ?? DEFAULT_C_IN;
  return (k * avgMsgTokens * c) / 1_000_000;
}

/** 找到使总成本最小的最优 k（recentKeep）。
 *  总成本 = 尾部存储成本 (k·|m̄|·c_in) + 预期丢失成本。 */
export function optimalRecentKeep(
  totalRegionMsgs: number,
  avgMsgTokens: number,
  avgTurnCost: number,
  lambda = 0.3,
  cIn?: number,
): { k: number; cost: number } {
  let bestK = 1;
  let bestCost = Infinity;

  for (let k = 1; k <= Math.min(totalRegionMsgs, 20); k++) {
    const storageCost = tailCost(k, avgMsgTokens, cIn) * 10; // 假设还有约 10 轮
    const loss = estimateLoss(k, totalRegionMsgs, lambda);
    const lossCost = loss * avgTurnCost;
    const totalCost = storageCost + lossCost;

    if (totalCost < bestCost) {
      bestCost = totalCost;
      bestK = k;
    }
  }

  return { k: bestK, cost: bestCost };
}

// ── 最优 compactRatio 估算器 ──

/** 根据预期会话长度找到最优 r（compactRatio）。
 *
 *  如果压缩太早（低 r），为较少的收益支付摘要成本，
 *  因为没有多少 token 可压缩。
 *  如果压缩太晚（高 r），压缩前每轮成本更高。
 *
 *  对于 N 条总消息的会话：
 *    - 不压缩：总成本 ∝ N²（每轮发送所有之前的消息）
 *    - 在 r 处压缩：压缩成本 + 之后线性增长
 *
 *  ponytail: 这是简化模型。真正的最优值取决于消息大小
 *  分布以及会话主要是工具密集型还是对话密集型。
 */
export function optimalCompactRatio(
  contextWindow: number,
  avgMsgTokens: number,
  expectedTurns: number,
  avgTurnCost: number,
): { r: number; estimatedSaving: number } {
  let bestR = 0.7;
  let bestSaving = 0;

  for (let r = 0.3; r <= 0.95; r += 0.05) {
    const triggerTokens = r * contextWindow;
    const triggerMsgs = Math.floor(triggerTokens / avgMsgTokens);

    if (triggerMsgs >= expectedTurns) continue; // 永不触发

    const regionTokens = triggerTokens - avgMsgTokens * 4; // 减去尾部
    const summaryTokens = regionTokens * 0.05; // ~5% 压缩比
    const turnsRemaining = expectedTurns - triggerMsgs;

    if (turnsRemaining <= 1) continue;

    const benefit = netBenefit({
      regionTokens,
      summaryTokens,
      turnsRemaining,
      extraTurnsFromLoss: 0, // 乐观估计
      avgTurnCost,
    });

    const savingsPerSession = benefit * turnsRemaining;
    if (savingsPerSession > bestSaving) {
      bestSaving = savingsPerSession;
      bestR = r;
    }
  }

  return { r: bestR, estimatedSaving: bestSaving };
}

// ── CompactionTracker — 监测 agent.ts ──

export class CompactionTracker {
  private filesRead = new Set<string>();
  private toolSigs = new Set<string>();
  private totalTurns = 0;
  private events: CompactionEvent[] = [];
  private turnsAfter: number[] = [];
  private reReads = 0;
  private dupTools = 0;
  private currentPostCompactCounter = -1; // -1 = not post-compaction

  /** 每次 API stream 前调用。 */
  recordTurn(): void {
    this.totalTurns++;
    if (this.currentPostCompactCounter >= 0) {
      this.currentPostCompactCounter++;
    }
  }

  /** read_file_content 或 read_file 工具执行时调用。 */
  recordFileRead(filePath: string): void {
    const norm = filePath.replace(/\\/g, '/').toLowerCase();
    if (this.currentPostCompactCounter >= 0 && this.filesRead.has(norm)) {
      this.reReads++;
      log.info('compaction-model', 're-read detected', {
        file: norm,
        turnsAfterCompact: this.currentPostCompactCounter,
      });
    }
    this.filesRead.add(norm);
  }

  /** 任意工具执行时调用。追踪签名用于重复检测。 */
  recordToolCall(name: string, args: string): void {
    const sig = `${name}:${args.slice(0, 200)}`;
    if (this.currentPostCompactCounter >= 0 && this.toolSigs.has(sig)) {
      this.dupTools++;
      log.info('compaction-model', 'duplicate tool call detected', {
        tool: name,
        turnsAfterCompact: this.currentPostCompactCounter,
      });
    }
    this.toolSigs.add(sig);
  }

  /** 压缩完成后调用。 */
  recordCompaction(event: CompactionEvent): void {
    this.events.push(event);
    this.turnsAfter.push(0);
    this.currentPostCompactCounter = 0;
  }

  /** 计算会话级统计。 */
  getStats(pricing?: Pricing): CompactionSessionStats {
    let totalSummaryCost = 0;
    let totalTokensSaved = 0;
    const cIn = pricing?.input ?? DEFAULT_C_IN;
    const cOut = pricing?.output ?? DEFAULT_C_OUT;

    for (const e of this.events) {
      totalSummaryCost += (e.summaryInputTokens * cIn + e.summaryOutputTokens * cOut) / 1_000_000;
      totalTokensSaved += e.regionTokensEst - e.summaryOutputTokens;
    }

    return {
      events: this.events,
      totalSummaryCost,
      estimatedTokensSaved: totalTokensSaved,
      filesReadPreCompact: this.filesRead,
      reReadCount: this.reReads,
      duplicateToolCalls: this.dupTools,
      totalTurns: this.totalTurns,
      turnsAfterCompaction: this.turnsAfter,
    };
  }

  /** 从收集的数据估算信息丢失因子 L。
   *  ponytail: 启发式 — 每次重读或重复工具调用计为
   *  0.25 个额外轮次（不到一整轮，因为 agent 通常恢复很快）。 */
  estimateLossFactor(): number {
    return (this.reReads + this.dupTools) * LOSS_FACTOR_PER_EVENT;
  }

  /** 从定价和 token 估算值计算平均轮次成本。 */
  estimateAvgTurnCost(avgInputTokens: number, avgOutputTokens: number, pricing?: Pricing): number {
    const cIn = pricing?.input ?? DEFAULT_C_IN;
    const cOut = pricing?.output ?? DEFAULT_C_OUT;
    return (avgInputTokens * cIn + avgOutputTokens * cOut) / 1_000_000;
  }

  reset(): void {
    // E5: 跨会话保留 events、turnsAfter 和 filesRead，
    // 使压缩调优不会在重启后从零开始。
    // 仅重置每会话的临时计数器。
    this.toolSigs.clear();
    this.totalTurns = 0;
    this.reReads = 0;
    this.dupTools = 0;
    this.currentPostCompactCounter = -1;
  }

  // ── E5: 跨会话持久化 ──

  /** 序列化持久状态用于跨会话存活。
   *  仅持久化 events、turnsAfter 和 filesRead — 每会话
   *  计数器（totalTurns、reReads、dupTools 等）每次会话重新开始。 */
  serializeState(): string {
    return JSON.stringify({
      events: this.events,
      turnsAfter: this.turnsAfter,
      filesRead: Array.from(this.filesRead),
    });
  }

  /** 从序列化字符串恢复状态。替换现有数据（非追加）。 */
  deserializeState(json: string): void {
    try {
      const data = JSON.parse(json) as {
        events?: CompactionEvent[];
        turnsAfter?: number[];
        filesRead?: string[];
      };
      // 替换而非追加 — 防止重复加载时累积重复数据
      if (Array.isArray(data.events)) {
        this.events = [...data.events];
      }
      if (Array.isArray(data.turnsAfter)) {
        this.turnsAfter = [...data.turnsAfter];
      }
      if (Array.isArray(data.filesRead)) {
        this.filesRead = new Set(data.filesRead);
      }
    } catch {
      /* 文件损坏 — 从零开始 */
    }
  }
}

// ── 自动调优：跨会话持久化最优参数 ──

export interface CompactionConfig {
  compactRatio: number;
  recentKeep: number;
  tunedAt: number; // 上次调优时间戳
  sampleCount: number; // 使用的压缩事件数量
  avgCompressionRatio: number;
  avgLossFactor: number;
  reasoning: string; // 人类可读的说明
}

const MIN_SAMPLES_FOR_TUNE = 5;

/** 从追踪器数据计算最优参数。数据不足时返回 null。 */
export function tuneCompactionParams(tracker: CompactionTracker, pricing?: Pricing): CompactionConfig | null {
  const stats = tracker.getStats(pricing);
  if (stats.events.length < MIN_SAMPLES_FOR_TUNE) return null;

  // 所有事件的平均压缩比
  const avgCompressionRatio =
    stats.events.reduce((sum, e) => {
      if (e.regionTokensEst === 0) return sum;
      return sum + e.summaryOutputTokens / e.regionTokensEst;
    }, 0) / stats.events.length;

  // 压缩后的平均轮次
  const _avgTurnsAfter =
    stats.turnsAfterCompaction.length > 0
      ? stats.turnsAfterCompaction.reduce((a, b) => a + b, 0) / stats.turnsAfterCompaction.length
      : 0;

  // 平均区域大小
  const avgRegionMsgs = stats.events.reduce((sum, e) => sum + e.regionMsgCount, 0) / stats.events.length;
  const avgRegionTokens = stats.events.reduce((sum, e) => sum + e.regionTokensEst, 0) / stats.events.length;

  // 平均消息 token 数
  const avgMsgTokens = avgRegionMsgs > 0 ? avgRegionTokens / avgRegionMsgs : 500;

  // 从观测到的重读/重复工具计算丢失因子
  const lossFactor = tracker.estimateLossFactor();
  const avgLossPerEvent = stats.events.length > 0 ? lossFactor / stats.events.length : 0;

  // 平均轮次成本
  const avgTurnCost = tracker.estimateAvgTurnCost(avgRegionTokens, avgRegionTokens * 0.15, pricing);

  // 计算最优 recentKeep
  const { k: optimalK } = optimalRecentKeep(Math.round(avgRegionMsgs), avgMsgTokens, avgTurnCost, 0.3, pricing?.input);

  // 根据预期会话长度计算最优 compactRatio
  const { r: optimalR } = optimalCompactRatio(1_000_000, avgMsgTokens, stats.totalTurns, avgTurnCost);
  // 限制到合理范围
  const tunedR = Math.max(0.35, Math.min(0.75, optimalR));

  // 构建说明
  const parts: string[] = [];
  parts.push(
    `${stats.events.length}次压缩, 平均压缩比 ${(avgCompressionRatio * 100).toFixed(1)}%, 每次平均信息丢失 ${avgLossPerEvent.toFixed(2)} 轮`,
  );
  parts.push(`compactRatio: ${(optimalR * 100).toFixed(0)}% → 夹到 ${(tunedR * 100).toFixed(0)}%`);
  parts.push(`recentKeep: ${optimalK}`);

  return {
    compactRatio: tunedR,
    recentKeep: optimalK,
    tunedAt: Date.now(),
    sampleCount: stats.events.length,
    avgCompressionRatio,
    avgLossFactor: avgLossPerEvent,
    reasoning: parts.join(' | '),
  };
}

/** 尝试自动调优并返回推荐。由调用方决定是否应用。 */
export function maybeTune(
  tracker: CompactionTracker,
  currentR: number,
  currentK: number,
  pricing?: Pricing,
): { config: CompactionConfig; changed: boolean } | null {
  const config = tuneCompactionParams(tracker, pricing);
  if (!config) return null;
  const changed = Math.abs(config.compactRatio - currentR) > 0.05 || config.recentKeep !== currentK;
  return { config, changed };
}

// ── 诊断报告（用于 /compact-stats 或 MCP 工具）──

/** ponytail: 共享成本计算 — 被 formatCompactionReport 和 agent 工具共用。 */
function compactionEventCost(e: CompactionEvent, pricing?: Pricing): number {
  return (
    (e.summaryInputTokens * (pricing?.input ?? DEFAULT_C_IN) +
      e.summaryOutputTokens * (pricing?.output ?? DEFAULT_C_OUT)) /
    1_000_000
  );
}

export function formatCompactionReport(stats: CompactionSessionStats, pricing?: Pricing): string {
  const lines: string[] = [
    `# 压缩成本分析报告`,
    ``,
    `| 指标 | 值 |`,
    `|------|-----|`,
    `| 压缩次数 | ${stats.events.length} |`,
    `| 压缩总成本 | $${stats.totalSummaryCost.toFixed(4)} |`,
    `| 估算省 token | ${stats.estimatedTokensSaved.toLocaleString()} |`,
    `| 重读文件次数 | ${stats.reReadCount} |`,
    `| 重复工具调用 | ${stats.duplicateToolCalls} |`,
    `| 估算信息丢失轮次 | ${(stats.reReadCount + stats.duplicateToolCalls) * LOSS_FACTOR_PER_EVENT} |`,
    `| 总会话轮次 | ${stats.totalTurns} |`,
  ];

  if (stats.events.length > 0) {
    lines.push('');
    lines.push('## 各次压缩明细');
    lines.push('');
    for (let i = 0; i < stats.events.length; i++) {
      const e = stats.events[i];
      const turnsAfter = stats.turnsAfterCompaction[i] || 0;
      const compressionRatio = ((1 - e.postTokens / e.preTokens) * 100).toFixed(1);
      lines.push(`### 压缩 #${i + 1}`);
      lines.push(`- 时间: ${new Date(e.ts).toLocaleTimeString()}`);
      lines.push(`- 方式: ${e.outcome}`);
      lines.push(`- 压缩区域: ${e.regionMsgCount} 条消息, ~${e.regionTokensEst.toLocaleString()} tokens`);
      lines.push(`- 摘要大小: ~${e.summaryOutputTokens.toLocaleString()} tokens`);
      lines.push(
        `- 压缩比: ${compressionRatio}% (${e.preTokens.toLocaleString()} → ${e.postTokens.toLocaleString()} tokens)`,
      );
      lines.push(`- 压缩 LLM 调用费: $${compactionEventCost(e, pricing).toFixed(4)}`);
      lines.push(`- 压缩后继续: ${turnsAfter} 轮`);
    }
  }

  return lines.join('\n');
}

// ── Agent 工具：hologram_compaction_stats ──

/** 创建只读工具，让 agent（和用户）检查压缩健康状态。
 *  ponytail: 不做修改 — 仅格式化追踪器的当前状态。 */
export function createCompactionTools(
  getTracker: () => CompactionTracker | null,
  getPricing: () => Pricing | undefined,
  getCurrentParams: () => { compactRatio: number; recentKeep: number; contextWindow: number },
  loadConfig: () => Promise<CompactionConfig | null>,
): Tool[] {
  return [
    {
      name: () => 'hologram_compaction_stats',
      description: () =>
        '查看上下文压缩的运行状态和数据。包括：已记录的压缩次数、压缩比、信息丢失估计、自动调优状态、当前参数 vs 推荐参数。' +
        '用户问"压缩调得怎么样"或"压缩数据够不够"时调用。',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => true,
      execute: async () => {
        const tracker = getTracker();
        const pricing = getPricing();
        const current = getCurrentParams();
        const persisted = await loadConfig();

        const stats = tracker?.getStats(pricing);
        const lines: string[] = [
          '# 上下文压缩运行状态',
          '',
          '## 当前参数',
          `- contextWindow: ${current.contextWindow.toLocaleString()} tokens`,
          `- compactRatio: ${(current.compactRatio * 100).toFixed(0)}% (阈值 ${((current.contextWindow * current.compactRatio) / 1000).toFixed(0)}K tokens)`,
          `- recentKeep: ${current.recentKeep} 条`,
          '',
        ];

        if (persisted) {
          lines.push('## 已持久化的调优结果');
          lines.push(`- compactRatio: ${(persisted.compactRatio * 100).toFixed(0)}%`);
          lines.push(`- recentKeep: ${persisted.recentKeep} 条`);
          lines.push(`- 基于 ${persisted.sampleCount} 次压缩样本`);
          lines.push(`- 调优时间: ${new Date(persisted.tunedAt).toLocaleString()}`);
          lines.push(`- 依据: ${persisted.reasoning}`);
          lines.push('');
        }

        if (!stats) {
          lines.push('## 数据收集');
          lines.push('Tracker 未初始化。压缩数据将在压缩触发后自动记录。');
          return lines.join('\n');
        }

        lines.push('## 数据收集');
        lines.push(`- 已记录压缩: ${stats.events.length} 次 (需 ≥5 次才能自动调优)`);
        lines.push(`- 当前会话轮次: ${stats.totalTurns}`);
        lines.push(`- 重读文件: ${stats.reReadCount} 次`);
        lines.push(`- 重复工具调用: ${stats.duplicateToolCalls} 次`);
        lines.push(
          `- 估算信息丢失: ${((stats.reReadCount + stats.duplicateToolCalls) * LOSS_FACTOR_PER_EVENT).toFixed(1)} 轮`,
        );
        lines.push(`- 压缩总成本: $${stats.totalSummaryCost.toFixed(4)}`);

        if (stats.events.length >= 5) {
          lines.push('');
          lines.push('✅ 样本充足，已触发自动调优。');
        } else if (stats.events.length > 0) {
          lines.push('');
          lines.push(`⏳ 还需 ${5 - stats.events.length} 次压缩才能自动调优。`);
        } else {
          lines.push('');
          lines.push('🆕 尚未触发压缩。会话 token 数达到阈值时将自动触发。');
        }

        if (stats.events.length > 0) {
          lines.push('');
          lines.push('## 压缩明细');
          lines.push('');
          for (let i = 0; i < stats.events.length; i++) {
            const e = stats.events[i];
            const turnsAfter = stats.turnsAfterCompaction[i] || 0;
            const ratio = e.regionTokensEst > 0 ? ((1 - e.postTokens / e.preTokens) * 100).toFixed(1) : '0';
            lines.push(
              `### #${i + 1} ${e.outcome === 'summary' ? '✅ 总结' : e.outcome === 'truncated' ? '✂️ 截断' : '⏸️ 卡住'}`,
            );
            lines.push(`- 压缩 ${e.regionMsgCount} 条消息 → 摘要 ${e.summaryOutputTokens.toLocaleString()} tokens`);
            lines.push(
              `- 上下文: ${e.preTokens.toLocaleString()} → ${e.postTokens.toLocaleString()} tokens (${ratio}%)`,
            );
            lines.push(`- 压缩成本: $${compactionEventCost(e, pricing).toFixed(4)}`);
            lines.push(`- 压缩后继续: ${turnsAfter} 轮`);
          }
        }

        lines.push('');
        lines.push('---');
        lines.push('*数据由 CompactionTracker 自动记录，存储于 compaction-model.ts。*');

        return lines.join('\n');
      },
    },
  ];
}
