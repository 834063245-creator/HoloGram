// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// office 域（C 路）守护——OfficeCLI 一等域工具：
//   ① 纯函数：动作 → argv（含缺参报错）/ 退出码解析 / batch 切块 / 输出清洗；
//   ② 工具形状：name/domain/actions/readOnlyActions + JSON Schema 动作枚举；
//   ③ plan 分档：只读动作放行、写动作拦截（readOnlyActions 白名单生效）；
//   ④ 执行面：经 process_cap/office_exec 派发（fake exec 收载荷）——argv 由本层造、
//      目标文件声明按动作分读写、相对路径按工作区根解析、粘性 cwd 沿用；
//   ⑤ 真二进制端到端随 R3 搬到 Rust（命令拼装与 spawn 都在强制层）：
//      `src-tauri/src/commands/process_cap.rs::office_command_real_binary_e2e`。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planGateCheck } from '../src/agent/plan/plan-registry';
import { PlanStateManager } from '../src/agent/plan/plan-state';
import { clearOwnerContextsForTest, registerOwnerContext } from '../src/agent/session-context';
import type { Tool, ToolExecutor } from '../src/agent/tool';
import {
  buildOfficeArgv,
  cleanShellOutput,
  createOfficeTools,
  OFFICE_ACTIONS,
  OFFICE_ARGV_MAX_CHARS,
  OFFICE_BATCH_MAX_ITEMS,
  OFFICE_READONLY_ACTIONS,
  officeArgvOversize,
  officeTargets,
  parseShellExit,
  splitOfficeBatchItems,
  validateOfficeBatchItems,
} from '../src/plugins/builtin/office-domain/office';

const identity = (p: string) => p.replace(/\\/g, '/');

