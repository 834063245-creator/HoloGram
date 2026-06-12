// Agent Lens — 透镜模式控制器 (Step 2)
// 订阅 'agent:focus-changed'，追踪 Agent 碰过的节点。
// 开启透镜后：只有访问过的节点保持高亮，其余降到 1% 透明度。
// 轨迹线由 AgentVisualizer 直接驱动 graph.updateAgentTrail()。

import type { StarGraph } from './graph';
import { bus } from './events';
import { dbg } from './debug';

export class AgentLens {
  private graph: StarGraph;

  /** All node names the agent has ever focused on (accumulated across turns). */
  private _visitedNodes = new Set<string>();

  /** Whether the lens overlay is currently active. */
  private _active = false;

  constructor(graph: StarGraph) {
    this.graph = graph;
    bus.on('agent:focus-changed', this._onFocusChanged.bind(this));
  }

  /** Update the star graph reference (for mode switches). */
  setGraph(graph: StarGraph): void {
    this.graph = graph;
    // Re-apply lens if active on new graph instance
    if (this._active && this._visitedNodes.size > 0) {
      this.graph.setAgentLens(this._visitedNodes);
    }
  }

  /** Toggle lens mode on/off. Returns new state. */
  toggle(): boolean {
    this._active = !this._active;
    if (this._active) {
      if (this._visitedNodes.size > 0) {
        this.graph.setAgentLens(this._visitedNodes);
        dbg('agent-lens', `ON — ${this._visitedNodes.size} visited nodes`);
      } else {
        dbg('agent-lens', 'ON — no visited nodes yet');
      }
    } else {
      this.graph.clearAgentLens();
      dbg('agent-lens', 'OFF');
    }
    return this._active;
  }

  get isActive(): boolean { return this._active; }
  get visitedCount(): number { return this._visitedNodes.size; }

  // ── Event handler ──────────────────────────────────────

  private _onFocusChanged(data: { nodeNames: string[]; toolName: string }): void {
    let added = 0;
    for (const name of data.nodeNames) {
      if (!this._visitedNodes.has(name)) {
        this._visitedNodes.add(name);
        added++;
      }
    }
    if (added > 0) {
      dbg('agent-lens', `+${added} nodes from "${data.toolName}" (total: ${this._visitedNodes.size})`);
      // Re-apply lens if active to include new nodes
      if (this._active) {
        this.graph.setAgentLens(this._visitedNodes);
      }
    }
  }
}
