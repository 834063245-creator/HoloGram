// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AgentRuntime — 管理 Agent 实例的生命周期
//
// 职责：
//   - 创建/销毁 Agent 实例
//   - 通过 RuntimeNotifier 接口向 UI 推送事件（不直接操作 zustand/store）
//   - 管理 ToolRegistry、hooks、preflight 等 Agent 依赖
//
// 不依赖：React, zustand, ui/event bus, ui/chat-store, ui/panel-store
//
// UI 层通过 setNotifier() 注入通知器，Runtime 通过它路由事件。

import type { ActivationHandle } from '../../composition/activation';
import type { ActivationService } from '../../composition/activation-service';
import { activeHookContributions } from '../../composition/hook-service';
import { activePreStepContributions } from '../../composition/pre-step-service';
import { factoryComposition, type ResolvedComposition } from '../../composition/roster';
import type { Context } from '../../cordis';
import { providersFilePath } from '../../provider/providers-store';
import type { StoredThinking } from '../../provider/thinking';
import type { ChatImageRef, Message, Provider } from '../../provider/types';
import { kernelDeleteFile, kernelProcessCall, kernelReadFile, kernelWriteFile, parseJson } from '../../rpc-contract';
import { Agent } from '../agent';
import { resolveAgentLoop } from '../agent-loop/agent-loop-active';
import type { AgentUINotifier, EventSink } from '../agent-types';
import { EventKind } from '../agent-types';
import { prewarmAssetStateSession } from '../asset-state';
import { AgentBlueprint, type BlueprintScope } from '../blueprint';
import { AgentContext } from '../context';
import { DiscoveryBoard, DiscoveryBoardProxy } from '../discovery-board';
import type { ListenerOptions, LoopEventName, LoopEventPayload } from '../events';
import { createExecState, type ExecStateInstance } from '../execution-state';
import { HookRegistry, PreflightHookRegistry } from '../hooks';
import { enqueueIsolationOp } from '../isolation-queue';
import type { Disposer } from '../lifecycle';
import { log } from '../logger';
import type { MessageBus } from '../message-contract';
import { requireMultiagentComm } from '../multiagent-impl';
import { PlanStateManager } from '../plan/plan-state';
import { PreStepRegistry } from '../pre-step';
// asset-state 读口（2026-10-07）：owner（bus id）→ 会话号——会话绑定时写入、
// 销毁时与 _agentSessions 同点清理；渲染侧不经过本表（它直接拿会话号）。
import { clearOwnerSessionId, setOwnerSessionId } from '../session-context';
import { SessionLog } from '../session-log';
// 批 9h-3：技能扫描随 skill-domain 包 ⇒ 走内核登记表门面（缺实现 = 具名 fail-loud；
// 调用点外层 catch 保住「技能目录读不到不炸装配」的既有降级语义）
import { scanSkills } from '../skill-impl';
import type { DiagnosticsSource } from '../state-inject';
import type { AgentLifecycleManager } from '../subagent-runtime-contract';
import { requireSubagentRuntime } from '../subagent-runtime-impl';
import type { TaskBoardFace, TaskBoardProxyFace, TaskManagerFace } from '../task-contract';
import { createTaskBoard, createTaskBoardProxy } from '../task-impl';
import type { TokenLedgerSnapshot } from '../token-meter';
import { agentInvoke, ToolRegistry } from '../tool';
import { buildSystemPrompt } from './agent-builder';

import {
  type AgentAssemblyInputs,
  type AgentConfig,
  type AgentHandle,
  type AgentStatus,
  type AgentSummary,
  pickAssemblyInputs,
  type RuntimeNotifier,
  type RuntimePort,
} from './types';

// ── AgentHandleImpl ──

/** 技能目录文本（装配期 system prompt 追加段）。
 *  扫 <project>/.lantai/skills + ~/.lantai/skills；无技能 = 返回 ''（零注入，
 *  system-prompt fixture 逐字节不变）。失败静默降级（技能目录读不到不炸装配）。 */
async function loadSkillCatalogFor(projectPath: string): Promise<string> {
  try {
    if (!projectPath) return '';
    const scan = await scanSkills(projectPath);
    if (scan.skills.length === 0) return '';
    return scan.skills
      .map((s) => {
        const base = `- **${s.name}**: ${s.description}`;
        return s.whenToUse ? `${base}\n  - 适用: ${s.whenToUse}` : base;
      })
      .join('\n');
  } catch {
    return '';
  }
}

class AgentHandleImpl implements AgentHandle {
  constructor(
    private readonly _agent: Agent,
    private readonly _runtime: AgentRuntime,
    private readonly _ctx: AgentContext | null = null,
  ) {}

  get id(): string {
    return this._agent.id;
  }
  get parentId(): string | null {
    return this._agent.parentId;
  }
  get status(): AgentStatus {
    return this._agent.isRunning ? 'running' : 'idle';
  }

  /** 转发附图引用（ChatAgentHandle.run 第三参）——**必须原样透传**：
   *  本类是实现侧最后一跳，少接一参即静默吞图（图不进 agent 会话、无占位、
   *  模型只收文字）；同签名的 acp.AcpAgent 是外部协议极小子集，不走此路。 */
  run(signal: AbortSignal, input: string, images?: ChatImageRef[]): Promise<void> {
    return this._agent.run(signal, input, images);
  }
  runGoal(signal: AbortSignal, goal: string) {
    return this._agent.runGoal(signal, goal);
  }
  resumeGoal(signal: AbortSignal, id?: string) {
    return this._agent.resumeGoal(signal, id);
  }
  compactNow(signal: AbortSignal) {
    return this._agent.compactNow(signal);
  }
  retractTurnAt(sessionIndex: number) {
    return this._agent.retractTurnAt(sessionIndex);
  }
  getSession() {
    return this._agent.getSession();
  }
  setSession(msgs: Message[]) {
    return this._agent.setSession(msgs);
  }
  newSession() {
    return this._agent.newSession();
  }
  get nextInsertIndex() {
    return this._agent.nextInsertIndex;
  }
  insertMessage(text: string, opts?: { silent?: boolean }) {
    return this._agent.insertMessage(text, opts);
  }
  cascadeAbort() {
    return this._agent.cascadeAbort();
  }
  stopAllSubAgents() {
    return this._agent.stopAllSubAgents();
  }
  runningSubAgentCount() {
    return this._agent.runningSubAgentCount();
  }
  setUiSessionId(sid: number) {
    return this._agent.setUiSessionId(sid);
  }
  setThinking(cfg: StoredThinking | undefined) {
    return this._agent.setThinking(cfg);
  }
  setProvider(prov: Provider) {
    return this._agent.setProvider(prov);
  }
  setContextWindow(n: number) {
    return this._agent.setContextWindow(n);
  }

