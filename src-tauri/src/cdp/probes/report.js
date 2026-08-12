// 视觉 lint 探针 — 由 cdp.rs 经 include_str! 嵌入，注入页面执行。
// 单一来源：外部 CDP 通道与 webview self 通道共用（见 ADR 0003 D4/D7）。
// 语法由 src-tauri/src/cdp.rs 的 #[cfg(test)] probes_are_valid_javascript
// 用 node --check 强制验证——改坏语法 cargo test 必红。
(scope) => {
  const issues = [];
  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) return { issues: [{ rule: 'scope', severity: 'error', detail: 'scope 选择器无匹配' }], ok: false };
  const SPACING_SCALE = [4, 8, 12, 16, 24, 32, 48];
  const px = (v) => { const m = String(v).match(/^([\d.]+)px$/); return m ? parseFloat(m[1]) : null; };
  const onScale = (v) => { const n = px(v); if (n === null) return true; return SPACING_SCALE.some((s) => Math.abs(s - n) <= 1); };
  const parseColor = (c) => {
    const m = String(c).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
    if (a < 0.5) return null;
    return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
  };
  const lum = (rgb) => {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const contrast = (a, b) => {
    const la = lum(a), lb = lum(b);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  };
  const shortPath = (el) => {
    if (el.id) return '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 2).join('.') : '';
    let s = el.tagName.toLowerCase();
    if (cls) s += '.' + cls;
    return s + ' <' + (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) + '>';
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  // 收集可见元素（深度优先，限制 500 个防卡死）
  const all = [];
  const walk = (el) => {
    if (all.length >= 500) return;
    if (el.children.length === 0 && el.textContent.trim()) all.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  // 1. 对比度
  const contrastIssues = [];
  for (const el of all) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    const fg = parseColor(cs.color);
    const bg = parseColor(cs.backgroundColor) || parseColor(getComputedStyle(el.parentElement || el).backgroundColor);
    if (fg && bg) {
      const r = contrast(fg, bg);
      if (r < 4.5) {
        contrastIssues.push({ rule: 'contrast', severity: 'warn', detail: `对比度 ${r.toFixed(2)}:1 < 4.5:1`, selector: shortPath(el) });
      }
    }
  }
  issues.push(...contrastIssues.slice(0, 8));
  // 2. 间距纪律（抽查主要块元素）
  const spacingIssues = [];
  const blocks = Array.from(root.querySelectorAll('div, section, article, header, footer, main, aside')).filter(vis).slice(0, 200);
  for (const el of blocks) {
    const cs = getComputedStyle(el);
    for (const p of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'marginTop', 'marginBottom']) {
      const v = cs[p];
      if (!onScale(v)) {
        spacingIssues.push({ rule: 'spacing', severity: 'info', detail: `${p} = ${v}（不在 4/8/12/16/24/32 刻度上）`, selector: shortPath(el) });
        break; // 每个元素只报一次
      }
    }
  }
  issues.push(...spacingIssues.slice(0, 6));
  // 3. 对齐检测：同行元素的左缘偏差
  const alignIssues = [];
  const rows = new Map();
  for (const el of blocks.slice(0, 100)) {
    const r = el.getBoundingClientRect();
    const key = Math.round(r.y / 20); // 20px 行桶
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ x: Math.round(r.x), el });
  }
  for (const [, group] of rows) {
    if (group.length >= 2) {
      const xs = [...new Set(group.map((g) => g.x))];
      if (xs.length >= 2 && Math.max(...xs) - Math.min(...xs) > 2) {
        alignIssues.push({ rule: 'alignment', severity: 'warn', detail: `同行元素左缘偏差 ${Math.max(...xs) - Math.min(...xs)}px`, selector: group.map((g) => shortPath(g.el)).join(', ') });
      }
    }
  }
  issues.push(...alignIssues.slice(0, 5));
  // 4. 层级：box-shadow 过重 / 过多同级阴影
  const shadowCounts = {};
  for (const el of blocks.slice(0, 150)) {
    const cs = getComputedStyle(el);
    const sh = cs.boxShadow;
    if (sh && sh !== 'none') shadowCounts[sh] = (shadowCounts[sh] || 0) + 1;
  }
  const heavy = Object.entries(shadowCounts).filter(([, c]) => c >= 5);
  for (const [sh, c] of heavy) {
    issues.push({ rule: 'hierarchy', severity: 'info', detail: `${c} 个元素使用相同阴影 ${sh.slice(0, 60)} — 视觉上无焦点`, selector: '—' });
  }
  // 5. 溢出
  const overflowIssues = [];
  for (const el of blocks.slice(0, 100)) {
    if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) {
      const cs = getComputedStyle(el);
      if (cs.overflow === 'visible' || cs.overflowX === 'visible') {
        overflowIssues.push({ rule: 'overflow', severity: 'warn', detail: `内容溢出 ${el.scrollWidth - el.clientWidth}px 宽 / ${el.scrollHeight - el.clientHeight}px 高`, selector: shortPath(el) });
      }
    }
  }
  issues.push(...overflowIssues.slice(0, 5));
  return { issues: issues.slice(0, 30), ok: issues.length === 0 };
}
