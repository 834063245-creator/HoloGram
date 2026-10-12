// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Workspace — 拥有一个已打开项目的全部状态。
// 替换 main.ts 中的 18+ 个模块级全局变量。
//
// 生命周期：
//   const ws = await Workspace.open(path, chatPanel);
//   // ... 用户工作 ...
//   await ws.deactivate(chatPanel);
//
// 切换工作区是原子的：old.deactivate() → new = Workspace.open() → 赋值。

import type { Agent } from './agent/agent';
import { agentSessionState } from './agent/agent-session-state';
import { AgentStore } from './agent/agent-store';
import { resetAgentCaches } from './agent/cache-store';
import { GoalManager } from './agent/goal-manager';
import { DisposerBag } from './agent/lifecycle';
import { applyLogLevelFromShell, initLogger, log } from './agent/logger';
import type { MemoryManagerFace } from './agent/memory-contract';
// 批 9h-4：记忆域实现随 memory-domain 包 ⇒ 装配点走内核登记表门面（缺实现 fail-loud）
import { createMemoryManager, memoryBundleIngest } from './agent/memory-impl';
import * as Obs from './agent/obs';
import { WIRE_IMAGE_CAPS } from './agent/request-images';
import { type BuilderDeps, buildToolRegistry } from './agent/runtime/agent-builder';
// ── 运行时层（替代 bootstrap.ts）──
import { AgentRuntime } from './agent/runtime/runtime';
import type { AgentHandle } from './agent/runtime/types';
import type { SkillRegistryFace } from './agent/skill-contract';
// 批 9h-3：技能域实现随 skill-domain 包 ⇒ 装配点改走内核登记表门面（缺实现 fail-loud）
import { createSkillRegistry } from './agent/skill-impl';
import { buildTurnStartBlock, refreshGitStatus } from './agent/state-inject';
import type { SubAgentPool } from './agent/subagent-runtime-contract';
import { requireSubagentRuntime } from './agent/subagent-runtime-impl';
import type { TaskManagerFace } from './agent/task-contract';
import { createTaskManager } from './agent/task-impl';
import type { ToolRegistry } from './agent/tool';
import type { ChatCore } from './app/chat/chat-core';
import { readAttachmentForWire } from './app/chat/image-intake';
import { useShellStore } from './app/shell-store';
import {
  compositionIdentity,
  effectiveComposition,
  isPresetKnown,
  reapplyComposition,
  selectionError,
} from './composition/preset-assembly';
import type { ResolvedComposition } from './composition/roster';
import type { SeamDisabledMap } from './composition/seam-resolution';
// 批 10 部件一：工作区接线贡献面（产物 apply 期登记 → 激活点串行回调）
import { activateWorkspaceContributions } from './composition/workspaces-service';
import type { Context, Fiber } from './cordis';
import { initCordisKernel } from './cordis/boot';
import { formatDeferredWakeNote, registerDeferredWakeHandler } from './plugins/deferred';
import { markDynamicFetchStart, mergeDynamicModels, recordDynamicFetchResult } from './provider/catalog';
import { resolveApiKey } from './provider/credentials';
import { createLiveProvider } from './provider/live';
import { providersFilePath } from './provider/providers-store';
import { getProxyPort } from './provider/transport';
import type { Provider } from './provider/types';
import { kernelGlobalMemoryDir, kernelProcessCall, typedListen, typedRpc } from './rpc-contract';
import {
  type AppSettings,
  getActiveProvider,
  loadSettings,
  loadSettingsWithSecrets,
  type ModelOverrides,
  modelContextWindow,
  type ProviderSettings,
} from './settings';
import type { AgentConfigChangeReason } from './state/agent-config-store';
import { getComposeStore, resolveComposeEffective } from './state/compose-store';
import { broadcastGoalRecord } from './state/goal-store';
import { getPanelStore } from './state/panel-store';
import { showToast, TOAST_LONG_HOLD_MS } from './state/toast-store';
import { pullShellWork, setOwnerSessionResolver, useWorkLedgerStore } from './state/work-ledger-store';
import { useAgentPanelStore } from './ui/agent-panel-store';
import { resetSessionState } from './ui/chat-session';
import { getDiagnosticsForFile, type LspService, requireLspService } from './ui/lsp-client';
import { createBuilderDeps, createRuntimeAdapter } from './ui/runtime-adapter';
import { bumpWorkspaceEpoch, getWorkspaceEpoch, isCurrentEpoch } from './workspace-scope';

// ═══════════════════════════════════════════════════════
// 从引擎注册表动态加载工具
// ═══════════════════════════════════════════════════════

// ── 路径工具 ──────────────────────────────────────────────────────

/** 不区分大小写的路径比较（Windows 盘符大小写可能不同）。 */
export function isSamePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

// ── 会话组合 → seam 裁剪面（S6 P2b）────────────────────────────

/** 某卷 provider 的 seam 裁剪面：**有组合上下文**的 provider 构建点（会话工厂 /
 *  两条热切换路径）按**该卷自己组合**取，方言解析据此裁剪 `seam/llm`——每卷可走
 *  不同 adapter，且切一次模型不会把卷级 seam 面退回全局（与装配面自洽）。
 *  无记录（新卷 / 旧卷无字段）= 全局当前选择（`effectiveComposition` 的既有权重）。
 *  解析面是 preset-assembly 的 cache 读、有捕获网（永不抛）——调用点零风险。 */
function sessionSeamViewFor(storeId: string, sessionId: number): SeamDisabledMap {
  return effectiveComposition(agentSessionState.getRecordedPresetId(storeId, sessionId) ?? undefined).seamDisabled;
}

// ── 参数翻译（从 main.ts 迁移）──────────────────────────────────
// ponytail: 所有 hologram 工具 schema 已用 camelCase (nodeId/maxDepth/from/to/...),
// Tauri v2 默认 camelCase 重命名 Rust snake_case 参数 → 期望的 JS key 正是这些 camelCase.
// 旧 ARG_TRANSLATIONS 把 camelCase→snake_case, 方向全反 → 7 个工具 (node/unused/impact/
// neighbors/path/coupling_report/community) 全部 "missing required key". 删整张表, args 直传.
// 若新增 hologram 命令: schema 参数名用 camelCase 即可, 无需任何翻译.

// ── Workspace 类 ─────────────────────────────────────────────────

/** 工作区 scope fiber 的插件定义（cordis-migration P1）。
 *  apply 为空：资源登记发生在 fiber ctx 上（获取点就地 effect），不走插件闭包。
 *
 *  ⚠ **不要给它加 `inject`**（2026-09-24 试过，当场撞墙）：声明 inject 会让 cordis
 *  为本插件派生 realm/隔离语义，于是 `new LspService(this._fiber.ctx)` 的
 *  `core.set('lsp')` 与 realm 记账冲突——`tests/workspace-fiber.test.ts` 5 条当场
 *  全红（`service "lsp" has been registered at <hologram/workspace>` /
 *  `Cannot set properties of undefined`）。
 *  需要 `ctx.tools` 的接线（随包引擎 MCP）走**自带 inject 的子 fiber**挂载
 *  （见 `plugins/bundled-engine.ts`：`ctx.plugin({ inject: ['tools'], apply })`），
 *  回收由调用方把子 fiber 的 dispose 登记进自己的 `ctx.effect`——**不依赖** cordis
 *  的父 dispose 级联语义。 */
const workspaceScopePlugin = {
  name: 'hologram/workspace',
  apply() {},
};

export class Workspace {
  // ── 标识 ──
  readonly path: string;

