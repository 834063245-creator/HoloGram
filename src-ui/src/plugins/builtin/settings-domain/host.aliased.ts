// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 设置域插件宿主依赖面 · 构建产物域（增补四，first-party-hot-reload-plan）。
// 与 host.ts 同形状的镜像实现，全部能力从宿主桥 mods 取用；本文件不参与
// tsc 测试域（esbuild onResolve 把 './host' 重定向到这里）；类型面以
// `typeof import('./host')` 对拍。jsx / jsxs / Fragment：esbuild automatic
// JSX 注入面。
//
// 2026-09-24 批 1 归家：三页 + preset-authoring 进包 ⇒ 新增下面的逐符号桥
// （删掉整页桥 McpPage/PluginsPage/SkillsPage 与作者面三件——它们已是包内实现）。

/* eslint-disable */
import type { ComponentType, ReactNode } from 'react';

interface PluginHostBridge {
  react: {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ReactNode;
    Fragment: unknown;
  };
  mods: {
    faceDeps: Record<string, unknown>;
  };
}

function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) {
    throw new Error(
      '[settings-domain/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载（window.__lantai_plugin_host__ 缺失）',
    );
  }
  return host;
}

const host = requireHost();

/** 依赖实现（形状对拍开发域 host.ts——mods.faceDeps 是其超集）。 */
const impl = host.mods.faceDeps as unknown as typeof import('./host');

export const selectPreset = impl.selectPreset;
// provider 配置文件通道（2026-09-24 配方改文件批）
export const saveProvidersDoc = impl.saveProvidersDoc;
export const providersFilePath = impl.providersFilePath;
export const providersDocStatus = impl.providersDocStatus;
export const onProvidersDocChange = impl.onProvidersDocChange;
export const ensureProvidersDir = impl.ensureProvidersDir;
export const loadProjectProvidersDoc = impl.loadProjectProvidersDoc;
export const projectProvidersErrors = impl.projectProvidersErrors;
export const projectProvidersFatal = impl.projectProvidersFatal;
export const retryProvidersPath = impl.retryProvidersPath;
// S6 P3b：激活诊断读面（设置面板「组合」节第四栏）
export const activationConflict = impl.activationConflict;
export const activationSkipped = impl.activationSkipped;
export const setLang = impl.setLang;
export const typedJsonRpc = impl.typedJsonRpc;
export const autoUpdateCheckEnabled = impl.autoUpdateCheckEnabled;
export const canvasWheelMode = impl.canvasWheelMode;
export const loadSettings = impl.loadSettings;
export const loadSettingsWithSecrets = impl.loadSettingsWithSecrets;
export const saveSettings = impl.saveSettings;
export const notifyAgentConfigChanged = impl.notifyAgentConfigChanged;
export const useCompositionStore = impl.useCompositionStore;
export const useDockStore = impl.useDockStore;
export const usePresetStore = impl.usePresetStore;
export const useUpdateStore = impl.useUpdateStore;
export const iconHtml = impl.iconHtml;
export const ConfirmDialog = impl.ConfirmDialog as ComponentType;

