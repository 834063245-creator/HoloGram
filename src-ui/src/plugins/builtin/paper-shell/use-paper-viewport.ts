// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 视口域（paper-panel-split C2）——PaperPanel 的摄像机：view/canvasSize 订阅、
// 平移（rAF 帧合并）、滚轮平滚（plain = 平移 / ctrl = 缩放 / 设置可切回
// 滚轮=缩放）、缩放步进（顶部浮件 −/+ 与键盘 +/−/0）、拖选自动滚屏、Home 回锚、
// LOD 缩远、重栅格化锐化、视口持久化、尺寸 RO、世界点守恒、重挂清除。
// 焦点飞行（flyTo 族）在 use-paper-focus——本域只产出飞行抢占所需的
// focusRafRef/focusFlightRef 载体。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEdgeAutoScroll, useHoverEdgeScroll } from './edge-scroll';
import { createFocusFlightScheduler } from './focus-flight';
import {
  ANCHOR,
  canvasWheelMode,
  getCanvasStore,
  loadSettings,
  lodActive,
  lodFarActive,
  nextZoomStep,
  onSettingsSaved,
  panBy,
  scheduleCanvasSave,
  useCanvasViewStore,
  useShellStore,
  wheelFactor,
  zoomAt,
} from './host';
import { panForAnchor } from './landing';
import { injectPaperTokens } from './type-tokens';
import type { PaperCore } from './use-paper-sessions';
import { isEditableSurface } from './use-paper-strips';
import { viewportWorldRect } from './virtualize';

/** 拖选自动滚屏的手势态（选区域产出，激活/布局核心两域穿参消费）：
 *  keepAlive → 锚点块保活（见 effect 注——原生选区锚点死则选区截顶）。 */
export interface SelectionDragState {
  /** 指针最新位（client 坐标——rAF 帧内现算边缘带） */
  x: number;
  y: number;
  /** 选区锚点块保活（首个非折叠帧登记，mouseup 清）：regions stub 豁免 +
   *  visibleIds 强制在册的输入。 */
  keepAlive: { sessionId: string; blockId: string } | null;
}

/** 视口域（paper-panel-split C2，自 PaperPanel 739-1049 + 1698-1813 域内原样搬入）。
 *  挂载序硬约束（paper-panel-split-plan §3）：本 hook 必须晚于 usePaperSessions
 *  （activeRegion 镜像先落，重挂清除 effect 才能选到活跃卷）。 */
