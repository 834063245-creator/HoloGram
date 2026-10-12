// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 日志可观测性批 1 —— 事件门面（`agent/obs.ts`）的**结构性守护**。
//
// 立项见 docs/plans/log-observability-plan.md：目标不是「多记日志」，是消灭
// 「失败默认无痕」——任何让用户看见的失败，日志里至少留一条，且带**发生层**
// 与**原始错误文本**。本文件钉住门面的四条不变量：
//
//   ① 公共字段齐全（ts/level/module/message/event/build/ids/out/err/ctx）
//   ② **脱敏**——apiKey / Bearer / URL query 永不落盘，端点只记 host:port
//      （门面是唯一审查点，这里守的就是「唯一」这两个字的行为面）
//   ③ 4KB 上限——超出**截断并标 truncated**，不是丢弃
//   ④ turn.failed 去重——同 (session,turn,phase) 只一条（六处出口不许刷屏）
//
// 走真 logger + mock rpc-contract（内存 fs），断言落在**实际落盘的 NDJSON** 上
// ——脱敏与截断是「写出去之后」的性质，测内存对象测不到。

import { beforeEach, describe, expect, it, vi } from 'vitest';

// 顶层触发 rpc-contract 的 vi.mock 工厂求值（logger 的 appendToFile 是动态
// import，不在文件加载期触发则首调前 H.kernelFs 仍为 null）。
import { kernelLogAppend } from '../src/rpc-contract';

void kernelLogAppend;

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

type ObsMod = typeof import('../src/agent/obs');
type LoggerMod = typeof import('../src/agent/logger');

