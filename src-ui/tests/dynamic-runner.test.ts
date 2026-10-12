// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ctx.dynamicRunner 守护（平台化 Phase 4 · D7，2026-08-27）：
//   ① 求值面阴影：插件源码内 window/fetch/document/eval/Function 全 undefined
//   ② define 校验：语法错误 / 源码超预算 / name·purpose 形状 → 显式拒绝
//   ③ define → run（审批放行）→ 贡献可见 → stop → 贡献回收（P4-C2 主链）
//   ④ 审批门（P4-C3）：无通道未授权 = APPROVAL_REQUIRED；拒绝 = APPROVAL_DENIED
//   ⑤ 守卫注册面：def 缺 id / 非法属性访问 / 写 ctx → 响亮拒绝且零残留
//   ⑥ apply 超时：fiber 回收 + budget 取消（超时后 register 拒绝）
//   ⑦ 跨会话隔离：B 会话看不见/动不了 A 的插件
//   ⑧ update 失败回滚：旧包重挂，currentPackageId 回退

import { afterEach, describe, expect, it } from 'vitest';
import {
  activeDynamicRunner,
  DynamicRunnerService,
  dynamicRunnerPlugin,
  resetDynamicRunnerForTests,
} from '../src/agent/dynamic-runner/dynamic-runner-service';
import { DYNAMIC_APPLY_TIMEOUT_MS, GUARDED_SERVICES } from '../src/agent/dynamic-runner/sandbox';
import { activeCapabilityContributions, capabilitiesServicePlugin } from '../src/composition/capability-service';
import { fsServicePlugin } from '../src/composition/fs-service';
import { activeHookContributions, hooksServicePlugin } from '../src/composition/hook-service';
import { overlayServicePlugin } from '../src/composition/overlay-service';
import { preStepServicePlugin } from '../src/composition/pre-step-service';
import { promptsServicePlugin } from '../src/composition/prompt-service';
import { rendererServicePlugin } from '../src/composition/renderer-service';
import { activeToolContributions, compositionServicesPlugin } from '../src/composition/services';
import { sessionPersistenceServicePlugin } from '../src/composition/session-persistence-service';
import { shellServicePlugin } from '../src/composition/shell-service';
import { subagentsServicePlugin } from '../src/composition/subagent-service';
import { Context } from '../src/cordis';
import { agentLoopServicePlugin } from '../src/plugins/builtin/agent-loop-service';

afterEach(() => {
  resetDynamicRunnerForTests();
});

async function booted(): Promise<{ runner: DynamicRunnerService; dispose: () => Promise<void> }> {
  const root = new Context();
  await root.plugin(compositionServicesPlugin);
  await root.plugin(dynamicRunnerPlugin);
  const runner = (root as unknown as { dynamicRunner: DynamicRunnerService }).dynamicRunner;
  expect(runner).toBeInstanceOf(DynamicRunnerService);
  return { runner, dispose: () => root.fiber.dispose() };
}

const TOOL_PLUGIN = (id: string): string =>
  `return { name: 'p', apply(ctx) { ctx.tools.register({ id: ${JSON.stringify(id)}, factory: () => [] }); } };`;