describe('office 域：纯函数（argv / 目标声明 / 退出码 / 切块）', () => {
  it('buildOfficeArgv：11 个动作的 argv 形状', () => {
    const r = identity;
    expect(buildOfficeArgv({ action: 'view', file: 'a.docx' }, r)).toEqual(['view', 'a.docx', 'text']);
    expect(buildOfficeArgv({ action: 'view', file: 'a.docx', mode: 'issues', json: true }, r)).toEqual([
      'view',
      'a.docx',
      'issues',
      '--json',
    ]);
    expect(buildOfficeArgv({ action: 'get', file: 'a.docx', path: '/body/p[2]', depth: 2, json: true }, r)).toEqual([
      'get',
      'a.docx',
      '/body/p[2]',
      '--depth',
      '2',
      '--json',
    ]);
    expect(buildOfficeArgv({ action: 'query', file: 'a.docx', selector: 'paragraph[style=Heading1]' }, r)).toEqual([
      'query',
      'a.docx',
      'paragraph[style=Heading1]',
    ]);
    expect(buildOfficeArgv({ action: 'validate', file: 'a.xlsx' }, r)).toEqual(['validate', 'a.xlsx']);
    expect(buildOfficeArgv({ action: 'create', file: 'new.pptx' }, r)).toEqual(['create', 'new.pptx']);
    expect(
      buildOfficeArgv({ action: 'set', file: 'a.docx', path: '/body/p[2]', props: { firstLineChars: '200' } }, r),
    ).toEqual(['set', 'a.docx', '/body/p[2]', '--prop', 'firstLineChars=200']);
    expect(
      buildOfficeArgv(
        { action: 'add', file: 'a.docx', parent: '/body', type: 'paragraph', props: { text: '标题' } },
        r,
      ),
    ).toEqual(['add', 'a.docx', '/body', '--type', 'paragraph', '--prop', 'text=标题']);
    expect(buildOfficeArgv({ action: 'remove', file: 'a.docx', path: '/body/p[9]' }, r)).toEqual([
      'remove',
      'a.docx',
      '/body/p[9]',
    ]);
    const items = [{ command: 'set', path: '/Sheet1/A1', props: { value: 'x' } }];
    expect(buildOfficeArgv({ action: 'batch', file: 'a.xlsx', items, json: true }, r)).toEqual([
      'batch',
      'a.xlsx',
      '--commands',
      JSON.stringify(items),
      '--json',
    ]);
    expect(
      buildOfficeArgv({ action: 'merge', file: 'tpl.docx', out: 'out.docx', data: { client: 'Acme' } }, r),
    ).toEqual(['merge', 'tpl.docx', 'out.docx', '--data', JSON.stringify({ client: 'Acme' })]);
    expect(buildOfficeArgv({ action: 'screenshot', file: 'a.pptx', out: 'p1.png', page: 2 }, r)).toEqual([
      'view',
      'a.pptx',
      'screenshot',
      '-o',
      'p1.png',
      '--page',
      '2',
    ]);
    expect(buildOfficeArgv({ action: 'screenshot', file: 'a.pptx', out: 'all.png', grid: true }, r)).toEqual([
      'view',
      'a.pptx',
      'screenshot',
      '-o',
      'all.png',
      '--grid',
      'auto',
    ]);
    // playbook（专项技能）：不需要 file
    expect(buildOfficeArgv({ action: 'playbook', playbook: 'academic-paper' }, r)).toEqual([
      'load_skill',
      'academic-paper',
    ]);
  });

  it('buildOfficeArgv：缺必要参数 → 返回可直给模型的说明（不抛）', () => {
    const r = identity;
    expect(buildOfficeArgv({ action: 'get', file: 'a.docx' }, r)).toContain('get 需要 path');
    expect(buildOfficeArgv({ action: 'query', file: 'a.docx' }, r)).toContain('query 需要 selector');
    expect(buildOfficeArgv({ action: 'set', file: 'a.docx', path: '/body/p[1]' }, r)).toContain(
      'set 需要至少一个 props',
    );
    expect(buildOfficeArgv({ action: 'add', file: 'a.docx' }, r)).toContain('add 需要 type');
    expect(buildOfficeArgv({ action: 'batch', file: 'a.xlsx' }, r)).toContain('batch 需要 items');
    expect(buildOfficeArgv({ action: 'merge', file: 't.docx' }, r)).toContain('merge 需要 out');
    expect(buildOfficeArgv({ action: 'screenshot', file: 'a.pptx' }, r)).toContain('screenshot 需要 out');
    expect(buildOfficeArgv({ action: 'playbook' }, r)).toContain('playbook 需要 playbook 参数');
    expect(buildOfficeArgv({ action: 'view' }, r)).toContain('view 需要 file');
  });

  it('officeTargets：强制层只审声明的目标文件（DOM 路径 / JSON 载荷不进判定）', () => {
    const r = identity;
    expect(officeTargets({ action: 'view', file: 'a.docx' }, r)).toEqual([{ path: 'a.docx', write: false }]);
    expect(officeTargets({ action: 'batch', file: 'a.xlsx', items: [] }, r)).toEqual([{ path: 'a.xlsx', write: true }]);
    // merge：模板按写（保守）+ 成品 out 写
    expect(officeTargets({ action: 'merge', file: 't.docx', out: 'o.docx' }, r)).toEqual([
      { path: 't.docx', write: true },
      { path: 'o.docx', write: true },
    ]);
    // screenshot：源文件读 + PNG 写
    expect(officeTargets({ action: 'screenshot', file: 'a.pptx', out: 'p.png' }, r)).toEqual([
      { path: 'a.pptx', write: false },
      { path: 'p.png', write: true },
    ]);
    // playbook：无文件目标（不审路径）
    expect(officeTargets({ action: 'playbook', playbook: 'word' }, r)).toEqual([]);
  });

  it('cleanShellOutput：剥 cwd 回显；找不到二进制时补安装指引（错误不静默）', () => {
    expect(cleanShellOutput('[exit 0] ok\n[cwd: /d/ws]\n')).toBe('[exit 0] ok');
    const missing = cleanShellOutput('[exit 127] bash: line 1: officecli: command not found');
    expect(missing).toContain('command not found');
    // 2026-10-13：指引从“装安装脚本”改为“重装/修复兰台”（后端随包分发；开发机走取件脚本）
    expect(missing).toContain('重装/修复兰台');
  });

  it('cleanShellOutput：只有"二进制缺席"才补安装指引（2026-09-15 收窄——别把文件找不到误报成没装）', () => {
    // 目标文件不存在 / 路径写错：一个字都不许提"装 officecli"
    const noFile = cleanShellOutput('[exit 1] Error: Cannot open /d/ws/报告.docx: No such file or directory');
    expect(noFile).not.toContain('重装/修复兰台');
    const badDom = cleanShellOutput('[exit 1] ERROR: Sheet not found: "参数表"');
    expect(badDom).not.toContain('重装/修复兰台');
    // 真缺席两种拼写都要认（PATH 形态 / 绝对路径形态）
    expect(cleanShellOutput('[exit 127] bash: line 1: officecli: command not found')).toContain('重装/修复兰台');
    expect(
      cleanShellOutput(
        '[exit 127] bash: line 1: /c/u/.lantai/tools/officecli/officecli.exe: No such file or directory',
      ),
    ).toContain('重装/修复兰台');
  });

  it('parseShellExit：两种形态都认（seam 的 `[exit N]` 与能力口原文的 `[exit code: N]`）；读不到 = null', () => {
    // ① 流式 shell seam（runtime/queued-shell.ts）形态——shell 域走这条
    expect(parseShellExit('[exit 0] ok')).toBe(0);
    expect(parseShellExit('[exit 127] bash: officecli: command not found')).toBe(127);
    expect(parseShellExit('\n[exit 1] boom')).toBe(1);
    // ② 能力口原文形态——office 域直呼 process_cap::office_exec，生产只产这一种
    //    （2026-09-16 审计：此前只认 ① ⇒ 成功与失败都读成 null ⇒ 写动作恒报"结果未知"、
    //    多批 batch 第 1 批假失败——landmine O3 的三态逻辑被 R3 重构静默放回）
    expect(parseShellExit('[exit code: 0]\nrecorded')).toBe(0);
    expect(parseShellExit('[exit code: 1]\n[1] ERROR: Sheet not found')).toBe(1);
    expect(parseShellExit('[exit code: -1] 命令超时 (120000ms)')).toBe(-1);
    expect(parseShellExit('  [exit code: 127] x')).toBe(127);
    // 未知不许当成功（也不许当失败——批量分支按"结果未知"单独报账）
    expect(parseShellExit('ok without marker')).toBeNull();
    expect(parseShellExit('')).toBeNull();
    expect(parseShellExit('[exit code: abc]')).toBeNull();
  });

  it('splitOfficeBatchItems：条数上限与字节上限双约束，超大单项独占一块', () => {
    expect(splitOfficeBatchItems([])).toEqual([]);
    const small = (n: number) => Array.from({ length: n }, (_, i) => ({ command: 'set', path: `/Sheet1/A${i + 1}` }));
    const chunks = splitOfficeBatchItems(small(250));
    expect(chunks.map((c) => c.length)).toEqual([OFFICE_BATCH_MAX_ITEMS, OFFICE_BATCH_MAX_ITEMS, 50]);
    // 字节上限先到：3 个 ~6KB 项 → 各自一块（2×6KB+2 > 12KB）
    const fat = Array.from({ length: 3 }, () => ({ command: 'set', props: { value: 'x'.repeat(6000) } }));
    expect(splitOfficeBatchItems(fat).map((c) => c.length)).toEqual([1, 1, 1]);
    // 单项就超上限 → 也得自成一块（切不开，只能交给上层报错）
    const huge = [{ command: 'set', props: { value: 'y'.repeat(20000) } }, { command: 'set' }];
    expect(splitOfficeBatchItems(huge).map((c) => c.length)).toEqual([1, 1]);
  });
});

