// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话存储 — 会话生命周期。
// 消息存于每会话 store：getMessagesStore(`${storeId}:${sessionId}`)

import { create } from 'zustand';
import { createScopedStore } from './scoped-store';

export interface ChatSessionMeta {
  id: number;
  label: string;
}

interface SessionStore {
  sessions: ChatSessionMeta[];
  activeIdx: number;
  sessionTokens: Record<number, number>;
  nextSessionId: number;
  msgIdSeq: number;

  setSessions: (sessions: ChatSessionMeta[]) => void;
  setActiveIdx: (idx: number) => void;
  setSessionTokens: (id: number, count: number) => void;
  removeSession: (id: number) => void;
  setNextSessionId: (id: number) => void;
  setMsgIdSeq: (seq: number) => void;
}

export type SessionStoreApi = ReturnType<typeof createSessionStoreImpl>;

function createSessionStoreImpl() {
  return create<SessionStore>((set) => ({
    sessions: [],
    activeIdx: -1,
    sessionTokens: {},
    nextSessionId: 1,
    msgIdSeq: 0,

    setSessions: (sessions) => set({ sessions }),
    setActiveIdx: (activeIdx) => set({ activeIdx }),
    setSessionTokens: (id, count) => set((s) => ({ sessionTokens: { ...s.sessionTokens, [id]: count } })),
    removeSession: (id) =>
      set((s) => {
        const { [id]: _, ...restTokens } = s.sessionTokens;
        return { sessionTokens: restTokens };
      }),
    setNextSessionId: (nextSessionId) => set({ nextSessionId }),
    setMsgIdSeq: (msgIdSeq) => set({ msgIdSeq }),
  }));
}

// ── 每面板注册表 ──

const scoped = createScopedStore('__hologram_session_stores__', createSessionStoreImpl);

export const getSessionStore = scoped.getStore;

/** 从注册表中移除面板的会话 store。 */
export function disposeSessionStore(storeId: string): void {
  scoped.disposeStore(storeId);
}

// ── 非响应式访问器 ──

function _store(storeId?: string) {
  return scoped.getState(storeId);
}

export function getSessions(storeId?: string): ChatSessionMeta[] {
  return _store(storeId).sessions;
}
export function getActiveIdx(storeId?: string): number {
  return _store(storeId).activeIdx;
}
export function getActiveSessionId(storeId?: string): number | null {
  const { sessions, activeIdx } = _store(storeId);
  return sessions[activeIdx]?.id ?? null;
}
export function getSessionTokens(storeId?: string): Record<number, number> {
  return _store(storeId).sessionTokens;
}
export function getNextSessionId(storeId?: string): number {
  return _store(storeId).nextSessionId;
}
export function getMsgIdSeq(storeId?: string): number {
  return _store(storeId).msgIdSeq;
}

export function nextMsgId(storeId?: string): string {
  const store = getSessionStore(storeId);
  const st = store.getState();
  const id = st.msgIdSeq + 1;
  store.setState({ msgIdSeq: id });
  return `m${id}`;
}
