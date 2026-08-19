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
      <div class="legend-row legend-node-row" data-node-filter="variable" title="${t('legend.variable.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xf07070)};color:${hexToCSS(0xf07070)}"></span> ${t('legend.variable')}</div>
      <div class="legend-row legend-node-row" data-node-filter="medium" title="${t('legend.medium.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xf0c060)};color:${hexToCSS(0xf0c060)}"></span> ${t('legend.medium')}</div>
      <div class="legend-row legend-node-row" data-node-filter="temporal" title="${t('legend.temporal.desc')}"><span class="legend-swatch" style="background:${hexToCSS(0xc098ff)};color:${hexToCSS(0xc098ff)}"></span> ${t('legend.temporal')}</div>
      <span class="legend-sep"></span>
      <div class="legend-row legend-edge-row" data-edge-type="calls" title="${t('legend.calls.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4a9adf)}"></span> ${t('legend.calls')}</div>
      <div class="legend-row legend-edge-row" data-edge-type="imports" title="${t('legend.imports.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4adfdf)}"></span> ${t('legend.imports')}</div>
      <div class="legend-row legend-edge-row" data-edge-type="defines" title="${t('legend.defines.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x4adf8a)}"></span> ${t('legend.defines')}</div>
      <div class="legend-row legend-edge-row" data-edge-type="inherits" title="${t('legend.inherits.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff66dd)}"></span> ${t('legend.inherits')}</div>
      <div class="legend-row legend-edge-row" data-edge-type="reads" title="${t('legend.reads.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x66dd66)}"></span> ${t('legend.reads')}</div>
      <div class="legend-row legend-edge-row" data-edge-type="writes" title="${t('legend.writes.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff5566)}"></span> ${t('legend.writes')}</div>
      <div class="legend-row legend-edge-row" data-edge-type="shares" title="${t('legend.shares.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xffaa44)}"></span> ${t('legend.shares')}</div>
      <div class="legend-row legend-edge-row" data-edge-type="triggers" title="${t('legend.triggers.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff8833)}"></span> ${t('legend.triggers')}</div>
      <div class="legend-row legend-edge-row" data-edge-type="awaits" title="${t('legend.awaits.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xc068ff)}"></span> ${t('legend.awaits')}</div>
      <div class="legend-row legend-edge-row" data-edge-type="sequences" title="${t('legend.sequences.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x8866ff)}"></span> ${t('legend.sequences')}</div>
      <div class="legend-row legend-edge-row" data-edge-type="usage" title="${t('legend.usage.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0x88aacc)}"></span> ${t('legend.usage')}</div>
      <div class="legend-row legend-edge-row" data-edge-type="throws" title="${t('legend.throws.desc')}"><span class="legend-edge-swatch" style="background:${hexToCSS(0xff4466)}"></span> ${t('legend.throws')}</div>`;
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