describe('office 域：工具形状与 plan 分档', () => {
  const tools = createOfficeTools(async () => 'noop');
  const tool = tools[0]!;

  it('形状：单工具 office / 域 office / 12 动作 / 5 只读动作 / 整体非只读', () => {
    expect(tools).toHaveLength(1);
    expect(tool.name()).toBe('office');
    expect(tool.domain?.()).toBe('office');
    expect(tool.actions?.()).toEqual([...OFFICE_ACTIONS]);
    expect(tool.readOnlyActions?.()).toEqual([...OFFICE_READONLY_ACTIONS]);
    // 混合读写域：整体 readOnly=false（照 domains.ts buildDomainTool 同款判据）
    expect(tool.readOnly()).toBe(false);
    const schema = tool.parameters() as { properties?: { action?: { enum?: string[] } } };
    expect(schema.properties?.action?.enum).toEqual([...OFFICE_ACTIONS]);
  });

  it('plan 分档：只读动作放行、写动作拦截（白名单生效）', () => {
    const ps = new PlanStateManager();
    ps.enter('D:/ws');
    for (const action of OFFICE_READONLY_ACTIONS) {
      expect(planGateCheck(ps, 'office', { action }, tool)).toBeNull();
    }
    for (const action of ['create', 'set', 'add', 'remove', 'batch', 'merge', 'screenshot']) {
      expect(planGateCheck(ps, 'office', { action }, tool)).toContain('[已拦截]');
    }
  });

  it('形状：动作面覆盖 MCP 路原有能力（含 playbook＝load_skill 专项技能，不丢面）', () => {
    expect(OFFICE_ACTIONS).toHaveLength(12);
    expect(OFFICE_ACTIONS).toContain('playbook');
    expect(OFFICE_READONLY_ACTIONS).toContain('playbook');
  });
});

