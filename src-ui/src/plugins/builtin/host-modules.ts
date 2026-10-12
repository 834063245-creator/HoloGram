// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置插件宿主模块面（first-party-hot-reload-plan 增补四施工）——
// 构建产物（builtin/<face>/ 双走查形态）经 window.__lantai_plugin_host__.mods
// 取用的项目模块真实例注册表。
//
// 为什么是「共享真实例」而不是产物内联副本：面组件消费的 zustand store /
// 服务 active 访问器（provider/catalog 动态拉取态、
// paper/measure 观察缓存）/ React Context（PaperDockContext 等）都是模块级
// 单例——产物内联副本会分裂状态（产物组件订阅到影子 store，UI 串流）。
// 本注册表把 bundle 域的唯一实例交给产物域消费；只有面组件本体与其 CSS
// 进入产物（视觉迭代的热更面）。
//
// 形状纪律：mods 的 key 分三组——faceDeps（四面组件共享依赖）/ toolDomains
// （16 工具域插件对象——产物域薄重导出）/ segments（段贡献插件对象）。
// 产物域的 host.aliased.ts 以 `typeof import('./host')` 对拍本表取用形状。
//
// 循环导入注记：本文件被 plugins/loader.ts 引用，而 faceDeps.SettingsDeps
// 里的 PluginsPage 反向引用 loader 的 activate/deactivate——三处都是运行期
// 取用（组件渲染 / 按钮回调），无模块初始化期解引用，ESM 循环安全。

