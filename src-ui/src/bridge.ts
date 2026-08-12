// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Bridge — 检测 Tauri 与浏览器环境，将 invoke/listen 路由到真实或 mock 实现
// 用此模块替代 '@tauri-apps/api/core' / '@tauri-apps/api/event'

const IS_TAURI = '__TAURI_INTERNALS__' in window;

import { log } from './agent/logger';

type RealInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type RealListen = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
let _realInvoke: RealInvoke | null = null;
let _realListen: RealListen | null = null;
let _mockInvoke: ((cmd: string, args?: Record<string, unknown>) => string) | undefined;

async function loadMock(): Promise<(cmd: string, args?: Record<string, unknown>) => string> {
  if (!_mockInvoke) {
    const mock = await import('./mock-data');
    _mockInvoke = mock.mockInvoke;
  }
  return _mockInvoke;
}

async function loadReal(): Promise<void> {
  if (!_realInvoke) {
    const core = await import('@tauri-apps/api/core').catch(() => {
      throw new Error('Failed to load Tauri core API — is the app running in Tauri shell?');
    });
    _realInvoke = core.invoke as unknown as RealInvoke;
  }
}

async function loadRealListen(): Promise<void> {
  if (!_realListen) {
    const event = await import('@tauri-apps/api/event').catch(() => {
      throw new Error('Failed to load Tauri event API — is the app running in Tauri shell?');
    });
    // Tauri 的 EventCallback<T> 携带 event/id 元字段 — 本桥接层只暴露 payload，
    // 类型边界收窄在模块加载点一次性完成（运行时直通）。
    _realListen = event.listen as unknown as RealListen;
  }
}

/**
 * `invoke`（来自 @tauri-apps/api/core）的直接替代品。
 * 浏览器环境（npm run dev）下路由到 mock 数据。
 * Tauri 环境下调用真实后端。
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (IS_TAURI) {
    await loadReal();
    log.debug('bridge', 'invoke', { command: cmd });
    try {
      const result = await _realInvoke(cmd, args);
      return result as T;
    } catch (e) {
      log.error('bridge', 'invoke failed', { command: cmd, error: String(e) });
      throw e;
    }
  }
  // 浏览器 mock 模式
  return (await loadMock())(cmd, args) as T;
}

/**
 * `listen`（来自 @tauri-apps/api/event）的直接替代品。
 * 浏览器环境下返回空操作 unlisten 函数。
 */
export async function listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
  if (IS_TAURI) {
    await loadRealListen();
    return _realListen(event, handler);
  }
  // 浏览器：无文件监听 — 返回一个空 unlisten
  return () => {};
}

/** 在浏览器中独立运行时为 true（npm run dev）。 */
export function isMockMode(): boolean {
  return !IS_TAURI;
}

/**
 * RPC — 所有应用命令的统一入口。
 * 替代单独的 invoke('cmd_name', params) 调用。
 * 自动将 camelCase 参数键转换为 snake_case 以适配 Rust 后端。
 */
export async function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const normalized: Record<string, unknown> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      // ponytail：仅在 lowercase→uppercase 转换处插入 _。
      // 避免破坏缩写词（URI → uri，而非 u_r_i）。
      const snakeKey = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      normalized[snakeKey] = value;
    }
  }
  return invoke<T>('rpc', { method, params: normalized });
}
