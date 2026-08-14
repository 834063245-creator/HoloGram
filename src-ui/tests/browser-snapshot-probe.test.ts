// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// snapshot.js 是注入页面的探针；没有 Windows/Chrome 真机时，本测试用 jsdom
// 保障 Linux 上能覆盖「可访问名称 + iframe/shadow DOM 遍历」的回退路径。
// 真实 Chrome 的 AX 优先路径由 cdp/e2e.rs E2E-4 在可用环境验证。
const source = readFileSync(resolve(process.cwd(), '../src-tauri/src/cdp/probes/snapshot.js'), 'utf8');
// eslint-disable-next-line no-new-func
const snapshotProbe = new Function(`return (${source});`)() as (
  scope: string,
  maxResults: number,
  offset: number,
) => {
  source: string;
  refs: Array<{ ref: number; tag: string; role: string; name: string; text: string; id?: string }>;
  count: number;
  total: number;
  offset: number;
  truncated: boolean;
};

const DOM_RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 120,
  bottom: 24,
  width: 120,
  height: 24,
} as DOMRect;

function makeRect(rect: DOMRect | undefined): DOMRect {
  return rect ?? DOM_RECT;
}

let restoreRect: (() => void) | undefined;

beforeEach(() => {
  document.body.innerHTML = '';
  const proto = Element.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'getBoundingClientRect');
  const original = desc?.value as (() => DOMRect) | undefined;
  Object.defineProperty(proto, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element) {
      const local = (this as Element & { __hgTestRect?: DOMRect }).__hgTestRect;
      return makeRect(local);
    },
  });
  restoreRect = () => {
    if (desc) Object.defineProperty(proto, 'getBoundingClientRect', desc);
    else delete (proto as Record<string, unknown>).getBoundingClientRect;
    void original;
  };
});

afterEach(() => {
  restoreRect?.();
  restoreRect = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function setRect(el: Element, rect?: DOMRect) {
  (el as Element & { __hgTestRect?: DOMRect }).__hgTestRect = rect;
}

describe('browser snapshot 探针（DOM 回退路径）', () => {
  it('计算可访问名称与 DOM 可推导 role', () => {
    document.body.innerHTML = `
      <label for="name">Your name</label><input id="name">
      <button id="icon" aria-label="Save icon">💾</button>
      <a id="link" href="/more">Read more</a>
      <input id="chk" type="checkbox">
      <span id="role-tab" role="tab">Tab one</span>
      <span id="delete-label">Delete item</span>
      <button id="delete-btn" aria-labelledby="delete-label">×</button>
    `;
    const result = snapshotProbe('', 20, 0);

    expect(result.source).toBe('dom');
    const byId = (id: string) => result.refs.find((r) => r.id === id);
    expect(byId('name')?.name).toBe('Your name');
    expect(byId('name')?.role).toBe('textbox');
    expect(byId('icon')?.name).toBe('Save icon');
    expect(byId('icon')?.role).toBe('button');
    expect(byId('link')?.name).toBe('Read more');
    expect(byId('link')?.role).toBe('link');
    expect(byId('chk')?.role).toBe('checkbox');
    expect(byId('role-tab')?.role).toBe('tab');
    expect(byId('role-tab')?.name).toBe('Tab one');
    expect(byId('delete-btn')?.name).toBe('Delete item');
    // ref 必须真实回写到 DOM，click/type 才能按 [data-hg-ref="N"] 找到
    const btn = document.getElementById('icon')!;
    const ref = byId('icon')!.ref;
    expect(btn.getAttribute('data-hg-ref')).toBe(String(ref));
  });

  it('遍历 same-origin iframe 与 open shadow root 并统一编号', () => {
    const host = document.createElement('div');
    host.id = 'shadow-host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button id="shadow-btn">Shadow action</button>';
    const shadowBtn = shadow.getElementById('shadow-btn')!;
    setRect(shadowBtn);

    const iframe = document.createElement('iframe');
    iframe.id = 'frame';
    document.body.appendChild(iframe);
    const frameDoc = document.implementation.createHTMLDocument('frame');
    frameDoc.body.innerHTML = '<button id="frame-btn">Frame action</button>';
    const frameBtn = frameDoc.getElementById('frame-btn')!;
    setRect(frameBtn);
    Object.defineProperty(iframe, 'contentDocument', { configurable: true, value: frameDoc });

    const result = snapshotProbe('', 20, 0);
    const refs = result.refs;
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.id).sort()).toEqual(['frame-btn', 'shadow-btn']);
    expect(frameBtn.getAttribute('data-hg-ref')).not.toBeNull();
    expect(shadowBtn.getAttribute('data-hg-ref')).not.toBeNull();
    expect(refs.map((r) => r.name).sort()).toEqual(['Frame action', 'Shadow action']);
  });

  it('scope 无匹配返回明确错误而不抛异常', () => {
    document.body.innerHTML = '<button>Main</button>';
    const result = snapshotProbe('#not-exist', 20, 0);
    expect(result.source).toBe('dom');
    expect(result.refs).toHaveLength(0);
    expect('error' in result).toBe(true);
  });
});
