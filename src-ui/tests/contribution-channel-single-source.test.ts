// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 贡献通道内核单源 —— 终态守护（M1 收口，2026-09-14）。
//
// 为什么需要这条守护：M1 之前，「id 寻址 + 重名装载期拒绝 + 幂等 disposer +
// 陈旧性守卫 + 贡献序清单」这套语义在同一仓库里被实现了 7 遍（ContributionRegistry
// 一份 + Renderer/Prompt/HookContribution/CapabilityContribution/Overlay 五份手抄 +
// assetKinds 相邻），成员集互不相同。收口删掉五份手抄、把 14 个 service 收敛到
// contribution-channel.ts 的唯一内核（净删约 1100 行）。
//
// 手抄的成本不在「多写了 40 行」，而在**没有地方可以改**：改一次生效时机语义
// 要改七处、读一条通道的时序要读七份文件头。这条守护把「只有一份实现」钉死，
// 让那种成本不能悄悄爬回来。
//
// 两条互补的判据（防止绕过）：
//   ① **行为指纹**：装载期拒绝的报错文案全仓只有内核一处产出——改名也绕不过
//      （新抄一份必须重写这套语义，重写就会带出同款文案）；
//   ② **具名守护**：五个手抄类名与旧内核名不得以 class 声明 / new 调用复活
//      （散文里提到这些名字不算——正本文件头就在讲这段历史）。
// 另加两条结构判据：14 个 service 的构造点齐备，且每处都声明了合法的 timing。

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', 'src');
const KERNEL_REL = 'composition/contribution-channel.ts';

/** 递归收集 src 下的 .ts/.tsx（不含测试与生成物）。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs));
    else if (/\.tsx?$/.test(e.name)) out.push(abs);
  }
  return out;
}

const FILES = walk(SRC).map((abs) => ({
  rel: path.relative(SRC, abs).split(path.sep).join('/'),
  text: readFileSync(abs, 'utf8'),
}));

/** 生效时机四档闭集（与 ContributionTiming 同源；此处手写是为了让漂移在此红）。 */
const TIMINGS = ['immediate', 'next-assembly', 'request', 'frame'];

/** 16 个 service 的通道构造点：十一条贡献通道 + 五条 seam provider 注册表。
 *  批 9e（2026-09-26）新增第十条：`rootViews`（App 外壳视图槽——首页 / 根浮层）。
 *  agent-hooks-plan（2026-10-13）：第十一条 `steps`——一期步前裁决面（pre-step 每步
 *  enter/reject + 注入）+ 二期扩展为步骤钩子家族（turn-stopping 停止边界裁决）。 */
const EXPECTED_KINDS = [
  'panels',
  'commands',
  'tools',
  'llm',
  'renderers',
  'prompts',
  'hooks',
  'steps',
  'capabilities',
  'overlays',
  'rootViews',
  'fs',
  'shell',
  'sessionPersistence',
  'subagents',
  'agentLoop',
];

interface ConstructionSite {
  rel: string;
  kind: string;
  timing: string | null;
}

/** 抽取 `new ContributionChannel<X>('kind', { ... timing: '...' ... })` 构造点。 */
function constructionSites(): ConstructionSite[] {
  const re = /new ContributionChannel<[^>]+>\(\s*'([A-Za-z]+)'\s*,\s*\{([\s\S]{0,260}?)\}\s*\)/g;
  const sites: ConstructionSite[] = [];
  for (const f of FILES) {
    for (const m of f.text.matchAll(re)) {
      sites.push({ rel: f.rel, kind: m[1], timing: /timing:\s*'([a-z-]+)'/.exec(m[2])?.[1] ?? null });
    }
  }
  return sites;
}

describe('贡献通道内核单源（M1 终态守护）', () => {
  it('① 装载期拒绝文案只有内核一处产出（行为指纹——改名绕不过）', () => {
    const owners = FILES.filter((f) => f.text.includes('duplicate contribution')).map((f) => f.rel);
    expect(owners, '「重名贡献装载期拒绝」的实现在内核之外出现了——手抄注册表又长了回来').toEqual([KERNEL_REL]);
  });

  it('② 五份手抄类名与旧内核名不得以 class 声明 / new 调用复活', () => {
    const banned = [
      'ContributionRegistry', // 旧内核名（经宿主桥暴露过，M1 v29 退役）
      'RendererRegistry',
      'PromptRegistry',
      'HookContributionRegistry',
      'CapabilityContributionRegistry',
      'OverlayRegistry',
    ];
    const decl = new RegExp(`\\bclass\\s+(${banned.join('|')})\\b`);
    const ctor = new RegExp(`\\bnew\\s+(${banned.join('|')})\\s*\\(`);
    const hits: string[] = [];
    for (const f of FILES) {
      if (decl.test(f.text)) hits.push(`${f.rel}: class 声明`);
      if (ctor.test(f.text)) hits.push(`${f.rel}: new 调用`);
    }
    expect(hits, '被收编的手抄注册表复活了——请改用 contribution-channel 的 ContributionChannel').toEqual([]);
  });

  it('③ 16 个 service 各有一个通道构造点，且都在 composition 层（agent-loop 经宿主桥）', () => {
    const sites = constructionSites();
    const kinds = sites.map((s) => s.kind).sort();
    expect(kinds).toEqual([...EXPECTED_KINDS].sort());
    // 构造点归属：14 处在 composition/，1 处（agentLoop）在产物域
    const outside = sites.filter((s) => !s.rel.startsWith('composition/')).map((s) => `${s.rel}(${s.kind})`);
    expect(outside).toEqual(['plugins/builtin/agent-loop-service/index.ts(agentLoop)']);
  });

  it('④ 每个构造点都声明了合法的 timing（四档闭集——生效时机是数据不是注释）', () => {
    const sites = constructionSites();
    expect(sites.length).toBeGreaterThan(0);
    const illegal = sites.filter((s) => s.timing === null || !TIMINGS.includes(s.timing));
    expect(
      illegal.map((s) => `${s.rel}:${s.kind} timing=${String(s.timing)}`),
      `通道构造点必须声明 timing ∈ {${TIMINGS.join(', ')}}`,
    ).toEqual([]);
  });

  it('⑤ 内核文件保持「只有内核」——不含任何具体通道的 def 类型', () => {
    const kernel = FILES.find((f) => f.rel === KERNEL_REL);
    if (!kernel) throw new Error(`内核文件缺失: ${KERNEL_REL}`);
    // 内核只认 { id: string } 结构约束，不得 import 任何通道的贡献形状
    const channelDefs = [
      'PanelContribution',
      'CommandContribution',
      'ToolContribution',
      'LlmAdapterContribution',
      'PromptContribution',
      'HookContribution',
      'CapabilityContribution',
      'OverlayContribution',
      'BlockRendererContribution',
    ];
    // 去注释后再查：正本文件头讲的就是「这五份手抄被收编」的历史，散文提及不算耦合
    const code = kernel.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const leaked = channelDefs.filter((d) => code.includes(d));
    expect(leaked, '内核不得认识任何具体通道的贡献形状（上收即耦合）').toEqual([]);
  });
});
