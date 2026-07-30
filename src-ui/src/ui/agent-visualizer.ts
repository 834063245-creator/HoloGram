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
 * 共享辅助函数 — 向 Agent 发送问题（若聊天面板未打开则自动打开）。
 * 任何 UI 面板均可调用此函数，让用户向 Agent 提问。
 */
export function askAgent(question: string): void {
  shell.queryAgent(question);
}

export class AgentVisualizer {
  private graph: StarGraph;

  /** Agent 曾经访问过的节点名称集合（用于透镜模式）。 */
  private _visitedNodes = new Set<string>();

  /** 最近聚焦节点的有序轨迹（最多 50 个，用于轨迹线）。 */
  private _trail: string[] = [];

  /** 回溯轨迹可视化当前是否处于激活状态。 */
  private _trailActive = false;

  constructor(graph: StarGraph) {
    this.graph = graph;
    bus.on('agent:tool-done', this._onToolDone.bind(this));
  }

  /** 更新星图引用（用于重建图的场景模式切换）。 */
  setGraph(graph: StarGraph): void {
    this.graph = graph;
  }

  /** 切换回溯轨迹模式 — 以青色发光轨迹线展示 Agent 的探索路径，
   *  未访问节点亮度降至 30%（仍可见作为背景）。相机飞向轨迹质心。 */
  toggleTrail(): boolean {
    if (this._trailActive) {
      this.hideTrail();
    } else {
      this.showTrail();
    }
    return this._trailActive;
  }

  /** 激活轨迹模式。 */
  showTrail(): void {
    if (this._visitedNodes.size === 0) return;
    this._trailActive = true;
    this.graph.showAgentTrail(this._visitedNodes, this._trail);
  }

  /** 停用轨迹模式，恢复正常渲染。 */
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

  // 向后兼容 — 旧的 toggleLens/AgentLens API 映射到轨迹模式
  /** @deprecated 请改用 toggleTrail()。 */
  toggleLens(): boolean {
    return this.toggleTrail();
  }
  /** @deprecated 请改用 isTrailActive。 */
  get isLensActive(): boolean {
    return this._trailActive;
  }

  // ── 事件处理 ────────────────────────────────────

  private _onToolDone(data: { toolName: string; args: Record<string, unknown>; output: string }): void {
    try {
      // 从工具参数中提取聚焦的节点名称（用于透镜 + 轨迹）
      const focusedNodes = this._extractFocusedNodes(data.toolName, data.args);
      for (const name of focusedNodes) {
        this._visitedNodes.add(name);
        if (this._trail.length === 0 || this._trail[this._trail.length - 1] !== name) {
          this._trail.push(name);
          if (this._trail.length > 50) this._trail.shift();
        }
      }

      // 若轨迹模式已激活，实时更新可视化
      if (this._trailActive && this._visitedNodes.size > 0) {
        this.graph.showAgentTrail(this._visitedNodes, this._trail);
      }
    } catch {
      // 可视化失败不得中断聊天或 Agent
    }
  }

  // ── 聚焦提取 ──

  /** 提取 Agent 在本次工具调用中明确聚焦的节点名称。 */
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
