// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Icon system — 纯天文几何语言
//
// 设计规范:
//   viewBox:   0 0 24 24
//   stroke:    1.5px · round caps/joins
//   图元:      圆 · 弧 · 直线 · 点 — 不用 polygon 拟物
//   fill:      仅用于"恒星"点 (小圆), 其余纯 stroke
//   网格:      坐标对齐到整数或 .5
//   视觉重量:  外环 r=7~9 · 内环 r=3~4 · 点 r=0.8~1.5
//   中心:      (12, 12)
//   色彩:      currentColor, 由 CSS 控制

interface IconDef {
  /** SVG inner HTML (paths only, no <svg> wrapper) */
  path: string;
  /** Semantic label for screen readers */
  label: string;
}

/** Raw icon definitions — paths in a 24×24 viewBox centered at (12,12). */
const icons: Record<string, IconDef> = {
  // ── Layout ──
  'chevron-right': {
    label: '展开',
    path: '<path d="M9 5 A7 7 0 0 1 9 19"/><line x1="9" y1="5" x2="6.5" y2="5"/><line x1="9" y1="19" x2="6.5" y2="19"/>',
  },
  'chevron-down': {
    label: '收起',
    path: '<path d="M5 9 A7 7 0 0 1 19 9"/><line x1="5" y1="9" x2="5" y2="6.5"/><line x1="19" y1="9" x2="19" y2="6.5"/>',
  },
  'chevron-up': {
    label: '收起',
    path: '<path d="M5 15 A7 7 0 0 0 19 15"/><line x1="5" y1="15" x2="5" y2="17.5"/><line x1="19" y1="15" x2="19" y2="17.5"/>',
  },
  close: {
    label: '关闭',
    path: '<circle cx="12" cy="12" r="8"/><line x1="7.5" y1="7.5" x2="16.5" y2="16.5"/>',
  },

  // ── Toolbar / Mode ──
  'mode-minimal': {
    label: '极简骨架',
    path: '<circle cx="12" cy="12" r="4" fill="currentColor" fill-opacity="0.15"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  },
  'mode-standard': {
    label: '标准星图',
    path: '<line x1="12" y1="5" x2="6" y2="18"/><line x1="12" y1="5" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="18"/><circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="6" cy="18" r="1.5" fill="currentColor"/><circle cx="18" cy="18" r="1.5" fill="currentColor"/>',
  },
  'mode-full': {
    label: '观赏模式',
    path: '<circle cx="12" cy="12" r="3" fill="currentColor" fill-opacity="0.2"/><circle cx="12" cy="12" r="3"/><path d="M4 14 A8 8 0 0 0 20 14"/>',
  },
  fold: {
    label: '折叠',
    path: '<circle cx="12" cy="12" r="6"/><ellipse cx="12" cy="12" rx="9" ry="3"/><circle cx="12" cy="12" r="1.2" fill="currentColor" fill-opacity="0.3"/>',
  },
  'folder-open': {
    label: '打开文件夹',
    path: '<path d="M3 6 L3 19 L21 19 L21 8 L11 8 L9 6 Z"/><line x1="3" y1="11" x2="21" y2="11"/>',
  },

  // ── Panels ──
  check: {
    label: '简报',
    path: '<polyline points="5,12 10,17 19,7"/>',
  },
  chat: {
    label: '对话',
    path: '<circle cx="11" cy="10" r="6"/><circle cx="8" cy="10" r="0.8" fill="currentColor"/><circle cx="14" cy="10" r="0.8" fill="currentColor"/><path d="M11 16 L14 20"/>',
  },
  diff: {
    label: '变更',
    path: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="7" y1="8" x2="11" y2="16"/><line x1="17" y1="8" x2="13" y2="16"/>',
  },
  timeline: {
    label: '时间轴',
    path: '<line x1="12" y1="3" x2="12" y2="21"/><circle cx="12" cy="6" r="1.5"/><line x1="13.5" y1="6" x2="18" y2="6"/><circle cx="12" cy="12" r="1.5"/><line x1="13.5" y1="12" x2="20" y2="12"/><circle cx="12" cy="18" r="1.5"/><line x1="13.5" y1="18" x2="16" y2="18"/>',
  },
  settings: {
    label: '设置',
    path: '<circle cx="12" cy="12" r="8"/><line x1="12" y1="3" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21"/><line x1="3" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21" y2="12"/><line x1="5.6" y1="5.6" x2="7" y2="7"/><line x1="17" y1="17" x2="18.4" y2="18.4"/><line x1="18.4" y1="5.6" x2="17" y2="7"/><line x1="7" y1="17" x2="5.6" y2="18.4"/><circle cx="12" cy="12" r="3.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  },
  constraints: {
    label: '约束',
    path: '<rect x="5" y="10" width="14" height="10" rx="1"/><path d="M8 10 L8 7 A4 4 0 0 1 16 7 L16 10"/><circle cx="12" cy="14.5" r="1.2" fill="currentColor"/>',
  },
  route: {
    label: '路由开关',
    path: '<circle cx="5" cy="7" r="1.5" fill="currentColor"/><circle cx="5" cy="17" r="1.5" fill="currentColor"/><circle cx="19" cy="7" r="1.5" fill="currentColor"/><circle cx="19" cy="17" r="1.5" fill="currentColor"/><line x1="6.5" y1="7" x2="17.5" y2="17"/><line x1="6.5" y1="17" x2="17.5" y2="7"/>',
  },
  threshold: {
    label: '阈值',
    path: '<path d="M4 15 A8 8 0 0 1 20 15"/><line x1="12" y1="15" x2="16.5" y2="9.5"/><circle cx="12" cy="15" r="1" fill="currentColor"/><line x1="4" y1="19" x2="20" y2="19"/>',
  },
  terminal: {
    label: '终端',
    path: '<rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="8" x2="21" y2="8"/><polyline points="7,11 10,14 7,17"/><line x1="12" y1="17" x2="16" y2="17"/>',
  },
  search: {
    label: '搜索',
    path: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="3.5"/><line x1="15.5" y1="15.5" x2="20" y2="20"/>',
  },

  // ── Actions ──
  send: {
    label: '发送',
    path: '<circle cx="5" cy="19" r="1.2" fill="currentColor"/><path d="M7.5 16.5 A5 5 0 0 1 7.5 6.5"/><path d="M10.5 13.5 A2 2 0 0 1 10.5 9.5"/><path d="M13 20 A10 10 0 0 1 3 10"/>',
  },
  stop: {
    label: '停止',
    path: '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
  },
  alert: {
    label: '警告',
    path: '<circle cx="12" cy="12" r="8" fill="currentColor" fill-opacity="0.1"/><circle cx="12" cy="12" r="8"/><line x1="12" y1="7" x2="12" y2="13"/><circle cx="12" cy="16" r="0.8" fill="currentColor"/>',
  },
  'alert-circle': {
    label: '警告',
    path: '<circle cx="12" cy="12" r="8"/><line x1="12" y1="7.5" x2="12" y2="13"/><circle cx="12" cy="15.5" r="0.8" fill="currentColor"/>',
  },
  'check-circle': {
    label: '通过',
    path: '<circle cx="12" cy="12" r="8"/><polyline points="8,12 11,15 16,9"/>',
  },
  dot: {
    label: '',
    path: '<circle cx="12" cy="12" r="3" fill="currentColor"/>',
  },
  'blink-dot': {
    label: '',
    path: '<circle cx="12" cy="12" r="4" fill="currentColor" fill-opacity="0.35"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>',
  },

  // ── Misc ──
  plus: {
    label: '添加',
    path: '<circle cx="12" cy="12" r="8"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
  },
  save: {
    label: '保存',
    path: '<circle cx="12" cy="12" r="8"/><line x1="12" y1="8" x2="12" y2="14"/><polyline points="9.5,11.5 12,14 14.5,11.5"/><line x1="8" y1="17" x2="16" y2="17"/>',
  },
  undo: {
    label: '撤销',
    path: '<path d="M19 10 A6 6 0 0 0 7 10"/><polyline points="10,7 7,10 10,13"/>',
  },
  redo: {
    label: '重做',
    path: '<path d="M5 10 A6 6 0 0 0 17 10"/><polyline points="14,7 17,10 14,13"/>',
  },
  reset: {
    label: '重置',
    path: '<path d="M5 12 A7 7 0 1 1 19 10"/><polyline points="8,9 5,12 8,15"/>',
  },
  brand: {
    label: '',
    path: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="0.8" fill="currentColor"/><line x1="12" y1="3" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="21"/><line x1="3" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="21" y2="12"/>',
  },

  // ── Status & feedback ──
  loading: {
    label: '加载中',
    path: '<path d="M4 12 A8 8 0 0 1 12 4"/><path d="M20 12 A8 8 0 0 1 12 20"/><circle cx="12" cy="12" r="0.8" fill="currentColor"/>',
  },
  clock: {
    label: '时间',
    path: '<circle cx="12" cy="12" r="8"/><polyline points="12,7 12,12 15,14"/>',
  },

  // ── Objects ──
  file: {
    label: '文件',
    path: '<path d="M6 3 L14 3 L18 7 L18 21 L6 21 Z"/><path d="M14 3 L14 7 L18 7"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="16" x2="15" y2="16"/>',
  },
  chart: {
    label: '统计',
    path: '<line x1="5" y1="20" x2="5" y2="13"/><line x1="12" y1="20" x2="12" y2="6"/><line x1="19" y1="20" x2="19" y2="10"/><line x1="3" y1="20" x2="21" y2="20"/>',
  },
  edit: {
    label: '编辑',
    path: '<circle cx="12" cy="12" r="8"/><line x1="9" y1="15" x2="15" y2="9"/><circle cx="15" cy="9" r="1" fill="currentColor"/>',
  },
  eye: {
    label: '预览',
    path: '<path d="M3 12 A9 5 0 0 1 21 12 A9 5 0 0 1 3 12"/><circle cx="12" cy="12" r="3"/>',
  },
  bookmark: {
    label: '书签',
    path: '<circle cx="12" cy="8" r="5"/><line x1="12" y1="13" x2="12" y2="21"/>',
  },

  // ── AI / Agent ──
  agent: {
    label: 'AI Agent',
    path: '<circle cx="12" cy="8" r="5"/><line x1="12" y1="13" x2="12" y2="19"/><line x1="8" y1="19" x2="16" y2="19"/><circle cx="10" cy="8" r="0.8" fill="currentColor"/><circle cx="14" cy="8" r="0.8" fill="currentColor"/>',
  },
  translate: {
    label: '代码翻译',
    path: '<circle cx="7" cy="8" r="3"/><circle cx="17" cy="16" r="3"/><path d="M9 10 A8 8 0 0 0 15 14"/>',
  },
  blast: {
    label: '波及分析',
    path: '<circle cx="12" cy="12" r="3"/><line x1="12" y1="3" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="21"/><line x1="3" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="21" y2="12"/><line x1="5" y1="5" x2="7" y2="7"/><line x1="17" y1="17" x2="19" y2="19"/><line x1="19" y1="5" x2="17" y2="7"/><line x1="7" y1="17" x2="5" y2="19"/>',
  },
  'reset-cam': {
    label: '复位',
    path: '<rect x="3" y="6" width="18" height="14" rx="1"/><circle cx="12" cy="13" r="4"/><circle cx="12" cy="13" r="1" fill="currentColor"/>',
  },
  focus: {
    label: '聚焦',
    path: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="3" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21"/><line x1="3" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21" y2="12"/>',
  },
  info: {
    label: '信息',
    path: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="8" r="0.8" fill="currentColor"/><line x1="12" y1="11" x2="12" y2="17"/>',
  },

  // ── People ──
  user: {
    label: '用户',
    path: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20 A7 7 0 0 1 19 20"/>',
  },

  // ── Symbols ──
  galaxy: {
    label: '星系',
    path: '<path d="M12 4 A8 8 0 0 1 12 20 A4 4 0 0 0 12 12 A2 2 0 0 1 12 8"/>',
  },
  link: {
    label: '链接',
    path: '<circle cx="7" cy="7" r="3"/><circle cx="17" cy="17" r="3"/><line x1="9.2" y1="9.2" x2="14.8" y2="14.8"/>',
  },
  block: {
    label: '禁止',
    path: '<circle cx="12" cy="12" r="8"/><line x1="6.5" y1="6.5" x2="17.5" y2="17.5"/>',
  },
  lock: {
    label: '锁定',
    path: '<rect x="5" y="11" width="14" height="10" rx="1"/><path d="M8 11 L8 7 A4 4 0 0 1 16 7 L16 11"/><circle cx="12" cy="15" r="1.2" fill="currentColor"/>',
  },

  // ── File tree ──
  'folder-closed': {
    label: '文件夹',
    path: '<path d="M3 6 L9 6 L11 8 L21 8 L21 19 L3 19 Z"/>',
  },
  refresh: {
    label: '刷新',
    path: '<path d="M6 8 A6 6 0 0 1 18 8"/><polyline points="6,8 9,8 9,5"/><path d="M18 16 A6 6 0 0 1 6 16"/><polyline points="18,16 15,16 15,19"/>',
  },
  code: {
    label: '代码',
    path: '<polyline points="9,6 4,12 9,18"/><polyline points="15,6 20,12 15,18"/>',
  },
  'code-py': {
    label: 'Python',
    path: '<polyline points="9,6 4,12 9,18"/><polyline points="15,6 20,12 15,18"/><circle cx="12" cy="9" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="15" r="1" fill="currentColor"/>',
  },
  'code-rs': {
    label: 'Rust',
    path: '<polyline points="9,6 4,12 9,18"/><polyline points="15,6 20,12 15,18"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="10" y1="12" x2="14" y2="12"/>',
  },
  'code-go': {
    label: 'Go',
    path: '<polyline points="9,6 4,12 9,18"/><polyline points="15,6 20,12 15,18"/><circle cx="12" cy="12" r="2"/>',
  },
  copy: {
    label: '复制',
    path: '<circle cx="8" cy="14" r="6"/><circle cx="16" cy="10" r="6"/>',
  },

  // ── Git SCM ──
  'git-branch': {
    label: '分支',
    path: '<circle cx="7" cy="6" r="1.5" fill="currentColor"/><line x1="7" y1="7.5" x2="7" y2="16.5"/><circle cx="7" cy="18" r="1.5" fill="currentColor"/><circle cx="17" cy="6" r="1.5" fill="currentColor"/><path d="M7 10 A6 6 0 0 1 17 6"/>',
  },
  upload: {
    label: '推送',
    path: '<line x1="12" y1="4" x2="12" y2="14"/><polyline points="7,9 12,4 17,9"/><line x1="4" y1="19" x2="20" y2="19"/>',
  },
  download: {
    label: '拉取',
    path: '<line x1="12" y1="5" x2="12" y2="15"/><polyline points="7,10 12,15 17,10"/><line x1="4" y1="19" x2="20" y2="19"/>',
  },
  regenerate: {
    label: '重新生成',
    path: '<path d="M5 8 A7 7 0 0 1 19 6"/><polyline points="5,8 8,8 8,5"/><circle cx="15" cy="16" r="4"/><polyline points="13,16 15,14 17,16"/>',
  },
  'file-plus': {
    label: '附加文件',
    path: '<path d="M6 3 L14 3 L18 7 L18 21 L6 21 Z"/><path d="M14 3 L14 7 L18 7"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>',
  },

  // ── Hotspots ──
  fire: {
    label: '热点',
    path: '<circle cx="12" cy="14" r="2" fill="currentColor"/><line x1="12" y1="3" x2="12" y2="8"/><line x1="4" y1="8" x2="8" y2="11"/><line x1="20" y1="8" x2="16" y2="11"/><line x1="3" y1="14" x2="7" y2="14"/><line x1="21" y1="14" x2="17" y2="14"/><line x1="6" y1="20" x2="9" y2="17"/><line x1="18" y1="20" x2="15" y2="17"/>',
  },

  // ── Permissions ──
  shield: {
    label: '权限',
    path: '<path d="M5 4 L5 13 A7 7 0 0 0 19 13 L19 4 Z"/>',
  },
  puzzle: {
    label: '子Agent',
    path: '<circle cx="7" cy="12" r="4"/><circle cx="17" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  },
  keyboard: {
    label: '快捷键',
    path: '<rect x="3" y="6" width="18" height="12" rx="1"/><line x1="6" y1="10" x2="6" y2="12"/><line x1="9" y1="10" x2="9" y2="12"/><line x1="12" y1="10" x2="12" y2="12"/><line x1="15" y1="10" x2="15" y2="12"/><line x1="18" y1="10" x2="18" y2="12"/><line x1="7" y1="15" x2="17" y2="15"/>',
  },
  'export-file': {
    label: '导出',
    path: '<path d="M6 3 L6 21 L18 21 L18 7 L14 3 Z"/><path d="M14 3 L14 7 L18 7"/><line x1="12" y1="17" x2="12" y2="10"/><polyline points="9,13 12,10 15,13"/>',
  },
  trash: {
    label: '删除',
    path: '<line x1="5" y1="7" x2="19" y2="7"/><path d="M7 7 A5 5 0 0 0 17 7"/><path d="M8 7 L8 19"/><path d="M16 7 L16 19"/><line x1="6" y1="19" x2="18" y2="19"/>',
  },

  // ── File tree header ──
  'sort-toggle': {
    label: '排序',
    path: '<line x1="4" y1="7" x2="12" y2="7"/><line x1="4" y1="12" x2="16" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/><polyline points="17,5 20,8 17,11"/>',
  },
  'collapse-all': {
    label: '折叠全部',
    path: '<rect x="4" y="4" width="16" height="16" rx="1"/><polyline points="8,11 12,15 16,11"/>',
  },
  'expand-all': {
    label: '展开全部',
    path: '<rect x="4" y="4" width="16" height="16" rx="1"/><polyline points="8,15 12,11 16,15"/>',
  },

  // ── Dataflow ──
  dataflow: {
    label: '数据流',
    path: '<circle cx="5" cy="7" r="2"/><circle cx="19" cy="7" r="2"/><circle cx="12" cy="19" r="2"/><line x1="7" y1="8" x2="10" y2="17"/><line x1="17" y1="8" x2="14" y2="17"/><line x1="10" y1="17" x2="14" y2="17"/>',
  },
  'arrow-down': {
    label: '读取',
    path: '<line x1="12" y1="4" x2="12" y2="18"/><polyline points="7,13 12,18 17,13"/>',
  },
  'arrow-up': {
    label: '写入',
    path: '<line x1="12" y1="18" x2="12" y2="4"/><polyline points="7,9 12,4 17,9"/>',
  },
  'arrow-right': {
    label: '流向',
    path: '<line x1="4" y1="12" x2="18" y2="12"/><polyline points="13,7 18,12 13,17"/>',
  },
  layers: {
    label: '共享',
    path: '<ellipse cx="9" cy="9" rx="7" ry="5"/><ellipse cx="15" cy="15" rx="7" ry="5"/>',
  },
  zap: {
    label: '触发',
    path: '<line x1="5" y1="19" x2="19" y2="5"/><circle cx="5" cy="19" r="1" fill="currentColor"/><circle cx="19" cy="5" r="1" fill="currentColor"/><circle cx="12" cy="12" r="0.8" fill="currentColor"/>',
  },
  hourglass: {
    label: '等待',
    path: '<line x1="6" y1="4" x2="18" y2="4"/><line x1="6" y1="20" x2="18" y2="20"/><line x1="6" y1="4" x2="12" y2="12"/><line x1="18" y1="4" x2="12" y2="12"/><line x1="6" y1="20" x2="12" y2="12"/><line x1="18" y1="20" x2="12" y2="12"/>',
  },

  // ── Plan / Blueprint ──
  plan: {
    label: '规划',
    path: '<rect x="4" y="3" width="16" height="18" rx="1"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="16" x2="13" y2="16"/><line x1="10" y1="8" x2="10" y2="16"/>',
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
  if (!def) return `<span style="color:var(--obs-fail)">?</span>`;
  return `<svg class="hg-icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-label="${def.label}" role="img">${def.path}</svg>`;
}

/**
 * Returns the SVG string for a given icon name — used in innerHTML contexts.
 */
export function iconHtml(name: string, size = 15): string {
  return iconSvg(name, size);
}
