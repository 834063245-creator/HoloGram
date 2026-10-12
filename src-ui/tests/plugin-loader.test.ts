// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 插件内核（WO-S0B）单元测试：manifest 校验 / 失败隔离 / disabled 跳过 / fiber dispose。
// loader 的 fetch 与 dynamic import 均为注入面（URL 注入 mock）；
// Rust 侧通道行为（遍历防护 / MIME / 404 / junction）由 src-tauri 的
// plugin_assets cargo test 覆盖。

import { beforeEach, describe, expect, it } from 'vitest';
import { clearActivationsForTest } from '../src/composition/activation';
import { rendererServicePlugin, resolveRenderer } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { hostSurfaceFingerprint } from '../src/plugins/builtin/host-modules';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { FIRST_PARTY_MANIFEST } from '../src/plugins/first-party-manifest';
import {
  activateExternalPlugin,
  activeExternalPluginNames,
  allBuiltinPlugins,
  deactivateExternalPlugin,
  loadBuiltinPlugins,
  loadExternalPlugins,
  resetPluginRuntimeForTests,
} from '../src/plugins/loader';
import { PluginManifestSchema, validateManifest } from '../src/plugins/types';
import { usePluginPrefs } from '../src/state/plugin-prefs';
import { usePluginStore } from '../src/state/plugin-store';

const ORIGIN = 'http://127.0.0.1:14570/plugins';

/** 全部第一方插件（14 内核 + dev 出厂产物源码——loadBuiltinPlugins 装载面）。 */
const ALL_PLUGINS = allBuiltinPlugins();

interface MockResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

function jsonResponse(body: unknown): MockResponse {
  return { ok: true, json: async () => body };
}

function notFound(): MockResponse {
  return { ok: false, json: async () => null };
}

/** 按 URL 精确路由的 mock fetch（未登记的 URL 一律 404）。 */
function mockFetch(routes: Record<string, unknown>): (url: string) => Promise<MockResponse> {
  return async (url: string) => (url in routes ? jsonResponse(routes[url]) : notFound());
}

const HELLO_MANIFEST = { name: 'hello', version: '1.0.0', entry: 'entry.js' };
const BAD_MANIFEST = { name: 'bad', version: '1.0.0', entry: 'entry.js' };

describe('manifest 校验（zod 单一来源）', () => {
  it('合法 manifest 通过', () => {
    expect(PluginManifestSchema.safeParse(HELLO_MANIFEST).success).toBe(true);
    const v = validateManifest(HELLO_MANIFEST);
    expect(v.ok).toBe(true);
  });

  it('缺 name / 坏 version / 坏 entry / 坏 name 全部拒绝', () => {
    expect(validateManifest({ version: '1.0.0', entry: 'entry.js' }).ok).toBe(false);
    expect(validateManifest({ name: 'hello', version: 'latest', entry: 'entry.js' }).ok).toBe(false);
    expect(validateManifest({ name: 'hello', version: '1.0.0', entry: '/abs/entry.js' }).ok).toBe(false);
    expect(validateManifest({ name: 'hello', version: '1.0.0', entry: '../escape.js' }).ok).toBe(false);
    expect(validateManifest({ name: 'hello', version: '1.0.0', entry: 'style.css' }).ok).toBe(false);
    expect(validateManifest({ name: 'Hello!', version: '1.0.0', entry: 'entry.js' }).ok).toBe(false);
    expect(validateManifest('not-an-object').ok).toBe(false);
  });

  it('S4-4 乙：mcpServers 形状校验（stdio/http 二选一 + failurePolicy 枚举）', () => {
    // 合法：stdio 带 command；http 带 url；failurePolicy 枚举值
    expect(
      validateManifest({
        ...HELLO_MANIFEST,
        mcpServers: [
          { name: 'engine', transport: 'stdio', command: './bin/engine', args: ['--serve'] },
          { name: 'remote', transport: 'http', url: 'http://127.0.0.1:9000/mcp' },
          { name: 'strict', transport: 'stdio', command: 'node', failurePolicy: 'startup-error' },
        ],
      }).ok,
    ).toBe(true);
    // stdio 缺 command / 带 url；http 缺 url / 带 command；未知键；坏枚举
    expect(validateManifest({ ...HELLO_MANIFEST, mcpServers: [{ name: 'a', transport: 'stdio' }] }).ok).toBe(false);
    expect(
      validateManifest({
        ...HELLO_MANIFEST,
        mcpServers: [{ name: 'a', transport: 'stdio', command: 'x', url: 'http://x' }],
      }).ok,
    ).toBe(false);
    expect(validateManifest({ ...HELLO_MANIFEST, mcpServers: [{ name: 'a', transport: 'http' }] }).ok).toBe(false);
    expect(
      validateManifest({
        ...HELLO_MANIFEST,
        mcpServers: [{ name: 'a', transport: 'http', url: 'http://x', command: 'c' }],
      }).ok,
    ).toBe(false);
    expect(
      validateManifest({
        ...HELLO_MANIFEST,
        mcpServers: [{ name: 'a', transport: 'stdio', command: 'c', bogus: 1 }],
      }).ok,
    ).toBe(false);
    expect(
      validateManifest({
        ...HELLO_MANIFEST,
        mcpServers: [{ name: 'a', transport: 'stdio', command: 'c', failurePolicy: 'nope' }],
      }).ok,
    ).toBe(false);
  });

  it('S2 受治治理字段：restart/lifecycle 枚举 + http 不得声明（无受治进程面）', () => {
    const STDIO = { name: 's', transport: 'stdio', command: 'node' } as const;
    // 合法：治理字段组合（任一在场 = 该条目进受治面）
    expect(validateManifest({ ...HELLO_MANIFEST, mcpServers: [{ ...STDIO, restart: 'on-crash' }] }).ok).toBe(true);
    expect(validateManifest({ ...HELLO_MANIFEST, mcpServers: [{ ...STDIO, lifecycle: 'lazy' }] }).ok).toBe(true);
    expect(validateManifest({ ...HELLO_MANIFEST, mcpServers: [{ ...STDIO, restart: 'off' }] }).ok).toBe(true);
    expect(validateManifest({ ...HELLO_MANIFEST, mcpServers: [{ ...STDIO, lifecycle: 'eager' }] }).ok).toBe(true);
    expect(validateManifest({ ...HELLO_MANIFEST, mcpServers: [{ ...STDIO, lifecycle: 'with-window' }] }).ok).toBe(true);
    // 坏枚举拒绝（枚举闭集——「写了但不生效」是手误，错误不静默）
    expect(validateManifest({ ...HELLO_MANIFEST, mcpServers: [{ ...STDIO, restart: 'always' }] }).ok).toBe(false);
    expect(validateManifest({ ...HELLO_MANIFEST, mcpServers: [{ ...STDIO, lifecycle: 'always' }] }).ok).toBe(false);
    // http 条目声明治理字段 = 拒绝（进程不是宿主起的——无受治进程面）
    expect(
      validateManifest({
        ...HELLO_MANIFEST,
        mcpServers: [{ name: 'r', transport: 'http', url: 'http://x', lifecycle: 'lazy' }],
      }).ok,
    ).toBe(false);
    expect(
      validateManifest({
        ...HELLO_MANIFEST,
        mcpServers: [{ name: 'r', transport: 'http', url: 'http://x', restart: 'on-crash' }],
      }).ok,
    ).toBe(false);
    // 旧形态（无治理字段）不受影响——兼容钉死
    expect(validateManifest({ ...HELLO_MANIFEST, mcpServers: [{ ...STDIO }] }).ok).toBe(true);
  });
  it('S6 P3a：activation 声明形状 + lazy 与 eager 互斥（资源型插件的副作用只能在激活时启动）', () => {
    // 合法：lazy / resources（闭集）/ exclusive（资源实例名）
    expect(
      validateManifest({
        ...HELLO_MANIFEST,
        activation: { lazy: true, resources: ['stdio'], exclusive: ['port:9310'] },
      }).ok,
    ).toBe(true);
    expect(validateManifest({ ...HELLO_MANIFEST, activation: { resources: ['pty'] } }).ok).toBe(true);
    expect(validateManifest({ ...HELLO_MANIFEST, activation: {} }).ok).toBe(true);
    // 坏形状：未知资源类型 / 未知键 / 坏 exclusive 条目
    expect(validateManifest({ ...HELLO_MANIFEST, activation: { resources: ['gpu'] } }).ok).toBe(false);
    expect(validateManifest({ ...HELLO_MANIFEST, activation: { bogus: 1 } }).ok).toBe(false);
    expect(validateManifest({ ...HELLO_MANIFEST, activation: { exclusive: [''] } }).ok).toBe(false);
    // lazy:true 与 mcpServers[].lifecycle="eager" 互斥（那正是 apply 期起进程）
    const EAGER = { name: 's', transport: 'stdio', command: 'node', lifecycle: 'eager' } as const;
    expect(validateManifest({ ...HELLO_MANIFEST, activation: { lazy: true }, mcpServers: [EAGER] }).ok).toBe(false);
    // 非 eager / 无 activation 块 = 放行（缺省 = P3 前语义，kill switch）
    expect(
      validateManifest({
        ...HELLO_MANIFEST,
        activation: { lazy: true },
        mcpServers: [{ name: 's', transport: 'stdio', command: 'node' }],
      }).ok,
    ).toBe(true);
    expect(validateManifest({ ...HELLO_MANIFEST, mcpServers: [EAGER] }).ok).toBe(true);
  });
});

