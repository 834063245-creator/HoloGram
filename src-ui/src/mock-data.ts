// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// Mock 数据 — 浏览器开发模式下的 RPC/命令 mock。
// （图谱 mock 面——Nebula 依赖图/引擎工具 schema/工具响应（hologram_call /
//  hologram_tools_list / load_graph_json 等）——已随图谱功能全量退役删除，
//  2026-09-09；剩余面 = 工作区/插件数据/沙箱状态等与引擎无关的命令 mock。）

// ── Mock invoke 分发器 ──
export function mockInvoke(cmd: string, args?: Record<string, unknown>): string {
  // RPC — 所有命令现在通过 invoke("rpc", {method, params}) 路由。
  // 提取 method + params 并分发到现有处理器。
  if (cmd === 'rpc') {
    const method = args?.method as string;
    const params = args?.params as Record<string, unknown>;
    return mockInvoke(method, params);
  }

  // 工作区生命周期（浏览器中为空操作）
  if (cmd === 'workspace_deactivate') {
    return '(mock: workspace deactivate no-op in browser)';
  }

  // 最近工作区（冷启动恢复信号）：mock 无持久化 → null
  if (cmd === 'get_last_project') {
    return 'null';
  }

  // 边界运行时校验层（2026-09-01）配套：以下命令此前落「Unhandled 回退」垃圾
  // 形状（{mock:true,…}），typedJsonRpc 校验后必炸——补齐真实形状，
  // 浏览器 dev 与真机同形（形状真源 = 各 Rust 命令实现）。
  if (cmd === 'sandbox_status') {
    return JSON.stringify({ available: true, degraded: false, reason: '' });
  }

  // app shell 件 B（S1）：插件数据目录 mock（浏览器 dev 无盘权——虚拟地盘
  // 形状，形状真源 = commands/plugin_data.rs；mock↔schema 同源自检钉住）。
  if (cmd === 'plugin_data_ensure') {
    const name = args?.name;
    return JSON.stringify({
      path: 'mock://plugin-data/' + (typeof name === 'string' ? name : 'unknown'),
    });
  }
  if (cmd === 'plugin_data_list') {
    return JSON.stringify({
      entries: [
        { name: 'notes.json', is_dir: false, size: 128 },
        { name: 'backups', is_dir: true, size: 0 },
      ],
    });
  }

  // 首页工作区清单（2026-09-01 三轴面审种子）：浏览器 dev 此前恒空态，
  // 首页数据态无法取证。两行覆盖面：置顶+活跃 / 非置顶+昨日+无注册名。
  if (cmd === 'workspace_list') {
    const now = Date.now();
    return JSON.stringify([
      {
        path: 'D:/works/nebula-novel',
        name: '星云小说',
        last_opened_at: new Date(now - 40 * 60_000).toISOString(),
        pinned: true,
        session_count: 12,
        latest_saved_at: new Date(now - 8 * 60_000).toISOString(),
        dir_exists: true,
      },
      {
        path: 'D:/works/verse-manuscripts/2026-chapters',
        name: null,
        last_opened_at: new Date(now - 26 * 3600_000).toISOString(),
        pinned: false,
        session_count: 3,
        latest_saved_at: new Date(now - 5 * 3600_000).toISOString(),
        dir_exists: true,
      },
    ]);
  }

  // 随包图谱引擎探测（2026-09-24 补）：浏览器 dev 无随包二进制 ⇒ 诚实形状
  // 「未检测到」（path/dir 为 null）。**不合成 available:true**——那会让 jsdom
  // 测试环境凭空「有引擎」，改掉既有用例的前提（引擎缺席时零成本降级、
  // 不碰 IO），也把「浏览器里能拨开关」这种假象带回 dev。形状真源 =
  // rpc.rs 的 engine_bundled_info 分支；mock↔schema 同源自检
  // （rpc-result-schemas.test）钉住形状。
  if (cmd === 'engine_bundled_info') {
    return JSON.stringify({ path: null, dir: null, available: false });
  }

  // 诊断包导出（日志可观测性批 4）：浏览器 dev 无真实日志文件系统 ⇒ 合成形状
  // （形状真源 = commands/diag.rs 的 ChannelOut；mock↔schema 同源自检钉住）。
  if (cmd === 'diag_export') {
    return JSON.stringify({
      path: 'mock://.lantai/diag/lantai-diag-20261012-000000.txt',
      size: 1024,
      channels: [{ name: 'ui.log', exists: false, size: 0, included_bytes: 0, truncated: false }],
    });
  }

  // 回退
  console.warn(`[mock] Unhandled command: ${cmd}`, args);
  return JSON.stringify({ mock: true, cmd, note: 'No mock data for this command' });
}
