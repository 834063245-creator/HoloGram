// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// GraphTooltip — 工具提示 / 详情卡片 / 框选 / 浮动提问栏
// 从 graph.ts StarGraph 类中提取 DOM 交互相关方法
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { shell } from './app-shell';
import { bus } from './events';
import { TYPE_LABELS } from './graph-colors';
import { iconHtml } from './icons';

// ── Host interface — StarGraph 需要暴露给 TooltipHost 的成员 ──

interface GraphNode {
  id: string;
  name: string;
  type?: string;
  kind?: string;
  location?: string;
  properties?: Record<string, unknown>;
}
interface EdgeData {
  s: number;
  t: number;
  couplingDepth: number;
  edgeType: string;
  direction: string;
  crossFile: boolean;
}

export interface TooltipHost {
  // 数据
  graphNodes: GraphNode[];
  nodePositions: Float32Array;
  edgeDataList: EdgeData[];
  deg: number[];
  _nodeCount: number;
  _analysis: { blastMode: boolean; startBlastMode(idx: number): void };
  _lensActive: boolean;

  // 场景
  container: HTMLElement;
  camera: THREE.PerspectiveCamera;

  // 详情卡按钮回调需要访问的方法
  enterFocusSubgraph(idx: number): void;
  clearAgentHighlight(): void;
  highlightNodeNames(names: string[], colorHex?: string): void;
}

// ═══════════════════════════════════════════════════════════════
// GraphTooltip
// ═══════════════════════════════════════════════════════════════

export class GraphTooltip {
  tooltipEl!: HTMLDivElement;
  detailCard!: HTMLDivElement;
  selectedIdx = -1;

  // ── Prompt bar ──
  _promptBarEl!: HTMLDivElement;
  _promptTitleEl!: HTMLSpanElement;
  _promptBtnEl!: HTMLButtonElement;
  _promptQuestion = '';
  _promptTimer: ReturnType<typeof setTimeout> | null = null;
  _showPromptBound: ((data: { title: string; question: string }) => void) | null = null;

  private _tmpVec3 = new THREE.Vector3();
  private host: TooltipHost;

  constructor(host: TooltipHost) {
    this.host = host;
  }

  // ── Tooltip ──────────────────────────────────────────────

  setupTooltip(): void {
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.id = 'graph-tooltip';
    this.tooltipEl.innerHTML = '<div class="tt-name"></div><div class="tt-meta"></div><div class="tt-loc"></div>';
    this.host.container.appendChild(this.tooltipEl);
  }

  updateTooltip(
    hoveredIdx: number,
    hoveredGalaxyIdx: number,
    communities: any[],
    nodeCommMap: Map<number, string>,
    foldMode: boolean,
    _fold: { galaxyMeta: any[]; enteredGalaxyId: string | null; galaxyGlows: any[] },
    container: HTMLElement,
    camera: THREE.Camera,
    _nodeCount: number,
    graphNodes: GraphNode[],
    deg: number[],
    nodePositions: Float32Array,
  ): void {
    // Galaxy hover takes priority
    if (foldMode && hoveredGalaxyIdx >= 0) return;
    if (hoveredIdx < 0 || hoveredIdx >= _nodeCount) {
      this.tooltipEl.classList.remove('visible');
      return;
    }
    const node = graphNodes[hoveredIdx];
    const kind = ((node.type || node.kind || 'symbol') as string).toLowerCase();
    this.tooltipEl.querySelector('.tt-name')!.textContent = node.name;
    const metaEl = this.tooltipEl.querySelector('.tt-meta')!;
    let metaText = `${TYPE_LABELS[kind] || kind.toUpperCase()} · 度 ${deg[hoveredIdx]}`;
    const cid = nodeCommMap.get(hoveredIdx);
    if (cid) {
      const comm = communities.find((c) => c.id === cid);
      const commLabel = comm ? comm.label.split('/')[0].replace(/_/g, ' ') : cid;
      metaText += ` · 🌌 ${commLabel}`;
    }
    metaEl.textContent = metaText;
    (metaEl as HTMLElement).dataset.kind = kind;
    this.tooltipEl.querySelector('.tt-loc')!.textContent = node.location || '';
    const i = hoveredIdx;
    this._tmpVec3.set(nodePositions[i * 3], nodePositions[i * 3 + 1], nodePositions[i * 3 + 2]);
    this._tmpVec3.project(camera);
    if (this._tmpVec3.z > 1) {
      this.tooltipEl.classList.remove('visible');
      return;
    }
    const x = (this._tmpVec3.x * 0.5 + 0.5) * container.clientWidth;
    const y = (-this._tmpVec3.y * 0.5 + 0.5) * container.clientHeight;
    this.tooltipEl.style.left = `${x + 18}px`;
    this.tooltipEl.style.top = `${y - 10}px`;
    this.tooltipEl.classList.add('visible');
  }

