// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent Visualizer — 订阅 EventBus，Agent 工具调用完成 → 星图可视化
// 不改 Agent 循环，不改 Python 引擎。纯胶水层。
//
// Step 2: 重构为类。订阅 'agent:tool-done' → 单入口更新图，
// 消除 main.ts / chat.ts 中的三重 visualizeAgentTool() 调用。

import type { StarGraph } from './graph';
import { bus } from './events';
import { shell } from './app-shell';
import { dbg } from './debug';

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

  /** Ordered trail of recently focused nodes (max 20, for trail line). */
  private _trail: string[] = [];

  /** Whether the agent lens overlay is currently active. */
  private _lensActive = false;

  constructor(graph: StarGraph) {
    this.graph = graph;
    bus.on('agent:tool-done', this._onToolDone.bind(this));
    bus.on('agent:tool-started', this._onToolStarted.bind(this));
  }

  /** Update the star graph reference (for mode switches that recreate the graph). */
  setGraph(graph: StarGraph): void {
    this.graph = graph;
  }

  /** Toggle agent lens mode — only visited nodes remain bright, others dim to 1%. */
  toggleLens(): boolean {
    this._lensActive = !this._lensActive;
    if (this._lensActive) {
      this.graph.setAgentLens(this._visitedNodes);
    } else {
      this.graph.clearAgentLens();
    }
    return this._lensActive;
  }

  get isLensActive(): boolean { return this._lensActive; }
  get visitedCount(): number { return this._visitedNodes.size; }

  // ── Event handlers ────────────────────────────────────

  private _onToolStarted(_data: { toolName: string; args: Record<string, unknown> }): void {
    // Reserve for future "tool running" indicator on the graph
  }

  private _onToolDone(data: { toolName: string; args: Record<string, unknown>; output: string }): void {
    try {
      dbg('agent-viz', `tool="${data.toolName}"`);

      // Extract focused node names from tool args (for lens + trail)
      const focusedNodes = this._extractFocusedNodes(data.toolName, data.args);
      for (const name of focusedNodes) {
        this._visitedNodes.add(name);
        // Deduplicate consecutive same-node trail entries
        if (this._trail.length === 0 || this._trail[this._trail.length - 1] !== name) {
          this._trail.push(name);
          if (this._trail.length > 20) this._trail.shift();
        }
      }

      // ── Visual effects ──
      switch (data.toolName) {
        case 'hologram_path':
          this._handlePath(data.args);
          break;
        case 'hologram_impact':
          this._handleImpact(data.args);
          break;
        case 'hologram_neighbors':
          this._handleNeighbors(data.args);
          break;
        case 'hologram_coupling_report':
          this._handleCouplingReport(data.args);
          break;
        case 'hologram_fragile':
          this._handleFragile(data.output);
          break;
        case 'hologram_cycle':
          this._handleCycle(data.output);
          break;
        case 'hologram_diff':
          this._handleDiff(data.output);
          break;
        case 'hologram_blindspots':
          this._handleBlindspots(data.output);
          break;
        case 'hologram_run_check':
          this._handleRunCheck(data.output);
          break;
        case 'hologram_history':
          this._handleHistory(data.args);
          break;
        case 'hologram_community':
          this._handleCommunity(data.output);
          break;
        case 'hologram_delayed':
          this._handleDelayed(data.output);
          break;
        case 'hologram_changes':
          this._handleChanges(data.output);
          break;
      }

      // ── Update trail line ──
      if (this._trail.length >= 2) {
        this.graph.updateAgentTrail(this._trail);
      }

      // ── Update lens if active ──
      if (this._lensActive && this._visitedNodes.size > 0) {
        this.graph.setAgentLens(this._visitedNodes);
      }

      // ── Notify other components of focus change ──
      if (focusedNodes.length > 0) {
        bus.emit('agent:focus-changed', {
          nodeNames: focusedNodes,
          toolName: data.toolName,
        });
      }
    } catch {
      // Visualization failure must never break chat or agent
    }
  }

  /** Extract node names the agent is explicitly focusing on in this tool call. */
  private _extractFocusedNodes(toolName: string, args: Record<string, unknown>): string[] {
    const names: string[] = [];
    const n = (key: string) => {
      const v = String(args[key] || '');
      if (v) names.push(v);
    };
    switch (toolName) {
      case 'hologram_path':
        n('from'); n('to');
        break;
      case 'hologram_impact':
      case 'hologram_neighbors':
      case 'hologram_history':
        n('node_id'); n('nodeId');
        break;
      case 'hologram_coupling_report':
        n('module');
        break;
    }
    return names;
  }

  // ── Individual visual-effect handlers ─────────────────

  private _handlePath(args: Record<string, unknown>): void {
    const from = String(args['from'] || args['from_node'] || '');
    const to = String(args['to'] || args['to_node'] || '');
    if (!from || !to) return;
    this.graph.showPathOnGraph(from, to);
  }

  private _handleImpact(args: Record<string, unknown>): void {
    const node = String(args['node_id'] || args['nodeId'] || '');
    dbg('agent-viz.impact', `node="${node}"`);
    if (!node) return;
    this.graph.focusNode(node);
  }

  private _handleNeighbors(args: Record<string, unknown>): void {
    const node = String(args['node_id'] || args['nodeId'] || '');
    dbg('agent-viz.neighbors', `node="${node}"`);
    if (!node) return;
    this.graph.focusNode(node);
  }

  private _handleCouplingReport(args: Record<string, unknown>): void {
    const module = String(args['module'] || args['module_name'] || args['moduleName'] || '');
    dbg('agent-viz.coupling', `module="${module}"`);
    if (!module) return;
    this.graph.focusNode(module);
  }

  private _handleFragile(resultText: string): void {
    const names = parseFragileOutput(resultText);
    if (names.length > 0) {
      this.graph.highlightNodeNames(names, '#f0b848');
    }
  }

  private _handleCycle(resultText: string): void {
    const names = parseCycleOutput(resultText);
    if (names.length > 0) {
      this.graph.highlightNodeNames(names, '#d94444');
    }
  }

  private _handleDiff(resultText: string): void {
    let diffData: any;
    try { diffData = JSON.parse(resultText); } catch { return; }
    if (diffData && !diffData.is_empty) {
      this.graph.showDiff(diffData);
    }
  }

  private _handleBlindspots(resultText: string): void {
    let data: any;
    try { data = JSON.parse(resultText); } catch { return; }
    const names: string[] = [];
    const items = Array.isArray(data) ? data : (data?.blindspots || data?.results || []);
    for (const item of items) {
      const name = item?.node_name || item?.name || item?.module || '';
      if (name) names.push(String(name));
    }
    if (names.length > 0) {
      this.graph.highlightNodeNames(names, '#f0b848');
    }
  }

  private _handleRunCheck(resultText: string): void {
    let data: any;
    try { data = JSON.parse(resultText); } catch { return; }
    const signals = data?.signals || [];
    const names: string[] = [];
    for (const sig of signals) {
      const nodeNames = sig?.affected_nodes || [];
      names.push(...nodeNames.map(String));
    }
    if (names.length > 0) {
      this.graph.highlightNodeNames(names, '#d94444');
    }
  }

  private _handleHistory(args: Record<string, unknown>): void {
    const node = String(args['node_id'] || args['nodeId'] || '');
    dbg('agent-viz.history', `node="${node}"`);
    if (!node) return;
    this.graph.focusNode(node);
  }

  private _handleCommunity(resultText: string): void {
    let data: any;
    try { data = JSON.parse(resultText); } catch { return; }
    const names: string[] = [];
    const siblings = data?.sibling_nodes || [];
    for (const sid of siblings) names.push(String(sid));
    if (data?.node_id) names.push(String(data.node_id));
    if (names.length > 0) {
      this.graph.highlightNodeNames(names, '#a088e0');
    }
  }

  private _handleDelayed(resultText: string): void {
    let data: any;
    try { data = JSON.parse(resultText); } catch { return; }
    const names = new Set<string>();
    for (const d of (data?.realtime || [])) {
      if (d.source?.name) names.add(String(d.source.name));
      if (d.target?.name) names.add(String(d.target.name));
    }
    for (const d of (data?.periodic || [])) {
      if (d.source?.name) names.add(String(d.source.name));
      if (d.target?.name) names.add(String(d.target.name));
    }
    if (names.size > 0) {
      this.graph.highlightNodeNames(Array.from(names), '#f0b848');
    }
  }

  private _handleChanges(resultText: string): void {
    let data: any;
    try { data = JSON.parse(resultText); } catch { return; }
    const nodes = data?.last_change?.affected_nodes || [];
    const names = nodes.map(String);
    if (names.length > 0) {
      this.graph.highlightNodeNames(names, '#d94444');
    }
  }
}