describe('ctx.dynamicRunner（D7 动态插件运行时）', () => {
  it('① 求值面阴影：危险全局在插件源码内全为 undefined', async () => {
    const { runner, dispose } = await booted();
    // 探测通道 = 工具工厂回传（宿主唯一可达面——插件闭包无法逃逸）
    const receipt = runner.define('s1', {
      kind: 'new',
      idPrefix: 'shadow',
      name: 'shadow-probe',
      purpose: '验证阴影面',
      code: `return { name: 'shadow', apply(ctx) {
        ctx.tools.register({ id: 'dyn/shadow-probe', factory: () => ({
          name: () => 'shadow_probe',
          description: () => 'typeof 探针',
          parameters: () => ({ type: 'object', properties: {} }),
          readOnly: () => true,
          execute: () => JSON.stringify({
            fetch: typeof fetch,
            window: typeof window,
            document: typeof document,
            eval: typeof eval,
            Function: typeof Function,
            localStorage: typeof localStorage,
            require: typeof require,
            process: typeof process,
          }),
        }) }); } };`,
    });
    await runner.run('s1', receipt.pluginId, receipt.packageId, 'run', async () => true);
    const contrib = activeToolContributions().find((c) => c.id === 'dyn/shadow-probe');
    expect(contrib).toBeDefined();
    const tool = (await contrib!.factory()) as { execute: (args: Record<string, unknown>) => Promise<string> };
    const probe = JSON.parse(await tool.execute({})) as Record<string, string>;
    expect(probe).toEqual({
      fetch: 'undefined',
      window: 'undefined',
      document: 'undefined',
      eval: 'undefined',
      Function: 'undefined',
      localStorage: 'undefined',
      require: 'undefined',
      process: 'undefined',
    });
    await runner.undefine('s1', receipt.pluginId);
    await dispose();
  });

  it('② define 校验：语法错误 / 超预算 / 形状缺项显式拒绝（不执行）', async () => {
    const { runner } = await booted();
    expect(() =>
      runner.define('s1', { kind: 'new', idPrefix: 'bad', name: 'x', purpose: 'y', code: 'return { apply: (' }),
    ).toThrow(/语法错误/);
    // 语法合法但形状不对的源码在 define 期放行（预检不执行工厂）——run 期求值拒绝
    const badShape = runner.define('s1', { kind: 'new', idPrefix: 'bad', name: 'x', purpose: 'y', code: 'return "x"' });
    await expect(runner.run('s1', badShape.pluginId, badShape.packageId, 'run', async () => true)).rejects.toThrow(
      /工厂必须返回对象/,
    );
    const big = 'const x = 1;' + 'x;'.repeat(200_000);
    expect(() => runner.define('s1', { kind: 'new', idPrefix: 'big', name: 'x', purpose: 'y', code: big })).toThrow(
      /超预算/,
    );
    expect(() =>
      runner.define('s1', { kind: 'new', idPrefix: 'Toolongprefix', name: 'x', purpose: 'y', code: 'return {}' }),
    ).toThrow(/idPrefix/);
    expect(() =>
      runner.define('s1', { kind: 'new', idPrefix: 'ok', name: '', purpose: 'y', code: 'return {}' }),
    ).toThrow(/name/);
  });

  it('③ define → run（审批放行）→ 贡献可见 → stop → 贡献回收（P4-C2 主链）', async () => {
    const { runner, dispose } = await booted();
    const receipt = runner.define('s1', {
      kind: 'new',
      idPrefix: 'tool',
      name: '工具插件',
      purpose: '注册一个工具贡献',
      code: TOOL_PLUGIN('dyn/tool-a'),
    });
    expect(receipt.pluginId).toMatch(/^dyn-tool-\d{4}$/);
    // 运行前贡献不存在
    expect(activeToolContributions().some((c) => c.id === 'dyn/tool-a')).toBe(false);
    // 审批放行 → 贡献出现
    await runner.run('s1', receipt.pluginId, receipt.packageId, 'run', async () => true);
    expect(activeToolContributions().some((c) => c.id === 'dyn/tool-a')).toBe(true);
    expect(runner.listInspect('s1')[0]?.running).toBe(true);
    // 已授权 → 重启无需再次审批
    await runner.stop('s1', receipt.pluginId);
    expect(activeToolContributions().some((c) => c.id === 'dyn/tool-a')).toBe(false);
    await runner.run('s1', receipt.pluginId, receipt.packageId, 'run'); // 无审批回调——已授权缓存
    expect(activeToolContributions().some((c) => c.id === 'dyn/tool-a')).toBe(true);
    // undefine → 贡献回收 + 记录删除
    await runner.undefine('s1', receipt.pluginId);
    expect(activeToolContributions().some((c) => c.id === 'dyn/tool-a')).toBe(false);
    expect(runner.listInspect('s1')).toEqual([]);
    await dispose();
  });

  it('④ 审批门：无通道未授权 = APPROVAL_REQUIRED；拒绝 = APPROVAL_DENIED（P4-C3）', async () => {
    const { runner } = await booted();
    const receipt = runner.define('s1', {
      kind: 'new',
      idPrefix: 'gate',
      name: '审批门',
      purpose: '验证未授权不能运行',
      code: TOOL_PLUGIN('dyn/gate'),
    });
    await expect(runner.run('s1', receipt.pluginId, receipt.packageId, 'run')).rejects.toThrow(/APPROVAL_REQUIRED/);
    expect(activeToolContributions().some((c) => c.id === 'dyn/gate')).toBe(false);
    await expect(runner.run('s1', receipt.pluginId, receipt.packageId, 'run', async () => false)).rejects.toThrow(
      /APPROVAL_DENIED/,
    );
    expect(activeToolContributions().some((c) => c.id === 'dyn/gate')).toBe(false);
    // 批准后可运行
    await runner.run('s1', receipt.pluginId, receipt.packageId, 'run', async () => true);
    expect(activeToolContributions().some((c) => c.id === 'dyn/gate')).toBe(true);
  });

  it('⑤ 守卫注册面：def 缺 id / 非法属性访问 → 响亮拒绝且零残留', async () => {
    const { runner, dispose } = await booted();
    // def 缺 id → register 拒绝 → apply 失败 → fiber dispose
    const bad1 = runner.define('s1', {
      kind: 'new',
      idPrefix: 'guard',
      name: '缺 id',
      purpose: '验证形状校验',
      code: "return { name: 'p', apply(ctx) { ctx.tools.register({ factory: () => [] }); } };",
    });
    await expect(runner.run('s1', bad1.pluginId, bad1.packageId, 'run', async () => true)).rejects.toThrow(/缺合法 id/);
    expect(activeToolContributions().some((c) => c.id.startsWith('dyn/'))).toBe(false);
    // 非法属性访问（白名单外）→ 响亮拒绝
    const bad2 = runner.define('s1', {
      kind: 'new',
      idPrefix: 'guard',
      name: '越权访问',
      purpose: '验证守卫面',
      code: "return { name: 'p', apply(ctx) { ctx.tools.register({ id: 'dyn/ok', factory: () => [] }); void ctx.fetch; } };",
    });
    await expect(runner.run('s1', bad2.pluginId, bad2.packageId, 'run', async () => true)).rejects.toThrow(
      /非法访问 ctx\.fetch/,
    );
    // 零残留：失败 apply 里先注册成功的贡献也随 fiber dispose 回收
    expect(activeToolContributions().some((c) => c.id === 'dyn/ok')).toBe(false);
    // 写 ctx → 拒绝
    const bad3 = runner.define('s1', {
      kind: 'new',
      idPrefix: 'guard',
      name: '写 ctx',
      purpose: '验证只读面',
      code: "return { name: 'p', apply(ctx) { ctx.tools = null; } };",
    });
    await expect(runner.run('s1', bad3.pluginId, bad3.packageId, 'run', async () => true)).rejects.toThrow(
      /不得写 ctx/,
    );
    await dispose();
  });

  it('⑥ apply 超时：fiber 回收 + 取消后 register 拒绝', async () => {
    const { runner, dispose } = await booted();
    runner.applyTimeoutMs = 60; // 测试注入小预算
    expect(DYNAMIC_APPLY_TIMEOUT_MS).toBeGreaterThan(1000); // 生产常量未被改动
    const receipt = runner.define('s1', {
      kind: 'new',
      idPrefix: 'slow',
      name: '慢 apply',
      purpose: '验证超时回收',
      code: "return { name: 'p', apply() { return new Promise(() => {}); } };",
    });
    await expect(runner.run('s1', receipt.pluginId, receipt.packageId, 'run', async () => true)).rejects.toThrow(
      /超预算/,
    );
    expect(runner.listInspect('s1')[0]?.running).toBe(false);
    expect(runner.inspectSelf('s1', receipt.pluginId, receipt.packageId)).toMatchObject({
      diagnostics: { status: 'failed', message: expect.stringContaining('超预算') },
    });
    await dispose();
  });

  it('⑦ 跨会话隔离：B 会话看不见 / 动不了 A 的插件', async () => {
    const { runner } = await booted();
    const receipt = runner.define('agentA', {
      kind: 'new',
      idPrefix: 'iso',
      name: 'A 的插件',
      purpose: '会话隔离',
      code: TOOL_PLUGIN('dyn/iso'),
    });
    expect(runner.listInspect('agentB')).toEqual([]);
    await expect(runner.run('agentB', receipt.pluginId, receipt.packageId, 'run')).rejects.toThrow(/非本会话所有/);
    await expect(runner.stop('agentB', receipt.pluginId)).rejects.toThrow(/非本会话所有/);
    expect(() => runner.inspectSelf('agentB', receipt.pluginId)).toThrow(/非本会话所有/);
    await runner.run('agentA', receipt.pluginId, receipt.packageId, 'run', async () => true);
    await runner.undefine('agentA', receipt.pluginId);
  });

  it('⑧ update 失败回滚：旧包重挂，currentPackageId 回退', async () => {
    const { runner, dispose } = await booted();
    const first = runner.define('s1', {
      kind: 'new',
      idPrefix: 'roll',
      name: 'v1',
      purpose: '稳定版',
      code: TOOL_PLUGIN('dyn/v1'),
    });
    await runner.run('s1', first.pluginId, first.packageId, 'run', async () => true);
    const second = runner.define('s1', {
      kind: 'existing',
      pluginId: first.pluginId,
      name: 'v2',
      purpose: '会失败的更新',
      code: "return { name: 'p', apply(ctx) { ctx.tools.register({ id: 'dyn/v2', factory: () => [] }); throw new Error('boom'); } };",
    });
    await expect(runner.run('s1', first.pluginId, second.packageId, 'update', async () => true)).rejects.toThrow(
      'boom',
    );
    // 回滚：current 回退到 v1；v1 贡献仍在；v2 贡献被回收
    const plugin = runner.inspectSelf('s1', first.pluginId) as { currentPackageId?: string };
    expect(plugin.currentPackageId).toBe(first.packageId);
    expect(activeToolContributions().some((c) => c.id === 'dyn/v1')).toBe(true);
    expect(activeToolContributions().some((c) => c.id === 'dyn/v2')).toBe(false);
    await runner.undefine('s1', first.pluginId);
    await dispose();
  });

  // ⑨ 运行期解析面回归（platform-bugs 2026-09-07）：生产消费单点是
  // activeDynamicRunner()（cordis 工具面 requireRunner 同源）——裸实例，
  // 方法内 this.ctx = runner 自身 fiber 的 ctx（fiber.runtime 非空）。
  // 前八个用例经 root.dynamicRunner 取 runner——cordis traceable 绑定把
  // this.ctx 重绑到「取用方 ctx」（root，无 runtime）→ 内核走免 inject 分支，
  // 恰好绕开了生产路径（守卫 ctx 经 resolverCtx[prop] 被 inject 拦截的缺陷）。
  // 本用例钉死生产路径：服务解析必须经免 inject 通道恒可解析。
  it('⑨ 运行期解析面：经 activeDynamicRunner()（生产真路径）run 注册贡献可解析', async () => {
    const { dispose } = await booted();
    const runner = activeDynamicRunner();
    expect(runner).toBeInstanceOf(DynamicRunnerService);
    // 前提钉死：裸实例的 this.ctx 是 runner fiber（有 runtime）——若未来
    // 变成无 runtime 的 ctx，本用例退化为①-⑧路径而失去守护价值。
    const rawCtx = (runner as unknown as { ctx: { fiber: { runtime: unknown } } }).ctx;
    expect(rawCtx.fiber.runtime).toBeTruthy();
    const receipt = runner!.define('s1', {
      kind: 'new',
      idPrefix: 'rtm',
      name: '运行期解析',
      purpose: '生产路径回归',
      code: TOOL_PLUGIN('dyn/runtime-path'),
    });
    await runner!.run('s1', receipt.pluginId, receipt.packageId, 'run', async () => true);
    expect(activeToolContributions().some((c) => c.id === 'dyn/runtime-path')).toBe(true);
    await runner!.undefine('s1', receipt.pluginId);
    await dispose();
  });
});

