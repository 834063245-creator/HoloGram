// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 多 Agent 通信层 — 拓扑策略实现
//
// 拓扑策略决定哪些 agent 之间可以通信。
// 通信层本身拓扑无关，策略由上层注入。

import type { AgentAddress, TopologyPolicy } from './message-types';

// ── 树形拓扑：只有 parent↔child 能通信 ──

export class TreeTopology implements TopologyPolicy {
  canSend(from: string, to: string, bus: { getAgent: (id: string) => AgentAddress | undefined }): boolean {
    if (from === to) return false;
    const fromAddr = bus.getAgent(from);
    const toAddr = bus.getAgent(to);
    if (!fromAddr || !toAddr) return false;

    // parent → child：from 是 to 的父
    if (toAddr.parentId === from) return true;
    // child → parent：to 是 from 的父
    if (fromAddr.parentId === to) return true;

    return false;
  }

  allowedTargets(agentId: string, bus: { listAgents: () => AgentAddress[] }): string[] {
    const me = bus.listAgents().find((a) => a.agentId === agentId);
    if (!me) return [];

    const targets: string[] = [];
    for (const a of bus.listAgents()) {
      if (a.agentId === agentId) continue;
      // 我的子 agent
      if (a.parentId === agentId) targets.push(a.agentId);
      // 我的父 agent
      if (me.parentId && a.agentId === me.parentId) targets.push(a.agentId);
    }
    return targets;
  }
}

// ── 星形拓扑：只有 center↔spoke 能通信 ──

export class StarTopology implements TopologyPolicy {
  constructor(private centerId: string) {}

  canSend(from: string, to: string, _bus: { getAgent: (id: string) => AgentAddress | undefined }): boolean {
    if (from === to) return false;
    // center 可以发给任何人；任何人可以发给 center
    return from === this.centerId || to === this.centerId;
  }

  allowedTargets(agentId: string, bus: { listAgents: () => AgentAddress[] }): string[] {
    if (agentId === this.centerId) {
      return bus
        .listAgents()
        .filter((a) => a.agentId !== agentId)
        .map((a) => a.agentId);
    }
    // spoke 只能发给 center
    return bus.listAgents().some((a) => a.agentId === this.centerId) ? [this.centerId] : [];
  }
}

// ── 网状拓扑：任意两个 agent 都能通信 ──

export class MeshTopology implements TopologyPolicy {
  canSend(from: string, to: string, _bus: { getAgent: (id: string) => AgentAddress | undefined }): boolean {
    return from !== to;
  }

  allowedTargets(agentId: string, bus: { listAgents: () => AgentAddress[] }): string[] {
    return bus
      .listAgents()
      .filter((a) => a.agentId !== agentId)
      .map((a) => a.agentId);
  }
}
