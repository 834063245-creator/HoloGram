// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat store — 4 个领域 store 的轻量注册表。
//
//   msg   → messages-store.ts  — 会话级消息、流式标志
//   sess  → session-store.ts   — sessions[]、activeIdx、token、nextId
//   panel → panel-store.ts     — panelMode、toolSchemas、focus
//   input → input-store.ts     — inputText、attachedFiles、inputHistory
//
// 每个都是真实的 Zustand store。getState() 返回实时内部状态。

import { disposeInputStore, getInputStore, type InputStoreApi } from './input-store';
import {
  getExpandedReasoningSet as _msg_expandedReasoning,
  getUserScrolledUp as _msg_scrolledUp,
  getStreamingAssistantId as _msg_streamingId,
  bumpMessages,
  disposeMessagesStores,
  getMessagesStore,
  type MessagesStoreApi,
} from './messages-store';
import { disposePanelStore, getPanelStore, type PanelStoreApi } from './panel-store';
import { disposeSessionStore, getSessionStore, nextMsgId, type SessionStoreApi } from './session-store';

// ── ChatStore 句柄 — 直接访问子 store ──

export interface ChatStoreHandles {
  msg: MessagesStoreApi;
  sess: SessionStoreApi;
  panel: PanelStoreApi;
  input: InputStoreApi;
}

/** 返回指定面板的 4 个领域 store。 */
export function getChatStore(storeId?: string): ChatStoreHandles {
  const id = storeId || '__default__';
  return {
    msg: getMessagesStore(id),
    sess: getSessionStore(id),
    panel: getPanelStore(id),
    input: getInputStore(id),
  };
}

// ── 会话级消息 store ──
// ponytail: 每个会话拥有独立的 messages-store 实例。
// 这是会话消息的唯一数据源 — 无面板级数组，
// 无 sessionMessageModels 缓存，无手动同步。

/** 特定会话的消息 store（非面板级）。 */
export function msgStoreFor(storeId: string, sessionId: number): MessagesStoreApi {
  return getMessagesStore(`${storeId}:${sessionId}`);
}

/** 活跃会话的消息 store。无活跃会话时返回 null。 */
export function msgStoreForActive(storeId: string): MessagesStoreApi | null {
  const sess = getSessionStore(storeId).getState();
  const sid = sess.sessions[sess.activeIdx]?.id;
  if (sid == null) return null;
  return msgStoreFor(storeId, sid);
}

/** 递增特定会话消息 store 的版本号。 */
export function bumpSession(storeId: string, sessionId: number): void {
  getMessagesStore(`${storeId}:${sessionId}`).getState().bump();
}

// ── 面板级流式标志（从默认 msg store 读取，后续迁移到会话级）──

export function bumpChat(storeId?: string): void {
  bumpMessages(storeId);
}

// 流式
export function getStreamingAssistantId(storeId?: string) {
  return _msg_streamingId(storeId);
}
export function getUserScrolledUp(storeId?: string) {
  return _msg_scrolledUp(storeId);
}
export function getExpandedReasoningSet(storeId?: string) {
  return _msg_expandedReasoning(storeId);
}

// ── 面板销毁 — 面板关闭时调用以防止内存泄漏 ──

/** 销毁与面板关联的所有 store（messages、session、panel、input）。
 *  同时移除会话级消息 store（panelId:sessionId）。
 *  2026-08-04 复核：生产暂未接线，但有单元测试保护，保留。 */
export function disposePanelStores(storeId: string): void {
  disposeMessagesStores(storeId);
  disposeSessionStore(storeId);
  disposePanelStore(storeId);
  disposeInputStore(storeId);
}
