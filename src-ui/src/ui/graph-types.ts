// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ── 星图共享类型（P4 拆解：graph.ts 与各渲染模块的公共契约）──

export interface GraphNode {
  id: string;
  name: string;
  type?: string;
  kind?: string;
  location?: string;
  properties?: Record<string, unknown>;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  properties?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
export interface GraphJSON {
  nodes: GraphNode[] | Record<string, GraphNode>;
  edges: GraphEdge[] | Record<string, GraphEdge>;
  meta?: Record<string, unknown>;
}

export interface EdgeData {
  s: number;
  t: number;
  couplingDepth: number;
  edgeType: string;
  direction: string;
  crossFile: boolean;
}
export interface CommunityData {
  id: string;
  label: string;
  node_ids: string[];
  level?: number;
  parent_id?: string | null;
}

// ponytail: diff payload from watcher — added/removed/changed nodes and edges
export interface GraphDiffJson {
  added_nodes: GraphNode[];
  removed_nodes: Array<{ id: string; name: string; type?: string }>;
  modified_nodes: Array<{ node_id: string; name: string; old_kind: string; new_kind: string }>;
  added_edges: GraphEdge[];
  removed_edges: Array<{ id: string; source: string; target: string }>;
}
