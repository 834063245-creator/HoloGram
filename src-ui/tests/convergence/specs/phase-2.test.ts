// Phase 2 — 工具执行管道类型化事件（验证计划 §4 Phase 2 T0 + T3 等价证明）。
//
// T0：AGENT_EVENT_MAP 每个事件声明 mode 且 ∈ serial|parallel|waterfall|emit；
//     五个管道事件（guard/preflight/around/result/error）齐备。
// T3 等价：同一组 trace fixture（helpers/trace-fixtures.ts）以 pipeline 模式跑
//     StreamingToolExecutor，产出与 phase-0/hook-pipeline.trace.json —— 人类审批
//     冻结的 legacy 行为 —— 逐字节一致的 trace。这是"一个执行器、两条等价路径"
//     的收敛级证明（单元级 12 场景差分在 tests/tool-pipeline-events.test.ts）。
import { describe, expect, it } from 'vitest';
import { AGENT_EVENT_MAP, EVENT_MODES } from '../../../src/agent/events';
import { snapshot } from '../helpers/snapshot';
import { runTraceCase, traceCases } from '../helpers/trace-fixtures';

describe('phase-2 T0 结构门禁 — 事件声明', () => {
  it('每个事件声明合法 mode', () => {
    const events = Object.keys(AGENT_EVENT_MAP) as Array<keyof typeof AGENT_EVENT_MAP>;
    expect(events.length).toBeGreaterThanOrEqual(5);
    for (const name of events) {
      const mode = AGENT_EVENT_MAP[name].mode;
      expect(
        EVENT_MODES.includes(mode),
        `事件 ${name} 的 mode "${mode}" 非法——必须 ∈ ${EVENT_MODES.join('|')}（验证计划 Phase 2 T0）`,
      ).toBe(true);
    }
  });

  it('五个管道事件齐备（guard/preflight/around/result/error）', () => {
    for (const name of ['tool/guard', 'tool/preflight', 'tool/around', 'tool/result', 'tool/error'] as const) {
      expect(AGENT_EVENT_MAP[name], `缺少事件声明 ${name}`).toBeDefined();
    }
  });
});

describe('phase-2 T3 等价 — pipeline 路径对拍 phase-0 冻结 baseline', () => {
  it('同一 fixture 经 eventBus 路径产出与 legacy 冻结 trace 逐字节一致', async () => {
    const traces = [];
    for (const c of traceCases()) {
      traces.push(await runTraceCase(c, 'pipeline'));
    }
    // 直接写 phase-0 的快照名：与人类审批的 legacy 行为基线比对，而非另立 baseline
    snapshot('phase-0/hook-pipeline.trace.json', { count: traces.length, traces });
  });
});
