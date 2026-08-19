// eventbus-zero-and-ui-split — P0 立项守护测试
// 计划：docs/plans/eventbus-zero-and-ui-split-plan.md
// 三重只减不增门禁 + 终态断言：
//   ① events.ts 事件名 ⊆ 11 基线（总线只减不增）
//   ② ui/ 文件 ⊆ 59 文件 manifest（目录只减不增；新 store 一律去 state/，禁止落 ui/）
//   ③ app/** 的 ui/events import 仅允许过渡期豁免面（chat-core / bridge-adapters）
// P3 收口时把 COMPLETE 翻为 true，终态断言生效。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// P3（2026-08-19）翻真：P1 事件归零 + P2 物理拆分均已完成，终态断言生效。
const COMPLETE = true;

/** P0 基线（2026-08-19）：剩余 11 事件。只能扣减。 */
const BASELINE_EVENTS = [
  'agent:diag',
  'agent:tool-done',
  'prompt:ask',
  'chat:turn-done',
  'goal:state',
  'check:result',
  'graph:node-clicked',
  'graph:rendered',
  'highlight:file',
  'navigate:file',
  'workspace:switched',
] as const;

/** 过渡期豁免：app/** 内允许 import ui/events 的文件（两者都随 P1 消亡）。 */
const APP_EVENTS_IMPORT_ALLOWLIST = new Set(['src/app/chat/chat-core.ts', 'src/app/bridge-adapters.ts']);

/** P0 基线（2026-08-19）：ui/ 全量 59 文件。只能扣减（graph.ts 允许变 shim 但文件名保留）。
 * P3 收口追加登记 'README.md'（目录定位文档，计划 P3 文档回写项，非代码）。 */
const UI_MANIFEST = [
  'README.md',
  'agent-config-store.ts',
  'agent-panel-store.ts',
  'agent-visualizer.ts',
  'app-shell.ts',
  'chat-session.ts',
  'chat-store.ts',
  'chat-stream.ts',
  'chat-utils.ts',
  'command-registry.ts',
  'context-menu.ts',
  'dataflow-store.ts',
  'debug.ts',
  'dock-config.ts',
  'dock-store.ts',
  'events.ts',
  'file-translator.css',
  'file-translator.ts',
  'file-viewer.tsx',
  'gpu-layout.ts',
  'graph.ts',
  'graph-analysis.ts',
  'graph-colors.ts',
  'graph-diff-overlay.ts',
  'graph-edge-renderer.ts',
  'graph-focus-controller.ts',
  'graph-fold.ts',
  'graph-fx.ts',
  'graph-glow-instanced.ts',
  'graph-highlight.ts',
  'graph-interaction.ts',
  'graph-interaction-controller.ts',
  'graph-labels.ts',
  'graph-layout.ts',
  'graph-node-renderer.ts',
  'graph-scene.ts',
  'graph-scene-lifecycle.ts',
  'graph-shaders.ts',
  'graph-textures.ts',
  'graph-tooltip.ts',
  'graph-types.ts',
  'graph-ui.ts',
  'icons.ts',
  'input-store.ts',
  'lsp-client.ts',
  'markdown-file-preview.tsx',
  'message-height.ts',
  'message-model.ts',
  'messages-store.ts',
  'overlay-store.ts',
  'panel-store.ts',
  'part-mutator.ts',
  'pretext-cache.ts',
  'resize-zones.ts',
  'runtime-adapter.ts',
  'scoped-store.ts',
  'session-store.ts',
  'subagent-sink.ts',
  'timeline-store.ts',
  'tool-semantics.ts',
];

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) {
      for (const f of listFiles(join(root, e.name))) out.push(`${e.name}/${f}`);
    } else {
      out.push(e.name);
    }
  }
  return out;
}