export function usePaperViewport(core: PaperCore | null) {
  /* 视口状态（Stage-3：书脊定位器共享真源——canvas-view-store app 级单例，
   * PaperPanel 读写；书脊/侧边栏经 requestFocus 驱动摄像机） */
  const view = useCanvasViewStore((s) => s.view);
  const setView = useCanvasViewStore((s) => s.setView);
  const canvasSize = useCanvasViewStore((s) => s.canvasSize);
  const setCanvasSize = useCanvasViewStore((s) => s.setCanvasSize);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /** 纸面根（.pp-root）：挂载时注入版式 token 为 CSS 变量（单一真源 type-tokens）。 */
  const paperRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (paperRootRef.current) injectPaperTokens(paperRootRef.current);
  }, []);
  /** 世界层（pp-world）引用：缩放停稳后摘 will-change + 强制 reflow 用。 */
  const worldRef = useRef<HTMLDivElement | null>(null);

  /* ── 缩远墨迹（P4 LOD）：zoom 低于迟滞阈值时块/纸条 DOM 退场，InkLayer 画
   * 真墨行条骨架——远看真卷轴 + 远缩性能防线（阈值间往返不闪烁）。 ── */
  const [lod, setLod] = useState(false);
  const lodRef = useRef(false);
  useEffect(() => {
    const sync = () => {
      const next = lodActive(useCanvasViewStore.getState().view.zoom, lodRef.current);
      if (next !== lodRef.current) {
        lodRef.current = next;
        setLod(next);
      }
    };
    sync();
    return useCanvasViewStore.subscribe(sync);
  }, []);

  /* ── 远档旗标（P4c 远景三档，2026-09-06）：zoom 進入行影档后卷首头/
   *  边缘手柄等 DOM 杂项退场（缩糊的 DOM 文本不如无——卷名由 InkLayer
   *  地志标签接管）。与 InkLayer 内部 tier 同边界同迟滞（paper/ink.ts 单一
   *  真源），订阅模式同上。 ── */
  const [lodFar, setLodFar] = useState(false);
  const lodFarRef = useRef(false);
  useEffect(() => {
    const sync = () => {
      const next = lodFarActive(useCanvasViewStore.getState().view.zoom, lodFarRef.current);
      if (next !== lodFarRef.current) {
        lodFarRef.current = next;
        setLodFar(next);
      }
    };
    sync();
    return useCanvasViewStore.subscribe(sync);
  }, []);

  /* ── 文字锐化（2026-08-30）：世界层 will-change 只在交互期挂。
   * 常驻 will-change:transform 会让浏览器固定合成层栅格化分辨率，放大时
   * GPU 拉伸旧位图、文字发虚；只有层内容变 dirty（重排）才按当前档位重新
   * 栅格化。这里订阅 view 变化（wheel/pan/动画全源）：变化中挂 live 保合成
   * 层流畅 + 重置 settle 定时器；停稳 120ms 摘 live + 强制 reflow，逼浏览器
   * 按当前档位重新栅格化。subscribe 模式对齐 LOD effect（不依赖 React 渲染
   * 周期，view 变化在 store 层即触发）。 */
  const rerasterTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const sync = () => {
      const world = worldRef.current;
      if (!world) return;
      world.classList.add('pp-world--live');
      if (rerasterTimerRef.current) window.clearTimeout(rerasterTimerRef.current);
      rerasterTimerRef.current = window.setTimeout(() => {
        const el = worldRef.current;
        if (!el) return;
        el.classList.remove('pp-world--live');
        void el.offsetHeight; // 强制同步 reflow → 触发重新栅格化
        rerasterTimerRef.current = null;
      }, 120);
    };
    sync();
    return useCanvasViewStore.subscribe(sync);
  }, []);
  useEffect(
    () => () => {
      if (rerasterTimerRef.current) window.clearTimeout(rerasterTimerRef.current);
    },
    [],
  );

  /* R2 视口持久化（2026-09-05）：view 变化（pan/zoom）→ 防抖落盘 canvas.json
   * （复用 scheduleCanvasSave 500ms 窗口）。平移/缩放是高频写——防抖合并；
   * 恢复视图（restoreView）也触发，但用户不动视口时不会反复写。 */
  useEffect(() => {
    if (!core) return;
    let saveTimerRef = 0;
    const sync = () => {
      if (saveTimerRef) window.clearTimeout(saveTimerRef);
      saveTimerRef = window.setTimeout(() => {
        const pp = useShellStore.getState().projectPath;
        if (pp) void scheduleCanvasSave(core.panelId, pp);
      }, 500);
    };
    sync();
    const un = useCanvasViewStore.subscribe(sync);
    return () => {
      un();
      if (saveTimerRef) window.clearTimeout(saveTimerRef);
    };
  }, [core]);

  /* 初始视口：锚点对视口下缘（D-R1-3）。画布尺寸变化时保持锚点关系 */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setCanvasSize(el.clientWidth, el.clientHeight);
    });
    ro.observe(el);
    setCanvasSize(el.clientWidth, el.clientHeight);
    return () => ro.disconnect();
  }, [setCanvasSize]);

  /* 尺寸变化 = 世界点守恒（2026-09-01 视角抢夺修复）：旧实现任何尺寸变化都把
   * pan 重置回默认锚点——用户视角被暴力抢回原点（模型下拉开合/窗口缩放/侧栏
   * 开合等一切引发画布 1px 尺寸差的场景全中招）。新语义：保持「锚点屏幕位置
   * 下的世界坐标」跨尺寸不动；只有首测（无前尺寸）才落默认锚点 pan。
   * ⚠ 首测读 render 闭包值（挂载时 = store 陈旧值/默认 800×600），RO effect
   * 先跑会同步写入真实尺寸——随后本 effect 二跑守恒从旧锚点 (400,504) 推世界
   * 点。此自洽链路期间**禁止任何其它 effect 抢先改写 pan**（2026-09-02 首挂
   * 视角错位尸检：旧「重挂回锚」effect 用 live 尺寸抢先落锚 (632,613)，守恒
   * 二跑从被改的 pan 反推出虚构世界点 (−232,−109)，把新旧锚差 (+232,+109)
   * 当用户平移补偿回去 → 首次进画布 pan=(864,722) 偏移，重进（store 尺寸已
   * 持久）反而正常——间歇性病灶的来源）。 */
  const prevCanvasSizeRef = useRef<{ w: number; h: number } | null>(null);
  /* ── 回锚 / 首屏落位（2026-09-17 修：认**卷锚**，不再按世界原点）──
   * 卷锚 = 活跃卷最新块底边（`RegionAnchor`，流向上长），随内容往上漂：用户三卷
   * 实测都已漂到 -28,700 上下，而旧实现一律按世界原点落锚 ⇒ 视口停在卷外 28,700px
   * 的空白桌面（用户报「点开工作区/按回锚就空白，啥也不渲染」；CDP 实测 Home 之后
   * 视口世界区间 [-2045, 151]）。裁决序：活跃卷 → 首个摊开卷 → 世界原点（旧口径）。
   * 引用稳定化：返回值只在用点现算，不入依赖表。 */
  const landingAnchor = useCallback((): { x: number; y: number } => {
    if (core) {
      const c = getCanvasStore(core.panelId).getState();
      const sid = c.activeSessionId && c.spread[c.activeSessionId] ? c.activeSessionId : Object.keys(c.spread)[0];
      const r = sid ? c.spread[sid] : null;
      if (r) return { x: r.anchorX, y: r.anchorY };
    }
    return { x: 0, y: 0 };
  }, [core]);

  useEffect(() => {
    const cur = { w: canvasSize.w, h: canvasSize.h };
    const prev = prevCanvasSizeRef.current;
    prevCanvasSizeRef.current = cur;
    if (!prev) {
      // R2 冷启动聚焦（2026-09-05）：恢复过视口（canvas.json view 字段 →
      // loadCanvasFromDisk 已 restoreView 写进 store）→ 用恢复值，不落默认锚
      //（restoredView 非空 = 本次恢复的视图尚未被用户动过）；否则落**卷锚**。
      const restored = useCanvasViewStore.getState().restoredView;
      if (!restored) {
        const v0 = useCanvasViewStore.getState().view;
        const { panX, panY } = panForAnchor(
          { w: cur.w, h: cur.h },
          v0.zoom,
          landingAnchor(),
          ANCHOR.screenBottomMargin,
        );
        setView((v) => ({ ...v, panX, panY }));
      }
      return;
    }
    if (prev.w === cur.w && prev.h === cur.h) return;
    /* 视口尺寸变化守恒：把「屏幕锚位下那个世界点」搬到新的屏幕锚位。
     * 这里用的是**屏幕锚位**（视口宽/2，视口高 − ANCHOR margin），与世界锚无关。 */
    const v = useCanvasViewStore.getState().view;
    const a0 = { x: prev.w / 2, y: prev.h - ANCHOR.screenBottomMargin };
    const world = { x: (a0.x - v.panX) / v.zoom, y: (a0.y - v.panY) / v.zoom };
    const a1 = { x: cur.w / 2, y: cur.h - ANCHOR.screenBottomMargin };
    setView((old) => ({ ...old, panX: a1.x - world.x * old.zoom, panY: a1.y - world.y * old.zoom }));
  }, [canvasSize.w, canvasSize.h, setView, landingAnchor]);

  /* 画布重挂 = 干净的定位面：清掉上一轮残留定位请求（2026-09-02 修复：原版
   * 还在此处 setView 回锚——与上方守恒 effect 首测分支职责重复，且用 live
   * 尺寸抢先落锚破坏守恒自洽（见上注释尸检）。回锚职责收归守恒 effect：每次
   * 挂载 prevCanvasSizeRef 归 null，首测分支天然落锚（重挂时闭包 = store
   * 持久尺寸，即时回锚，语义等价且无竞态）。
   * R2 冷启动聚焦兜底（2026-09-05）：本工作区画布无恢复视图（旧版 canvas.json
   * 无 view 字段）且摊开卷非空 → 定位到活跃卷（或首个摊开卷）——不裸站原点。
   * 有恢复视图（新数据）→ 视角已在上次视野，只清残留 pending。 */
  useEffect(() => {
    const cvs = useCanvasViewStore.getState();
    if (!cvs.restoredView && core) {
      const canvas = getCanvasStore(core.panelId).getState();
      const spreadKeys = Object.keys(canvas.spread);
      if (spreadKeys.length > 0) {
        const target =
          canvas.activeSessionId && canvas.spread[canvas.activeSessionId] ? canvas.activeSessionId : spreadKeys[0];
        cvs.requestFocus(target);
        return;
      }
    }
    cvs.requestFocus(null);
  }, [core]);

  /* 视口虚拟化输入 */
  const viewRect = useMemo(
    () => viewportWorldRect(view, canvasSize.w, canvasSize.h),
    [view, canvasSize.w, canvasSize.h],
  );

  /* ── 交互：平移 / 缩放 ── */
  const panningRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const [panning, setPanning] = useState(false);
  /* 焦点飞行载体（use-paper-focus / glide 消费——wheel 与手动拖拽抢占飞行）。 */
  const focusRafRef = useRef(0);
  const focusFlightRef = useRef(createFocusFlightScheduler());

  /* ── 拖选自动滚屏（2026-09-07 UX 批；2026-09-17 接入边缘滚动子系统）──
   * 拖选文字贴到画布边缘 → 视口按入带深度自动平移 + 把原生选区延伸到指针下
   * 的新内容。两个关键点：
   *  - 浏览器只在指针物理移动时扩选——内容在指针下移动（我们平移的）不会
   *    自行扩选，须每帧 caretRangeFromPoint → Selection.extend 手动追；
   *  - 虚拟化会卸载滑出窗口的块——锚点块一卸，原生选区从顶部被截。锚点块
   *    经 keepAlive 保活（regions stub 豁免 + visibleIds 强制在册），到手势
   *    松开为止。
   * 帧循环与策略（开关/灵敏度/带宽/限速）归 `edge-scroll.ts`（与拖块同一套）：
   * 本域只提供「取指针 + 先延后滚」——延伸必须发生在 pan **之前**（延伸读的是
   * 已提交布局，与旧 tick 同序，勿调）。 */
  const selDragRef = useRef<SelectionDragState | null>(null);
  const { start: startEdgeScroll, stop: stopEdgeScroll } = useEdgeAutoScroll(canvasRef);

  /* 悬停即滚（RTS 相机标准形态，缺省关——设置里开）：指针停在画布边缘就滚，
   * 不必先按住东西。同一子系统（策略/曲线/灵敏度共用），差异见 edge-scroll.ts 注。 */
  useHoverEdgeScroll(canvasRef);

  /* 缩放/平滚：原生非被动监听（React 合成 wheel 是 passive，preventDefault 无效）。
   * 2026-09-07 UX 批：滚轮语义改「平滚视角」——plain wheel = 平移（纵向随
   * deltaY / 横向随 deltaX，Chromium 已把 Shift+滚轮换算成 deltaX，其他宿主
   * 在此兜底换算）；Ctrl+wheel（触控板捏合同道）= 缩放。工具/程文输出区
   * （pre/.pp-out 自带溢出滚动）保留原生透传——滚输出文本不带走画布。
   * 2026-09-08 缩放舒适度拍板：设置「滚轮行为」可选回「缩放画布」
   *（canvasWheelMode——Whimsical 派），zoom 模式下 plain wheel 走原缩放路径。 */
  const wheelZoomModeRef = useRef(false);
  useEffect(() => {
    /* 滚轮行为随设置即时换轨：mount 读一次 + 保存广播刷新（设置面板保存 →
     * onSettingsSaved → 重读）。滚轮是高频事件——不逐事件 JSON.parse。 */
    const sync = () => {
      wheelZoomModeRef.current = canvasWheelMode(loadSettings()) === 'zoom';
    };
    sync();
    return onSettingsSaved(sync);
  }, []);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      // R3.5 浮动 minimap：滚轮在 minimap 上 = 缩放 minimap 本体，不缩放画布
      if (t?.closest('.pp-minimap')) return;
      if (!e.ctrlKey && t?.closest('pre, .pp-out')) return;
      e.preventDefault();
      // 用户动视口 = 手动接管：取消在途定位动画（否则动画会跟手抢 pan）
      if (focusRafRef.current) {
        cancelAnimationFrame(focusRafRef.current);
        focusRafRef.current = 0;
        focusFlightRef.current.end();
      }
      useCanvasViewStore.getState().requestFocus(null);
      // Ctrl 恒缩放（捏合同道）；设置切「缩放画布」时 plain wheel 也缩放
      if (e.ctrlKey || wheelZoomModeRef.current) {
        const rect = el.getBoundingClientRect();
        setView((v) => zoomAt(v, e.clientX - rect.left, e.clientY - rect.top, wheelFactor(e.deltaY)));
        return;
      }
      // 平滚：deltaMode 1（行）按 16px/行归一；滚一下挪一屏内容、不动归属。
      const unit = e.deltaMode === 1 ? 16 : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        dx = dy;
        dy = 0;
      }
      setView((v) => panBy(v, -dx, -dy));
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, [setView]);

  /* ── 缩放步进 / 回 100%（2026-09-08 缩放舒适度拍板）──顶部浮件 −/+ 控件与键盘
   * +/−/0 的语义端：阶梯档位（ZOOM_STEPS）迈步、锚视口中心；手动接管视口
   *（取消在途定位动画 + 清 pendingFocus），与滚轮同纪律。 */
  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      if (focusRafRef.current) {
        cancelAnimationFrame(focusRafRef.current);
        focusRafRef.current = 0;
        focusFlightRef.current.end();
      }
      useCanvasViewStore.getState().requestFocus(null);
      const { view: v, canvasSize: cs } = useCanvasViewStore.getState();
      const target = nextZoomStep(v.zoom, dir);
      // 已在档位端点（夹持返回同值）：不迈步、也不抬读数计数——否则读数会「空跳一下」
      if (target === v.zoom) return;
      useCanvasViewStore.getState().markZoomStep();
      setView((cur) => zoomAt(cur, cs.w / 2, cs.h / 2, target / cur.zoom));
    },
    [setView],
  );
  const resetZoom = useCallback(() => {
    if (focusRafRef.current) {
      cancelAnimationFrame(focusRafRef.current);
      focusRafRef.current = 0;
      focusFlightRef.current.end();
    }
    useCanvasViewStore.getState().requestFocus(null);
    const { view: v, canvasSize: cs } = useCanvasViewStore.getState();
    // 已在 100%：不抬读数计数（同 stepZoom 的端点守卫）
    if (Math.abs(v.zoom - 1) < 1e-9) return;
    useCanvasViewStore.getState().markZoomStep();
    setView((cur) => zoomAt(cur, cs.w / 2, cs.h / 2, 1 / cur.zoom));
  }, [setView]);

  /* 键盘缩放快捷键：+ / = 上调、- / _ 下调、0 回 100%（Ctrl+= / Ctrl+− 浏览器
   * 习惯别名同收）；输入框/编辑区内不触发（Home 同款门控）。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '+' && e.key !== '=' && e.key !== '-' && e.key !== '_' && e.key !== '0') return;
      if (e.altKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === '0') {
        e.preventDefault();
        resetZoom();
        return;
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        stepZoom(1);
        return;
      }
      e.preventDefault();
      stepZoom(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepZoom, resetZoom]);

  /* 回锚快捷键（D-R1-3 流锚甲 / 2026-09-17 修）：Home → **回到活跃卷**
   *（最新块贴视口下缘上方 margin）。旧实现按世界原点落锚，卷锚漂到 -28,700 之后
   * Home 落在空白桌面上（用户报「按回锚就空白」）。与滚轮/缩放/拖拽同纪律：
   * 手动接管视口先取消在途定位飞行 + 清挂起定位，否则飞行会把回锚覆盖掉。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Home' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      if (focusRafRef.current) {
        cancelAnimationFrame(focusRafRef.current);
        focusRafRef.current = 0;
        focusFlightRef.current.end();
      }
      useCanvasViewStore.getState().requestFocus(null);
      const { view: cur, canvasSize: cs } = useCanvasViewStore.getState();
      const { panX, panY } = panForAnchor({ w: cs.w, h: cs.h }, cur.zoom, landingAnchor(), ANCHOR.screenBottomMargin);
      setView((v) => ({ ...v, panX, panY }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView, landingAnchor]);

  const onCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // 空白处按下 → 开始平移。2026-09-07 UX 批：平移起手势面扩到流区纸面
    // （.pp-region 本体——卷首/空卷题字 pointer-events:none 穿透到它）——
    // 鼠标在会话流区内同样可拖动画布。块/边缘/角柄/纸条/文类签各有自己的
    // 手势（stopPropagation），不会落到这里；流区自己的 onMouseDown（激活）
    // 先跑，激活与平移并存。
    const t = e.target as HTMLElement;
    const onEmpty = t === e.currentTarget || t.classList.contains('pp-world') || t.classList.contains('pp-region');
    if (!onEmpty) return;
    e.preventDefault();
    // 用户拖拽 = 手动接管视口：取消在途定位动画（否则动画会跟手抢 pan）
    if (focusRafRef.current) {
      cancelAnimationFrame(focusRafRef.current);
      focusRafRef.current = 0;
      focusFlightRef.current.end();
    }
    useCanvasViewStore.getState().requestFocus(null);
    panningRef.current = { lastX: e.clientX, lastY: e.clientY };
    setPanning(true);
  }, []);

  useEffect(() => {
    if (!panning) return;
    /* 材质批修复（2026-09-01）：平移 setView 按 rAF 帧合并——mousemove 只累计
     * 增量，每帧至多一次 setView。此前鼠标事件频率直接打满同步重渲染，区域
     * 巨大（万级像素高）+ 目次带重渲染时更新嵌套爆 React #185 上限，帧呈现
     * 饿死 = 整窗冻在旧帧（实机打回「流区透明」即此：新样式永远排不上屏）。 */
    let raf = 0;
    let pendX = 0;
    let pendY = 0;
    const flush = () => {
      raf = 0;
      const dx = pendX;
      const dy = pendY;
      pendX = 0;
      pendY = 0;
      if (dx !== 0 || dy !== 0) setView((v) => panBy(v, dx, dy));
    };
    const move = (e: MouseEvent) => {
      const p = panningRef.current;
      if (!p) return;
      pendX += e.clientX - p.lastX;
      pendY += e.clientY - p.lastY;
      p.lastX = e.clientX;
      p.lastY = e.clientY;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const up = () => {
      // ⚠ 必须清 panningRef：move 以 ref 判手势在途——不清则松手后任意
      // mousemove 继续拖画布（2026-09-06 前只清 state 没清 ref，真机病根之一）。
      panningRef.current = null;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      flush(); // 松手把尾巴增量落完，视角精确停在指针下
      setPanning(false);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [panning, setView]);

  /* ── 拖选自动滚屏：手势臂装（window capture——块手柄类手势在 React 层
   * stopPropagation，冒泡路看不到，须捕获面先行）→ rAF 循环（活选区非折叠
   * 才滚）→ 边缘带平移 + 选区延伸。松手/选区未成不滚；指针回带内停摆，
   * 再入带由 mousemove 重启。 ── */
  useEffect(() => {
    /** 锚点块保活登记：从活选区锚点反查块身份（data-block-id/data-session-id）。 */
    const keepAliveOf = (): SelectionDragState['keepAlive'] => {
      const node = window.getSelection()?.anchorNode ?? null;
      const el = node instanceof Element ? node : (node?.parentElement ?? null);
      const blockEl = el?.closest('.pp-block') ?? null;
      const blockId = blockEl?.getAttribute('data-block-id');
      const sessionId = blockEl?.getAttribute('data-session-id');
      return blockId && sessionId ? { sessionId, blockId } : null;
    };

    /** 把选区焦点延伸到指针下的插入点（内容平移后浏览器不会自行扩选）。
     *  caretRangeFromPoint 是 Chromium 面（WebView2 在册）；缺席的宿主降级
     *  只滚不延。插入点落在世界层外（画布底/创作坞）不追——选区不逃出纸面。 */
    const extendToCaret = (px: number, py: number): void => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const caretFn = (
        document as Document & {
          caretRangeFromPoint?: (x: number, y: number) => Range | null;
        }
      ).caretRangeFromPoint;
      if (typeof caretFn !== 'function') return;
      const caret = caretFn.call(document, px, py);
      if (!caret) return;
      const node = caret.startContainer;
      const el = node instanceof Element ? node : node.parentElement;
      if (!el?.closest('.pp-world')) return;
      sel.extend(node, caret.startOffset);
    };

    const startLoop = (): void => {
      startEdgeScroll(() => {
        const g = selDragRef.current;
        if (!g) return null; // 手势已收
        const sel = window.getSelection();
        // 选区未成（按下未拖开）——不滚；下一次 mousemove 会重新起循环
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
        if (!g.keepAlive) g.keepAlive = keepAliveOf();
        return {
          x: g.x,
          y: g.y,
          // 先延后滚：延伸反映上一帧 pan 后的已提交布局（React 提交滞后一帧），
          // 本帧滚出的位移由下一帧的延伸追上——选区焦点恒差一帧，不可见。
          beforePan: (pan) => {
            if (pan.dx !== 0 || pan.dy !== 0) extendToCaret(g.x, g.y);
          },
        };
      });
    };

    const down = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      const canvasEl = canvasRef.current;
      const t = e.target instanceof Element ? e.target : null;
      if (!canvasEl || !t || !canvasEl.contains(t)) return;
      // 选择手势只可能起于块文本（.pp-block user-select:text）——纸条/流区
      // 背景不可选（全局选区政策，见 foundation.css）天然不进；界面注记
      // （按钮/链接/折叠闸 summary/文类签拖出柄/宽度手调柄）是手势面不是文本，
      // 排除；块内输入件同理（在准奏卡的意见框里拖选是写字，不是划纸面）。
      // ⚠ 本族与 PaperPanel.css 的块内禁选族（`.pp-block :where(…)`）**同步维护**
      //   ——2026-09-17 实测漂移过一回：CSS 收了 summary 而此处没收，BibTeX 折叠闸
      //   照样能武装拖选自动滚屏。
      if (!t.closest('.pp-block')) return;
      if (t.closest('button, a, summary, .pp-kind, .pp-resize') || isEditableSurface(t)) return;
      selDragRef.current = { x: e.clientX, y: e.clientY, keepAlive: null };
    };
    const move = (e: MouseEvent): void => {
      const g = selDragRef.current;
      if (!g) return;
      g.x = e.clientX;
      g.y = e.clientY;
      startLoop();
    };
    const up = (): void => {
      if (!selDragRef.current) return;
      selDragRef.current = null;
      stopEdgeScroll();
    };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      stopEdgeScroll();
    };
  }, [startEdgeScroll, stopEdgeScroll]);

  /* 稳定引用（性能专项第二刀）：平移/缩放每帧 view 变——回调读 ref 而非依赖
   * view/layout，拖拽/移位回调才可零依赖稳定（memo 友好，不逐帧重建闭包）。 */
  const viewRef = useRef(view);
  viewRef.current = view;

  return {
    view,
    canvasSize,
    canvasRef,
    paperRootRef,
    worldRef,
    lod,
    lodFar,
    viewRect,
    viewRef,
    panning,
    selDragRef,
    stepZoom,
    resetZoom,
    focusRafRef,
    focusFlightRef,
    onCanvasMouseDown,
  };
}
