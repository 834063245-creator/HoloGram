// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ExecutionState — 统一运行状态管理
//
// 收拢原本散落在 chat.ts / agent.ts / coordinator.ts / permission.ts 中的状态：
//   running / abortCtrl / _permCardCount / _permQueue / sessionGen / compactRunning / pendingCards
//
// 设计原则：
//   1. 单点写入 — 所有状态变更走 ExecutionState 方法，不直接改字段
//   2. 自动通知 — 任何状态变更自动触发 onChange 回调
//   3. 无框架依赖 — 纯 TypeScript，不依赖 React/Vue/任何 UI 框架
//   4. 可测试 — 类可独立实例化，不依赖 DOM 或 Tauri bridge

// ── Types ──

export type StateChangeListener = () => void;

/** Minimal sub-agent status — avoids importing coordinator.ts (prevents circular dep) */
export type SubAgentStatus = 'Running' | 'Completed' | 'Failed' | 'Stopped';

/** Minimal sub-agent handle — mirrors coordinator.ts SubAgentHandle without importing it */
export interface SubAgentHandle {
  id: string;
  description: string;
  status: SubAgentStatus;
  startedAt: number;
  result?: string;
  error?: string;
}

/** Minimal permission card entry — mirrors permission.ts pendingCards */
interface PermCard {
  resolve: (r: { allow: boolean; remember: boolean }) => void;
  cleanup: () => void;
}

/** Internal sub-agent tracking entry */
interface SubAgentEntry {
  handle: SubAgentHandle;
  abortController: AbortController;
}

// ── ExecutionState ──

export class ExecutionState {
  // ---- Core ----
  private _mainRunning = false;
  private _abortController: AbortController | null = null;
  private _sessionVersion = 0;

  // ---- Permission queue ----
  private _permQueue: Promise<void> = Promise.resolve();
  private _permCardCount = 0;
  private _permCards: PermCard[] = [];

  // ---- Sub-agents ----
  private _subAgents = new Map<string, SubAgentEntry>();
  private _subCompleted: SubAgentHandle[] = [];
  private static readonly MAX_COMPLETED = 20;

  // ---- Subscribers ----
  private _listeners = new Set<StateChangeListener>();

  // ═══════════════════════════════════════
  // 只读属性
  // ═══════════════════════════════════════

  /** 是否有任何 Agent（主/子）或权限卡片在工作 */
  get isBusy(): boolean {
    return this._mainRunning || this._subAgents.size > 0 || this._permCardCount > 0;
  }

  /** 主 Agent 是否在运行（不含子Agent） */
  get isRunning(): boolean { return this._mainRunning; }

  /** 当前中止信号，供 Agent 循环和子Agent 使用 */
  get abortSignal(): AbortSignal | undefined { return this._abortController?.signal; }

  /** 会话版本号 — 每次 session 替换递增。只用于版本比对，不兼做中止信号 */
  get sessionVersion(): number { return this._sessionVersion; }

  /** 当前待处理的权限卡片数 */
  get permCardCount(): number { return this._permCardCount; }

  /** 运行中的子Agent 数量 */
  get subAgentCount(): number { return this._subAgents.size; }

  // ═══════════════════════════════════════
  // 主 Agent 生命周期
  // ═══════════════════════════════════════

  /** 开始一轮主 Agent 执行。返回 AbortSignal 传给 Agent.run() */
  start(): AbortSignal {
    // 确保上一轮已清理
    this._abortController?.abort();
    this._abortController = new AbortController();
    this._mainRunning = true;
    this._notify();
    return this._abortController.signal;
  }

  /** 主 Agent 正常完成（非中止） */
  done(): void {
    this._mainRunning = false;
    this._abortController = null;
    this._notify();
  }

  /** 用户主动停止：中止主Agent + 级联中止所有子Agent + 清空权限队列 */
  stop(): void {
    // 1. 中止主 Agent
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    // 2. 级联中止所有子Agent — 每个都有独立的 AbortController
    for (const [id, entry] of this._subAgents) {
      entry.abortController.abort();
      entry.handle.status = 'Stopped' as any;
      entry.handle.error = 'stopped by user';
      this._addCompleted(entry.handle);
    }
    this._subAgents.clear();

    // 3. 清空权限队列 — 修复 R5（之前 cancelPendingApprovals 只清 DOM 不清队列）
    this._cancelAllPermissions();
    this._permQueue = Promise.resolve();
    this._permCardCount = 0;

    // 4. 复位
    this._mainRunning = false;
    this._notify();
  }

