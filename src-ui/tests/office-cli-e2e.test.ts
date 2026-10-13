// officecli **语义**真机回归（真实二进制）——经 MCP 最小挂载器驱动，**不是产品路**。
//
// 定位（2026-09-13 C 路改判后重述）：产品路已改为内置 office 域工具（`office(action,…)`，
// 守护在 tests/office-domain.test.ts）。本文件保留是因为它用**最小挂载器**（一个 manifest 形状的
// server 声明 + registerMcpServerTools）就能把 officecli 当纯 CLI 驱动，用来钉**officecli 自身的
// 语义**——这些结论同时是出厂技能 `officecli` 正文（`builtin-skills.ts`）的实测依据：
//   ① 挂载器形状与真实 tools/list（`mcp__office__officecli`）+ **P0 只读语义**（无 annotations
//      ⇒ readOnly=false，旧实现恒 true 会让写动作绕过 plan 门禁）；
//   ② 真写盘与落盘边界（别的程序读的是盘上字节）；
//   ③ 预览原料：`view screenshot` 产出真 PNG（纸面截图路的输入）；
//   ④ 交付门槛覆盖面（抓得到 pptx 越界/溢出、xlsx 公式错与未求值；抓不到占位符/alt/空白）；
//   ⑤ 读数陷阱（待决删除在 view text 里不显示）、修订按作者接受、模板 dump→batch→merge 往返、
//      单位/颜色/行距全形态、pptx 全流程。
//
// 跳过纪律（仓库既有纪律：真实环境测试缺条件自动跳过，不炸 CI）：
//   二进制缺席（未装且未设 OFFICECLI_PATH）= 整套 skip。
//   本机安装位：%USERPROFILE%\.lantai\tools\officecli\officecli.exe

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeStdioProc } from '../src/agent/mcp/transport';
import { planGateCheck } from '../src/agent/plan/plan-registry';
import { PlanStateManager } from '../src/agent/plan/plan-state';
import type { Tool } from '../src/agent/tool';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { type McpBridgeIO, registerMcpServerTools } from '../src/plugins/mcp-bridge';
import type { McpServerDecl } from '../src/plugins/types';

const BIN = process.env.OFFICECLI_PATH ?? join(homedir(), '.lantai', 'tools', 'officecli', 'officecli.exe');
const available = existsSync(BIN);

// 子进程继承本进程 env——关掉后台自动更新检查（部署纪律，计划 §7 坑 4）
process.env.OFFICECLI_SKIP_UPDATE = '1';

const WORK = available ? mkdtempSync(join(tmpdir(), 'lantai-officecli-e2e-')) : '';
const DOCX = `${WORK.replace(/\\/g, '/')}/端到端.docx`;
const PNG = `${WORK.replace(/\\/g, '/')}/第1页.png`;

/** 与安装位 mcp.json 同形的声明（受治进程：lazy + on-crash）——覆盖面与真机一致。
 *  注意**不声明 readOnly**：officecli 写文件，缺省 fail-closed 视为写才是期望行为。 */
const SERVER: McpServerDecl = {
  name: 'office',
  transport: 'stdio',
  command: BIN,
  args: ['mcp'],
  lifecycle: 'lazy',
  restart: 'on-crash',
};

const io: McpBridgeIO = {
  // 真实 stdio 桥（Node 侧等价实现；生产走 Rust protocol_bridge，协议面同一）
  createProcIO: async (_bridgeId, command, args) => createNodeStdioProc(command, args),
  pluginDir: async () => WORK,
};

const d = available ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立（真实时钟——受治进程就绪是真实 setTimeout + 真进程握手）。 */
async function pollUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 60_000, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(stepMs);
  }
  return await cond();
}

let root: Context | null = null;
let fiber: Awaited<ReturnType<Context['plugin']>> | null = null;
let tool: Tool | null = null;

