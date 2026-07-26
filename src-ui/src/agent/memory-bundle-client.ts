// Memory Bundle HTTP client — calls the Dockerized FirstBeat memory service.
// If the service is unreachable, all methods degrade gracefully (return null/empty).
//
// NOTE: Currently only memoryBundleIngest() is wired into workspace.ts/runtime.ts.
// The other exported functions (health/analyze/recall/portrait) are NOT yet
// integrated — do not call them from agent logic without first wiring them up.

const BASE_URL = 'http://127.0.0.1:9600';
const TIMEOUT_MS = 5000;

// ── Types ──
// These types are only used by the un-integrated APIs below.
// They will become public once the corresponding functions are wired up.

interface EmotionResult {
  valence: number;
  arousal: number;
  category: string;
}

interface IntentResult {
  label: string;
  confidence: number;
}

interface RelationshipResult {
  trust: number;
  closeness: number;
  familiarity: number;
}

interface AnalyzeResult {
  embedding_dim: number;
  emotion?: EmotionResult;
  intent?: IntentResult;
  entities?: string[];
  tags?: string[];
  relationship?: RelationshipResult;
  engagement?: number;
  field_direction_norm?: number;
}

interface FactRecord {
  id: string;
  content: string;
  score: number;
}

interface RecallResult {
  query: string;
  embedding_dim: number;
  facts?: FactRecord[];
  facts_text?: string;
  residuals?: Record<string, number>;
  rerank_reference?: boolean;
}

interface PortraitResult {
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

// ── Un-integrated API (NOT yet wired into agent logic) ──

/** Check if the memory bundle service is alive. */
async function memoryBundleHealth(): Promise<boolean> {
  const result = await fetchJson<{ status: string }>('/health');
  return result?.status === 'ok';
}

/** Analyze a single message: extract emotion, intent, entities, tags, relationship. */
async function memoryBundleAnalyze(
  text: string,
  userId: string = 'default',
  sessionId: string = '',
): Promise<AnalyzeResult | null> {
  return await fetchJson<AnalyzeResult>('/analyze', { text, user_id: userId, session_id: sessionId });
}

/** Recall facts and memory field residuals for a query. */
async function memoryBundleRecall(
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
async function memoryBundlePortrait(): Promise<PortraitResult | null> {
  return await fetchJson<PortraitResult>('/portrait');
}
