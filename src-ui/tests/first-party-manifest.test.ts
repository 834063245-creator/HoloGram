// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// first-party-manifest 守护：44 个第一方插件必须有清单条目、无孤儿条目、
// name 与 key 一致、元数据合法。任何新增第一方插件（BUILTIN_PLUGINS 加行）
// 必须同步本清单——缺条目会让 loader 跳过装载 + error 记录（运行时断层），
// 本测试在测试期就拦死（错误不静默，先把断层炸在 CI）。

import { describe, expect, it } from 'vitest';
import { FIRST_PARTY_MANIFEST, FIRST_PARTY_VERSION } from '../src/plugins/first-party-manifest';
import { allBuiltinPlugins, BUILTIN_PLUGINS } from '../src/plugins/loader';
import { SERVICE_PLUGINS } from '../src/plugins/service-plugins';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

describe('first-party-manifest（清单完备性守护）', () => {
  it('全部第一方插件在清单中（无遗漏——缺一条 loader 就断层）', () => {
    const names = allBuiltinPlugins().map((p) => p.name);
    const missing = names.filter((n) => !(n in FIRST_PARTY_MANIFEST));
    expect(missing).toEqual([]);
  });

  it('清单无孤儿条目（清单内的 name 都在第一方插件里）', () => {
    const names = new Set(allBuiltinPlugins().map((p) => p.name));
    const orphans = Object.keys(FIRST_PARTY_MANIFEST).filter((n) => !names.has(n));
    expect(orphans).toEqual([]);
  });

  it('条目 name 与 key 一致；version/description/kind 合法', () => {
    for (const [key, m] of Object.entries(FIRST_PARTY_MANIFEST)) {
      expect(m.name).toBe(key);
      expect(m.version).toMatch(SEMVER_RE);
      expect(m.version).toBe(FIRST_PARTY_VERSION);
      expect(m.description.length).toBeGreaterThan(0);
      expect(['service', 'feature']).toContain(m.kind);
    }
  });

  it('计数快照（58 = 19 内核 service + 39 出厂 feature）', () => {
    // graph-service / graph-builtin / engine-domain 随图谱功能全量退役（2026-09-09）：45 → 42
    // office-domain 新增（2026-09-13，C 路：OfficeCLI 一等域工具，取代 MCP 挂接）：42 → 43
    // plan-mode 新增（2026-09-24 批 6a：规划模式实现归产物，内核 capability 查登记表）：43 → 44
    // goal-mode 新增（2026-09-24 批 6b：goal 循环实现归产物）：44 → 45
    // state-hooks 新增（2026-09-24 批 6c：出厂 hook 四工厂归产物）：45 → 46
    // composition-root-views 新增（2026-09-26 批 9e：App 外壳视图槽通道——内核 service）：50 → 51
    // sessions-home 新增（2026-09-26 批 9e：案卷首页归产物）：51 → 52
    // ask-cards 新增（2026-09-26 批 9e-3：ask/权限卡架归产物，required 不可禁用）：52 → 53
    // token-meter 新增（2026-09-26 §4-6 A：token 计量升为内核第 16 个 service）：53 → 54
    // composition-workspaces / composition-shell-rows 新增（2026-09-26 批 10 同窗：两条宿主生命周期
    // 贡献面，用户 2026-09-25 裁定 A）：54 → 56
    // bundled-engine 新增（2026-09-26 批 10 部件三：引擎接线产物化）：56 → 57
    // pre-step-service 新增（2026-10-13 agent-hooks-plan 一期：步前裁决贡献面）：57 → 58
    expect(Object.keys(FIRST_PARTY_MANIFEST)).toHaveLength(58);
  });

  it('两类都有存量：service 平台服务（常驻）与 feature 功能插件（可禁用）', () => {
    const kinds = new Set(Object.values(FIRST_PARTY_MANIFEST).map((m) => m.kind));
    expect(kinds).toEqual(new Set(['service', 'feature']));
  });

  it('§4-15 单一真源（批 9a）：内核 service 名单只在 service-plugins.ts 写一次', () => {
    const names = SERVICE_PLUGINS.map((e) => e.plugin.name);
    // pre-step-service 追加末位（2026-10-13 agent-hooks-plan 一期）：18 → 19
    expect(names).toHaveLength(19);
    // loader 表由本表派生（对象同一，不是「两份名单碰巧一样」）
    expect(BUILTIN_PLUGINS.map((p) => p.name)).toEqual(names);
    expect(BUILTIN_PLUGINS.map((p) => p.name)).toEqual(SERVICE_PLUGINS.map((e) => e.plugin.name));
    // 清单 service 段的键集与序 = 本表（description 也从本表读，清单面零手写名单）
    expect(
      Object.entries(FIRST_PARTY_MANIFEST)
        .filter(([, m]) => m.kind === 'service')
        .map(([k]) => k),
    ).toEqual(names);
  });
});
