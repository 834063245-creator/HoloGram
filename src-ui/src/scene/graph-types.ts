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
  /** 引擎序列化节点携带的 level-0 社区 id。 */
  community_id?: number | string;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  properties?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** 引擎序列化边携带的耦合深度。 */
  coupling_depth?: number;
  /** 引擎序列化边携带的方向。 */
  direction?: string;
}
export interface GraphJSON {
  nodes: GraphNode[] | Record<string, GraphNode>;
  edges: GraphEdge[] | Record<string, GraphEdge>;
  meta?: Record<string, unknown>;
  /** 扁平社区 — 引擎序列化图携带。 */
  communities?: CommunityData[];
  /** 层级社区 — 引擎序列化图携带。 */
  hierarchical_communities?: CommunityData[];
}

export interface EdgeData {
  s: number;
  t: number;
  couplingDepth: number;
  edgeType: string;
  direction: string;
  crossFile: boolean;
  /** Resolver couldn't uniquely identify target — heuristic match, may need manual review. */
  ambiguous: boolean;
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