  /** 强制复位 — 安全超时用。比 stop() 更粗暴，不管正在进行的操作 */
  forceReset(): void {
    this._abortController?.abort();
    this._abortController = null;
    this._mainRunning = false;
    // 不清子Agent — 它们已经脱离控制，等自然超时
    this._cancelAllPermissions();
    this._permQueue = Promise.resolve();
    this._permCardCount = 0;
    this._notify();
  }

  // ═══════════════════════════════════════
  // 会话版本号
  // ═══════════════════════════════════════

  /** 递增并返回新版本号。每次 session 替换时调用 */
  bumpVersion(): number {
    return ++this._sessionVersion;
  }

  // ═══════════════════════════════════════
  // 权限队列 — 修复 R5
  // ═══════════════════════════════════════

  /** 注册一个权限卡片的 DOM 清理回调（替代 permission.ts registerPendingCard） */
  registerPermCard(resolve: (r: { allow: boolean; remember: boolean }) => void, cleanup: () => void): void {
    this._permCards.push({ resolve, cleanup });
  }

  /** 将权限请求串行化到队列中，防止卡片堆叠闪烁 */
  enqueuePerm<T>(fn: () => Promise<T>): Promise<T> {
    this._permCardCount++;
    this._notify();

    const prev = this._permQueue;
    const result = prev.then(() => fn());

    // promise settled 后减计数，但不断链
    result.finally(() => {
      this._permCardCount = Math.max(0, this._permCardCount - 1);
      this._notify();
    });

    // 维持队列链：即使单个请求 reject，后续请求仍能继续
    this._permQueue = result.catch(() => {}).then(() => {});
    return result;
  }

  /** 清空权限队列并重置 — 调用方负责已渲染 DOM 的清理 */
  resetPermQueue(): void {
    this._cancelAllPermissions();
    this._permQueue = Promise.resolve();
    this._permCardCount = 0;
    this._notify();
  }

  private _cancelAllPermissions(): void {
    while (this._permCards.length > 0) {
      const p = this._permCards.pop()!;
      p.cleanup();
      p.resolve({ allow: false, remember: false });
    }
  }

  // ═══════════════════════════════════════
  // 子Agent 管理
  // ═══════════════════════════════════════

  /** 注册一个子Agent。返回专属 AbortController — 父Agent 停止时自动 abort */
  registerSubAgent(id: string, handle: SubAgentHandle): AbortController {
    const ac = new AbortController();
    this._subAgents.set(id, { handle, abortController: ac });
    this._notify();
    return ac;
  }

  /** 子Agent 完成（成功或失败） */
  subAgentDone(id: string, status: 'Completed' | 'Failed' | 'Stopped', result?: string, error?: string): void {
    const entry = this._subAgents.get(id);
    if (!entry) return;
    entry.handle.status = status as any;
    if (result !== undefined) entry.handle.result = result;
    if (error !== undefined) entry.handle.error = error;
    this._addCompleted(entry.handle);
    this._subAgents.delete(id);
    this._notify();
  }

  /** 停止单个子Agent */
  stopSubAgent(id: string): boolean {
    const entry = this._subAgents.get(id);
    if (!entry) return false;
    entry.abortController.abort();
    entry.handle.status = 'Stopped' as any;
    entry.handle.error = 'stopped by user';
    this._addCompleted(entry.handle);
    this._subAgents.delete(id);
    this._notify();
    return true;
  }

  /** 取出已完成列表（消费后清空） */
  pollCompleted(): SubAgentHandle[] {
    const results = [...this._subCompleted];
    this._subCompleted = [];
    return results;
  }

  private _addCompleted(handle: SubAgentHandle): void {
    this._subCompleted.push(handle);
    if (this._subCompleted.length > ExecutionState.MAX_COMPLETED) {
      this._subCompleted = this._subCompleted.slice(-ExecutionState.MAX_COMPLETED);
    }
  }

  // ═══════════════════════════════════════
  // 订阅
  // ═══════════════════════════════════════

  /** 注册状态变更回调。返回取消订阅函数 */
  onChange(fn: StateChangeListener): () => void {
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  private _notify(): void {
    for (const fn of this._listeners) {
      try { fn(); } catch { /* 单个 listener 崩溃不影响其他 */ }
    }
  }
}

// ── 全局单例 — 当前系统只有一个根 Agent，单例足够 ──

export const execState = new ExecutionState();
