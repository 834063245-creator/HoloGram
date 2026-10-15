// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 焦点飞行域（paper-panel-split C2）——视口轻动画：飞到指定会话的指定世界点
//（书脊/侧边栏/目次带/键盘走卷共用）+ 小地图点击滑视 + pendingFocus 补飞。
// 飞行调度（focusFlight）与 raf 载体由 use-paper-viewport 创建传入——wheel/
// 手动拖拽在视口域抢占飞行，两域共享同一实例（同仓显式穿参纪律，禁共享模块态）。

import type { MutableRefObject } from 'react';
import { useCallback, useEffect } from 'react';
import type { createFocusFlightScheduler } from './focus-flight';
import type { RegionView } from './host';
import { getCanvasStore, useCanvasViewStore, viewFocusRegion } from './host';
import type { PaperCore } from './use-paper-sessions';

/** 焦点飞行域（paper-panel-split C2，自 PaperPanel 1476-1590 域内原样搬入）。
 *  挂载序约束：必须晚于 use-paper-regions 调用——补飞 effect 依赖 regions
 *  值（regions 引用变化 = 触发重判）。 */

/** 飞行动画归一化进度（两族 fly 共用）。
 *
 *  ⚠ **不混钟 + 夹零**（2026-09-18 出处引导批实测立案）：旧实现以
 *  `t0 = performance.now()` 起算、`now` 取 rAF 回调时间戳——两把钟不同源时
 *  `now < t0` ⇒ `t` 为负 ⇒ `ease` 为负且越走越负，而 `t < 1` 恒真 ⇒
 *  **rAF 循环永不终止、视口一带一路飞出内容之外**（jsdom 实测：now 4968 vs
 *  t0 6268 ⇒ t = −5.4、单帧 panY 位移 −17 万 px，四帧内 panY 到 −16.7 万）。
 *  真机 Chromium 两钟同源（都是 time origin 起算的 DOMHighResTimeStamp）故不
 *  触发，但「循环靠两把钟恰好对齐才终止」不该是契约。现行两条：
 *  ① 起点 = **首帧的 rAF 时间戳**（同一把钟，环境无关，动画当场起跑）；
 *  ② 进度夹 [0,1]（单调不减 ⇒ 到 1 即 else 分支收尾，循环必然终止）。 */
function progressOf(now: number, t0: number, duration: number): number {
  return Math.min(1, Math.max(0, (now - t0) / duration));
}

/** 焦点飞行时长（§15 让位档）。
 *
 *  ⚠ **必须是 `tokens.css` 的 `--m-sheet` 值**（0.26s）——两把尺子一把：
 *  这里是 rAF 帧动画、那边是 CSS transition，同一个「让位」读感不能两个时长。
 *  镜像由 `tests/motion-contract.test.ts` 钉死（改一处不改另一处即红）。
 *  旧案是「240」字面量**在本文件写了两遍**（flyToPoint + glideViewTo），
 *  换一处漏一处——2026-10-15 §15 收成单常量。 */
const FOCUS_FLIGHT_MS = 260;

