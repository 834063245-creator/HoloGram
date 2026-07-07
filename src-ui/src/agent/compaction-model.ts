// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Compaction cost model — replaces hardcoded magic numbers with measurable math.
//
// Decision variables (currently hardcoded in agent.ts):
//   r = compactRatio  (0.7) — trigger threshold as fraction of contextWindow
//   k = recentKeep    (4)   — messages kept verbatim in tail
//
// Model:
//   NetBenefit = |R|·c_in·(T-1) - |S|·c_out - L·avg_turn_cost
//
//   |R|  = tokens in summarized region
//   |S|  = tokens in generated summary
//   T    = remaining turns after compaction
//   L    = expected extra turns from information loss
//   c_in = input token cost per 1M
//   c_out = output token cost per 1M
//
// The unknown: L (information loss → extra turns).
// This tracker instruments the agent loop to measure it.

import type { Pricing } from './agent-types';
import { log } from './logger';

// ── Collected metrics ──

export interface CompactionEvent {
  ts: number;
  /** Messages in the summarized region */
  regionMsgCount: number;
  /** Estimated tokens in the region before summarization */
  regionTokensEst: number;
  /** Actual tokens the summarization LLM call consumed (input) */
  summaryInputTokens: number;
  /** Tokens in the generated summary (output) */
  summaryOutputTokens: number;
  /** Messages left in tail (verbatim) */
  tailMsgCount: number;
  /** Estimated session tokens before compaction */
  preTokens: number;
  /** Estimated session tokens after compaction */
  postTokens: number;
  /** Outcome: 'summary' | 'truncated' | 'stuck' */
  outcome: 'summary' | 'truncated' | 'stuck';
}

export interface CompactionSessionStats {
  events: CompactionEvent[];
  /** Total summarization LLM cost (input + output) */
  totalSummaryCost: number;
  /** Estimated total tokens saved across all remaining turns */
  estimatedTokensSaved: number;
  /** Files read BEFORE compaction (tracked for re-read detection) */
  filesReadPreCompact: Set<string>;
  /** Number of re-reads of pre-compaction files after compaction */
  reReadCount: number;
  /** Duplicate tool calls post-compaction (same name + same args signature) */
  duplicateToolCalls: number;
  /** Total turns in this session */
  totalTurns: number;
  /** Turns that happened after each compaction */
  turnsAfterCompaction: number[];
}

// ── Cost constants (Claude Sonnet, per 1M tokens) ──

const DEFAULT_C_IN = 3.0;   // $3/1M input
const DEFAULT_C_OUT = 15.0; // $15/1M output

// ── Token estimation (matches agent.ts:830) ──

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 2.5);
}

// ── Compaction cost model ──

export interface CompactionParams {
  regionTokens: number;      // |R|
  summaryTokens: number;     // |S|
  turnsRemaining: number;    // T
  extraTurnsFromLoss: number; // L
  avgTurnCost: number;       // avg_turn_cost (dollars)
  cIn?: number;              // default $3
  cOut?: number;             // default $15
}

/** Compute net benefit of a single compaction.
 *  Positive = compaction saved money. Negative = cost more than it saved. */
export function netBenefit(p: CompactionParams): number {
  const cIn = p.cIn ?? DEFAULT_C_IN;
  const cOut = p.cOut ?? DEFAULT_C_OUT;

  const savedTokens = p.regionTokens * (p.turnsRemaining - 1);
  const savedCost = (savedTokens * cIn) / 1_000_000;

  const summaryCost = (p.regionTokens * cIn + p.summaryTokens * cOut) / 1_000_000;

  const lossCost = p.extraTurnsFromLoss * p.avgTurnCost;

  return savedCost - summaryCost - lossCost;
}

/** Break-even turns: how many remaining turns needed for compaction to pay off.
 *  Ignores information loss (L=0). Returns Infinity if summary is larger than region. */
export function breakevenTurns(p: CompactionParams): number {
  const cIn = p.cIn ?? DEFAULT_C_IN;
  const cOut = p.cOut ?? DEFAULT_C_OUT;

  if (p.regionTokens <= 0) return Infinity;

  // Solve: |R|·c_in·(T-1) - |S|·c_out - L·avg = 0 for T
  // → T = 1 + (|S|·c_out + L·avg) / (|R|·c_in)
  const numerator = p.summaryTokens * cOut + p.extraTurnsFromLoss * p.avgTurnCost * 1_000_000;
  const denominator = p.regionTokens * cIn;

  return 1 + numerator / denominator;
}

// ── Optimal recentKeep estimator ──

/** Estimate information loss from keeping k messages in tail.
 *  ponytail: exponential decay model — each message further from current turn
 *  has geometrically lower relevance. Keeping more messages reduces loss
 *  but increases per-turn token cost.
 *
 *  loss(k) = base_loss * exp(-λ * k)
 *    where λ controls how fast relevance decays (higher = faster decay)
 *
 *  Default λ ≈ 0.3 means each message ~74% as relevant as the previous one.
 */
