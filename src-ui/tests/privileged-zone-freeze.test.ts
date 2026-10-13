// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 特权区文件集冻结（插件化欠账总账 §5 第 2 条 · 批 0b）
//
// 病灶：既有「只减不增」守卫只对 `ui/**`（59 文件 manifest）与 `events.ts`（11 事件）
// 生效，而 `composition/**`（组合/装配通道内核）与 `plugins/**` 顶层（装载链）
// **没有任何封口** —— 特权区可以悄悄膨胀：本该住产物包的第一方内容与产品件被顺手
// 塞进来，谁也不会发现（账本 §2.6「进货清单挪到柜台，货仍在店里」）。
//
// 本守卫把纪律变成门禁（照 tests/eventbus-zero-and-ui-split.test.ts 的 manifest 范式）：
//   ① 两区文件集 ⊆ 冻结基线（新文件一律去产物包 / state / 测试helpers，禁落特权区）；
//   ② 基线每条都仍在磁盘（销账制：删/挪文件必须同批删条目）；
//   ③ `KNOWN_DEBT` 与基线两处同步（防「只删一处」）。
//
// ⚠ 为什么**没有**行数水位线（原设计有，2026-09-24 撤）：本仓多窗口并行改同一工作树，
// 对 `plugins/**` 这类他人正在施工的文件设总量上限，会把**别人的正当改动**判成本守卫的红
// （实测：立账 15 分钟后另一窗口的 bundled-engine 施工就让 plugins/ 顶层 +277 行）。
// 「只减不增」的约束力由文件集封口承担（新文件即红）——这是本仓既有范式的口径。
//
// 基线 = 2026-09-24 账本立账时实测（composition 32 文件 → 批 0c 删
// `asset-renderers.tsx` 后 31；plugins 顶层 17 → 批 9a §4-15 收单一真源新增
// `service-plugins.ts` 后 18）。批 9e（2026-09-26）：新增内核通道
// `composition/root-views-service.ts`（App 外壳视图槽——用户裁定 A，特权区内的**通道本体**）→ 32。
// 批 10 部件三（2026-09-26）：`bundled-engine.ts` 的**接线**随 `plugins/builtin/bundled-engine/`
// ⇒ 顶层条目改记拆分后的内核件 `bundled-engine-prefs.ts`（探测 + 开关，设置面板经 faceDeps 取用）。
// 批 10 同窗（2026-09-26）：两条**宿主生命周期贡献面**本体入区——`composition/workspaces-service.ts`
// （`ctx.workspaces`）与 `composition/shell-rows-service.ts`（`ctx.shellRows`）；用户 2026-09-25 裁定 A
// （§4-9 与工作区接线同窗），契约 v52 → v53 → 34 文件。
// agent-hooks-plan 一期（2026-10-13）：步前裁决贡献面本体入区——`composition/pre-step-service.ts`
// （`ctx.preStep` 通道；与 hooks/capability 同族的**通道本体**，非可搬产物内容），契约 v54 → v55 → 35 文件。
// agent-hooks-plan 二期（2026-10-13）：面扩展 + 改名——`composition/steps-service.ts`（`ctx.steps`
// 通道：步骤钩子家族），契约 v55 → v56。

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

/** 特权区 ①：`composition/**`（组合解析 / 装配 / 通道内核 = 强制层）。 */
const COMPOSITION_MANIFEST = [
  'activation-service.ts',
  'activation.ts',
  'capability-service.ts',
  'contract-version.ts',
  'contribution-channel.ts',
  'first-party-capabilities.ts',
  'first-party-prompts.ts',
  'first-party-tools.ts',
  'fs-service.ts',
  'hook-service.ts',
  'overlay-service.ts',
  'patch-loader.ts',
  'plugin-tool-rows.ts',
  'steps-service.ts',
  'preset-assembly.ts',
  'preset-discovery.ts',
  'presets.ts',
  'prompt-sections.ts',
  'prompt-service.ts',
  'renderer-service.tsx',
  'roster.ts',
  'seam-resolution.ts',
  'seam-scope.ts',
  'services.ts',
  'session-persistence-service.ts',
  'shell-rows.ts',
  'shell-rows-service.ts',
  'root-views-service.ts',
  'shell-service.ts',
  'space-service.ts',
  'subagent-service.ts',
  'tool-rows.ts',
  'with-first-party-channel.ts',
  'workspaces-service.ts',
];