// ── 批 1 逐符号桥（归家页面的内核依赖面）──
export const Icon = impl.Icon as ComponentType;
export const useShellStore = impl.useShellStore;
export const scanSkills = impl.scanSkills;
export const activeLlmAdapters = impl.activeLlmAdapters;
export const buildOauthHeaders = impl.buildOauthHeaders;
export const createLiveProvider = impl.createLiveProvider;
export const createProvider = impl.createProvider;
export const defaultBaseUrl = impl.defaultBaseUrl;
export const getDynamicFetchFailure = impl.getDynamicFetchFailure;
export const getModel = impl.getModel;
export const invalidateCredentialCache = impl.invalidateCredentialCache;
export const invalidateOauthCache = impl.invalidateOauthCache;
export const loadProvidersDoc = impl.loadProvidersDoc;
export const markDynamicFetchStart = impl.markDynamicFetchStart;
export const mergeDynamicModels = impl.mergeDynamicModels;
export const mountDialogFocus = impl.mountDialogFocus;
export const oauthAccounts = impl.oauthAccounts;
export const oauthLogout = impl.oauthLogout;
export const onDynamicFetchChange = impl.onDynamicFetchChange;
export const Overlay = impl.Overlay;
export const providerId = impl.providerId;
export const recordDynamicFetchResult = impl.recordDynamicFetchResult;
export const resolveOauthToken = impl.resolveOauthToken;
export const runDeviceLogin = impl.runDeviceLogin;
export const isBundledEngineEnabled = impl.isBundledEngineEnabled;
export const onBundledEnginePrefChanged = impl.onBundledEnginePrefChanged;
export const probeBundledEngine = impl.probeBundledEngine;
export const setBundledEngineEnabled = impl.setBundledEngineEnabled;
export const activateExternalPlugin = impl.activateExternalPlugin;
export const deactivateExternalPlugin = impl.deactivateExternalPlugin;
export const McpServerDeclSchema = impl.McpServerDeclSchema;
export const isUserMcpMissingError = impl.isUserMcpMissingError;
export const parseUserMcpJson = impl.parseUserMcpJson;
export const resolveUserMcpJsonPath = impl.resolveUserMcpJsonPath;
export const describeReceipt = impl.describeReceipt;
export const useBundledEngineStore = impl.useBundledEngineStore;
export const usePluginPrefs = impl.usePluginPrefs;
export const usePluginStore = impl.usePluginStore;
export const reapplyComposition = impl.reapplyComposition;
export const discoverPresets = impl.discoverPresets;
export const stringifyPatchYaml = impl.stringifyPatchYaml;
export const builtinPresets = impl.builtinPresets;
export const isValidPresetId = impl.isValidPresetId;
export const kernelCreateDirectory = impl.kernelCreateDirectory;
export const kernelDeleteFile = impl.kernelDeleteFile;
export const kernelReadFile = impl.kernelReadFile;
export const kernelWriteFile = impl.kernelWriteFile;
export const parseJson = impl.parseJson;
export const typedRpc = impl.typedRpc;
// 批 9f-1（2026-09-26）：Provider 编辑面随本包（`provider-data.ts` / `model-sync.ts`）⇒
// 撤四键（applyFetchedModels / addProvider / persistSecrets / removeSecret，见 host.ts 注），
// 补留内核的邻居键（包内 `provider-data.ts` 与 Provider 三页取用）。
export const findVendorTemplate = impl.findVendorTemplate;
export const getVendorTemplateVendors = impl.getVendorTemplateVendors;
export const VENDOR_TEMPLATES = impl.VENDOR_TEMPLATES;
export const getCatalogVendors = impl.getCatalogVendors;
export const getDefaultModel = impl.getDefaultModel;
export const modelMaxTokens = impl.modelMaxTokens;
export const effectiveModels = impl.effectiveModels;
export const modelContextWindow = impl.modelContextWindow;
export const modelDescriptor = impl.modelDescriptor;
export const modelInput = impl.modelInput;
// A4 销账 W2（2026-09-28）：ProviderPage 原先直引内核 `settings.ts` 取这两个纯投影
// （模块本体带投影 + 订阅表 = 有身份）⇒ 改走本桥（键早已在 faceDeps 在册）。
export const getActiveProvider = impl.getActiveProvider;
export const updateProvider = impl.updateProvider;
export const PROVIDER_PROTOCOL_DEFAULTS = impl.PROVIDER_PROTOCOL_DEFAULTS;
export const intentOf = impl.intentOf;
// 日志可观测性批 2：凭据写面的事件门面（与 host.ts 同形状镜像）
export const credStore = impl.credStore;
export const credRemove = impl.credRemove;
export const panelReload = impl.panelReload;
// 日志可观测性批 4：级别开关面（DiagnosticPage 取用；与 host.ts 同形状镜像）
export const logLevel = impl.logLevel;
export const setLogLevelPreference = impl.setLogLevelPreference;

export type AppSettings = import('./host').AppSettings;
export type ConnectionProbe = import('./host').ConnectionProbe;
export type ProbeOutcome = import('./host').ProbeOutcome;
export type ProviderSettings = import('./host').ProviderSettings;
export type ProviderId = import('./host').ProviderId;
export type BundledEngineInfo = import('./host').BundledEngineInfo;
export type McpServerDecl = import('./host').McpServerDecl;
export type PluginRecord = import('./host').PluginRecord;
export type SkillDef = import('./host').SkillDef;
export type LogLevel = import('./host').LogLevel;
export type LogLevelSource = import('./host').LogLevelSource;
export type DiscoverPresetsOptions = import('./host').DiscoverPresetsOptions;
export type PresetEntry = import('./host').PresetEntry;

// ── esbuild automatic JSX 注入面（--jsx=automatic --jsx-import-source=./host）──

export function jsx(type: unknown, props: Record<string, unknown> | null, key?: unknown): ReactNode {
  const merged = key != null ? { ...(props ?? {}), key } : (props ?? {});
  return host.react.createElement(type, merged) as ReactNode;
}

export function jsxs(type: unknown, props: Record<string, unknown> | null, key?: unknown): ReactNode {
  return jsx(type, props, key);
}

export const Fragment = host.react.Fragment;
export type { ComponentType };
