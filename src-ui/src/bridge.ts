// Bridge — detects Tauri vs browser, routes invoke/listen to real or mock
// Import this instead of '@tauri-apps/api/core' / '@tauri-apps/api/event'

const IS_TAURI = '__TAURI_INTERNALS__' in window;

// ── Mock invoke ──
import { mockInvoke } from './mock-data';
import { log } from './agent/logger';

let _realInvoke: any;
let _realListen: any;

async function loadReal() {
  if (!_realInvoke) {
    const core = await import('@tauri-apps/api/core').catch(() => {
      throw new Error('Failed to load Tauri core API — is the app running in Tauri shell?');
    });
    _realInvoke = core.invoke;
  }
}

async function loadRealListen() {
  if (!_realListen) {
    const event = await import('@tauri-apps/api/event').catch(() => {
      throw new Error('Failed to load Tauri event API — is the app running in Tauri shell?');
    });
    _realListen = event.listen;
  }
}

/**
 * Drop-in replacement for `invoke` from @tauri-apps/api/core.
 * In browser (npm run dev), routes to mock data.
 * In Tauri, calls the real backend.
 */
export async function invoke<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (IS_TAURI) {
    await loadReal();
    log.debug('bridge', 'invoke', { command: cmd });
    try {
      const result = await _realInvoke(cmd, args);
      return result;
    } catch (e: any) {
      log.error('bridge', 'invoke failed', { command: cmd, error: String(e) });
      throw e;
    }
  }
  // Browser mock mode
  return mockInvoke(cmd, args) as T;
}

/**
 * Drop-in replacement for `listen` from @tauri-apps/api/event.
 * In browser, returns a no-op unlisten function.
 */
export async function listen<T = any>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  if (IS_TAURI) {
    await loadRealListen();
    return _realListen(event, handler);
  }
  // Browser: no file watcher — just return a dummy unlisten
  return () => {};
}

/** True when running standalone in browser (npm run dev). */
export function isMockMode(): boolean {
  return !IS_TAURI;
}
