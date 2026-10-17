// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞浮动化（2026-09-17 用户拍板：全画布自由浮动 + 吸附边缘 + 双击复位，
// 锚线跟随重算）——**挂真实 PaperPanel 穿全层**的行为考官：坞位归属槽主人
// （paper-shell），坞本体一字不知（compose-dock 不动），故此处以一个假坞
// 贡献行占住 composer 槽 + 一个假目次带贡献行读让位带，考的是**槽主人**那条链：
//
//   ① 默认位：槽无内联 style（走 CSS 版心居中坐底）；
//   ② 让位带 --composer-band = 视口底 → 坞顶线（默认位 = 抬高 96 + 坞实测高），
//      并**下发到覆盖层消费面**（假目次带读到的值同源）；
//   ③ 按住坞书眉行拖动 → 坞位落内联 style（拖动中带 pp-composer-dragging）+
//      让位带随坞的实际位置重算 + 松手落 localStorage；
//   ④ 吸附：横向到右缘即吸；夹紧：拖出屏外不越界；
//   ⑤ 双击坞书眉行 = 复位（撤内联 + 清记忆）；
//   ⑥ 交互件/坞书眉之外不起拖（翰钮/输入行 textarea 按住不挪坞）。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { layoutMock, richStatsMock } = vi.hoisted(() => ({
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
  richStatsMock: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: layoutMock,
  clearCache: vi.fn(),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _mock: true })),
  walkLineRanges: vi.fn((_prepared: unknown, _width: number, cb: (l: unknown) => void) => {
    cb({ start: 0, end: 1, width: 100 });
  }),
  materializeLineRange: vi.fn(() => ({ width: 100, text: 'mock' })),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items })),
  measureRichInlineStats: richStatsMock,
}));

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));