describe('loadExternalPlugins（失败隔离铁律）', () => {
  beforeEach(() => {
    usePluginStore.setState({ plugins: [] });
  });

  it('两个插件一个 import 抛错 → 另一个 active，store 有 error 记录', async () => {
    const root = new Context();
    const importCalls: string[] = [];
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello', 'bad'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: HELLO_MANIFEST,
        [ORIGIN + '/bad/manifest.json']: BAD_MANIFEST,
      }),
      importModule: async (url: string) => {
        importCalls.push(url);
        if (url.includes('/bad/entry.js')) throw new Error('disk boom');
        return { default: { name: 'hello', apply() {} } };
      },
    });
    const plugins = usePluginStore.getState().plugins;
    expect(plugins).toHaveLength(2);
    expect(plugins.find((p) => p.name === 'hello')?.status).toBe('active');
    const bad = plugins.find((p) => p.name === 'bad');
    expect(bad?.status).toBe('error');
    expect(bad?.error).toContain('disk boom');
    expect(importCalls).toHaveLength(2);
  });

  it('apply 抛错 → error 记录（cordis fiber await reject）', async () => {
    const root = new Context();
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: HELLO_MANIFEST,
      }),
      importModule: async () => ({
        default: {
          name: 'hello',
          apply() {
            throw new Error('apply boom');
          },
        },
      }),
    });
    const plugins = usePluginStore.getState().plugins;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.status).toBe('error');
    expect(plugins[0]?.error).toContain('apply boom');
  });

  it('disabled 跳过：plugins.json 列出 → 不 import，store 记 disabled', async () => {
    const root = new Context();
    const importModule = async (url: string): Promise<Record<string, unknown>> => {
      throw new Error('不应被调用: ' + url);
    };
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: ['hello'] },
        [ORIGIN + '/hello/manifest.json']: HELLO_MANIFEST,
      }),
      importModule,
    });
    const plugins = usePluginStore.getState().plugins;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.status).toBe('disabled');
  });

  it('S4：inject 缺失 → 不拒载（cordis fiber PENDING 挂起，boot 审计判生死）', async () => {
    const root = new Context();
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: { ...HELLO_MANIFEST, inject: ['nonexistent-service'] },
      }),
      importModule: async () => ({ default: { name: 'hello', apply() {} } }),
    });
    const plugins = usePluginStore.getState().plugins;
    // S4：装载不再因缺依赖拒载——插件已装载（active），fiber 挂 PENDING
    // 等依赖 provide（此用例里永缺——boot 审计会判失败，见 boot-gate.test）
    expect(plugins[0]?.status).toBe('active');
    // fiber 在册（activeExternalFibers 有记录）
    expect(activeExternalPluginNames()).toContain('hello');
  });

  it('manifest 缺失 / 校验失败 → error 记录（不 import）', async () => {
    const root = new Context();
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['ghost', 'broken'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/broken/manifest.json']: { name: 'broken', version: 'x', entry: 'entry.js' },
      }),
      importModule: async () => {
        throw new Error('不应被调用');
      },
    });
    const plugins = usePluginStore.getState().plugins;
    expect(plugins).toHaveLength(2);
    expect(plugins.find((p) => p.name === 'ghost')?.error).toContain('缺失');
    expect(plugins.find((p) => p.name === 'broken')?.error).toContain('校验失败');
  });

  it('通道索引不可用 → loader 不 reject、store 不变', async () => {
    const root = new Context();
    await expect(loadExternalPlugins(root, { origin: ORIGIN, fetchImpl: mockFetch({}) })).resolves.toBeUndefined();
    expect(usePluginStore.getState().plugins).toEqual([]);
  });

  it('C11-1：manifest.tools + entry toolHandlers → 声明通道工具挂接；缺 handler → error 记录', async () => {
    const root = new Context();
    const { compositionServicesPlugin } = await import('../src/composition/services');
    await root.plugin(compositionServicesPlugin);
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/todo'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/acme/todo/manifest.json']: {
          name: 'acme/todo',
          version: '1.0.0',
          entry: 'entry.js',
          tools: [
            {
              name: 'todo_read',
              description: '读待办',
              parameters: { type: 'object', properties: { q: { type: 'string' } } },
              readOnly: true,
            },
          ],
        },
      }),
      importModule: async () => ({
        default: { name: 'acme/todo', apply() {} },
        toolHandlers: { todo_read: async (args: { q?: string }) => 'todo:' + String(args.q ?? '') },
      }),
    });
    expect(usePluginStore.getState().plugins[0]?.status).toBe('active');
    // 声明通道贡献在册（行 id 折算 plugin/<插件名>/<工具名>）
    const { pluginToolRows } = await import('../src/composition/plugin-tool-rows');
    expect(pluginToolRows().map((r) => r.id)).toEqual(['plugin/acme/todo/todo_read']);
    const row = pluginToolRows()[0];
    if (!row) throw new Error('声明通道贡献行未注册');
    const tools = await row.factory({} as never);
    expect(tools[0]?.name()).toBe('todo_read');
    expect(tools[0]?.readOnly()).toBe(true);
    await expect(tools[0]?.execute({ q: 'x' })).resolves.toBe('todo:x');

    // 缺 handler → 插件 error（失败隔离；all-or-nothing：一条不挂，全部不挂）
    // 注：2026-08-29 起 loader 写 store 用 mergePlugins（外部装载不冲刷第一方
    // 记录）——多次装载的记录按 name 合并，断言按 name 找而非 plugins[0]。
    const root2 = new Context();
    await root2.plugin(compositionServicesPlugin);
    await loadExternalPlugins(root2, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/broken'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/acme/broken/manifest.json']: {
          name: 'acme/broken',
          version: '1.0.0',
          entry: 'entry.js',
          tools: [{ name: 'todo_read', description: '读', parameters: { type: 'object' } }],
        },
      }),
      importModule: async () => ({
        default: { name: 'acme/broken', apply() {} },
        // toolHandlers 导出但缺 todo_read
        toolHandlers: { other: async () => 'x' },
      }),
    });
    const broken = usePluginStore.getState().plugins.find((p) => p.name === 'acme/broken');
    expect(broken?.status).toBe('error');
    expect(broken?.error).toContain('未声明的工具');
    expect(pluginToolRows()).toEqual([]); // 失败不残留贡献
  });

  it('C11-2：permissions 声明形状校验（枚举闭集）', () => {
    expect(validateManifest({ ...HELLO_MANIFEST, permissions: ['read', 'bash'] }).ok).toBe(true);
    expect(validateManifest({ ...HELLO_MANIFEST, permissions: [] }).ok).toBe(true);
    // 未知权限类拒绝（枚举闭集——「写了但不生效」的类名是手误）
    expect(validateManifest({ ...HELLO_MANIFEST, permissions: ['root'] }).ok).toBe(false);
    expect(validateManifest({ ...HELLO_MANIFEST, permissions: ['bash', 'ssh'] }).ok).toBe(false);
    expect(validateManifest({ ...HELLO_MANIFEST, permissions: 'bash' }).ok).toBe(false);
  });

  it('C11-2：权限门禁——声明未被 granted 覆盖 → blocked（不 import）；覆盖/无声明 → 装载', async () => {
    const importCalls: string[] = [];
    const importModule = async (url: string): Promise<Record<string, unknown>> => {
      importCalls.push(url);
      return { default: { name: 'acme/power', apply() {} } };
    };
    const manifest = {
      name: 'acme/power',
      version: '1.0.0',
      entry: 'entry.js',
      permissions: ['bash', 'edit'],
    };
    // 未授予（granted 缺该插件）→ blocked + 缺哪些授权可见 + 不 import
    const root = new Context();
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/power'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: {} },
        [ORIGIN + '/acme/power/manifest.json']: manifest,
      }),
      importModule,
    });
    let rec = usePluginStore.getState().plugins[0];
    expect(rec?.status).toBe('blocked');
    expect(rec?.missingPermissions).toEqual(['bash', 'edit']);
    expect(importCalls).toEqual([]);

    // 部分授予 → 仍 blocked（缺的部分可见）
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/power'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: { 'acme/power': ['bash'] } },
        [ORIGIN + '/acme/power/manifest.json']: manifest,
      }),
      importModule,
    });
    rec = usePluginStore.getState().plugins[0];
    expect(rec?.status).toBe('blocked');
    expect(rec?.missingPermissions).toEqual(['edit']);
    expect(importCalls).toEqual([]);

    // 全覆盖 → active（import + apply）
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/power'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: { 'acme/power': ['bash', 'edit', 'web'] } },
        [ORIGIN + '/acme/power/manifest.json']: manifest,
      }),
      importModule,
    });
    expect(usePluginStore.getState().plugins[0]?.status).toBe('active');
    expect(importCalls).toHaveLength(1);

    // 无声明 = 零摩擦直接装载（hello 形态）
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/pure'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: {} },
        [ORIGIN + '/acme/pure/manifest.json']: { name: 'acme/pure', version: '1.0.0', entry: 'entry.js' },
      }),
      importModule: async () => ({ default: { name: 'acme/pure', apply() {} } }),
    });
    expect(usePluginStore.getState().plugins[0]?.status).toBe('active');

    // plugins.json 缺失/坏形状 → granted 空表（按无授权处理，声明插件 blocked）
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/power'],
        // plugins.json 不可达（404 → fetchJson null → 空态）
        [ORIGIN + '/acme/power/manifest.json']: manifest,
      }),
      importModule,
    });
    expect(usePluginStore.getState().plugins[0]?.status).toBe('blocked');
  });

  it('S4-4 乙：mcpServers → 包装装载（entry.apply 后桥贡献注册）', async () => {
    // 内存 MCP server 行协议 fake（mcp-bridge.test 同款——loader 集成只验
    // 包装接线，协议细节与 dispose 链在桥测试钉）
    const kills: string[] = [];
    const io = {
      createProcIO: async () => {
        const outCbs = new Set<(line: string) => void>();
        const exitCbs = new Set<(code: number | null) => void>();
        return {
          writeLine: (line: string) => {
            const msg = JSON.parse(line) as { id?: number; method?: string };
            if (msg.id === undefined) return;
            const result =
              msg.method === 'initialize'
                ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'f', version: '1' } }
                : msg.method === 'tools/list'
                  ? { tools: [{ name: 'probe_tool', inputSchema: { type: 'object', properties: {} } }] }
                  : {};
            for (const cb of outCbs) cb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
          },
          onStdoutLine: (cb: (line: string) => void) => {
            outCbs.add(cb);
            return () => {
              outCbs.delete(cb);
            };
          },
          onExit: (cb: (code: number | null) => void) => {
            exitCbs.add(cb);
            return () => {
              exitCbs.delete(cb);
            };
          },
          kill: () => {
            kills.push('killed');
            for (const cb of exitCbs) cb(0);
          },
        };
      },
      pluginDir: async (name: string) => `C:/plugins/${name}`,
    } as const;

    const applyCalls: string[] = [];
    const root = new Context();
    // 四 service 先挂（tools 可注入）
    const { compositionServicesPlugin } = await import('../src/composition/services');
    await root.plugin(compositionServicesPlugin);
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      mcpBridgeIO: io,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: {
          ...HELLO_MANIFEST,
          mcpServers: [{ name: 'engine', transport: 'stdio', command: './bin/engine' }],
        },
      }),
      importModule: async () => ({
        default: {
          name: 'hello',
          apply() {
            applyCalls.push('hello');
          },
        },
      }),
    });
    // entry.apply 已跑 + 插件 active
    expect(applyCalls).toEqual(['hello']);
    expect(usePluginStore.getState().plugins[0]?.status).toBe('active');
    // 桥贡献已注册（行 id plugin/hello/mcp/engine）
    const { pluginToolRows } = await import('../src/composition/plugin-tool-rows');
    const rows = pluginToolRows();
    expect(rows.map((r) => r.id)).toEqual(['plugin/hello/mcp/engine']);
    // 惰性连接：首装配拉远端工具
    const row = rows[0];
    if (!row) throw new Error('桥贡献行未注册');
    const tools = await row.factory({} as never);
    expect(tools.map((t) => t.name())).toEqual(['mcp__engine__probe_tool']);
    // dispose 链（fiber dispose → 贡献注销 + 进程 kill）在 mcp-bridge.test 钉
    // （root 的 asyncDispose 不级联 plugin fibers——此处不重复断言）
    expect(kills).toEqual([]);
    await root[Symbol.asyncDispose]?.();
  });

  it('S2 数据目录衔接：dataDir + mcpServers → ensure 先行捕获路径 → spawn 注入 env', async () => {
    const events: string[] = [];
    const spawns: Array<{ id: string; env?: Record<string, string> }> = [];
    const io = {
      createProcIO: async (id: string, _command: string, _args: string[], env?: Record<string, string>) => {
        spawns.push({ id, env });
        const outCbs = new Set<(line: string) => void>();
        const exitCbs = new Set<(code: number | null) => void>();
        return {
          writeLine: (line: string) => {
            const msg = JSON.parse(line) as { id?: number; method?: string };
            if (msg.id === undefined) return;
            const result =
              msg.method === 'initialize'
                ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'f', version: '1' } }
                : msg.method === 'tools/list'
                  ? { tools: [] }
                  : {};
            for (const cb of outCbs) cb(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
          },
          onStdoutLine: (cb: (line: string) => void) => {
            outCbs.add(cb);
            return () => {
              outCbs.delete(cb);
            };
          },
          onExit: (cb: (code: number | null) => void) => {
            exitCbs.add(cb);
            return () => {
              exitCbs.delete(cb);
            };
          },
          kill: () => {
            for (const cb of exitCbs) cb(0);
          },
        };
      },
      pluginDir: async (name: string) => `C:/plugins/${name}`,
    } as const;

    const root = new Context();
    // 四 service 先挂（wrapper inject 'tools' 可解析——否则 fiber PENDING，apply 不跑）
    const { compositionServicesPlugin } = await import('../src/composition/services');
    await root.plugin(compositionServicesPlugin);
    const { pluginToolRows } = await import('../src/composition/plugin-tool-rows');
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      mcpBridgeIO: io,
      pluginDataEnsure: async (name: string) => {
        events.push('ensure:' + name);
        return `C:/data-root/${name}`;
      },
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/data-app'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/acme/data-app/manifest.json']: {
          name: 'acme/data-app',
          version: '1.0.0',
          entry: 'entry.js',
          dataDir: true,
          mcpServers: [{ name: 'engine', transport: 'stdio', command: './bin/engine', lifecycle: 'lazy' }],
        },
      }),
      importModule: async () => ({
        default: {
          name: 'acme/data-app',
          apply() {
            events.push('apply');
          },
        },
      }),
    });
    expect(usePluginStore.getState().plugins[0]?.status).toBe('active');
    // wrapper ensure 先于插件代码（S1 语义），路径捕获传桥（S2 衔接）
    expect(events[0]).toBe('ensure:acme/data-app');
    expect(events[1]).toBe('apply');
    // 受治 lazy：装配触发拉起 → spawn env 注入 LANTAI_PLUGIN_DATA_DIR
    const row = pluginToolRows().find((r) => r.id === 'plugin/acme/data-app/mcp/engine');
    if (!row) throw new Error('受治 mcp 行未注册');
    await row.factory({} as never);
    const deadline = Date.now() + 1000;
    while (spawns.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(spawns[0]?.env).toEqual({ LANTAI_PLUGIN_DATA_DIR: 'C:/data-root/acme/data-app' });
    await deactivateExternalPlugin('acme/data-app');
  });
});

