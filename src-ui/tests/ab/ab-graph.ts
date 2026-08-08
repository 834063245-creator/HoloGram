import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface TrialGraphData {
  nodes: Array<{ id: string; name: string; kind: string; location: string }>;
  edges: Array<{ source: string; target: string; kind: string }>;
}

export function loadGraphFromDb(dbPath: string): TrialGraphData | null {
  try {
    if (!fs.existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const nodes = db
      .prepare('SELECT id, name, kind, location FROM nodes LIMIT 200000')
      .all() as Array<{ id: string; name: string; kind: string; location: string }>;
    const edges = db
      .prepare('SELECT source, target, kind FROM edges LIMIT 400000')
      .all() as Array<{ source: string; target: string; kind: string }>;
    db.close();
    if (nodes.length === 0) return null;
    return { nodes, edges };
  } catch {
    return null;
  }
}

export function buildFixtureGraph(worktree: string): TrialGraphData {
  const files = [
    'engine/src/storage/store.rs',
    'engine/src/storage/snapshot.rs',
    'engine/src/graph/mod.rs',
    'src-ui/src/agent/hooks.ts',
    'src-ui/src/agent/state-inject.ts',
    'src-ui/src/agent/tools/coding.ts',
    'src-ui/src/agent/agent.ts',
  ];
  const nodes: TrialGraphData['nodes'] = [];
  const edges: TrialGraphData['edges'] = [];
  let id = 0;
  for (const f of files) {
    const base = f.split('/').pop()!.replace(/\.[^.]+$/, '');
    for (const sym of [base, base + 'Impl', base + 'Helper']) {
      nodes.push({ id: `f${id}`, name: sym, kind: 'function', location: `${worktree}/${f}:10` });
      id++;
    }
  }
  for (let i = 1; i < id; i++) {
    edges.push({ source: `f${i - 1}`, target: `f${i}`, kind: 'calls' });
  }
  return { nodes, edges };
}

export function resolveGraphData(worktree: string, graphDbPath?: string): TrialGraphData {
  const fromDb = graphDbPath ? loadGraphFromDb(graphDbPath) : null;
  return fromDb ?? buildFixtureGraph(worktree);
}
