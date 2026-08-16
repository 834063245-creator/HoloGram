// Convergence 测试基建 — baseline 采集与比对。
//
// 防自证协议（验证计划 §3）：
//   - 默认模式（无 CONVERGENCE_RECORD）：baseline 只读，逐行比对，漂移即失败；
//   - record 模式（CONVERGENCE_RECORD=1，仅 gate.mjs record 触发）：重写 baseline，
//     只允许出现在人类审批的 baseline 专用提交中；
//   - 实现期发现 baseline 漂移 → 停止实现，输出 baseline-change-request.md。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeVolatileText, stableStringify } from './normalize';

/** 记录或比对一份契约快照。name 相对 tests/convergence/baseline/（如 'phase-0/xx.json'）。 */
export function snapshot(name: string, actual: unknown): void {
  const file = resolveBaselinePath(name);
  const serialized = typeof actual === 'string' ? normalizeVolatileText(actual) : stableStringify(actual);

  if (process.env.CONVERGENCE_RECORD === '1') {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${serialized}\n`, 'utf8');
    return;
  }

  if (!existsSync(file)) {
    throw new Error(
      `[convergence] baseline 缺失: ${name}。baseline 由 freeze commit 生成；` +
        '实现期不允许自行 record（防自证），需要新增/重建快照时先停下来问人类。',
    );
  }
  const expected = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  const { ok, line, context } = compareText(expected, serialized);
  if (!ok) {
    throw new Error(
      `[convergence] baseline 漂移: ${name}（首个差异在第 ${line} 行）\n${context}\n` +
        '— 若该行为变化不是本 phase 的目标：修代码。若确认需要变更模型可见表面：' +
        '停止实现，写 baseline-change-request.md 交人类审批，禁止直接 record 覆盖。',
    );
  }
}

/** baseline 文件绝对路径解析。
 *  注意：不能写 `new URL(字面量, import.meta.url)` — Vite 会对该模式做静态改写，
 *  把结果指到 dev server origin（http://localhost:3000）。经中间变量绕开改写后，
 *  运行时 import.meta.url 是正确的 file URL。cwd 候选兜底（vitest 以 src-ui 为 cwd）。 */
function resolveBaselinePath(name: string): string {
  const baseUrl = import.meta.url;
  try {
    return fileURLToPath(new URL(`../baseline/${name}`, baseUrl));
  } catch {
    return path.resolve(process.cwd(), 'tests/convergence/baseline', name);
  }
}

/** 逐行文本比对，返回首个差异位置与 ±3 行上下文。gate 检测的核心，自身被测试覆盖。 */
export function compareText(expected: string, actual: string): { ok: boolean; line: number; context: string } {
  const expLines = expected.split('\n');
  const actLines = actual.split('\n');
  const max = Math.max(expLines.length, actLines.length);
  for (let i = 0; i < max; i++) {
    const e = expLines[i] ?? '<缺失>';
    const a = actLines[i] ?? '<缺失>';
    if (e !== a) {
      const lines: string[] = [];
      const from = Math.max(0, i - 3);
      const to = Math.min(i + 3, max - 1);
      for (let j = from; j <= to; j++) {
        const mark = j === i ? '!' : ' ';
        lines.push(`${mark} 第 ${j + 1} 行 期望: ${expLines[j] ?? '<缺失>'}`);
        lines.push(`${mark} 第 ${j + 1} 行 实际: ${actLines[j] ?? '<缺失>'}`);
      }
      return { ok: false, line: i + 1, context: lines.join('\n') };
    }
  }
  return { ok: true, line: 0, context: '' };
}
