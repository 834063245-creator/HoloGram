// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Icon system — geometric SVG icons for deep-space command console
// 统一规格: 18x18 viewBox · 1.5px stroke · round caps · 颜色走 CSS currentColor

interface IconDef {
  /** SVG inner HTML (paths only, no <svg> wrapper) */
  path: string;
  /** Semantic label for screen readers */
  label: string;
}

/** Raw icon definitions — paths in a 18×18 viewBox centered at (9,9). */
const icons: Record<string, IconDef> = {
  // ── Layout ──
  'chevron-right': {
    label: '展开',
    path: '<polyline points="7,4 13,9 7,14"/>',
  },
  'chevron-down': {
    label: '收起',
    path: '<polyline points="4,7 9,13 14,7"/>',
  },
  'chevron-up': {
    label: '收起',
    path: '<polyline points="4,12 9,6 14,12"/>',
  },
  close: {
    label: '关闭',
    path: '<line x1="5" y1="5" x2="13" y2="13"/><line x1="13" y1="5" x2="5" y2="13"/>',
  },

  // ── Toolbar ──
  'mode-minimal': {
    label: '极简骨架',
    path: '<circle cx="9" cy="9" r="3" fill="currentColor" fill-opacity="0.2"/><circle cx="9" cy="9" r="3"/>',
  },
  'mode-standard': {
    label: '标准星图',
    path: '<circle cx="9" cy="5" r="1.2"/><circle cx="5" cy="13" r="1.2"/><circle cx="13" cy="13" r="1.2"/><line x1="9" y1="6.2" x2="6" y2="12"/><line x1="9" y1="6.2" x2="12" y2="12"/><line x1="6" y1="12" x2="12" y2="12"/>',
  },
  'mode-full': {
    label: '观赏模式',
    path: '<path d="M9 1 L10.5 7.5 L9 5 L7.5 7.5 Z"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="9" r="3"/><path d="M3 11 A7 7 0 0 0 15 11"/>',
  },
  fold: {
    label: '折叠',
    path: '<circle cx="9" cy="9" r="5"/><ellipse cx="9" cy="9" rx="7" ry="2.5"/><circle cx="9" cy="9" r="1" fill="currentColor" fill-opacity="0.3"/>',
  },
  'folder-open': {
    label: '打开文件夹',
    path: '<path d="M3 6 L3 15 L15 15 L15 6 L8.5 6 L7 3.5 L3 3.5 L3 6 Z"/><line x1="9" y1="9" x2="9" y2="12"/><line x1="7" y1="10.5" x2="11" y2="10.5"/>',
  },

  // ── Panels ──
  check: {
    label: '简报',
    path: '<polygon points="9,2 2,15 16,15"/><line x1="9" y1="7" x2="9" y2="11"/><circle cx="9" cy="13" r="0.6" fill="currentColor"/>',
  },
  chat: {
    label: '对话',
    path: '<path d="M3 4 L3 11 L6 11 L9 14.5 L9 11 L15 11 L15 4 Z"/><circle cx="7" cy="7.5" r="1.2"/><circle cx="11.5" cy="7.5" r="1.2"/>',
  },
  diff: {
    label: '变更',
    path: '<circle cx="5" cy="5" r="2.5"/><circle cx="13" cy="13" r="2.5"/><circle cx="13" cy="5" r="2.5"/><line x1="6.5" y1="5" x2="11.5" y2="5"/><line x1="6.5" y1="13" x2="11.5" y2="13"/>',
  },
  timeline: {
    label: '时间轴',
    path: '<circle cx="5" cy="5" r="2"/><polyline points="5,7 5,13 8,12"/><line x1="5" y1="3" x2="13" y2="9"/><circle cx="13" cy="10" r="2"/>',
  },
  settings: {
    label: '设置',
    path: '<circle cx="9" cy="9" r="4.5"/><circle cx="9" cy="9" r="1.5" fill="currentColor"/><line x1="9" y1="2" x2="9" y2="4.5"/><line x1="9" y1="13.5" x2="9" y2="16"/><line x1="2" y1="9" x2="4.5" y2="9"/><line x1="13.5" y1="9" x2="16" y2="9"/><line x1="4.05" y1="4.05" x2="5.82" y2="5.82"/><line x1="12.18" y1="12.18" x2="13.95" y2="13.95"/><line x1="13.95" y1="4.05" x2="12.18" y2="5.82"/><line x1="5.82" y1="12.18" x2="4.05" y2="13.95"/>',
  },
  constraints: {
    label: '约束',
    path: '<circle cx="9" cy="4" r="2.5"/><line x1="5" y1="5.8" x2="13" y2="12.2"/><circle cx="5" cy="13" r="2.5"/><circle cx="13" cy="13" r="2.5"/>',
  },
  terminal: {
    label: '终端',
    path: '<rect x="2" y="3" width="14" height="12" rx="2"/><polyline points="5,7 7,9 5,11"/><line x1="8" y1="11" x2="13" y2="11"/>',
  },
  search: {
    label: '搜索',
    path: '<circle cx="7.5" cy="7.5" r="4"/><line x1="10.5" y1="10.5" x2="15" y2="15"/>',
  },

  // ── Actions ──
  send: {
    label: '发送',
    path: '<polygon points="5,9 3,15 16,9 3,3"/>',
  },
  stop: {
    label: '停止',
    path: '<rect x="4" y="4" width="10" height="10" rx="1.5"/>',
  },
  alert: {
    label: '警告',
    path: '<polygon points="9,2 2,15 16,15"/><line x1="9" y1="7" x2="9" y2="11"/><circle cx="9" cy="13.5" r="0.7" fill="currentColor"/>',
  },
  'alert-circle': {
    label: '警告',
    path: '<circle cx="9" cy="9" r="6.5"/><line x1="9" y1="5" x2="9" y2="10"/><circle cx="9" cy="12.5" r="0.7" fill="currentColor"/>',
  },
  'check-circle': {
    label: '通过',
    path: '<circle cx="9" cy="9" r="6.5"/><polyline points="5.5,9 8,11.5 12.5,6.5"/>',
  },
  dot: {
    label: '',
    path: '<circle cx="9" cy="9" r="2.5" fill="currentColor"/>',
  },
  'blink-dot': {
    label: '',
    path: '<circle cx="9" cy="9" r="3" fill="currentColor" fill-opacity="0.35"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/>',
  },

  // ── Misc ──
  plus: {
    label: '添加',
    path: '<line x1="9" y1="4" x2="9" y2="14"/><line x1="4" y1="9" x2="14" y2="9"/>',
  },
  save: {
    label: '保存',
    path: '<path d="M4 2 L4 14 L12 14 L14 12 L14 2 Z"/><line x1="7" y1="2" x2="7" y2="7"/><line x1="5" y1="7" x2="12" y2="7"/>',
  },
  undo: {
    label: '撤销',
    path: '<path d="M4 9 A5 5 0 0 1 14 5"/><polyline points="4,9 8,9 8,5"/><line x1="8" y1="9" x2="15" y2="9"/>',
  },
  redo: {
    label: '重做',
    path: '<path d="M14 9 A5 5 0 0 1 4 5"/><polyline points="14,9 10,9 10,5"/><line x1="10" y1="9" x2="3" y2="9"/>',
  },
  reset: {
    label: '重置',
    path: '<path d="M3 5 A6 6 0 0 1 13 3"/><polyline points="3,5 7,5 7,1"/>',
  },
  brand: {
    label: '',
    path: '<circle cx="9" cy="9" r="2" fill="currentColor" fill-opacity="0.35"/><circle cx="9" cy="9" r="6"/><circle cx="9" cy="9" r="1" fill="currentColor"/><line x1="9" y1="3" x2="9" y2="7"/><line x1="9" y1="11" x2="9" y2="15"/><line x1="3" y1="9" x2="7" y2="9"/><line x1="11" y1="9" x2="15" y2="9"/>',
  },

  // ── Status & feedback ──
  loading: {
    label: '加载中',
    path: '<path d="M5 3 L13 3 L9.5 8 L13 13 L5 13 L8.5 8 Z"/>',
  },
  clock: {
    label: '时间',
    path: '<circle cx="9" cy="9" r="6"/><polyline points="9,5 9,9 12,12"/>',
  },

  // ── Objects ──
  file: {
    label: '文件',
    path: '<path d="M5 3 L5 15 L13 15 L13 7 L10 3 Z"/><polyline points="10,3 10,7 13,7"/><line x1="7" y1="10" x2="12" y2="10"/><line x1="7" y1="12" x2="10" y2="12"/>',
  },
  chart: {
    label: '统计',
    path: '<line x1="4" y1="15" x2="4" y2="8"/><line x1="8" y1="15" x2="8" y2="4"/><line x1="12" y1="15" x2="12" y2="6"/><polyline points="2,8 4,8 8,4 12,6 16,2"/>',
  },
  edit: {
    label: '编辑',
    path: '<path d="M13 2 L16 5 L9 12 L5 12 L5 8 Z"/><line x1="7" y1="10" x2="12" y2="5"/>',
  },
  eye: {
    label: '预览',
    path: '<path d="M2 9s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="9" cy="9" r="2"/>',
  },
  bookmark: {
    label: '书签',
    path: '<path d="M5 2 L5 16 L9 12 L13 16 L13 2 Z"/>',
  },

  // ── Actions ──
  agent: {
    label: 'AI Agent',
    path: '<rect x="2" y="3" width="14" height="9" rx="2"/><circle cx="6.5" cy="7.5" r="1"/><circle cx="11.5" cy="7.5" r="1"/><line x1="9" y1="10" x2="9" y2="13"/><line x1="5" y1="13" x2="13" y2="13"/>',
  },
  translate: {
    label: '代码翻译',
    path: '<path d="M9 2 L11.2 7.5 L17 9 L11.2 10.5 L9 16 L6.8 10.5 L1 9 L6.8 7.5 Z"/>',
  },
  blast: {
    label: '波及分析',
    path: '<circle cx="9" cy="9" r="3"/><line x1="9" y1="2" x2="9" y2="5"/><line x1="9" y1="12" x2="9" y2="15"/><line x1="2" y1="9" x2="5" y2="9"/><line x1="12" y1="9" x2="15" y2="9"/><line x1="4" y1="4" x2="6.2" y2="6.2"/><line x1="11.8" y1="11.8" x2="14" y2="14"/><line x1="14" y1="4" x2="11.8" y2="6.2"/><line x1="6.2" y1="11.8" x2="4" y2="14"/>',
  },
  'reset-cam': {
    label: '复位',
    path: '<rect x="2" y="5" width="14" height="10" rx="1"/><circle cx="9" cy="10" r="3"/><circle cx="9" cy="10" r="1"/><line x1="2" y1="2" x2="5" y2="5"/><line x1="16" y1="2" x2="13" y2="5"/><line x1="2" y1="18" x2="5" y2="15"/><line x1="16" y1="18" x2="13" y2="15"/>',
  },
  focus: {
    label: '聚焦',
    path: '<circle cx="9" cy="9" r="5.5"/><circle cx="9" cy="9" r="2.5"/><line x1="9" y1="1" x2="9" y2="3.5"/><line x1="9" y1="14.5" x2="9" y2="17"/><line x1="1" y1="9" x2="3.5" y2="9"/><line x1="14.5" y1="9" x2="17" y2="9"/>',
  },
  info: {
    label: '信息',
    path: '<path d="M6 3 L6 4 L4 4 L4 15 L14 15 L14 4 L12 4 L12 3 Z"/><line x1="7" y1="8" x2="12" y2="8"/><line x1="7" y1="11" x2="10" y2="11"/>',
  },

  // ── People ──
  user: {
    label: '用户',
    path: '<circle cx="9" cy="5.5" r="2.5"/><path d="M3 16 C3 11 15 11 15 16"/>',
  },

  // ── Symbols ──
  galaxy: {
    label: '星系',
    path: '<path d="M9 9 L9 5 A4 4 0 0 1 13 9 A3 3 0 0 1 10 12 A2 2 0 0 1 8 10"/>',
  },
  link: {
    label: '链接',
    path: '<circle cx="5" cy="5" r="2.5"/><circle cx="13" cy="13" r="2.5"/><line x1="7.1" y1="6.8" x2="10.9" y2="11.2"/>',
  },
  block: {
    label: '禁止',
    path: '<circle cx="9" cy="9" r="6"/><line x1="4.5" y1="4.5" x2="13.5" y2="13.5"/>',
  },

  // ── File tree ──
  'folder-closed': {
    label: '文件夹',
    path: '<path d="M3 3.5 L7.5 3.5 L9 5.5 L15 5.5 L15 14 L3 14 Z"/>',
  },
  refresh: {
    label: '刷新',
    path: '<path d="M3 5 A6 6 0 0 1 13 3"/><polyline points="3,5 7,5 7,1"/><path d="M15 12 A6 6 0 0 1 5 14"/><polyline points="15,12 11,12 11,16"/>',
  },
  code: {
    label: '代码',
    path: '<polyline points="6,5 2,9 6,13"/><polyline points="12,5 16,9 12,13"/><line x1="9" y1="13" x2="11" y2="3"/>',
  },
  'code-py': {
    label: 'Python',
    path: '<polyline points="6,5 2,9 6,13"/><polyline points="12,5 16,9 12,13"/><text x="9" y="14" text-anchor="middle" font-size="5" fill="currentColor" font-weight="700">Py</text>',
  },
  'code-rs': {
    label: 'Rust',
    path: '<polyline points="6,5 2,9 6,13"/><polyline points="12,5 16,9 12,13"/><text x="9" y="14" text-anchor="middle" font-size="5" fill="currentColor" font-weight="700">Rs</text>',
  },
  'code-go': {
    label: 'Go',
    path: '<polyline points="6,5 2,9 6,13"/><polyline points="12,5 16,9 12,13"/><text x="9" y="14" text-anchor="middle" font-size="5" fill="currentColor" font-weight="700">Go</text>',
  },
  copy: {
    label: '复制',
    path: '<rect x="5" y="5" width="8" height="10" rx="1"/><polyline points="9,3 13,3 13,12 11,12"/>',
  },

  // ── Git SCM ──
  'git-branch': {
    label: '分支',
    path: '<circle cx="9" cy="4" r="2.5"/><line x1="9" y1="6.5" x2="9" y2="13"/><path d="M9 10 L13 14 L13 16 M13 12 L13 16"/>',
  },
  upload: {
    label: '推送',
    path: '<line x1="9" y1="3" x2="9" y2="11"/><polyline points="5,6 9,2 13,6"/><line x1="3" y1="15" x2="15" y2="15"/>',
  },
  download: {
    label: '拉取',
    path: '<line x1="9" y1="13" x2="9" y2="5"/><polyline points="5,10 9,14 13,10"/><line x1="3" y1="3" x2="15" y2="3"/>',
  },
  regenerate: {
    label: '重新生成',
    path: '<path d="M4 4 A6 6 0 0 1 13 2"/><polyline points="4,4 7.5,4 7.5,1"/><circle cx="13" cy="12" r="4"/><polyline points="10.5,12 12.5,10 14.5,12"/>',
  },

  // ── P6: Hotspots ──
  fire: {
    label: '热点',
    path: '<path d="M9 2 C6 6 4 8 4 11.5 A5 5 0 0 0 9 16.5 A5 5 0 0 0 14 11.5 C14 8 12 6 9 2 Z"/>',
  },

  // ── Permissions ──
  shield: {
    label: '权限',
    path: '<path d="M9 2 L4 4.5 L4 10 C4 13.5 6.5 16.5 9 17 C11.5 16.5 14 13.5 14 10 L14 4.5 Z"/>',
  },
  puzzle: {
    label: '子Agent',
    path: '<path d="M5 3 L5 6 L8 6 L8 4.5 A1.5 1.5 0 0 1 11 4.5 L11 6 L14 6 L14 12 L11 12 L11 13.5 A1.5 1.5 0 0 1 8 13.5 L8 12 L5 12 L5 15 L15 15 L15 3 Z"/>',
  },
  keyboard: {
    label: '快捷键',
    path: '<rect x="2" y="4" width="14" height="10" rx="1.5"/><line x1="5" y1="7" x2="5" y2="11"/><line x1="8" y1="7" x2="8" y2="11"/><line x1="11" y1="7" x2="11" y2="11"/><line x1="14" y1="7" x2="14" y2="9"/>',
  },
  'export-file': {
    label: '导出',
    path: '<path d="M5 3 L5 15 L13 15 L13 7 L10 3 Z"/><polyline points="10,3 10,7 13,7"/><line x1="9" y1="12" x2="9" y2="8"/><polyline points="7,10 9,8 11,10"/><line x1="5" y1="12" x2="4" y2="14"/>',
  },
  trash: {
    label: '删除',
    path: '<polyline points="4,6 5,6 14,6"/><path d="M6,6 L6,15 L12,15 L12,6"/><line x1="8" y1="9" x2="8" y2="12"/><line x1="10" y1="9" x2="10" y2="12"/>',
  },

  // ── File tree header ──
  'sort-toggle': {
    label: '排序',
    path: '<line x1="3" y1="6" x2="9" y2="6"/><line x1="3" y1="10" x2="12" y2="10"/><line x1="3" y1="14" x2="15" y2="14"/><polyline points="13,3 15,6 13,9"/>',
  },
  'collapse-all': {
    label: '折叠全部',
    path: '<rect x="3" y="3" width="12" height="12" rx="1" fill="none"/><polyline points="6,8 9,11 12,8"/>',
  },
  'expand-all': {
    label: '展开全部',
    path: '<rect x="3" y="3" width="12" height="12" rx="1" fill="none"/><polyline points="6,11 9,8 12,11"/>',
  },
};

/**
 * Render an icon to an HTML string.
 * @param name Icon key from the icon set
 * @param size In pixels (default: 15)
 * @param cls Optional CSS class
 */
export function iconSvg(name: string, size = 15, cls = ''): string {
  const def = icons[name];
  if (!def) return `<span style="color:var(--fail)">?</span>`;
  return `<svg class="hg-icon ${cls}" width="${size}" height="${size}" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-label="${def.label}" role="img">${def.path}</svg>`;
}

/**
 * Returns the SVG string for a given icon name — used in innerHTML contexts.
 */
export function iconHtml(name: string, size = 15): string {
  return iconSvg(name, size);
}
