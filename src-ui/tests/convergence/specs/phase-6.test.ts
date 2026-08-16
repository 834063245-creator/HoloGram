// Phase 6 — 组合层收尾的结构门禁与验收实证（主计划 §6 Phase 6）。
//
// T0 静态：
//   - AgentConfig 字段面冻结（31 字段，AST 取 PropertySignature）——组合扩展走
//     blueprint capability，新增 config 字段必须显式改此断言并登记 progress.md；
//   - _assembleAgent 零组合面直调——工具/hook 工厂、plan 接线、自动调优只出现在
//     blueprint.ts 的 capability 表；runtime 保留构造与生命周期所有权（Phase 4）；
//   - 缺省装配 = AgentBlueprint.standard()，表驱动（capabilities('context'|'agent')）。
// T1 原语行为：tests/blueprint.test.ts（6 例，随全量 vitest）。
// T2 验收实证（主计划验收"新增一个工具或 hook 不再要求修改 AgentConfig"）：
//   - 扩展蓝图注入新工具 → 出现在 Agent 工具面且标准面序不变（全程未碰 AgentConfig）；
//   - 空蓝图 → 工具面只剩输入注册表（装配面完全由 blueprint 决定）。
// T3：零新增 baseline——缺省装配面的字节契约由既有 phase-0/1 快照承担
//   （tool-schemas.effective 跑真实 createAgent 全注册；等价性锚在人类审批的
//   既有 baseline，同决策 #14）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AgentBlueprint } from '../../../src/agent/blueprint';
import { AgentContext } from '../../../src/agent/context';
import type { Hook } from '../../../src/agent/hooks';
import { AgentRuntime } from '../../../src/agent/runtime/runtime';
import { type Tool, ToolRegistry } from '../../../src/agent/tool';
import { readOnlyTool, scriptedProvider } from '../helpers/fixtures';

// ── T0 静态门禁 ──

/** 提取 runtime.ts 指定类的指定方法源文本（与 phase-4 spec 同款）。 */
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

/** AgentConfig 的字段名（声明序，AST PropertySignature）。 */
function agentConfigFieldNames(): string[] {
  const src = readFileSync(path.resolve(process.cwd(), 'src/agent/runtime/types.ts'), 'utf8');
  const sf = ts.createSourceFile('types.ts', src, ts.ScriptTarget.ES2021, true);
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === 'AgentConfig') {
      return stmt.members.filter(ts.isPropertySignature).map((m) => m.name.getText(sf));
    }
  }
  throw new Error('[convergence] 未找到 AgentConfig interface');
}

/** T0 豁免：允许 _assembleAgent 残留的组合面片段。新增必须附 progress.md 记录。 */
const T0_EXEMPTIONS: string[] = [];

/** 组合面片段（工厂/plan 接线/调优）——只能出现在 blueprint.ts 的 capability 表。 */
const FORBIDDEN_COMPOSITION = [
  'createEnterPlanModeTool',
  'createExitPlanModeTool',
  'createCommunicationTools',
  'createDiscoveryTools',
  'createMergeTool',
  'createBoardStatusTool',
  'createAgentKillTool',
  'createRequestTool',
  'createSubAgentTool',
  'createTaskTools',
  'new TaskManager(',
  'registerCompactionTools',
  'convergeRegistry',
  'createGraphContextHook',
  'createStateReadHook',
  'createGraphPreflightHook',
  'createStatePreflightHook',
  'createPlanExploreHook',
  'createPlanWriteHook',
  'createBoardTrackingHook',
  'loadEngineSnapshot',
  'setCompactionConfigPath',
  'setPlanState',
  'setPreRunHook',
  'PlanModeInjector',
  'applyAutoTuneConfig',
];

