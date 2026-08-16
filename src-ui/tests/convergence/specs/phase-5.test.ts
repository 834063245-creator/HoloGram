// Phase 5 — 会话事件溯源的结构门禁与行为验证（验证计划 §4 Phase 5）。
//
// T0 静态：
//   - agent.ts 对 session 数组的直改（push/splice/赋值）只允许出现在三个双写入口
//     （_appendMessage / _replaceSession / _retractSessionRange）与构造初始化内
//     —— AST 按方法定位，比 gate.mjs 的计数扫描更强；
//   - session event 类型封闭可扩展（SESSION_EVENT_KINDS 冻结 + 主计划 7 kind 齐备）；
//   - seq 严格递增由运行检查保证（appendEvent 重复/乱序拒绝）。
// T0 接线：createAgentFromContext 物化 sessionLog 服务，Agent.getSessionLog 与
//   ctx 持有同一实例（Phase 3 服务表语义）。
// T2 差分矩阵在 tests/session-differential.test.ts（全量 vitest 覆盖）；
// T3 契约快照 session-projection.trace.json 由 freeze commit 落地（本文件追加）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/agent/runtime/runtime';
import { SESSION_EVENT_KINDS, SessionLog } from '../../../src/agent/session-log';
import { ToolRegistry } from '../../../src/agent/tool';
import { scriptedProvider } from '../helpers/fixtures';

/** 读取 src/agent/agent.ts 的 AST（含每个方法名 → 源文本范围映射）。 */
function agentClassMethods(): Map<string, ts.Node> {
  const src = readFileSync(path.resolve(process.cwd(), 'src/agent/agent.ts'), 'utf8');
  const sf = ts.createSourceFile('agent.ts', src, ts.ScriptTarget.ES2021, true);
  for (const stmt of sf.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === 'Agent') {
      const map = new Map<string, ts.Node>();
      for (const m of stmt.members) {
        const name = ts.isMethodDeclaration(m)
          ? m.name?.getText(sf)
          : ts.isConstructorDeclaration(m)
            ? '<constructor>'
            : undefined;
        if (name) map.set(name, m);
      }
      return map;
    }
  }
  throw new Error('[convergence] 未找到 Agent 类');
}

/** this.session 成员访问判定（`this.session` — 两层属性访问的最内层）。 */
function isThisSessionAccess(e: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword && e.name.text === 'session'
  );
}

/** 数组变异方法（其余 this.session.xxx() 调用均为只读投影）。 */
const SESSION_MUTATORS = new Set(['push', 'splice', 'pop', 'shift', 'unshift', 'sort', 'reverse', 'fill']);

/** 方法体内对 this.session 的直改表达式（变异方法调用 / 赋值）。 */
function sessionDirectWrites(method: ts.Node): string[] {
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    // this.session.xxx(...) 形态：callee = <this.session>.xxx
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      if (isThisSessionAccess(callee.expression) && SESSION_MUTATORS.has(callee.name.text)) {
        hits.push(`this.session.${callee.name.text}()`);
      }
    }
    // this.session = … 形态
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (isThisSessionAccess(node.left as ts.Expression)) {
        hits.push('this.session = …');
      }
    }
    node.forEachChild(visit);
  };
  method.forEachChild(visit);
  return hits;
}

/** T0 豁免：允许直改 session 的方法（双写入口 + 构造初始化）。新增必须附 progress.md 记录。 */
const T0_ALLOWED_METHODS = new Set([
  '<constructor>', // 初始化空数组（_replaceSession 前置）
  '_appendMessage', // 双写入口：append 事件 + push 投影
  '_replaceSession', // 双写入口：append reset 事件 + 整体替换
  '_retractSessionRange', // 双写入口：append retract 事件 + splice 投影
]);

describe('phase-5 T0 结构门禁 — session 变异收敛到双写入口', () => {
  it('agent.ts 直改 session 只出现在双写入口与构造初始化（AST 定位）', () => {
    const methods = agentClassMethods();
    expect(methods.size).toBeGreaterThan(10);
    const violations: string[] = [];
    for (const [name, node] of methods) {
      if (T0_ALLOWED_METHODS.has(name)) continue;
      const hits = sessionDirectWrites(node);
      for (const h of hits) violations.push(`${name}: ${h}`);
    }
    expect(violations, `直改 session 的残留点：${violations.join(' | ')}——必须经双写入口先入事件日志`).toEqual([]);
  });

  it('双写入口齐备（三个入口方法存在且各自恰好一次直改）', () => {
    const methods = agentClassMethods();
    const append = methods.get('_appendMessage');
    const replace = methods.get('_replaceSession');
    const retract = methods.get('_retractSessionRange');
    expect(append, '_appendMessage 入口缺失').toBeDefined();
    expect(replace, '_replaceSession 入口缺失').toBeDefined();
    expect(retract, '_retractSessionRange 入口缺失').toBeDefined();
    if (!append || !replace || !retract) throw new Error('双写入口缺失');
    expect(sessionDirectWrites(append)).toEqual(['this.session.push()']);
    expect(sessionDirectWrites(replace)).toEqual(['this.session = …']);
    expect(sessionDirectWrites(retract)).toEqual(['this.session.splice()']);
  });

  it('session event 类型封闭可扩展：冻结集合 + 主计划 7 kind 齐备', () => {
    expect(Object.isFrozen(SESSION_EVENT_KINDS)).toBe(true);
    for (const k of [
      'turn/start',
      'user/message',
      'assistant/text',
      'assistant/reasoning',
      'tool/call',
      'tool/result',
      'session/compaction',
    ] as const) {
      expect(SESSION_EVENT_KINDS, `缺少主计划规定的 kind: ${k}`).toContain(k);
    }
  });

  it('seq 严格递增由运行检查保证：重复 append 即拒绝', () => {
    const log = new SessionLog();
    const e1 = log.append('user/message', { message: { role: 'user', content: 'x' } });
    expect(() => log.appendEvent(e1)).toThrow(/重复\/乱序 append 拒绝/);
    expect(log.size).toBe(1);
  });
});

describe('phase-5 T0 接线 — sessionLog 服务物化', () => {
  it('createAgentFromContext 物化 sessionLog，Agent.getSessionLog 与 ctx 同一实例', async () => {
    const rt = new AgentRuntime();
    await rt.ready();
    const h = await rt.createAgent({
      agentId: 'p5-wiring-agent',
      projectPath: '/projects/demo',
      provider: scriptedProvider([]),
      tools: new ToolRegistry(),
      systemPrompt: 'sys',
    });
    const ctx = (
      h as unknown as { _getContext(): { get(name: 'sessionLog'): SessionLog | undefined } | null }
    )._getContext();
    const agent = (h as unknown as { _getAgent(): { getSessionLog(): SessionLog } })._getAgent();
    const logFromCtx = ctx?.get('sessionLog') as SessionLog | undefined;
    expect(logFromCtx, 'ctx 未物化 sessionLog 服务').toBeDefined();
    expect(agent.getSessionLog()).toBe(logFromCtx);
    // 构造期的 system prompt 已按 reset 事件入日志，投影等价
    expect(agent.getSessionLog().deriveMessages()).toEqual(agent.getSession());
    h.dispose();
  });
});