/* ═══ 守卫注册面校准（2026-09-14）═══════════════════════════════════════════
 * 缘起：`sandbox.ts` 的白名单自注「键集同时是守卫白名单 + 可解析服务清单
 * ——单一真源防两处漂移」，但它**自己漂了**：仍列着 2026-09-09 全量退役的
 * `graph`，且缺 overlays / hooks / agentLoop；更糟的是 `validateDef` 里按服务
 * 特判 `needId='key'`——M1 把行身份统一成 `id` 后，那个分支让**动态插件注册
 * capability 整条路恒失败**（给正确的 id 被守卫拒，给旧 key 又会被通道的
 * 形状校验拒）。技能文档 `lantai-plugin-dev` 曾照抄这份错误清单，一并更正。
 *
 * 本组补上它承诺却没兑现的那条守护：白名单 ↔ 真装配对拍。 */

describe('守卫注册面校准（白名单 ↔ 真装配）', () => {
  /** 全服务装配：十条贡献通道 + 五条 seam（agentLoop 经产物域插件挂）。 */
  const SERVICE_PLUGINS = [
    compositionServicesPlugin,
    rendererServicePlugin,
    promptsServicePlugin,
    hooksServicePlugin,
    capabilitiesServicePlugin,
    overlayServicePlugin,
    preStepServicePlugin,
    fsServicePlugin,
    shellServicePlugin,
    sessionPersistenceServicePlugin,
    subagentsServicePlugin,
    agentLoopServicePlugin,
  ];

  async function bootedAll(): Promise<{ runner: DynamicRunnerService; dispose: () => Promise<void> }> {
    const root = new Context();
    for (const p of SERVICE_PLUGINS) await root.plugin(p);
    await root.plugin(dynamicRunnerPlugin);
    const runner = (root as unknown as { dynamicRunner: DynamicRunnerService }).dynamicRunner;
    return { runner, dispose: () => root.fiber.dispose() };
  }

  it('⑩ 白名单 ↔ 真装配对拍：零死条目 + 十通道五 seam 齐备 + graph 不回榜', async () => {
    const root = new Context();
    for (const p of SERVICE_PLUGINS) await root.plugin(p);
    const reflect = (root as unknown as { reflect: { get(n: string): unknown } }).reflect;

    const dead: string[] = [];
    const noRegister: string[] = [];
    for (const name of GUARDED_SERVICES) {
      let svc: unknown;
      try {
        svc = reflect.get(name);
      } catch {
        svc = undefined;
      }
      if (svc == null) {
        dead.push(name);
        continue;
      }
      if (typeof (svc as { register?: unknown }).register !== 'function') noRegister.push(name);
    }
    // 死条目 = 白名单列了一个平台没有的服务（模型照它写 ctx.<name>.register 必炸）
    expect(dead, '白名单里有解析不到的服务（死条目）').toEqual([]);
    expect(noRegister, '白名单条目解析到的对象没有 register').toEqual([]);

    // 集合与集合语义：十条通道 + 五 seam，无重复，退役面不回榜
    expect([...GUARDED_SERVICES].sort()).toEqual(
      [
        'tools',
        'panels',
        'commands',
        'llm',
        'prompts',
        'hooks',
        'preStep',
        'capabilities',
        'renderers',
        'overlays',
        'fs',
        'shell',
        'sessionPersistence',
        'subagents',
        'agentLoop',
      ].sort(),
    );
    expect(new Set(GUARDED_SERVICES).size).toBe(GUARDED_SERVICES.length);
    expect(GUARDED_SERVICES, '图谱能力 2026-09-09 全量退役——白名单不得留 graph').not.toContain('graph');
    await root.fiber.dispose();
  });

  it('⑪ capability 行身份 = id：动态插件给 id 可注册、给退役的 key 被拒', async () => {
    const { runner, dispose } = await bootedAll();
    const ok = runner.define('s1', {
      kind: 'new',
      idPrefix: 'capok',
      name: 'capability 用 id',
      purpose: 'M1 后行身份统一回归',
      code: "return { name: 'p', apply(ctx) { ctx.capabilities.register({ id: 'dyn/cap-ok', phase: 'agent', install() {} }); } };",
    });
    await runner.run('s1', ok.pluginId, ok.packageId, 'run', async () => true);
    expect(activeCapabilityContributions().map((c) => c.id)).toContain('dyn/cap-ok');

    // 旧字段名 key：守卫在装载期就拒（不潜伏到装配期）
    const bad = runner.define('s1', {
      kind: 'new',
      idPrefix: 'capbad',
      name: 'capability 用旧 key',
      purpose: '退役字段拒绝',
      code: "return { name: 'p', apply(ctx) { ctx.capabilities.register({ key: 'dyn/cap-bad', phase: 'agent', install() {} }); } };",
    });
    await expect(runner.run('s1', bad.pluginId, bad.packageId, 'run', async () => true)).rejects.toThrow(/缺合法 id/);
    await dispose();
  });

  it('⑫ hooks 嵌套形状装载期校验：合法 enrich/preflight 收，畸形拒', async () => {
    const { runner, dispose } = await bootedAll();
    const ok = runner.define('s1', {
      kind: 'new',
      idPrefix: 'hookok',
      name: 'hooks 合法形状',
      purpose: '嵌套形状收',
      code:
        "return { name: 'p', apply(ctx) {" +
        " ctx.hooks.register({ id: 'dyn/h-enrich', kind: 'enrich', hook: { name: 'he', shouldEnrich: () => false, enrich: async (t, a, r) => r } });" +
        " ctx.hooks.register({ id: 'dyn/h-pre', kind: 'preflight', hook: { name: 'hp', shouldCheck: () => false, check: () => null } });" +
        ' } };',
    });
    await runner.run('s1', ok.pluginId, ok.packageId, 'run', async () => true);
    expect(activeHookContributions().map((c) => c.id)).toEqual(['dyn/h-enrich', 'dyn/h-pre']);

    // 三类畸形：kind 拼错 / hook 不是对象 / enrich 族缺 enrich 函数
    const malformed: Array<[string, RegExp]> = [
      ["ctx.hooks.register({ id: 'dyn/x', kind: 'post', hook: { name: 'n' } });", /kind 必须是/],
      ["ctx.hooks.register({ id: 'dyn/x', kind: 'enrich', hook: 'nope' });", /hook 必须是对象/],
      [
        "ctx.hooks.register({ id: 'dyn/x', kind: 'enrich', hook: { name: 'n', shouldEnrich: () => true } });",
        /hook 缺 enrich 函数成员/,
      ],
    ];
    for (const [stmt, re] of malformed) {
      const bad = runner.define('s1', {
        kind: 'new',
        idPrefix: 'hkb',
        name: 'hooks 畸形',
        purpose: '嵌套形状拒',
        code: `return { name: 'p', apply(ctx) { ${stmt} } };`,
      });
      await expect(runner.run('s1', bad.pluginId, bad.packageId, 'run', async () => true)).rejects.toThrow(re);
    }
    await dispose();
  });

  it('⑬ overlays / agentLoop 在册且形状受检（component / run 承重成员）', async () => {
    const { runner, dispose } = await bootedAll();
    // overlays：组件是唯一函数成员
    const badOverlay = runner.define('s1', {
      kind: 'new',
      idPrefix: 'ovlbad',
      name: 'overlays 缺 component',
      purpose: '承重成员校验',
      code: "return { name: 'p', apply(ctx) { ctx.overlays.register({ id: 'dyn/ovl', slot: 'composer' }); } };",
    });
    await expect(runner.run('s1', badOverlay.pluginId, badOverlay.packageId, 'run', async () => true)).rejects.toThrow(
      /缺 component 函数成员/,
    );
    // agentLoop：run 是唯一函数成员（只验形状，不真换 loop——换 loop 是
    // 会话装配面的事，本组只钉「白名单条目活着且形状受检」）
    const badLoop = runner.define('s1', {
      kind: 'new',
      idPrefix: 'lpb',
      name: 'agentLoop 缺 run',
      purpose: '承重成员校验',
      code: "return { name: 'p', apply(ctx) { ctx.agentLoop.register({ id: 'dyn/loop' }); } };",
    });
    await expect(runner.run('s1', badLoop.pluginId, badLoop.packageId, 'run', async () => true)).rejects.toThrow(
      /缺 run 函数成员/,
    );
    await dispose();
  });
});
