// 页面快照探针 — 由 cdp.rs 经 include_str! 嵌入，注入页面执行。
// 收集可交互元素 → 打 data-hg-ref 标记 → 返回 {source, refs, count, total, offset, truncated}。
// 操作按 ref 引用（纯数字/ref:N 会转成 [data-hg-ref="N"]）；DOM 变化后
// ref 失效，操作会返回"请重新 snapshot"的错误。
// 分页（B4）：offset 跳过前 N 个匹配项，maxResults 限定本次窗口。
// total 返回全量匹配数，truncated = 是否还有后续窗口（offset+max<total），
// 模型据此决定是否带 offset 取下一页。ref 在当前窗口内从 0 重新编号。
// 二轮评审第三批增强：
//   - 遍历 same-origin iframe / frame 与 open shadow root（跨文档打 ref）；
//   - 按浏览器可访问名称算法补 name / role（aria-labelledby、label[for]、
//     aria-label、alt/title/placeholder/value 等），纯图标按钮不再 text 为空。
// cdp.rs 会优先尝试 Accessibility.getFullAXTree；AX 不可用时回退本探针。
// 语法由 src-tauri/src/cdp.rs 的 #[cfg(test)] probes_are_valid_javascript
// 用 node --check 强制验证——改坏语法 cargo test 必红。
(scope, maxResults, offset) => {
  const max = maxResults || 80;
  const off = offset || 0;
  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) return { source: 'dom', refs: [], count: 0, total: 0, offset: off, error: 'scope 选择器无匹配' };
  const INTERACTIVE =
    'a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [onclick], label';

  // 收集所有要扫描的根（主文档 root + same-origin iframe 文档 + open shadow roots）
  const roots = [];
  const seenRoots = new Set();
  const walk = (r) => {
    if (!r || seenRoots.has(r)) return;
    seenRoots.add(r);
    roots.push(r);
    if (!r.querySelectorAll) return;
    for (const f of r.querySelectorAll('iframe, frame')) {
      try {
        if (f.contentDocument) walk(f.contentDocument);
      } catch (e) {}
    }
    for (const el of r.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);

  // 清除本次扫描范围内旧 ref（含 iframe/shadow，避免跨文档残留）
  roots.forEach((r) => {
    if (r.querySelectorAll) {
      r.querySelectorAll('[data-hg-ref]').forEach((el) => el.removeAttribute('data-hg-ref'));
    }
  });

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  // 可访问名称（accessible name）简化算法：aria-labelledby > aria-label >
  // label[for] > 包裹 label > alt > title/placeholder > value > 可见文本。
  const accName = (el) => {
    const doc = el.ownerDocument || document;
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const fromIds = labelledby.split(/\s+/).map((id) => {
        const ref = doc.getElementById(id);
        return ref ? norm(ref.textContent) : '';
      }).filter(Boolean).join(' ');
      if (fromIds) return fromIds;
    }
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;
    const tag = (el.tagName || '').toLowerCase();
    if (el.id) {
      const labels = Array.from(doc.querySelectorAll('label'))
        .filter((l) => l.htmlFor === el.id)
        .map((l) => norm(l.textContent))
        .filter(Boolean);
      if (labels.length) return labels.join(' ');
    }
    const wrapped = el.closest ? el.closest('label') : null;
    if (wrapped) {
      const labelText = norm(wrapped.textContent);
      if (labelText) return labelText;
    }
    if ((tag === 'img' || tag === 'area' || tag === 'input') && el.getAttribute('alt')) {
      const alt = norm(el.getAttribute('alt'));
      if (alt) return alt;
    }
    const title = norm(el.getAttribute('title'));
    if (title) return title;
    const placeholder = norm(el.getAttribute('placeholder'));
    if (placeholder) return placeholder;
    if (tag === 'input' && /^(button|submit|reset)$/i.test(el.type || '')) {
      const v = norm(el.getAttribute('value'));
      if (v) return v;
    }
    const visible = norm(el.innerText || el.textContent);
    if (visible) return visible;
    const value = norm(el.value);
    return value;
  };

  // DOM 可推导 role（AX 成功路径不经过这里，role 由 CDP AX 树给）
  const domRole = (el) => {
    const explicit = (el.getAttribute && el.getAttribute('role') || '').trim().toLowerCase();
    if (explicit) return explicit;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'a' && el.getAttribute('href')) return 'link';
    if (tag === 'button' || (tag === 'input' && /^(button|submit|reset|image)$/i.test(el.type || ''))) return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea' || el.getAttribute('contenteditable') === 'true') return 'textbox';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'search') return 'searchbox';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      return 'textbox';
    }
    return '';
  };

  // 去重后过滤可见元素（iframe 内的元素 rect 可能是局部坐标，但 width/height 仍可信）
  const all = [];
  roots.forEach((r) => {
    if (r.querySelectorAll) all.push(...Array.from(r.querySelectorAll(INTERACTIVE)));
    if (r.matches && r.matches(INTERACTIVE)) all.push(r);
  });
  const unique = Array.from(new Set(all));
  const visible = unique.filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const total = visible.length;
  const els = visible.slice(off, off + max);
  const refs = els.map((el, i) => {
    el.setAttribute('data-hg-ref', String(i));
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' || tag === 'button' ? (el.type || '') : null;
    const name = accName(el);
    const text = name || norm(el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || '');
    const out = { ref: i, tag, role: domRole(el), name, text: text.slice(0, 80) };
    if (type) out.type = type;
    if (el.id) out.id = el.id;
    return out;
  });
  return {
    source: 'dom',
    refs, count: refs.length, total, offset: off,
    truncated: off + max < total,
    note: '用 ref 数字引用元素操作（如 click(selector: "37")）；ref 仅在本次 snapshot 后有效；如 truncated=true 可用 offset 取下一页；已含 iframe/shadow DOM 元素与可访问名称',
  };
}
