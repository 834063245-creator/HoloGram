// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// rpc 边界运行时校验层（2026-09-01）三重守护：
//   1. mock 同源自检——遍历 rpcResultSchemas 已收编命令的 mockInvoke 返回，
//      对同一张 schema 表校验：mock 与 schema 漂移在 vitest 第一时间炸，
//      浏览器 dev「恒看起来对」的假象根除（设计件 §3.3）。
//   2. schema 四态——合法 / 缺字段 / 多字段 / 类型错（以 workspace_list、
//      list_directory 两个最富形状为代表逐态断言；全量合法形状由 1 覆盖）。
//   3. 终态守卫——全库 `typedJsonRpc<` 泛型残留为零（签名收紧后守卫即
//      编译器，本守卫钉住泛型盲转不回潮；rpc-contract.ts 定义本体豁免）。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mockInvoke } from '../src/mock-data';
import { dirEntryArraySchema, parseJson, rpcResultSchemas } from '../src/rpc-contract';

/** 每个已收编命令的 mock 取样参数（取 mockInvoke 已登记的命令面）。
 *  （list_directory / list_directory_flat / read_memory_batch 已迁 builtin.fs——
 *  走 tool_call 信封 + kernelListDirectory 内的 dirEntryArraySchema 校验，
 *  不再是 rpcResultSchemas 收编面，kernel-plugin-runtime P2-2；git_status
 *  同理随 git 域收口退役——走 git_cap + git-porcelain.ts 解析，R3-c；
 *  shell_env 同理随 shell 域收口退役——走 process_cap 文本路径 + 消费方
 *  parseJson，R3-d。） */
const MOCK_SAMPLE_PARAMS: Record<keyof typeof rpcResultSchemas, Record<string, unknown>> = {
  hologram_call: { tool: 'fragile_modules', args: {} },
  hologram_tools_list: {},
  load_graph_json: { path: '/mock/nebula-project' },
  get_last_project: {},
  workspace_list: {},
  sandbox_status: {},
  plugin_data_ensure: { name: 'mock-plugin' },
  plugin_data_list: { name: 'mock-plugin', path: '' },
  // 随包引擎探测（2026-09-24 收编）：无参；mock 返回合成「已检测到」形状。
  engine_bundled_info: {},
  // 诊断包导出（日志可观测性批 4 收编）：无参；mock 返回合成形状（浏览器 dev 无盘）。
  diag_export: {},
};

describe('rpc 边界校验层：mock 同源自检（mock ↔ schema 漂移即红）', () => {
  for (const method of Object.keys(rpcResultSchemas) as Array<keyof typeof rpcResultSchemas>) {
    it(`${method}: mockInvoke 返回过 rpcResultSchemas 校验`, () => {
      const raw = mockInvoke(method, MOCK_SAMPLE_PARAMS[method]);
      const value: unknown = typeof raw === 'string' ? parseJson(raw) : raw;
      const parsed = rpcResultSchemas[method].safeParse(value);
      const issues = parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3));
      expect(parsed.success, `${method} mock 形状漂移: ${issues}`).toBe(true);
    });
  }
});

describe('rpc 边界校验层：schema 四态', () => {
  const ws = rpcResultSchemas.workspace_list;
  const validWs = {
    path: 'D:/works/x',
    name: null,
    last_opened_at: '2026-09-01T00:00:00Z',
    pinned: false,
    session_count: 0,
    latest_saved_at: null,
    dir_exists: true,
    graph_engine: null,
  };

  it('workspace_list 合法：全字段通过', () => {
    expect(ws.safeParse([validWs]).success).toBe(true);
  });

  it('workspace_list 缺字段：dir_exists 缺失即拒（首页「目录已丢失」误判路径的钉子）', () => {
    const broken: Record<string, unknown> = { ...validWs };
    delete broken.dir_exists;
    expect(ws.safeParse([broken]).success).toBe(false);
  });

  it('workspace_list 多字段：Rust 加字段不炸前端（passthrough 语义）', () => {
    expect(ws.safeParse([{ ...validWs, future_field: 1 }]).success).toBe(true);
  });

  it('workspace_list 类型错：pinned 为字符串即拒', () => {
    expect(ws.safeParse([{ ...validWs, pinned: 'yes' }]).success).toBe(false);
  });

  // P2-2：list_directory 返回形状守护迁 dirEntryArraySchema（信封化后由
  // kernelListDirectory 内联消费，不再走 rpcResultSchemas 表行）
  const dir = dirEntryArraySchema;
  const leaf = { name: 'a.ts', path: '/mock/a.ts', is_dir: false, children: null };

  it('list_directory 合法：嵌套 children 递归通过', () => {
    expect(dir.safeParse([{ name: 'src', path: '/mock/src', is_dir: true, children: [leaf] }]).success).toBe(true);
  });

  it('list_directory 缺字段：children 缺失即拒（Rust DirEntry children 键恒在）', () => {
    const broken: Record<string, unknown> = { name: 'src', path: '/mock/src', is_dir: true };
    expect(dir.safeParse([broken]).success).toBe(false);
  });

  it('list_directory 类型错：is_dir 为数字即拒', () => {
    expect(dir.safeParse([{ ...leaf, is_dir: 0 }]).success).toBe(false);
  });
});

describe('rpc 边界校验层：终态守卫', () => {
  it('全库 typedJsonRpc< 泛型残留为零（泛型盲转不回潮）', () => {
    const offenders: string[] = [];
    const walk = (root: string): void => {
      for (const name of readdirSync(root, { withFileTypes: true })) {
        const p = join(root, name.name);
        if (name.isDirectory()) {
          walk(p);
        } else if (/\.tsx?$/.test(name.name) && !name.name.includes('rpc-contract')) {
          if (/typedJsonRpc</.test(readFileSync(p, 'utf8'))) offenders.push(p);
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});
