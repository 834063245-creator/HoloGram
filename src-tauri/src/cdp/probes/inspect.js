// 元素检查探针 — 由 cdp.rs 经 include_str! 嵌入，注入页面执行。
// 单一来源：外部 CDP 通道与 webview self 通道共用（见 ADR 0003 D4/D7）。
// 语法由 src-tauri/src/cdp.rs 的 #[cfg(test)] probes_are_valid_javascript
// 用 node --check 强制验证——改坏语法 cargo test 必红。
(selector, props, maxResults) => {
  const max = maxResults || 20;
  const els = Array.from(document.querySelectorAll(selector)).slice(0, max);
  const want = (k) => !props || props.length === 0 || props.includes(k);
  const parseColor = (c) => {
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
    if (a < 0.5) return null; // 半透明背景无法可靠计算
    return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
  };
  const lum = (rgb) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const contrast = (a, b) => {
    const la = lum(a), lb = lum(b);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  };
  return els.map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const out = { tag: el.tagName.toLowerCase(), selector };
    if (el.id) out.id = el.id;
    if (want('geometry')) {
      out.rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      out.visible = r.width > 0 && r.height > 0;
      const sr = el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
      out.scrollable = sr;
    }
    if (want('style')) {
      out.style = {
        color: cs.color, background: cs.backgroundColor, fontSize: cs.fontSize,
        fontWeight: cs.fontWeight, lineHeight: cs.lineHeight,
        padding: cs.padding, margin: cs.margin,
        borderRadius: cs.borderRadius, boxShadow: cs.boxShadow, gap: cs.gap,
      };
    }
    if (want('text')) {
      out.text = (el.textContent || '').trim().slice(0, 200);
    }
    if (want('contrast')) {
      const fg = parseColor(cs.color);
      const bg = parseColor(cs.backgroundColor) || parseColor(getComputedStyle(el.parentElement || el).backgroundColor);
      if (fg && bg) out.contrast = Math.round(contrast(fg, bg) * 100) / 100;
    }
    return out;
  });
}
