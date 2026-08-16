// Convergence 测试基建 — createAgent/_disposeAgent 装配事实的 AST 提取。
//
// 用途（验证计划 §4 Phase 0 / Phase 3 度量）：
//   - config.* 直读清单与数量（Phase 3 装配收敛的度量基线）
//   - effR/r.register 调用清单（注册点数量）
//   - newAgent.setX 接线调用清单
//   - _disposeAgent 顶层清理步骤（Phase 4 生命周期统一的度量基线）
// 只读源码文本，不 import 运行时 — 零副作用，跨机器确定性。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

export interface WiringFacts {
  configReads: string[];
  registerCalls: string[];
  setterCalls: string[];
  disposeSteps: string[];
}

export function extractWiringFromSource(
  source: string,
  methodNames: string[] = ['createAgent', '_disposeAgent'],
): WiringFacts {
  const sf = ts.createSourceFile('runtime.ts', source, ts.ScriptTarget.ES2021, true);
  const methods = new Map<string, ts.MethodDeclaration>();
  for (const stmt of sf.statements) {
    if (!ts.isClassDeclaration(stmt)) continue;
    for (const member of stmt.members) {
      if (ts.isMethodDeclaration(member) && member.body) {
        methods.set(member.name.getText(sf), member);
      }
    }
  }

  const facts: WiringFacts = { configReads: [], registerCalls: [], setterCalls: [], disposeSteps: [] };
  const seenConfig = new Set<string>();

  const walk = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'config') {
      const name = node.name.text;
      if (!seenConfig.has(name)) {
        seenConfig.add(name);
        facts.configReads.push(name);
      }
    }
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        (expr.expression.text === 'effR' || expr.expression.text === 'r') &&
        expr.name.text === 'register'
      ) {
        facts.registerCalls.push(describeRegisterArg(node.arguments[0], sf));
      }
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === 'newAgent'
      ) {
        facts.setterCalls.push(expr.name.text);
      }
    }
    node.forEachChild(walk);
  };
  // 多方法合并提取（Phase 3：度量可指向 _assembleAgent 等指定方法集）；
  // 缺失的方法跳过——度量对"方法不存在"不报错，由调用方断言结构。
  for (const name of methodNames) {
    methods.get(name)?.forEachChild(walk);
  }

  const disposeAgent = methods.get('_disposeAgent');
  if (disposeAgent?.body) {
    for (const st of disposeAgent.body.statements) {
      facts.disposeSteps.push(st.getText(sf).split('\n')[0].replace(/\s+/g, ' ').slice(0, 100));
    }
  }
  return facts;
}

function describeRegisterArg(arg: ts.Expression | undefined, sf: ts.SourceFile): string {
  if (!arg) return '<无参数>';
  if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) return `${arg.expression.text}(...)`;
  if (ts.isIdentifier(arg)) return `loop:${arg.text}`;
  return arg.getText(sf).split('\n')[0].slice(0, 60);
}

/** 读取当前 runtime.ts 并提取装配事实。
 *  import.meta.url 在部分 vite 转换管线里非 file scheme，故以 cwd 候选优先
 *  （vitest 的约定调用方式均以 src-ui 为 cwd），URL 解析作兜底。 */
export function extractRuntimeWiring(): WiringFacts {
  return extractRuntimeMethodWiring(['createAgent', '_disposeAgent']);
}

/** 读取当前 runtime.ts，按指定方法名集合提取装配事实（Phase 3 T0：
 *  度量指向 _assembleAgent / _contextFromConfig 等收敛后的结构位点）。 */
export function extractRuntimeMethodWiring(methodNames: string[]): WiringFacts {
  const candidates: string[] = [path.resolve(process.cwd(), 'src/agent/runtime/runtime.ts')];
  try {
    candidates.push(fileURLToPath(new URL('../../../src/agent/runtime/runtime.ts', import.meta.url)));
  } catch {
    // 非 file scheme 的转换管线 — 跳过，走 cwd 候选
  }
  const file = candidates.find((c) => existsSync(c));
  if (!file) {
    throw new Error(`[convergence] 找不到 runtime.ts（候选: ${candidates.join(' | ')}）— 请从 src-ui 目录运行 vitest`);
  }
  return extractWiringFromSource(readFileSync(file, 'utf8'), methodNames);
}

/** 人类可读的 wiring 报告（create-agent.wiring.txt 快照的格式）。 */
export function formatWiringReport(f: WiringFacts): string {
  const lines: string[] = [
    '# createAgent / _disposeAgent 装配清单（AST 静态提取）',
    '# 来源: src/agent/runtime/runtime.ts',
    '# 用途: Phase 3/4 收敛度量基线 — config.* 直读数、注册点数、setter 接线数、清理步骤数',
    '',
    `config_reads (${f.configReads.length}):`,
    ...f.configReads.map((n) => `  - ${n}`),
    '',
    `register_calls (${f.registerCalls.length}):`,
    ...f.registerCalls.map((n) => `  - ${n}`),
    '',
    `setter_wiring (${f.setterCalls.length}):`,
    ...f.setterCalls.map((n) => `  - ${n}`),
    '',
    `dispose_cleanup_steps (${f.disposeSteps.length}):`,
    ...f.disposeSteps.map((n) => `  - ${n}`),
  ];
  return lines.join('\n');
}
