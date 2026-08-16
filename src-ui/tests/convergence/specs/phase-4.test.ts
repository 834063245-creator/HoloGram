// Phase 4 — 生命周期所有权统一的结构门禁与行为验证（验证计划 §4 Phase 4）。
//
// T0 静态：_disposeAgent 不再直接调用分散清理路径（lifecycle.stop /
//   bus.unregister / board.unregister / runtime maps delete——除非登记豁免）；
//   装配本体以 ctx.effect 登记所有权；dispose 步骤数 ≤ 16（Phase 0 基线 21）。
// T1 顺序 trace（runtime 级）：flush 计时器清 → bus/board flush → saveState('done')
//   → 逆序 effects（board 注销 → bus 注销）——与 Phase 4 前行为的顺序铁律一致。
// T5 泄漏：fake timers 下 create/dispose 循环 100 次，timer 数无增长
//   （每个 Agent 恰好 +1 巡检 interval，dispose 后归零），注册表/总线全空。
// T3：Phase 0 全部快照（除已在案变更的 wiring dispose 段）由 phase-0 spec
//   在同一次 gate check 比对；dispose_steps 变化走 baseline-change-request 审批。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';
import { AgentRuntime } from '../../../src/agent/runtime/runtime';
import { SubAgentPool } from '../../../src/agent/coordinator';
import { ToolRegistry } from '../../../src/agent/tool';
import { scriptedProvider } from '../helpers/fixtures';
import { extractRuntimeWiring } from '../helpers/wiring';

/** 提取 runtime.ts 指定类的指定方法源文本（T0 静态检查用）。 */
function methodSource(className: string, methodName: string): string {
  const src = readFileSync(path.resolve(process.cwd(), 'src/agent/runtime/runtime.ts'), 'utf8');
  const sf = ts.createSourceFile('runtime.ts', src, ts.ScriptTarget.ES2021, true);
  for (const stmt of sf.statements) {
    if (!ts.isClassDeclaration(stmt) || stmt.name?.text !== className) continue;
    for (const m of stmt.members) {
      if (ts.isMethodDeclaration(m) && m.name.getText(sf) === methodName) return m.getText(sf);
    }
  }
  throw new Error(`[convergence] 未找到 ${className}.${methodName}`);
}

/** T0 豁免表：允许残留在 _disposeAgent 中的分散清理片段。新增必须附 progress.md 记录。 */
const T0_EXEMPTIONS: string[] = [];

/** _disposeAgent 中禁止出现的分散清理片段（验证计划 Phase 4 T0）。 */
const FORBIDDEN_FRAGMENTS = [
  '_lifecycleManagers', // 巡检 timer 经 ctx.effect 持有
  'unregister(', // bus/board 条目注销经 ctor/装配期 effect
  '.stop(', // lifecycle.stop 不再由 dispose 直接调用
  '_agentProxies.delete', // runtime maps 注销经 'runtime-maps' effect
  '_agentSessions.delete',
  '_agentTaskManagers.delete',
  'agents.delete',
];

describe('phase-4 T0 结构门禁 — 清理分支收敛到 context 所有权', () => {
  it('_disposeAgent 不含分散清理调用（除非登记豁免）', () => {
    const src = methodSource('AgentRuntime', '_disposeAgent');
    const forbidden = FORBIDDEN_FRAGMENTS.filter((f) => !T0_EXEMPTIONS.includes(f));
    const hits = forbidden.filter((f) => src.includes(f));
    expect(hits, `_disposeAgent 残留分散清理：${hits.join(' | ')}——应登记为 ctx.effect`).toEqual([]);
  });

  it('装配本体以 ctx.effect 登记所有权（board/lifecycle/runtime-maps ≥ 3 处）', () => {
    const src = methodSource('AgentRuntime', '_assembleAgent');
    const count = src.split('ctx.effect(').length - 1;
    expect(count, `_assembleAgent 仅 ${count} 处 ctx.effect——board-unregister/lifecycle-manager/runtime-maps 三类所有权必须登记`).toBeGreaterThanOrEqual(3);
  });

  it('dispose 步骤数 ≤ 16（Phase 0 基线 21）', () => {
    const w = extractRuntimeWiring();
    expect(w.disposeSteps.length, `当前 ${w.disposeSteps.length} 步——分散清理未收敛`).toBeLessThanOrEqual(16);
  });
});