describe('fiber 生命周期（cordis，workspace-fiber 测试同款模式）', () => {
  it('root.plugin(obj) 注册的 effect 在 fiber dispose 后清理', async () => {
    const root = new Context();
    const events: string[] = [];
    const fiber = root.plugin({
      name: 'probe',
      apply(ctx) {
        ctx.effect(() => {
          events.push('setup');
          return () => {
            events.push('dispose');
          };
        }, 'probe');
      },
    });
    await fiber;
    expect(events).toEqual(['setup']);
    await fiber.dispose();
    expect(events).toEqual(['setup', 'dispose']);
  });

  it('apply 抛错 → await root.plugin() reject（装载期可捕获，进 store）', async () => {
    const root = new Context();
    const fiber = root.plugin({
      name: 'bad',
      apply() {
        throw new Error('apply boom');
      },
    });
    await expect(Promise.resolve(fiber)).rejects.toThrow('apply boom');
  });
});

// ── D6 运行时热重载（平台化 Phase 4，2026-08-27）──

describe('D6 运行时热重载（activateExternalPlugin / deactivateExternalPlugin）', () => {
  beforeEach(async () => {
    // 同 worker 模块态跨用例共享：先拆掉前面用例装载的插件 + 复位运行时
    for (const name of activeExternalPluginNames()) {
      await deactivateExternalPlugin(name);
    }
    resetPluginRuntimeForTests();
    usePluginStore.getState().setPlugins([]);
  });

  function hotPluginModule(name: string, probe: { events: string[] }) {
    return {
      default: {
        name,
        apply(ctx: { effect: (f: () => () => void, label: string) => unknown }) {
          ctx.effect(() => {
            probe.events.push(`${name}:setup`);
            return () => probe.events.push(`${name}:dispose`);
          }, `${name}-probe`);
        },
      },
    };
  }

  it('① boot 装载填充活跃注册表；disable 的插件不在表内', async () => {
    const root = new Context();
    const probe = { events: [] as string[] };
    const importModule = async (url: string): Promise<Record<string, unknown>> => {
      if (url.includes('/hello/')) return hotPluginModule('hello', probe);
      throw new Error('unexpected ' + url);
    };
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: {} },
        [ORIGIN + '/hello/manifest.json']: HELLO_MANIFEST,
      }),
      importModule,
    });
    expect(activeExternalPluginNames()).toEqual(['hello']);
    expect(probe.events).toEqual(['hello:setup']);
    expect(usePluginStore.getState().plugins[0]?.status).toBe('active');
  });

  it('② 停用 = fiber dispose 链式回收贡献；再启用 = 重新装载', async () => {
    const root = new Context();
    const probe = { events: [] as string[] };
    const importModule = async (): Promise<Record<string, unknown>> => hotPluginModule('hello', probe);
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: {} },
        [ORIGIN + '/hello/manifest.json']: HELLO_MANIFEST,
      }),
      importModule,
    });
    expect(probe.events).toEqual(['hello:setup']);

    // 停用：dispose → effect 清理器跑（贡献链式回收）
    expect(await deactivateExternalPlugin('hello')).toBe(true);
    expect(probe.events).toEqual(['hello:setup', 'hello:dispose']);
    expect(activeExternalPluginNames()).toEqual([]);

    // 再启用：重新装载（apply 重跑）
    const record = await activateExternalPlugin('hello');
    expect(record.status).toBe('active');
    expect(probe.events).toEqual(['hello:setup', 'hello:dispose', 'hello:setup']);
    expect(activeExternalPluginNames()).toEqual(['hello']);

    // 未活跃插件停用 = no-op false
    expect(await deactivateExternalPlugin('nope')).toBe(false);
  });

  it('③ 权限门禁照常生效：granted 未覆盖 → blocked 不装载', async () => {
    const root = new Context();
    const manifest = { ...HELLO_MANIFEST, permissions: ['bash'] };
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: {} },
        [ORIGIN + '/hello/manifest.json']: manifest,
      }),
      importModule: async (): Promise<Record<string, unknown>> => {
        throw new Error('blocked 插件不应被 import');
      },
    });
    expect(activeExternalPluginNames()).toEqual([]);

    // 授权后增量激活 → 仍 blocked（granted 段未覆盖——读最新 plugins.json）
    const record = await activateExternalPlugin('hello');
    expect(record.status).toBe('blocked');
    expect(record.missingPermissions).toEqual(['bash']);
    expect(activeExternalPluginNames()).toEqual([]);
  });

  it('④ 未引导运行时（loadExternalPlugins 未跑）→ 显式错误记录，不静默', async () => {
    const record = await activateExternalPlugin('ghost');
    expect(record.status).toBe('error');
    expect(record.error).toContain('插件运行时未引导');
  });

  it('⑤ 升级重装：已活跃插件再 activate = 先拆旧再装载新（dispose → setup）', async () => {
    const root = new Context();
    const probe = { events: [] as string[] };
    const importModule = async (): Promise<Record<string, unknown>> => hotPluginModule('hello', probe);
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: {} },
        [ORIGIN + '/hello/manifest.json']: HELLO_MANIFEST,
      }),
      importModule,
    });
    await activateExternalPlugin('hello'); // 已活跃 → 重装载
    expect(probe.events).toEqual(['hello:setup', 'hello:dispose', 'hello:setup']);
    expect(activeExternalPluginNames()).toEqual(['hello']);
  });

  // ── landmine H4（2026-09-20 立法）：产物 JS 入口必带恒新版本号 ──
  // 病灶：ES module 的模块图按 URL 缓存已求值的模块，同文档内 `import(同一 URL)`
  // 连请求都不发（实测模块请求数 0）⇒「点重新加载」只重跑旧模块，TS 改动必须
  // 重启应用才可见（CSS 那侧 H3 已带版本号 ⇒ 症状是「经常不生效」而非「从来不」）。
  it('⑥ 重载取新产物：入口 URL 带版本号，且两次装载的 URL 必不相同', async () => {
    const root = new Context();
    const probe = { events: [] as string[] };
    const urls: string[] = [];
    const importModule = async (url: string): Promise<Record<string, unknown>> => {
      urls.push(url);
      return hotPluginModule('hello', probe);
    };
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: {} },
        [ORIGIN + '/hello/manifest.json']: HELLO_MANIFEST,
      }),
      importModule,
    });
    await activateExternalPlugin('hello'); // 用户操作：设置 → 插件 → 重新加载

    expect(urls).toHaveLength(2);
    for (const url of urls) expect(url).toContain(ORIGIN + '/hello/entry.js?v=');
    // 判据：URL 恒新 ⇒ 浏览器必重新请求模块（相同 URL = 拿到模块图里的旧模块）
    expect(urls[0]).not.toBe(urls[1]);
  });

  // ── dev 源码域语义错配（2026-09-20 审计）：出厂产物在 dev 走源码路径装载，
  //    不在产物通道的活跃表里 ⇒ 从产物通道重载 = 同 id 贡献二次注册 ⇒
  //    注册表见同 id 即抛（contribution-channel）。具名拒绝取代隐晦抛错。
  it('⑦ dev 源码域：出厂产物的产物通道重载被具名拒绝，不制造撞 id 的隐晦失败', async () => {
    const root = new Context();
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hologram/canvas-nav'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: {} },
      }),
      importModule: async () => {
        throw new Error('dev 源码域的产物不应被 import');
      },
    });
    // vitest 域 DEV=true（同 allBuiltinPlugins 的 dev 展开判据）
    const record = await activateExternalPlugin('hologram/canvas-nav');
    expect(record.status).toBe('error');
    expect(record.error).toContain('dev 源码域');
    expect(activeExternalPluginNames()).toEqual([]);
  });
});

