// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { t } from '../i18n';
import { hexToCSS } from './graph-colors';

// ── Legend (color key) ────────────────────────────────────────

export function buildLegend(
  container: HTMLElement,
  setEdgeTypeFilter: (et: string | null) => void,
  setNodeKindFilter: (nk: string | null) => void,
  _edgeTypeFilter: () => string | null,
  _nodeKindFilter: () => string | null,
): HTMLDivElement {
  const el = document.createElement('div');
  el.id = 'graph-legend';
  el.style.display = 'none';
  // P5：观测台原型 — 水平玻璃胶囊（标题 + 节点色点 + 分隔 + 连线样例）
  el.innerHTML = `<span class="legend-title">${t('legend.title')}</span>
      <div class="legend-row legend-node-row" data-node-filter="function" title="${t('legend.function.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0x4ad8c8)};color:${hexToCSS(0x4ad8c8)}"></span> ${t('legend.function')}</div>
      <div class="legend-row legend-node-row" data-node-filter="class" title="${t('legend.class.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0x7fd84a)};color:${hexToCSS(0x7fd84a)}"></span> ${t('legend.class')}</div>
      <div class="legend-row legend-node-row" data-node-filter="module" title="${t('legend.module.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xd8d84a)};color:${hexToCSS(0xd8d84a)}"></span> ${t('legend.module')}</div>
      <div class="legend-row legend-node-row" data-node-filter="interface" title="${t('legend.interface.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xf0a850)};color:${hexToCSS(0xf0a850)}"></span> ${t('legend.interface')}</div>
      <div class="legend-row legend-node-row" data-node-filter="file" title="${t('legend.file.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xf0c060)};color:${hexToCSS(0xf0c060)}"></span> ${t('legend.file')}</div>
      <div class="legend-row legend-node-row" data-node-filter="symbol" title="${t('legend.symbol.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0x6ab0ff)};color:${hexToCSS(0x6ab0ff)}"></span> ${t('legend.symbol')}</div>
      <span class="legend-sep"></span>
      <div class="legend-row legend-edge-row" data-edge-type="calls" title="${t('legend.calls.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4a9adf)}"></span> ${t('legend.calls')}</div>
      <div class="legend-row legend-edge-row" data-edge-type="imports" title="${t('legend.imports.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4adfdf)}"></span> ${t('legend.imports')}</div>
      <div class="legend-row legend-edge-row" data-edge-type="defines" title="${t('legend.defines.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4adf8a)}"></span> ${t('legend.defines')}</div>
      <div class="legend-row legend-edge-row" data-edge-type="inherits" title="${t('legend.inherits.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff66dd)}"></span> ${t('legend.inherits')}</div>`;
  container.appendChild(el);
  el.querySelectorAll<HTMLElement>('.legend-edge-row').forEach((row) => {
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      const et = row.dataset.edgeType || '';
      setEdgeTypeFilter(_edgeTypeFilter() === et ? null : et);
    });
  });
  el.querySelectorAll<HTMLElement>('.legend-node-row').forEach((row) => {
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      const nk = row.dataset.nodeFilter || '';
      setNodeKindFilter(_nodeKindFilter() === nk ? null : nk);
    });
  });
  return el;
}

// ── Focus subgraph banner ─────────────────────────────────────

export function buildFocusBanner(container: HTMLElement, onClick: () => void): HTMLDivElement {
  const el = document.createElement('div');
  el.id = 'graph-focus-banner';
  el.textContent = '';
  el.addEventListener('click', onClick);
  container.appendChild(el);
  return el;
}