  // ── Agent 与记忆 ──
  /** 工厂已挂接标记（applyAgentConfig 的「补装配」分支判据——工厂在场
   *  即热同步，不重装、不动摊开集）。 */
  private _factoryRegistered = false;
  /** 工厂现造的最后一个 raw Agent 引用（模块能力面：setPlanMode /
   *  notifyMemorySaved / spawnSubAgent 闭包——接口层未覆盖的能力经此触达；
   *  句柄随卷生灭，本引用仅是「最近一次工厂产出」的借用，不持所有权）。 */
  private _lastRawAgent: Agent | null = null;
  prov: Provider | null = null;
  registry: ToolRegistry | null = null;
  memoryManager: MemoryManagerFace | null = null;
  taskManager: TaskManagerFace = createTaskManager();
  skillRegistry: SkillRegistryFace | null = null;
  agentStore: AgentStore | null = null;
  goalManager: GoalManager | null = null;

  // ── 运行时 ──
  runtime: AgentRuntime | null = null;

  // ── 子 Agent 池 ──
  // 批 7c-2：子 Agent 池实现归产物包 subagent-in-process，经内核登记表造（service 语义）
  subAgentPool: SubAgentPool = requireSubagentRuntime().createPool();

  // ── Store 路由（面板级隔离）──
  _storeId: string = '__default__';

  // ── Agent 设置守卫 ──
  agentSetupRunning: boolean = false;
  agentSetupPending: boolean = false;

  // ── 内部状态 ──
  private _active: boolean = false;
  /** 工作区生命周期 = 根 Context 上的一个 cordis fiber（cordis-migration P1）。
   *  全部工作区级资源以 effect 登记在 fiber 上：constructor/open 的独立清理器直接
   *  effect（LIFO 释放）；setupAgent 的有序拆除组（先拆 runtime 再清缓存等顺序契约）
   *  每次调用打包为一个 DisposerBag、作为单个 effect 登记（组内串行逆序不变）。
   *  deactivate/forceClearState 统一走 fiber.dispose()（dispose-to-quiescence）。 */
  private readonly _fiber: Fiber;
  /** LSP 子系统服务（批 9b §4-13）：**内核单例**（`lspServicePlugin` 由 loader 装载）——
   *  工作区不再各建实例（同链重名会被 cordis reflect 拒），改在自身 fiber 上登记
   *  「工作区级清态」（`resetWorkspaceState()`）：与旧的「服务随 fiber dispose」逐条等价
   *  （provider/监听器/诊断缓存/会话表全清 —— H1 不带入新工作区）。 */
  private readonly _lspService: LspService;

  /** 工作区级装配材料（builderDeps + agentRef + 装配时组合快照 + chatPanel）
   *  ——_buildRegistryLocked / 会话工厂消费。 */
  private _agentRef: { current: Agent | null } = { current: null };
  private _builderDeps: BuilderDeps | null = null;
  /** 共享注册表所依据的组合**身份**（S6 P1d）——建注册表时点的
   *  composition-store.resolvedKey 快照（缺席 = 未知 ⇒ 会话一律自建注册表）。
   *  必须与**建表时点**同步快照：判定要比的是「建表时的输入」，而不是比较时点的
   *  store（热重载后 store 已前进，拿新身份配旧注册表 = 复用陈旧行面）。
   *  （旧字段（装配时点的组合快照）是引用比较的另一半，随判据换轨删除——
   *  零读者即化石。） */
  private _assemblyKey: string | undefined;

  /** 守卫（历史名 _initialRenderActive）：分页原子换入已随 Phase 1.5 退役，
   *  快照重拉幂等无需防踩踏 —— 字段保留给既有读写点，语义 = 初始装载期。 */
  _initialRenderActive: boolean = false;

  get active(): boolean {
    return this._active;
  }

  /** 工作区 fiber 的 ctx — P2/P3 子系统（agent 装配、面板 Service）从这里挂子 fiber。 */
  get cordisCtx(): Context {
    return this._fiber.ctx;
  }

  /** LSP 子系统服务（cordis-migration P3）— 等价 cordisCtx.lsp 的便捷入口。 */
  get lsp(): LspService {
    return this._lspService;
  }

  // ── UI 回调（由 main.ts 设置）──
  onStatusChange: ((msg: string) => void) | null = null;
  onLoadingChange: ((loading: boolean) => void) | null = null;

