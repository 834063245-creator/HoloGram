// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Plan 模式图增强 Hook — HoloGram 独有差异化能力
//
// 两层增强：
//   1. 探索阶段（post-tool）：LLM 读文件时注入更详细的影响面（比普通模式更全）
//   2. 计划写入阶段（post-tool）：LLM 写计划文件后，自动追加影响面分析摘要
//
// 注意：hook 不修改计划文件本身 — 只增强工具返回结果（LLM 看到的）。
// LLM 可以选择把分析写进计划，也可以忽略。不破坏 LLM 对计划内容的控制权。

import type { GraphContext, Hook } from '../hooks';
import type { PlanStateManager } from './plan-state';

const MAX_PLAN_ENRICH_BYTES = 1200; // plan 模式给更多空间，因为计划需要更丰富的数据

/** 探索阶段图增强 — plan 模式下读文件时注入完整影响面 */
export function createPlanExploreHook(ctx: GraphContext, planState: PlanStateManager): Hook {
  return {
    name: 'plan-explore-graph',
    shouldEnrich(toolName: string): boolean {
      if (!planState.state.active) return false;
      return ['read_file_content', 'read_file', 'search_content', 'glob', 'explore_deps', 'trace_impact'].includes(
        toolName,
      );
    },
    async enrich(toolName: string, args: Record<string, unknown>, result: string): Promise<string> {
      if (result.length > 30_000) return result;
      if (/^(error|Error|❌)/.test(result.trimStart())) return result;

      let snippet: string | null = null;

      if (toolName === 'read_file_content' || toolName === 'read_file') {
        const fp = String(args.filePath || args.file_path || '');
        if (!fp) return result;

        // 基础影响面
        const summary = ctx.getImpactSummary(fp);
        const nodes = ctx.getNodesInFile(fp);

        // plan 模式下给更详细的分析
        if (nodes.length > 0) {
          const parts: string[] = [];
          const downstream = [...nodes].filter((n) => n.fanIn > 0).sort((a, b) => b.fanIn - a.fanIn).slice(0, 8);
          const upstream = [...nodes].filter((n) => n.fanOut > 0).sort((a, b) => b.fanOut - a.fanOut).slice(0, 5);

          parts.push(`此文件 ${nodes.length} 个符号。`);
          if (downstream.length > 0) {
            parts.push(
              `下游依赖（被谁调用）: ${downstream.map((n) => `\`${n.name}\`(${n.fanIn}↓)`).join(', ')}`,
            );
          }
          if (upstream.length > 0) {
            parts.push(
              `上游依赖（调了谁）: ${upstream.map((n) => `\`${n.name}\`(${n.fanOut}↑)`).join(', ')}`,
            );
          }

          // 引擎层数据
          if (ctx.engine) {
            const normFp = fp.replace(/\\/g, '/').toLowerCase();
            const rankEntry = ctx.engine.fragilityRanks.find(
              (r) =>
                r.file.replace(/\\/g, '/').toLowerCase().includes(normFp) ||
                normFp.includes(r.file.replace(/\\/g, '/').toLowerCase()),
            );
            if (rankEntry) {
              const rank = ctx.engine.fragilityRanks.indexOf(rankEntry) + 1;
              parts.push(`脆弱度排名 #${rank} (${rankEntry.score.toFixed(0)})`);
            }
            if (ctx.engine.cycleCount > 0) {
              parts.push(`项目存在 ${ctx.engine.cycleCount} 个循环依赖`);
            }
            if (ctx.engine.sessionDrift > 0) {
              parts.push(`本次会话脆弱度退化 +${(ctx.engine.sessionDrift * 100).toFixed(1)}%`);
            }
          }

          snippet = parts.join(' | ');
        } else if (summary) {
          snippet = summary;
        }
      } else if (toolName === 'search_content' || toolName === 'glob' || toolName === 'explore_deps') {
        // 对搜索结果，给出匹配文件的图上下文
        let files: string[] = [];
        if (toolName === 'search_content') {
          try {
            const parsed = JSON.parse(result);
            const matches = parsed.matches || parsed.results || [];
            const fileSet = new Set<string>();
            for (const m of matches) {
              if (m.file) fileSet.add(m.file);
              if (fileSet.size >= 5) break;
            }
            files = [...fileSet];
          } catch {}
        }
        if (files.length > 0) {
          snippet = ctx.getSearchContext(files.slice(0, 5));
        }
      } else if (toolName === 'trace_impact') {
        // trace_impact 结果已经有了影响面数据，不需要额外注入
        return result;
      }

      if (snippet && snippet.length > 0) {
        if (snippet.length > MAX_PLAN_ENRICH_BYTES) {
          snippet = snippet.slice(0, MAX_PLAN_ENRICH_BYTES) + '…';
        }
        const block = `📊 [Plan 图上下文] ${snippet}\n${'─'.repeat(40)}\n\n`;
        if (result.length + block.length <= 30_000) {
          return block + result;
        }
      }
      return result;
    },
  };
}

/** 计划写入增强 — LLM 写计划文件后，自动追加影响面分析摘要 */
export function createPlanWriteHook(ctx: GraphContext, planState: PlanStateManager): Hook {
  return {
    name: 'plan-write-graph',
    shouldEnrich(toolName: string, args: Record<string, unknown>): boolean {
      if (!planState.state.active) return false;
      if (toolName !== 'write_file' && toolName !== 'edit_file') return false;
      const fp = String(args.filePath || '');
      return planState.isPlanFile(fp);
    },
    async enrich(_toolName: string, _args: Record<string, unknown>, result: string): Promise<string> {
      if (!ctx.engine) return result;

      const eng = ctx.engine;
      const parts: string[] = [];

      // 项目级概览
      parts.push('### 项目影响面概览');
      parts.push(`- 节点数 / 边数: 见 graph_summary`);
      parts.push(`- 循环依赖: ${eng.cycleCount} 个`);
      parts.push(`- 健康分数: ${eng.healthScore}/100`);
      if (eng.sessionDrift > 0) {
        parts.push(`- 会话退化: +${(eng.sessionDrift * 100).toFixed(1)}%`);
      }

      // 脆弱度 top 5
      if (eng.fragilityRanks.length > 0) {
        parts.push('');
        parts.push('### 高脆弱度模块 (改前必查)');
        for (const r of eng.fragilityRanks.slice(0, 5)) {
          const fileName = r.file.split('/').pop() || r.file;
          parts.push(`- \`${fileName}\` — 脆弱度 ${r.score.toFixed(0)}`);
        }
      }

      // LSP 热点
      if (eng.lspHotspots.length > 0) {
        parts.push('');
        parts.push('### 调用热点');
        for (const h of eng.lspHotspots.slice(0, 3)) {
          const fileName = h.file.split('/').pop() || h.file;
          parts.push(`- \`${fileName}:${h.symbol}\` — ${h.callers} 个调用者`);
        }
      }

      // 合成标记
      if (eng.synthesisAlerts.length > 0) {
        parts.push('');
        parts.push('### 架构盲区');
        for (const a of eng.synthesisAlerts.slice(0, 3)) {
          parts.push(`- ${a.type}: ${a.detail}`);
        }
      }

      const analysis = parts.join('\n');
      if (analysis) {
        return result + `\n\n---\n📊 [自动影响面分析 — 供写计划时参考]\n${analysis}\n`;
      }
      return result;
    },
  };
}