import { Agent } from '../../agent/agent';
import { setActiveAgentLoop } from '../../agent/agent-loop/agent-loop-active';
import { agentSessionState } from '../../agent/agent-session-state';
import { EventKind } from '../../agent/agent-types';
import {
  assetDigest,
  assetKinds,
  generateAssetId,
  parseAssetEventOutput,
  requireKind,
  requirePresentation,
  validatePayload,
} from '../../agent/asset-kinds';
// asset-state（2026-10-07 html 卡状态桥）：渲染层经 renderer-host 取读写两键；
// Agent 读口（asset-domain 的 list_block_kinds）取 owner 解析面。带模块级状态
// （会话表 + 落盘句柄）——必须走桥，禁止随包内联。
import { getAssetState, listAssetStateSummaryForOwner, patchAssetState } from '../../agent/asset-state';
import { findAssetByContent, getAsset, listAssets, upsertAsset } from '../../agent/asset-store';
import { BoardPersistence } from '../../agent/board-persistence';
// S3：工具域/段贡献插件对象导入已拆除——产物域真源自带；此处只导工具工厂
// 运行时值（faceDeps 取用面）。（z（engine-domain 运行时取用）随图谱退役
// 移除，2026-09-09。）
// 批 9h-1 归家（2026-09-26）：capability 十四项内容表进 capability-segments 包 ⇒
// `firstPartyCapabilities` 桥键撤除；该包新的取用面（登记表读面 + 工具工厂）在此供面。
import { createCodeExecutionTool } from '../../agent/code-run/code-execution-tool';
import { COMPACTION_NOTICE_MARK, DEFAULT_COMPACT_RATIO, DEFAULT_RETAIN_RATIO } from '../../agent/compaction-contract';
import { registerCompactionImplementation } from '../../agent/compaction-impl';
import { DEFAULT_C_IN, DEFAULT_C_OUT, LOSS_FACTOR_PER_EVENT } from '../../agent/compaction-tracker';
import { waitForConfirm } from '../../agent/confirm-registry';
import { activeDynamicRunner } from '../../agent/dynamic-runner/dynamic-runner-service';
import { createExecState } from '../../agent/execution-state';
import { extractFilePath, FileOwnership, WRITE_TOOLS } from '../../agent/file-ownership';
import { parseGitLogCommits, parseGitStatusPorcelain } from '../../agent/git-porcelain';
import { registerGoalImplementation } from '../../agent/goal-impl';
import { HookRegistry } from '../../agent/hooks';
import { enqueueIsolationOp } from '../../agent/isolation-queue';
import { once } from '../../agent/lifecycle';
import { log, logLevel, setLogLevelPreference } from '../../agent/logger';
// 批 9h-2 归家（2026-09-26）：出厂默认 loop 实现进 agent-loop-service 包 ⇒
// `defaultAgentLoop` 桥键撤除；改桥该包新的取用面（循环依赖面 3 个缺失键）。
import { errText, finishReasonMessage, parseFilePathArg } from '../../agent/loop-helpers';
import { createTauriProcIO } from '../../agent/mcp/tauri-io';
// 批 9h-4 归家（2026-09-26）：记忆域实现随 memory-domain 包 ⇒ 撤 `createMemoryTools` 桥键
// （该包自持实现，经 `agent/memory-impl.ts` 登记表反向登记）；改桥「事实保存授权」消费口
// （跨模块一次性状态留内核、产物只取用）。
import {
  clearMemoryImplementation,
  consumeFactAuthorization,
  registerMemoryImplementation,
} from '../../agent/memory-impl';
import {
  AgentNotFoundError,
  InboxFullError,
  MessageNotFoundError,
  TopologyDeniedError,
} from '../../agent/message-contract';
import { registerMultiagentComm, requireMultiagentComm } from '../../agent/multiagent-impl';
// 日志可观测性批 2：产物域的事件门面出口（settings-domain 的凭据写面 +
// llm-adapters 的出网四相）。obs 的**函数无模块状态**（除键控自清理的去重表），
// 故桥函数引用即可——产物与内核写的是同一本日志。
import { credRemove, credStore, llmDone, llmError, llmFirstByte, llmSend, panelReload } from '../../agent/obs';
import { activePlanImplementation, registerPlanImplementation } from '../../agent/plan/plan-impl';
import { planRegistry } from '../../agent/plan/plan-registry';
import { registerCompactionTools } from '../../agent/runtime/agent-builder';
import { execStreamedShell } from '../../agent/runtime/queued-shell';
import {
  assertSupportedSchema,
  buildOutputSchemaInstruction,
  extractJsonObject,
  validateObjectJsonSchema,
} from '../../agent/schema-validate';
import { isAbsolutePath, ownerContext, resolveAgainstRoot, stickyCwdOf } from '../../agent/session-context';
import { buildCompactedSummaryMessage } from '../../agent/session-log';
// 批 9h-3 归家（2026-09-26）：技能域实现随 skill-domain 包 ⇒ 撤 `createSkillTool` 桥；
// `scanSkills` 改经内核登记表门面（settings-domain 的 SkillsPage 列表源读它）。
import { clearSkillImplementation, registerSkillImplementation, scanSkills } from '../../agent/skill-impl';
import { parseIsolationDiff, spillToFile } from '../../agent/spill';
import { activeStateHooksImplementation, registerStateHooksImplementation } from '../../agent/state-hooks-impl';
import {
  buildPreReadBlock,
  cacheBuildResult,
  formatDiagnostics,
  invalidateBlameEntry,
  refreshGitBlame,
} from '../../agent/state-inject';
import { StreamingToolExecutor } from '../../agent/streaming-executor';
import {
  getSubAgentActivity,
  removeSubAgentActivity,
  STUCK_THRESHOLD_S,
  wrapSubAgentSink,
} from '../../agent/subagent-activity';
// 批 3a 归家：wait/office/cordis 三域工厂已随包 ⇒ 撤桥，改桥它们仍住内核的依赖面。
import { SubAgentStatus } from '../../agent/subagent-runtime-contract';
import { activeDiscoveryTools, activeMergeTools, registerSubagentRuntime } from '../../agent/subagent-runtime-impl';
import { activeSubAgentTools, registerSubAgentTools } from '../../agent/subagent-tools-impl';
// 批 9h-5（2026-09-26）：task 三件实现随 task-domain 包 ⇒ 撤 `TaskManager` 类键（改
// `createTaskManager` 门面）、`createTaskTools` / `createBoardStatusTool` 改指内核门面
// `agent/task-impl`，并补该包的登记口 + 两个新内核依赖（`BoardPersistence` / `spillToFile`）。
import {
  clearTaskImplementation,
  createBoardStatusTool,
  createTaskManager,
  createTaskTools,
  registerTaskImplementation,
} from '../../agent/task-impl';
import { countMessage, countMessages, countText } from '../../agent/token-counter';
// §4-6 A（2026-09-26）：分桶代数真源 = 内核第 16 个 service `ctx.tokenMeter` 的 usage 面
// ——创作坞墨量册此前直接 import 内核实现文件（构建期内联第二份副本），改经本桥取唯一实例。
import { tokenAlgebra } from '../../agent/token-meter/service';
import { ToolRegistry } from '../../agent/tool';
import { foldToolResults, nextFoldBoundary } from '../../agent/tool-fold';
import { hasImageRefs } from '../../agent/tool-images';
// 批 4c-2 归家：agent-isolation / ask 两族进包 ⇒ 撤工厂桥；两族只余 defineTool/类型面。
import { defineTool, toInputJsonSchema } from '../../agent/tools/define-tool';
import { convergeRegistry, resolveGuardToolName } from '../../agent/tools/domains';
import { parseStructuredError } from '../../agent/tools/structured-error';
import { ConfirmDialog } from '../../app/ConfirmDialog';
import { useCoreStore } from '../../app/chat/core-instance';
import { extractImageFiles, previewUrlFor, readAttachmentBase64 } from '../../app/chat/image-intake';
import { filterCommands, listCommands, slashOnly } from '../../app/commands/command-catalog';
import { ensureSkillCatalog } from '../../app/commands/skill-catalog';
import { mountDialogFocus } from '../../app/dialog-focus';
import { Icon } from '../../app/Icon';
import { Overlay, useDialogEscape } from '../../app/overlay';
import { PluginBoundary } from '../../app/PluginBoundary';
// 批 1 归家：McpPage / PluginsPage / SkillsPage 已迁 plugins/builtin/settings-domain/
// （改为逐符号桥，见下方「批 1」段）；ProviderPage 家族仍在内核（批 9）。
// 批 8b 归家：纸面块渲染器进 paper-renderers 包 ⇒ 桥它仍住应用 bundle 的件
// （MermaidBlock 是重依赖例外：内部 import('mermaid') 是动态裸 import，产物构建闸拒绝）。
import MermaidBlock from '../../app/paper/mermaid-block';
import { useShellStore } from '../../app/shell-store';
import { WinControls } from '../../app/WinControls';
import { onTopbarDoubleClick, onTopbarPointerDown } from '../../app/window-drag';
import { isMockMode, watchFileDragDrop } from '../../bridge';
// S6 P3b：激活诊断读面（设置面板「组合」节第四栏「被跳过」+ 独占冲突回看）
import { activationConflict, activationSkipped } from '../../composition/activation';
import { ContributionChannel } from '../../composition/contribution-channel';
import { activeFsProviders } from '../../composition/fs-service';
import { activeOverlayContributions, subscribeOverlayContributions } from '../../composition/overlay-service';
import { reapplyComposition, selectPreset } from '../../composition/preset-assembly';
import { discoverPresets, stringifyPatchYaml } from '../../composition/preset-discovery';
import { builtinPresets, isValidPresetId } from '../../composition/presets';
import { resolveAssetBlock, resolveRenderer } from '../../composition/renderer-service';
import { ownerIdOf, ownerSeamView } from '../../composition/seam-scope';
import { activeLlmAdapters } from '../../composition/services';
import { activeShellProviders } from '../../composition/shell-service';
import { activeSpace } from '../../composition/space-service';
import { Service } from '../../cordis';
import { setLang } from '../../i18n';
// A4 销账 W1（2026-09-28）：`createBlock` 也经宿主面出（renderers 的双走查查看器建块用）——
// 该模块带块 id 发号器（`let blockSeq`），产物域随包内联会另起一套号、与画布（以 id 为键）撞车。
import { createBlock, writingBlockIdOf } from '../../paper/block-model';
import {
  ANCHOR,
  autoPanVector,
  layoutRegion,
  nextZoomStep,
  panBy,
  screenToWorld,
  viewFocusRegion,
  viewportCenterWorld,
  wheelFactor,
  worldToScreen,
  zoomAt,
} from '../../paper/canvas-math';
import { defaultFolded, foldLabel, isFoldable } from '../../paper/fold';
import {
  createInkCache,
  INK_FAIL,
  INK_LABEL_ALPHA,
  INK_LABEL_MIN_PX,
  INK_SIL_ACCENT_ALPHA,
  INK_SIL_MASS_ALPHA,
  inkBarColorOf,
  inkColorOf,
  inkForBlock,
  LOD_TEXT_MIN_PX,
  lodActive,
  lodFarActive,
  lodTierOf,
} from '../../paper/ink';
import { activeMarkdownBody } from '../../paper/markdown-body-seam';
import { clearMeasureImplementation, registerMeasureImplementation } from '../../paper/measure-seam';
import { clampViewportFrame, inkBarsFor, minimapProject, regionFrame } from '../../paper/minimap-core';
import { PaperDockContext, PaperRegionContext, usePaperDock, usePaperRegion } from '../../paper/overlay-context';
import {
  clampRegionW,
  defaultRegionFor,
  EMPTY_REGION_CONTENT_H,
  nearestFreeRegion,
  pickDropAnchor,
  REGION_CONTENT_MARGIN,
  STREAM_REGION,
} from '../../paper/space';
import { collapseToolGroups, isDiffLang, translateMessagesCached } from '../../paper/translate';
// 批 1 归家（2026-09-24）：三页进包后的逐符号桥面——引擎开关 / 装卸面 /
// MCP 声明与用户级 mcp.json / 插件与偏好 store。装卸面与 loader 的循环为
// 运行期取用（组件按钮回调），无初始化期解引用，ESM 循环安全（见文件头注）。
// 批 10 部件三（2026-09-26）：接线随 bundled-engine 包 ⇒ 内核只剩「探测 + 开关」两件
// （`plugins/bundled-engine-prefs.ts`，设置面板经本桥取用）；台账 store 独立成键。
import {
  isBundledEngineEnabled,
  onBundledEnginePrefChanged,
  probeBundledEngine,
  setBundledEngineEnabled,
} from '../../plugins/bundled-engine-prefs';
import { activateExternalPlugin, deactivateExternalPlugin } from '../../plugins/loader';
// 批 10 部件三（部件二落地）：MCP 受治桥面对第一方产物可见（设计件 §4.2 方案 A）
import { ASSEMBLY_READY_WAIT_MS, registerMcpServerTools, waitWithin } from '../../plugins/mcp-bridge';
import { McpServerDeclSchema } from '../../plugins/types';
import { isUserMcpMissingError, parseUserMcpJson, resolveUserMcpJsonPath } from '../../plugins/user-mcp';
import { createProvider } from '../../provider';
// 批 2a 归家：llm-adapters 的三方言实现已进产物包 ⇒ 撤掉工厂的 faceDeps 桥
// （kernel 侧零消费者），改桥适配器仍依赖的内核面（seam 契约 / 目录与元数据 /
// 错误分类 / 思考档 / 传输 / 协议默认端点表）。
import {
  clampMaxTokens,
  findModels,
  getCatalogVendors,
  getDefaultModel,
  getDynamicFetchFailure,
  getDynamicFetchInflight,
  getModel,
  hasDynamicFetchInflight,
  markDynamicFetchStart,
  mergeDynamicModels,
  onDynamicFetchChange,
  recordDynamicFetchResult,
  searchModels,
} from '../../provider/catalog';
import {
  invalidateCredentialCache,
  invalidateOauthCache,
  resolveApiKey,
  resolveOauthToken,
} from '../../provider/credentials';
import { classifyProviderError } from '../../provider/error-catalog';
import { streamWithIdleTimeout } from '../../provider/idle-stream';
import { createLiveProvider } from '../../provider/live';
import { modelEntries, parseModelEntry } from '../../provider/model-meta';
import { buildOauthHeaders, oauthAccounts, oauthLogout, runDeviceLogin } from '../../provider/oauth';
import { intentOf } from '../../provider/providers-doc';
// provider 配置文件通道（2026-09-24 配方改文件批）：设置页路径/错误/写盘面
import {
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
} from '../../provider/providers-store';
import {
  assertEffortDeclared,
  isThinkingMode,
  THINKING_EFFORT_BUDGETS,
  thinkingCapability,
  thinkingOptionsFor,
  thinkingOptionsOrDefault,
} from '../../provider/thinking';
import { proxyFetch } from '../../provider/transport';
import {
  ApiError,
  ChunkType,
  classifyError,
  classifyStreamError,
  errorCodeFromBody,
  retryAfterSeconds,
  sanitizeToolPairing,
} from '../../provider/types';
import { findVendorTemplate, getVendorTemplateVendors, VENDOR_TEMPLATES } from '../../provider/vendor-templates';
import {
  clearWorkspaceListCache,
  kernelAppendFileDurable,
  kernelCreateDirectory,
  kernelDeleteFile,
  kernelGlobalMemoryDir,
  kernelListDirectory,
  kernelListDirectoryFlat,
  kernelReadFile,
  kernelReadFileRaw,
  kernelReadMemoryBatch,
  kernelTruncateFile,
  kernelWriteFile,
  parseJson,
  typedJsonRpc,
  typedRpc,
  typedRpcWithTimeout,
  workspaceListCached,
} from '../../rpc-contract';
// 批 9c-4b（2026-09-26）：测量引擎（measure.ts + type-tokens.ts）整件随 paper-shell 包
// ⇒ 撤 12 个键（包内直接取用），改桥该包的**登记口**两键（引擎 apply 期登记进内核接缝）。
import {
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
  modelThinking,
  onSettingsSaved,
  PROVIDER_PROTOCOL_DEFAULTS,
  providerId,
  saveSettings,
  updateProvider,
} from '../../settings';
import { leaveToHome, pickFolder, workspaceFlow } from '../../shell/rows/workspace';
// 批 9e 归家：案卷首页进产物 ⇒ 桥它的壳层句柄（工作区/切区状态机读数——壳行 workspace 流的宿主面）
import { shellRefs } from '../../shell/runtime';
import { notifyAgentConfigChanged } from '../../state/agent-config-store';
import { useAskStore } from '../../state/ask-store';
import { useBgAlertStore } from '../../state/bg-alert-store';
import { describeReceipt, useBundledEngineStore } from '../../state/bundled-engine-store';
import { blockFromSnapshot, getCanvasStore, scheduleCanvasSave, snapshotFromBlock } from '../../state/canvas-store';
import { useCanvasViewStore } from '../../state/canvas-view-store';
import { getComposeStore, resolveNewSessionDefault } from '../../state/compose-store';
import { useCompositionStore } from '../../state/composition-store';
import { useDockStore } from '../../state/dock-store';
import { MODE_DESCRIPTIONS, MODE_LABELS, PERMISSION_MODES, useModeStore } from '../../state/mode-store';
import { usePluginPrefs } from '../../state/plugin-prefs';
import { usePluginStore } from '../../state/plugin-store';
import { usePresetStore } from '../../state/preset-store';
import { useSessionVolumesStore } from '../../state/session-volumes-store';
// A4 销账第一笔（2026-09-28）：toast store 上宿主面——paper-shell 的 ToastHost 是
// toast 通道唯一渲染器，直引内核路径会被产物内联成第二份 store（打包态 toast 全不显示）
import { useToastStore } from '../../state/toast-store';
import { useUpdateStore } from '../../state/update-store';
import {
  killShellWork,
  pullShellWork,
  selectSessionWork,
  setOwnerSessionResolver,
  useWorkLedgerStore,
} from '../../state/work-ledger-store';
import { getChatStore, msgStoreFor } from '../../ui/chat-store';
// 批 9e-3 归家：ask / 权限卡架进产物 ⇒ 桥它的图标库（自有静态图标，卡片小图标）
import { iconHtml, iconSvg } from '../../ui/icons';

