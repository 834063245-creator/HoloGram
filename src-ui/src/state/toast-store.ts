// state/toast-store.ts — 全局瞬时提示通道（2026-08-31 贴黄拆迁）。
//
// 贴黄（notice 消息）收窄为「会话事件」后，系统反馈改走三层：
//   toast（本 store）   — 瞬时操作结果/错误，说完即走，绝不入会话流
//   就地（组件内联）      — 守卫提示，挂在动作发生处
//   回合附着（turn-error 块）— 回合错误，贴着回合走
// 本 store 是全局单例：toast 是瞬时 UI 元素，不承载跨工作区数据归属，
// 也不参与会话持久化（崩溃/切区残留会自行消隐）。
//
// 克制纪律（2026-08-31 拍板）：
//   - 操作成功默认不弹（界面状态变化即反馈）——调用方不应为成功播报
//   - 同文本 4 秒内不重复弹（goals/双通道去重——幂等）
//   - error 级长显（holdMs 6000，信息要读完）；info/warn 默认 3200

import { create } from 'zustand';
import * as Obs from '../agent/obs';

export type ToastLevel = 'info' | 'warn' | 'error';

export interface ToastItem {
  id: number;
  text: string;
  level: ToastLevel;
  /** 全透明停留时长（毫秒），过后淡出。 */
  holdMs: number;
}

interface ToastState {
  toasts: ToastItem[];
  showToast: (text: string, level?: ToastLevel, holdMs?: number) => void;
  dismissToast: (id: number) => void;
}

/** 默认停留：3.2s hold + 0.26s 淡出（与 CSS `.pp-toast` 收尾段一致——§15 `--m-sheet`）。 */
export const TOAST_HOLD_MS = 3200;
/** 数据风险/长文：加倍停留。 */
export const TOAST_LONG_HOLD_MS = 6400;
/** 淡出时长（= CSS `.pp-toast` 的 `--m-sheet` 段；两处镜像由 tests/motion-contract.test.ts 钉死）。 */
export const TOAST_FADE_MS = 260;
/** 同文去重窗口：4 秒。 */
const TOAST_DEDUP_MS = 4000;

let toastSeq = 0;
const _recentToasts = new Map<string, number>();

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  showToast: (text, level = 'info', holdMs = TOAST_HOLD_MS) => {
    // 同文去重（按 level 与文本）：窗口内跳过——goals 双通道/重复触发不叠加
    const now = Date.now();
    const key = `${level}:${text}`;
    const last = _recentToasts.get(key);
    if (last != null && now - last < TOAST_DEDUP_MS) return;
    _recentToasts.set(key, now);
    if (_recentToasts.size > 64) {
      for (const [k, ts] of _recentToasts) {
        if (now - ts >= TOAST_DEDUP_MS) _recentToasts.delete(k);
      }
    }
    const id = ++toastSeq;
    // ⚡ 日志可观测性批 1（2026-09-27）：error 级 toast = **用户看见了一次失败**，
    //   落一条 `ui.toast`（漏斗的兜底面——墓碑之外的第二条呈现路径）。
    //   位置在去重闸**之后**：没弹出来的不记（日志要如实反映用户所见，不是调用次数）。
    if (level === 'error') Obs.toast({ text, level });
    // 最多同屏 3 条——满则弃最旧
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, level, holdMs }] }));
    setTimeout(() => get().dismissToast(id), holdMs + TOAST_FADE_MS);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** 便捷导出：非组件代码（chat-core / chat-session / chat-stream）触发提示。 */
export function showToast(text: string, level: ToastLevel = 'info', holdMs = TOAST_HOLD_MS): void {
  useToastStore.getState().showToast(text, level, holdMs);
}
