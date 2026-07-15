// Memory Bundle HTTP client — calls the Dockerized FirstBeat memory service.
// If the service is unreachable, all methods degrade gracefully (return null/empty).

const BASE_URL = 'http://127.0.0.1:9600';
const TIMEOUT_MS = 5000;

// ── Types ──

export interface EmotionResult {
  valence: number;
  arousal: number;
  category: string;
}

export interface IntentResult {
  label: string;
  confidence: number;
}

export interface RelationshipResult {
  trust: number;
  closeness: number;
  familiarity: number;
}

export interface AnalyzeResult {
  embedding_dim: number;
  emotion?: EmotionResult;
  intent?: IntentResult;
  entities?: string[];
  tags?: string[];
  relationship?: RelationshipResult;
  engagement?: number;
  field_direction_norm?: number;
}

export interface FactRecord {
  id: string;
  content: string;
  score: number;
}

export interface RecallResult {
  query: string;
  embedding_dim: number;
  facts?: FactRecord[];
  facts_text?: string;
  residuals?: Record<string, number>;
  rerank_reference?: boolean;
}

export interface PortraitResult {
  emotion?: EmotionResult;
  relationship?: RelationshipResult;
  intent?: string;
  engagement?: number;
  turn_count?: number;
}

// ── HTTP helpers ──

async function fetchJson<T>(path: string, body?: unknown): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ──

/** Check if the memory bundle service is alive. */
export async function memoryBundleHealth(): Promise<boolean> {
  const result = await fetchJson<{ status: string }>('/health');
  return result?.status === 'ok';
}

/** Analyze a single message: extract emotion, intent, entities, tags, relationship. */
export async function memoryBundleAnalyze(
  text: string,
  userId: string = 'default',
  sessionId: string = '',
): Promise<AnalyzeResult | null> {
  return await fetchJson<AnalyzeResult>('/analyze', { text, user_id: userId, session_id: sessionId });
}

/** Recall facts and memory field residuals for a query. */
export async function memoryBundleRecall(
  query: string,
  topK: number = 10,
  includeText: boolean = false,
): Promise<RecallResult | null> {
  return await fetchJson<RecallResult>('/recall', { query, top_k: topK, include_text: includeText });
}

/** Ingest a complete session (array of {role, content} messages). */
export async function memoryBundleIngest(
  messages: Array<{ role: string; content: string }>,
  userId: string = 'default',
  sessionId: string = '',
): Promise<boolean> {
  const result = await fetchJson<{ status: string }>('/ingest', {
    messages,
    user_id: userId,
    session_id: sessionId,
  });
  return result?.status === 'ok';
}

/** Get current user portrait. */
export async function memoryBundlePortrait(): Promise<PortraitResult | null> {
  return await fetchJson<PortraitResult>('/portrait');
}
