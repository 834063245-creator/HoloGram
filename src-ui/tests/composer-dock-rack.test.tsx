// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composer-dock-rack.test.tsx — 图版架（资产收纳面，2026-09-23 拍板丙案 §9.5）
// 行为考官：**挂真实 PaperPanel + 真装 compose-dock 插件**（坞与架都是真贡献行，
// 与 tests/paper-composer-float 同一harness 范式）。
//
// 考的是用户操作序列，不是几何常量：
//   ① 架是 `.pp-composer` 的**兄弟**且出流（绝对定位 top:100%）⇒ 不进坞槽量高盒
//      ——让位带仍 = 96 + 坞实测高（此处坞高 131 ⇒ **227**）；
//   ② 空态 = **架内零张**（本卷零资产）⇒ 整条不渲染；
//   ③ 至多 6 张 + 「… 另 N 张」（N 只数架内）；
//   ④ 单击 = 飞到流里那一块（收起态连展开）——**点不是钉**（钉只认拖出）；
//   ⑤ update_asset 广播（原位置换 + touchMessage，真函数）⇒ 该签条出石青点；
//   ⑥ 拖出落钉 ⇒ 该签条**离架**且「另 N 张」随之（D4「钉出去 = 拿出来」）；
//   ⑦ 从**流内文类签**钉出 ⇒ 同样离架（入架判据一条）；
//   ⑧ 拔钉收回（流内「已移出 · 点击恢复」）⇒ 签条回架且序归位；
//   ⑨ 全钉出 ⇒ 整条退场。
//
// 注：jsdom 无布局，坞槽实测矩形由桩铺（真值 880×131 见 prototype/asset-rack-v2.NOTES.md）；
// 「架不进量高盒」在 jsdom 里由 DOM 结构 + CSS 出流声明两证（像素面归真机验收）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  materializeLineRange: vi.fn(() => ({ width: 100, text: '行文缩微' })),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items })),
  measureRichInlineStats: richStatsMock,
}));

const mockInvoke = vi.hoisted(() => vi.fn());
/** 桥面替身：`watchFileDragDrop`（坞的拖放入卷监听）也要给——**真坞**在架旁渲染，
 *  缺这一项坞会当场崩（PluginBoundary 兜住，但 `.pp-composer` 就不在场了）；
 *  它也是「架单列贡献」的价值证明：坞崩了架照旧（各包一层边界）。 */
vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
  watchFileDragDrop: vi.fn(async () => () => {}),
}));

