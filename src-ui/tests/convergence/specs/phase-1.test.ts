// Phase 1 — Disposer 契约的结构门禁（验证计划 §4 Phase 1 T0）。
//
// T0：注册 API 必须显式返回 Disposer（或登记豁免）。
// 行为测试（T1/T5）在 tests/lifecycle-disposer.test.ts 与 tests/tool-registry-disposer.test.ts；
// T3（Phase 0 快照不变）由 phase-0 spec 在同一次 gate check 中覆盖（默认跑全部 specs）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry, type Tool } from '../../../src/agent/tool';
import { HookRegistry, PreflightHookRegistry } from '../../../src/agent/hooks';

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
});
