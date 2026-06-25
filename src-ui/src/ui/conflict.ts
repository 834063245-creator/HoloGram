// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Conflict Panel — 多工作区冲突预演（P7）
// 双工作区 diff 叠加耦合分析，标记共同波及节点

import { invoke } from '../bridge';
import { shell } from './app-shell';
import { iconHtml } from './icons';
import { askAgent } from './agent-visualizer';
import type { StarGraph } from './graph';

interface ConflictNode {
  node_name: string;
  node_id: string;
  location: string;
  file: string;
  a_impact: { depth: number; upstream_count: number; downstream_count: number };
  b_impact: { depth: number; upstream_count: number; downstream_count: number };
  conflict_risk: 'high' | 'medium' | 'low';
}

interface ConflictData {
  workspace_a: { path: string; node_count: number; edge_count: number; file_count: number };
  workspace_b: { path: string; node_count: number; edge_count: number; file_count: number };
  overlapping_nodes: ConflictNode[];
  shared_files: string[];
  risk_summary: { high: number; medium: number; low: number };
  error?: string;
}

const PANEL_ID = 'conflict-panel';
const RISK_CLASS: Record<string, string> = { high: 'cf-risk-high', medium: 'cf-risk-mid', low: 'cf-risk-low' };
const RISK_LABEL: Record<string, string> = { high: '高冲突', medium: '中冲突', low: '低冲突' };

export class ConflictPanel {
  private panel!: HTMLElement;
  private content!: HTMLElement;
  private openState = false;
  private loading = false;
  private lastData: ConflictData | null = null;
  private starGraph: StarGraph | null = null;

  constructor(container: HTMLElement) {
    this.buildDOM(container);
  }

  setGraph(sg: StarGraph): void { this.starGraph = sg; }