/** 动效敏感用户（§15 约束律）。
 *
 *  病灶：`foundation.css` 的 `prefers-reduced-motion` 块把 animation/transition
 *  时长压到 0.01ms，但它**管不到 JS 帧动画**——于是开了「减弱动效」的用户，
 *  唯一还在动的恰好是幅度最大的那个动作：视口飞越整张纸。故 rAF 飞行必须自觉
 *  读 matchMedia，降级 = **直达目标**（导航功能不变，只是不过场，与 CSS 侧
 *  0.01ms 的语义一致）。 */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function usePaperFocus(params: {
  core: PaperCore | null;
  canvasSize: { w: number; h: number };
  regions: RegionView[];
  regionsRef: MutableRefObject<RegionView[]>;
  focusRafRef: MutableRefObject<number>;
  focusFlightRef: MutableRefObject<ReturnType<typeof createFocusFlightScheduler>>;
}) {
  const { core, canvasSize, regions, regionsRef, focusRafRef, focusFlightRef } = params;

  /* ── 视口轻动画：飞到指定会话的指定世界点（书脊定位器/目次带/键盘走卷共用）──
   * 复用 viewFocusRegion（锚到流区中轴 + 目标世界 y）；anchorX 缺省 = 该卷当前
   * 渲染中轴（调用方都在卷已落位的场景）；flyToRegion 显式传真位置（见下）。 */
  const flyToPoint = useCallback(
    (sessionId: string, worldY: number, anchorX?: number) => {
      const x = anchorX ?? regionsRef.current.find((r) => r.sessionId === sessionId)?.anchor.anchorX;
      if (x === undefined) return;
      // 同目标动画在途不再重播（regions 随视口每帧换引用——无守卫会自锁成乱飞）
      if (focusFlightRef.current.begin(sessionId) === 'rejected') return;
      const start = useCanvasViewStore.getState().view;
      const target = viewFocusRegion(start, canvasSize.w, canvasSize.h, { x, y: worldY });
      if (focusRafRef.current) cancelAnimationFrame(focusRafRef.current);
      /* 动效敏感：不过场，直达（仍要 end() + 清 pending —— 否则画面静了而
       * 飞行态永远在途，后续 begin() 全被 'rejected' 挡掉 = 导航静默失灵）。 */
      if (prefersReducedMotion()) {
        useCanvasViewStore.getState().setView(target);
        focusRafRef.current = 0;
        focusFlightRef.current.end();
        useCanvasViewStore.getState().requestFocus(null);
        return;
      }
      let t0: number | null = null; // 首帧 rAF 时间戳（同一把钟，见 progressOf）
      const tick = (now: number) => {
        if (t0 === null) t0 = now;
        const t = progressOf(now, t0, FOCUS_FLIGHT_MS);
        const ease = 1 - (1 - t) ** 3;
        useCanvasViewStore.getState().setView({
          zoom: start.zoom,
          panX: start.panX + (target.panX - start.panX) * ease,
          panY: start.panY + (target.panY - start.panY) * ease,
        });
        if (t < 1) {
          focusRafRef.current = requestAnimationFrame(tick);
        } else {
          focusRafRef.current = 0;
          focusFlightRef.current.end();
          useCanvasViewStore.getState().requestFocus(null);
        }
      };
      focusRafRef.current = requestAnimationFrame(tick);
    },
    [canvasSize.w, canvasSize.h, regionsRef, focusRafRef, focusFlightRef],
  );
  const flyToRegion = useCallback(
    (sessionId: string) => {
      /* 目标几何唯一取 canvas-store 的 spread（流区位置唯一真相），**不读
       * regionsRef**（2026-09-10 用户两问之一：新建卷视角导航）：
       * 定序——落位 effect（useRegionPlacement）与 pendingFocus effect（本域）
       * 在同一提交内先后跑，落位先写 spread（真位置），本 effect 随后读到；
       * 但 regions memo 是本提交**渲染期**快照，此刻新卷还没有 spread →
       * defaultRegionFor(i) 网格占位。守卫读 store、目标读 memo = 守卫放行而
       * 目标虚构：视角飞到「卷不在那儿」的网格点（连 pending 都会被那次假飞行
       * 清掉，不再补飞）。两读同源（store）后，飞行目标恒 = 真落位。
       * 无 spread（真未落位：expand/恢复在途）= 不飞，pending 保持给下方补飞
       * effect（R1 语义不变——护栏是「别飞虚构几何」，不是「别飞新卷」）。 */
      if (!core) return;
      const region = getCanvasStore(core.panelId).getState().spread[sessionId];
      if (!region) return;
      flyToPoint(sessionId, region.anchorY, region.anchorX);
    },
    [flyToPoint, core],
  );
  /* 小地图点击跳转（V3b 欠账接回，2026-08-30）：视口中心滑到目标世界点（保 zoom）。
   * 复用 focusRafRef——与 flyToPoint 互斥（后动取消先动）。 */
  const glideViewTo = useCallback(
    (worldX: number, worldY: number) => {
      // glide 也是飞行：进入在途态（无目标卷），阻挡补飞打扰；定位到达后取代
      if (focusFlightRef.current.begin(null) === 'rejected') return;
      const start = useCanvasViewStore.getState().view;
      const target = {
        zoom: start.zoom,
        panX: canvasSize.w / 2 - worldX * start.zoom,
        panY: canvasSize.h / 2 - worldY * start.zoom,
      };
      if (focusRafRef.current) cancelAnimationFrame(focusRafRef.current);
      /* 动效敏感：同 flyToPoint（不过场，但飞行态必须收尾，见那里注）。 */
      if (prefersReducedMotion()) {
        useCanvasViewStore.getState().setView(target);
        focusRafRef.current = 0;
        focusFlightRef.current.end();
        useCanvasViewStore.getState().requestFocus(null);
        return;
      }
      let t0: number | null = null; // 同 flyToPoint：起点取首帧 rAF 时间戳（不混钟）
      const tick = (now: number) => {
        if (t0 === null) t0 = now;
        const t = progressOf(now, t0, FOCUS_FLIGHT_MS);
        const ease = 1 - (1 - t) ** 3;
        useCanvasViewStore.getState().setView({
          zoom: start.zoom,
          panX: start.panX + (target.panX - start.panX) * ease,
          panY: start.panY + (target.panY - start.panY) * ease,
        });
        if (t < 1) {
          focusRafRef.current = requestAnimationFrame(tick);
        } else {
          focusRafRef.current = 0;
          focusFlightRef.current.end();
          useCanvasViewStore.getState().requestFocus(null);
        }
      };
      focusRafRef.current = requestAnimationFrame(tick);
    },
    [canvasSize.w, canvasSize.h, focusRafRef, focusFlightRef],
  );
  const pendingFocusId = useCanvasViewStore((s) => s.pendingFocusId);
  useEffect(() => {
    if (pendingFocusId) flyToRegion(pendingFocusId);
  }, [pendingFocusId, flyToRegion]);
  useEffect(() => {
    // 未摊开卷 expand 在途：流区出现后补飞（pending 未清且目标已存在）。
    // 动画在途不重启（2026-08-31 视口乱飞修复）：regions 随视口每帧换引用，
    // 无守卫会让补飞每帧 cancel+重播动画 → 动画永不完、pending 永不清。
    // R1（2026-09-05，2026-09-10 改为同源读 spread）：spread 尚无目标位置 =
    // 落位 effect 未跑（未摊开/恢复在途）→ 不重判（flyToRegion 内部守卫已挡）；
    // 位置落定后 regions 变化（canvasState.spread 写入 → regions memo 重算）
    // 本 effect 重跑补飞。
    void regions;
    const pending = useCanvasViewStore.getState().pendingFocusId;
    if (pending && !focusFlightRef.current.isActive()) flyToRegion(pending);
  }, [regions, flyToRegion, focusFlightRef]);
  useEffect(
    () => () => {
      if (focusRafRef.current) cancelAnimationFrame(focusRafRef.current);
      focusFlightRef.current.end();
    },
    [focusRafRef, focusFlightRef],
  );

  return { flyToPoint, flyToRegion, glideViewTo };
}