  // ── token 计量转发（2026-09-13）：句柄即会话账本入口 ──
  getTokenStats() {
    return this._agent.getTokenStats();
  }
  snapshotTokenLedger() {
    return this._agent.snapshotTokenLedger();
  }
  restoreTokenLedger(snapshot: TokenLedgerSnapshot | null | undefined) {
    return this._agent.restoreTokenLedger(snapshot);
  }
  restoreCompactionFromLog() {
    return this._agent.restoreCompactionFromLog();
  }

  // ── loop 事件监听转发（P0 会话存盘止血，2026-09-15）──
  // 消费面 = 会话检查点（「模型请求前」语义时刻，见 shell/rows/persistence）：
  // 一层薄转发到 Agent.onLoopEvent（D4 监听面，非契约文件——不改 agent-loop 契约）。
  onLoopEvent<E extends LoopEventName>(
    event: E,
    fn: (payload: LoopEventPayload[E]) => void,
    opts?: ListenerOptions,
  ): Disposer {
    return this._agent.onLoopEvent(event, fn, opts);
  }

  // ── 事件日志（Phase 1 换轨，2026-09-15）──
  // 句柄即日志入口：会话层据此把事件日志接到盘上（app/chat/session-log-store），
  // 检查点/退出收尾据它排空队列。
  get sessionLog() {
    return this._agent.sessionLog;
  }

  /** 采用日志里的磁盘历史（Phase 3b）：转发到 Agent.adoptSessionLog。 */
  adoptSessionLog(systemPrompt: string): void {
    this._agent.adoptSessionLog(systemPrompt);
  }

  /** 绑定到指定会话的 board — 会话 id 在创建后才分配，由会话层在登记句柄时调用 */
  bindSession(sessionId: string): void {
    this._runtime._bindAgentSession(this._agent.id, sessionId);
  }

  /** 装配收尾回填本卷 exec 账本 — 转发到 Agent.setExecState（运行态单一权威源）。
   *  少接这一跳 = 句柄自起的轮次（总线唤醒/后台任务）记在构造期那本孤儿账上，
   *  UI 全域（读注册表实例）认为空闲——呼吸线不亮、停止钮拉不动。 */
  setExecState(exec: ExecStateInstance): void {
    this._agent.setExecState(exec);
  }

  /** 销毁此 Agent — 句柄即所有权，幂等（重复调用为 no-op） */
  dispose(): void {
    this._runtime._disposeAgent(this._agent.id);
  }

  /** 直接访问底层 Agent — 仅供内部使用 */
  _getAgent(): Agent {
    return this._agent;
  }

  /** 直接访问装配 context — 仅供内部使用（_disposeAgent / 收敛测试） */
  _getContext(): AgentContext | null {
    return this._ctx;
  }
}

// ── AgentRuntime ──

export class AgentRuntime implements RuntimePort {
  private agents = new Map<string, AgentHandleImpl>();
  private notifier: RuntimeNotifier | null = null;
  /** 全局 MessageBus 实例 */
  private _bus: MessageBus;
  /** 会话级 TaskBoardFace 实例 — 按 sessionId 隔离 */
  private _taskBoards = new Map<string, TaskBoardFace>();
  /** 会话级 DiscoveryBoard 实例 — 按 sessionId 隔离 */
  private _discoveryBoards = new Map<string, DiscoveryBoard>();
  /** 每个 Agent 的 board proxies — bindSession 时重定向到其会话的 board */
  private _agentProxies = new Map<string, { task: TaskBoardProxyFace; discovery: DiscoveryBoardProxy }>();
  /** 已 restore 的会话集合 — 避免重复 restore */
  private _restoredSessions = new Set<string>();
  /** 项目路径 — 用于持久化 */
  private _projectPath: string;
  /** LifecycleManager 实例 — 每个 agent 一个，持有 pool/board/bus/exec/sink 引用 */
  private _lifecycleManagers = new Map<string, AgentLifecycleManager>();
  /** 启动恢复 promise — createAgent 前必须 await ready() */
  private _readyPromise: Promise<void>;
  /** agentId → sessionId 映射 — _disposeAgent 时知道清理哪个会话的 board */
  private _agentSessions = new Map<string, string>();
  /** agentId → 该 Agent 实例专属的待办 TaskManagerFace（每会话主 Agent 一个实例） */
  private _agentTaskManagers = new Map<string, TaskManagerFace>();
  /** cordis 挂载父 ctx（cordis-migration P2）— AgentContext 身份 fiber 的挂载点。 */
  private _cordisParent?: Context;
  /** 组合解析产物（S2-1 组合外化）— capability 表（蓝图默认来源）与
   *  prompt 段表的运行时真源。缺省 = 出厂组合（factoryComposition，
   *  现行装配，零漂移）；workspace 接线传 composition-store 的 resolved。 */
  private _composition: ResolvedComposition;

  constructor(projectPath?: string, cordisParent?: Context, composition?: ResolvedComposition) {
    this._projectPath = projectPath ?? '';
    // cordis-migration P2：Agent fiber 的挂载父（workspace 接线传工作区 fiber ctx）。
    // 缺省（单测/无内核）→ AgentContext 不建 fiber，行为零变化。
    this._cordisParent = cordisParent;
    this._composition = composition ?? factoryComposition();
    if (projectPath) {
      // 批 7b：通信域实现归产物包，经内核登记表造（service 语义：缺实现即 fail-loud）
      const comm = requireMultiagentComm();
      const store = comm.createJsonStore(projectPath);
      this._bus = comm.createBus(undefined, store);
      this._readyPromise = this._restore();
    } else {
      this._bus = requireMultiagentComm().createBus();
      this._readyPromise = Promise.resolve();
    }
  }