// jsdom 无 Canvas 2D → 假 ctx（InkLayer/目次带墨迹都不数墨，只求不炸）
class Fake2dCtx {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  textBaseline = '';
  setTransform(): void {}
  clearRect(): void {}
  fillRect(): void {}
  fillText(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  stroke(): void {}
  strokeRect(): void {}
  closePath(): void {}
}
HTMLCanvasElement.prototype.getContext = function fakeGetContext() {
  return new Fake2dCtx();
} as unknown as typeof HTMLCanvasElement.prototype.getContext;

/** jsdom 无 ResizeObserver：记录实例 + 只对**创作坞槽**按需 flush（量坞实测宽高）。 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  private cb: () => void;
  private el: Element | null = null;
  constructor(cb: () => void) {
    this.cb = cb;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.el = el;
  }
  unobserve(): void {}
  disconnect(): void {}
  static flushComposerSlot(): void {
    for (const i of FakeResizeObserver.instances) {
      if (i.el?.classList.contains('pp-composer-slot')) i.cb();
    }
  }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

import { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { overlayServicePlugin } from '../src/composition/overlay-service';
import { Context } from '../src/cordis';
import { usePaperDock, usePaperRegion } from '../src/paper/overlay-context';
import { BAND_STYLE_ID, COMPOSER_BAND_CONSUMERS } from '../src/plugins/builtin/paper-shell/composer-band';
import { COMPOSER_POS_KEY } from '../src/plugins/builtin/paper-shell/composer-float';
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
import { getCanvasStore } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { useDockStore } from '../src/state/dock-store';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import type { ChatMessage, UserMessage } from '../src/ui/message-model';

function userMsg(id: string, text: string): UserMessage {
  return { role: 'user', _id: id, text, sessionIndex: 0 };
}

/** 假创作坞：结构照真坞（书眉行 + 输入行），只求占住 composer 槽与抓手命中面。 */
/** 假创作坞：结构照真坞（书眉行 + 输入行）+ **照能力位渲染拖动锁工具**
 *（真坞在 `.pp-dock-tools` 里渲染同一枚——锁态与写面在槽主人，坞只读能力位）。 */
function FakeDock() {
  const { composerLock } = usePaperDock();
  return (
    <div className="pp-composer">
      <div className="pp-composer-header">
        <span className="pp-composer-target">卷一</span>
        <div className="pp-composer-settings-spacer" />
        <div className="pp-dock-tools">
          {composerLock && (
            <button
              type="button"
              className={`pp-tool-btn${composerLock.unlocked ? ' open' : ''}`}
              aria-pressed={composerLock.unlocked}
              onClick={composerLock.toggle}
            >
              {composerLock.unlocked ? '锁' : '移'}
            </button>
          )}
          <button type="button" className="pp-tool-btn">
            翰
          </button>
        </div>
      </div>
      <div className="pp-composer-row">
        <textarea aria-label="输入" />
      </div>
    </div>
  );
}

/** 假目次带：把覆盖层消费面读到的坞几何落到 DOM——**锚线跟随重算**的端到端证据。
 *  2026-09-17 用户裁定「目次带不让位」：本假件读的是**让位带口径**（bottom + height），
 *  目次带真身只读 height（出厂底带）——两条口径分别有测试钉（stage4-toc-* 与本件）。 */
function FakeToc() {
  const { composerDock } = usePaperRegion();
  return (
    <div
      className="fake-toc"
      data-band={Math.round(composerDock.bottom + composerDock.height)}
      data-height={Math.round(composerDock.height)}
    />
  );
}

describe('创作坞浮动化（槽主人链路：坞位 + 让位带 + 手势）', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let overlayFiber: ReturnType<Context['plugin']> | null = null;
  /* jsdom 视口 = 坞位/夹紧/吸附的坐标基准（组件读的就是 window.innerWidth/Height）。 */
  const VW = window.innerWidth;
  const VH = window.innerHeight;
  const DOCK_W = 880;
  const DOCK_H = 110;
  const CENTER_LEFT = (VW - DOCK_W) / 2;

  beforeEach(async () => {
    localStorage.clear();
    FakeResizeObserver.instances = [];
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    useShellStore.setState({ projectPath: 'D:/composer-float-ws' });
    useDockStore.getState().closePanel('paper');

    const panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    const sess = getChatStore(panel.panelId).sess;
    sess.setState({ sessions: [{ id: 1, label: '卷一' }], activeIdx: 0, nextSessionId: 2 });
    msgStoreFor(panel.panelId, 1)
      .getState()
      .setMessages([userMsg('u1', '起一卷。')] as ChatMessage[]);
    getCanvasStore(panel.panelId).getState().setRegion('1', { anchorX: 0, anchorY: 0, width: 720 });

    const view = useCanvasViewStore;
    view.getState().setCanvasSize(VW, VH);
    view.getState().restoreView({ zoom: 1, panX: 600, panY: 450 });

    // 覆盖层贡献行：假坞（composer 槽）+ 假目次带（right-edge 槽）
    const ctx = new Context();
    const fiber = ctx.plugin(overlayServicePlugin);
    await fiber;
    ctx.overlays.register({ id: 'fake-dock', slot: 'composer', component: FakeDock });
    ctx.overlays.register({ id: 'fake-toc', slot: 'right-edge', component: FakeToc });
    overlayFiber = fiber;
  });

  afterEach(async () => {
    if (root) {
      void act(() => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    await overlayFiber?.dispose();
    overlayFiber = null;
    document.documentElement.style.removeProperty('--composer-band');
    document.getElementById(BAND_STYLE_ID)?.remove();
  });

  /** 挂纸壳 + 把槽实测矩形钉成真尺寸（jsdom 无布局：RO 桩 + 实例方法覆盖）。 */
  async function mount(): Promise<HTMLDivElement> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PaperPanel />);
    });
    await act(async () => {
      useCanvasViewStore.getState().setCanvasSize(VW, VH);
    });
    const slot = container.querySelector('.pp-composer-slot') as HTMLDivElement;
    expect(slot).not.toBeNull();
    slot.getBoundingClientRect = () => rectOf(CENTER_LEFT, VH - 96, DOCK_W, DOCK_H); // 默认位：居中 + 坐底抬高 96
    await act(async () => {
      FakeResizeObserver.flushComposerSlot();
    });
    return slot;
  }

  function rectOf(left: number, bottom: number, w: number, h: number): DOMRect {
    return {
      left,
      top: bottom - h,
      right: left + w,
      bottom,
      width: w,
      height: h,
      x: left,
      y: bottom - h,
      toJSON: () => ({}),
    } as DOMRect;
  }

  function fire(el: EventTarget, type: string, init: Record<string, unknown>): void {
    act(() => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
    });
  }

  /** 让位带读数（**行为级**：照真消费者的样子在 `.psh-host` 上读**解析后**的值）。
   *  载体是「只命中让位消费面的一条规则」（`composer-band.ts`，2026-10-18 性能批），
   *  **不是** `:root` 内联——后者在拖动期是 62ms/帧的全树样式重算，是用户报
   *  「一顿一顿」的病灶。此处刻意不读载体内幕：换实现只要消费面读得到，测试不动。 */
  function bandVar(): string {
    const host = document.createElement('div');
    host.className = 'psh-host';
    document.body.appendChild(host);
    const value = getComputedStyle(host).getPropertyValue('--composer-band').trim();
    host.remove();
    return value;
  }
  function tocBand(): string | null {
    return container?.querySelector('.fake-toc')?.getAttribute('data-band') ?? null;
  }
  function drag(target: Element, from: { x: number; y: number }, to: { x: number; y: number }): void {
    fire(target, 'pointerdown', { button: 0, clientX: from.x, clientY: from.y });
    fire(window, 'pointermove', { clientX: to.x, clientY: to.y });
    fire(window, 'pointerup', { clientX: to.x, clientY: to.y });
  }
  /** 拖动锁工具（坞书眉工具行里的第三枚单字钮：`移` ↔ `锁`）：
   *  常显可点，不做悬停浮现——悬停浮现会因「揭示与命中互为前提」死锁（用户实机报）。 */
  function lockBtn(slot: HTMLDivElement): HTMLButtonElement {
    return slot.querySelector('.pp-dock-tools .pp-tool-btn') as HTMLButtonElement;
  }
  function unlock(slot: HTMLDivElement): void {
    fire(lockBtn(slot), 'click', { button: 0 });
  }

  it('默认位：槽无内联 style（走 CSS 版心居中坐底），让位带 = 抬高 + 坞实测高', async () => {
    const slot = await mount();
    expect(slot.style.left).toBe('');
    expect(slot.style.bottom).toBe('');
    // 让位带：96（抬高）+ 110（坞实测高）= 206 → 下发给 CSS 消费面与覆盖层消费面
    expect(bandVar()).toBe('206px');
    expect(tocBand()).toBe('206');
    /* 过渡期旧 token（2026-09-17）：外壳 CSS 内嵌在 exe 里不能热更，旧口径由槽主人
     * 代发一版——**本断言与 use-composer-float 的「过渡期旧 token 代发」effect 同生共死**
     * （下一次整包重编后两边一起删；它红了就是在提醒这件事）。 */
    expect(document.documentElement.style.getPropertyValue('--composer-h-live')).toBe('110px');
  });

  it('拖动锁（用户方案）：默认锁定——坞对鼠标零响应，随手拖坞不改坞位、不落盘', async () => {
    const slot = await mount();
    expect(slot.className).not.toContain('pp-composer-unlocked');
    expect(lockBtn(slot).textContent).toBe('移'); // 文案 = 点下去会发生什么（同「拟文/停」语言）
    expect(lockBtn(slot).getAttribute('aria-pressed')).toBe('false');
    // 锁定态：拖坞体任意处都不动（这就是「谁都不知道这东西能拖动」的反面——不会误拖）
    drag(slot.querySelector('.pp-composer-target') as Element, { x: 300, y: 660 }, { x: 500, y: 400 });
    expect(slot.style.left).toBe('');
    expect(slot.style.bottom).toBe('');
    expect(localStorage.getItem(COMPOSER_POS_KEY)).toBeNull();
  });

  it('解锁：坞体任意空白处拖动都算（不再只有书眉行）+ 拖动期全页禁选 + 松手落盘', async () => {
    const slot = await mount();
    unlock(slot);
    expect(slot.className).toContain('pp-composer-unlocked');
    expect(lockBtn(slot).textContent).toBe('锁');
    expect(lockBtn(slot).getAttribute('aria-pressed')).toBe('true');

    // 从坞体任意空白处（输入行/设置行之间的坞体）起拖——用户报的「毫无反应」由此解决
    const dock = slot.querySelector('.pp-composer') as HTMLElement;
    fire(dock, 'pointerdown', { button: 0, clientX: 300, clientY: 660 });
    fire(window, 'pointermove', { clientX: 300, clientY: 560 }); // 上移 100
    expect(slot.style.left).toBe('72px');
    expect(slot.style.bottom).toBe('196px');
    expect(slot.className).toContain('pp-composer-dragging');
    /* 拖动期全页禁选（html 挂类，规则在 PaperPanel.css）——**用户报的第一条冲突**
     *（坞上按下带出纸上选区 → document 级 selectionchange 唤醒选中浮钮）的根治处。 */
    expect(document.documentElement.classList.contains('pp-composer-dragging')).toBe(true);
    expect(bandVar()).toBe('306px'); // 196 + 110
    expect(tocBand()).toBe('306');
    fire(window, 'pointerup', { clientX: 300, clientY: 560 });
    expect(slot.className).not.toContain('pp-composer-dragging');
    expect(document.documentElement.classList.contains('pp-composer-dragging')).toBe(false);
    expect(JSON.parse(localStorage.getItem(COMPOSER_POS_KEY) as string)).toEqual({ left: 72, bottom: 196 });
  });

  it('解锁态持久（重开仍解锁）；再点回锁定则坞又不可拖', async () => {
    const slot = await mount();
    unlock(slot);
    expect(localStorage.getItem('lantai.composer.unlocked')).toBe('1');
    fire(lockBtn(slot), 'click', { button: 0 });
    expect(slot.className).not.toContain('pp-composer-unlocked');
    expect(localStorage.getItem('lantai.composer.unlocked')).toBeNull();
    drag(slot.querySelector('.pp-composer-target') as Element, { x: 300, y: 660 }, { x: 500, y: 400 });
    expect(slot.style.left).toBe('');
  });

  it('吸附边缘（右缘）与夹紧（拖出屏外不越界）', async () => {
    const slot = await mount();
    unlock(slot);
    const head = slot.querySelector('.pp-composer-target') as HTMLElement;
    // 起点坞位 left=72（居中）→ +60 = 132：右缘目标 136 在阈内 ⇒ 吸附
    drag(head, { x: 300, y: 660 }, { x: 360, y: 660 });
    expect(slot.style.left).toBe('136px');
    // 拖出屏外：夹在屏缘（左 8）
    drag(head, { x: 136, y: 660 }, { x: -2000, y: 660 });
    expect(slot.style.left).toBe('8px');
    drag(head, { x: 8, y: 660 }, { x: 4000, y: 660 });
    expect(slot.style.left).toBe('136px');
    // 上夹紧：顶部浮件带 56 + 屏缘 8 —— 坞顶不得挤进浮件带（浮件在右上，
    // 压上去会把设置/回首页/窗口钮盖死——窗口钮是唯一的关闭入口）
    drag(head, { x: 300, y: 400 }, { x: 300, y: -5000 });
    const topPx = VH - Number.parseFloat(slot.style.bottom) - DOCK_H;
    expect(topPx).toBe(56 + 8);
  });

  it('双击坞体 = 复位：撤内联坞位 + 清记忆 + 让位带回默认位', async () => {
    const slot = await mount();
    unlock(slot);
    const head = slot.querySelector('.pp-composer-target') as HTMLElement;
    drag(head, { x: 300, y: 660 }, { x: 400, y: 400 });
    expect(localStorage.getItem(COMPOSER_POS_KEY)).not.toBeNull();
    fire(head, 'dblclick', { button: 0 });
    expect(slot.style.left).toBe('');
    expect(slot.style.bottom).toBe('');
    expect(localStorage.getItem(COMPOSER_POS_KEY)).toBeNull();
    expect(bandVar()).toBe('206px');
  });

  it('让位带载体（2026-10-18 性能批）：不写 :root 内联，只下发到命中让位消费面的那条规则', async () => {
    const slot = await mount();
    /* 消费面读得到（解析后的值 = 真值；载体形状不是测试对象）。 */
    expect(bandVar()).toBe('206px');
    /* 性能契约：`:root` 上**没有**这个变量——旧载体在拖动期每帧触发整棵文档树的
     * 样式重算（本机实测 62ms/帧、28 次 64ms 长任务 ⇒ 用户报的「一顿一顿」）。 */
    expect(document.documentElement.style.getPropertyValue('--composer-band')).toBe('');
    expect(document.documentElement.getAttribute('style') ?? '').not.toContain('--composer-band');
    const carrier = document.getElementById(BAND_STYLE_ID) as HTMLStyleElement | null;
    expect(carrier?.sheet?.cssRules[0].selectorText).toBe(COMPOSER_BAND_CONSUMERS);

    /* 拖动期**逐帧**下发（不是只在松手时补一次）：坞上移 100 ⇒ 让位带 206 → 306。 */
    unlock(slot);
    const dock = slot.querySelector('.pp-composer') as HTMLElement;
    fire(dock, 'pointerdown', { button: 0, clientX: 300, clientY: 660 });
    fire(window, 'pointermove', { clientX: 300, clientY: 560 });
    expect(bandVar()).toBe('306px');
    fire(window, 'pointerup', { clientX: 300, clientY: 560 });

    /* 槽卸载（paper 关闭）= 撤载体 ⇒ 消费面回落到 CSS 里的静态兜底算式。 */
    await act(async () => {
      root?.unmount();
    });
    root = null;
    expect(document.getElementById(BAND_STYLE_ID)).toBeNull();
    expect(bandVar()).toBe('');
  });

  it('解锁态：坞内交互件仍不承载拖坞手势（翰钮/输入框）', async () => {
    const slot = await mount();
    unlock(slot);
    const btn = slot.querySelector('.pp-tool-btn') as HTMLElement;
    drag(btn, { x: 300, y: 660 }, { x: 700, y: 400 });
    expect(slot.style.left).toBe('');
    expect(localStorage.getItem(COMPOSER_POS_KEY)).toBeNull();

    const ta = slot.querySelector('textarea') as HTMLElement;
    drag(ta, { x: 300, y: 700 }, { x: 700, y: 400 });
    expect(slot.style.left).toBe('');
    expect(localStorage.getItem(COMPOSER_POS_KEY)).toBeNull();
  });
});
