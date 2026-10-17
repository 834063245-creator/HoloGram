// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-composer-float — 创作坞浮动化的纸壳侧机制域（paper-panel-split 同族的
// use-*.ts 落位）：坞位 state + 实测尺寸 + 拖动锁 + 手势力矩 + 几何下发。
//
// 分工（单一权威源）：
//   - 坞位真源 = 本 hook 的 `pos`（null = 无覆盖 = CSS 默认居中坐底），落
//     localStorage（composer-float.ts 的 load/save）；拖动锁同族落盘；
//   - 几何/吸附/拖动面判据 = composer-float.ts 纯函数（可单测）；
//   - 让位带 --composer-band 由本 hook 下发**到让位消费面那条规则**（composer-band.ts，
//     旧实现在此写 `:root` 内联 = 拖动期 62ms/帧全树重算，详见该文件头注；旧
//     --composer-h-live 由坞自己上报「坞高」，浮动态失效——让位带是槽主人的几何，
//     收归一处）。**过渡期**由本 hook 代发旧 token 一版（仍走 `:root` 内联——它只在
//     坞高变化时写，不在拖动帧上）：运行中 exe 内嵌的外壳 CSS 仍读它，只换产物不重编
//     exe 时那两处消费面要它续命（拆除条件见下方 effect 注释）；
//   - 坞本体（compose-dock 插件）**一字不知**：拖动面判据基于坞 DOM 命中
//     （事件从坞冒泡到槽，槽主人接手势），不给 PaperDockContext 加回调、不动
//     宿主面（faceDeps）基线。
//
// 手感（2026-09-17 两批）：**默认锁定**（桌面歌词式拖动锁，用户方案）——锁定态坞
// 对鼠标零响应（不改光标、不接管手势、划词照旧）；解锁后**整坞**除交互件皆是抓手，
// 拖动全程磁吸（左右缘/版心中轴/底带/最底缘），双击坞体复位，松手落盘。
// 拖动期在 `html` 上挂 `pp-composer-dragging` 全页禁选（见下）——**刻意不
// preventDefault** pointerdown：取消它会连带影响 dblclick 的跨引擎互操作，复位
// 手势优先；防误选改由「拖动锁 + 拖动期禁选」两层承担。

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ComposerBandSink, createComposerBandSink } from './composer-band';
import type { ComposerBox, ComposerDockGeom, ComposerPos, ComposerViewport } from './composer-float';
import {
  clampComposerPos,
  composerAnchorOf,
  composerGeomOf,
  isComposerDragSurface,
  loadComposerPos,
  loadComposerUnlocked,
  saveComposerPos,
  saveComposerUnlocked,
  snapComposerPos,
} from './composer-float';

/** 坞浮动域的输入（2026-09-23 图版架丙案 D2 起有第二个输入）。 */
export interface ComposerFloatOpts {
  /** **架在否**（有活跃卷且架内非空；真源 = `paper/asset-rack.ts` 的 rackPresent，
   *  由 PaperPanel 按活跃流区算好递下）：架在 ⇒ 最底缘吸附位与夹紧下限顺延架高
   *  （8 → 46），架永在匣下、不被屏缘切。 */
  rackOn?: boolean;
}

/** 坞浮动域对 PaperPanel 的公开面。 */
export interface ComposerFloat {
  /** 槽元素 callback ref（React 19 清理式：量实测宽高，供夹紧/几何用）。 */
  slotRef: (el: HTMLDivElement | null) => (() => void) | undefined;
  /** 槽内联位置（undefined = 无覆盖，走 CSS 默认位）。 */
  style: CSSProperties | undefined;
  /** 拖动中（CSS 抓手手感：grabbing）。 */
  dragging: boolean;
  /** 拖动锁是否已解锁（解锁 = 坞对鼠标有响应）。 */
  unlocked: boolean;
  /** 锁钮（桌面歌词式小钮）：锁定 ↔ 解锁，落盘记忆。 */
  toggleUnlocked: () => void;
  /** 坞几何（bottom = 视口底 → 坞下边；height = 坞实测高）——覆盖层消费面按各自规矩派生。 */
  dock: ComposerDockGeom;
  /** **坞侧锚点**（屏幕坐标；2026-09-22 版口引线的起笔）= 坞顶左端版口钮的起端中点。
   *  引用稳定（只在坞位/坞实测尺寸变时换新）——平移/缩放帧不重算，线不闪。 */
  anchor: { x: number; y: number };
  /** 槽 pointerdown（锁定态直接放行；解锁态按拖动面判据）。 */
  onPointerDown: (e: React.PointerEvent) => void;
  /** 槽 dblclick（解锁态双击坞体 = 复位到版心居中坐底）。 */
  onDoubleClick: (e: React.MouseEvent) => void;
}