  /** 等待启动恢复完成 — createAgent 前必须 await */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /** 注入 UI 通知器 — 由 UI 层在启动时设置 */
  setNotifier(n: RuntimeNotifier): void {
    this.notifier = n;
  }

  /** 获取全局 MessageBus 实例 */
  getBus(): MessageBus {
    return this._bus;
  }

  /** 获取指定会话的 TaskBoardFace — 不存在则创建 */
  getTaskBoard(sessionId?: string): TaskBoardFace {
    return this._getOrCreateTaskBoard(sessionId ?? 'default');
  }

  /** 获取指定会话的 DiscoveryBoard — 不存在则创建 */
  getDiscoveryBoard(sessionId?: string): DiscoveryBoard {
    return this._getOrCreateDiscoveryBoard(sessionId ?? 'default');
  }

  /** 获取或创建会话级 TaskBoardFace */
  private _getOrCreateTaskBoard(sessionId: string): TaskBoardFace {
    let board = this._taskBoards.get(sessionId);
    if (!board) {
      board = createTaskBoard(this._projectPath || undefined, sessionId);
      this._taskBoards.set(sessionId, board);
    }
    return board;
  }

  /** 获取或创建会话级 DiscoveryBoard */
  private _getOrCreateDiscoveryBoard(sessionId: string): DiscoveryBoard {
    let board = this._discoveryBoards.get(sessionId);
    if (!board) {
      board = new DiscoveryBoard(this._projectPath || undefined, sessionId);
      this._discoveryBoards.set(sessionId, board);
    }
    return board;
  }

  /** 销毁会话级 board 并删除持久化文件 */
  async destroySessionBoards(sessionId: string): Promise<void> {
    const tb = this._taskBoards.get(sessionId);
    if (tb) {
      await tb.destroy();
      this._taskBoards.delete(sessionId);
    }
    const db = this._discoveryBoards.get(sessionId);
    if (db) {
      await db.destroy();
      this._discoveryBoards.delete(sessionId);
    }
  }

  /** 切换当前活跃会话 — 仅触发该会话 board 的懒加载恢复（供面板查询）。
   *  不改写任何 Agent 的 board 绑定 — proxies 由 bindSession 静态绑定。 */
  setCurrentSession(sessionId: string): void {
    const tb = this._getOrCreateTaskBoard(sessionId);
    const db = this._getOrCreateDiscoveryBoard(sessionId);
    // 尚未恢复的会话进行懒加载恢复
    if (!this._restoredSessions.has(sessionId)) {
      this._restoredSessions.add(sessionId);
      void tb.restore();
      void db.restore();
    }
  }

  /** 将 Agent 的 board proxies 绑定到指定会话 — 仅供内部使用（AgentHandle.bindSession）。
   *  聊天会话的数字 id 在 createAgent 之后才分配，会话层在登记句柄时调用完成
   *  静态绑定；此后该 Agent 的 board 写入终生落在此会话的板上，不再随会话切换改变。 */
  _bindAgentSession(agentId: string, sessionId: string): void {
    const proxies = this._agentProxies.get(agentId);
    if (!proxies) return;
    const tb = this._getOrCreateTaskBoard(sessionId);
    const db = this._getOrCreateDiscoveryBoard(sessionId);
    // 尚未恢复的会话进行懒加载恢复（与 setCurrentSession 同一语义）
    if (!this._restoredSessions.has(sessionId)) {
      this._restoredSessions.add(sessionId);
      void tb.restore();
      void db.restore();
    }
    proxies.task.setTarget(tb);
    proxies.discovery.setTarget(db);
    // 更新会话映射 — 子 Agent 经 _agentSessions.get(parentId) 继承正确会话，
    // _disposeAgent 据此清理正确会话的 board
    this._agentSessions.set(agentId, sessionId);
    // asset-state 读口（同上时点）：owner → 会话号可解析；顺带预热该会话的状态表
    // （提前触发读盘恢复，收窄「html 卡首读为空」的窗口——文件读快，通常先于渲染完成）。
    setOwnerSessionId(agentId, sessionId);
    prewarmAssetStateSession(this._projectPath, sessionId);
    // 重启收养：根 Agent 绑定会话板后，认领上次进程遗留的条目与 worktree
    // （子 Agent 完成时父已退出 → 旧父 id 死账；Rust isolation 注册表内存态
    // → 磁盘 worktree 死账。两侧都收养后 agent_merge 恢复可用。）
    const handle = this.agents.get(agentId);
    if (handle && handle.parentId === null) {
      void tb.restore().then(() => this._adoptRestartOrphans(agentId, tb));
    }
  }

  /** 重启收养：重挂旧父 id 条目 + 注册磁盘孤儿 worktree（best-effort，不阻塞会话）。
   *  Rust 侧已在 workspace_activate 重建 isolation 注册表，这里把状态接回
   *  TaskBoardFace 使 agent_board / agent_merge 恢复可见可用。 */
  private async _adoptRestartOrphans(rootAgentId: string, tb: TaskBoardFace): Promise<void> {
    try {
      let adopted = 0;
      // 1. 旧父 id 条目重挂（父进程已消亡，条目还挂在死 id 上）
      const liveIds = new Set(this.agents.keys());
      for (const entry of tb.getAllEntries()) {
        if (entry.parentAgentId === rootAgentId || liveIds.has(entry.parentAgentId)) continue;
        tb.reparent(entry.agentId, rootAgentId);
        adopted++;
      }
      // 2. 磁盘孤儿 worktree（Rust 已收养、board 无记录）→ 注册为可合并条目
      const statusText = await agentInvoke<string>('agent_isolation_status', {});
      const status = JSON.parse(statusText) as {
        isolations?: Array<{ agent_id: string; worktree_exists: boolean }>;
      };
      const known = new Set(
        tb
          .getAllEntries()
          .map((e) => e.isolationId)
          .filter((v): v is string => !!v),
      );
      for (const iso of status.isolations ?? []) {
        if (!iso.worktree_exists || known.has(iso.agent_id)) continue;
        tb.register({
          agentId: iso.agent_id,
          parentAgentId: rootAgentId,
          description: '重启前遗留的子 Agent worktree（启动收养，可直接 agent_merge 或丢弃）',
          isolationId: iso.agent_id,
        });
        tb.complete(
          iso.agent_id,
          '重启收养的孤儿 worktree — 变更未经本轮验证，合并前请先 agent_isolation_diff 审阅',
          '',
        );
        adopted++;
      }
      if (adopted > 0) {
        console.warn(`[AgentRuntime] 收养 ${adopted} 个重启前遗留的子 Agent 条目到 ${rootAgentId}`);
        // 通知模型上下文（bus），不只发 console — 收养结果必须可见。
        // systemNotify 绕过拓扑：system 不是注册 agent，树拓扑会拒绝
        // （旧 bus.send 被静默吞掉，收养结果从未真正到达过模型上下文）。
        this._bus.systemNotify(
          rootAgentId,
          'status',
          `已收养 ${adopted} 个重启前遗留的子 Agent 条目（agent_board 可见；completed 条目可直接 agent_merge）`,
        );
      }
    } catch {
      // best-effort — 收养失败不阻塞会话启动
    }
  }

