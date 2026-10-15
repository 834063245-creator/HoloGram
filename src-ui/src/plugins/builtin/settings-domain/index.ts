// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// settings 域第一方插件（S3）—— settings 面板域行化：面板 + 命令双贡献。
//
// 挂载通道（S3 设计件 §2.5）：从 panel-def 常量行 + 壳行 toggle-settings
// 动作迁为组合层贡献（对齐 paper-shell 插件先例——「重构推到哪个域，
// 行化跟到哪个域」）。settings.ts 持久化与 agent-config-store 订阅
// 是 workspace 级关注点，留壳层不动（原范围裁决，设计件 §0）。
//
// 注册纪律：disposer 经 ctx.effect 登记（四 service 裸 disposer 契约——
// 调用方负责所有权，见 composition/services.ts 头注）；装载在四 service
// 之后（loadBuiltinPlugins 表序），ctx.panels / ctx.commands 可解析。
// 快捷键 ctrl+, 的分发链不变：useGlobalKeys 字面量 runAction('toggle-settings')
// → app/actions.ts 别名翻译层 → 本插件的 settings/toggle 贡献（设计件 §2.3）。
//
// 双走查形态（增补四，first-party-hot-reload-plan）：bundle 兜底行 +
// 产物域（dist-plugins/builtin/hologram/settings-domain/，manifest 声明
// displace 位移 bundle 行；设置面板「重新加载」热替换）。

import type { Context } from '../../../cordis';
import { injectFaceArtifactCss } from '../face-css';
import { useDockStore } from './host';
import { SettingsPanel } from './SettingsPanel';
import { bootUpdateCheck } from './update-check';

/** settings 域插件 — 面板贡献（即时生效）+ toggle 命令贡献。 */
export const settingsPlugin = {
  name: 'hologram/settings-domain',
  inject: ['panels', 'commands', 'shellRows'],
  apply(ctx: Context) {
    /* §4-9（批 10 同窗）：壳行贡献——启动期自动检查更新（原内核 shell-update-check 行）。
     * 行 id 用 plugin/ 前缀（对齐工具行先例）；boot 期由 bootShell 在内置行之后按注册序执行。 */
    ctx.effect(
      () =>
        ctx.shellRows.register({
          id: 'plugin/hologram/settings-domain/shell-update-check',
          boot: () => bootUpdateCheck(),
        }),
      'shell-update-check',
    );
    injectFaceArtifactCss();
    ctx.effect(
      () =>
        ctx.panels.register({
          id: 'settings',
          // side:null 全屏覆盖 + 关即卸载（对齐旧 panel-def 常量行，逐字段等值迁移）
          side: null,
          title: '设置',
          icon: 'settings',
          unmountOnClose: true,
          // 关时先留一个出场窗（§15 退场对称）——出场样式在 settings-panel.css
          animateExit: true,
          component: SettingsPanel,
        }),
      'settings-panel',
    );
    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'settings/toggle',
          label: '设置…',
          group: '设置',
          slash: '/settings',
          // kbd 是 palette 显示值（kbd 提示）；键绑定仍在 useGlobalKeys 全局层
          kbd: 'ctrl ,',
          action: { type: 'local', handler: () => useDockStore.getState().togglePanel('settings') },
        }),
      'settings-command',
    );
  },
};

/** 产物域 default 导出（WO-S0B 契约：pickPluginObject 取 default；缺此导出时位移装载会形状失败）。 */
export default settingsPlugin;