// ── 2026-08-29：第一方插件收编 plugin-store（平台化收尾）──

describe('loadBuiltinPlugins（第一方插件进插件列表）', () => {
  beforeEach(() => {
    usePluginPrefs.getState().resetForTests();
    usePluginStore.getState().setPlugins([]);
  });

  it('装载后写入 plugin-store：58 条 builtin 记录 + 元数据 + 状态 active', async () => {
    const root = new Context();
    loadBuiltinPlugins(root);
    // cordis plugin() 是 promise——flush 微任务让四 service 与 bundle 贡献落定
    await new Promise((resolve) => setTimeout(resolve, 0));
    const plugins = usePluginStore.getState().plugins;
    expect(plugins).toHaveLength(ALL_PLUGINS.length);
    // graph 三件套退役（2026-09-09）：45 → 42；office-domain 新增（2026-09-13）：42 → 43
    // plan-mode 新增（2026-09-24 批 6a：规划模式实现归产物）：43 → 44
    // goal-mode 新增（2026-09-24 批 6b：goal 循环实现归产物）：44 → 45
    // state-hooks 新增（2026-09-24 批 6c：出厂 hook 四工厂归产物）：45 → 46
    // composition-root-views 新增（2026-09-26 批 9e：App 外壳视图槽通道 = 内核 service）：50 → 51
    // sessions-home 新增（2026-09-26 批 9e：案卷首页归产物）：51 → 52
    // ask-cards 新增（2026-09-26 批 9e-3：ask/权限卡架归产物）：52 → 53
    // token-meter 新增（2026-09-26 §4-6 A：token 计量升为内核第 16 个 service）：53 → 54
    // 批 10 同窗两条通道 service（workspaces / shellRows）：54 → 56
    // 批 10 部件三 bundled-engine 产物：56 → 57
    // pre-step-service 新增（2026-10-13 agent-hooks-plan 一期：步前裁决贡献面）：57 → 58
    expect(ALL_PLUGINS.length).toBe(58);
    expect(plugins.every((p) => p.builtin === true)).toBe(true);
    expect(plugins.every((p) => p.meta?.name === p.name)).toBe(true);
    expect(plugins.every((p) => p.status === 'active')).toBe(true);
  });

  it('用户禁用的 feature 插件：跳过装载 + 记录 disabled（下次启动生效）', async () => {
    const feature = ALL_PLUGINS.find((p) => FIRST_PARTY_MANIFEST[p.name]?.kind === 'feature');
    expect(feature).toBeTruthy();
    if (!feature) return;
    usePluginPrefs.getState().setDisabled(feature.name, true);
    const root = new Context();
    loadBuiltinPlugins(root);
    // cordis plugin() 是 promise——flush 微任务让四 service 与 bundle 贡献落定
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rec = usePluginStore.getState().plugins.find((p) => p.name === feature.name);
    expect(rec?.status).toBe('disabled');
    // 其余仍是 active
    const activeCount = usePluginStore
      .getState()
      .plugins.filter((p) => p.name !== feature.name && p.status === 'active').length;
    expect(activeCount).toBe(ALL_PLUGINS.length - 1);
  });

  it('platform（service）无视禁用集——常驻不可禁', async () => {
    const service = ALL_PLUGINS.find((p) => FIRST_PARTY_MANIFEST[p.name]?.kind === 'service');
    expect(service).toBeTruthy();
    if (!service) return;
    usePluginPrefs.getState().setDisabled(service.name, true);
    const root = new Context();
    loadBuiltinPlugins(root);
    // cordis plugin() 是 promise——flush 微任务让四 service 与 bundle 贡献落定
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rec = usePluginStore.getState().plugins.find((p) => p.name === service.name);
    expect(rec?.status).toBe('active');
  });

  it('外部插件装载不冲刷第一方记录（mergePlugins 语义）', async () => {
    // 先装载第一方
    const root = new Context();
    loadBuiltinPlugins(root);
    // cordis plugin() 是 promise——flush 微任务让四 service 与 bundle 贡献落定
    await new Promise((resolve) => setTimeout(resolve, 0));
    const builtinCount = usePluginStore.getState().plugins.length;
    expect(builtinCount).toBeGreaterThan(0);
    // 再装载一个外部插件——第一方记录必须保留
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['hello'],
        [ORIGIN + '/plugins.json']: { disabled: [] },
        [ORIGIN + '/hello/manifest.json']: HELLO_MANIFEST,
      }),
      importModule: async () => ({ default: { name: 'hello', apply() {} } }),
    });
    const plugins = usePluginStore.getState().plugins;
    expect(plugins).toHaveLength(builtinCount + 1);
    expect(plugins.filter((p) => p.builtin === true)).toHaveLength(builtinCount);
    expect(plugins.find((p) => p.name === 'hello')?.builtin).toBeFalsy();
  });
});

