// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Plan 模式工具守卫。
//
// 背景：plan 模式过去通过整体切换 ToolRegistry（_fullTools ↔ _planTools）
// 实现只读约束，但 tools 字段一变，DeepSeek 前缀缓存整段失效
// （实测单次 ~10 万 tokens 按全价重算）。2026-08-10 起改为：
//
//   - 主 Agent：单一注册表，schema 跨模式恒定；写约束在执行层按
//     planState 运行时拦截（planGateCheck，由 streaming-executor 调用）。
//   - plan 模式下 spawn 的子 Agent：仍用 planRegistry() 静态降级为
//     只读克隆——子 Agent 生命周期可能跨越 plan 退出，
//     保持"并行只读探索"语义不依赖父 Agent 的运行时状态。

import { ToolRegistry } from '../tool';
import type { Tool } from '../tool';
import type { PlanStateManager } from './plan-state';

/** plan 门禁判定：返回 null = 放行；返回字符串 = 拦截（作为工具结果返回给模型）。
 *  规则与下方 planRegistry 静态过滤对齐：
 *    - readOnly 工具放行；
 *    - 领域工具仅放行只读动作；fs(write)/fs(edit) 命中计划文件时豁免；
 *    - agent(spawn) 放行（plan 模式保留并行只读探索；子 Agent 静态只读）；
 *    - 其余非只读工具（analyze_project/validate_project/rename_symbol 等）拦截。 */
export type PlanGate = (name: string, args: Record<string, unknown>, tool: Tool) => string | null;

export function planGateCheck(
  planState: PlanStateManager | null,
  name: string,
  args: Record<string, unknown>,
  tool: Tool,
): string | null {
  if (!planState?.state.active) return null;
  if (tool.readOnly()) return null;

  const ro = tool.readOnlyActions?.();
  if (ro && ro.length > 0) {
    const action = typeof args?.action === 'string' ? args.action : '';
    if (action && ro.includes(action)) return null;
    // fs(write)/fs(edit) 计划文件豁免 — 兼容 filePath/path/file_path 别名
    // （与 domains.ts normalizeArgs 的别名表一致）。
    if (tool.domain?.() === 'fs' && (action === 'write' || action === 'edit')) {
      const fp = String(args?.filePath ?? args?.path ?? args?.file_path ?? '');
      if (fp && planState.isPlanFile(fp)) return null;
    }
    // plan 模式保留 spawn（原 planRegistry 对 agent_spawn 的显式保留，
    // 收敛后走 agent 领域动作）；spawn 出的子 Agent 静态只读。
    if (tool.domain?.() === 'agent' && action === 'spawn') return null;
    return `[已拦截] 规划模式下 ${name} 仅允许只读动作: ${ro.join(', ')}。` +
      `把修改方案写入计划文件（${planState.state.planFilePath ?? '未知'}），或退出规划模式后再执行。`;
  }

  return `[已拦截] 规划模式下不允许调用 ${name}。` +
    `请只做只读探索，把修改方案写入计划文件（${planState.state.planFilePath ?? '未知'}）。`;
}

// ── Plan 模式静态只读克隆（子 Agent 用） ──

export function planRegistry(base: ToolRegistry, planState?: PlanStateManager): ToolRegistry {
  const out = new ToolRegistry();
  for (const t of base.all()) {
    if (base.isHidden(t.name())) continue; // 隐藏的旧工具不再进入 plan 模式可见集
    if (t.readOnly()) {
      out.register(t);
      continue;
    }
    // 领域工具：只暴露只读动作，其余动作在 execute 层拦截。
    // fs 的 write/edit 与 write_file/edit_file 同等待遇：命中计划文件时放行。
    const ro = t.readOnlyActions?.();
    if (ro && ro.length > 0) {
      out.register(guardDomainForPlan(t, ro, planState));
    }
  }

  // plan 模式下额外允许 write_file / edit_file，但仅限计划文件。
  // 无条件注册（不依赖构建时 active 状态）——运行时由 planState.isPlanFile 判定：
  // 未激活时 planFilePath 为 null → isPlanFile 恒 false → 拦截所有写（安全兜底）；
  // 激活后只放行计划文件。这样 plan 工具集可随时构建、随时切换。
  const writeFile = base.get('write_file');
  const editFile = base.get('edit_file');
  if (writeFile) {
    out.register({
      name: () => writeFile.name(),
      description: () => writeFile.description(),
      parameters: () => writeFile.parameters(),
      readOnly: () => false,
      execute: async (args, onProgress) => {
        const fp = String(args.filePath || '');
        if (planState && planState.isPlanFile(fp)) {
          return writeFile.execute(args, onProgress);
        }
        return `[已拦截] 规划模式下只能写计划文件 (${planState?.state.planFilePath ?? '未知'})。`;
      },
    });
  }
  if (editFile) {
    out.register({
      name: () => editFile.name(),
      description: () => editFile.description(),
      parameters: () => editFile.parameters(),
      readOnly: () => false,
      execute: async (args, onProgress) => {
        const fp = String(args.filePath || '');
        if (planState && planState.isPlanFile(fp)) {
          return editFile.execute(args, onProgress);
        }
        return `[已拦截] 规划模式下只能编辑计划文件 (${planState?.state.planFilePath ?? '未知'})。`;
      },
    });
  }
  return out;
}

/** plan 模式守卫：领域工具只放行只读动作；fs 的 write/edit 在命中计划文件时豁免
 *  （与 write_file/edit_file 的计划文件特判一致，见上方）。
 *  未激活规划模式时 planFilePath 为 null → isPlanFile 恒 false → 写操作仍全拦（安全兜底）。 */
function guardDomainForPlan(
  t: Tool,
  readOnlyActions: string[],
  planState?: PlanStateManager,
): Tool {
  return {
    name: () => t.name(),
    description: () => t.description(),
    parameters: () => t.parameters(),
    readOnly: () => false,
    domain: () => t.domain?.() ?? '',
    actions: () => t.actions?.() ?? [],
    readOnlyActions: () => readOnlyActions,
    execute: async (args, onProgress, signal) => {
      const action = (args as { action?: unknown })?.action;
      if (typeof action === 'string') {
        if (readOnlyActions.includes(action)) {
          return t.execute(args, onProgress, signal);
        }
        // fs(write)/fs(edit) 计划文件豁免 — 兼容 filePath/path/file_path 别名
        // （与 domains.ts normalizeArgs 的别名表一致）。
        if (
          t.domain?.() === 'fs' &&
          (action === 'write' || action === 'edit') &&
          planState
        ) {
          const fp = String(args.filePath ?? args.path ?? args.file_path ?? '');
          if (planState.isPlanFile(fp)) {
            return t.execute(args, onProgress, signal);
          }
        }
      }
      return `[已拦截] 规划模式下 ${t.name()} 仅允许只读动作: ${readOnlyActions.join(', ')}`;
    },
  };
}