describe('phase-4 T1 — dispose 顺序 trace（runtime 级）', () => {
  it('flush 计时器清 → bus/board flush → saveState → 逆序 effects（board → bus 注销）', async () => {
    const rt = new AgentRuntime();
    await rt.ready();
    const bus = rt.getBus();
    const board = rt.getTaskBoard(); // default 会话板（该 Agent 终生绑定）
    const busClear = vi.spyOn(bus, 'clearFlushTimer');
    const busFlush = vi.spyOn(bus, 'flush').mockResolvedValue(undefined);
    const busUnreg = vi.spyOn(bus, 'unregister');
    const boardClear = vi.spyOn(board, 'clearFlushTimer');
    const boardFlush = vi.spyOn(board, 'flush').mockResolvedValue(undefined);
    const boardUnreg = vi.spyOn(board, 'unregister');

    const h = await rt.createAgent({
      agentId: 'trace-agent',
      projectPath: '/projects/demo',
      provider: scriptedProvider([]),
      tools: new ToolRegistry(),
      systemPrompt: 'sys',
    });
    const agent = (h as unknown as { _getAgent(): { saveState: () => Promise<void> } })._getAgent();
    const saveState = vi.spyOn(agent, 'saveState').mockResolvedValue(undefined);

    h.dispose();

    const first = (s: ReturnType<typeof vi.spyOn>) => s.mock.invocationCallOrder[0];
    // 落盘前置：先清防抖计时器，再 flush
    expect(first(busClear)).toBeLessThan(first(busFlush));
    expect(first(boardClear)).toBeLessThan(first(boardFlush));
    // flush → saveState('done') → effects（context.dispose 在 saveState 之后）
    expect(first(busFlush)).toBeLessThan(first(saveState));
    expect(first(boardFlush)).toBeLessThan(first(saveState));
    expect(first(saveState)).toBeLessThan(first(busUnreg));
    // effects 逆序：bus-unregister（ctor 注册，晚于装配顶部的 board effect）
    // 先于 board-unregister 释放——与 Phase 4 前的相对顺序一致
    expect(first(busUnreg)).toBeLessThan(first(boardUnreg));
    // 同步快通道：dispose() 返回后注册表立即为空
    expect(rt.listAgents()).toHaveLength(0);
    expect(bus.getAgent('trace-agent')).toBeUndefined();
  });
});

describe('phase-4 T5 — create/dispose 百次循环无泄漏', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('100 次循环：每轮 +1 巡检 timer，dispose 归零；终态注册表/总线全空', async () => {
    vi.useFakeTimers();
    const rt = new AgentRuntime();
    await rt.ready();
    const pool = new SubAgentPool();
    expect(vi.getTimerCount()).toBe(0);
    for (let i = 0; i < 100; i++) {
      const h = await rt.createAgent({
        agentId: `t5-agent-${i}`,
        projectPath: '/projects/demo',
        provider: scriptedProvider([]),
        tools: new ToolRegistry(),
        subAgentPool: pool,
        systemPrompt: 'sys',
      });
      expect(vi.getTimerCount(), `第 ${i} 轮创建后 timer 数`).toBe(1);
      h.dispose();
      expect(vi.getTimerCount(), `第 ${i} 轮销毁后 timer 数`).toBe(0);
    }
    expect(rt.listAgents()).toHaveLength(0);
    expect(rt.getBus().listAgents()).toHaveLength(0);
  });
});
