// 页面快照探针 — 由 cdp.rs 经 include_str! 嵌入，注入页面执行。
// 收集可交互元素 → 打 data-hg-ref 标记 → 返回 {refs, count, truncated}。
// 操作按 ref 引用（纯数字/ref:N 会转成 [data-hg-ref="N"]）；DOM 变化后
// ref 失效，操作会返回"请重新 snapshot"的错误。
// 语法由 src-tauri/src/cdp.rs 的 #[cfg(test)] probes_are_valid_javascript
// 用 node --check 强制验证——改坏语法 cargo test 必红。
(scope, maxResults) => {
  const max = maxResults || 80;
  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) return { refs: [], count: 0, error: 'scope 选择器无匹配' };
  // 清除本 root 下的旧标记，避免过期 ref 残留
  root.querySelectorAll('[data-hg-ref]').forEach((el) => el.removeAttribute('data-hg-ref'));
  const INTERACTIVE =
    'a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"], [onclick], label';
  const els = Array.from(root.querySelectorAll(INTERACTIVE)).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).slice(0, max);
  const refs = els.map((el, i) => {
    el.setAttribute('data-hg-ref', String(i));
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' || tag === 'button' ? (el.type || '') : null;
    const text = (
      el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || ''
    ).trim().slice(0, 60);
    const out = { ref: i, tag, text };
    if (type) out.type = type;
    if (el.id) out.id = el.id;
    return out;
  });
  return { refs, count: refs.length, truncated: els.length >= max, note: '用 ref 数字引用元素操作（如 click(selector: "37")）；ref 仅在本次 snapshot 后有效' };
}