  // ── Detail Card ──────────────────────────────────────────

  setupDetailCard(): void {
    this.detailCard = document.createElement('div');
    this.detailCard.id = 'detail-card';
    this.detailCard.innerHTML =
      '<div class="dc-header">' +
      '<div class="dc-name"></div>' +
      `<button class="dc-close">${iconHtml('close', 14)}</button>` +
      '</div>' +
      '<div class="dc-meta"><span class="dc-kind"></span><span class="dc-degree"></span></div>' +
      '<div class="dc-location"></div>' +
      '<div class="dc-divider"></div>' +
      '<div class="dc-section-title">耦合层级</div>' +
      '<div class="dc-coupling"></div>' +
      '<div class="dc-divider"></div>' +
      '<div class="dc-actions">' +
      `<button class="dc-open-btn">${iconHtml('file', 11)} 打开</button>` +
      `<button class="dc-agent-btn">${iconHtml('agent', 11)} 问 Agent</button>` +
      `<button class="dc-blast-btn">${iconHtml('blast', 11)} 波及</button>` +
      `<button class="dc-focus-btn">${iconHtml('focus', 11)} 聚焦</button>` +
      '</div>' +
      '<div class="dc-blast-filters">' +
      '<div class="dc-filter-label">边类型过滤</div>' +
      '<div class="dc-filter-btns">' +
      '<button class="dc-filter-btn active" data-type="all">全部</button>' +
      '<button class="dc-filter-btn" data-type="structural">结构</button>' +
      '<button class="dc-filter-btn" data-type="data">数据</button>' +
      '<button class="dc-filter-btn" data-type="temporal">时间</button>' +
      '</div>' +
      '<div class="dc-filter-label">方向过滤</div>' +
      '<div class="dc-filter-btns">' +
      '<button class="dc-filter-btn active" data-dir="both">双向</button>' +
      '<button class="dc-filter-btn" data-dir="outbound">出向</button>' +
      '<button class="dc-filter-btn" data-dir="inbound">入向</button>' +
      '</div>' +
      '</div>';
    this.host.container.appendChild(this.detailCard);

    // Close
    this.detailCard.querySelector('.dc-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hideDetail();
    });
    // Focus subgraph
    this.detailCard.querySelector('.dc-focus-btn')?.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (this.selectedIdx >= 0) {
        const idx = this.selectedIdx;
        this.hideDetail();
        this.host.enterFocusSubgraph(idx);
      }
    });
    // Blast radius
    this.detailCard.querySelector('.dc-blast-btn')?.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (this.selectedIdx >= 0) this.host._analysis.startBlastMode(this.selectedIdx);
    });
    this.detailCard.querySelector('.dc-blast-btn')?.addEventListener('contextmenu', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const panel = this.detailCard.querySelector('.dc-blast-filters') as HTMLElement;
      if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    // Open file
    this.detailCard.querySelector('.dc-open-btn')?.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (this.selectedIdx >= 0) {
        const node = this.host.graphNodes[this.selectedIdx];
        if (node.location) {
          const loc = node.location;
          const lastColon = loc.lastIndexOf(':');
          const filePath = lastColon > 1 ? loc.substring(0, lastColon) : loc;
          const lineStr = lastColon > 1 ? loc.substring(lastColon + 1) : '';
          const line = parseInt(lineStr, 10);
          shell.navigateToFile(filePath, Number.isNaN(line) ? undefined : line);
        }
      }
    });
    // Ask Agent
    this.detailCard.querySelector('.dc-agent-btn')?.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (this.selectedIdx >= 0) {
        const node = this.host.graphNodes[this.selectedIdx];
        const kind = ((node.type || node.kind || 'symbol') as string).toLowerCase();
        const question = `分析节点 "${node.name}" (${TYPE_LABELS[kind] || kind}, 度=${this.host.deg[this.selectedIdx]}, ${node.location || '未知位置'})。它和其他模块的关系如何？改它会有什么影响？`;
        shell.queryAgent(question);
      }
    });
  }

  showDetail(
    idx: number,
    edgeDataList: EdgeData[],
    deg: number[],
    nodePositions: Float32Array,
    container: HTMLElement,
    camera: THREE.Camera,
    graphNodes: GraphNode[],
  ): void {
    this.selectedIdx = idx;
    const node = graphNodes[idx];
    // Emit file path for file tree <-> graph linking
    if (node.location) {
      const _filePath =
        node.location.indexOf(':') >= 0 ? node.location.substring(0, node.location.lastIndexOf(':')) : node.location;
    }
    const kind = ((node.type || node.kind || 'symbol') as string).toLowerCase();
    const dist = [0, 0, 0, 0, 0];
    for (const e of edgeDataList) {
      if (e.s === idx || e.t === idx) dist[e.couplingDepth] = (dist[e.couplingDepth] || 0) + 1;
    }
    const maxDist = Math.max(...dist, 1);

    this.detailCard.querySelector('.dc-name')!.textContent = node.name;

    const kindColors: Record<string, string> = {
      symbol: 'var(--obs-blue)',
      function: 'var(--obs-blue)',
      method: 'var(--obs-blue)',
      class: 'var(--obs-blue)',
      module: 'var(--obs-blue)',
      variable: 'var(--obs-blue)',
      interface: 'var(--obs-blue)',
      constant: 'var(--obs-blue)',
      medium: 'var(--obs-brass)',
      file: 'var(--obs-brass)',
      database: 'var(--obs-brass)',
      cache: 'var(--obs-brass)',
      queue: 'var(--obs-brass)',
      temporal: '#a088e0',
      thread: '#a088e0',
      timer: '#a088e0',
      trigger: '#a088e0',
    };
    const kindEl = this.detailCard.querySelector('.dc-kind') as HTMLElement;
    kindEl.textContent = TYPE_LABELS[kind] || kind.toUpperCase();
    kindEl.style.color = kindColors[kind] || 'var(--obs-blue)';
    const degEl = this.detailCard.querySelector('.dc-degree') as HTMLElement;
    degEl.textContent = `度 ${deg[idx]}${deg[idx] >= 10 ? ' · Hub 节点' : ''}`;

    this.detailCard.querySelector('.dc-location')!.textContent = node.location || '';

    const bars = [
      { label: 'L1 公开API', v: dist[1], cls: 'l1' },
      { label: 'L2 内部导入', v: dist[2], cls: 'l2' },
      { label: 'L3 共享数据', v: dist[3], cls: 'l3' },
      { label: 'L4 封装穿透', v: dist[4], cls: 'l4' },
    ];
    this.detailCard.querySelector('.dc-coupling')!.innerHTML = bars
      .map((b) => {
        const pct = Math.round((b.v / maxDist) * 100);
        const zero = b.v === 0 ? ' dc-zero' : '';
        const warn =
          b.v > 0 && (b.cls === 'l3' || b.cls === 'l4')
            ? ` <span class="dc-bar-warn">${iconHtml(b.cls === 'l3' ? 'alert' : 'block', 10)}</span>`
            : '';
        return `<div class="dc-bar-row${zero}"><span class="dc-bar-label">${b.label}</span><span class="dc-bar-count">${b.v}</span><span class="dc-bar-track"><span class="dc-bar-fill ${b.cls}" style="width:${pct}%"></span></span>${warn}</div>`;
      })
      .join('');

    const openBtn = this.detailCard.querySelector('.dc-open-btn') as HTMLButtonElement;
    if (openBtn) openBtn.style.display = node.location ? '' : 'none';

    this.positionDetailCard(idx, nodePositions, container, camera);
    this.detailCard.classList.add('visible');
  }

  hideDetail(): void {
    this.selectedIdx = -1;
    this.detailCard.classList.remove('visible');
  }

  positionDetailCard(idx: number, nodePositions: Float32Array, container: HTMLElement, camera: THREE.Camera): void {
    this._tmpVec3.set(nodePositions[idx * 3], nodePositions[idx * 3 + 1], nodePositions[idx * 3 + 2]);
    this._tmpVec3.project(camera);
    const x = (this._tmpVec3.x * 0.5 + 0.5) * container.clientWidth;
    const y = (-this._tmpVec3.y * 0.5 + 0.5) * container.clientHeight;
    let left = x + 24,
      top = y - 60;
    if (left + 290 > container.clientWidth - 10) left = x - 310;
    if (top < 10) top = 10;
    if (top + 300 > container.clientHeight - 10) top = container.clientHeight - 310;
    if (left < 10) left = 10;
    this.detailCard.style.left = `${left}px`;
    this.detailCard.style.top = `${top}px`;
  }

  // ── Prompt bar ───────────────────────────────────────────

  setupPromptBar(): void {
    this._promptBarEl = document.createElement('div');
    this._promptBarEl.id = 'graph-prompt-bar';
    this._promptBarEl.style.cssText =
      'position:absolute;z-index:19;top:12px;left:50%;transform:translateX(-50%);' +
      'display:none;align-items:center;gap:10px;padding:8px 14px;' +
      'background:var(--obs-glass-hi,rgba(4,12,28,0.94));' +
      'backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);' +
      'border:1px solid var(--obs-line);' +
      'border-radius:9px;' +
      'box-shadow:0 24px 80px rgba(0,0,0,0.45);' +
      'font-family:var(--obs-font-mono);font-size: calc(10px * var(--font-scale));color:var(--obs-text,#c3daf8);white-space:nowrap;' +
      'opacity:0;transition:opacity 0.16s;';
    this._promptTitleEl = document.createElement('span');
    this._promptTitleEl.style.cssText = 'max-width:420px;overflow:hidden;text-overflow:ellipsis;';
    this._promptBarEl.appendChild(this._promptTitleEl);
    this._promptBtnEl = document.createElement('button');
    this._promptBtnEl.textContent = 'Ask Agent';
    this._promptBtnEl.style.cssText =
      'font-family:var(--obs-font-mono);font-size: calc(8px * var(--font-scale));font-weight:600;' +
      'letter-spacing:0.5px;text-transform:uppercase;' +
      'padding:3px 8px;border-radius:2px;cursor:pointer;' +
      'transition:all var(--obs-snap);' +
      'border:1px solid rgba(140,100,200,0.25);' +
      'background:rgba(12,22,36,0.6);color:#a088e0;';
    this._promptBtnEl.addEventListener('mouseenter', () => {
      this._promptBtnEl.style.background = 'rgba(160,180,220,0.08)';
      this._promptBtnEl.style.color = 'var(--obs-text,#c3daf8)';
    });
    this._promptBtnEl.addEventListener('mouseleave', () => {
      this._promptBtnEl.style.background = 'rgba(12,22,36,0.6)';
      this._promptBtnEl.style.color = '#a088e0';
    });
    this._promptBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._promptQuestion) {
        shell.queryAgent(this._promptQuestion);
      }
      this._hidePrompt();
    });
    this._promptBarEl.appendChild(this._promptBtnEl);
    const dismissBtn = document.createElement('button');
    dismissBtn.innerHTML = iconHtml('close', 11);
    dismissBtn.style.cssText =
      'padding:2px 4px;border:none;background:none;color:var(--obs-text-3);' +
      'cursor:pointer;font-size: calc(11px * var(--font-scale));line-height:0;transition:color var(--obs-snap);';
    dismissBtn.addEventListener('mouseenter', () => {
      dismissBtn.style.color = 'var(--obs-text,#c3daf8)';
    });
    dismissBtn.addEventListener('mouseleave', () => {
      dismissBtn.style.color = 'var(--obs-text-3)';
    });
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._hidePrompt();
    });
    this._promptBarEl.appendChild(dismissBtn);
    this.host.container.appendChild(this._promptBarEl);
  }

  private _showPrompt = (data: { title: string; question: string }): void => {
    if (this._promptTimer) clearTimeout(this._promptTimer);
    this._promptTitleEl.textContent = data.title;
    this._promptQuestion = data.question;
    this._promptBarEl.style.display = 'flex';
    this._promptBarEl.style.opacity = '1';
    this._promptTimer = setTimeout(() => this._hidePrompt(), 8000);
  };

  _hidePrompt = (): void => {
    if (this._promptTimer) {
      clearTimeout(this._promptTimer);
      this._promptTimer = null;
    }
    this._promptBarEl.style.opacity = '0';
    setTimeout(() => {
      if (this._promptBarEl.style.opacity === '0') {
        this._promptBarEl.style.display = 'none';
        this._promptQuestion = '';
      }
    }, 200);
  };
}
