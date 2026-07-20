// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent Visualizer — 订阅 EventBus，Agent 工具调用完成 → 星图可视化
// 不改 Agent 循环，不改 Python 引擎。纯胶水层。
//
// Step 2: 重构为类。订阅 'agent:tool-done' → 单入口更新图，
// 消除 main.ts / chat.ts 中的三重 visualizeAgentTool() 调用。

import { shell } from './app-shell';
import { bus } from './events';
import type { StarGraph } from './graph';

/**
 * Shared helper — send a question to the Agent (opens chat panel if closed).
 * Use this from any UI panel to let the user ask Agent about something.
 */
export function askAgent(question: string): void {
  shell.queryAgent(question);
}

export class AgentVisualizer {
  private graph: StarGraph;

  /** Set of node names the agent has ever touched (for lens mode). */
  private _visitedNodes = new Set<string>();

  /** Ordered trail of recently focused nodes (max 50, for trail line). */
  private _trail: string[] = [];

  /** Whether the retrospective trail visualization is currently active. */
  private _trailActive = false;

  constructor(graph: StarGraph) {
    this.graph = graph;
    bus.on('agent:tool-done', this._onToolDone.bind(this));
    bus.on('agent:tool-started', this._onToolStarted.bind(this));
  }

  /** Update the star graph reference (for mode switches that recreate the graph). */
  setGraph(graph: StarGraph): void {
    this.graph = graph;
  }

  /** Toggle retrospective trail mode — shows the Agent's exploration path as
   *  a glowing cyan trail through visited nodes, with unvisited nodes dimmed to
   *  30% (still visible as backdrop). Camera flies to the trail centroid. */
  toggleTrail(): boolean {
    if (this._trailActive) {
      this.hideTrail();
    } else {
      this.showTrail();
    }
    return this._trailActive;
  }

  /** Activate trail mode. */
  showTrail(): void {
    if (this._visitedNodes.size === 0) return;
    this._trailActive = true;
    this.graph.showAgentTrail(this._visitedNodes, this._trail);
  }

  /** Deactivate trail mode, restore normal rendering. */
  hideTrail(): void {
    this._trailActive = false;
    this.graph.hideAgentTrail();
  }

  get isTrailActive(): boolean {
    return this._trailActive;
  }
  get visitedCount(): number {
    return this._visitedNodes.size;
  }

  // Backward compat — old toggleLens/AgentLens APIs map to trail mode
  /** @deprecated Use toggleTrail() instead. */
  toggleLens(): boolean {
    return this.toggleTrail();
  }
  /** @deprecated Use isTrailActive instead. */
  get isLensActive(): boolean {
    return this._trailActive;
  }

  // ── Event handlers ────────────────────────────────────

  private _onToolStarted(_data: { toolName: string; args: Record<string, unknown> }): void {
    // Reserve for future "tool running" indicator on the graph
  }

  private _onToolDone(data: { toolName: string; args: Record<string, unknown>; output: string }): void {
    try {
      // Extract focused node names from tool args (for lens + trail)
      const focusedNodes = this._extractFocusedNodes(data.toolName, data.args);
      for (const name of focusedNodes) {
        this._visitedNodes.add(name);
        if (this._trail.length === 0 || this._trail[this._trail.length - 1] !== name) {
          this._trail.push(name);
          if (this._trail.length > 50) this._trail.shift();
        }
      }

      // If trail mode is active, update the visualization live
      if (this._trailActive && this._visitedNodes.size > 0) {
        this.graph.showAgentTrail(this._visitedNodes, this._trail);
      }

      if (focusedNodes.length > 0) {
        bus.emit('agent:focus-changed', {
          nodeNames: focusedNodes,
          toolName: data.toolName,
          visitedCount: this._visitedNodes.size,
        });
      }
    } catch {
      // Visualization failure must never break chat or agent
    }
  }

  // ── Focus extraction ──

  /** Extract node names the agent is explicitly focusing on in this tool call. */
  private _extractFocusedNodes(toolName: string, args: Record<string, unknown>): string[] {
    const names: string[] = [];
    const n = (key: string) => {
      const v = String(args[key] || '');
      if (v) names.push(v);
    };
    switch (toolName) {
      case 'find_dep_path':
        n('from');
        n('to');
        break;
      case 'trace_impact':
      case 'get_neighbors':
      case 'symbol_history':
      case 'inspect_symbol':
        n('node_id');
        n('nodeId');
        break;
      case 'coupling_report':
        n('module');
        break;
    }
    return names;
  }
}
