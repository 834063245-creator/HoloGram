// 页面正文提取探针 — 由 cdp.rs 经 include_str! 嵌入，注入页面执行。
// 支持 text / markdown-lite 两种形态 + selector scope + 按字符分页。
// 返回 {title,url,format,offset,maxChars,total,truncated,text|markdown}。
// 契约：调用方用 JSON.stringify 包裹 + returnByValue 取字符串（ADR 0003 D7）。
// 语法由 src-tauri/src/cdp.rs 的 #[cfg(test)] probes_are_valid_javascript
// 用 node --check 强制验证——改坏语法 cargo test 必红。
(scope, format, offset, maxChars) => {
  const root = scope ? document.querySelector(scope) : document.body;
  const title = (document.title || '').slice(0, 500);
  const url = (location.href || '').slice(0, 2000);
  if (!root) {
    return { title, url, format: 'text', offset: 0, maxChars: 0, total: 0, truncated: false, text: '', error: 'scope 选择器无匹配' };
  }

  const fmt = format === 'markdown' ? 'markdown' : 'text';
  const off = Math.max(0, offset || 0);
  const max = Math.max(0, Math.min(maxChars || 8000, 20000));
  const normalize = (s) => String(s)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const markdownLite = (el) => {
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE', 'LINK', 'META']);
    const clone = el.cloneNode(true);
    const out = [];
    const visit = (node, indent) => {
      if (out.length > 8000) return; // 防呆：markdown 分页只取前 20k 字符，生成 8000 行足够覆盖
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        if (t) out.push(t);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (SKIP.has(tag.toUpperCase())) return;
      if (tag === 'br') {
        out.push('\n');
        return;
      }
      if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
        const level = Number(tag.slice(1));
        out.push('\n' + '#'.repeat(level) + ' ' + (node.textContent || '').trim().replace(/\s+/g, ' ') + '\n');
        return;
      }
      if (tag === 'pre') {
        out.push('\n```\n' + (node.textContent || '').trimEnd() + '\n```\n');
        return;
      }
      if (tag === 'img') {
        const alt = node.getAttribute('alt') || '';
        const src = node.getAttribute('src') || '';
        if (alt || src) out.push('![' + alt + '](' + src + ')');
        return;
      }
      if (tag === 'a') {
        const text = (node.textContent || '').trim().replace(/\s+/g, ' ');
        const href = node.getAttribute('href') || '';
        if (text) out.push(href && /^https?:/i.test(href) ? '[' + text + '](' + href + ')' : text);
        return;
      }
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const value = tag === 'select' && node.selectedOptions && node.selectedOptions[0]
          ? node.selectedOptions[0].textContent
          : node.value || node.getAttribute('placeholder') || '';
        if (value) out.push('[' + tag + ': ' + String(value).trim() + ']');
        return;
      }
      if (tag === 'li') {
        out.push('\n' + '  '.repeat(Math.min(indent, 4)) + '- ' + (node.textContent || '').trim().replace(/\s+/g, ' '));
        return;
      }
      if (tag === 'blockquote') {
        const text = (node.textContent || '').trim().replace(/\s+/g, ' ');
        if (text) out.push('\n> ' + text + '\n');
        return;
      }
      if (tag === 'table') {
        const rows = Array.from(node.querySelectorAll('tr')).slice(0, 50).map((tr) =>
          Array.from(tr.querySelectorAll('th,td')).map((td) => (td.textContent || '').trim().replace(/\s+/g, ' ')).join(' | ')
        );
        if (rows.length) out.push('\n' + rows.join('\n') + '\n');
        return;
      }
      // 块级元素作为换行边界；inline 递归拼接
      const block = /^(p|div|section|article|main|header|footer|nav|aside|ul|ol|dl|dt|dd|tr|form|figure|figcaption|details|summary)$/.test(tag);
      if (block && out.length > 0 && out[out.length - 1] !== '\n') out.push('\n');
      for (const child of node.childNodes) visit(child, indent + (tag === 'ul' || tag === 'ol' ? 1 : 0));
      if (block && out.length > 0 && out[out.length - 1] !== '\n') out.push('\n');
    };
    visit(clone, 0);
    return out.join(' ').replace(/ \n/g, '\n').replace(/\n +/g, '\n');
  };

  const full = fmt === 'markdown' ? markdownLite(root) : (root.innerText || root.textContent || '');
  const normalized = normalize(full);
  const total = normalized.length;
  const slice = normalized.slice(off, off + max);
  const result = {
    title,
    url,
    format: fmt,
    offset: off,
    maxChars: max,
    total,
    truncated: off + max < total,
  };
  result[fmt] = slice;
  if (scope) result.scope = scope;
  return result;
}
