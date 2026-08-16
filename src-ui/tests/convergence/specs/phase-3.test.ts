// Phase 3 — AgentContext 抽取的结构门禁与双入口差分（验证计划 §4 Phase 3）。
//
// T0 结构度量：
//   - createAgent 的 config.* 直读数 ≤ 15（Phase 0 基线 26 的 -40% 验收线；
//     主计划 §6 Phase 3 验收"直接字段赋值数量至少下降 40%"）；
//   - 装配本体 _assembleAgent 零 config.* 直读 — 装配只消费 AgentContext +
//     AgentAssemblyInputs，AgentConfig 的唯一消费点是 _contextFromConfig 翻译层；
//   - AgentContext 公共成员（字段/方法/访问器/构造器）必须有 JSDoc。
//
// T2 差分：同一输入分别走旧 AgentConfig 入口与新 AgentContext 入口（ctx 手工
// 构造，不经翻译层），生成同一 AgentSummary / 同一工具 schema 面 / 同一 system
// prompt —— 证明收敛没有丢字段、没有隐藏的 config 依赖。
//
// T3：tool-schemas.* / system-prompt.fixture 由 phase-0 spec 在同一次 gate check
// 中比对（字节不变）；create-agent.wiring.txt 的变化走 baseline-change-request
// 人类审批流程（Phase 3 目的即 wiring 收敛，漂移是预期产物）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AgentContext } from '../../../src/agent/context';
import { SubAgentPool } from '../../../src/agent/coordinator';
import { AgentRuntime } from '../../../src/agent/runtime/runtime';
import type { AgentConfig } from '../../../src/agent/runtime/types';
import { ToolRegistry } from '../../../src/agent/tool';
import type { SubAgentSpawner } from '../../../src/agent/tools/subagent';
import { fsDomainTool, readOnlyTool, scriptedProvider } from '../helpers/fixtures';
import { stableStringify } from '../helpers/normalize';
import { extractRuntimeMethodWiring, extractRuntimeWiring } from '../helpers/wiring';

// ── T0 结构门禁 ──

describe('phase-3 T0 结构门禁 — 装配收敛', () => {
  it('createAgent 的 config.* 直读数 ≤ 15（基线 26 的 -40% 验收线）', () => {
    const w = extractRuntimeWiring();
    expect(
      w.configReads.length,
      `createAgent 直读 ${w.configReads.length} 个 config 字段（${w.configReads.join(', ')}）——超出 Phase 3 验收线`,
    ).toBeLessThanOrEqual(15);
  });

  it('createAgent 是纯翻译层 — 零直接注册/零 setter 接线', () => {
    const w = extractRuntimeWiring();
    expect(w.registerCalls, `createAgent 内出现 effR/r.register：${w.registerCalls.join(', ')}`).toEqual([]);
    expect(w.setterCalls, `createAgent 内出现 newAgent.* 接线：${w.setterCalls.join(', ')}`).toEqual([]);
  });

  it('装配本体 _assembleAgent 零 config.* 直读（ctx + inputs 是唯一来源）', () => {
    const w = extractRuntimeMethodWiring(['_assembleAgent']);
    expect(
      w.configReads,
      `_assembleAgent 直读了 config 字段：${w.configReads.join(', ')}——装配不得依赖 AgentConfig，先经 _contextFromConfig 翻译`,
    ).toEqual([]);
  });

  it('config 消费面完整迁移 — Phase 0 基线的全部 26 个字段都在翻译层消费', () => {
    // 防字段漏配：旧 createAgent 消费的 26 个 config 字段（phase-0 wiring 基线）
    // 必须全部出现在 _contextFromConfig 的翻译面里。漏一个 = 该字段被静默丢弃
    // （execState 漏配就是以此方式被人工发现的，此断言把这类回归挡在门禁）。
    const w = extractRuntimeMethodWiring(['_contextFromConfig']);
    const translated = new Set(w.configReads);
    const expected = [
      'agentId', 'sessionId', 'parentId', 'systemPrompt', 'memoryManager', 'graphData',
      'projectPath', 'provider', 'tools', 'collaborationMode', 'eventSink', 'execState',
      'onSessionPersisted', 'pricing', 'temperature', 'contextWindow', 'subagentDepth',
      'toolResultWindow', 'isolationId', 'agentStore', 'goalManager', 'subAgentPool',
      'subAgentSpawner', 'graphContext', 'hooksEnabled', 'preRunHook',
    ];
    const missing = expected.filter((f) => !translated.has(f));
    expect(missing, `翻译层漏掉了 config 字段：${missing.join(', ')}`).toEqual([]);
  });

  it('AgentContext 公共成员均有 JSDoc', () => {
    const file = path.resolve(process.cwd(), 'src/agent/context.ts');
    const src = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile('context.ts', src, ts.ScriptTarget.ES2021, true);
    const missing: string[] = [];
    for (const stmt of sf.statements) {
      if (!ts.isClassDeclaration(stmt) || stmt.name?.text !== 'AgentContext') continue;
      for (const m of stmt.members) {
        if (
          !ts.isPropertyDeclaration(m) &&
          !ts.isMethodDeclaration(m) &&
          !ts.isGetAccessorDeclaration(m) &&
          !ts.isConstructorDeclaration(m)
        ) {
          continue;
        }
        const name = ts.isConstructorDeclaration(m) ? 'constructor' : m.name.getText(sf);
        const isPrivate = name.startsWith('_') || m.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.PrivateKeyword);
        if (isPrivate) continue;
        const ranges = ts.getLeadingCommentRanges(src, m.pos);
        const hasJsdoc = ranges?.some((r) => src.slice(r.pos, r.pos + 3) === '/**') ?? false;
        if (!hasJsdoc) missing.push(name);
      }
    }
    expect(missing, `AgentContext 公共成员缺 JSDoc：${missing.join(', ')}（验证计划 Phase 3 T0）`).toEqual([]);
  });
});