describe('office 域：执行面（经 process_cap office_exec 派发）', () => {
  const captured: Array<{ name: string; args: Record<string, unknown> }> = [];
  let tool: Tool;
  /** 下一次能力口回执（各用例按需改写——退出码语义靠它驱动）。
   *  形态取**生产真形**：office 走 process_cap::office_exec，成功 = `[exit code: 0]`。 */
  let nextResult = '[exit code: 0]\nrecorded';
  /** 按调用序号出队的回执脚本（空则用 nextResult）——多批场景靠它逐步改判。 */
  let scripted: string[] = [];

  /** 假 exec：记录 (能力口名, 载荷) 并按脚本回执。 */
  const fakeExec: ToolExecutor = async (name, args) => {
    captured.push({ name, args });
    return scripted.shift() ?? nextResult;
  };

  const officeOf = (i = 0) =>
    captured[i]?.args.office as { argv: string[]; targets: Array<{ path: string; write: boolean }> };

  beforeAll(() => {
    clearOwnerContextsForTest();
    registerOwnerContext('owner-1', 'D:\\ws');
    tool = createOfficeTools(fakeExec)[0]!;
  });

  afterAll(() => clearOwnerContextsForTest());

  it('走 process_cap/office_exec：交 argv + 声明的目标（命令由 Rust 拼，2026-09-15 R3）', async () => {
    captured.length = 0;
    const out = await tool.execute({ action: 'view', file: '报告.docx', mode: 'issues', _owner_id: 'owner-1' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.name).toBe('process_cap');
    expect(captured[0]?.args.action).toBe('office_exec');
    // argv 由本层造（动作→CLI 参数），路径按工作区根解析
    expect(officeOf().argv).toEqual(['view', 'D:/ws/报告.docx', 'issues']);
    // 声明的目标 = 强制层唯一审的文件系统面；view 是读
    expect(officeOf().targets).toEqual([{ path: 'D:/ws/报告.docx', write: false }]);
    // meta 身份原样透传（审计/通知路由）
    expect(captured[0]?.args._owner_id).toBe('owner-1');
    expect(out).toContain('recorded');
  });

  it('目标声明按动作分读写：set 写文件；screenshot 读源 + 写 PNG', async () => {
    captured.length = 0;
    await tool.execute({
      action: 'set',
      file: 'a.docx',
      path: '/body/p[1]',
      props: { bold: 'true' },
      _owner_id: 'owner-1',
    });
    expect(officeOf().targets).toEqual([{ path: 'D:/ws/a.docx', write: true }]);

    captured.length = 0;
    await tool.execute({ action: 'screenshot', file: 'a.pptx', out: 'p1.png', page: 1, _owner_id: 'owner-1' });
    expect(officeOf().targets).toEqual([
      { path: 'D:/ws/a.pptx', write: false },
      { path: 'D:/ws/p1.png', write: true },
    ]);

    // playbook 无文件目标（不审路径）
    captured.length = 0;
    nextResult = '[exit code: 0]\nLoaded skill';
    await tool.execute({ action: 'playbook', playbook: 'excel', _owner_id: 'owner-1' });
    expect(officeOf().targets).toEqual([]);
    expect(officeOf().argv).toEqual(['load_skill', 'excel']);
  });

  it('cwd 沿用 owner 粘性值（不把 shell 域的 cwd 顶掉）', async () => {
    captured.length = 0;
    await tool.execute({ action: 'validate', file: 'D:/ws/a.xlsx', _owner_id: 'owner-1' });
    expect(captured[0]?.args.cwd).toBe('D:\\ws');
  });

  it('落盘脚注只认退出码：成功才声明，失败/未知一律不声明（2026-09-15 假成功事故）', async () => {
    captured.length = 0;
    nextResult = '[exit code: 0]\nrecorded\n[cwd: /d/ws]';
    const write = await tool.execute({
      action: 'set',
      file: 'D:/ws/a.docx',
      path: '/body/p[1]',
      props: { bold: 'true' },
    });
    expect(write).toContain('改动已落盘');

    // 失败：officecli 报错 + 非零退出码 → 不得出现"已落盘/已提交"这类成功话术
    nextResult = '[exit code: 1]\n[1] ERROR: Sheet not found: "参数表"\nBatch complete: 0 succeeded, 3 failed';
    const failed = await tool.execute({
      action: 'set',
      file: 'D:/ws/a.docx',
      path: '/body/p[1]',
      props: { bold: 'true' },
    });
    expect(failed).toContain('未成功');
    expect(failed).not.toContain('改动已落盘');

    // 退出码读不到（别的 shell provider / 回执形状变了）→ 未知，同样不许声明成功
    nextResult = 'recorded without exit marker';
    const unknown = await tool.execute({
      action: 'set',
      file: 'D:/ws/a.docx',
      path: '/body/p[1]',
      props: { bold: 'true' },
    });
    expect(unknown).toContain('没拿到退出码');
    expect(unknown).not.toContain('改动已落盘');

    // 只读动作任何情况下都不带脚注
    nextResult = '[exit code: 0]\nrecorded\n[cwd: /d/ws]';
    const read = await tool.execute({ action: 'validate', file: 'D:/ws/a.docx' });
    expect(read).not.toContain('改动已落盘');
    expect(read).not.toContain('未成功');
  });

  it('create 关掉外部常驻进程时明说（用户的 watch 需重起）', async () => {
    captured.length = 0;
    nextResult = '[exit code: 0]\nResident closed for a.xlsx\nCreated: D:/ws/a.xlsx';
    const out = await tool.execute({ action: 'create', file: 'D:/ws/a.xlsx' });
    expect(out).toContain('外部');
    expect(out).toContain('watch');
    expect(out).toContain('改动已落盘');
  });

  it('batch 超限自动切块：顺序执行、逐批报账（2026-09-15 静默丢行事故）', async () => {
    captured.length = 0;
    nextResult = '[exit code: 0]\nBatch complete: ok';
    const items = Array.from({ length: 250 }, (_, i) => ({
      command: 'set',
      path: `/Sheet1/A${i + 1}`,
      props: { value: String(i) },
    }));
    const out = await tool.execute({ action: 'batch', file: 'D:/ws/a.xlsx', items });
    // 250 项 / 上限 100 → 3 批 ⇒ 3 次 CLI 调用，且每批自身 ≤100 项
    expect(captured).toHaveLength(3);
    const perCall = captured.map((c) => {
      const argv = (c.args.office as { argv: string[] }).argv;
      const idx = argv.indexOf('--commands');
      expect(idx).toBeGreaterThan(0);
      return JSON.parse(argv[idx + 1] ?? '[]') as unknown[];
    });
    expect(perCall.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(out).toContain('分 3 批执行');
    expect(out).toContain('共 250 项');
  });

  it('batch 中途失败：停在原地并说清哪几批已落盘（不回退、不重来）', async () => {
    captured.length = 0;
    scripted = [
      '[exit code: 0]\nBatch complete: 100 succeeded',
      '[exit code: 1]\nBatch complete: 100 failed, 100 total',
    ];
    const out = await tool.execute({
      action: 'batch',
      file: 'D:/ws/a.xlsx',
      items: Array.from({ length: 250 }, (_, i) => ({ command: 'set', path: `/Sheet1/A${i + 1}` })),
    });
    scripted = [];
    expect(captured).toHaveLength(2); // 第 2 批失败即停，不再跑第 3 批
    expect(out).toContain('第 2/3 批失败并已停下');
    expect(out).toContain('前 1 批已落盘');
  });

  it('batch 第 N 批结果未知（无退出码）：单独报"未知"，不许当失败、更不许整表重来', async () => {
    captured.length = 0;
    scripted = ['[exit code: 0]\nBatch complete: 100 succeeded', 'output without exit marker'];
    const out = await tool.execute({
      action: 'batch',
      file: 'D:/ws/a.xlsx',
      items: Array.from({ length: 250 }, (_, i) => ({ command: 'set', path: `/Sheet1/A${i + 1}` })),
    });
    scripted = [];
    expect(captured).toHaveLength(2);
    // 未知 ≠ 失败：话术分开（此前 null !== 0 一律按"失败"报，把可能已生效的批次说成失败）
    expect(out).toContain('第 2/3 批**结果未知**');
    expect(out).not.toContain('第 2/3 批失败并已停下');
    // 出路是"先核对再决定补做"，而不是重跑整表（add/batch 是追加型，重来 = 内容重复）
    expect(out).toContain('office(view)');
    expect(out).toContain('不要整表重来');
  });

  it('batch 项形状预检：派发前拦下（键名猜错 / command 成命令行串 / 缺必需字段）', async () => {
    captured.length = 0;
    nextResult = '[exit code: 0]\nBatch complete: ok';

    // ① 键名猜错——O5 的典型形态：形状只活在技能文档里，模型拿不到就会把动作名塞到别的键上
    const wrongKey = await tool.execute({
      action: 'batch',
      file: 'D:/ws/a.xlsx',
      items: [{ op: 'set', path: '/Sheet1/A1', props: { value: 'x' } }],
    });
    expect(wrongKey).toContain('第 1 项缺 command');
    expect(wrongKey).toContain('op');
    // ② command 塞成命令行串（要的是裸动词，参数同级）
    const cmdline = await tool.execute({
      action: 'batch',
      file: 'D:/ws/a.xlsx',
      items: [{ command: 'officecli set --path /Sheet1/A1' }],
    });
    expect(cmdline).toContain('命令行串');
    // ③ 已知动词缺必需字段
    const missingField = await tool.execute({
      action: 'batch',
      file: 'D:/ws/a.xlsx',
      items: [{ command: 'add', parent: '/body' }],
    });
    expect(missingField).toContain('command="add" 缺 type');
    // ④ 报错点名技能章节 + 明说"未执行任何一项"，且**一次都没派发**（无部分落盘）
    expect(missingField).toContain('officecli 技能 §5.1');
    expect(missingField).toContain('未执行任何一项');
    expect(captured).toHaveLength(0);
  });

  it('batch 合法项照常放行（宁窄勿宽：不查 props 内部键，未知裸动词也放行）', async () => {
    captured.length = 0;
    nextResult = '[exit code: 0]\nBatch complete: ok';
    const ok = await tool.execute({
      action: 'batch',
      file: 'D:/ws/a.xlsx',
      items: [
        { command: 'set', path: '/Sheet1/A1', props: { value: '标题', 未知键: 'y' } },
        { command: 'move', selector: 'row[2]', to: '/Sheet1/A5' },
        { command: 'clear', path: '/Sheet1/B2' }, // 未知裸动词：交给 officecli 判，不误拒
      ],
    });
    expect(ok).toContain('Batch complete: ok');
    expect(captured).toHaveLength(1);
  });

  it('尺寸闸：非 batch 写动作的超长载荷在派发前被拦（静默截断的另一入口）', async () => {
    captured.length = 0;
    const out = await tool.execute({
      action: 'add',
      file: 'D:/ws/a.docx',
      parent: '/body',
      type: 'paragraph',
      props: { text: 'x'.repeat(OFFICE_ARGV_MAX_CHARS + 100) },
    });
    expect(out).toContain('add 无法单次送达');
    expect(out).toContain('静默截断');
    expect(out).toContain('拆成多次调用');
    expect(captured).toHaveLength(0); // 未派发 ⇒ 不会"回执说成功而字节没进去"
  });

  it('尺寸闸：batch 单块超限（切不开的单项）同样拦在派发前', async () => {
    captured.length = 0;
    const out = await tool.execute({
      action: 'batch',
      file: 'D:/ws/a.xlsx',
      items: [{ command: 'set', path: '/Sheet1/A1', props: { value: 'y'.repeat(OFFICE_ARGV_MAX_CHARS + 100) } }],
    });
    expect(out).toContain('第 1/1 块');
    expect(out).toContain('静默截断');
    expect(captured).toHaveLength(0);
  });

  it('纯函数面：validateOfficeBatchItems / officeArgvOversize 的边界', () => {
    expect(validateOfficeBatchItems([{ command: 'set', path: '/a', props: { v: '1' } }])).toBeNull();
    expect(validateOfficeBatchItems([{ command: 'remove', path: '/a' }])).toBeNull();
    expect(validateOfficeBatchItems([null])).toContain('不是对象');
    expect(validateOfficeBatchItems([{ command: 'set', props: { v: '1' } }])).toContain('缺 path');
    // 尺寸：正好等于上限放行，超一个字符就拦
    expect(officeArgvOversize('x'.repeat(OFFICE_ARGV_MAX_CHARS))).toBeNull();
    expect(officeArgvOversize('x'.repeat(OFFICE_ARGV_MAX_CHARS + 1))).toContain('单次上限');
  });

  it('playbook 结果前置环境护栏（正文是命令行指南，本环境跑不了）', async () => {
    captured.length = 0;
    nextResult = '[exit code: 0]\n# OfficeCLI XLSX Skill\n\n## Help-First Rule\n\n```bash\nofficecli help xlsx\n```';
    const out = await tool.execute({ action: 'playbook', playbook: 'excel', _owner_id: 'owner-1' });
    expect(out).toContain('在本环境不可执行');
    expect(out).toContain('不在 shell 的 PATH 里');
    expect(out).toContain('Help-First Rule'); // 正文照旧保留（护栏是前缀，不是替换）
    // 护栏不放行"只在文档里写"：真派发（load_skill）照旧发生
    expect(captured[0]?.args.action).toBe('office_exec');
    expect(officeOf().argv).toEqual(['load_skill', 'excel']);
  });

  it('缺参不派发、直接回说明（省一次进程）', async () => {
    captured.length = 0;
    const out = await tool.execute({ action: 'set', file: 'D:/ws/a.docx', path: '/body/p[1]' });
    expect(out).toContain('set 需要至少一个 props');
    expect(captured).toHaveLength(0);
  });
});