/** 从 events.ts 提取 BusEvents 接口里的事件名（'xxx:yyy': 形式的键）。 */
function extractEventNames(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*['"]([a-z-]+:[a-z-]+)['"]\s*:/gm)) out.push(m[1]);
  return out;
}

function findEventsImports(root: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const rel = p.replace(/\\/g, '/').replace(/^.*\/src\//, 'src/');
        for (const line of readFileSync(p, 'utf-8').split('\n')) {
          if (/from ['"][^'"]*ui\/events['"]/.test(line)) hits.push(`${rel}: ${line.trim()}`);
        }
      }
    }
  };
  walk(root);
  return hits;
}

describe('事件总线归零 + ui/ 拆分门禁（docs/plans/eventbus-zero-and-ui-split-plan.md）', () => {
  const uiDir = join(process.cwd(), 'src', 'ui');

  it(COMPLETE ? '终态：events.ts 已删除' : '只减不增：events.ts 事件 ⊆ 11 基线', () => {
    const eventsFile = join(uiDir, 'events.ts');
    if (COMPLETE) {
      expect(existsSync(eventsFile), 'src/ui/events.ts 应已删除').toBe(false);
    } else if (existsSync(eventsFile)) {
      // P1 已删除 events.ts 时此门禁天然满足（零事件 ⊆ 11 基线）；文件仍存在则继续封口
      const actual = extractEventNames(readFileSync(eventsFile, 'utf-8'));
      const baseline = new Set<string>(BASELINE_EVENTS);
      const extra = actual.filter((e) => !baseline.has(e));
      expect(
        extra,
        `BusEvents 出现基线之外的新事件（封口违规）：
${extra.join('\n')}`,
      ).toEqual([]);
      expect(actual.length, '事件数应只减不增').toBeLessThanOrEqual(BASELINE_EVENTS.length);
    }
  });

  it(COMPLETE ? '终态：ui/ 收窄到残余目标' : '只减不增：ui/ 文件 ⊆ 59 文件 manifest', () => {
    const actual = listFiles(uiDir);
    const manifest = new Set<string>(UI_MANIFEST);
    const extra = actual.filter((f) => !manifest.has(f));
    expect(
      extra,
      `ui/ 出现 manifest 之外的新文件（封口违规——新 store 去 state/，新组件去 app/）：
${extra.join('\n')}`,
    ).toEqual([]);
    if (COMPLETE) {
      // 精确终态 26 = 计划 §3.3 残余清单逐项点数 25（file-translator.ts/.css 计两文件 +
      // graph.ts shim）+ P3 目录 README；计划原文「~24」是把 .css 折算进 .ts 的估算值。
      expect(actual.length, 'ui/ 残余应已收窄到计划 §3.3 清单 + README（26）').toBeLessThanOrEqual(26);
    }
  });

  it('app/** 的 ui/events import ⊆ 过渡豁免面（chat-core / bridge-adapters）', () => {
    const hits = findEventsImports(join(process.cwd(), 'src', 'app'));
    const violations = hits.filter((h) => {
      const file = h.split(':')[0];
      return !APP_EVENTS_IMPORT_ALLOWLIST.has(file);
    });
    expect(
      violations,
      `app/** 出现豁免面之外的 ui/events import：
${violations.join('\n')}`,
    ).toEqual([]);
  });

  it.skipIf(!COMPLETE)('终态：总线与桥接全灭，scene/ 与 state/ 就位', () => {
    expect(existsSync(join(process.cwd(), 'src', 'app', 'bridge-adapters.ts'))).toBe(false);
    expect(findEventsImports(join(process.cwd(), 'src'))).toEqual([]);
    const scene = listFiles(join(process.cwd(), 'src', 'scene'));
    expect(scene.length, 'scene/ 应 ≥23 文件').toBeGreaterThanOrEqual(23);
    const state = listFiles(join(process.cwd(), 'src', 'state'));
    expect(state.length, 'state/ 应 ≥11 文件').toBeGreaterThanOrEqual(11);
    const shim = readFileSync(join(uiDir, 'graph.ts'), 'utf-8');
    expect(
      shim.split('\n').filter((l) => l.trim()).length,
      'ui/graph.ts 应为 ≤3 行 re-export shim',
    ).toBeLessThanOrEqual(3);
  });
});