/** 特权区 ②：`plugins/` 顶层（装载链 / 平台类型 / 名册）。`builtin/**` 是产物包本体，不在本区。 */
const PLUGINS_MANIFEST = [
  'boot-gate.ts',
  'builtin-roster.json',
  'builtin-roster.ts',
  'bundled-engine-prefs.ts',
  'data-fs.ts',
  'deferred.ts',
  'factory-products.ts',
  'first-party-manifest.ts',
  'host-surface.baseline.json',
  'loader.ts',
  'mcp-bridge.ts',
  'product-watch.ts',
  'service-plugins.ts',
  'tool-declarations.ts',
  'types.ts',
  'user-mcp.ts',
  'window-bridge.ts',
  'window-facility.ts',
];

/** 已知该搬出特权区的条目（账本裁定；搬完即从 manifest 与这里同时销账）。
 *  批 9「§2.6 内核产品件」= 清单四件。
 *  （`preset-authoring.ts` 已于批 1 归家进 `plugins/builtin/settings-domain/`——销账。） */
const KNOWN_DEBT = [
  'composition/first-party-tools.ts',
  'composition/first-party-prompts.ts',
  'composition/first-party-capabilities.ts',
  'composition/with-first-party-channel.ts',
];

function zoneFiles(dir: string): string[] {
  return readdirSync(join(SRC, dir), { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

describe('特权区文件集冻结（composition/** + plugins/ 顶层）', () => {
  it('composition/** ⊆ 冻结基线（新内容一律去产物包，禁落通道内核）', () => {
    const actual = zoneFiles('composition');
    const extra = actual.filter((f) => !COMPOSITION_MANIFEST.includes(f));
    expect(
      extra,
      `composition/ 出现基线之外的新文件（特权区封口违规——产品/内容件请落 plugins/builtin/<产物>/，
机制件落 state/ 或 shell/，测试腰落 tests/）：\n${extra.join('\n')}`,
    ).toEqual([]);
  });

  it('plugins/ 顶层 ⊆ 冻结基线（装载链只减不增）', () => {
    const actual = zoneFiles('plugins');
    const extra = actual.filter((f) => !PLUGINS_MANIFEST.includes(f));
    expect(
      extra,
      `plugins/ 顶层出现基线之外的新文件（装载链封口违规——产物请落 plugins/builtin/<产物>/）：\n${extra.join('\n')}`,
    ).toEqual([]);
  });

  it('基线每条都仍在磁盘（销账制：删/挪文件必须同批删条目）', () => {
    const stale: string[] = [];
    for (const [dir, list] of [
      ['composition', COMPOSITION_MANIFEST],
      ['plugins', PLUGINS_MANIFEST],
    ] as const) {
      for (const f of list) if (!existsSync(join(SRC, dir, f))) stale.push(`${dir}/${f}`);
    }
    expect(stale, `冻结基线里的文件已不存在（搬走了就销账，别让基线烂着）：\n${stale.join('\n')}`).toEqual([]);
  });

  it('自检：基线条目数与磁盘一致（防手抄漂移）', () => {
    expect(COMPOSITION_MANIFEST.length, '基线条目数与磁盘文件数应一致（否则第 3 条会红）').toBe(
      zoneFiles('composition').length,
    );
    expect(PLUGINS_MANIFEST.length).toBe(zoneFiles('plugins').length);
    // 已知欠账条目必须在基线里（搬完销账时两处一起删——本断言防「只删一处」）
    for (const d of KNOWN_DEBT) {
      const [dir, file] = d.split('/') as [string, string];
      const list: readonly string[] = dir === 'composition' ? COMPOSITION_MANIFEST : PLUGINS_MANIFEST;
      expect(list.includes(file), `KNOWN_DEBT 里的 ${d} 已不在基线（搬完了？请两处一起销账）`).toBe(true);
      expect(existsSync(join(SRC, dir, file)), `KNOWN_DEBT 里的 ${d} 已不在磁盘（同上）`).toBe(true);
    }
  });

  it('区外产品件登记表非空（本守卫只封口两区；其余欠账由 tests/plugin-home-ledger 守）', () => {
    expect(relative(SRC, SRC), '占位断言：保持本用例结构稳定').toBe('');
    expect(KNOWN_DEBT.length).toBeGreaterThan(0);
  });
});