/** 宿主桥供面封蜡（2026-09-02 划词白屏事故立法）：faceDeps 此前是手抄清单，
 *  host.ts 加出口漏注册时 tsc/测试全绿（两域测试都直连真身）、exe 里才炸
 *  （产物域 impl.X = undefined → TypeError → 整树卸载）。satisfies 四面
 *  host 形状后，漏注册在本文件保存即 tsc 红——失败从「用户 exe 运行时」
 *  搬回「写代码时」。
 *
 *  批 8c（2026-09-25）补一条：封蜡是**下界**（faceDeps ⊇ 各产物 host.ts 的出口），
 *  尾部 `Record<string, unknown>` 允许**平台级冗余键**——那些不属于任何产物 host.ts、
 *  但产物域确需从 faceDeps 取的真实例（先例：内核登记表读面 `activeMarkdownBody`，
 *  由 renderers 产物的 `renderer-host.aliased.ts` 取用，而该产物的桥不走 faceDeps）。 */
type FaceBridgeSeal = Record<string, unknown> &
  Record<keyof typeof import('./canvas-nav/host'), unknown> &
  Record<keyof typeof import('./compose-dock/host'), unknown> &
  Record<keyof typeof import('./paper-minimap/host'), unknown> &
  Record<keyof typeof import('./paper-shell/host'), unknown> &
  Record<keyof typeof import('./settings-domain/host'), unknown> &
  Record<keyof typeof import('./sessions-builtin/host'), unknown> &
  Record<keyof typeof import('./subagent-in-process/host'), unknown> &
  Record<keyof typeof import('./llm-adapters/host'), unknown> &
  Record<keyof typeof import('./web-domain/host'), unknown> &
  Record<keyof typeof import('./browser-desktop-domain/host'), unknown> &
  Record<keyof typeof import('./git-domain/host'), unknown> &
  Record<keyof typeof import('./search-domain/host'), unknown> &
  Record<keyof typeof import('./fs-domain/host'), unknown> &
  Record<keyof typeof import('./shell-domain/host'), unknown> &
  Record<keyof typeof import('./agent-isolation-domain/host'), unknown> &
  Record<keyof typeof import('./ask-domain/host'), unknown> &
  Record<keyof typeof import('./skill-domain/host'), unknown> &
  Record<keyof typeof import('./memory-domain/host'), unknown> &
  Record<keyof typeof import('./task-domain/host'), unknown> &
  Record<keyof typeof import('./agent-domain/host'), unknown> &
  Record<keyof typeof import('./multiagent-comm/host'), unknown> &
  Record<keyof typeof import('./wait-domain/host'), unknown> &
  Record<keyof typeof import('./cordis-domain/host'), unknown> &
  Record<keyof typeof import('./asset-domain/host'), unknown> &
  Record<keyof typeof import('./office-domain/host'), unknown> &
  Record<keyof typeof import('./prompt-segments/host'), unknown> &
  Record<keyof typeof import('./capability-segments/host'), unknown> &
  Record<keyof typeof import('./plan-mode/host'), unknown> &
  Record<keyof typeof import('./goal-mode/host'), unknown> &
  Record<keyof typeof import('./state-hooks/host'), unknown> &
  Record<keyof typeof import('./compaction/host'), unknown> &
  Record<keyof typeof import('./paper-renderers/host'), unknown> &
  Record<keyof typeof import('./agent-domain/host'), unknown> &
  Record<keyof typeof import('./agent-loop-service/host'), unknown>;

