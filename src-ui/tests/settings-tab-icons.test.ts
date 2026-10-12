// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 设置面板页签图标守卫（2026-09-28 立，用户报「图标重复了」触发）。
//
// 病灶：页签图标表原先写在 JSX 字面量里，而七个页签有四个共用 `agent`
// （提供方 / 插件 / 技能 / MCP），真正叫「Agent」那页反倒借了 `code`、「显示」借了
// 画布的 `mode-standard`——一列看过去四把一样的伞。人眼在 11px 一列里极难发现，
// 因为「都差不多」看起来像是「风格统一」。
//
// 本测试钉两条（都是机械判据，表在 `settings-tabs.ts` = 单一真源）：
//   ① **图标互不相同**——一个图标不许服务两个页签（同形即红，报出撞车的那对）；
//   ② **图标真在册**——名字拼错时 `iconSvg` 会静默退化成红色问号
//      （`<span style="color:var(--obs-fail)">?</span>`），肉眼极难发现，故此处钉死；
//      「在册」还顺带保证图标集没被改名/删除时页签不会悄悄变问号。
//
// 尺寸档另有一条人工纪律（不可机械断言）：页签只画 11px ⇒ 图标须按 11px 档设计
// （1~3 个图元 + 至少一个重元素），见 `src/ui/icons.ts` 头注。

import { describe, expect, it } from 'vitest';
import { SETTINGS_TABS } from '../src/plugins/builtin/settings-domain/settings-tabs';
import { iconNames } from '../src/ui/icons';

describe('设置面板页签图标', () => {
  it('各页签的图标互不相同（同形 = 用户报的「图标重复了」）', () => {
    const byIcon = new Map<string, string[]>();
    for (const t of SETTINGS_TABS) {
      byIcon.set(t.icon, [...(byIcon.get(t.icon) ?? []), t.label]);
    }
    const dupes = [...byIcon.entries()].filter(([, labels]) => labels.length > 1);
    expect(
      dupes,
      `这些页签共用同一个图标（每个页签该有自己的形）：\n${dupes.map(([icon, ls]) => `  ${icon} ← ${ls.join(' / ')}`).join('\n')}`,
    ).toEqual([]);
  });

  it('每个页签图标都真在图标集在册（拼错会静默退化成红问号）', () => {
    const known = new Set(iconNames());
    const missing = SETTINGS_TABS.filter((t) => !known.has(t.icon)).map((t) => `${t.label} → ${t.icon}`);
    expect(
      missing,
      `图标名不在 src/ui/icons.ts 在册集里（会被 iconSvg 静默画成红问号）：\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('页签表自检：id 无重复、题字非空（加页签只动 settings-tabs.ts 一处）', () => {
    const ids = SETTINGS_TABS.map((t) => t.id);
    expect(new Set(ids).size, `页签 id 有重复：${ids.join(', ')}`).toBe(ids.length);
    for (const t of SETTINGS_TABS) expect(t.label, `${t.id} 缺题字`).toBeTruthy();
  });
});
