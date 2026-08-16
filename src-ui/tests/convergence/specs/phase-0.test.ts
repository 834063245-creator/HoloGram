// Phase 0 — 契约快照（验证计划 §4 Phase 0 / §2 gate.mjs check 的比对主体）。
//
// 默认模式：与 baseline/phase-0/ 下的人类审批快照逐行比对，漂移即失败。
// record 模式（CONVERGENCE_RECORD=1，仅经 gate.mjs record 触发）：重写 baseline。
// 快照覆盖（验证计划 §4 Phase 0 T3 清单）：
//   tool-schemas.full / tool-schemas.plan / system-prompt.fixture /
//   plan-gate.decisions / hook-pipeline.trace / create-agent.wiring
import { describe, expect, it } from 'vitest';
import { planGateCheck, planRegistry } from '../../../src/agent/plan/plan-registry';
import { PlanStateManager } from '../../../src/agent/plan/plan-state';
import { buildSystemPrompt } from '../../../src/agent/runtime/agent-builder';
import { runDifferential } from '../helpers/differential';
import {
  agentDomainTool,
  buildStandardRegistry,
  FIXED_GRAPH_DATA,
  fixedGraphSnapshot,
  fsDomainTool,
  readOnlyTool,
  throwingTool,
} from '../helpers/fixtures';
import { stableStringify } from '../helpers/normalize';
import { compareText, snapshot } from '../helpers/snapshot';
import { runTraceCase, traceCases } from '../helpers/trace-fixtures';
import { extractRuntimeWiring, formatWiringReport } from '../helpers/wiring';

describe('phase-0 契约快照', () => {
  it('tool-schemas.full — 标准 buildToolRegistry 的模型可见工具面', async () => {
    const reg = await buildStandardRegistry();
    const schemas = reg.schemas();
    snapshot('phase-0/tool-schemas.full.json', {
      note: '引擎动态工具（hologram_tools_list）测试环境恒为空，不在本快照内；本快照钉住静态注册面',
      count: schemas.length,
      schemas,
    });
  });

  it('tool-schemas.plan — planRegistry 静态只读克隆工具面', async () => {
    const base = await buildStandardRegistry();
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const planReg = planRegistry(base, ps);
    const schemas = planReg.schemas();
    snapshot('phase-0/tool-schemas.plan.json', {
      count: schemas.length,
      schemas,
    });
  });

  it('system-prompt.fixture — 固定输入的 buildSystemPrompt', () => {
    const withGraph = buildSystemPrompt(
      FIXED_GRAPH_DATA,
      '/projects/demo',
      '### 固定记忆段落\n- 记忆条目 A',
      fixedGraphSnapshot(),
      '### CLAUDE.md 固定内容\n- 规范条目 A',
      'deepseek',
      '- OS: win32\n- Shell: bash (Git Bash)',
    );
    const noGraph = buildSystemPrompt(null, '/projects/demo', '', '', '', undefined, '');
    snapshot('phase-0/system-prompt.fixture.json', {
      withGraphLength: withGraph.length,
      withGraph,
      noGraphLength: noGraph.length,
      noGraph,
    });
  });

  it('plan-gate.decisions — 固定矩阵的 planGateCheck 判定', () => {
    const ps = new PlanStateManager();
    const planFile = ps.enter('/proj');
    const matrix: Array<{ label: string; active: boolean; name: string; args: Record<string, unknown>; tool: Tool }> = [
      {
        label: '未激活-fs写放行',
        active: false,
        name: 'fs',
        args: { action: 'write', filePath: '/proj/a.ts' },
        tool: fsDomainTool(),
      },
      { label: '未激活-非只读放行', active: false, name: 'analyze_project', args: {}, tool: throwingTool() },
      { label: '激活-只读工具放行', active: true, name: 'graph_summary', args: {}, tool: readOnlyTool() },
      {
        label: '激活-领域只读动作放行',
        active: true,
        name: 'fs',
        args: { action: 'read', filePath: '/proj/a.ts' },
        tool: fsDomainTool(),
      },
      {
        label: '激活-领域写动作拦截',
        active: true,
        name: 'fs',
        args: { action: 'write', filePath: '/proj/a.ts' },
        tool: fsDomainTool(),
      },
      {
        label: '激活-fs写命中计划文件豁免',
        active: true,
        name: 'fs',
        args: { action: 'write', filePath: planFile },
        tool: fsDomainTool(),
      },
      {
        label: '激活-fs编辑path别名命中计划文件豁免',
        active: true,
        name: 'fs',
        args: { action: 'edit', path: planFile },
        tool: fsDomainTool(),
      },
      {
        label: '激活-agent spawn放行',
        active: true,
        name: 'agent',
        args: { action: 'spawn', description: 'explore' },
        tool: agentDomainTool(),
      },
      {
        label: '激活-agent kill拦截',
        active: true,
        name: 'agent',
        args: { action: 'kill', id: 'sub-1' },
        tool: agentDomainTool(),
      },
      { label: '激活-非领域非只读拦截', active: true, name: 'analyze_project', args: {}, tool: throwingTool() },
    ];
    const decisions = matrix.map((c) => {
      const state = c.active ? ps : null;
      const d = planGateCheck(state, c.name, c.args, c.tool);
      return { label: c.label, name: c.name, args: c.args, decision: d === null ? 'allow' : d };
    });
    snapshot('phase-0/plan-gate.decisions.json', { count: decisions.length, decisions });
  });

  it('hook-pipeline.trace — StreamingToolExecutor 固定事件顺序与输出', async () => {
    const traces = [];
    for (const c of traceCases()) {
      traces.push(await runTraceCase(c));
    }
    snapshot('phase-0/hook-pipeline.trace.json', { count: traces.length, traces });
  });

  it('create-agent.wiring — createAgent/_disposeAgent 装配 AST 清单', () => {
    snapshot('phase-0/create-agent.wiring.txt', formatWiringReport(extractRuntimeWiring()));
  });
});

// ── 机制自检：比对器自身被测（验证计划 §7.4 — 门禁脚本要有会故意失败的小 spec）──

describe('snapshot 机制自检', () => {
  it('compareText 检出首个差异行并给出上下文', () => {
    const r = compareText('a\nb\nc', 'a\nX\nc');
    expect(r.ok).toBe(false);
    expect(r.line).toBe(2);
    expect(r.context).toContain('X');
    expect(r.context).toContain('期望: b');
    expect(compareText('same\nsame', 'same\nsame').ok).toBe(true);
  });

  it('stableStringify 排序 key 且归一计划 id / ISO 时间戳', () => {
    const s = stableStringify({
      b: 1,
      a: { y: 'plan-1720000000000-ab12', x: '2026-08-15T00:00:00.000Z' },
    });
    const aIdx = s.indexOf('"a"');
    const bIdx = s.indexOf('"b"');
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(s).toContain('plan-<id>');
    expect(s).toContain('<iso-ts>');
  });

  it('runDifferential：相同输入 ok，不同输入报告差异行', async () => {
    const same = await runDifferential(
      async () => ({ output: 'x', truncated: false }),
      async () => ({ output: 'x', truncated: false }),
    );
    expect(same.ok).toBe(true);
    const diff = await runDifferential(
      async () => ({ output: 'legacy', truncated: false }),
      async () => ({ output: 'new', truncated: false }),
    );
    expect(diff.ok).toBe(false);
    expect(diff.differences[0]).toContain('legacy');
  });
});