/** 取行 factory 的工具面（受治 lazy：未就绪返回空集，就绪后整组产出）。 */
async function factoryTools(): Promise<Tool[]> {
  const row = pluginToolRows().find((r) => r.id === 'plugin/office-e2e/mcp/office');
  if (!row) throw new Error('未折算出行 plugin/office-e2e/mcp/office');
  return await row.factory({} as never);
}

beforeAll(async () => {
  root = new Context();
  await root.plugin(compositionServicesPlugin);
  fiber = await root.plugin({
    name: 'office-e2e',
    inject: ['tools'],
    async apply(ctx) {
      await registerMcpServerTools(ctx, 'office-e2e', [SERVER], io);
    },
  });
  // 受治 lazy：装配非阻塞（首装配空集是按设计），轮询到握手就绪 + 快照到位
  await pollUntil(async () => (await factoryTools()).length > 0);
  const tools = await factoryTools();
  tool = tools[0] ?? null;
}, 180_000);

afterAll(async () => {
  await fiber?.dispose();
  await root?.[Symbol.asyncDispose]?.();
  if (WORK) {
    try {
      rmSync(WORK, { recursive: true, force: true });
    } catch {
      // 临时目录残留不影响判定（resident 已 close，正常可删）
    }
  }
});

d('OfficeCLI A 路端到端（真实二进制）', () => {
  it('① 折算工具行 → 真实 tools/list 出 mcp__office__officecli；② 只读语义 fail-closed 为写', () => {
    expect(tool).not.toBeNull();
    const create = tool!;
    expect(create.name()).toBe('mcp__office__officecli');
    // ② P0 真机证据：officecli 的 MCP 工具无 annotations ⇒ 视为写
    expect(create.readOnly()).toBe(false);
    // 计划 §8 反向判据（真工具）：plan 模式下被拦截，而非放行落盘
    const planState = new PlanStateManager();
    planState.enter(WORK);
    expect(planGateCheck(planState, create.name(), {}, create)).toContain('[已拦截]');
  }, 180_000);

  it('③ 真写盘：create → add → save 后 view text 读回内容（落盘边界）', async () => {
    const create = tool!;
    const run = (command: string[]) => create.execute({ command }) as Promise<string>;

    expect(await run(['create', DOCX])).toContain('Created');
    expect(await run(['add', DOCX, '/body', '--type', 'paragraph', '--prop', 'text=兰台端到端测试'])).toContain(
      'Added paragraph',
    );
    // save 是幂等的：实测两种回执——"Saved x" / "x is already saved to disk."
    // （resident 在命令间隙可能已自动落盘；自适应 2-10s 空闲 flush）
    expect(await run(['save', DOCX])).toMatch(/Saved|already saved/i);

    // 盘上真文件（resident 延迟写盘的坑：save 前读不到——这正是集成计划 §7 坑 3 的判据）
    expect(existsSync(DOCX)).toBe(true);
    expect(statSync(DOCX).size).toBeGreaterThan(1000);

    const text = await run(['view', DOCX, 'text']);
    expect(text).toContain('兰台端到端测试');
    expect(await run(['validate', DOCX])).toContain('no errors');
  }, 180_000);

  it('④ 预览原料：view screenshot 产出真 PNG（纸面截图路的输入）', async () => {
    const out = (await tool!.execute({
      command: ['view', DOCX, 'screenshot', '-o', PNG, '--page', '1'],
    })) as string;
    expect(out).toContain('.png');
    expect(existsSync(PNG)).toBe(true);
    const bytes = readFileSync(PNG);
    expect(bytes.length).toBeGreaterThan(1000);
    // PNG magic（89 50 4E 47）——确是真图，不是错误文本落盘
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 180_000);

  it('⑤ close 释放 resident（flush + 释放句柄——交付/外部打开前的收尾动作）', async () => {
    const out = (await tool!.execute({ command: ['close', DOCX] })) as string;
    expect(out.toLowerCase()).toContain('close');
  }, 120_000);

  it('⑥ 交付物工作流（批次①）：一次 batch 建报告骨架 → validate 干净 → 交付门槛真拦人 → 修复清零', async () => {
    const docx = `${WORK}/交付.docx`;
    const run = (command: string[]) => tool!.execute({ command }) as Promise<string>;

    await run(['create', docx]);
    // 一次 batch 建骨架（styles 必须在最前：新建文档只有 Normal——实测）
    const batch = [
      {
        command: 'add',
        parent: '/styles',
        type: 'style',
        props: { id: 'Heading1', name: 'heading 1', type: 'paragraph', basedOn: 'Normal' },
      },
      { command: 'add', parent: '/body', type: 'paragraph', props: { text: '季度研究报告', style: 'Heading1' } },
      { command: 'add', parent: '/body', type: 'paragraph', props: { text: '本季度收入同比增长 25%。' } },
    ];
    const out = await run(['batch', docx, '--commands', JSON.stringify(batch), '--json']);
    const parsed = JSON.parse(out) as { success: boolean; data: { summary: { succeeded: number; failed: number } } };
    expect(parsed.success).toBe(true);
    expect(parsed.data.summary).toMatchObject({ succeeded: 3, failed: 0 });

    expect(await run(['validate', docx])).toContain('no errors');

    // 交付门槛真拦人：中文正文缺首行缩进（F1）——实测默认就报，验证"validate 通过 ≠ 可交付"
    expect(await run(['view', docx, 'issues'])).toContain('first-line indent');
    // 修复：2 字符首行缩进（firstLineChars 是 1/100 字符单位）
    expect(await run(['set', docx, '/body/p[2]', '--prop', 'firstLineChars=200'])).toContain('firstLineChars=200');
    expect(await run(['view', docx, 'issues'])).toContain('0 issue');
    expect(await run(['save', docx])).toMatch(/Saved|already saved/i);
  }, 180_000);

  it('⑦ 注疏回写（批次②）：原生批注 + 修订痕迹 → 读回 → 按 nativePath 接受修订', async () => {
    const docx = `${WORK}/来文.docx`;
    const run = (command: string[]) => tool!.execute({ command }) as Promise<string>;

    await run(['create', docx]);
    await run(['add', docx, '/body', '--type', 'paragraph', '--prop', 'text=来文第一段：本季度收入增长 25%。']);
    await run(['add', docx, '/body', '--type', 'paragraph', '--prop', 'text=来文第二段：成本同比持平。']);

    // ① Word 原生批注（锚在段落上）
    expect(await run(['add', docx, '/body/p[1]', '--type', 'comment', '--prop', 'text=口径需与附件核对'])).toContain(
      '/comments/comment[1]',
    );
    // ② 修订痕迹：**run 宿主必须 type 与 author 成对**（help 明载：裸 author 会被拒——防空快照记录）
    expect(
      await run(['set', docx, '/body/p[2]/r[1]', '--prop', 'revision.type=ins', '--prop', 'revision.author=兰台']),
    ).toContain('revision.type=ins');

    // ③ 读回：批注（/comments）与修订（query revision）都在
    expect(await run(['get', docx, '/comments', '--json'])).toContain('口径需与附件核对');
    const revs = JSON.parse(await run(['query', docx, 'revision', '--json'])) as {
      data: { matches: number; results: { format: Record<string, unknown> }[] };
    };
    expect(revs.data.matches).toBe(1);
    expect(revs.data.results[0]?.format['revision.author']).toBe('兰台');

    // ④ 接受修订：地址是 **native path**（/body/p[N]/ins[1]），不是 /revision[@id=]
    expect(await run(['set', docx, '/body/p[2]/ins[1]', '--prop', 'revision.action=accept'])).toContain(
      'revision.action=accept',
    );
    const after = JSON.parse(await run(['query', docx, 'revision', '--json'])) as { data: { matches: number } };
    expect(after.data.matches).toBe(0); // 修订已决（接受后不再挂 revision 节点）
    // 批注不受修订接受影响（两条通道互不干扰）
    expect(await run(['get', docx, '/comments', '--json'])).toContain('口径需与附件核对');
    expect(await run(['validate', docx])).toContain('no errors');
  }, 180_000);

  it('⑧ xlsx 数据面（批次③）：公式写即求值 + 透视表随文件落 OOXML', async () => {
    const xlsx = `${WORK}/数据.xlsx`;
    const run = (command: string[]) => tool!.execute({ command }) as Promise<string>;

    await run(['create', xlsx]);
    await run(['set', xlsx, '/Sheet1/A1', '--prop', 'value=Region', '--prop', 'bold=true']);
    await run(['set', xlsx, '/Sheet1/B1', '--prop', 'value=Revenue', '--prop', 'bold=true']);
    await run(['set', xlsx, '/Sheet1/A2', '--prop', 'value=EMEA']);
    await run(['set', xlsx, '/Sheet1/B2', '--prop', 'value=1200']);
    await run(['set', xlsx, '/Sheet1/A3', '--prop', 'value=APAC']);
    await run(['set', xlsx, '/Sheet1/B3', '--prop', 'value=900']);
    // 公式：prop 值以 `=` 开头 ⇒ 写成 `key==FORMULA`（实测：漏前导 = 会被当字符串存，evaluated=false）
    await run(['set', xlsx, '/Sheet1/B4', '--prop', 'value==SUM(B2:B3)']);

    const cell = JSON.parse(await run(['get', xlsx, '/Sheet1/B4', '--json'])) as {
      data: { results: { format: Record<string, unknown> }[] };
    };
    expect(cell.data.results[0]?.format).toMatchObject({
      type: 'Number',
      formula: 'SUM(B2:B3)',
      evaluated: true,
      computedValue: '2100', // 写入即算，无需 Excel 回环
    });

    // 透视表：一条命令落 OOXML（Excel 打开即见聚合）
    expect(
      await run([
        'add',
        xlsx,
        '/Sheet1',
        '--type',
        'pivottable',
        '--prop',
        'source=Sheet1!A1:B3',
        '--prop',
        'rows=Region',
        '--prop',
        'values=Revenue:sum',
      ]),
    ).toContain('pivottable');
    const text = await run(['view', xlsx, 'text']);
    expect(text).toContain('Grand Total');
    expect(await run(['validate', xlsx])).toContain('no errors');
  }, 180_000);

  it('⑨ 活预览最小形态（截图刷新路）：改完 save → 重截同一路径 → 图真的变（不是旧图）', async () => {
    const docx = `${WORK}/预览.docx`;
    const png = `${WORK}/预览-第1页.png`;
    const run = (command: string[]) => tool!.execute({ command }) as Promise<string>;
    const shot = async (): Promise<Buffer> => {
      await run(['view', docx, 'screenshot', '-o', png, '--page', '1']);
      return readFileSync(png);
    };

    await run(['create', docx]);
    await run(['add', docx, '/body', '--type', 'paragraph', '--prop', 'text=第一行']);
    await run(['save', docx]);
    const before = await shot();
    expect([...before.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    // 改内容 → 落盘 → 覆盖截同一路径（update_asset 刷新用的正是这个语义）
    await run(['add', docx, '/body', '--type', 'paragraph', '--prop', 'text=第二行（刷新后应可见）']);
    await run(['save', docx]);
    expect(await run(['view', docx, 'text'])).toContain('第二行');
    const after = await shot();

    // 图标判据：内容真变了 ⇒ 图也必须变（旧图会被用户看成"没生效"）
    expect(after.equals(before)).toBe(false);
    expect(after.length).not.toBe(before.length);
  }, 180_000);

  it('⑩ 模板工作流（skill §7.2）：dump 出蓝图 → batch 回放 → merge 填 {{key}}', async () => {
    const src = `${WORK}/样张.docx`;
    const replay = `${WORK}/回放.docx`;
    const blueprint = `${WORK}/blueprint.json`;
    const template = `${WORK}/模板.docx`;
    const merged = `${WORK}/成品.docx`;
    const run = (command: string[]) => tool!.execute({ command }) as Promise<string>;

    // 造一份「样张」：样式 + 标题 + 正文 + 表格（一次 batch）
    await run(['create', src]);
    const build = [
      {
        command: 'add',
        parent: '/styles',
        type: 'style',
        props: { id: 'Heading1', name: 'heading 1', type: 'paragraph', basedOn: 'Normal' },
      },
      { command: 'add', parent: '/body', type: 'paragraph', props: { text: '季度报告', style: 'Heading1' } },
      { command: 'add', parent: '/body', type: 'paragraph', props: { text: '正文一段。' } },
      { command: 'add', parent: '/body', type: 'table', props: { rows: '2', cols: '2' } },
    ];
    const built = JSON.parse(await run(['batch', src, '--commands', JSON.stringify(build), '--json'])) as {
      data: { summary: { failed: number } };
    };
    expect(built.data.summary.failed).toBe(0);
    await run(['save', src]);

    // dump：整篇 → 可回放蓝图（结构化，不是裸 XML）
    expect(await run(['dump', src, '-o', blueprint])).toContain('blueprint.json');
    expect(existsSync(blueprint)).toBe(true);

    // batch 回放：换一份新件照蓝图重建（实测 16 项全成）
    await run(['create', replay]);
    const replayed = JSON.parse(await run(['batch', replay, '--input', blueprint, '--json'])) as {
      success: boolean;
      data: { summary: { succeeded: number; failed: number } };
    };
    expect(replayed.success).toBe(true);
    expect(replayed.data.summary.failed).toBe(0);
    expect(replayed.data.summary.succeeded).toBeGreaterThan(10); // 蓝图是细粒度项集（非 4 项）
    const replayText = await run(['view', replay, 'text']);
    expect(replayText).toContain('季度报告');
    expect(replayText).toContain('正文一段。');
    expect(replayText).toContain('[Table: 2 rows]');
    expect(await run(['validate', replay])).toContain('no errors');

    // merge：{{key}} 模板填充（工作表流：样式设计一次 → 数据灌 N 次）
    await run(['create', template]);
    const tpl = [
      { command: 'add', parent: '/body', type: 'paragraph', props: { text: '客户：{{client}}' } },
      { command: 'add', parent: '/body', type: 'paragraph', props: { text: '金额：{{total}} 元' } },
    ];
    await run(['batch', template, '--commands', JSON.stringify(tpl), '--json']);
    await run(['save', template]);
    const mergeOut = await run(['merge', template, merged, '--data', '{"client":"Acme","total":"5,200"}']);
    expect(mergeOut).toContain('Replaced keys: 2');
    const mergedText = await run(['view', merged, 'text']);
    expect(mergedText).toContain('客户：Acme');
    expect(mergedText).toContain('金额：5,200 元');
    expect(mergedText).not.toContain('{{');
  }, 240_000);

  it('⑪ 待决修订的读数语义（skill §7.3 陷阱）：view text 隐藏、annotated 不标注、query revision 才是真源', async () => {
    const docx = `${WORK}/读数.docx`;
    const run = (command: string[]) => tool!.execute({ command }) as Promise<string>;

    await run(['create', docx]);
    await run(['add', docx, '/body', '--type', 'paragraph', '--prop', 'text=第一句（我改）']);
    await run(['add', docx, '/body', '--type', 'paragraph', '--prop', 'text=第二句（他人改）']);
    // 一个 run 同时只能挂一个修订（再叠会报 "run is already inside a track-change wrapper"）
    await run(['set', docx, '/body/p[1]/r[1]', '--prop', 'revision.type=ins', '--prop', 'revision.author=兰台']);
    await run(['set', docx, '/body/p[2]/r[1]', '--prop', 'revision.type=del', '--prop', 'revision.author=他人']);
    // 同一 run 叠第二个修订 → 报错（负例，钉住"一 run 一修订"）
    const conflict = await run([
      'set',
      docx,
      '/body/p[2]/r[1]',
      '--prop',
      'revision.type=ins',
      '--prop',
      'revision.author=兰台',
    ]);
    expect(conflict.toLowerCase()).toContain('track-change wrapper');

    // 真源：query revision 看得见两条（含作者/类型）
    const revs = JSON.parse(await run(['query', docx, 'revision', '--json'])) as {
      data: { matches: number; results: { format: Record<string, unknown> }[] };
    };
    expect(revs.data.matches).toBe(2);
    // 判定用「集合」口径：query 按**文档序**回（兰台 在 p1、他人 在 p2），
    // 排序按 UTF-16 码元（他 U+4ED6 < 兰 U+5170）——两处顺序都别凭直觉写期望
    expect(
      revs.data.results.map((r) => r.format['revision.author']).sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(['兰台', '他人'].sort((a, b) => a.localeCompare(b)));

    // 陷阱一：待决删除的文本在 view text 里**不出现**（段落看起来是空的）
    const text = await run(['view', docx, 'text']);
    expect(text).toContain('第一句');
    expect(text).not.toContain('第二句（他人改）');
    // 陷阱二：view annotated 显示该文本，但**不标注**它处于修订态
    const annotated = await run(['view', docx, 'annotated']);
    expect(annotated).toContain('第二句（他人改）');
    expect(annotated).not.toContain('revision');

    // 按作者批次接受：只决 兰台 的，他人 的留着
    expect(await run(['set', docx, '/revision[@author=兰台]', '--prop', 'revision.action=accept'])).toContain(
      'revision.action=accept',
    );
    const after = JSON.parse(await run(['query', docx, 'revision', '--json'])) as {
      data: { matches: number; results: { format: Record<string, unknown> }[] };
    };
    expect(after.data.matches).toBe(1);
    expect(after.data.results[0]?.format['revision.author']).toBe('他人');
  }, 240_000);

  it('⑫ 幻灯片工作流（skill §7.6）：建页 + 形状属性 + 大纲/issues + 单页与全册截图', async () => {
    const pptx = `${WORK}/汇报.pptx`;
    const page1 = `${WORK}/汇报-第1页.png`;
    const grid = `${WORK}/汇报-全册.png`;
    const run = (command: string[]) => tool!.execute({ command }) as Promise<string>;

    await run(['create', pptx]);
    expect(
      await run(['add', pptx, '/', '--type', 'slide', '--prop', 'title=季度汇报', '--prop', 'background=1A1A2E']),
    ).toContain('/slide[1]');
    // 一条命令把文本/坐标/字号/颜色四类属性一次给全（单位与颜色形态实测覆盖）
    expect(
      await run([
        'add',
        pptx,
        '/slide[1]',
        '--type',
        'shape',
        '--prop',
        'text=收入增长 25%',
        '--prop',
        'x=2cm',
        '--prop',
        'y=5cm',
        '--prop',
        'size=24',
        '--prop',
        'color=rgb(255,0,0)',
      ]),
    ).toContain('Added shape');
    await run(['add', pptx, '/', '--type', 'slide', '--prop', 'title=第二页']);

    const outline = await run(['view', pptx, 'outline']);
    expect(outline).toContain('季度汇报');
    expect(outline).toContain('第二页');
    expect(await run(['view', pptx, 'issues'])).toContain('0 issue');
    expect(await run(['validate', pptx])).toContain('no errors');

    // 单页截图 + 全册联系表（两者都是纸面资产块的合法输入）
    await run(['view', pptx, 'screenshot', '-o', page1, '--page', '1']);
    await run(['view', pptx, 'screenshot', '-o', grid, '--grid', 'auto']);
    for (const png of [page1, grid]) {
      expect(existsSync(png)).toBe(true);
      const bytes = readFileSync(png);
      expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(bytes.length).toBeGreaterThan(1000);
    }
    expect(statSync(grid).size).toBeGreaterThan(statSync(page1).size); // 联系表比单页大
  }, 240_000);

  it('⑬ 交付门槛覆盖面实测（skill §5.1）：抓得到几何/公式，抓不到占位符/alt/空白', async () => {
    const pptx = `${WORK}/缺陷.pptx`;
    const xlsx = `${WORK}/缺陷.xlsx`;
    const docx = `${WORK}/缺陷.docx`;
    const blank = `${WORK}/空.docx`;
    const png = `${WORK}/缺陷图.png`;
    const run = (command: string[]) => tool!.execute({ command }) as Promise<string>;

    // 造一张真图当素材（无 alt 图片检测用）
    await run(['create', docx]);
    await run(['add', docx, '/body', '--type', 'paragraph', '--prop', 'text=素材']);
    await run(['save', docx]);
    await run(['view', docx, 'screenshot', '-o', png, '--page', '1']);

    // ── 抓得到：pptx 几何（越界 + 文本溢出，连改法都给） ──
    await run(['create', pptx]);
    await run(['add', pptx, '/', '--type', 'slide', '--prop', 'title=越界测试']);
    await run(['add', pptx, '/slide[1]', '--type', 'shape', '--prop', 'text=我跑到画布外面去了', '--prop', 'x=40cm']);
    expect(await run(['view', pptx, 'issues'])).toContain('past slide right edge');
    await run([
      'add',
      pptx,
      '/slide[1]',
      '--type',
      'shape',
      '--prop',
      'text=这是一段非常长的文字用来测试溢出检测能力它显然放不进这个只有两厘米宽的小方框里',
      '--prop',
      'x=2cm',
      '--prop',
      'y=8cm',
      '--prop',
      'width=2cm',
      '--prop',
      'height=1cm',
      '--prop',
      'size=40',
    ]);
    expect(await run(['view', pptx, 'issues'])).toContain('text overflow'); // 带 suggest.height 的改法

    // ── 抓得到：xlsx 公式错 + 未求值 ──
    await run(['create', xlsx]);
    await run(['set', xlsx, '/Sheet1/A1', '--prop', 'value=文本']);
    await run(['set', xlsx, '/Sheet1/A2', '--prop', 'value==1/0']);
    await run(['set', xlsx, '/Sheet1/A3', '--prop', 'value==A1+1']);
    await run(['set', xlsx, '/Sheet1/A4', '--prop', 'value==NOSUCHFN(1)']);
    const xlsxIssues = await run(['view', xlsx, 'issues']);
    expect(xlsxIssues).toContain('#DIV/0!');
    expect(xlsxIssues).toContain('#VALUE!');
    // 求值器不认识的函数：写了但没值——门槛会点名，别以为写进去了
    expect(xlsxIssues).toContain('not evaluated');

    // ── 抓不到（盲区，逐条钉住；上游哪天补上，本用例会红并要求同步技能） ──
    // ① 占位符残留：docx 与 pptx 都不报（merge 的静默失败形态）
    await run(['add', docx, '/body', '--type', 'paragraph', '--prop', 'text=客户：{{client}} <TODO> xxxx']);
    expect(await run(['view', docx, 'issues'])).not.toContain('{{');
    await run(['add', pptx, '/slide[1]', '--type', 'shape', '--prop', 'text=客户：{{client}}', '--prop', 'x=2cm']);
    expect(await run(['view', pptx, 'issues'])).not.toContain('{{');
    // ② 无 alt 图片：issues 不报，但 query 选择器查得到 —— 必须自己查
    await run(['add', pptx, '/slide[1]', '--type', 'picture', '--prop', `src=${png}`, '--prop', 'x=2cm']);
    expect(await run(['view', pptx, 'issues'])).not.toContain('alt');
    expect(await run(['query', pptx, 'picture:no-alt'])).toContain('picture');
    // ③ 空白内容：空文档 0 issues 且 validate 干净（"干净"不等于"有东西"）
    await run(['create', blank]);
    expect(await run(['view', blank, 'issues'])).toContain('0 issue');
    expect(await run(['validate', blank])).toContain('no errors');
  }, 300_000);
});
