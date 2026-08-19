// ui-react-retirement — 岛层退休终态守护（P3，2026-08-19 完成）
// 计划：docs/plans/ui-react-island-retirement-plan.md
// 终态断言：ui/react/ 目录不复存在；5 个退役事件名零残留；
// src/ 与 tests/ 不得再出现 ui/react 路径引用（防复发）。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RETIRED_EVENTS = [
  'agent:status',
  'agent:config-changed',
  'lang:changed',
  'timeline:refresh',
  'dataflow:saved',
] as const;

function listDir(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) {
      for (const f of listDir(join(root, e.name))) out.push(`${e.name}/${f}`);
    } else {
      out.push(e.name);
    }
  }
  return out;
}

describe('ui/react/ 岛层退休终态（docs/plans/ui-react-island-retirement-plan.md）', () => {
  it('ui/react/ 目录已清空删除', () => {
    expect(listDir(join(process.cwd(), 'src', 'ui', 'react'))).toEqual([]);
  });

  it('events.ts 不含 5 个退役事件名（已迁 zustand store）', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'ui', 'events.ts'), 'utf-8');
    for (const ev of RETIRED_EVENTS) {
      expect(src.includes(`'${ev}'`), `events.ts 仍含退役事件 ${ev}`).toBe(false);
    }
  });

  it('src/ 源码零 ui/react 路径引用（防复发）', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|css)$/.test(e.name)) {
          const c = readFileSync(p, 'utf-8');
          // 允许历史注释中出现字样，只拦真实 import/引用路径
          for (const line of c.split('\n')) {
            if (/from ['"][^'"]*ui\/react|import ['"][^'"]*ui\/react|\['\.\/react\//.test(line)) {
              hits.push(`${p}: ${line.trim()}`);
            }
          }
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(hits, `发现 ui/react 路径引用（退休复发）：\n${hits.join('\n')}`).toEqual([]);
  });
});