  private buildDOM(container: HTMLElement): void {
    this.panel = document.createElement('div');
    this.panel.id = PANEL_ID;

    // Corner brackets
    const brackets = document.createElement('div');
    brackets.className = 'corner-brackets';
    brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
    this.panel.appendChild(brackets);

    // Header
    const header = document.createElement('div');
    header.className = 'cf-header';
    header.innerHTML = `<span>${iconHtml('link', 12)} 工作区冲突预演</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'cf-close-btn';
    closeBtn.innerHTML = iconHtml('close', 12);
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);
    this.panel.appendChild(header);

    // Content
    this.content = document.createElement('div');
    this.content.className = 'cf-content';
    this.panel.appendChild(this.content);

    container.appendChild(this.panel);
  }

  toggle(): void {
    this.openState ? this.close() : this.open();
  }

  open(): void {
    this.openState = true;
    this.panel.classList.add('cf-open');
    shell.notifyPanelChanged();
    if (!this.lastData) this.renderInput();
  }

  close(): void {
    this.openState = false;
    this.panel.classList.remove('cf-open');
    this.starGraph?.clearAgentHighlight();
    shell.notifyPanelChanged();
  }

  isOpen(): boolean { return this.openState; }

  private renderInput(): void {
    this.content.innerHTML = `
      <div class="cf-section">
        <div class="cf-label">工作区 A</div>
        <input type="text" id="cf-path-a" class="cf-input" placeholder="D:\projects\repo-a" />
      </div>
      <div class="cf-section">
        <div class="cf-label">工作区 B</div>
        <input type="text" id="cf-path-b" class="cf-input" placeholder="D:\projects\repo-b" />
      </div>
      <button id="cf-analyze-btn" class="cf-analyze-btn">${iconHtml('chart', 11)} 分析冲突</button>
      <div id="cf-error" class="cf-error"></div>
      <div id="cf-spinner" class="cf-spinner" style="display:none">分析中...</div>
    `;

    document.getElementById('cf-analyze-btn')?.addEventListener('click', () => this.analyze());
  }

  private async analyze(): Promise<void> {
    const pathA = (document.getElementById('cf-path-a') as HTMLInputElement)?.value.trim();
    const pathB = (document.getElementById('cf-path-b') as HTMLInputElement)?.value.trim();
    const errEl = document.getElementById('cf-error')!;
    const spinEl = document.getElementById('cf-spinner')!;

    if (!pathA || !pathB) {
      errEl.textContent = '请输入两个工作区路径';
      return;
    }

    this.loading = true;
    errEl.textContent = '';
    spinEl.style.display = 'block';

    try {
      const json = await invoke<string>('hologram_workspace_conflict', {
        pathA, pathB,
      });
      const data = JSON.parse(json) as ConflictData;
      if (data.error) {
        errEl.textContent = data.error;
        return;
      }
      this.lastData = data;
      this.renderResult(data);
    } catch (err: any) {
      errEl.textContent = `分析失败: ${err}`;
    } finally {
      this.loading = false;
      spinEl.style.display = 'none';
    }
  }

  private renderResult(data: ConflictData): void {
    const nodes = data.overlapping_nodes;
    const highCount = data.risk_summary.high || 0;
    const midCount = data.risk_summary.medium || 0;
    const lowCount = data.risk_summary.low || 0;

    let html = `
      <div class="cf-back-row">
        <button id="cf-back-btn" class="cf-back-btn">← 重新选择</button>
      </div>
      <div class="cf-summary">
        <div class="cf-summary-item cf-summary-shared">
          <span class="cf-summary-num">${data.shared_files.length}</span>
          <span class="cf-summary-label">共享文件</span>
        </div>
        <div class="cf-summary-item cf-summary-overlap">
          <span class="cf-summary-num">${nodes.length}</span>
          <span class="cf-summary-label">冲突节点</span>
        </div>
        ${highCount > 0 ? `<div class="cf-summary-item cf-summary-high"><span class="cf-summary-num">${highCount}</span><span class="cf-summary-label">高风险</span></div>` : ''}
        ${midCount > 0 ? `<div class="cf-summary-item cf-summary-mid"><span class="cf-summary-num">${midCount}</span><span class="cf-summary-label">中风险</span></div>` : ''}
        ${lowCount > 0 ? `<div class="cf-summary-item cf-summary-low"><span class="cf-summary-num">${lowCount}</span><span class="cf-summary-label">低风险</span></div>` : ''}
      </div>
    `;

    if (nodes.length === 0) {
      html += `<div class="cf-empty">未发现冲突节点。两个工作区没有共享文件的耦合重叠。</div>`;
    } else {
      html += `<div class="cf-node-list">`;
      for (const cn of nodes) {
        const riskClass = RISK_CLASS[cn.conflict_risk] || '';
        const riskLabel = RISK_LABEL[cn.conflict_risk] || cn.conflict_risk;
        const shortName = cn.node_name.split('.').pop() || cn.node_name;
        const shortFile = (cn.file || '').replace(/\\/g, '/').split('/').pop() || '';

        html += `<div class="cf-node ${riskClass}" data-node="${escapeHtml(cn.node_name)}" data-file="${escapeHtml(cn.file)}">`;
        html += `<div class="cf-node-header">`;
        html += `<span class="cf-node-risk ${riskClass}">${riskLabel}</span>`;
        html += `<span class="cf-node-name">${escapeHtml(shortName)}</span>`;
        html += `<span class="cf-node-file">${escapeHtml(shortFile)}</span>`;
        html += `</div>`;
        html += `<div class="cf-node-meta">`;
        html += `<span title="A 工作区出入度">A: ↓${cn.a_impact.downstream_count} ↑${cn.a_impact.upstream_count}</span>`;
        html += `<span title="B 工作区出入度">B: ↓${cn.b_impact.downstream_count} ↑${cn.b_impact.upstream_count}</span>`;
        html += `</div>`;
        html += `<button class="cf-ask-btn" title="问 Agent 关于这个冲突">${iconHtml('agent', 10)}</button>`;
        html += `</div>`;
      }
      html += `</div>`;
    }

    this.content.innerHTML = html;

    // Wire back button
    document.getElementById('cf-back-btn')?.addEventListener('click', () => {
      this.lastData = null;
      this.renderInput();
    });

    // Wire node clicks → navigate to star graph
    this.content.querySelectorAll('.cf-node').forEach(el => {
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.cf-ask-btn')) return;
        const nodeName = (el as HTMLElement).dataset['node'] || '';
        if (nodeName) shell.navigateToNode(nodeName);
      });
    });

    // Wire ask agent buttons
    this.content.querySelectorAll('.cf-ask-btn').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const nodeEl = (el as HTMLElement).closest('.cf-node') as HTMLElement;
        if (!nodeEl) return;
        const nodeName = nodeEl.dataset['node'] || '';
        const file = nodeEl.dataset['file'] || '';
        const cn = nodes.find(n => n.node_name === nodeName);
        if (!cn) return;
        const context = [
          `工作区冲突节点: ${cn.node_name}`,
          `风险等级: ${cn.conflict_risk}`,
          cn.file ? `文件: ${cn.file}` : '',
          `A 下游: ${cn.a_impact.downstream_count}, B 下游: ${cn.b_impact.downstream_count}`,
        ].filter(Boolean).join(' | ');
        askAgent(`分析这个工作区冲突: ${context}`);
      });
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