describe('P1 内置渲染器插件（磁盘产物装载→覆盖行）', () => {
  beforeEach(() => {
    usePluginStore.setState({ plugins: [] });
  });

  /** 装配 renderers 服务 + bundle 渲染器插件（出厂兜底行）的 ctx。 */
  async function withRenderersCtx(fn: (root: Context) => void | Promise<void>): Promise<void> {
    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    await root.plugin(rendererServicePlugin);
    await root.plugin(builtinRenderersPlugin);
    await fn(root);
    await root.fiber.dispose();
  }

  it('bundle 行注册后 resolveRenderer(kind) 走 builtin/<kind>（出厂兜底）', async () => {
    await withRenderersCtx(() => {
      expect(resolveRenderer('media')?.id).toBe('builtin/media');
      expect(resolveRenderer('grid')?.id).toBe('builtin/grid');
      expect(resolveRenderer('html')?.id).toBe('builtin/html');
    });
  });

  it('S5 dev 模式：出厂产物在通道索引中被过滤（源码域已装载，防重复/覆盖热重载）', async () => {
    const RENDERERS_MANIFEST = {
      name: 'hologram/renderers',
      version: '1.0.0',
      entry: 'entry.js',
      inject: ['renderers'],
    };
    await withRenderersCtx(async (root) => {
      // 装载前：bundle 兜底行（dev 模式下 ALL_PLUGINS 含 renderers 源码行）
      expect(resolveRenderer('media')?.id).toBe('builtin/media');
      // dev 模式 loadExternalPlugins 过滤出厂产物名——通道里的磁盘副本跳过
      let imported = false;
      await loadExternalPlugins(root, {
        origin: ORIGIN,
        fetchImpl: mockFetch({
          [ORIGIN + '/']: ['hologram/renderers'],
          [ORIGIN + '/plugins.json']: { disabled: [] },
          [ORIGIN + '/hologram/renderers/manifest.json']: RENDERERS_MANIFEST,
        }),
        importModule: async () => {
          imported = true;
          return { default: { name: 'hologram/renderers', apply() {} } };
        },
      });
      expect(imported).toBe(false); // 通道里的 renderers 未被 import（dev 过滤）
      // 兜底行未被覆盖（源码域装载的行是唯一行）
      expect(resolveRenderer('media')?.id).toBe('builtin/media');
    });
  });
});