export function useComposerFloat(opts?: ComposerFloatOpts): ComposerFloat {
  /* 架在否（2026-09-23 图版架丙案 D2）：吸附表/夹紧下限的第二个输入。手势闭包
   * （pointermove 里的 snap）拿不到当帧 props ⇒ 同 unlockedRef 的手法存 ref。 */
  const rackOn = opts?.rackOn ?? false;
  const rackOnRef = useRef(rackOn);
  rackOnRef.current = rackOn;
  /* 坞位（null = 无覆盖）——懒初始化读盘：挂载即回到用户上次摆的位置。 */
  const [pos, setPos] = useState<ComposerPos | null>(loadComposerPos);
  const [box, setBox] = useState<ComposerBox>({ w: 0, h: 0 });
  const [vp, setVp] = useState<ComposerViewport>(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  const [dragging, setDragging] = useState(false);
  /* 拖动锁（默认锁定）：锁定态坞是普通 DOM——这条同时根治「拖动与划词打架」
   * （2026-09-17 用户报：坞头按下会带出纸上选区，document 级 selectionchange
   * 把选中浮钮一并唤醒）。 */
  const [unlocked, setUnlocked] = useState(loadComposerUnlocked);
  const slotEl = useRef<HTMLDivElement | null>(null);
  /** 松手落盘要读最新值（拖动期逐帧 setPos，闭包拿不到当帧值）。 */
  const posRef = useRef<ComposerPos | null>(pos);
  /** 起拖判据要在 window 监听器闭包里读最新锁定态。 */
  const unlockedRef = useRef(unlocked);
  unlockedRef.current = unlocked;

  /* 视口尺寸（拖拽夹紧 + 存量坞位的读侧夹紧都按它算）。 */
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* 槽实测宽高：坞高随内容变（思考展开/附件/墨量册），宽随窗口变——
   * ResizeObserver 一处跟上（jsdom 无 RO：只量首帧，测试自铺桩）。 */
  const slotRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    slotEl.current = el;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (slotEl.current === el) slotEl.current = null;
    };
  }, []);

  /* 读侧夹紧：存量坞位遇窗口缩小不越界（值不改写——窗口涨回去坞回原处）。
   * 未实测（宽高为 0）时不夹：无真尺寸的夹紧只会算错。
   * 架在时下限顺延架高（rackOn 参与依赖：架出没会改这一位的合法区间）。 */
  const effective = useMemo(() => {
    if (!pos) return null;
    if (box.w <= 0 || box.h <= 0) return pos;
    return clampComposerPos(pos, vp, box, { rack: rackOn });
  }, [pos, vp, box, rackOn]);

  /* 坞几何引用稳定（P2-3 纪律）：PaperPanel 平移/缩放帧都会重渲，若此处每帧换新对象，
   * 覆盖层 context 跟着变 → 目次带/小地图每帧重渲。依赖只有坞位与坞高，平移帧不变。 */
  const dock = useMemo(() => composerGeomOf(effective, box.h), [effective, box.h]);
  /* 坞侧锚点（版口引线，2026-09-22）：坞位取**夹紧后**的那一份（与内联 style 同一个数
   * ——否则窗口缩小后线会离坞）。引用稳定纪律同 dock：平移/缩放帧不重算。 */
  const anchor = useMemo(() => composerAnchorOf(effective, vp, box), [effective, vp, box]);
  const band = dock.bottom + dock.height;

  /* 让位带下发（消费面：递牒卡宿主 `.psh-host` / 插件造物坞 `.pw-dock` 读
   * `var(--composer-band, 静态兜底算式)`）。
   *
   * **2026-10-18 性能批换载体**：旧实现写 `document.documentElement.style` 内联
   * ——拖动期每帧一次全树样式重算，真机实测 **62ms/帧**（用户报「一顿一顿」的病灶，
   * 全量实测数据在 `composer-band.ts` 头注）。现在写的是**只命中让位消费面**的
   * 一条规则（≈1ms/帧，且后挂载的消费面自动命中）。**别退回内联写法。** */
  const bandSink = useRef<ComposerBandSink | null>(null);
  useEffect(() => {
    const sink = createComposerBandSink();
    bandSink.current = sink;
    return () => {
      bandSink.current = null;
      sink.dispose();
    };
  }, []);
  useEffect(() => {
    bandSink.current?.publish(band);
  }, [band]);

  /* ── 过渡期旧 token 代发（**随下次整包重编删除**，债在 docs/landmine-map.md）──
   * 旧 `--composer-h-live`（坞自报坞高）的出版者已随坞产物拆除，但**运行中 exe 的
   * 外壳 CSS 是内嵌在 exe 里的**（`shell.css` 的 .psh-host / `plugin-windows.css` 的
   * .pw-dock 仍读它）——只换产物不重编 exe 时那两处会回退到 `--composer-h`(66px)，
   * 让位少 44px/32px、压住坞顶。故由槽主人（本 hook 已测坞高）在过渡期代发旧口径，
   * 新口径 `--composer-band` 同时下发（载体不同——见上；两代消费面都正确）。
   * 拆除条件：下一次 `cargo tauri build`（整包重编 ⇒ 内嵌 CSS 换成本仓库的新式）——
   * 届时本 effect 内两行与 landmine 条目一并删除。 */
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--composer-h-live', `${Math.round(box.h)}px`);
    return () => {
      root.style.removeProperty('--composer-h-live');
    };
  }, [box.h]);

  const style = useMemo<CSSProperties | undefined>(
    () => (effective ? { left: `${effective.left}px`, bottom: `${effective.bottom}px`, transform: 'none' } : undefined),
    [effective],
  );

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (!isComposerDragSurface(e.target, unlockedRef.current)) return;
    const el = slotEl.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return; // 未实测（jsdom / 未布局）：不起拖
    /* 起拖快照：坞位 + 指针起点 + 当帧视口（拖动期窗口若变，松手后由读侧夹紧收）。
     * 坞在 CSS 默认位（pos=null）时也从实测矩形起算——拖动即接管为显式坞位。 */
    const vpNow = { w: window.innerWidth, h: window.innerHeight };
    const start = { x: e.clientX, y: e.clientY, left: r.left, bottom: vpNow.h - r.bottom };
    const boxNow = { w: r.width, h: r.height };
    let moved = false;
    setDragging(true);
    /* 拖动期全页禁选（html 上挂类，规则在 PaperPanel.css）：坞上按下会带出原生选区，
     * 而纸上挂着 document 级 selectionchange（use-paper-strips 的选中浮钮）——
     * 不禁选就是「拖动坞 = 纸上划词」（2026-09-17 用户报的第一条冲突）。
     * 既有选区也一并清掉：抓坞等同点了别处，选区该散。 */
    const rootEl = document.documentElement;
    rootEl.classList.add('pp-composer-dragging');
    window.getSelection()?.removeAllRanges();
    const onMove = (ev: PointerEvent) => {
      moved = true;
      const raw = {
        left: start.left + (ev.clientX - start.x),
        bottom: start.bottom - (ev.clientY - start.y),
      };
      const next = snapComposerPos(clampComposerPos(raw, vpNow, boxNow, { rack: rackOnRef.current }), vpNow, boxNow, {
        rack: rackOnRef.current,
      });
      posRef.current = next;
      setPos(next);
    };
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      rootEl.classList.remove('pp-composer-dragging');
      setDragging(false);
      /* 只点不拖（moved=false）= 坞位原样（不落盘）——否则单击坞体会把已存的
       * 坞位当「无覆盖」清掉，坞无故跳回底部。 */
      if (moved) saveComposerPos(posRef.current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }, []);

  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!isComposerDragSurface(e.target, unlockedRef.current)) return;
    posRef.current = null;
    setPos(null);
    saveComposerPos(null);
  }, []);

  const toggleUnlocked = useCallback(() => {
    setUnlocked((prev) => {
      const next = !prev;
      saveComposerUnlocked(next);
      return next;
    });
  }, []);

  return { slotRef, style, dragging, unlocked, toggleUnlocked, dock, anchor, onPointerDown, onDoubleClick };
}