describe('phase-6 T0 结构门禁 — 组合面收敛到 blueprint capability 表', () => {
  it('AgentConfig 字段面冻结（31 字段 — 新增工具/hook 不再扩 config）', () => {
    expect(
      agentConfigFieldNames(),
      'AgentConfig 字段面漂移——组合扩展走 blueprint capability；确需新增 config 字段须改此断言并登记 progress.md',
    ).toEqual([
      'agentId',
      'parentId',
      'subagentDepth',
      'sessionId',
      'projectPath',
      'graphData',
      'provider',
      'tools',
      'memoryManager',
      'skillRegistry',
      'goalManager',
      'agentStore',
      'subAgentPool',
      'subAgentSpawner',
      'taskManager',
      'execState',
      'eventSink',
      'graphContext',
      'hooksEnabled',
      'isolationId',
      'temperature',
      'contextWindow',
      'pricing',
      'toolResultWindow',
      'collaborationMode',
      'systemPrompt',
      'preRunHook',
      'onSessionPersisted',
      'messageBus',
      'taskBoard',
      'discoveryBoard',
    ]);
  });

  it('_assembleAgent 零组合面直调（工具/hook 工厂与 plan 接线只在 capability 表）', () => {
    const src = methodSource('AgentRuntime', '_assembleAgent');
    const forbidden = FORBIDDEN_COMPOSITION.filter((f) => !T0_EXEMPTIONS.includes(f));
    const hits = forbidden.filter((f) => src.includes(f));
    expect(hits, `_assembleAgent 残留组合面直调：${hits.join(' | ')}——装配声明落在 blueprint.ts`).toEqual([]);
  });

  it('缺省装配 = AgentBlueprint.standard()，两阶段表驱动', () => {
    const src = methodSource('AgentRuntime', '_assembleAgent');
    expect(src, '缺省蓝图必须是 AgentBlueprint.standard()').toContain('AgentBlueprint.standard()');
    expect(src, '装配必须按 capability 表驱动（context 阶段）').toContain("blueprint.capabilities('context')");
    expect(src, '装配必须按 capability 表驱动（agent 阶段）').toContain("blueprint.capabilities('agent')");
  });
});

// ── T2 验收实证 ──

/** 验收探针工具 — 经扩展蓝图注入，全程不改 AgentConfig。 */
function probeTool(): Tool {
  return {
    name: () => 'acme_probe',
    description: () => 'phase-6 验收探针',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => true,
    execute: async () => 'ok',
  };
}

/** 手工 ctx（不经翻译层）+ 缺省 inputs，与 phase-3 T2 同构造。 */
function makeCtx(agentId: string, rt: AgentRuntime): AgentContext {
  const tools = new ToolRegistry();
  tools.register(readOnlyTool());
  return new AgentContext(
    { agentId, parentId: null, subagentDepth: 0, projectPath: '/projects/demo' },
    {
      provider: scriptedProvider([]),
      tools,
      eventSink: () => {},
      messageBus: rt.getBus(),
    },
  );
}

/** Agent 工具面（注册序）。 */
function agentToolNames(h: unknown): string[] {
  const agent = (h as { _getAgent(): { tools: ToolRegistry } })._getAgent();
  return agent.tools.all().map((t) => t.name());
}

describe('phase-6 T2 验收实证 — 新增工具/hook 不要求修改 AgentConfig', () => {
  it('扩展蓝图注入新工具 → 出现在 Agent 工具面，标准面序不变', async () => {
    const rt = new AgentRuntime();
    await rt.ready();

    // 基准：缺省（标准蓝图）装配的工具面
    const hStd = await rt.createAgentFromContext(makeCtx('p6-std', rt), {});
    const stdNames = agentToolNames(hStd);
    expect(stdNames.length).toBeGreaterThan(0);
    hStd.dispose();

    // 扩展：标准表尾部追加一个 capability（同时验证 hook 面可写）——AgentConfig 零改动
    let hookInstalled = false;
    const ext = AgentBlueprint.standard().add(
      {
        key: 'acme-probe-tool',
        phase: 'agent',
        install: (scope) => scope.tools.register(probeTool()),
      },
      {
        key: 'acme-probe-hook',
        phase: 'agent',
        install: (scope) => {
          const hook: Hook = {
            name: 'acme-probe-hook',
            shouldEnrich: () => false,
            enrich: async (_t, _a, result) => result,
          };
          scope.hooks.register(hook);
          hookInstalled = true;
        },
      },
    );
    const hExt = await rt.createAgentFromContext(makeCtx('p6-ext', rt), {}, ext);
    const extNames = agentToolNames(hExt);
    hExt.dispose();

    expect(extNames).toEqual([...stdNames, 'acme_probe']);
    expect(hookInstalled, 'hook capability 应经共享 registry 接线').toBe(true);
  });

  it('装配面完全由 blueprint 决定 — 空蓝图 → 工具面只剩输入注册表', async () => {
    const rt = new AgentRuntime();
    await rt.ready();
    const h = await rt.createAgentFromContext(makeCtx('p6-empty', rt), {}, new AgentBlueprint([]));
    expect(agentToolNames(h)).toEqual(['graph_summary']);
    h.dispose();
  });
});
