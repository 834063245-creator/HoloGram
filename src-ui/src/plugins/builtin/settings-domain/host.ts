// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 设置域插件宿主依赖面 · 开发/测试域（增补四，first-party-hot-reload-plan）。
// tsc / vitest / bundle 域直连真实模块；esbuild 产物域构建期重定向到
// './host.aliased.ts'（宿主桥 mods 共享真实例）。两域形状必须一致
// （host.aliased.ts 以 `typeof import('./host')` 对拍）：本文件只做
// re-export，不改写任何实现。
//
// 2026-09-24 批 1 归家：`McpPage` / `PluginsPage` / `SkillsPage` / `preset-authoring`
// 已搬进本包 ⇒ 它们的内核依赖从「整页桥」变成**逐符号桥**（下方按模块路径排序的
// 那些新条目——biome organizeImports 会按路径重排，故不再挂小节注释）。
// `ProviderPage` 家族（§2.1 的 2,740 行）与 `ConfirmDialog`（§4-3 归属待裁）仍在内核，
// 照旧整页桥。要点：`scanSkills`（技能列表源，批 3 随 skill-domain 走）、
// 随包引擎开关面（McpPage 卡片）、loader 装卸面（PluginsPage 按钮，运行期取用）、
// `stringifyPatchYaml`（作者面 YAML 序列化留内核——产物不得裸 import）。

