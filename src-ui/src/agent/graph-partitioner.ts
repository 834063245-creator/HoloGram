// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Graph-aware work partitioning — split a codebase into independent work zones
// using hologram community detection + graph analysis.
//
// This is what CC can't do — precise partitioning based on actual dependency data.

import { invoke } from '../bridge';

export interface WorkPartition {
  label: string;
  files: string[];
  entryPoints: string[];
  crossDeps: string[];
}

/** Partition the project scope into N work zones using graph community detection.
 *  Returns partitions sorted by size (largest first). */
export async function partitionByGraph(
  scope: string,
  maxPartitions: number = 4,
): Promise<WorkPartition[]> {
  try {
    // Step 1: Get community clusters from hologram
    const clustersRaw = await invoke<string>('hologram_call', {
      tool: 'hologram_clusters',
      args: { maxClusters: maxPartitions },
    });
    const clusters = parseClusters(clustersRaw);

    if (clusters.length === 0) {
      // Fallback: single partition with entire scope
      return [{
        label: '全库',
        files: [scope],
        entryPoints: [],
        crossDeps: [],
      }];
    }

    // Step 2: For each community, get entry points (top-degree nodes)
    const partitions: WorkPartition[] = [];
    for (const cluster of clusters) {
      const files = cluster.nodes
        .filter((n: string) => n.includes('.')) // filter to file-level nodes
        .map((n: string) => {
          // Extract file path from node ID: "D:.path.to.file.ts.symbol" → "path/to/file.ts"
          const parts = n.split('.');
          // Find the .ts/.rs/.py/etc boundary
          for (let i = 1; i < parts.length; i++) {
            if (/\.(ts|tsx|js|jsx|rs|py|go|java|rb)$/.test(parts[i])) {
              return parts.slice(1, i + 1).join('/');
            }
          }
          return n;
        })
        .filter((f: string, i: number, arr: string[]) => arr.indexOf(f) === i); // dedupe

      // Top nodes by degree (from cluster metadata)
      const entryPoints = (cluster.topNodes || []).slice(0, 5);

      partitions.push({
        label: cluster.label || `社区 ${partitions.length + 1}`,
        files,
        entryPoints,
        crossDeps: cluster.crossEdges || [],
      });
    }

    // Sort by file count desc
    partitions.sort((a, b) => b.files.length - a.files.length);
    return partitions.slice(0, maxPartitions);
  } catch {
    // Fallback: single partition
    return [{
      label: '全库',
      files: [scope],
      entryPoints: [],
      crossDeps: [],
    }];
  }
}

/** Parse community clusters from hologram_clusters output. */
function parseClusters(raw: string): Array<{
  label: string;
  nodes: string[];
  topNodes: string[];
  crossEdges: string[];
}> {
  try {
    // Try JSON first
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((c: any) => ({
        label: c.label || c.name || '',
        nodes: c.nodes || c.members || [],
        topNodes: c.topNodes || c.top_nodes || [],
        crossEdges: c.crossEdges || c.cross_edges || [],
      }));
    }
    if (parsed.clusters) {
      return parseClusters(JSON.stringify(parsed.clusters));
    }
  } catch {
    // Try to parse text format
    const clusters: ReturnType<typeof parseClusters> = [];
    const sections = raw.split(/(?:^|\n)(?:#|###)\s+/);
    for (const section of sections) {
      if (!section.trim()) continue;
      const lines = section.split('\n');
      const label = lines[0]?.trim() || '';
      const nodes: string[] = [];
      for (const line of lines.slice(1)) {
        const trimmed = line.replace(/^[-*\s]+/, '').trim();
        if (trimmed) nodes.push(trimmed);
      }
      if (nodes.length > 0) {
        clusters.push({ label, nodes, topNodes: nodes.slice(0, 5), crossEdges: [] });
      }
    }
    return clusters;
  }
  return [];
}

/** Generate agent_spawn prompts for each partition. */
export function buildPartitionPrompts(
  partitions: WorkPartition[],
  task: string,
): Array<{ description: string; prompt: string }> {
  return partitions.map((p, i) => {
    const fileList = p.files.length > 20
      ? p.files.slice(0, 20).join(', ') + ` …(+${p.files.length - 20})`
      : p.files.join(', ');

    const epSection = p.entryPoints.length > 0
      ? `\n关键入口点: ${p.entryPoints.join(', ')}`
      : '';

    const crossSection = p.crossDeps.length > 0
      ? `\n跨区依赖（需与其它分区协调的接口）: ${p.crossDeps.join(', ')}`
      : '';

    return {
      description: p.label,
      prompt: `## 任务: ${task}

## 分区 ${i + 1}/${partitions.length}: ${p.label}
文件范围: ${fileList}${epSection}${crossSection}

请仅分析此分区内的文件和符号。如需引用跨区接口，标记为 [跨区] 并说明依赖方向。`,
    };
  });
}