/** 四面组件共享依赖（bundle 域真实例）。key = 产物 host.aliased 取用名。 */
const faceDeps = {
  // agent / composition 服务读面
  agentSessionState,
  activeSpace,
  activeOverlayContributions,
  subscribeOverlayContributions,
  resolveAssetBlock,
  resolveRenderer,
  selectPreset,
  // 批 1 归家（2026-09-24）：作者面三件（compositionDir/createPresetFromTemplate/
  // rescanPresets）已随 preset-authoring 进包 ⇒ 从 faceDeps 撤桥；改桥它们仍留内核的
  // 机制依赖（重扫应用 / 发现 / 内置表 / id 围栏 / patch 序列化）。
  reapplyComposition,
  discoverPresets,
  stringifyPatchYaml,
  builtinPresets,
  isValidPresetId,
  // provider 配置文件通道（2026-09-24 配方改文件批）：路径 / 逐节错误 / 写盘
  saveProvidersDoc,
  providersFilePath,
  providersDocStatus,
  onProvidersDocChange,
  ensureProvidersDir,
  loadProjectProvidersDoc,
  projectProvidersErrors,
  projectProvidersFatal,
  retryProvidersPath,
  // 日志可观测性批 2（2026-09-27）：事件门面（唯一脱敏点）对产物域的出口面。
  //   settings-domain → 凭据写面（credStore/credRemove）
  //   llm-adapters    → 出网四相（llmSend/llmFirstByte/llmDone/llmError）
  // 面在 `agent/obs.ts`（内核，不可禁）；产物只经宿主桥取用，不裸 import 内核。
  credStore,
  credRemove,
  panelReload,
  llmSend,
  llmFirstByte,
  llmDone,
  llmError,
  // S6 P3b：激活诊断读面（第四栏「被跳过」= 激活失败的插件 + 原因；独占冲突回看）
  activationSkipped,
  activationConflict,
  // paper 域（几何/墨迹/测量/选择/翻译/虚拟化/上下文）
  viewportCenterWorld,
  writingBlockIdOf,
  // A4 销账 W1（2026-09-28）：块工厂（renderers 双走查查看器）+ 差分语言判据
  // （paper-renderers 体渲染）——两处所在模块都带模块级状态，按纪律上桥。
  createBlock,
  isDiffLang,
  // paper-minimap 插件（2026-09-05）：minimap-core 纯几何（inkColorOf 已在下）
  clampViewportFrame,
  inkBarsFor,
  minimapProject,
  regionFrame,
  ANCHOR,
  autoPanVector,
  nextZoomStep,
  layoutRegion,
  panBy,
  screenToWorld,
  viewFocusRegion,
  wheelFactor,
  worldToScreen,
  zoomAt,
  defaultFolded,
  foldLabel,
  isFoldable,
  createInkCache,
  inkBarColorOf,
  inkColorOf,
  inkForBlock,
  INK_FAIL,
  lodActive,
  lodFarActive,
  lodTierOf,
  LOD_TEXT_MIN_PX,
  INK_SIL_MASS_ALPHA,
  INK_SIL_ACCENT_ALPHA,
  INK_LABEL_MIN_PX,
  INK_LABEL_ALPHA,
  PaperDockContext,
  PaperRegionContext,
  usePaperDock,
  usePaperRegion,
  // 批 5a 归家（2026-09-24）：toc / toc-ink / ime / sel-ink / focus-flight / sheet /
  // provenance 七件随包 ⇒ 这些 faceDeps 键已撤（包内实现，两域同源）。
  clampRegionW,
  defaultRegionFor,
  EMPTY_REGION_CONTENT_H,
  nearestFreeRegion,
  pickDropAnchor,
  REGION_CONTENT_MARGIN,
  STREAM_REGION,
  collapseToolGroups,
  translateMessagesCached,
  // 状态层（zustand 真实例——影子 store 禁止）
  blockFromSnapshot,
  getCanvasStore,
  scheduleCanvasSave,
  snapshotFromBlock,
  useCanvasViewStore,
  useCompositionStore,
  getComposeStore,
  resolveNewSessionDefault,
  useDockStore,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  PERMISSION_MODES,
  useModeStore,
  usePresetStore,
  useAskStore,
  useBgAlertStore,
  useUpdateStore,
  /* 役册（2026-09-22）：后台工作台账——zustand 单例 + 只读对账口，坞只读；
   * 归属解析器由 workspace 装配期注入（面板 runtime 才有 bus 父子树）。 */
  useWorkLedgerStore,
  selectSessionWork,
  pullShellWork,
  killShellWork,
  setOwnerSessionResolver,
  /* 卷清单变更信号（2026-09-18 侧栏载入批）：canvas-nav 侧栏/书脊订阅——卷文件
   * 落定写入后重读清单投影（写代缓存已就地更行，重读零 I/O）。 */
  useSessionVolumesStore,
  notifyAgentConfigChanged,
  getChatStore,
  msgStoreFor,
  listCommands,
  slashOnly,
  filterCommands,
  ensureSkillCatalog,
  useCoreStore,
  // 应用壳件
  Icon,
  useDialogEscape,
  useShellStore,
  useToastStore,
  WinControls,
  PluginBoundary,
  ConfirmDialog,
  /* 离开工作区回首页（2026-09-08）：paper-shell 确认弹层确认后触发——运行时
   * 真关工作区在壳层 workspace 流（host.ts 出口与 faceDeps 同步）。 */
  leaveToHome,
  // 批 9e 归家（2026-09-26）：案卷首页进产物 ⇒ 桥它的数据源与壳层入口
  // （workspace_list 强制层 RPC + 写代缓存 · 系统目录选择器 · 切区/强制重置函数族 ·
  //  壳层工作区句柄读数）
  clearWorkspaceListCache,
  workspaceListCached,
  pickFolder,
  workspaceFlow,
  shellRefs,
  // 批 9e-3 归家（2026-09-26）：ask / 权限卡架进产物 ⇒ 桥图标库（卡片小图标）
  iconSvg,
  // 批 2a 归家（2026-09-24）：llm-adapters 的端点真源（内核协议默认端点表）
  PROVIDER_PROTOCOL_DEFAULTS,
  // 批 1 归家（2026-09-24）：三页进包后的逐符号桥面
  scanSkills,
  isBundledEngineEnabled,
  onBundledEnginePrefChanged,
  probeBundledEngine,
  setBundledEngineEnabled,
  activateExternalPlugin,
  deactivateExternalPlugin,
  McpServerDeclSchema,
  isUserMcpMissingError,
  parseUserMcpJson,
  resolveUserMcpJsonPath,
  describeReceipt,
  useBundledEngineStore,
  usePluginPrefs,
  usePluginStore,
  kernelCreateDirectory,
  kernelReadFile,
  parseJson,
  typedRpc,
  // 设置 / provider / rpc / i18n
  autoUpdateCheckEnabled,
  canvasWheelMode,
  effectiveModels,
  // A4 销账 W2（2026-09-28）：ProviderPage 原先直引内核 `settings.ts` 取这两个纯投影
  // （模块本体带投影 + 订阅表）⇒ 上桥。
  getActiveProvider,
  updateProvider,
  loadSettings,
  loadSettingsWithSecrets,
  modelContextWindow,
  // B5 multimodal-image：生效输入模态解析（覆盖 ?? 目录 ?? ['text']）——
  // 创作坞附图门禁与 ModelSelector「视」徽标同链消费
  modelInput,
  // 2026-09-23 思考下沉：provider 作用域描述符 + 生效思考档位（覆盖 ?? 行值）
  // ——创作坞 pill 换源到与设置页/请求期同一把尺子
  modelDescriptor,
  modelThinking,
  onSettingsSaved,
  saveSettings,
  getModel,
  findModels,
  searchModels,
  getDynamicFetchFailure,
  getDynamicFetchInflight,
  hasDynamicFetchInflight,
  onDynamicFetchChange,
  resolveApiKey,
  extractImageFiles,
  previewUrlFor,
  thinkingOptionsFor,
  thinkingOptionsOrDefault,
  typedJsonRpc,
  // sessions-builtin（2026-09-05 seam 动作面重设计）：默认 provider 换
  // kernel* 具名 helper（D-3/D-4——行为与今日直连逐字节一致 + 测试 mock 面
  // 零迁移）。
  // （typedRpc 孤儿键随 sessions-builtin 换轨移除——旧默认 provider 走 RPC
  //  直呼的唯一供给源；现无任何产物 host 面消费它。
  //  agentInvoke 先例（graph-builtin）随图谱退役删除，2026-09-09。）
  kernelReadFileRaw,
  kernelListDirectory,
  kernelWriteFile,
  // 批 9h-4 归家：记忆域实现随包 ⇒ 桥它的内核依赖面（记忆文件 IO 五值 ——
  // `kernelCreateDirectory` / `kernelDeleteFile` / `kernelReadFile` 早已在册 —— 与
  // 「事实保存授权」消费口）
  kernelReadMemoryBatch,
  consumeFactAuthorization,
  // 批 9h-3/9h-4 现场修复（2026-09-25）：产物 apply 的**登记口**必须经 faceDeps 落到内核同一份
  // 登记表——产物域直连内核模块路径会被 esbuild 内联成副本，登记进副本 = 内核读不到
  // （实机病灶：workspace 打开报 MEMORY_DOMAIN_UNAVAILABLE）。
  registerMemoryImplementation,
  clearMemoryImplementation,
  registerSkillImplementation,
  clearSkillImplementation,
  // Phase 1 事件日志（2026-09-15 DSH 参照移植）：durable append 进宿主桥
  // （append_events 动作的落盘面——fsync 版 kernel helper）。
  kernelAppendFileDurable,
  kernelDeleteFile,
  kernelTruncateFile,
  // 批 2a：llm-adapters 归家后的依赖面（工厂已随包，不再桥）
  ApiError,
  ChunkType,
  clampMaxTokens,
  classifyProviderError,
  modelEntries,
  parseModelEntry,
  assertEffortDeclared,
  isThinkingMode,
  THINKING_EFFORT_BUDGETS,
  thinkingCapability,
  proxyFetch,
  classifyError,
  classifyStreamError,
  errorCodeFromBody,
  retryAfterSeconds,
  sanitizeToolPairing,
  setLang,
  iconHtml,
  // 创作坞 v2（2026-08-31）：引（typedJsonRpc 文件枚举）/ 拖放入卷（Tauri 原生通道）
  isMockMode,
  watchFileDragDrop,
  // S3 工具域真源产物运行时依赖（经宿主桥 mods.faceDeps 取用）
  // 批 9h-3：`createSkillTool` 随 skill-domain 包（该包自持实现）⇒ 键已撤
  createTaskTools,
  // 批 9h-3 归家：技能域实现随包 ⇒ 桥扫描器读面（内核 RPC；纯读无状态）
  kernelGlobalMemoryDir,
  kernelListDirectoryFlat,
  // 批 9h-1 归家（2026-09-26）：capability 十四项内容表进 capability-segments 包 ⇒
  // 桥它的取用面（批 6/7 的登记表读面 + 内核工具工厂 / 域折叠表）；`firstPartyCapabilities` 键已撤
  createCodeExecutionTool,
  requireMultiagentComm,
  activePlanImplementation,
  registerCompactionTools,
  activeDiscoveryTools,
  activeMergeTools,
  activeSubAgentTools,
  createBoardStatusTool,
  convergeRegistry,
  // 批 9h-5 归家（2026-09-26）：task 三件实现随 task-domain 包 ⇒ 撤 `TaskManager` 类键
  // （改 `createTaskManager` 门面，形状 = 契约面 `agent/task-contract`）；同批补该包的
  // 登记口两键与两个内核依赖（`BoardPersistence` 共享件 / `spillToFile` 溢写）。
  createTaskManager,
  registerTaskImplementation,
  clearTaskImplementation,
  BoardPersistence,
  spillToFile,
  // 批 4b 归家（2026-09-24）：search/web 两域实现进包（原 manifest-tools 按域拆）
  // ⇒ 撤这两个工厂键；两域只余平台面（toInputJsonSchema / Tool 类型）。
  // 批 3a 归家（2026-09-24）：wait/office/cordis 三域的工具工厂已随包 ⇒ 撤桥；
  // 改用它们仍住内核的依赖面（defineTool / Tool 类型 / 域私有内核函数）。
  SubAgentStatus,
  defineTool,
  isAbsolutePath,
  ownerContext,
  resolveAgainstRoot,
  stickyCwdOf,
  activeDynamicRunner,
  // 标题栏交互（2026-09-14 app-region 退役）：顶部浮件拖拽/双击最大化的原生实现
  onTopbarPointerDown,
  onTopbarDoubleClick,
  // 批 9g-2 归家：asset 三工具进 asset-domain 包 ⇒ 桥它们用的内核单例面
  assetDigest,
  assetKinds,
  findAssetByContent,
  generateAssetId,
  getAsset,
  listAssets,
  parseAssetEventOutput,
  requireKind,
  requirePresentation,
  upsertAsset,
  validatePayload,
  waitForConfirm,
  // S5b agent-loop-service 产物运行时依赖
  ContributionChannel,
  Service,
  setActiveAgentLoop,
  // 批 9h-2 归家：出厂默认 loop 随包 ⇒ 桥循环依赖面（`defaultAgentLoop` 键已撤；
  // `parseFilePathArg` 早已在册）
  finishReasonMessage,
  StreamingToolExecutor,
  typedRpcWithTimeout,
  // 批 4a 归家（2026-09-24）：browser/desktop 实现进包 ⇒ 撤工厂桥，改桥依赖面
  errText,
  toInputJsonSchema,
  parseStructuredError,
  // 批 4c-1 归家：git 工具族进包 ⇒ 撤工厂桥；改桥它仍住内核的解析器
  parseGitLogCommits,
  parseGitStatusPorcelain,
  // 批 4c-3 归家：fs/shell 两族进包 ⇒ 撤工厂桥；改桥 seam 裁剪读面 + 活跃 provider 表
  ownerIdOf,
  ownerSeamView,
  activeFsProviders,
  activeShellProviders,
  // 批 6a 归家：plan 模式实现进包 ⇒ 桥内核登记表 + 事件枚举（kernelReadFile 早已在册）
  registerPlanImplementation,
  EventKind,
  // 批 6b 归家：goal 循环实现进包 ⇒ 桥内核登记表（errText/defineTool 早已在册）
  registerGoalImplementation,
  // 批 6c 归家：出厂 hook 四工厂进包 ⇒ 桥登记表 + 数据源（诊断/blame/构建缓存/附图判定）
  registerStateHooksImplementation,
  buildPreReadBlock,
  cacheBuildResult,
  formatDiagnostics,
  hasImageRefs,
  invalidateBlameEntry,
  refreshGitBlame,
  // 批 6d-2 归家：压缩域实现进包 ⇒ 桥登记表 + 数据源/常量（kernelReadFile/ChunkType/defineTool/EventKind 已在册）
  registerCompactionImplementation,
  streamWithIdleTimeout,
  log,
  // 日志可观测性批 4：设置页「诊断」签的级别开关面（读当前 + 设偏好）
  logLevel,
  setLogLevelPreference,
  buildCompactedSummaryMessage,
  countMessage,
  countMessages,
  countText,
  foldToolResults,
  nextFoldBoundary,
  extractFilePath,
  WRITE_TOOLS,
  parseFilePathArg,
  resolveGuardToolName,
  DEFAULT_C_IN,
  DEFAULT_C_OUT,
  LOSS_FACTOR_PER_EVENT,
  DEFAULT_COMPACT_RATIO,
  DEFAULT_RETAIN_RATIO,
  COMPACTION_NOTICE_MARK,
  // 批 7a 归家：subagent 工具族进包 ⇒ 撤两工厂键；桥 schema 校验 / 子代理活动账 / 登记表
  registerSubAgentTools,
  assertSupportedSchema,
  extractJsonObject,
  validateObjectJsonSchema,
  getSubAgentActivity,
  STUCK_THRESHOLD_S,
  // 批 7b 归家：通信族进包 ⇒ 桥登记表 + 四个错误类 + 目录/删除/列举文件腰
  registerMultiagentComm,
  AgentNotFoundError,
  InboxFullError,
  MessageNotFoundError,
  TopologyDeniedError,
  // 批 7c-1 归家：merge / discovery 两工具族进 subagent-in-process 包 ⇒ 桥登记表 + 隔离队列/编译腰
  enqueueIsolationOp,
  execStreamedShell,
  parseIsolationDiff,
  registerSubagentRuntime,
  // 批 7c-2 归家：子代理运行时进包 ⇒ 撤 spawnSubAgentImpl 桥；补运行时依赖面
  Agent,
  activeStateHooksImplementation, // 批 9d 归家：Provider 控制台 8 件进 settings-domain 包 ⇒ 桥它们的有状态内核依赖面
  activeLlmAdapters,
  buildOauthHeaders,
  createLiveProvider,
  createProvider,
  defaultBaseUrl,
  invalidateCredentialCache,
  invalidateOauthCache,
  loadProvidersDoc,
  markDynamicFetchStart,
  mergeDynamicModels,
  mountDialogFocus,
  oauthAccounts,
  oauthLogout,
  providerId,
  recordDynamicFetchResult,
  resolveOauthToken,
  runDeviceLogin,
  once,
  createExecState,
  HookRegistry,
  buildOutputSchemaInstruction,
  planRegistry,
  removeSubAgentActivity,
  wrapSubAgentSink,
  ToolRegistry,
  FileOwnership,
  // 批 8b 归家：纸面块渲染器进 paper-renderers 包 ⇒ 桥应用层依赖面
  // （MermaidBlock 是重依赖例外：组件本体留应用 bundle，产物只做认领 + 降级）
  MermaidBlock,
  Overlay,
  readAttachmentBase64,
  // 批 8c 归家：ipynb / markdown-doc 查看器撤 heavy 内联进 renderers 包 ⇒ 桥内核登记表读面
  // （markdown 体渲染由 paper-renderers 产物登记；产物域不得相对 import 那个叶模块——会被
  //  esbuild 内联成另一份实例，读不到内核那份登记）
  activeMarkdownBody,
  // §4-6 A（2026-09-26）：token 计量升为内核第 16 个 service `ctx.tokenMeter` ⇒ 分桶代数
  // 经本键取内核唯一实例（创作坞墨量册的读数面；产物域自建副本 = 口径漂移入口）。
  tokenAlgebra,
  // 批 9f-1（2026-09-26）：Provider 编辑面随 settings-domain 包 ⇒ 撤 4 键（applyFetchedModels /
  // addProvider / persistSecrets / removeSecret）；补留内核的邻居 5 键（该包 host.ts 有注）。
  findVendorTemplate,
  VENDOR_TEMPLATES,
  getCatalogVendors,
  getDefaultModel,
  modelMaxTokens,
  getVendorTemplateVendors,
  intentOf,
  // 批 9c-4b（2026-09-26）：测量引擎随 paper-shell 包 ⇒ 撤 12 个 measure/type-tokens 键
  // （包内直接取用），改桥该包的登记口两键（apply 期登记进内核接缝 paper/measure-seam）。
  registerMeasureImplementation,
  clearMeasureImplementation,
  // 批 10 部件三（2026-09-26 部件二）：MCP 受治桥面对第一方产物可见（设计件 §4.2 方案 A
  // ——不新开公开通道；第三方仍只有 manifest.mcpServers 声明面）+ 引擎接线所需 IO 工厂。
  registerMcpServerTools,
  waitWithin,
  ASSEMBLY_READY_WAIT_MS,
  createTauriProcIO,
  // asset-state（2026-10-07 html 卡状态桥）：renderers 的 HtmlBody 经 renderer-host
  // 取读写（get/patch）；asset-domain 的 list_block_kinds 取 owner→会话解析面。
  // 带模块级状态（会话表 + 落盘句柄）——必须走桥。
  getAssetState,
  patchAssetState,
  listAssetStateSummaryForOwner,
} satisfies FaceBridgeSeal;