const LOG_PATH = '/ws/.lantai/logs/ui.log';

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: 超时未落地');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('日志可观测性 · 事件门面（obs.ts）', () => {
  let obs: ObsMod;
  let logger: LoggerMod;
  let drainSeq = 0;

  /** 逼出一次 flush 并回读落盘的 NDJSON 条目。
   *  ⚡ 两条纪律：① logger 的 flush 是私有的（50 条阈值 / 2s 定时器），测试用
   *  **写满阈值**逼它同步 splice + fire-and-forget 落盘（不引 fake timers——那条
   *  路要再等微任务，比轮询更脆）；② 等待信号必须是**本次唯一标记**——内存 fs
   *  跨用例复用，用固定的 'filler' 当信号会被上一轮的残留骗过（假绿）。 */
  async function drain(): Promise<Record<string, unknown>[]> {
    const fs = H.kernelFs!.fs;
    fs.files.clear();
    const mark = `drain-mark-${++drainSeq}`;
    // ⚡ 批 3 起默认级别 = info（debug 直接被过滤、不入缓冲）——drain 的信号行与
    //    填充行一律用 info：本文件的被测性质是**门面字段/脱敏/上限**，与级别无关。
    logger.log.info('test', mark);
    for (let i = 0; i < 50; i++) logger.log.info('test', 'filler');
    await waitFor(() => (fs.files.get(LOG_PATH) ?? '').includes(mark));
    const raw = fs.files.get(LOG_PATH) ?? '';
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  function byEvent(all: Record<string, unknown>[], event: string): Record<string, unknown>[] {
    return all.filter((e) => e.event === event);
  }

  beforeEach(async () => {
    vi.resetModules();
    logger = await import('../src/agent/logger');
    obs = await import('../src/agent/obs');
    await logger.initLogger('/ws');
  });

  // ── ① 公共字段 ────────────────────────────────────────────────────

  it('boot：公共字段齐全（构建锚 / 平台 / 时区 / 工作区 / 配置路径 / 端口 / 通道）', async () => {
    obs.boot({
      workspace: 'D:/ws',
      providersPath: 'C:/Users/u/.lantai/providers.yml',
      proxyPort: '14570',
    });
    const boot = byEvent(await drain(), 'boot');
    expect(boot).toHaveLength(1);
    const e = boot[0];
    expect(e.level).toBe('info');
    expect(e.module).toBe('boot');
    expect(e.out).toBe('ok');
    expect(typeof e.ts).toBe('string');
    expect(typeof e.message).toBe('string');
    // 构建锚：收到的 log 靠它定位代码（事故里只能靠「有无 method 字段」反推）
    expect(e.build).toEqual({ v: expect.any(String), commit: expect.any(String) });
    expect(e.ctx).toMatchObject({
      workspace: 'D:/ws',
      providers_yml: 'C:/Users/u/.lantai/providers.yml',
      proxy_port: '14570',
      log_channel: 'ok',
    });
  });

  it('事件名是 ASCII 点分稳定名（不用中文句子当判据）', async () => {
    const ids = { session: 1, turn: 1 };
    obs.boot({ workspace: '/w', providersPath: '/p.yml', proxyPort: '0' });
    obs.configLoad({ path: '/p.yml', sections: 2, errors: [], empty: false, source: 'file', ids });
    obs.panelReload({ path: '/p.yml', sections: 2, errors: [], empty: false, source: 'file', trigger: 'open', ids });
    obs.credGet({ provider: 'p', hit: true, len: 12, ids });
    obs.credStore({ provider: 'p', ok: true, ids });
    obs.credRemove({ provider: 'p', ok: true, ids });
    obs.llmSend({ provider: 'p', model: 'm', kind: 'openai', url: 'http://h:1/v1', tools: 0, ids });
    obs.llmFirstByte({ provider: 'p', model: 'm', kind: 'openai', url: 'http://h:1/v1', ms: 5, ids });
    obs.llmDone({ provider: 'p', model: 'm', kind: 'openai', url: 'http://h:1/v1', ms: 9, ids });
    obs.llmError({ provider: 'p', model: 'm', kind: 'openai', url: 'http://h:1/v1', raw: 'boom', ids });
    obs.turnFailed({ ids, phase: 'stream', kind: 'UNKNOWN', raw: 'boom', message: '错误: boom' });
    obs.toast({ text: '出错了', level: 'error' });
    const all = (await drain()).filter((e) => typeof e.event === 'string');
    expect(all.length).toBeGreaterThanOrEqual(12);
    for (const e of all) {
      expect(String(e.event)).toMatch(/^[a-z][a-z_]*(\.[a-z][a-z_]*)*$/);
      // 每条事件都必须带构建锚与可读 message（门面的公共字段契约）
      expect(e.build).toEqual({ v: expect.any(String), commit: expect.any(String) });
      expect(typeof e.message).toBe('string');
      expect(String(e.message).length).toBeGreaterThan(0);
    }
  });

  // ── ② 脱敏（唯一审查点）──────────────────────────────────────────

  it('hostPort：端点只留 host:port（协议面/路径/query 一律不进日志）', () => {
    expect(obs.hostPort('http://127.0.0.1:8080/v1/chat/completions?api-key=X')).toBe('127.0.0.1:8080');
    expect(obs.hostPort('https://api.deepseek.com/v1/chat/completions')).toBe('api.deepseek.com');
    expect(obs.hostPort('not a url')).toBe('<unparsable>');
  });

  it('脱敏：apiKey / Bearer / URL query 永不落盘', async () => {
    obs.llmError({
      provider: 'local',
      model: 'qwen',
      kind: 'openai',
      // 接缝递整条 URL 进来（门面负责削成 host:port）——query 里的 key 必须被削掉
      url: 'http://127.0.0.1:8080/v1/chat?api-key=QUERYSECRET0123',
      raw:
        'HTTP 401: {"error":{"message":"Incorrect API key provided: sk-live-ABCDEFGHIJKLMNOP"}} ' +
        'Authorization: Bearer BEARERSECRET0123456789 x-api-key: XAPIKEYSECRET',
      status: 401,
      errorKind: 'auth_or_param',
    });
    const all = await drain();
    // 断言落在**实际落盘的文件原文**上：脱敏是「写出去之后」的性质
    const file = H.kernelFs?.fs.files.get(LOG_PATH) ?? '';
    for (const secret of ['QUERYSECRET0123', 'sk-live-ABCDEFGHIJKLMNOP', 'BEARERSECRET0123456789', 'XAPIKEYSECRET']) {
      expect(file).not.toContain(secret);
    }
    const e = byEvent(all, 'llm.error')[0];
    // 端点只留 host:port（协议面/路径/query 一律不进日志）
    expect(String((e.ctx as Record<string, unknown>).target)).toBe('127.0.0.1:8080');
    expect(e.out).toBe('fail');
    expect(e.err).toMatchObject({ kind: 'auth_or_param', status: 401 });
  });

  it('脱敏不误伤计数类字段（max_tokens / tokens 不是凭据）', async () => {
    obs.llmDone({
      provider: 'p',
      model: 'm',
      kind: 'openai',
      url: 'http://h:1/v1',
      ms: 3,
      promptTokens: 1234,
      completionTokens: 56,
      finishReason: 'stop',
    });
    const e = byEvent(await drain(), 'llm.done')[0];
    expect(e.ctx).toMatchObject({ prompt_tokens: 1234, completion_tokens: 56, finish_reason: 'stop' });
  });

  // ── ③ 4KB 上限 ───────────────────────────────────────────────────

  it('4KB 上限：超长条目被截断并标 truncated（不是丢弃）', async () => {
    // 单条真能撑爆 4KB 的形态 = 逐节错误很多且每条都长（raw 单字段另有 2000 字
    // 预削，单靠 raw 到不了上限——测试必须构造真实可超限的载荷，否则假绿）。
    obs.configLoad({
      path: '/home/u/.lantai/providers.yml',
      sections: 300,
      errors: Array.from({ length: 300 }, (_, i) => ({ name: `节${i}`, reason: '缺少 protocol '.repeat(20) })),
      empty: false,
      source: 'file',
      ids: { session: 1, turn: 1 },
    });
    const e = byEvent(await drain(), 'config.load')[0];
    expect(e.truncated).toBe(true);
    const bytes = new TextEncoder().encode(JSON.stringify(e)).length;
    expect(bytes).toBeLessThanOrEqual(4096);
    // 截断后仍是**可读记录**：判据（事件名/级别/来源）与计数都在
    expect(e.level).toBe('warn');
    expect(e.ctx).toMatchObject({ source: 'file', sections: 300 });
  });

  it('收缩保信号：长数组留前 8 项 + `…(+N)` 计数，不静默丢项', async () => {
    obs.configLoad({
      path: '/p.yml',
      sections: 12,
      errors: Array.from({ length: 12 }, (_, i) => ({ name: `节${i}`, reason: 'r'.repeat(600) })),
      empty: false,
      source: 'file',
    });
    const e = byEvent(await drain(), 'config.load')[0];
    expect(e.truncated).toBe(true);
    const errs = (e.ctx as Record<string, unknown>).section_errors as string[];
    expect(errs).toHaveLength(9); // 前 8 项 + 计数尾巴
    expect(errs[8]).toBe('…(+4)');
  });

  it('未超限的条目不带 truncated（不虚标）', async () => {
    obs.credGet({ provider: 'p', hit: true, len: 40 });
    const e = byEvent(await drain(), 'cred.get')[0];
    expect(e.truncated).toBeUndefined();
    expect(e.out).toBe('hit');
  });

  // ── ④ turn.failed 去重（唯一漏斗不许刷屏）────────────────────────

  it('turn.failed 去重：同 (session,turn,phase) 只一条；换层 / 换轮各一条', async () => {
    const ids = { session: 7, turn: 3, run: 11 };
    expect(obs.turnFailed({ ids, phase: 'stream', kind: 'PROVIDER_ERROR', raw: 'boom', message: '错误: boom' })).toBe(
      true,
    );
    expect(
      obs.turnFailed({ ids, phase: 'stream', kind: 'PROVIDER_ERROR', raw: 'boom again', message: '错误: boom again' }),
    ).toBe(false);
    expect(
      obs.turnFailed({ ids, phase: 'preflight', kind: 'MISSING_CREDENTIAL', raw: 'no key', message: '错误: no key' }),
    ).toBe(true);
    expect(
      obs.turnFailed({
        ids: { session: 7, turn: 4, run: 12 },
        phase: 'stream',
        kind: 'UNKNOWN',
        raw: 'x',
        message: '错误: x',
      }),
    ).toBe(true);
    const fails = byEvent(await drain(), 'turn.failed');
    expect(fails).toHaveLength(3);
    // 覆盖性硬要求：层（phase）与原始文本（raw）必须在这条记录里
    expect(fails[0].err).toMatchObject({ phase: 'stream', kind: 'PROVIDER_ERROR', raw: 'boom' });
    expect(fails[1].err).toMatchObject({ phase: 'preflight', kind: 'MISSING_CREDENTIAL', raw: 'no key' });
    expect(fails[2].ids).toMatchObject({ session: 7, turn: 4, run: 12 });
  });

  it('endTurn 清去重表：同回合同层可再次记录（键控自清理）', async () => {
    const ids = { session: 2, turn: 1, run: 1 };
    obs.turnFailed({ ids, phase: 'stream', kind: 'UNKNOWN', raw: 'a', message: 'a' });
    obs.endTurn(ids);
    expect(obs.turnFailed({ ids, phase: 'stream', kind: 'UNKNOWN', raw: 'b', message: 'b' })).toBe(true);
    expect(byEvent(await drain(), 'turn.failed')).toHaveLength(2);
  });

  // ── ui.toast：漏斗的兜底面 ───────────────────────────────────────

  it('ui.toast：只记 error 级（info/warn 不入账）', async () => {
    obs.toast({ text: 'warn 级提示', level: 'warn' });
    obs.toast({ text: 'info 级提示', level: 'info' });
    obs.toast({ text: 'error 级提示', level: 'error' });
    const toasts = byEvent(await drain(), 'ui.toast');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].ctx).toMatchObject({ text: 'error 级提示' });
    expect(toasts[0].level).toBe('error');
  });

  // ── classifyTurnFailure：phase 判定靠**类型**不靠文案 ────────────

  it('classifyTurnFailure：预检契约标记 → preflight；带 status 的错误 → stream', () => {
    // 标记表保留为防御面（2026-09-28 无 Key 放行批后 live.ts 不再抛它；第三方/未来
    // 路径抛同名标记时仍按「请求未发出」归类）。
    const cred = obs.classifyTurnFailure(
      new Error('MISSING_CREDENTIAL: 提供方「本地」未配置 API Key——设置 → Provider 填写并保存后直接重试'),
    );
    expect(cred.phase).toBe('preflight');
    expect(cred.kind).toBe('MISSING_CREDENTIAL');

    const httpErr = Object.assign(new Error('[服务商故障] upstream 502'), { status: 502 });
    expect(obs.classifyTurnFailure(httpErr)).toMatchObject({ phase: 'stream', kind: 'PROVIDER_ERROR', status: 502 });

    // 无 Key 放行后的真机形态：请求发出、端点 401 拒 → phase 记 stream（不冒充 preflight）
    const keyless401 = Object.assign(new Error('[密钥错误] "本地" 的端点要求鉴权（HTTP 401），而本行没有 API Key：…'), {
      status: 401,
      kind: 'auth_or_param',
    });
    expect(obs.classifyTurnFailure(keyless401)).toMatchObject({
      phase: 'stream',
      kind: 'PROVIDER_ERROR',
      status: 401,
    });

    expect(obs.classifyTurnFailure(new Error('说不清的错'))).toMatchObject({ phase: 'stream', kind: 'UNKNOWN' });
  });

  // ── 配置 / 凭据接缝的读数形状（批 2 消费面）──────────────────────

  it('config.load：成功也写；逐节错误与 fatal 分级别、投影来源与 Key 携带可见', async () => {
    obs.configLoad({
      path: '/home/u/.lantai/providers.yml',
      sections: 3,
      errors: [{ name: '坏节', reason: '缺少 protocol' }],
      empty: false,
      source: 'file',
      keysCarried: { withKey: 2, total: 3 },
    });
    obs.configLoad({
      path: '/home/u/.lantai/providers.yml',
      sections: 0,
      errors: [],
      fatal: 'YAML 解析失败',
      empty: true,
      source: 'localStorage',
    });
    const loads = byEvent(await drain(), 'config.load');
    expect(loads).toHaveLength(2);
    expect(loads[0].level).toBe('warn');
    expect(loads[0].ctx).toMatchObject({ sections: 3, source: 'file', keys: '2/3' });
    expect(loads[1].level).toBe('error');
    expect(loads[1].out).toBe('fail');
    expect(loads[1].err).toMatchObject({ kind: 'CONFIG_FATAL', raw: 'YAML 解析失败' });
  });

  it('cred.get：命中 / 未命中 / IPC 抛错**三条路径可分**（不许把抖动记成「没配」）', async () => {
    obs.credGet({ provider: 'a', hit: true, len: 51 });
    obs.credGet({ provider: 'b', hit: false });
    obs.credGet({ provider: 'c', hit: false, error: 'IPC timeout' });
    const gets = byEvent(await drain(), 'cred.get');
    expect(gets.map((g) => g.out)).toEqual(['hit', 'miss', 'fail']);
    expect(gets[0].ctx).toMatchObject({ provider: 'a', len: 51 });
    expect(gets[2].err).toMatchObject({ kind: 'CRED_IPC_ERROR', raw: 'IPC timeout' });
  });
});