export type { LogLevel, LogLevelSource } from '../../../agent/logger';
// 日志可观测性批 4（2026-10-12）：设置页「诊断」签的级别开关面（读当前级别 +
// 持久化偏好并立即生效）。同上：内核基础设施，产物域经宿主桥取用。
export { logLevel, setLogLevelPreference } from '../../../agent/logger';
// 日志可观测性批 2（2026-09-27）：凭据写面的事件门面（provider-data.ts 的
// persistSecrets / removeSecret 用）。内核不可禁的基础设施，经宿主桥取用。
export { credRemove, credStore, panelReload } from '../../../agent/obs';
export type { SkillDef } from '../../../agent/skill-contract';
// 技能域（SkillsPage 列表源）——批 9h-3（2026-09-26）：实现随 skill-domain 包 ⇒
// 列表源改走内核登记表门面 `scanSkills`（`agent/skill-impl.ts`），形状从契约文件取。
export { scanSkills } from '../../../agent/skill-impl';
export { ConfirmDialog } from '../../../app/ConfirmDialog';
// 批 9d（2026-09-26）：Provider 控制台 8 件归家 ⇒ 桥它们的**有状态**内核依赖面
// （纯模块——vendor-templates / thinking / custom-headers / types——随包内联，不桥）。
export { mountDialogFocus } from '../../../app/dialog-focus';
// 应用壳件
export { Icon } from '../../../app/Icon';
export { Overlay } from '../../../app/overlay';
export { useShellStore } from '../../../app/shell-store';
// S6 P3b：激活诊断读面（设置面板「组合」节第四栏「被跳过」+ 独占冲突回看）
export { activationConflict, activationSkipped } from '../../../composition/activation';
// 组合作者面（preset-authoring 归家后仍住内核的机制面）
export { reapplyComposition, selectPreset } from '../../../composition/preset-assembly';
export {
  type DiscoverPresetsOptions,
  discoverPresets,
  stringifyPatchYaml,
} from '../../../composition/preset-discovery';
export { builtinPresets, isValidPresetId, type PresetEntry } from '../../../composition/presets';
export { activeLlmAdapters } from '../../../composition/services';
export { setLang } from '../../../i18n';
// 随包引擎开关面（McpPage「随包图谱引擎」卡片）——批 10 部件三起，内核只剩探测 + 开关两件
// （接线已随 `bundled-engine` 产物）
export {
  type BundledEngineInfo,
  isBundledEngineEnabled,
  onBundledEnginePrefChanged,
  probeBundledEngine,
  setBundledEngineEnabled,
} from '../../../plugins/bundled-engine-prefs';
// 装卸面（PluginsPage 的启用/禁用/卸载按钮；与 loader 的循环为运行期取用，见
// host-modules.ts 头注）
export { activateExternalPlugin, deactivateExternalPlugin } from '../../../plugins/loader';
export { type McpServerDecl, McpServerDeclSchema } from '../../../plugins/types';
export { isUserMcpMissingError, parseUserMcpJson, resolveUserMcpJsonPath } from '../../../plugins/user-mcp';
export { createProvider } from '../../../provider';
export {
  getCatalogVendors,
  getDefaultModel,
  getDynamicFetchFailure,
  getModel,
  markDynamicFetchStart,
  mergeDynamicModels,
  onDynamicFetchChange,
  recordDynamicFetchResult,
} from '../../../provider/catalog';
export { invalidateCredentialCache, invalidateOauthCache, resolveOauthToken } from '../../../provider/credentials';
export { createLiveProvider } from '../../../provider/live';
export { buildOauthHeaders, oauthAccounts, oauthLogout, runDeviceLogin } from '../../../provider/oauth';
export { intentOf } from '../../../provider/providers-doc';
// provider 配置文件通道（2026-09-24 配方改文件批）：设置页显示路径与逐节错误、
// 打开目录、保存时写盘——意图的唯一权威是那份 YAML，这里是它的界面面。
export {
  ensureProvidersDir,
  loadProjectProvidersDoc,
  loadProvidersDoc,
  onProvidersDocChange,
  projectProvidersErrors,
  projectProvidersFatal,
  providersDocStatus,
  providersFilePath,
  retryProvidersPath,
  saveProvidersDoc,
} from '../../../provider/providers-store';
// 批 9f-1（2026-09-26）：Provider 编辑面 7 个符号随本包（`provider-data.ts` / `model-sync.ts`）⇒ 上述
// 四个键销账；下面四个是**留内核的邻居**（`modelMaxTokens` 被内核 `modelDescriptor` 自用；vendor/catalog
// 三个读面供包内 `provider-data.ts` 的 `isFactoryBaseUrl` / `addProvider` 使用——原先它们被 .tsx 直接
// import 内核 `settings.ts`/`provider/*`，产物域会把内核模块连状态一起内联成副本，本批一并消除）。
export { findVendorTemplate, getVendorTemplateVendors, VENDOR_TEMPLATES } from '../../../provider/vendor-templates';
// 强制层 fs 口 + RPC 面（两页 + 作者面的 IO）
export {
  kernelCreateDirectory,
  kernelDeleteFile,
  kernelReadFile,
  kernelWriteFile,
  parseJson,
  typedJsonRpc,
  typedRpc,
} from '../../../rpc-contract';
export type { AppSettings, ConnectionProbe, ProbeOutcome, ProviderId, ProviderSettings } from '../../../settings';
// 批 9f-1 续：包内 `provider-data.ts` 与 Provider 三页需要的其余内核读面（均已是 faceDeps 键，
// 只是本文件此前没出口——原先三页直接 import 内核路径，产物域因此把 `settings.ts` 连状态一起内联）。
export {
  autoUpdateCheckEnabled,
  canvasWheelMode,
  defaultBaseUrl,
  effectiveModels,
  getActiveProvider,
  loadSettings,
  loadSettingsWithSecrets,
  modelContextWindow,
  modelDescriptor,
  modelInput,
  modelMaxTokens,
  PROVIDER_PROTOCOL_DEFAULTS,
  providerId,
  saveSettings,
  updateProvider,
} from '../../../settings';
export { notifyAgentConfigChanged } from '../../../state/agent-config-store';
export { describeReceipt, useBundledEngineStore } from '../../../state/bundled-engine-store';
export { useCompositionStore } from '../../../state/composition-store';
export { useDockStore } from '../../../state/dock-store';
export { usePluginPrefs } from '../../../state/plugin-prefs';
export { type PluginRecord, usePluginStore } from '../../../state/plugin-store';
export { usePresetStore } from '../../../state/preset-store';
export { useUpdateStore } from '../../../state/update-store';
export { iconHtml } from '../../../ui/icons';