// ── S5：位移式装载已退役（bundle 兜底行拆除，产物是唯一装载面）──

/** 从 root Context 取 commands service 注册表（组合层四 service 挂根，类型经 cordis 模块扩充）。 */
function ctxCommands(root: Context) {
  return root.commands;
}

// ── 保险丝 a：face 键集对拍门禁（2026-09-03 生产事故立法）──
// 起因：新树构建的产物丢进旧 exe → faceDeps 缺键 → 渲染期 TypeError →
// React 整树卸载。装载器在 displace 之前对拍 face.json，缺键拒载。

describe('face 键集对拍门禁（保险丝 a）', () => {
  beforeEach(async () => {
    for (const name of activeExternalPluginNames()) {
      await deactivateExternalPlugin(name);
    }
    resetPluginRuntimeForTests();
    usePluginStore.getState().setPlugins([]);
  });

  // S5：face 键测试改用第三方插件名（出厂产物名在 dev 模式被 loadExternalPlugins
  // 过滤——源码域已装载，不测通道路径）。face 键集对拍机制对任何插件一律生效。
  const FACE_TEST_MANIFEST = {
    name: 'acme/face-probe',
    version: '1.0.0',
    entry: 'entry.js',
    inject: ['commands'],
  };

  it('face.json 缺键（版本偏斜）→ 拒载：import 不发生', async () => {
    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    let imported = false;
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/face-probe'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: {} },
        [ORIGIN + '/acme/face-probe/manifest.json']: FACE_TEST_MANIFEST,
        [ORIGIN + '/acme/face-probe/face.json']: { faceDeps: ['layoutRegion', '__lantai_never_key__'] },
      }),
      importModule: async () => {
        imported = true;
        return { default: { name: 'acme/face-probe', apply() {} } };
      },
    });
    // 产物代码未执行（拒载发生在 import 之前）
    expect(imported).toBe(false);
    const rec = usePluginStore.getState().plugins.find((p) => p.name === 'acme/face-probe');
    expect(rec?.status).toBe('error');
    expect(rec?.error).toContain('宿主面缺键');
    expect(rec?.error).toContain('__lantai_never_key__');
  });

  it('face.json 宿主面指纹偏斜（保险丝 a′）→ 拒载：报错给出两个指纹', async () => {
    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    let imported = false;
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/face-probe'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: {} },
        [ORIGIN + '/acme/face-probe/manifest.json']: FACE_TEST_MANIFEST,
        // 键全在（键集闸不会开火），但指纹是旧 exe 的——正是「本批动了宿主面、
        // 产物只换产物热更」那种偏斜
        [ORIGIN + '/acme/face-probe/face.json']: {
          faceDeps: ['layoutRegion', 'ANCHOR'],
          hostApi: 'deadbeef',
        },
      }),
      importModule: async () => {
        imported = true;
        return { default: { name: 'acme/face-probe', apply() {} } };
      },
    });
    expect(imported).toBe(false);
    const rec = usePluginStore.getState().plugins.find((p) => p.name === 'acme/face-probe');
    expect(rec?.status).toBe('error');
    expect(rec?.error).toContain('宿主面版本偏斜');
    expect(rec?.error).toContain('deadbeef'); // 产物声明的指纹
    expect(rec?.error).toContain(hostSurfaceFingerprint()); // 当前 exe 的指纹
    expect(rec?.error).toContain('重建 exe');
  });

  it('face.json 全键在 → 正常装载', async () => {
    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/face-probe'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: {} },
        [ORIGIN + '/acme/face-probe/manifest.json']: FACE_TEST_MANIFEST,
        // layoutRegion / ANCHOR 是运行时 faceDeps 实有键（同源产物）
        [ORIGIN + '/acme/face-probe/face.json']: { faceDeps: ['layoutRegion', 'ANCHOR'] },
      }),
      importModule: async () => ({
        default: {
          name: 'acme/face-probe',
          inject: ['commands'],
          apply(ctx: Context) {
            ctx.effect(
              () =>
                ctx.commands.register({
                  id: 'acme/probe',
                  label: '探针',
                  group: '测试',
                  slash: '/probe',
                  action: { type: 'local', handler: () => {} },
                }),
              'acme-probe',
            );
          },
        },
      }),
    });
    expect(ctxCommands(root).get('acme/probe')).toBeTruthy();
    const rec = usePluginStore.getState().plugins.find((p) => p.name === 'acme/face-probe');
    expect(rec?.status).toBe('active');
  });

  it('face.json 坏形状（faceDeps 非数组）→ 视为零需求照常装载（毒化容忍）', async () => {
    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        [ORIGIN + '/']: ['acme/face-probe'],
        [ORIGIN + '/plugins.json']: { disabled: [], granted: {} },
        [ORIGIN + '/acme/face-probe/manifest.json']: FACE_TEST_MANIFEST,
        [ORIGIN + '/acme/face-probe/face.json']: { faceDeps: 'not-an-array' },
      }),
      importModule: async () => ({
        default: { name: 'acme/face-probe', inject: ['commands'], apply() {} },
      }),
    });
    const rec = usePluginStore.getState().plugins.find((p) => p.name === 'acme/face-probe');
    expect(rec?.status).toBe('active');
  });
});