  /** 启动恢复 — 在 createAgent() 之前完成。
   *  1. 恢复所有 inbox 消息
   *  2. 迁移旧全局 discoveries.json/taskboard.json（一次性）
   *  3. 孤儿检测：崩溃时还在跑的子 agent，进程已死，标记为 stopped 并清理 worktree
   *  best-effort — 永不抛异常阻塞启动
   *  注意：会话级 board 懒加载，首次 getOrCreate 时 restore */
  private async _restore(): Promise<void> {
    try {
      // 1. 恢复所有 inbox 消息
      await this._bus.restore();
      // 1b. 清除跨 session 泄漏的 result/reply — 这些只在上个 session 内有效
      this._bus.purgeEphemeralTypes();

      // 2. 迁移旧全局 discoveries.json → default 会话（一次性）
      await this._migrateGlobalBoards();

      // 3. 恢复 default 会话的 boards（启动时默认恢复）
      const defaultTB = this._getOrCreateTaskBoard('default');
      await defaultTB.restore();
      const defaultDB = this._getOrCreateDiscoveryBoard('default');
      await defaultDB.restore();
      this._restoredSessions.add('default');

      // 4. 孤儿检测：status === 'running' 的条目是崩溃时还在跑的子 agent。
      //    进程已死 → 标记 stopped；worktree 不销毁 — 先抓 diff 保全到 board
      //    （TTL 清理纪律：不销毁无记录的工作），抓不到则保留现场。
      const orphans = defaultTB.getAllEntries().filter((e) => e.status === 'running');
      for (const orphan of orphans) {
        defaultTB.stop(orphan.agentId);
        if (orphan.isolationId) {
          const orphanIsolationId = orphan.isolationId;
          try {
            await enqueueIsolationOp(async () => {
              const diffText = await agentInvoke<string>('agent_isolation_diff', {
                agent_id: orphanIsolationId,
              }).catch(() => '');
              if (diffText) {
                try {
                  const parsed = JSON.parse(diffText) as { has_changes?: boolean; diff?: string };
                  // 只保全可解析的 diff 文本；不可解析的回包不入 board（保留现场即可）
                  if (parsed.has_changes && parsed.diff) defaultTB.attachDiff(orphan.agentId, parsed.diff);
                } catch {
                  /* diff 抓取失败 — worktree 保留现场，不写垃圾进 board */
                }
              }
            });
          } catch {
            /* best-effort — Rust 注册表可能尚未收养（workspace_activate 顺序），保留现场即可 */
          }
        }
        console.warn(
          `[AgentRuntime] 检测到孤儿 agent: ${orphan.agentId}, 已标记 stopped（worktree 保留，diff 已尽力保全）`,
        );
      }

      // 5. 刷新持久化（把 stop 状态写回）
      if (orphans.length > 0) {
        await defaultTB.flush();
      }
    } catch {
      // best-effort — 恢复失败不阻塞启动
    }
  }

