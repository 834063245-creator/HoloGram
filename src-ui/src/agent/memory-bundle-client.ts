// Memory Bundle HTTP 客户端 — 调用 Dockerized FirstBeat 记忆服务。
// 如果服务不可达，所有方法优雅降级（返回 null/空值）。
//
// 注意：目前仅 memoryBundleIngest() 已接入 workspace.ts/runtime.ts。
// 其他导出函数（health/analyze/recall/portrait）尚未集成 —
// 未接入前不要从 agent 逻辑中调用。

const BASE_URL = 'http://127.0.0.1:9600';
const TIMEOUT_MS = 5000;

// ── 类型 ──
// 这些类型仅被下方未集成的 API 使用。
// 对应函数接入后将变为公开。

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

// ── HTTP 辅助函数 ──

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

// ── 未集成 API（尚未接入 agent 逻辑）──

/** 检查记忆 bundle 服务是否存活。 */
async function memoryBundleHealth(): Promise<boolean> {
  const result = await fetchJson<{ status: string }>('/health');
  return result?.status === 'ok';
}

/** 分析单条消息：提取情感、意图、实体、标签、关系。 */
async function memoryBundleAnalyze(
  text: string,
  userId: string = 'default',
  sessionId: string = '',
): Promise<AnalyzeResult | null> {
  return await fetchJson<AnalyzeResult>('/analyze', { text, user_id: userId, session_id: sessionId });
}

/** 为查询召回事实和记忆场残差。 */
async function memoryBundleRecall(
  query: string,
  topK: number = 10,
  includeText: boolean = false,
): Promise<RecallResult | null> {
  return await fetchJson<RecallResult>('/recall', { query, top_k: topK, include_text: includeText });
}

/** 摄入完整会话（{role, content} 消息数组）。 */
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

/** 获取当前用户画像。 */
async function memoryBundlePortrait(): Promise<PortraitResult | null> {
  return await fetchJson<PortraitResult>('/portrait');
}