// ═══════════════════════════════════════════════════════
// Text parsers (shared helpers, unchanged from Step 1)
// ═══════════════════════════════════════════════════════

/**
 * Parse hologram_fragile tabular output.
 * Format:
 *   Top N Most Fragile Modules:
 *     Module                    L4   L3   L2   L1   Score
 *     -----------------------  ---  ---  ---  ---  ------
 *     my.module.name             5    3    2    1   0.850
 */
function parseFragileOutput(text: string): string[] {
  const names: string[] = [];
  const lines = text.split('\n');
  let inTable = false;
  for (const line of lines) {
    if (line.includes('---') && line.includes('--')) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    const m = line.match(/^\s{2}(\S+)\s+\d+/);
    if (m && m[1]) {
      names.push(m[1]);
    }
  }
  return names;
}

/**
 * Parse hologram_cycle output.
 * Format:
 *   [category] 环长 N 跳: A → B → C
 */
function parseCycleOutput(text: string): string[] {
  const names = new Set<string>();
  const arrowLines = text.match(/→.+→/g);
  if (arrowLines) {
    for (const line of arrowLines) {
      const parts = line.split('→').map(s => s.trim());
      for (const p of parts) {
        if (p && p.length < 120 && !p.startsWith('[')) {
          names.add(p);
        }
      }
    }
  }
  return Array.from(names);
}
