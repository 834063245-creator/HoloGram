// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// bootstrap.ts has been replaced by agent/runtime/agent-builder.ts (pure, zero
// ui/ imports) and ui/runtime-adapter.ts (UI implementation). All agent/ files
// must remain pure — no UI imports, no browser APIs.
// If you need a new agent→ui channel, add a callback to AgentUINotifier /
// RuntimeNotifier / constructor injection instead.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const AGENT_DIR = join(process.cwd(), 'src', 'agent');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

// import ... from '../ui/...' or '../../ui/...'
const UI_IMPORT_RE = /from\s+['"][^'"]*\.\.\/ui\//;
// browser-only APIs that would make the core un-runnable headless.
// 只命中"真正调用"形态，避免把英文描述文案里的 "the ... window."（自然语言）
// 误判成浏览器 API（UIA 工具描述里大量出现，曾导致误报）。匹配：
//   - requestAnimationFrame(  调用
//   - window./document. 后紧跟标识符（真实属性访问，如 window.addEventListener）
//   - window[...] / document[...] 括号访问
const BROWSER_API_RE = /requestAnimationFrame\(|\b(?:window|document)\.[A-Za-z_$]|\b(?:window|document)\[/;

describe('agent → ui one-way boundary', () => {
  const files = walk(AGENT_DIR);

  it('scans a non-trivial number of agent files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    it(`${relative(AGENT_DIR, file)} — no ui/ imports, no browser APIs`, () => {
      const src = readFileSync(file, 'utf8');
      const uiHit = src.match(UI_IMPORT_RE);
      expect(uiHit, `ui/ import found: ${uiHit?.[0]}`).toBeNull();
      const domHit = src.match(BROWSER_API_RE);
      expect(domHit, `browser API found: ${domHit?.[0]}`).toBeNull();
    });
  }
});