// jsdom 无 Canvas 2D → 假 ctx（InkLayer rAF 循环要跑，不数墨）
class Fake2dCtx {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  textBaseline = '';
  textAlign = '';
  globalAlpha = 1;
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
import { compositionServicesPlugin } from '../src/composition/services';
import { spaceServicePlugin } from '../src/composition/space-service';
import { Context } from '../src/cordis';
import { RACK_CAP } from '../src/paper/asset-rack';
import { composeDockPlugin } from '../src/plugins/builtin/compose-dock';
import { BAND_STYLE_ID } from '../src/plugins/builtin/paper-shell/composer-band';
import { RACK_H } from '../src/plugins/builtin/paper-shell/composer-float';
import { PaperPanel } from '../src/plugins/builtin/paper-shell/PaperPanel';
import { getCanvasStore } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { useDockStore } from '../src/state/dock-store';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import type { AssistantMessage, ChatMessage, UserMessage } from '../src/ui/message-model';
import { applyAssetUpdateToExistingParts } from '../src/ui/part-mutator';

const PANEL_CSS = readFileSync(
  join(__dirname, '..', 'src', 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'),
  'utf8',
);

/** 从选择器名截取规则体（到下一个 `}` 为止——同 paper-provenance 的既有范式）。 */
function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
}

function userMsg(id: string, text: string): UserMessage {
  return { role: 'user', _id: id, text, sessionIndex: 0 };
}

/** 一条带资产块的助手回合（BlockPart 形状与 show_asset 产出一致）。 */
function assetMsg(
  id: string,
  assets: Array<{ assetId: string; kind: string; title?: string }>,
  respondingTo: string,
): AssistantMessage {
  return {
    role: 'assistant',
    _id: id,
    parts: assets.map((a) => ({
      type: 'block' as const,
      assetId: a.assetId,
      kind: a.kind,
      presentation: a.presentation ?? 'grid',
      ...(a.title !== undefined ? { title: a.title } : {}),
      payload: { columns: ['a'], rows: [[a.assetId]] },
      finalised: true,
    })),
    status: 'done',
    respondingTo,
  };
}

/** 一卷对话：`n` 张图版（每张一个助手回合）+ 每条前面的来文（阶段语义照常）。 */
function volumeWithAssets(n: number): ChatMessage[] {
  const out: ChatMessage[] = [userMsg('u-0', '起一卷，摆几张图版出来看看。')];
  for (let i = 0; i < n; i++) {
    const am = assetMsg(`a-${i}`, [{ assetId: `as-${i}`, kind: 'table', title: `图版 ${i + 1}` }], 'u-0');
    (am.parts as unknown[]).unshift({ type: 'text', text: `第 ${i + 1} 张。`, finalised: true });
    out.push(am);
  }
  return out;
}

describe('图版架（坞下横架 · 丙案）', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let overlays: ReturnType<Context['plugin']> | null = null;
  let panel: ChatCore;
  const VW = window.innerWidth;
  const VH = window.innerHeight;
  /** 坞槽实测（真值读数：坞 880×131 —— prototype/asset-rack-v2.NOTES.md §2）。 */
  const DOCK_W = 880;
  const DOCK_H = 131;
  const REGION_X = 0;
  const VIEW = { zoom: 1, panX: -260, panY: 600 };

  beforeEach(async () => {
    localStorage.clear();
    FakeResizeObserver.instances = [];
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    useShellStore.setState({ projectPath: 'D:/asset-rack-ws' });
    useDockStore.getState().closePanel('paper');
    useCanvasViewStore.setState({
      view: VIEW,
      canvasSize: { w: VW, h: VH },
      restoredView: null,
      pendingFocusId: null,
    });

    // 真装 compose-dock 插件：坞与架都是真贡献行（架 = 'asset-rack' 贡献）
    const ctx = new Context();
    const f1 = ctx.plugin(compositionServicesPlugin);
    await f1;
    const f2 = ctx.plugin(spaceServicePlugin);
    await f2;
    const f3 = ctx.plugin(overlayServicePlugin);
    await f3;
    const f4 = ctx.plugin(composeDockPlugin);
    await f4;
    overlays = f4;
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
    await overlays?.dispose();
    overlays = null;
    document.documentElement.style.removeProperty('--composer-band');
    document.getElementById(BAND_STYLE_ID)?.remove();
  });

  /** 让位带读数（**行为级**：照真消费者在 `.psh-host` 上读解析后的值）。
   *  载体 = 只命中让位消费面的一条规则（`composer-band.ts`，2026-10-18 性能批）——
   *  **不是** `:root` 内联（后者在拖动期是 62ms/帧的全树样式重算）。 */
  function bandVar(): string {
    const host = document.createElement('div');
    host.className = 'psh-host';
    document.body.appendChild(host);
    const v = getComputedStyle(host).getPropertyValue('--composer-band').trim();
    host.remove();
    return v;
  }

  /** 挂纸壳：一卷（可带 N 张图版）；返回坞槽元素（已铺实测矩形）。 */
  async function mount(assets: number): Promise<HTMLDivElement> {
    panel = new ChatCore();
    useCoreStore.setState({ core: panel });
    getChatStore(panel.panelId).sess.setState({
      sessions: [{ id: 1, label: '卷一' }],
      activeIdx: 0,
      nextSessionId: 2,
    });
    msgStoreFor(panel.panelId, 1).getState().setMessages(volumeWithAssets(assets));
    getCanvasStore(panel.panelId).getState().setRegion('1', { anchorX: REGION_X, anchorY: 0, width: 720 });

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
    slot.getBoundingClientRect = () =>
      ({
        left: (VW - DOCK_W) / 2,
        top: VH - 96 - DOCK_H,
        right: (VW - DOCK_W) / 2 + DOCK_W,
        bottom: VH - 96,
        width: DOCK_W,
        height: DOCK_H,
        x: (VW - DOCK_W) / 2,
        y: VH - 96 - DOCK_H,
        toJSON: () => ({}),
      }) as DOMRect;
    await act(async () => {
      FakeResizeObserver.flushComposerSlot();
    });
    return slot;
  }

  const rack = (): HTMLElement | null => container?.querySelector<HTMLElement>('.pp-rack') ?? null;
  const chips = (): HTMLElement[] => [...(rack()?.querySelectorAll<HTMLElement>('.pp-rack-chip') ?? [])];
  const chipIds = (): string[] => chips().map((c) => c.dataset.blockId ?? '');
  const moreText = (): string => rack()?.querySelector('.pp-rack-more')?.textContent ?? '';
  /** 某块在流里的 DOM（`data-block-id` 恒在；虚拟化窗口外的块不在 DOM）。 */
  const blockEl = (blockId: string): HTMLElement | null =>
    container?.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`) ?? null;
  /** 流区块的世界 y（layout 是块位置唯一真相——渲染面 transform 就是它）。 */
  const blockWorldY = (blockId: string): number => {
    const el = blockEl(blockId);
    if (!el) throw new Error(`块 ${blockId} 不在渲染面`);
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform);
    if (!m) throw new Error(`块 ${blockId} 无 transform`);
    return Number(m[2]);
  };
  /** 等飞行（240ms 动画）跑完 —— 焦点飞行有「同卷在途不重播」守卫，
   *  测试里若不等上一趟落地，下一次 flyToPoint 会被静默拒播。 */
  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
  };

  /** 按住 → 拖到屏幕点 → 松手（真手势三拍：钉手势走 window 监听）。 */
  const dragFrom = (handle: HTMLElement, x0: number, y0: number, x1: number, y1: number): void => {
    act(() => {
      handle.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: x0, clientY: y0 }),
      );
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x1, clientY: y1 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x1, clientY: y1 }));
    });
  };

  it('架是坞的兄弟且出流（top:100%）——让位带仍 96 + 坞实测高 = 227', async () => {
    const slot = await mount(2);
    const rackEl = rack();
    const dockEl = container?.querySelector('.pp-composer');
    expect(rackEl).not.toBeNull();
    // 兄弟：同在坞槽内、坞不包含架（驾不进坞的内容盒 ⇒ 坞高与让位带不受影响）
    expect(rackEl?.parentElement).toBe(slot);
    expect(dockEl?.parentElement).toBe(slot);
    expect(dockEl?.contains(rackEl ?? null)).toBe(false);
    // 出流声明（CSS 真源）：绝对定位 + top:100% + 高 38（= TS 侧 RACK_H 镜像）
    const css = ruleBody(PANEL_CSS, '.pp-rack {');
    expect(css).toContain('position: absolute');
    expect(css).toContain('top: 100%');
    expect(css).toContain(`height: ${RACK_H}px`);
    // 让位带读数（CSS 消费面读的那个数）不含架
    expect(DOCK_H + 96).toBe(227);
    expect(bandVar()).toBe('227px');
  }, 30_000);

  it('空态 = 架内零张（本卷零资产）⇒ 整条不渲染', async () => {
    await mount(0);
    expect(rack()).toBeNull();
  }, 30_000);

  it('至多 6 张 + 「… 另 N 张」（N 只数架内）+ 签条带物类签与题名', async () => {
    await mount(8);
    expect(chips()).toHaveLength(RACK_CAP);
    expect(moreText()).toBe('… 另 2 张');
    expect(chips()[0].querySelector('.pp-rack-sign')?.textContent).toBe('表');
    expect(chips()[0].querySelector('.pp-rack-title')?.textContent).toBe('图版 1');
  }, 30_000);

  it('单击 = 飞到流里那一块（收起态连展开）；**点不是钉**', async () => {
    await mount(2);
    /* 挂载期落位 effect 会补飞一次「卷锚」（本卷 y = 0）——飞行在途时 flyToPoint
     * 对同卷会拒播（focus-flight 的既守卫），故先等它跑完再点（240ms 动画）。 */
    await settle();
    const target = chipIds()[1];
    // 图版卡**默认张开**（2026-10-08 用户拍板撤销「默认收成一行签条」）——
    // 折叠行此时报「▾ 收起 …」（展开态文案）
    expect(blockEl(target)?.querySelector('.pp-fold')?.textContent).toBe('▾ 收起 表 图版 2');
    // 先造「用户手动收起」这一步（点折叠行）——这才是 expandBlock 能力位现在
    // 要办的事：经用户意志收起的卡，飞过去会落在一行签条上等于没到
    await act(async () => {
      blockEl(target)
        ?.querySelector('.pp-fold')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(blockEl(target)?.querySelector('.pp-fold')?.textContent).toBe('▸ 表 图版 2');
    // 收起改变块高 ⇒ 下游块整体上移，世界 y 必须**收起后**重读（layout 是位置唯一真源）
    await settle();
    const worldY = blockWorldY(target);
    const chip = chips()[1];
    await act(async () => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
    const view = useCanvasViewStore.getState().view;
    expect(view.panY).toBeCloseTo(VH / 2 - worldY, 3);
    // 收起态连展开：折叠行由「▸ 表 图版 2」翻成「▾ 收起 …」（飞到一块还收着的卡
    // 等于没到——这正是 expandBlock 能力位要办的事）。
    // 注：块体（.pp-plate/.pp-grid-table）归**渲染器产物**（本测试只装 compose-dock，
    // 表现注册表为空 ⇒ Body 回落空 .pp-body），故此处只考折叠态本身（用户可见面）。
    expect(blockEl(target)?.querySelector('.pp-fold')?.textContent).toBe('▾ 收起 表 图版 2');
    // 点不是钉：不产生钉、签条仍在架
    expect(Object.keys(getCanvasStore(panel.panelId).getState().pins)).toHaveLength(0);
    expect(chipIds()).toContain(target);
  }, 30_000);

  it('update_asset 广播（原位置换 + touchMessage）⇒ 该签条出石青点（机＝石青）', async () => {
    await mount(2);
    const target = chipIds()[0];
    expect(chips()[0].querySelector('.pp-rack-upd')).toBeNull();
    // 走生产路径：chat-stream 的 _applyAssetBroadcast 就是这两件事
    const msg = msgStoreFor(panel.panelId, 1).getState().messages[1] as AssistantMessage;
    applyAssetUpdateToExistingParts(msg.parts, {
      assetId: 'as-0',
      kind: 'table',
      presentation: 'grid',
      title: '图版 1',
      payload: { columns: ['a'], rows: [['更新过']] },
    } as never);
    await act(async () => {
      msgStoreFor(panel.panelId, 1).getState().touchMessage(msg._id);
    });
    expect(chipIds()).toContain(target);
    expect(chips()[0].querySelector('.pp-rack-upd')).not.toBeNull();
    // 去看过（点击）⇒ 点散（点不散会变成一句过期的谎）
    await act(async () => {
      chips()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(chips()[0].querySelector('.pp-rack-upd')).toBeNull();
  }, 30_000);

  it('拖出落钉 ⇒ 该签条离架、后续递补、「另 N 张」随之（D4「钉出去 = 拿出来」）', async () => {
    await mount(2);
    const target = chipIds()[0];
    // 拖出：起手在签条上，落在纸面远处（世界 x 与锚点差 600 > 半宽 ⇒ 不回槽）
    dragFrom(chips()[0], 0, 0, 600, 300);
    expect(Object.keys(getCanvasStore(panel.panelId).getState().pins)).toEqual([target]);
    expect(chipIds()).not.toContain(target);
    expect(chips()).toHaveLength(1);
    // 钉在案上（流内原序位是「已移出 · 点击恢复」占位）+ 签条**不留「已钉」记号**
    expect(blockEl(target)?.classList.contains('pp-pinned')).toBe(true);
    expect(rack()?.textContent).not.toContain('已钉');
  }, 30_000);

  it('从**流内文类签**拖出钉住 ⇒ 同样离架（入架判据一条）', async () => {
    await mount(2);
    const target = chipIds()[0];
    const handle = blockEl(target)?.querySelector<HTMLElement>('.pp-kind');
    expect(handle).toBeTruthy();
    const worldY = blockWorldY(target);
    // 落点 = 同一列、源块下方 500 世界单位（> 回槽容差 96）⇒ 落钉
    dragFrom(handle as HTMLElement, 0, 0, VIEW.panX + REGION_X, VIEW.panY + worldY + 500);
    expect(Object.keys(getCanvasStore(panel.panelId).getState().pins)).toEqual([target]);
    expect(chipIds()).not.toContain(target);
  }, 30_000);

  it('拔钉收回（流内「已移出 · 点击恢复」）⇒ 签条回架且**序归位**', async () => {
    await mount(2);
    const target = chipIds()[0];
    const order = chipIds();
    dragFrom(chips()[0], 0, 0, 600, 300);
    expect(chipIds()).not.toContain(target);
    // 收回 = 点流内那个占位钮（真手势语言：已移出 · 点击恢复）——占位钮是钉住块的
    // **兄弟**（不在块内），故按容器查（本例只有一张钉，唯一）
    const ghost = container?.querySelector<HTMLElement>('.pp-ghost');
    expect(ghost?.textContent).toContain('已移出');
    await act(async () => {
      ghost?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(Object.keys(getCanvasStore(panel.panelId).getState().pins)).toHaveLength(0);
    expect(chipIds()).toEqual(order); // 原位、序归位
  }, 30_000);

  it('全钉出 ⇒ 架内一张不剩 ⇒ 整条退场', async () => {
    await mount(2);
    const ids = chipIds();
    for (const id of ids) {
      dragFrom(chips().find((c) => c.dataset.blockId === id) as HTMLElement, 0, 0, 600, 300);
    }
    expect(Object.keys(getCanvasStore(panel.panelId).getState().pins)).toHaveLength(2);
    expect(rack()).toBeNull();
  }, 30_000);
});
