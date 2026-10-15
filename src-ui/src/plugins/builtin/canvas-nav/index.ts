// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// plugins/builtin/canvas-nav — 画布导航第一方插件（Stage-3；增补四通道化）。
//
// 侧边栏 + 书脊 = 上层形态（原则二/三）：两个面板都以贡献行落位
// （ctx.panels 注册 'canvas-spine' / 'canvas-sidebar'），消费 ctx.space
// （activeSpace() 读面 + focus/expand/place/collapse 四命令），不新增核心 API。
//
// 互斥两态（2026-09-02 用户拍板）：书脊列 = 侧边栏的收起态——左缘任一
// 时刻只留一个。侧边栏展开 → 书脊整列退场；收起 → 书脊回场。开侧栏期间
// 书脊的空间手势由侧栏行承接（行点击定位 + 行拖放落位，SpineRack 手势
// 同族）。paper 是两个覆盖层的生命周期锚（paper 开 → 书脊态起步；paper
// 关 → 两者全退）。
//
// 双走查形态（增补四，first-party-hot-reload-plan）：本目录同时是
//   A. 编译期 bundle 域（BUILTIN_PLUGINS 表项——出厂兜底行）；
//   B. 构建产物域（esbuild → dist-plugins/builtin/hologram/canvas-nav/
//      entry.js + entry.css——磁盘通道装载 + manifest.displace 位移
//      bundle 行；设置面板「重新加载」热替换）。
// 面板组件的项目内依赖经 './host' 取宿主共享真实例（host.aliased.ts 为
// 构建期替换面），CSS 随产物携带（entry.css 经宿主 loadCss 注入）。
//
// 注册纪律：disposer 经 ctx.effect 登记（四 service 裸 disposer 契约）；
// 装载在 compositionServicesPlugin + spaceServicePlugin 之后（inject 依赖可解析）。

import type { Context } from '../../../cordis';
import { injectFaceArtifactCss } from '../face-css';
import { useDockStore } from './host';
import { SessionSidebar } from './SessionSidebar';
import { SpineRack } from './SpineRack';

/** 画布导航插件——书脊 + 案卷侧边栏双面板贡献 + 开合同步（互斥两态）+ toggle 命令。 */
export const canvasNavPlugin = {
  name: 'hologram/canvas-nav',
  inject: ['panels', 'commands', 'space'],
  apply(ctx: Context) {
    injectFaceArtifactCss();
    ctx.effect(
      () =>
        ctx.panels.register({
          id: 'canvas-spine',
          side: 'left',
          title: '书脊',
          icon: 'book',
          unmountOnClose: true,
          // 出场：与 sr-slide-in 逆写（§15 退场对称）——互斥两态换态不再「一边滑入、一边凭空消失」
          animateExit: true,
          component: SpineRack,
        }),
      'canvas-spine-panel',
    );
    ctx.effect(
      () =>
        ctx.panels.register({
          id: 'canvas-sidebar',
          side: 'left',
          title: '案卷',
          icon: 'list',
          unmountOnClose: true,
          // 出场：与 ss-slide-in 逆写（§15 退场对称）
          animateExit: true,
          component: SessionSidebar,
        }),
      'canvas-sidebar-panel',
    );

    // 开合同步：纸面板是两个覆盖层的生命周期锚（纸关 = 画布上下文退场）。
    // 纸开 → 书脊态起步（侧栏不自动展开——用户经「案卷」toggle 或 /sidebar
    // 命令唤出）；纸关 → 两者全关。只在 paper 开合翻转时同步。
    let prevPaperOpen = useDockStore.getState().open.paper === true;
    const syncPanels = (): void => {
      const paperOpen = useDockStore.getState().open.paper === true;
      if (paperOpen === prevPaperOpen) return;
      prevPaperOpen = paperOpen;
      if (paperOpen) {
        useDockStore.getState().openPanel('canvas-spine');
      } else {
        useDockStore.getState().closePanel('canvas-spine');
        useDockStore.getState().closePanel('canvas-sidebar');
      }
    };
    // 互斥不变量（终态裁决，任何 dock 写入后跑一遍）：侧栏与书脊不并陈——
    // 并陈 → 书脊退（侧栏胜）；纸开着而两者皆关 → 书脊回场（收起态默认）。
    // 终态式对热替换自愈：旧版「paper 开 = 双开」遗留态在装载首跑即被收敛。
    const enforceExclusivity = (): void => {
      const st = useDockStore.getState();
      if (st.open['canvas-sidebar'] === true && st.open['canvas-spine'] === true) {
        st.closePanel('canvas-spine');
      } else if (st.open['canvas-sidebar'] !== true && st.open['canvas-spine'] !== true && st.open.paper === true) {
        st.openPanel('canvas-spine');
      }
    };
    ctx.effect(() => {
      syncPanels();
      enforceExclusivity();
      return useDockStore.subscribe(() => {
        syncPanels();
        enforceExclusivity();
      });
    }, 'canvas-nav-sync');

    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'canvas/sidebar-toggle',
          label: '案卷侧边栏（开/收起）',
          group: '画布',
          slash: '/sidebar',
          action: { type: 'local', handler: () => useDockStore.getState().togglePanel('canvas-sidebar') },
        }),
      'canvas-sidebar-command',
    );
  },
};

/** 产物域 default 导出（WO-S0B 契约：pickPluginObject 取 default；缺此导出时位移装载会形状失败）。 */
export default canvasNavPlugin;