// ── T2 双入口差分 ──

interface AgentCapture {
  summary: unknown;
  schemas: unknown[];
  systemPrompt: string;
}

const stubSpawner = (async () => 'stub-spawn-result') as unknown as SubAgentSpawner;

function diffInputTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(readOnlyTool());
  tools.register(fsDomainTool());
  return tools;
}

async function captureAgent(rt: AgentRuntime, agentId: string): Promise<AgentCapture> {
  const h = rt.getAgent(agentId);
  if (!h) throw new Error(`agent ${agentId} 不存在`);
  const agent = (
    h as unknown as { _getAgent(): { tools: ToolRegistry; getSession(): Array<{ content: string }> } }
  )._getAgent();
  return {
    summary: rt.listAgents().find((s) => s.id === agentId),
    schemas: agent.tools.schemas(),
    systemPrompt: agent.getSession()[0]?.content ?? '',
  };
}

describe('phase-3 T2 差分 — AgentConfig 入口 vs AgentContext 入口', () => {
  it('同一输入经两入口生成同一 AgentSummary / 工具面 / system prompt', async () => {
    const rt = new AgentRuntime(); // 无 projectPath → 纯内存 bus/boards，零持久化副作用
    await rt.ready();
    const agentId = 'phase3-diff-agent';

    // 路径 A：旧 AgentConfig 入口
    const config: AgentConfig = {
      agentId,
      projectPath: '/projects/demo',
      provider: scriptedProvider([]),
      tools: diffInputTools(),
      subAgentPool: new SubAgentPool(),
      subAgentSpawner: stubSpawner,
      eventSink: () => {},
    };
    const hA = await rt.createAgent(config);
    const viaConfig = await captureAgent(rt, agentId);
    hA.dispose();

    // 路径 B：新 AgentContext 入口 — ctx 手工构造，不经 _contextFromConfig，
    // 证明装配本体的依赖面就是 ctx + inputs，没有隐藏的 config 通路。
    const ctx = new AgentContext(
      { agentId, parentId: null, subagentDepth: 0, projectPath: '/projects/demo' },
      {
        provider: scriptedProvider([]),
        tools: diffInputTools(),
        eventSink: () => {},
        subAgentPool: new SubAgentPool(),
        messageBus: rt.getBus(),
      },
    );
    const hB = await rt.createAgentFromContext(ctx, { subAgentSpawner: stubSpawner });
    const viaContext = await captureAgent(rt, agentId);
    hB.dispose();

    expect(stableStringify(viaContext.schemas)).toBe(stableStringify(viaConfig.schemas));
    expect(viaContext.systemPrompt).toBe(viaConfig.systemPrompt);
    expect(viaContext.summary).toEqual(viaConfig.summary);
  });
});