  /** 低层构造（测试缝/占位形态退役后的实例化入口）：仅建 fiber 与身份，
   *  不绑定后端（open() 才是生产入口——内部走 workspace_activate）。
   *  直接 new 出来的实例 _active=false，不触发任何 RPC。 */
  constructor(path: string) {
    this.path = path;
    // 工作区 scope fiber — 挂在根 Context 上（initCordisKernel 幂等：生产路径
    // main.ts 已引导，复用既有根；测试路径首次调用自动建根）。
    this._fiber = initCordisKernel().plugin(workspaceScopePlugin);
    // 批 9b §4-13：LSP 服务是内核单例（loader 装载，不可禁用）——工作区只登记**清态**：
    // fiber dispose（deactivate / forceClear）时清 provider/监听器/缓存/会话表。
    this._lspService = requireLspService();
    this._fiber.ctx.effect(
      () => () => {
        this._lspService.resetWorkspaceState();
      },
      'lsp-workspace-state',
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 工厂方法：打开工作区 — 激活 + 监听器接线
  // （V5 拆除 2026-08-22：starGraph 渲染面退役）
  // （workspace-session-ownership-rework 2026-08-27：占位工作区 path='' 退役——
  //  零目录会话已退役，工作区 = 目录实体，无项目不装配 Agent）
  // （图谱全量退役 2026-09-09：分析/快照装载/简报/图事件监听整批移除——
  //  工作区打开 = 激活 + 会话恢复，零引擎接线）
  // ═══════════════════════════════════════════════════════════════

  static async open(
    path: string,
    callbacks?: {
      onStatusChange?: (msg: string) => void;
      onLoadingChange?: (loading: boolean) => void;
    },
  ): Promise<Workspace> {
    const ws = new Workspace(path);
    ws._active = true;
    // ponytail: 立即连接回调，以便本方法内的状态更新能推送。
    ws.onStatusChange = callbacks?.onStatusChange ?? null;
    ws.onLoadingChange = callbacks?.onLoadingChange ?? null;

    // 1. 向后端注册工作区
    ws.onStatusChange?.('正在激活工作区...');
    console.log('[Workspace.open] step 1: workspace_activate...');
    // #10 修复（2026-09-02）：workspace_activate 失败此前只 console.error——
    // 后端未注册工作区时后续文件操作会全失败，但用户看不到。现在 pushStatus
    // 可见化（不 throw——工作区文件层面仍可操作，只是后端桥断）。
    await typedRpc('workspace_activate', { path }).catch((e) => {
      console.error('[Workspace.open] workspace_activate failed:', e);
      const msg = e instanceof Error ? e.message : String(e);
      ws.onStatusChange?.(`⚠️ 工作区激活失败（后端桥可能不可用）: ${msg}`);
    });
    console.log('[Workspace.open] step 1: done');
    // ⚡ 启动锚（日志可观测性批 1，2026-09-27）：收到的 ui.log 必须自带
    //   版本/commit/工作区/配置路径/代理端口——事故里这些一个都没有，只能靠
    //   「invoke 有没有 method 字段」反推壳的构建时间。
    //   两条时序纪律：① 等 initLogger 落定再报（logPath 在它的 await 之后才赋值，
    //   抢跑会误报 log_channel:unavailable，且本条会写进**旧工作区**的缓冲）；
    //   ② 全程 void——锚是诊断副产物，绝不许拖慢或拦住工作区打开。
    void (async () => {
      // 级别开关（日志可观测性批 3）：**必须先于 initLogger** —— 级别就位之前
      // 写的条目会按旧级别判（该丢的写了 / 该留的丢了）。env > localStorage > 默认。
      try {
        await applyLogLevelFromShell();
      } catch {
        // 级别解析失败不是失败：applyLogLevelFromShell 自身已全部兜底，这里再兜一层
        //（它不许成为工作区打开的失败源——与下面的 initLogger 同一条纪律）。
      }
      // try/await 而非 .catch()：initLogger 在测试替身里可能返回非 promise
      //（vi.fn() → undefined），`.catch` 会当场炸——锚是副产物，不许它成为
      // 工作区打开的失败源。
      try {
        await initLogger(path);
      } catch {
        // 日志通道初始化失败不拦启动——boot 会如实记 log_channel:unavailable
      }
      let port = 0;
      try {
        port = await getProxyPort();
      } catch {
        // 端口解析失败 = 回退直连（transport 的既有降级语义），记 0
      }
      Obs.boot({ workspace: path, providersPath: providersFilePath(), proxyPort: String(port) });
    })();

    console.log('[Workspace.open] all done, returning workspace');
    return ws;
  }

  // ═══════════════════════════════════════════════════════════════
  // 停用 — 保存状态、停止监听器、移除监听器
  // ═══════════════════════════════════════════════════════════════

  async deactivate(chatPanel: ChatCore): Promise<void> {
    this._active = false;

    // 跨工作区串染根治（H3，2026-09-02）：deactivate 可能被 switchWorkspace 的
    // withTimeout(5000) 放弃后仍在后台跑——超时/异常路径的 catch 会调
    // forceClearState 抢救（推进代际）并继续开新工作区。迟到的保存步骤会
    // 用「已被新工作区覆盖的 store」快照写进旧工作区文件：saveCanvasState 把
    // 新工作区摊开集写进旧区 canvas.json（持久污染）；workspace_deactivate
    // 还会误关新工作区的后端态。每步落盘前校验代际，过期即弃。
    const epoch = getWorkspaceEpoch();

    // 保存聊天会话
    try {
      await chatPanel.saveActiveSession(this.path);
    } catch {
      /* 忽略 */
    }
    if (!isCurrentEpoch(epoch)) {
      console.warn('[Workspace.deactivate] 代际已变（超时被 forceClearState 抢救）——跳过剩余落盘，防跨工作区串写');
      return;
    }

    // Stage-5：切走前落盘工作区画布状态（布局 + 公共物——工作区级，随工作区走）
    try {
      await chatPanel.saveCanvasState(this.path);
    } catch {
      /* 忽略 */
    }
    if (!isCurrentEpoch(epoch)) return;

    // 停止 watcher 并清除后端状态（过期跳过——此 RPC 会误关**新**工作区的后端态）
    if (isCurrentEpoch(epoch)) {
      try {
        await typedRpc('workspace_deactivate', {});
      } catch {
        /* 忽略 */
      }
    }

    // 统一释放 fiber 上登记的全部工作区级清理器（dispose-to-quiescence：等待
    // 全部清理器 settle）。所有获取点（open/setupAgent）在获取时就地 effect 登记，
    // deactivate 不靠人肉枚举。失败必须可见（不静默）— setupAgent 有序组内部聚合
    // 记 warn；独立 effect 的失败走 cordis logger.error；均不阻断工作区切换。
    try {
      await this._fiber.dispose();
    } catch (err) {
      console.warn('[Workspace.deactivate] fiber.dispose 部分清理失败:', err);
    }
    // 推进工作区代际 — 使在途的旧项目 fire-and-forget 写共享态过期丢弃。
    bumpWorkspaceEpoch();
  }

  /** 强制清除所有状态。
   *  在 deactivate() 超时时调用 — 防止卡住的工作区
   *  阻塞下一次 switchWorkspace。
   *  #13 修复（2026-09-02）：fiber.dispose() 改为返回 Promise——调用方 await
   *  确保异步清理器（canvas flush、session 落盘等）在新工作区创建前 settle，
   *  否则旧工作区的 fire-and-forget 清理与新工作区设置竞态。runtime 同步
   *  disposeAll 保留（H3 防 60s TTL timer）；fiber async 清理器改为 await。 */
  async forceClearState(): Promise<void> {
    this._active = false;
    // 紧急路径：runtime 必须同步 disposeAll（H3）— 不等 flush，防 60s TTL timer
    // 继续对共享后端发 agent_isolation_discard（真实删 worktree）。
    // flushAllBoards 设计为 fire-and-forget。
    if (this.runtime) {
      void this.runtime.flushAllBoards();
      this.runtime.disposeAll();
      this.runtime = null;
    }
    // 快通道释放 fiber 上登记的清理器——runtime 已同步 disposeAll（H3），
    // 有序组内 runtime disposer 因 this.runtime === null 而 no-op。
    // async 清理器（canvas flush 等）await settle，防新工作区竞态。
    await this._fiber.dispose();
    // 推进工作区代际 — 使在途的旧项目 fire-and-forget 写共享态过期丢弃。
    bumpWorkspaceEpoch();
  }

  // ── Agent 配置变更统一入口 ──

  /**
   * Agent 配置变更统一入口（由 state/agent-config-store 信号驱动）。
   * 所有变更热切换，不重建 Agent：
   *  - 协作模式 → 运行时切换（setPlanMode）
   *  - 提供方身份变更 → 换 live provider 引用（唯一需要换引用的场景）
   *  - 同提供方内的 baseUrl/model/apiKey/thinking/maxTokens 变更 → 无需任何
   *    换引用——live provider（Phase C，2026-08-24）在每次使用点按名现解析，
   *    保存即生效
   *  - contextWindow → 热同步（setContextWindow）
   * 上下文、压缩缓存、hook、正在运行的执行、所有会话全部保留。
   * 例外：Agent 缺席（装配失败/异常路径的恢复——Phase C 后无 Key 冷启动不再
   * 走此分支，Agent 恒装配）→ 走全量装配（setupAgent + autoRestoreLastSession，
   * 与冷启动同序列）。组件不得绕过此方法直接调 setupAgent。
   *
   * ⚡ P14（2026-08-22）恒 swap 退役（Phase C，2026-08-24）：恒 swap 时代靠
   * 「每次信号重建 provider 换引用」把新配置带进在用 Agent——枚举漂移的旧雷
   * （_agentRebuildKey 手工 diff）曾靠它根治。live provider 把配置面整体移到
   * 使用点后，换引用只剩「提供方换人」一个场景；Key 清空不再拆除 Agent/会话
   * （下一次请求经 live 现解析出空 Key → 照发且不发凭据头；端点要鉴权时按
   * 401/403 的分类文案点名「本行没有 API Key」，会话照常显示）——DSH 形态的
   * 「配置断了 → 会话在，发送时报错」。
   */
  async applyAgentConfig(chatPanel: ChatCore, reason: AgentConfigChangeReason, sessionId?: number): Promise<void> {
    // 规划模式切换 — 运行时状态切换（raw Agent 引用承担——接口层无 setPlanMode；
    // 工厂现造的句柄下次造时从 mode-store 现读，无活句柄也不丢状态）
    if (reason === 'collaboration-mode') {
      const mode = this._modeState().collaborationMode;
      this._lastRawAgent?.setPlanMode(mode === 'plan');
      return;
    }

    // D2（2026-08-27 收窄）：热切换路径不再全量 restoreSecrets——loadSettings
    // 同步读就够了（providers/activeProvider/model 都在 localStorage）；诊断 Key
    // 状态改走 resolveApiKey（provider/credentials.ts 内存缓存，命中零 IPC）。
    // 此前每个 model-switched/settings-saved 信号都逐个 provider credential_get
    // （切一次模型 = N 次 IPC），只为算个诊断用 keyLen。request 期真实凭据仍由
    // live provider 按名现解析（fail-loud 语义不变）。
    const s = loadSettings();
    const act = getActiveProvider(s);

    // Key 状态仅作诊断呈现（不拆 Agent/会话——请求期由 live provider 报错）
    const apiKey = await resolveApiKey(act.name);
    if (!apiKey || apiKey.trim() === '') {
      useAgentPanelStore.getState().setDiag({
        text: `⚠️ API Key 未配置 — provider="${act.name}"。会话保留，发送请求将报错。`,
        ready: false,
      });
    } else {
      useAgentPanelStore.getState().setDiag({ text: `[Agent] provider=${act.name}`, ready: true });
    }

    // 工厂缺席（装配从未成功过的恢复路径）才补一次全量装配。
    if (!this._factoryRegistered) {
      await this.setupAgent(chatPanel);
      return;
    }

    // ── 方案甲（2026-08-27）：会话级变更（创作坞切模型/思考，信号带 sessionId）
    //    → 只热切换该会话的句柄。解析该会话生效配置（覆盖 ?? 全局默认）。 ──
    if ((reason === 'model-switched' || reason === 'thinking-changed') && sessionId != null) {
      const handle = agentSessionState.getAgent(this._storeId, sessionId);
      if (!handle) return; // 句柄未建（惰性）——工厂现造时会吃到新覆盖
      const eff = resolveComposeEffective(this._storeId, sessionId);
      const row = s.providers.find((p) => p.name === eff.providerName) ?? act;
      // 档位只有**会话显式覆盖**才写进 provider 的覆盖槽（2026-09-23 思考下沉）：
      // 写 undefined = 清覆盖 → live 按目标模型解析（per-model ?? 行值）。
      // 写「解析后的全局快照值」会把行值钉成本卷覆盖，per-model 档位永不生效。
      const prefs = getComposeStore(this._storeId).getState().getPrefs(String(sessionId));
      const prov = createLiveProvider(
        eff.providerName,
        // S6 P2b：热切换重造的 provider 也用**该卷自己组合**的 seam 裁剪面
        // （否则切一次模型就把卷级 seam 面退回全局——与装配面不自洽）。
        { seamView: sessionSeamViewFor(this._storeId, sessionId) },
        { model: eff.model, thinking: prefs?.thinking },
      );
      prov.prewarm?.();
      handle.setProvider(prov);
      handle.setThinking(prefs?.thinking);
      handle.setContextWindow(this._contextWindowFor(row, eff.model));
      return;
    }

    // ── 全局变更（settings-saved）→ 逐会话重解析（方案甲语义 3/4）：
    //    有覆盖的卷保持自己的值；无覆盖的卷实时跟随新全局默认。 ──
    this.prov = this._buildProvider(s); // 工厂/后续装配的全局基准
    this.prov.prewarm?.();
    agentSessionState.forEachAgentEntry((storeId, sid, h) => {
      const eff = resolveComposeEffective(storeId, sid);
      const row = s.providers.find((p) => p.name === eff.providerName) ?? act;
      // 覆盖存在 → live 带覆盖（该会话维度不跟随全局）；无覆盖 → 裸 live（现解析行值）
      // seamView（S6 P2b）：两条分支都按该卷组合裁剪 `seam/llm`。
      const override = getComposeStore(storeId).getState().getPrefs(String(sid));
      const seamView = sessionSeamViewFor(storeId, sid);
      const prov = override
        ? createLiveProvider(eff.providerName, { seamView }, { model: eff.model, thinking: override.thinking })
        : createLiveProvider(eff.providerName, { seamView });
      h.setProvider(prov);
      // 档位覆盖只来自**会话显式改动**（override.thinking）；未改卷传 undefined =
      // 清覆盖 → live 现解析 per-model ?? 行值（2026-09-23 思考下沉：旧写法传
      // eff.thinking = 全局快照里的行值，把它钉成了会话覆盖，per-model 永不生效）。
      h.setThinking(override?.thinking);
      h.setContextWindow(this._contextWindowFor(row, eff.model));
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // setupAgent — 构建带 hologram/coding/memory 工具的 LLM Agent
  // ═══════════════════════════════════════════════════════════════

  async setupAgent(chatPanel: ChatCore): Promise<void> {
    if (this.agentSetupRunning) {
      this.agentSetupPending = true;
      return;
    }
    this.agentSetupRunning = true;
    try {
      await this._setupAgentInner(chatPanel);
    } finally {
      this.agentSetupRunning = false;
      if (this.agentSetupPending) {
        this.agentSetupPending = false;
        await this.setupAgent(chatPanel);
      }
    }
  }

  /** 构建/重建共享工具注册表——setupAgent 与会话工厂覆盖路径的共用出口。
   *  组装材料（deps/agentRef/memoryManager/skillRegistry…）全部工作区级。
   *
   *  `assemblyKey` = `composition` 那份产物的**输入身份**（`compositionIdentity()`，
   *  调用方与产物同时求出）。不在这里读 composition-store：store 可能落后于本工作区
   *  真实输入（引擎工具行注册后、error 态等——见 `_setupAgentInner` 的取产物注释），
   *  而「注册表是按哪份组合建的」这条判定必须与**实际建表用的产物**一致。 */
  private async _buildRegistryLocked(composition: ResolvedComposition, assemblyKey: string): Promise<ToolRegistry> {
    const registry = await buildToolRegistry({
      deps: this._builderDeps as BuilderDeps,
      memoryManager: this.memoryManager ?? undefined,
      skillRegistry: this.skillRegistry ?? undefined,
      taskManager: this.taskManager,
      subAgentPool: this.subAgentPool,
      subAgentSpawner: async (desc, prompt, prog, mode, al, sig, asyncMode, agentIdOverride, outputSchema) =>
        this._agentRef.current?.spawnSubAgent(
          desc,
          prompt,
          prog,
          mode,
          al,
          sig,
          asyncMode,
          agentIdOverride,
          outputSchema,
        ) ?? Promise.resolve({ text: '', err: 'agent not available' }),
      // S2-1 组合外化：工具行表穿线（roster 解析产物；缺省 = 出厂表 = 零漂移）
      toolRows: composition.tools,
    });
    this.registry = registry;
    // S6 P1d：身份与产物同步快照（建表时点）——判定「能否复用本注册表」用身份比，
    // 而身份必须是**建表时点**的（见 _assemblyKey 字段注）。
    this._assemblyKey = assemblyKey;
    return registry;
  }

  /** 从 panel store 读取协作模式。回退到 normal。
   * （权限模式已迁 mode-store 单源真相，C11 重设计 2026-08-22——
   * 不再从 panel-store 读，agent 会话工厂亦不消费。） */
  private _modeState(): { collaborationMode: 'normal' | 'plan' } {
    try {
      const ps = getPanelStore(this._storeId).getState();
      return { collaborationMode: ps.collaborationMode };
    } catch (e) {
      console.warn('[Workspace] _modeState failed, falling back to normal:', e);
      return { collaborationMode: 'normal' };
    }
  }

  /** 构建 active provider 的 live 形态（Phase C，2026-08-24 工作区归属根治）：
   *  provider 对象 = 无状态协议适配器——baseUrl/model/apiKey/thinking/maxTokens
   *  每次使用点按提供方名现解析（createLiveProvider → provider/credentials.ts
   *  凭据缓存 + 写穿失效）。_setupAgentInner 与会话工厂共用此入口，保证两处
   *  构建永不分叉。Agent 的构造与存在性因此与 Key 无关（空 Key = 照发、不发
   *  凭据头；端点要鉴权时由 401/403 的分类文案点名「本行没有 API Key」）；
   *  「强制关闭思考」的旁路（翻译/压缩）仍用
   *  显式构造的 createProvider，不经此入口。 */
  private _buildProvider(settings: AppSettings): Provider {
    // S6 P2b：这里**不传 seamView** 是有意的——工作区默认 provider 的组合上下文
    // 就是「工作区装配组合」，而 composition-store 的三个 setter 已把它的
    // seamDisabled 灌成全局当前选择（seam-resolution.ts 的兜底面）⇒ 缺省即正确。
    return createLiveProvider(getActiveProvider(settings).name);
  }

  /** 方案甲（2026-08-27）+ per-model 覆盖（2026-08-26）：会话级窗口计算——
   *  per-model 覆盖（modelOverrides）优先，其次会话生效模型的目录值，最后 200K。
   *  工厂与热切换共用（原全局版 _effectiveContextWindow 随「全局单 provider 装配」
   *  退役；per-provider 单字段 contextWindow 已拆，多模型时代按 Provider 管一个值
   *  毫无意义）。 */
  private _contextWindowFor(
    row: { modelOverrides?: Record<string, ModelOverrides>; kind: string },
    model: string,
  ): number {
    return modelContextWindow(row as ProviderSettings, model);
  }

  private async _setupAgentInner(chatPanel: ChatCore): Promise<void> {
    this._storeId = chatPanel.panelId;

    // 跨工作区串卷根治（H2，2026-09-02）：旧工作区会话面清理必须在**任何可抛
    // 错的装配步骤之前**。此前挂在函数尾部——switchWorkspace 对 setupAgent 的
    // catch 只 pushStatus 后继续走恢复链（setProjectPath → restoreCanvasSpread），
    // 装配链任一步抛错即跳过清理 → sess store 残留旧区在内存卷 → 恢复链的
    // openIds 把撞号卷判「已在案头」，旧区内容渲染到新工作区画布（实机串卷
    // 根因之二；之一见 chat-session.ts 摊开路径的代际防护）。
    resetSessionState(chatPanel.panelId);

    // P0-4 优化（2026-09-02）：loadSettingsWithSecrets（含 credential_get 并行解密）
    // 与 get_global_memory_dir 互相独立——Promise.all 并行，省 1 次 IPC 往返。
    let globalDir: string | undefined;
    const settingsPromise = loadSettingsWithSecrets();
    const globalDirPromise = kernelGlobalMemoryDir()
      .then((d) => {
        globalDir = d;
      })
      .catch(() => {
        /* 忽略 */
      });
    const settings = await settingsPromise;
    await globalDirPromise;

    // 从保存的偏好初始化模式状态
    // 权限模式（C11 重设计）：mode-store 已在 boot 期水合并镜像 Rust
    // （hydratePermissionMode），此处不再从 settings 套用——单向陷阱退役。
    // 协作模式仍走 panel-store（会话级状态，与权限模式不同生命周期）。
    const sAgent = settings.agent || {};
    const ps = getPanelStore(this._storeId).getState();
    if (sAgent.collaborationMode && ps.collaborationMode === 'normal') {
      ps.setCollaborationMode(sAgent.collaborationMode);
    }

    const active = getActiveProvider(settings);

    const diag = `[Agent] provider=${active.name} keyLen=${(active.apiKey || '').length}`;
    this.onStatusChange?.(diag);
    useAgentPanelStore.getState().setDiag({ text: diag, ready: !!active.apiKey && active.apiKey.trim() !== '' });

    // Phase B（2026-08-24 工作区归属根治）：无 Key 不再拆除会话——装配照常进行
    //（工厂注册 + 会话内容层），缺 Key 的表现 = 发消息时工厂返 null →
    // ensureSessionAgent 提示「请先配置 API Key」/配 Key 后请求期报错，会话
    // 列表恒在（DSH 形态：配置断了 → 会话照常显示，发送时报错）。
    if (!active.apiKey || active.apiKey.trim() === '') {
      useAgentPanelStore.getState().setDiag({
        text: `⚠️ 未检测到 API Key — provider="${active.name}"。会话照常可用，发送前请在设置中配置。`,
        ready: false,
      });
    }

    // ⚡ 2026-08-08：删除启动时的 persistSecrets 回写（原在此行）。
    // 理由：读回→无条件写回是「null 复活」与双重编码放大循环的驱动器——
    // 任何残留在 state 里的垃圾 key（如字面量 "null"）都会在每次启动时
    // 被重新写入凭据库。凭据的唯一写入入口 = SettingsPanel 的保存动作。

    // 加载记忆（全局 + 项目）——globalDir 已在上方与 settings 并行获取（P0-4）
    let memorySection = '';
    // setupAgent 有序拆除组（cordis-migration P1）：每次调用一个 DisposerBag，
    // 作为单个 fiber effect 登记。组内保持 DisposerBag 的串行逆序契约 —
    // 「先拆 runtime 再清缓存」等顺序依赖不变。
    // 组创建即登记 effect（而非收集完再登记）：setupAgent 中途异常时已登记的
    // 部分清理器同样随 fiber dispose 释放（与旧 _bag 行为一致）。
    const teardown = new DisposerBag();
    this._fiber.ctx.effect(
      () => async () => {
        try {
          await teardown.dispose();
        } catch (err) {
          console.warn('[Workspace] setupAgent teardown 部分清理失败:', err);
        }
      },
      'setupAgent-teardown',
    );
    this.memoryManager = createMemoryManager(this.path, globalDir);
    // 获取即登记：停用时释放记忆。
    teardown.add(() => {
      this.memoryManager = null;
    }, 'memory-manager-null');
    this.memoryManager.onSaved = (info) => {
      // raw Agent 引用（agentRef）承担非接口能力面——接口层无 notifyMemorySaved
      this._lastRawAgent?.notifyMemorySaved(
        `记忆已更新: **${info.description || info.name}** (${info.confidence || 'reference'})`,
      );
    };
    try {
      // 记忆召回锚点：原为图谱 top 枢纽名，图谱退役（2026-09-09）后回退无锚形态。
      memorySection = await this.memoryManager.loadPromptSection();
    } catch (err) {
      console.error('[setupAgent] loadPromptSection failed:', err);
    }

    // 初始化 Agent 状态持久化 + goal 生命周期 + skill 注册表
    // 2026-09-01：AgentStore 已内存化（不再落盘 .lantai/agents，见 agent-store.ts 头注）
    this.agentStore = new AgentStore();
    this.goalManager = new GoalManager(this.path, broadcastGoalRecord);
    this.goalManager.adoptOrphans().catch((e) => console.warn('[workspace] goal adoption failed:', e));
    this.skillRegistry = createSkillRegistry(this.path);

    if (memorySection.trim()) {
      const memLines = memorySection.split('\n').filter((l) => l.startsWith('- ')).length;
      const globalCount = this.memoryManager?.scopes?.().includes('global') ? ' (含全局)' : '';
      this.onStatusChange?.(`[记忆] 已注入 ${memLines} 条${globalCount}`);
    }

    // ── 创建 Provider ──
    const prov: Provider = this._buildProvider(settings);
    prov.prewarm?.();
    // 从 API 获取动态模型，合并到目录（尽力而为）
    // R5 D8（2026-08-29）：拉取中面——compact 选择器分组头「目录获取中…」可见
    // provider-model-meta（2026-09-11）：**全部提供方**都后台拉取（此前只拉 active
    // ——多提供方配置下非活动行的模型元数据永远缺失，切过去才发现窗口/视觉全错）。
    // 无凭据的行由 live 层静默返回空（不算失败面）；这里只落**内存目录**
    // （mergeDynamicModels），不写 settings——避免与设置页未保存的暂存互相覆盖。
    // 持久化走设置页「从 API 拉取」这个显式动作（写暂存 → 保存落 modelMeta）。
    for (const row of settings.providers) {
      const target: Provider = row.name === active.name ? prov : createLiveProvider(row.name);
      markDynamicFetchStart(row.name);
      target
        .fetchModels?.()
        .then((models) => {
          if (models.length > 0) mergeDynamicModels(row.name, models);
          // C5（2026-08-27）：后台自动拉取也记失败面——成功清标记，失败记原因
          // （**设置页「模型目录」区**可见原因，那儿有「刷新目录」可重试；
          // 2026-09-23 用户拍板 A 后创作坞不再报这个警）。last-good 已合并模型
          // 不因失败被清。
          recordDynamicFetchResult(row.name, true);
        })
        .catch((e) => recordDynamicFetchResult(row.name, false, e instanceof Error ? e.message : String(e)));
    }
    this.prov = prov;

    // ── 创建 Runtime + UI 适配器 ──
    // P0-10：覆盖旧 runtime 前必须走完整拆除（与下方销毁路径同一顺序：
    // flushAllBoards → disposeAll）——否则旧 runtime 的订阅与防抖 flush
    // 定时器仍然存活，可能回写覆盖新看板（雷区地图 P0-10）
    if (this.runtime) {
      try {
        await this.runtime.flushAllBoards();
      } catch (e) {
        console.warn('[workspace] 旧 runtime 看板 flush 失败:', e);
      }
      this.runtime.disposeAll();
      this.runtime = null;
    }
    // 清注入缓存登记在 runtime 之前 → 逆序释放时晚于 runtime.disposeAll（先拆 Agent 再清缓存）。
    teardown.add(() => resetAgentCaches(), 'reset-agent-caches');

    // ── 工作区接线贡献面（批 10 部件一，2026-09-26）──
    // 产物在 apply 期经 `ctx.workspaces.onActivate` 登记「工作区打开时要接的线」；
    // 此处按注册序**串行 await**，位置在组合快照 / `_buildRegistryLocked` **之前**
    // （工具行必须先于注册表构建）。贡献抛错不阻断工作区打开（失败隔离 + 具名回执）。
    // ⚠ 本批（部件一）先立通道：`bundled-engine` 的接线仍是内联调用，**部件三**把它
    // 迁成第一个贡献者（届时这段内联接线删除）。
    await activateWorkspaceContributions({
      root: this.path,
      ctx: this._fiber.ctx,
      report: (r) => {
        // 通用回执面：状态栏一行 + 日志（贡献者自己的诊断 store 由它自己写）
        if (r.status === 'wired') {
          useShellStore.getState().pushStatus(r.toolCount != null ? `已接线（${r.toolCount} 项在册）` : '已接线');
        } else if (r.status === 'failed') {
          useShellStore.getState().pushStatus(`⚠️ 接线未完成：${r.reason ?? '原因未给出'}`);
          console.warn('[Workspace] 接线贡献未完成:', r.reason);
        }
      },
    });

    // ── 随包图谱引擎接线（批 10 部件三，2026-09-26）：**已迁入产物** ──
    // `plugins/builtin/bundled-engine/` 经 `ctx.workspaces.onActivate` 贡献——由上方那条
    // `activateWorkspaceContributions(...)` 在**同一位置**（组合快照之前）按注册序执行；
    // 三态回执（wired / failed + 具名原因 / off）由该产物写 `useBundledEngineStore` + 状态栏。
    // 本文件不再持有引擎知识（禁用该产物 = 引擎天然 kill switch）。

    // ── 创建 Runtime + UI 适配器（旧 runtime 的拆除已在上方 P0-10 处完成）──
    // cordis-migration P2：runtime 挂在工作区 fiber 下 — 每个 Agent 在 cordis 树上
    // 获得身份 fiber（hologram/agent），生命周期随 AgentContext.dispose 摘除。
    // S2-1 组合外化：组合解析产物穿进 runtime（capability 表 + prompt 段表的运行时
    // 真源 + 激活 retain 的判定面）。
    // ⚠ 取产物必须在**引擎接线之后**（见上）：接线注册的引擎工具行是这份产物的输入。
    //
    // 取法 = **重新解析**，而不是读 composition-store 的快照（2026-09-24 实测缺陷）：
    // store 是解析产物的缓存，只在「贡献变更监听已武装（bootShell）+ 非 error 态」
    // 时才会被刷新——工作区装配不该依赖那个监听在不在（无引导环境、或用户层 patch
    // 被拒的 error 态下 store 停在旧产物，引擎行静默缺席，症状与用户报的一模一样）。
    // `effectiveComposition()` 是**永不抛出**的解析入口（F1 捕获网），与 store 的
    // 写入口同源；`compositionIdentity()` 是它的输入身份（S6 P1d：会话工厂据此判
    // 「本卷要的组合」与共享注册表所依据的组合是否同一份）。
    reapplyComposition(); // 正常态下顺带同步 store（诊断面与会话工厂读它）；error 态按纪律跳过
    const composition = effectiveComposition();
    this._assemblyKey = compositionIdentity();
    const runtime = new AgentRuntime(this.path, this._fiber.ctx, composition);
    const adapter = createRuntimeAdapter(this._storeId);
    runtime.setNotifier(adapter);
    runtime.setDiagnosticsSource(getDiagnosticsForFile);
    this.runtime = runtime;
    // 获取即登记：runtime 销毁（flush 看板 → disposeAll → 解引用）。
    // async 清理器在 deactivate（await fiber.dispose → 组内串行）等待；forceClearState
    // 走快通道（不等 settle）— runtime 已在 forceClear 顶部同步 disposeAll，此处因
    // this.runtime 已为 null 而 no-op。
    teardown.add(async () => {
      if (!this.runtime) return;
      try {
        await this.runtime.flushAllBoards();
      } catch (e) {
        console.warn('[workspace] runtime flushAllBoards 失败:', e);
      }
      this.runtime.disposeAll();
      this.runtime = null;
    }, 'runtime-dispose');
    teardown.add(() => {
      this.subAgentPool.stopAll();
    }, 'subagent-pool-stop');
    // ── 后台任务通知路由（bg:note）──
    // Rust 监视线程在 job 完成/停滞时发射（携带 owner）→ 这里排干该 owner 的
    // 通知队列并经 bus systemNotify 投递：idle agent 被 wake 回调唤起新一轮 run，
    // 运行中的 agent 则在下轮边界注入。owner = 发起 agent 的 bus id（executor
    // 注入 _owner_id）— 排干幂等（同一通知只经 listener 或 runLoop drain 之一
    // 到达）。owner 已消亡（子 Agent 结束注销）时不排干：通知留在 Rust 有界
    // 队列（超限丢最旧）— 排干后无处投递才是真丢失；bash_output(jobId) 仍是
    // 兜底拉取路径。
    const bgNoteBus = runtime.getBus();
    const unBgNote = await typedListen('bg:note', (payload) => {
      const owner = payload.owner;
      // 役台账（2026-09-22）：job 完成/停滞即对账一次——`bg:note` 是**唯一**的
      // 终态时点信号（快照只含在役，job 一旦终态就查不到它了）。这一跳必须
      // **先于**下面的 owner 守卫：owner=null（用户/UI 发起）也要落账。
      void pullShellWork(this._storeId);
      // 用户/UI 发起的任务（owner=null）不投给 agent；owner 已注销的直接跳过（见上）
      if (!owner || !bgNoteBus.isRegistered(owner)) return;
      void (async () => {
        try {
          // R3-d 信封退役：drain_bg_notifications 经 process_cap 能力口直呼
          const notes = await kernelProcessCall('drain_bg_notifications', { agent_id: owner });
          if (notes) bgNoteBus.systemNotify(owner, 'bg', notes);
        } catch {
          /* best-effort — 通知丢失时 bash_output(jobId) 仍可主动拉取 */
        }
      })();
    });
    teardown.add(unBgNote, 'listener:bg-note');
    // ── 插件 deferred 唤醒路由（app shell 件 D · S4）──
    // 插件后台任务完成（工具口 host.deferred.complete / MCP 路 lantai/deferred
    // 通知翻译）→ plugins/deferred 扇出到各 runtime 的唤醒路由器；本路由器
    // 认领本 runtime 注册的发起 Agent：systemNotify('bg') 投递 minimal 定位键
    // （{status, taskId, sessionId}——与 bg:note 同一注入/唤醒通道，内容凭
    // taskId 调插件工具按需取）。多工作区各注册各的，不认领返回 false。
    const unDeferredWake = registerDeferredWakeHandler((ownerId, key) => {
      const bus = runtime.getBus();
      if (!bus.isRegistered(ownerId)) return false;
      bus.systemNotify(ownerId, 'bg', formatDeferredWakeNote(key, runtime.sessionIdOf(ownerId)));
      return true;
    });
    teardown.add(unDeferredWake, 'listener:plugin-deferred-wake');
    // agentSessionState 解除本面板的全部会话句柄（dispose + 清表）— 拆 audit 中危：
    // 清理不再挂在下一个 setupAgent 上。
    teardown.add(() => agentSessionState.clearPanelState(this._storeId), 'session-state-clear');

    // ── 初始化 Agent 面板数据 + 订阅消息流 ──
    useAgentPanelStore.getState().setRuntime(runtime);
    useAgentPanelStore.getState().refresh(runtime);
    /* 役台账的 owner → 会话归属解析（2026-09-22）。Rust 账本只给裸 owner 串
     * （`main-…` / `sub-…` / null，bg_jobs.rs:147），没有「属于哪个会话」的字段；
     * 解析要 bus 的父子树 + agentSessionState，两者都只在**本面板的 runtime**
     * 手里 ⇒ 在此装配期注入（能力位：不注入 = 归属未知，条目不丢，落「他卷」档）。
     * 子 Agent 不入 sessionOfAgent 表（agent-session-state.ts:99-101 明写），
     * 故沿 bus 的 parentId 链上溯到主 Agent 再查表——这条链对子 Agent 是通的
     *（子 Agent 在 Agent 构造时随 setBus 注册，agent.ts:608-614）。 */
    const resolveOwnerSession = (owner: string | null): number | null => {
      if (!owner) return null;
      const bus = runtime.getBus();
      const seen = new Set<string>();
      let cursor: string | null = owner;
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const hit = agentSessionState.sessionOfAgent(cursor);
        if (hit && hit.storeId === this._storeId) return hit.sessionId;
        cursor = bus.getAgent(cursor)?.parentId ?? null;
      }
      return null;
    };
    setOwnerSessionResolver(this._storeId, resolveOwnerSession);
    // 获取即登记：停用时清面板 runtime 引用 + currentSessionId（拆 audit 中危#3：
    // 2s 轮询打旧 runtime 建错位 board）+ 清看板列表 + 解役台账归属。
    teardown.add(() => {
      const p = useAgentPanelStore.getState();
      p.setAgents([]);
      p.setTaskBoard([]);
      p.setDiscoveries([]);
      p.setCurrentSessionId('default');
      p.setRuntime(null);
      setOwnerSessionResolver(this._storeId, null);
      useWorkLedgerStore.getState().clearPanel(this._storeId);
    }, 'agent-panel-store-clear');
    const unsubMsg = runtime.getBus().subscribe({}, (msg) => {
      useAgentPanelStore.getState().pushMessage(msg);
    });
    teardown.add(unsubMsg, 'listener:runtime-msg');

    // ── 构建工具注册表（通过 agent-builder，零 UI 导入）──
    // 装配材料提升为实例字段（会话工厂覆盖路径复用同一 deps/agentRef/组合快照）。
    const builderDeps: BuilderDeps = createBuilderDeps(this._storeId);
    this._builderDeps = builderDeps;
    this._agentRef = { current: null as Agent | null };
    const agentRef = this._agentRef;

    // 随包图谱引擎接线已在上方完成（**必须先于组合快照**：工具行是装配输入，
    // 见该处注释——2026-09-24 实机缺陷①②）。这里只建注册表。
    const registry = await this._buildRegistryLocked(composition, this._assemblyKey);

    // 冷启动：预热状态缓存（git 状态与引擎无关照刷）
    refreshGitStatus(this.path).catch(() => {});

    // ── 工厂：每次调用通过 runtime 创建全新 Agent ──
    // 返回 runtime 句柄（含 dispose）— 所有权随句柄交给会话 state
    // （agentSessionState），会话关闭时由其负责销毁；
    // agentRef 仅是借用 raw Agent 引用（spawn 闭包、notifyMemorySaved）。
    // S4-1a 会话工厂组合覆盖（设计件 §2.2 复审补充的机制位——「无生产 UI
    // 消费、机制完整、选择器留给 V5」）：当前生效组合 ≠ 工作区装配组合时，
    // 工厂为该会话构建会话作用域注册表（deps 全部工作区级可复用）并把组合
    // 覆盖传给 createAgent（prompt/capabilities 域随覆盖换源；工具域经会话
    // 注册表换源）。无选择器时两值恒等 → 走共享注册表 + 无覆盖 = S2 现状
    // 零漂移。子 Agent 经 ctx composition 服务继承 → 与父同面。
    const factory = async (sessionId: number): Promise<AgentHandle | null> => {
      // Phase C（2026-08-24 工作区归属根治）：Agent 恒可构造——Key 缺失不再拒绝
      // 装配。凭据/baseUrl/apiKey 全部在使用点经 live provider 按名现解析（空
      // Key = 照发、不发凭据头，会话不动）。定价/窗口出自同步
      // settings 快照（零 IPC），后续变更由 applyAgentConfig 热同步。
      // 方案甲（2026-08-27）：按会话生效配置装配——有覆盖的卷用会话的
      // provider/model/thinking，未改过的卷 = 裸 live（实时跟随全局默认）。
      const s = loadSettings();
      const act = getActiveProvider(s);
      const override = getComposeStore(this._storeId).getState().getPrefs(String(sessionId));
      const eff = resolveComposeEffective(this._storeId, sessionId);
      const row = s.providers.find((p) => p.name === eff.providerName) ?? act;
      const sessSeamView = sessionSeamViewFor(this._storeId, sessionId);
      const sessProv = override
        ? createLiveProvider(
            eff.providerName,
            { seamView: sessSeamView },
            // 档位同理（2026-09-23 思考下沉）：只有会话显式覆盖才写覆盖槽
            { model: eff.model, thinking: override.thinking },
          )
        : createLiveProvider(eff.providerName, { seamView: sessSeamView });
      sessProv.prewarm?.(); // 廉价预热（fire-and-forget）；fetchModels 合目录只在 setupAgent 做

      const ms = this._modeState();

      await runtime.ready();
      // 唯一 agentId — 每会话一个 Agent 实例；'main' 硬编码会让所有会话的
      // Agent 在 runtime.agents/_agentSessions 里互相覆盖（多会话错位根因之一）
      const sessionAgentId = `main-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // 会话组合覆盖判定（S4-1a 机制位；S6 P1d 换判据）：本会话要的组合与共享
      // 注册表所依据的组合**不是同一份**时，为本会话建会话作用域注册表并把组合
      // 覆盖传给 createAgent。
      // ⚡ 判据演进（2026-09-15）：
      //   - 旧判据是**对象引用**比较（会话解析产物 vs 装配时点快照字段；该字段随
      //     换轨删除——零读者即化石）。
      //     实测语义（2026-09-15 审计 F4）：引用在 factory 态恒不等——store 里那份是
      //     setupAgent 时点的快照，会话解析产物来自 preset-assembly 的 cache，两者
      //     永不同一对象 ⇒ 覆盖分支恒活跃，**每卷白建一份会话注册表**。
      //   - 现判据是**组合身份**比较（preset-assembly.compositionIdentity：层内容 +
      //     贡献代数，输入派生）。同身份 ⇒ 同输入 ⇒ 同一份行面 ⇒ 可安全复用共享
      //     注册表；身份含贡献代数 ⇒ 插件重注册/卸载后必不相等 ⇒ 不会复用陈旧注册表
      //     （「先证明不会复用陈旧注册表」的判据就在这一条）。
      //   - 身份与产物同步快照（_assemblyKey 在**建表时点**取，见字段注）——不与
      //     比较时点的 store 比，否则热重载后会拿新身份配旧注册表。
      //   - _assemblyKey 缺席（store 未记录输入身份）= 未知 ⇒ 按「不同」处理
      //     （会话自建注册表 = 旧行为，安全方向）。
      // F1 捕获网：解析走 effectiveComposition（坏 preset 回退用户层组合，不抛）。
      // P0 记录闭环（2026-09-14）：**重开一卷用它自己记录的组合**重建（读盘时经
      // agentSessionState 登记；缺省 = 新卷，用全局当前选择）——「模型可见 ⟺ 已记录」
      // 的可重建半边：某卷创建于 minimal，后来全局默认改成 standard，重开该卷仍是
      // minimal（该组合仍可用时）。两类失败在**装配面**给一次可见提示（卷照常打开、
      // 回退用户层组合；不静默、不阻断）——提示归这里而不是卷持久化层：那一层引组合
      // 模块会成环（实测整仓连坐），且「组合可不可用」只有解析侧知道。
      const recordedPresetId = agentSessionState.getRecordedPresetId(this._storeId, sessionId);
      if (recordedPresetId !== null) {
        const reason = isPresetKnown(recordedPresetId)
          ? selectionError(recordedPresetId)
          : `组合「${recordedPresetId}」不在册（已被删除或改名）`;
        if (reason) {
          showToast(`本卷组合不可用：${reason}——已按用户层组合加载`, 'error', TOAST_LONG_HOLD_MS);
        }
      }
      const sessionComposition = effectiveComposition(recordedPresetId ?? undefined);
      // S6 P1d 判据：组合身份（输入派生）不引用。身份 ≠ 建表时点身份（含「未知」）
      // ⇒ 本会话自建注册表；等同 ⇒ 复用共享注册表（真零重建）。
      const sessionKey = compositionIdentity(recordedPresetId ?? undefined);
      const compositionOverride = sessionKey !== this._assemblyKey ? sessionComposition : undefined;
      // 会话作用域注册表：覆盖存在时按覆盖的 tools 域构建（deps 工作区级复用）
      const sessionRegistry = compositionOverride
        ? await buildToolRegistry({
            deps: builderDeps,
            memoryManager: this.memoryManager ?? undefined,
            skillRegistry: this.skillRegistry ?? undefined,
            taskManager: this.taskManager,
            subAgentPool: this.subAgentPool,
            subAgentSpawner: async (desc, prompt, prog, mode, al, sig, asyncMode, agentIdOverride, outputSchema) =>
              agentRef.current?.spawnSubAgent(
                desc,
                prompt,
                prog,
                mode,
                al,
                sig,
                asyncMode,
                agentIdOverride,
                outputSchema,
              ) ?? Promise.resolve({ text: '', err: 'agent not available' }),
            toolRows: compositionOverride.tools,
          })
        : (this.registry ?? registry);

      let handle: Awaited<ReturnType<typeof runtime.createAgent>>;
      try {
        handle = await runtime.createAgent(
          {
            agentId: sessionAgentId,
            parentId: null,
            projectPath: this.path,
            provider: sessProv,
            tools: sessionRegistry,
            memoryManager: this.memoryManager ?? undefined,
            goalManager: this.goalManager ?? undefined,
            agentStore: this.agentStore ?? undefined,
            subAgentPool: this.subAgentPool,
            // 并发会话（2026-08-26）：事件入口按会话绑定——事件天生携带所属卷
            // 身份，两卷并发流式互不串扰（旧共享 eventSink 靠活跃卷猜测路由）。
            // execState 同步改挂会话级（权限卡/停止语义按卷隔离）。
            eventSink: chatPanel.eventSinkFor(sessionId),
            execState: chatPanel.getSessionExecState(sessionId),
            collaborationMode: ms.collaborationMode,
            temperature: 0.7,
            // 附图读取器（multimodal-image-plan B3 · D-5）：请求期 ref→载荷
            // 的 IO 腰——工作区根拼 attachments 路径经 fs_cap read_base64，
            // 再过 **wire 规整**（2026-09-22 读图挂起事故：工具附图通道不走准入
            // 规整，6.4MB 图直接内联成 8.6MB data URI 让服务商 30s 零字节）；
            // Agent 层零 app 依赖（注入闭包）。子 Agent 经 spawn 继承。
            imageReader: (ref) => readAttachmentForWire(this.path, ref, WIRE_IMAGE_CAPS),
            // 从模型目录动态解析窗口（deepseek-v4 标 1M），查不到才 fallback 200K。
            // 0b3e5bf 曾加 Math.min(..., 200000) 硬封顶 — 把动态结果压成 200K，
            // 导致压缩在 110K 就触发；压缩已根治为只影响发送载荷，cap 无必要。
            // 方案甲：按会话生效模型 + provider 行覆盖计算。
            contextWindow: this._contextWindowFor(row, eff.model),
            onSessionPersisted: (_sid: string, messages: Array<{ role: string; content: unknown }>) => {
              memoryBundleIngest(
                messages.map((m) => ({
                  role: m.role,
                  content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                })),
                'holo',
                _sid,
              ).catch(() => {});
              (async () => {
                await refreshGitStatus(this.path);
                // 只消费本 Agent 产生的构建结果（其他会话的留在槽位等本尊）——
                // 并发会话：用本工厂闭包捕获的 agent（handle 建成即定），不再
                // 经共享 agentRef.current（最后创建的卷）错路由。
                const block = buildTurnStartBlock(sessionAgentId);
                if (block)
                  agentRef.current?.insertMessage(`<system-reminder>\n${block}\n</system-reminder>`, { silent: true });
              })().catch(() => {});
            },
          },
          // S4-1a：会话组合覆盖（prompt/capabilities 域随会话换源；缺省 =
          // runtime 组合 = 工作区装配组合，S2 零漂移）
          compositionOverride,
        );
      } catch (e) {
        // Phase D（错误不静默，2026-08-28 加固）：createAgent 抛错此前被上层
        // 静默吞掉（createNewSession catch{} / ensureSessionAgent 无 catch）→
        // 「点发送没反应」。这里落 ui.log（[DEBUG-send] 标签），错误仍上抛由
        // 调用方（sendMessage 已加 catch）可见化。
        const msg = e instanceof Error ? e.message : String(e);
        log.error('workspace', `[DEBUG-send] 会话 Agent 装配抛错（projectPath=${this.path}）: ${msg}`, {
          stack: e instanceof Error ? e.stack : undefined,
        });
        throw e;
      }

      const agent = '_getAgent' in handle ? (handle as { _getAgent(): Agent })._getAgent() : null;
      if (!agent) {
        // Phase D（错误不静默）：句柄建了但 raw Agent 取不到——可见诊断，不只进
        // console（会话层只会看到「工厂返回空」，这里补上根因）
        const msg = '会话 Agent 创建失败（运行时句柄无 raw Agent）';
        useAgentPanelStore.getState().setDiag({ text: `❌ ${msg}`, ready: false });
        this.onStatusChange?.(`⚠️ ${msg}`);
        return null;
      }
      // P1a（S6，2026-09-14）：把**本卷记录的组合**回述给 Agent 镜像。
      // 病灶（探针实证）：Agent 构造期 `_presetId = currentPresetId()` 读的是
      // **全局默认**，而卷落盘写的是 `agent.presetId`（chat-session.ts 两处 save）
      // ——重开一卷时装配面已按记录重建（上面的 effectiveComposition(recorded)），
      // 但镜像仍是全局默认，于是本卷**再落一次盘就把 presetId 改写成全局默认**，
      // 记录静默丢失（P0 的「重开按其重建」只在第一次重开成立）。
      // 记录不可解析时照样回述：`presetId` 是「本卷的组合意图」而非「实际生效面」，
      // 修好该 preset 后重开仍应回到它；回退与提示已在上方装配面给出（不静默）。
      // `selectPreset` 追加 preset/selected 事件（newest-wins 重建面同源），且
      // 不触发重装配——组合面在构造时点已按记录冻结（前缀缓存纪律）。
      if (recordedPresetId !== null) agent.selectPreset(recordedPresetId);
      agentRef.current = agent;
      this._lastRawAgent = agent;
      return handle;
    };

    // 注册工厂（DSH 形态，2026-08-25：工厂 = 「知道怎么造」，零成本挂接）。
    // 不再预造初始 Agent——句柄生命周期跟随卷，拟文时 ensureSessionAgent
    // 经工厂现造；raw Agent 引用面由 factory 内部 agentRef 承担。
    chatPanel.setAgentFactory(factory);
    this._factoryRegistered = true;
    this.onStatusChange?.('[Agent] ✅ 工厂已就绪（拟文时装配）');
  }
}
