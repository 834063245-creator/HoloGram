// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Session store — session lifecycle.
// Messages live in per-session stores: getMessagesStore(`${storeId}:${sessionId}`)

import { create } from 'zustand';

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

// ── Per-panel registry ──

// ponytail: store Map on window so Vite HMR doesn't wipe it (module-level
// variables are re-initialized on hot reload, breaking React subscriptions).
const SESSION_STORES_KEY = '__hologram_session_stores__';
const DEFAULT_ID = '__default__';

function _storesMap(): Map<string, SessionStoreApi> {
  const w = window as any;
  if (!w[SESSION_STORES_KEY]) {
    const m = new Map<string, SessionStoreApi>();
    m.set(DEFAULT_ID, createSessionStoreImpl());
    w[SESSION_STORES_KEY] = m;
  }
  return w[SESSION_STORES_KEY] as Map<string, SessionStoreApi>;
}

export function getSessionStore(storeId?: string): SessionStoreApi {
  const id = storeId || DEFAULT_ID;
  const stores = _storesMap();
  let s = stores.get(id);
  if (!s) {
    s = createSessionStoreImpl();
    stores.set(id, s);
  }
  return s;
}

/** Remove a panel's session store from the registry. */
export function disposeSessionStore(storeId: string): void {
  _storesMap().delete(storeId);
}

// ── Non-reactive accessors ──

function _store(storeId?: string) {
  return getSessionStore(storeId).getState();
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
