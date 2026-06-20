// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Minimal i18n — zh/en toggle for new UI elements
// Does NOT cover the full app — only legend, focus banner, color/scale labels.

const TRANS: Record<string, { zh: string; en: string }> = {
  'legend.node':   { zh: '节点', en: 'NODE' },
  'legend.edge':   { zh: '连线', en: 'EDGE' },
  'legend.symbol': { zh: '符号', en: 'Symbol' },
  'legend.medium': { zh: '介质', en: 'Medium' },
  'legend.temporal': { zh: '时序', en: 'Temporal' },
  'legend.structural': { zh: '结构', en: 'Structural' },
  'legend.dataRead':   { zh: '数据读', en: 'Data Read' },
  'legend.dataWrite':  { zh: '数据写', en: 'Data Write' },
  'legend.temporalEdge': { zh: '时序', en: 'Temporal' },

  'focus.title':  { zh: '聚焦', en: 'Focus' },
  'focus.nodes':  { zh: '节点', en: 'nodes' },
  'focus.exit':   { zh: 'Esc 退出', en: 'Esc to exit' },

  'color.type':      { zh: '按类型', en: 'By Type' },
  'color.community': { zh: '按社区', en: 'By Community' },
  'color.coupling':  { zh: '按耦合', en: 'By Coupling' },
  'color.tooltip':   { zh: '着色', en: 'Color' },

  'scale.degree':   { zh: '按度', en: 'By Degree' },
  'scale.coupling': { zh: '按耦合风险', en: 'By Coupling Risk' },
  'scale.tooltip':  { zh: '缩放', en: 'Scale' },
};

export type Lang = 'zh' | 'en';

let _lang: Lang = 'zh';

export function getLang(): Lang { return _lang; }

export function setLang(lang: Lang): void { _lang = lang; }

export function t(key: string): string {
  const entry = TRANS[key];
  if (!entry) return key;
  return entry[_lang] || entry.en || key;
}