export function estimateLoss(k: number, totalRegionMsgs: number, lambda = 0.3): number {
  // Each message omitted from tail has some probability of being needed later.
  // Messages further back are less likely to be needed.
  let cumulativeLoss = 0;
  for (let i = 0; i < totalRegionMsgs - k; i++) {
    // Relevance of message at distance i from current turn
    cumulativeLoss += Math.exp(-lambda * (i + k));
  }
  // Scale: max loss is ~1 extra turn per 50 messages lost
  return cumulativeLoss * 0.02;
}

/** Expected per-turn cost for keeping k tail messages.
 *  avgMsgTokens = average token count per message. */
export function tailCost(k: number, avgMsgTokens: number, cIn?: number): number {
  const c = cIn ?? DEFAULT_C_IN;
  return (k * avgMsgTokens * c) / 1_000_000;
}

/** Find optimal k (recentKeep) that minimizes total cost.
 *  Total cost = tail storage cost (k·|m̄|·c_in) + expected loss cost. */
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
    const storageCost = tailCost(k, avgMsgTokens, cIn) * 10; // assume ~10 remaining turns
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

// ── Optimal compactRatio estimator ──

/** Find optimal r (compactRatio) given expected session length.
 *
 *  If we compact too early (low r), we pay summarization cost for less gain
 *  because there aren't many tokens to compress.
 *  If we compact too late (high r), we pay more per turn before compaction.
 *
 *  For a session of N total messages:
 *    - Without compaction: total cost ∝ N² (each turn sends all previous msgs)
 *    - With compaction at r: compaction cost + linear growth after
 *
 *  ponytail: this is a simplified model. Real optimum depends on message size
 *  distribution and whether the session is mostly tool-heavy or chat-heavy.
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

    if (triggerMsgs >= expectedTurns) continue; // never triggers

    const regionTokens = triggerTokens - avgMsgTokens * 4; // minus tail
    const summaryTokens = regionTokens * 0.05; // ~5% compression ratio
    const turnsRemaining = expectedTurns - triggerMsgs;

    if (turnsRemaining <= 1) continue;

    const benefit = netBenefit({
      regionTokens,
      summaryTokens,
      turnsRemaining,
      extraTurnsFromLoss: 0, // optimistic
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

// ── CompactionTracker — instruments agent.ts ──

export class CompactionTracker {
  private sessionStart = Date.now();
  private filesRead = new Set<string>();
  private toolSigs = new Set<string>();
  private totalTurns = 0;
  private events: CompactionEvent[] = [];
  private turnsAfter: number[] = [];
  private reReads = 0;
  private dupTools = 0;
  private currentPostCompactCounter = -1; // -1 = not post-compaction

  /** Call before every API stream. */
  recordTurn(): void {
    this.totalTurns++;
    if (this.currentPostCompactCounter >= 0) {
      this.currentPostCompactCounter++;
    }
  }

  /** Call when a read_file_content or read_file tool executes. */
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

  /** Call when any tool executes. Track sig for duplicate detection. */
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

  /** Call after compaction completes. */
  recordCompaction(event: CompactionEvent): void {
    this.events.push(event);
    this.turnsAfter.push(0);
    this.currentPostCompactCounter = 0;
  }

  /** Compute session-level stats. */
  getStats(pricing?: Pricing): CompactionSessionStats {
    let totalSummaryCost = 0;
    let totalTokensSaved = 0;
    const cIn = pricing?.input ?? DEFAULT_C_IN;
    const cOut = pricing?.output ?? DEFAULT_C_OUT;

    for (const e of this.events) {
      totalSummaryCost +=
        (e.summaryInputTokens * cIn + e.summaryOutputTokens * cOut) / 1_000_000;
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

  /** Estimate information loss factor L from collected data.
   *  ponytail: heuristic — each re-read or duplicate tool call counts as
   *  0.25 extra turns (not a full turn since agent usually recovers quickly). */
  estimateLossFactor(): number {
    return (this.reReads + this.dupTools) * 0.25;
  }

  /** Compute average turn cost from pricing and token estimates. */
  estimateAvgTurnCost(avgInputTokens: number, avgOutputTokens: number, pricing?: Pricing): number {
    const cIn = pricing?.input ?? DEFAULT_C_IN;
    const cOut = pricing?.output ?? DEFAULT_C_OUT;
    return (avgInputTokens * cIn + avgOutputTokens * cOut) / 1_000_000;
  }

  reset(): void {
    this.filesRead.clear();
    this.toolSigs.clear();
    this.totalTurns = 0;
    this.events = [];
    this.turnsAfter = [];
    this.reReads = 0;
    this.dupTools = 0;
    this.currentPostCompactCounter = -1;
    this.sessionStart = Date.now();
  }
}

// ── Diagnostic report (for /compact-stats or MCP tool) ──

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
    `| 估算信息丢失轮次 | ${(stats.reReadCount + stats.duplicateToolCalls) * 0.25} |`,
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
      lines.push(`- 压缩比: ${compressionRatio}% (${e.preTokens.toLocaleString()} → ${e.postTokens.toLocaleString()} tokens)`);
      lines.push(`- 压缩 LLM 调用费: $${((e.summaryInputTokens * (pricing?.input ?? DEFAULT_C_IN) + e.summaryOutputTokens * (pricing?.output ?? DEFAULT_C_OUT)) / 1_000_000).toFixed(4)}`);
      lines.push(`- 压缩后继续: ${turnsAfter} 轮`);
    }
  }

  return lines.join('\n');
}