describe('S6 P3a：activation 声明-接线对齐（登记 ≠ 激活）', () => {
  beforeEach(() => {
    usePluginStore.setState({ plugins: [] });
    clearActivationsForTest();
  });

  const LAZY_MANIFEST = {
    name: 'acme/res',
    version: '1.0.0',
    entry: 'entry.js',
    activation: { lazy: true, resources: ['stdio'], exclusive: ['port:9310'] },
  };

  const routes = {
    [ORIGIN + '/']: ['acme/res'],
    [ORIGIN + '/plugins.json']: { disabled: [] },
    [ORIGIN + '/acme/res/manifest.json']: LAZY_MANIFEST,
  };

  it('声明 activation.lazy 但 apply 未登记激活回调 → 装载失败记录（不静默放过）', async () => {
    const root = new Context();
    await root.plugin(compositionServicesPlugin); // 生产同序：组合层 service 先于外部插件
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch(routes),
      importModule: async () => ({ default: { name: 'acme/res', apply() {} } }),
    });
    const rec = usePluginStore.getState().plugins.find((p) => p.name === 'acme/res');
    expect(rec?.status).toBe('error');
    expect(rec?.error).toContain('未登记激活回调');
    expect(activeExternalPluginNames()).not.toContain('acme/res');
  });

  it('声明 + 登记齐备 → active；装载期零副作用，装配期才 start（登记 ≠ 激活）', async () => {
    const log: string[] = [];
    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch(routes),
      importModule: async () => ({
        default: {
          name: 'acme/res',
          // 装载层为 activation 声明补 inject（与 tools 同款）——故此处不写 inject
          apply(ctx: Context) {
            ctx.activation.declare('acme/res', {
              resources: ['stdio'],
              exclusive: ['port:9310'],
              start: () => {
                log.push('start');
              },
              stop: () => {
                log.push('stop');
              },
            });
          },
        },
      }),
    });
    const rec = usePluginStore.getState().plugins.find((p) => p.name === 'acme/res');
    expect(rec?.status).toBe('active');
    expect(log).toEqual([]); // 登记 ≠ 激活：装载期不起副作用

    const handles = await root.activation.retainForComposition(
      { tools: [{ id: 'plugin/acme/res/probe' }] },
      'holder-1',
    );
    expect(log).toEqual(['start']); // 组合装配期才启动
    await root.activation.releaseAll(handles);
    expect(log).toEqual(['start', 'stop']);
  });

  it('声明 activation.lazy 的 MCP 插件：懒激活由治理器 lifecycle 承担（不要求 apply 再登记）', async () => {
    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    await loadExternalPlugins(root, {
      origin: ORIGIN,
      fetchImpl: mockFetch({
        ...routes,
        [ORIGIN + '/acme/res/manifest.json']: {
          ...LAZY_MANIFEST,
          mcpServers: [{ name: 'engine', transport: 'stdio', command: 'node', lifecycle: 'lazy' }],
        },
      }),
      importModule: async () => ({ default: { name: 'acme/res', apply() {} } }),
    });
    const rec = usePluginStore.getState().plugins.find((p) => p.name === 'acme/res');
    expect(rec?.status).toBe('active'); // 不因「未登记回调」被拒
  });
});
