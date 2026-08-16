// Phase 1 — Disposer 契约的结构门禁（验证计划 §4 Phase 1 T0）+ F8 盲区快照。
//
// T0：注册 API 必须显式返回 Disposer（或登记豁免）。
// 行为测试（T1/T5）在 tests/lifecycle-disposer.test.ts 与 tests/tool-registry-disposer.test.ts；
// T3（Phase 0 快照不变）由 phase-0 spec 在同一次 gate check 中覆盖（默认跑全部 specs）。
//
// F8（审计发现）：createAgent 在 runtime.ts 里注册的工具（plan 工具/通信/discovery/
// 子 Agent 管理/task 替换/compaction）不在 tool-schemas.full 的覆盖内——本 spec 的
// tool-schemas.effective 快照用空输入注册表跑真实 createAgent，把这块盲区钉住。
// 注：快照是注册后的 schemas() 可见面；不含运行时 _schemaSelector 的 visibleToolsLimit
// 限额裁剪（那是按上下文动态决定的）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry, type Tool } from '../../../src/agent/tool';
import { HookRegistry, PreflightHookRegistry } from '../../../src/agent/hooks';
import { AgentRuntime } from '../../../src/agent/runtime/runtime';
import { SubAgentPool } from '../../../src/agent/coordinator';
import type { SubAgentSpawner } from '../../../src/agent/tools/subagent';
import { snapshot } from '../helpers/snapshot';
import { scriptedProvider } from '../helpers/fixtures';

/** T0 豁免清单：允许不返回 Disposer 的注册 API（格式：文件相对路径 + 方法名）。
 *  新增豁免必须在 progress.md 记录原因；当前为空。 */
const T0_EXEMPTIONS: string[] = [];

function readAgentSource(rel: string): string {
  return readFileSync(path.resolve(process.cwd(), 'src/agent', rel), 'utf8');
}

function expectRegisterReturnsDisposer(rel: string, pattern: RegExp, methodLabel: string): void {
  const exempt = T0_EXEMPTIONS.includes(methodLabel);
  const source = readAgentSource(rel);
  const ok = pattern.test(source);
  expect(
    ok || exempt,
    `${methodLabel} 必须返回 Disposer（${rel} 中未匹配 ${pattern}）${
      exempt ? '——已豁免' : '；这是 Phase 1 的 T0 结构门禁，若确需豁免请更新 T0_EXEMPTIONS 并在 progress.md 记录'
    }`,
  ).toBe(true);
}

describe('phase-1 T0 结构门禁 — 注册 API 返回 Disposer', () => {
  it('ToolRegistry.register 签名返回 Disposer', () => {
    expectRegisterReturnsDisposer('tool.ts', /register\(t: Tool\)\s*:\s*Disposer/, 'ToolRegistry.register');
  });

  it('HookRegistry.register 签名返回 Disposer', () => {
    expectRegisterReturnsDisposer('hooks.ts', /register\(hook: Hook\)\s*:\s*Disposer/, 'HookRegistry.register');
  });

  it('PreflightHookRegistry.register 签名返回 Disposer', () => {
    expectRegisterReturnsDisposer(
      'hooks.ts',
      /register\(hook: PreflightHook\)\s*:\s*Disposer/,
      'PreflightHookRegistry.register',
    );
  });

  it('运行时行为：register 实际返回可调用的清理器', () => {
    const reg = new ToolRegistry();
    const tool: Tool = {
      name: () => 'smoke',
      description: () => 'smoke',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => true,
      execute: async () => 'ok',
    };
    const d = reg.register(tool);
    expect(typeof d).toBe('function');
    d();
    expect(reg.names()).toEqual([]);

    const hooks = new HookRegistry();
    const dh = hooks.register({ name: 'h', shouldEnrich: () => false, enrich: async (_n, _a, r) => r });
    expect(typeof dh).toBe('function');

    const pre = new PreflightHookRegistry();
    const dp = pre.register({ name: 'p', shouldCheck: () => false, check: () => null });
    expect(typeof dp).toBe('function');
  });

  it('tool-schemas.effective — createAgent 运行时注册面（F8 盲区钉住）', async () => {
    const rt = new AgentRuntime(); // 无 projectPath → 纯内存 bus/boards，零持久化副作用
    await rt.ready();
    const stubSpawner = (async () => 'stub-spawn-result') as unknown as SubAgentSpawner;
    const handle = await rt.createAgent({
      projectPath: '/projects/demo',
      provider: scriptedProvider([]),
      tools: new ToolRegistry(), // 空输入：只钉 createAgent 自己注册的面
      subAgentPool: new SubAgentPool(),
      subAgentSpawner: stubSpawner,
      eventSink: () => {},
    });
    const agent = (
      handle as unknown as {
        _getAgent(): unknown;
      }
    )._getAgent() as { tools: ToolRegistry };
    const schemas = agent.tools.schemas();
    handle.dispose(); // 停 LifecycleManager 巡检 timer 等运行时资源
    snapshot('phase-1/tool-schemas.effective.json', {
      note: '空输入注册表跑真实 createAgent 后的 schemas()——钉 runtime 侧注册的工具面；引擎动态工具豁免同 phase-0 决策#1；不含 _schemaSelector 限额裁剪',
      count: schemas.length,
      schemas,
    });
  });
});
