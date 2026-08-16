// Convergence 测试基建 — 差分骨架（Phase 2 起的核心）。
//
// 用途：同一输入分别跑 legacy 路径与新路径，逐行比较稳定序列化结果。
// 纪律（验证计划 §7.2）：legacy 与 next 各自独立构建夹具实例，
// 不得共享同一 registry/hook 对象 — 防止两条路径共享同一个 bug。
import { stableStringify } from './normalize';

export interface DiffOutcome {
  ok: boolean;
  differences: string[];
}

/** 结构差分：稳定序列化后逐行比对，报告差异行（上限 20 条，防刷屏）。 */
export function diffValues(legacy: unknown, next: unknown): DiffOutcome {
  const a = stableStringify(legacy).split('\n');
  const b = stableStringify(next).split('\n');
  const differences: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && differences.length < 20; i++) {
    const la = a[i] ?? '<缺失>';
    const lb = b[i] ?? '<缺失>';
    if (la !== lb) differences.push(`第 ${i + 1} 行 legacy=${la} | new=${lb}`);
  }
  return { ok: differences.length === 0, differences };
}

/** 双路径执行 + 差分。两个工厂各自独立执行（分别 await，不并发共享状态）。 */
export async function runDifferential<T>(legacy: () => Promise<T>, next: () => Promise<T>): Promise<DiffOutcome> {
  const a = await legacy();
  const b = await next();
  return diffValues(a, b);
}