  /** 一次性迁移旧全局 discoveries.json / taskboard.json → default 会话 */
  private async _migrateGlobalBoards(): Promise<void> {
    if (!this._projectPath) return;
    const base = this._projectPath.replace(/\\/g, '/').replace(/\/$/, '');
    // 迁移全局 discoveries.json
    const oldDiscPath = `${base}/.lantai/discoveries.json`;
    try {
      const raw = await kernelReadFile(oldDiscPath);
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) {
        const db = this._getOrCreateDiscoveryBoard('default');
        for (const e of arr) {
          db.post(e.agentId, e.key, e.value, e.category);
        }
        await db.flush();
      }
      // 迁移后删除旧文件
      await kernelDeleteFile(oldDiscPath).catch(() => {});
    } catch {
      /* 文件不存在 — 无需迁移 */
    }
    // 迁移全局 taskboard.json
    const oldTaskPath = `${base}/.lantai/taskboard.json`;
    try {
      const raw = await kernelReadFile(oldTaskPath);
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) {
        const _tb = this._getOrCreateTaskBoard('default');
        // 直接将迁移的条目写入新路径
        await kernelWriteFile(`${base}/.lantai/taskboard/default.json`, JSON.stringify(arr, null, 2));
      }
      // 迁移后删除旧文件
      await kernelDeleteFile(oldTaskPath).catch(() => {});
    } catch {
      /* 文件不存在 — 无需迁移 */
    }
  }

  /** 创建 Agent — 接收完整配置，Runtime 不做 UI 依赖的事。
   *  Phase 3 起（agent-core-convergence）：本方法是 AgentConfig → AgentContext
   *  的翻译层 + 装配委托；装配本体 _assembleAgent 只消费 ctx + inputs，
   *  不再接触 AgentConfig（specs/phase-3 T0 结构门禁钉住）。
   *  S4-1a：可选 compositionOverride 整体换源（缺省 this._composition——
   *  S2 零漂移）；AgentConfig 字段面冻结不受影响（覆盖走参数不走 config）。 */
  async createAgent(config: AgentConfig, compositionOverride?: ResolvedComposition): Promise<AgentHandle> {
    const { ctx, inputs } = this._contextFromConfig(config);
    return this._assembleAgent(ctx, inputs, undefined, compositionOverride);
  }

  /** 从 AgentContext 创建 Agent — Phase 3 收敛入口（RuntimePort 契约见 types.ts）。
   *  Phase 6：第 3 参 blueprint 允许调用方以声明式 capability 扩展装配面 —
   *  新增工具/hook 不再要求修改 AgentConfig。缺省蓝图 = 组合产物派生
   *  （fromRoster(composition.capabilities)——B⑤ 起出厂 capability 面经
   *  ctx.capabilities 通道贡献，standard() 快捷方式退役）。
   *  S4-1a：第 4 参 composition 覆盖 — 缺省 this._composition（S2 零漂移）；
   *  会话工厂传会话作用域组合（工具面/prompt/capabilities 三域换源）。 */
  async createAgentFromContext(
    ctx: AgentContext,
    inputs: AgentAssemblyInputs = {},
    blueprint?: AgentBlueprint,
    composition?: ResolvedComposition,
  ): Promise<AgentHandle> {
    return this._assembleAgent(ctx, inputs, blueprint, composition);
  }

  /** AgentConfig → AgentContext 翻译层 — 身份与调用方供给的服务进 ctx，
   *  非服务装配输入进 inputs。这是 createAgent 路径唯一消费 AgentConfig 的地方。 */
  private _contextFromConfig(config: AgentConfig): { ctx: AgentContext; inputs: AgentAssemblyInputs } {
    // Plan 状态在翻译层创建（collaborationMode 是 config 侧概念，不进 ctx 契约）
    const planState = new PlanStateManager();
    if (config.collaborationMode === 'plan') {
      planState.enter(config.projectPath);
    }
    const ctx = new AgentContext(
      {
        agentId: config.agentId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        parentId: config.parentId ?? null,
        subagentDepth: config.subagentDepth ?? 0,
        isolationId: config.isolationId,
        projectPath: config.projectPath,
        sessionId: config.sessionId,
        cordisParent: this._cordisParent,
      },
      {
        provider: config.provider,
        tools: config.tools,
        eventSink: config.eventSink,
        memoryManager: config.memoryManager,
        agentStore: config.agentStore,
        goalManager: config.goalManager,
        subAgentPool: config.subAgentPool,
        execState: config.execState,
        messageBus: this._bus,
        planState,
      },
    );
    // 非服务装配输入：清单驱动搬运（ASSEMBLY_INPUT_KEYS 是唯一真源——类型与
    // 本行都从它派生，新增素材只改清单一处 ⇒ 漏搬在结构上不可能）。
    // 事故（2026-09-19 实测定位）：B3（2026-09-09）加 `imageReader` 时两端都改
    // 了、唯独这层的逐键手抄表漏搬 ⇒ Agent 持 `_imageReader = null` ⇒ 请求期图
    // 既不进 wire 也不留占位（能力戳已声明支持图，故连「图已省略」都没有），
    // **用户附图 / 工具截图 / fs(read) 图片从落地起一张都没到过模型**；真机复验
    // 与既有用例全绿（用例走 createTestAgent / mock provider，恰好绕开本层）。
    return { ctx, inputs: pickAssemblyInputs(config) };
  }

  /** 物化会话级基础设施服务（board proxies / planState / execState）并写回 ctx。
   *  ctx 入口允许调用方自带（差分 / 子 Agent 派生）；缺什么补什么，幂等。 */
  private _materializeSessionServices(ctx: AgentContext): void {
    // 会话级 board — 按 sessionId 隔离，子 Agent 继承父会话
    // 有 parentId 的子 Agent 继承父会话 ID；否则使用 ctx.sessionId 或 'default'
    // （会话主 Agent 的数字 id 创建后才分配，由会话层随后调 bindSession 重绑）
    if (!ctx.get('taskBoard') || !ctx.get('discoveryBoard')) {
      const sessionId =
        ctx.sessionId ?? (ctx.parentId ? this._agentSessions.get(ctx.parentId) : undefined) ?? 'default';
      const taskBoard = this._getOrCreateTaskBoard(sessionId);
      const discoveryBoard = this._getOrCreateDiscoveryBoard(sessionId);
      // Proxy 静态绑定到该 Agent 所属会话的 board — 句柄即所有权，
      // 一个 Agent 终生只属于一个会话，不再随会话切换动态重定向。
      const taskProxy = createTaskBoardProxy(taskBoard);
      const discoveryProxy = new DiscoveryBoardProxy(discoveryBoard);
      this._agentProxies.set(ctx.agentId, { task: taskProxy, discovery: discoveryProxy });
      this._agentSessions.set(ctx.agentId, sessionId);
      // asset-state 读口的初始绑定：子 Agent（继承父会话）创建即写入；
      // 主 Agent 此刻可能还是 'default' 哨兵（数字 id 创建后才分配）——跳过，
      // 由会话层 bindSession 重绑真号（同 _agentSessions 的重绑语义）。
      if (sessionId !== 'default') setOwnerSessionId(ctx.agentId, sessionId);
      ctx.set('taskBoard', taskProxy as unknown as TaskBoardFace);
      ctx.set('discoveryBoard', discoveryProxy as unknown as DiscoveryBoard);
    }
    if (!ctx.get('planState')) ctx.set('planState', new PlanStateManager());
    if (!ctx.get('execState')) {
      // 物化兜底：非会话装配路径（headless / 第三方 createAgentFromContext）自铸一本私账。
      // 会话路径**必须**显式供账（workspace 会话工厂传卷级账）——在这里铸 = 该 Agent 记在
      // 一本 UI 读不到的账上（2026-09-17 运行态丢失的形状），故留 debug 痕可回溯。
      log.debug('runtime', `Agent ${ctx.agentId} 未收运行账——runtime 物化一本私账（非会话装配路径）`);
      ctx.set('execState', createExecState());
    }
    // Phase 5：会话事件溯源日志 — 每 Agent 独立物化（Agent 构造从 ctx 读取并双写）
    if (!ctx.get('sessionLog')) ctx.set('sessionLog', new SessionLog());
  }

  /** 装配本体 — 只消费 AgentContext + AgentAssemblyInputs + AgentBlueprint（config-free）。
   *  Phase 6：工具/hook/接线由 blueprint capability 表驱动（表序 = 注册序，
   *  与 Phase 5 前的手写注册序一一对应；phase-1 effective 快照钉字节）。
   *  S2-1：缺省蓝图改由组合解析产物派生（fromRoster(this._composition.
   *  capabilities)——零漂移；B⑤ 起出厂 capability 面经 ctx.capabilities
   *  通道贡献，通道在册的组合快照即标准面）；显式
   *  blueprint 参数仍最高优先（createAgentFromContext 的扩展面）。
   *  S4-1a：composition 参数整体换源（缺省 this._composition）——prompt 段表
   *  与 capability 表读覆盖组合，缓存引用稳定由调用方（preset-assembly）保证。
   *  runtime 保留三块生命周期所有权：board-unregister / lifecycle-manager /
   *  runtime-maps 的 ctx.effect（Phase 4 语义，specs/phase-4 T0 钉住 ≥3 处）。 */
  private async _assembleAgent(
    ctx: AgentContext,
    inputs: AgentAssemblyInputs,
    blueprint?: AgentBlueprint,
    compositionOverride?: ResolvedComposition,
  ): Promise<AgentHandle> {
    const composition = compositionOverride ?? this._composition;
    const effectiveBlueprint = blueprint ?? AgentBlueprint.fromRoster(composition.capabilities);
    this._materializeSessionServices(ctx);
    const agentId = ctx.agentId;
    const taskProxy = ctx.resolve('taskBoard');
    const discoveryProxy = ctx.resolve('discoveryBoard');

    // Phase 4：TaskBoardFace 条目注销的对称清理归 ctx 所有权（proxy 转发到该 Agent
    // 终生绑定的会话板）。discoveryBoard 维持现状——旧 dispose 路径本就不注销它。
    ctx.effect(() => () => taskProxy.unregister(agentId), 'board-unregister');

    // 1. 构建 system prompt（如果没预构建）
    let sysPrompt = inputs.systemPrompt;
    if (!sysPrompt) {
      let memSection = '';
      const memoryManager = ctx.get('memoryManager');
      if (memoryManager) {
        try {
          // 记忆召回锚点：原为图谱 top 枢纽名（extractGraphNodeNames），
          // 图谱退役（2026-09-09）后回退无锚形态。
          memSection = await memoryManager.loadPromptSection();
        } catch {}
      }
      let claudeMd = '';
      try {
        claudeMd = await kernelReadFile(`${ctx.projectPath}/CLAUDE.md`);
      } catch {}

      // 运行环境块 — 探测当前 shell（bash/cmd），注入 system prompt。
      // Agent 第一轮就知道命令跑在哪个解释器上，避免"猜语法"反复踩坑。
      let shellEnvSection = '';
      try {
        // shell_env 形状真源 = os_sandbox::shell_env（os/shell/shell_path/notes 恒在；
        // shell_version/bundled 仅 Windows-bash 分支）。R3-d 信封退役：经
        // process_cap 能力口直呼（kernelProcessCall + parseJson）。
        const env = parseJson(await kernelProcessCall('shell_env')) as {
          os?: string;
          shell?: string;
          notes?: string;
        };
        if (env.shell) {
          if (env.shell === 'bash') {
            shellEnvSection =
              `- OS: ${env.os}${env.os === 'windows' ? ' (Windows 环境)' : ''}\n` +
              `- Shell: bash (Git Bash)\n` +
              `- 所有命令跑在 bash 上，用 Unix 语法：用 /dev/null 而不是 NUL、路径用正斜杠、用 ls 而不是 dir、变量用 $var`;
          } else {
            shellEnvSection =
              `- OS: ${env.os}\n` +
              `- Shell: ${env.shell}\n` +
              `- 命令跑在 ${env.shell} 上，用对应语法（bash 用 $var，cmd 用 %var%）`;
          }
          if (env.notes) shellEnvSection += `\n- 提示: ${env.notes}`;
        }
      } catch {}

      sysPrompt = buildSystemPrompt(
        ctx.projectPath,
        memSection,
        claudeMd,
        ctx.resolve('provider').name(),
        shellEnvSection,
        composition.prompt,
        await loadSkillCatalogFor(ctx.projectPath),
        // provider 配置文件路径（2026-09-24 配方改文件批）：让 agent 知道
        // 「配 provider」落在哪份文件上——它能直接读写它，不必请用户去点设置页。
        providersFilePath(),
      );
    }

    // 2. 克隆工具注册表（每个 Agent 获得自己的副本）— 克隆件写回 ctx.tools，
    //    Agent 构造（ctx 路径）与后续注册都落在这份有效注册表上；
    //    输入注册表保持干净，调用方可继续复用（与 Phase 3 前语义一致）。
    const r = new ToolRegistry();
    for (const t of ctx.resolve('tools').all()) r.register(t);
    ctx.set('tools', r);

    // 2b. isolationExec — agent_isolation_* 的 invoke 包装，被 merge/kill 工具与
    //     LifecycleManager 共用；Phase 6 经 BlueprintDeps 注入 capability。
    const isolationExec = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const result = await agentInvoke<string>(name, args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    };

    // 3. Phase 6 声明式装配 — capability 表驱动。context 阶段（Agent 构造前，
    //    可写 ctx 服务）→ 构造 → agent 阶段（表序即工具面注册序）。
    //    S4-1a：组合产物写进 ctx 服务表（Agent.composition 读取 + child()
    //    继承白名单——spawnSubAgent 的子 Agent 与父同一组合面）。
    if (!ctx.get('composition')) ctx.set('composition', composition);
    // S6 P3a：组合级插件激活账——装配期 retain（首次激活才 await start() 起副作用），
    // 句柄交给 AgentContext 的 effect（Agent dispose / 切组合即归零 → stop）。
    // 取值走 cordis ctx（AgentContext 是自有服务表，ctx.activation 不在其
    // AgentServices 面内）；无 cordis 挂载（腰外单测）或无声明插件 ⇒ 零开销
    // no-op（缺省零漂移：出厂 43 插件今天零 activation 声明）。
    const activation: ActivationService | undefined = ctx.cordisCtx?.get('activation');
    if (activation) {
      const activationHandles: ActivationHandle[] = [];
      ctx.effect(() => () => activation.releaseAll(activationHandles), 'activation-release');
      activationHandles.push(...(await activation.retainForComposition(composition, agentId)));
    }
    const scope: BlueprintScope = {
      ctx,
      inputs,
      tools: r,
      hooks: new HookRegistry(),
      preflightHooks: new PreflightHookRegistry(),
      preStep: new PreStepRegistry(),
      deps: {
        isolationExec,
        messageBus: this._bus,
        diagnosticsSource: this._diagSource ?? undefined,
        onPlanModeChange: (active, planFilePath) => {
          this.notifier?.onPlanModeChange?.(agentId, active, planFilePath);
        },
        registerTaskManager: (tm) => {
          this._agentTaskManagers.set(agentId, tm);
        },
      },
    };
    for (const cap of effectiveBlueprint.capabilities('context')) {
      if (cap.when?.(scope) ?? true) cap.install(scope);
    }

    // 4. 创建 Agent 实例（Phase 3：ctx 入口 — 身份/服务/总线/boards 从 ctx 读；
    //    隔离 ID、bus 注册、store/goalManager/pool 接线在构造内完成，
    //    旧路径这些接线与构造之间无 await，时序等价）
    const newAgent = new Agent(ctx, sysPrompt, {
      onSessionPersisted: inputs.onSessionPersisted,
      temperature: inputs.temperature ?? 0.7,
      contextWindow: inputs.contextWindow ?? 0,
      toolResultWindow: inputs.toolResultWindow,
      ui: this._wrapNotifier(agentId),
      // 附图读取器（B3）：装配输入透传——app 注入的 IO 腰（request-images）。
      imageReader: inputs.imageReader,
      // D13（平台化 Phase 5）：loop 解析 = ctx.agentLoop 注册表后注册胜。
      // 修复（2026-08-28 实机）：不再经 `this._cordisParent?.agentLoop?.active()`
      // 裸取 cordis 服务——生产 fiber 链上该访问抛「cannot get property
      // "agentLoop" without inject」（装配整链失败 → 点发送没反应）。改用
      // agent-loop-service 自带的消费读取面 resolveAgentLoop()：读模块级活动
      // 服务单例（后注册胜），无服务环境回落 defaultAgentLoop——与 AgentOptions
      // 缺省语义一致（agent.ts 构造 `opts.agentLoop ?? defaultAgentLoop`）。
      agentLoop: resolveAgentLoop(),
    });

    // 5. agent 阶段 capability — 注册序 = 表序（通信/discovery/merge/request/
    //    spawn/task/compaction/converge + hooks + plan 接线 + pre-run + 自动调优）。
    const agentScope: BlueprintScope = { ...scope, agent: newAgent };
    for (const cap of effectiveBlueprint.capabilities('agent')) {
      if (cap.when?.(agentScope) ?? true) cap.install(agentScope);
    }
    // hooks / preStep 统一接线 — capability 只往共享 registries 注册（整体替换语义）
    newAgent.setHooks(scope.hooks);
    newAgent.setPreflightHooks(scope.preflightHooks);
    newAgent.setPreStep(scope.preStep);

    // 5b. 管道钩子贡献折叠（A-2 通道）——ctx.hooks 贡献（enrich/preflight）
    // 注册进本 Agent 的共享 registries。序：capability 钩子先（state-hooks/
    // board-tracking 等第一方面），通道贡献随后——与 tools 域「builtin 行
    // 在前、贡献行随后」同序约定。贡献实例跨装配复用（无 factory 面）；
    // 生效时机 = 装配时点（在途会话不动，新会话折叠最新清单）。子 Agent
    // 不经本路径（spawnSubAgent 手工建 registry——state-hooks 同款不下放）。
    for (const contribution of activeHookContributions()) {
      if (contribution.kind === 'enrich') scope.hooks.register(contribution.hook);
      else scope.preflightHooks.register(contribution.hook);
    }

    // 5c. 步前裁决贡献折叠（agent-hooks-plan 一期——ctx.preStep 通道）——
    // 注册进本 Agent 的 PreStepRegistry。序：capability 先、通道贡献随后
    // （同 5b 约定）；生效时机 = 装配时点（在途会话不动）。子 Agent 不经
    // 本路径（spawnSubAgent 不接 pre-step 面 ⇒ host.preStep = null 直通）。
    for (const contribution of activePreStepContributions()) {
      scope.preStep.register(contribution.hook);
    }

    // 6. 接线 LifecycleManager — 全局空闲判定 + 泄漏检测 + worktree TTL 清理
    //    （生命周期所有权留 runtime，不进 capability — Phase 4 语义）
    const subPool = ctx.get('subAgentPool');
    if (subPool) {
      // 停止此 agentId 的前一个 LifecycleManager — 否则其 60s setInterval
      // 会在会话创建/恢复周期中泄漏并堆积。
      this._lifecycleManagers.get(agentId)?.stop();

      const rawSink = ctx.get('eventSink') ?? (() => {});
      const wrappedSink: EventSink = (ev) => {
        rawSink(ev);
        // 将 Notice 事件转发给通知器以驱动面板
        if (ev.kind === EventKind.Notice) {
          this.notifier?.onLifecycleAlert?.(agentId, ev.level ?? 'info', ev.text ?? '');
        }
      };
      // 批 7c-2：生命周期巡检器实现在产物包 subagent-in-process，经登记表造
      const lifecycle = requireSubagentRuntime().createLifecycleManager(
        subPool,
        taskProxy as unknown as TaskBoardFace,
        this._bus,
        isolationExec,
        wrappedSink,
      );
      // Phase 4：巡检 timer（60s setInterval）所有权归 ctx —— startOwned 返回
      // 幂等清理器，_disposeAgent 经 ctx.dispose() 释放，不再分散 stop。
      this._lifecycleManagers.set(agentId, lifecycle);
      ctx.effect(() => {
        const stopOwned = lifecycle.startOwned();
        return () => {
          stopOwned();
          this._lifecycleManagers.delete(agentId);
        };
      }, 'lifecycle-manager');

      // 接线子 Agent 完成 → 归档 discoveries（会话级）
      if (!ctx.parentId) {
        subPool.onFinish = (subId: string) => {
          discoveryProxy.archive(subId);
        };
      }
    }

    // 7. 注册并返回。runtime 注册表（agents/proxies/sessions/taskManagers）
    // 的清理同样归 ctx 所有权——最后注册 → dispose 时最先释放，保证
    // listAgents 在 dispose() 返回后同步可见移除（同步快通道）。
    const handle = new AgentHandleImpl(newAgent, this, ctx);
    this.agents.set(agentId, handle);
    ctx.effect(
      () => () => {
        this._agentProxies.delete(agentId);
        this._agentSessions.delete(agentId);
        clearOwnerSessionId(agentId);
        this._agentTaskManagers.delete(agentId);
        this.agents.delete(agentId);
      },
      'runtime-maps',
    );
    log.info('runtime', `agent created: ${agentId}`);

    return handle;
  }

  getAgent(id: string): AgentHandle | null {
    return this.agents.get(id) ?? null;
  }

  /** Agent 所属会话 id（未登记回 'default'）。S4（app shell 件 D）插件
   *  deferred 唤醒路由用——workspace 唤醒路由器按发起 Agent 解析所属会话，
   *  组 minimal 定位键 {status, taskId, sessionId}。 */
  sessionIdOf(agentId: string): string {
    return this._agentSessions.get(agentId) ?? 'default';
  }

  /** 返回某 Agent 实例专属的待办 TaskManagerFace（每会话主 Agent 一个实例）。
   *  UI 的 TasksPanel 用它订阅 / 读写当前会话主 Agent 的待办清单。 */
  getAgentTaskManager(agentId: string): TaskManagerFace | null {
    return this._agentTaskManagers.get(agentId) ?? null;
  }

  /** 销毁单个 Agent — 仅供内部使用（AgentHandle.dispose / disposeAll）。
   *  外部代码必须经句柄销毁，不提供按 id 的公开入口。幂等。
   *  Phase 4：顺序铁律保持不变 —— bus/board flush → saveState('done') →
   *  context 逆序 effects（runtime maps 注销 → lifecycle timer → board/bus
   *  条目注销）。effects 全 sync 链经 DisposerBag 同步快通道在返回前完成，
   *  listAgents / bus 注册状态调用后立即可观测；聚合错误经 log.warn 可观测。 */
  _disposeAgent(id: string): void {
    const handle = this.agents.get(id);
    if (!handle) return;
    // 获取此 Agent 的会话级 board（effects 释放 maps 前完成查找）
    const sessionId = this._agentSessions.get(id) ?? 'default';
    const taskBoard = this._taskBoards.get(sessionId);
    const discoveryBoard = this._discoveryBoards.get(sessionId);
    // Flush 持久化 — 在清理前落盘
    this._bus.clearFlushTimer();
    taskBoard?.clearFlushTimer();
    discoveryBoard?.clearFlushTimer();
    void this._bus.flush();
    void taskBoard?.flush();
    void discoveryBoard?.flush();
    handle
      ._getAgent()
      .saveState('done')
      .catch(() => {});
    // 分散清理已统一归 ctx 所有权（装配期 effect 登记），此处只释放 context
    handle
      ._getContext()
      ?.dispose()
      .catch((err) => log.warn('runtime', `agent ${id} context 清理部分失败: ${String(err)}`));
    log.info('runtime', `agent destroyed: ${id}`);
  }

  /** 销毁所有 Agent — Workspace 整体停用时调用 */
  disposeAll(): void {
    for (const id of [...this.agents.keys()]) {
      this._disposeAgent(id);
    }
  }

  listAgents(): AgentSummary[] {
    return Array.from(this.agents.values()).map((h) => ({
      id: h.id,
      parentId: h.parentId,
      status: h.status,
      // 会话主 Agent 的 id 是 main-<ts>-<rand>（不再硬编码 'main'），按 parentId 判定
      description: h.parentId === null ? '主Agent' : `Agent (${h.id})`,
      subagentDepth: h._getAgent().subagentDepth,
    }));
  }

  /** E6: 同步刷新所有会话级 board（best-effort）。
   *  在 beforeunload 时调用以防止标签页/窗口关闭时数据丢失。
   *  清除防抖定时器（同步）并触发 flush()（异步，可能未完成）。 */
  /** 刷新所有会话级 board + 消息总线。等待每个 flush 完成以确保
   *  主清理路径（deactivate）上的调用方在销毁 runtime 前数据已持久化。
   *  使用 allSettled 以防一个 board 失败阻塞其他 board。 */
  async flushAllBoards(): Promise<void> {
    const flushes: Promise<unknown>[] = [];
    for (const board of this._taskBoards.values()) {
      board.clearFlushTimer();
      flushes.push(board.flush());
    }
    for (const board of this._discoveryBoards.values()) {
      board.clearFlushTimer();
      flushes.push(board.flush());
    }
    this._bus.clearFlushTimer();
    flushes.push(this._bus.flush());
    await Promise.allSettled(flushes);
  }

  // ── 私有：将 RuntimeNotifier 包装为 AgentUINotifier ──

  private _wrapNotifier(agentId: string): AgentUINotifier {
    return {
      progress: (step: number, toolName: string) => {
        this.notifier?.onProgress(agentId, step, toolName);
      },
      toolDone: (toolName: string, args: Record<string, unknown>, output: string) => {
        this.notifier?.onToolDone(agentId, toolName, args, output);
      },
      subAgentSpawn: (info, onProgress) => {
        return this.notifier?.onSubAgentSpawn({
          agentId: info.agentId,
          parentAgentId: agentId,
          description: info.description,
          sessionId: info.sessionId,
          onProgress,
        });
      },
      subAgentFinished: (id, sessionId, ok) => {
        this.notifier?.onSubAgentFinished(id, agentId, sessionId, ok);
      },
      onStatusChange: (running: boolean) => {
        this.notifier?.onAgentStatus(agentId, running ? 'running' : 'idle');
      },
      sessionReplaced: (messages: Message[]) => {
        this.notifier?.onSessionReplaced(agentId, messages);
      },
    };
  }

  // ── 私有：诊断数据源 ──
  // 由 setDiagnosticsSource() 注入 — agent-builder 无法 import ui/lsp-client
  private _diagSource: DiagnosticsSource | null = null;

  setDiagnosticsSource(fn: DiagnosticsSource): void {
    this._diagSource = fn;
  }
}
