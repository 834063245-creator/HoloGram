// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// One-way boundary enforcement: src/agent (agent core) must never import from
// src/ui (rendering) and never touch browser-only APIs. UI code may freely
// import agent/ — the reverse direction is what rotted the seams (workspace
// god-object bugs, unmockable hidden singletons, un-headless-able core).
//
// This test IS the boundary constraint — it runs on every `vitest run`,
// no graph engine or human memory required. If you need a new agent→ui
// channel, add a callback to AgentUINotifier / constructor injection instead.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const AGENT_DIR = join(process.cwd(), 'src', 'agent');

// bootstrap.ts is the wiring layer — it bridges agent core and UI,
// so it legitimately imports from ../ui/. All other agent/ files must
// remain pure (no UI imports, no browser APIs).
const BOUNDARY_EXEMPT = new Set(['bootstrap.ts']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !BOUNDARY_EXEMPT.has(entry)) out.push(full);
  }
  return out;
}

// import ... from '../ui/...' or '../../ui/...'
const UI_IMPORT_RE = /from\s+['"][^'"]*\.\.\/ui\//;
// browser-only APIs that would make the core un-runnable headless
const BROWSER_API_RE = /\b(requestAnimationFrame|document\.|window\.)/;

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
