// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// LspService（cordis-migration P3）— LSP 状态从模块级可变单例收进 cordis Service，
// 由 Workspace 挂在工作区 fiber 上，生命周期随 fiber。钉住：
//   1. 服务定位器：fiber ctx 上 ctx.lsp 解析到服务实例；
//   2. 生命周期：fiber dispose → provider/监听器释放、缓存清空、active 指针摘除；
//   3. 模块函数路由：挂载实例优先；无挂载时惰性游离实例（行为与旧模块态等价）；
//   4. H2 代际防护在服务实例内同样生效（过期 resolve 的 sid 丢弃）。
// 既有 tests/lsp-session / lsp-diagnostics 零改动经薄转发全绿 — 转发等价性由它们守护。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc, mockListen } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockListen: vi.fn(async () => vi.fn()),
}));
vi.mock('../src/bridge', () => ({
  rpc: (...args: unknown[]) => mockRpc(...args),
  listen: mockListen,
  isMockMode: () => true,
}));

import { Context } from '../src/cordis';
import { getLspSession, LspService, startLsp, stopAllLsp } from '../src/ui/lsp-client';
import { bumpWorkspaceEpoch } from '../src/workspace-scope';

describe('LspService 挂树与生命周期（P3）', () => {
  beforeEach(async () => {
    await stopAllLsp(); // 清活跃实例状态（含游离兜底），隔离用例
    mockRpc.mockReset();
  });

  it('服务挂 fiber — 消费 fiber（inject 声明）经 ctx.lsp 解析到实例', async () => {
    const root = new Context();
    const mount = root.plugin({ name: 't/lsp-mount', apply() {} });
    new LspService(mount.ctx);
    // cordis DI：访问服务名需消费方 fiber 声明 inject（防隐式依赖）
    const consumer = mount.ctx.plugin({ name: 't/lsp-consumer', inject: ['lsp'], apply() {} });
    await consumer; // fiber 加载是异步的 — 等依赖解析完成（对齐 P0 冒烟姿势）
    // cordis traceable：ctx.lsp 出口是调用侧包装 — 原生 instanceof 通过、
    // 身份 !==（vitest 匹配器会探测服务上不存在的属性而触发 shadow 路由，故间接断言）
    const viaCtx = consumer.ctx.lsp;
    expect(viaCtx instanceof LspService).toBe(true);
    expect(typeof viaCtx.getLspSession).toBe('function');
    await mount.dispose();
  });

  it('fiber dispose → 同步收尾 + active 摘除，后续模块函数落到新实例（状态不残留）', async () => {
    const root = new Context();
    const fiber = root.plugin({ name: 't/lsp-life', apply() {} });
    const svc = new LspService(fiber.ctx);
    // 经模块函数（应路由到挂载实例）启动会话
    mockRpc.mockResolvedValueOnce('5');
    await startLsp('rust', 'file:///D:/p');
    expect(svc.getLspSession('rust')).toBe(5);

    await fiber.dispose();
    expect(svc.disposed).toBe(true);
    // active 已摘除 → 会话状态随 fiber 清空，后续调用路由到新游离实例
    expect(getLspSession('rust')).toBeUndefined();
  });

  it('未挂载路径 — 惰性游离实例，行为与旧模块全局态等价', async () => {
    mockRpc.mockResolvedValueOnce('7');
    const sid = await startLsp('go', 'file:///D:/g');
    expect(sid).toBe(7);
    expect(getLspSession('go')).toBe(7);
    await stopAllLsp();
    expect(getLspSession('go')).toBeUndefined();
  });

  it('H2 代际防护在服务实例内同样生效 — 过期 resolve 的 sid 丢弃', async () => {
    let resolveStart: ((v: string) => void) | null = null;
    mockRpc.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveStart = res;
        }),
    );
    const p = startLsp('python', 'file:///D:/py');
    bumpWorkspaceEpoch(); // 在途切换工作区
    resolveStart?.('11');
    expect(await p).toBeNull();
    expect(getLspSession('python')).toBeUndefined();
  });
});
