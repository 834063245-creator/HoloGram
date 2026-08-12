// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// AuraSDK TypeScript bindings — SDR semantic recall via Tauri FFI bridge.
// Underlying engine: aura.dll (https://github.com/teolex2020/AuraSDK, MIT)

import { typedRpc } from '../rpc-contract';

// ── Types ──

export interface AuraRecord {
  id: string;
  content: string;
  score: number;
  level: string; // Working | Decisions | Domain | Identity
  strength: number;
  tags: string[];
  created_at: string;
  source_type: string;
}

// ── API ──

/** Initialize the Aura brain. Call once at app startup. */
export async function auraInit(brainPath: string): Promise<{ status: string; path: string; record_count: number }> {
  const raw = await typedRpc('aura_init', { brain_path: brainPath });
  return JSON.parse(raw);
}

/** Recall relevant memories as structured JSON. */
export async function auraRecall(query: string, topK: number = 20): Promise<AuraRecord[]> {
  const raw = await typedRpc('aura_recall', { query, top_k: topK });
  return JSON.parse(raw || '[]');
}

/** Recall as a formatted text block (for LLM prompt injection). */
export async function auraRecallText(query: string, tokenBudget: number = 0): Promise<string> {
  return await typedRpc('aura_recall_text', { query, token_budget: tokenBudget });
}

/** Store a memory. Returns the record ID. */
export async function auraStore(
  content: string,
  level: number = 0,
  tags: string[] = [],
  namespace: string = '',
): Promise<string> {
  return await typedRpc('aura_store', {
    content,
    level,
    tags: tags.length > 0 ? JSON.stringify(tags) : '',
    namespace,
  });
}

/** Get record count. */
export async function auraCount(): Promise<number> {
  return Number(await typedRpc('aura_count', {}));
}

/** Run a maintenance cycle. */
export async function auraMaintenance(): Promise<void> {
  await typedRpc('aura_maintenance', {});
}

/** Shut down and flush. Call on app exit. */
export async function auraShutdown(): Promise<void> {
  await typedRpc('aura_shutdown', {});
}