/** 宿主桥 mods 注册表（loader installPluginHostBridge 注入）。
 *  S3：toolDomains/segments 薄重导出已拆除——产物域真源自带插件对象。 */
export function pluginHostMods(): Record<string, unknown> {
  return { faceDeps };
}

/** 运行时宿主面键集（保险丝 a 对拍真源，2026-09-03 生产事故立法）：
 *  产物 face.json 声明的需求键以此为对拍面——缺键 = 产物与 exe 版本偏斜，
 *  装载器拒载（bundle 兜底行不位移），渲染期整树卸载的偏斜类事故绝迹。 */
export function faceDepsKeys(): ReadonlySet<string> {
  return new Set(Object.keys(faceDeps));
}

/** 宿主面指纹（保险丝 a′，2026-09-14 立法）——键集（排序）的 FNV-1a 32 位十六进制。
 *
 *  为什么需要它：保险丝 a 只在「产物要的键运行时没有」时开火，而这**只是偏斜的
 *  一种形态**。同日事故（乙 批把 INK_FAIL / buildTocInkBuckets 加进宿主面后按
 *  「只换产物」部署）：产物 face.json 声明的键在 exe 里也没有 → a 开火了，但由于
 *  S5 已把 displace 兜底退役（产物是唯一装载面），结果是**该插件整面缺席**，而非
 *  §8.5 承诺的「拒载 + bundle 兜底行不倒」。且**作者期毫无信号**——`npm run build`
 *  不会告诉你"本批动了宿主面，光换产物必炸"。
 *  指纹把这条边界变成可读数字：基线 `src/plugins/host-surface.baseline.json` 由
 *  `npm run gen:host-surface` 生成、由 tests/host-surface-seal.test.ts 封印（改宿主面
 *  必须同 commit 更新基线）；构建脚本把它写进每个产物 face.json 并**与本批 HEAD 的
 *  基线对比**，变了就大字告警；装载器拿产物声明的指纹与运行时对拍，报错从"缺键 A、B"
 *  升级为"产物需宿主面 <a>，当前 exe <b>"。
 *
 *  keys 可注入（缺省 = 运行时真源）——纯函数，测试可直接对拍稳定性与敏感性。 */
export function hostSurfaceFingerprint(keys: Iterable<string> = faceDepsKeys()): string {
  const sorted = [...keys].sort();
  let h = 0x811c9dc5; // FNV-1a 32
  for (const k of sorted) {
    for (let i = 0; i < k.length; i++) {
      h ^= k.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x1f; // 键分隔符（防 "ab"+"c" 与 "a"+"bc" 撞同一指纹）
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
