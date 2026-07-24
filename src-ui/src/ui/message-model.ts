// ── Message model — data-driven chat rendering
// Replaces the old "one currentBubble + appendChild" pattern with
// a flat message array. Each message is an immutable-like record;
// streaming updates replace the array entry, the renderer diffs.
//
// Inspired by Claude Code (messages/*.tsx) and Hermes (@assistant-ui).

// ── Types ────────────────────────────────────────────────

export type MessageId = string;

// ⚡ _idSeq → chat-store.ts
import { getChatStore } from './chat-store';

export function nextMsgId(storeId?: string): MessageId {
  const store = getChatStore(storeId).sess.getState();
  const id = store.msgIdSeq + 1;
  getChatStore(storeId).sess.setState({ msgIdSeq: id });
  return `m${id}`;
}

/** Resets the message id counter for a given store.
 *  NOTE: This is now a no-op to prevent cross-session ID collisions.
 *  The counter monotonically increases, ensuring globally unique IDs.
 *  Previously, resetting caused new sessions to restart from m1,
 *  colliding with existing sessions and misrouting streaming events. */
export function resetMsgIdCounter(_storeId?: string): void {
  // Intentionally empty — see note above.
}

// ── Attachments ──────────────────────────────────────────

export interface FileAttachment {
  path: string;
  name: string;
  size: number;
}

// ── Message parts (assistant) ────────────────────────────

export type ToolStatus = 'pending' | 'running' | 'done' | 'error';

export interface ReasonPart {
  type: 'reasoning';
  text: string;
}

export interface TextPart {
  type: 'text';
  text: string;
  /** When true, this text has been finalised (no more streaming append). */
  finalised: boolean;
}

export interface ToolCallPart {
  type: 'tool';
  toolId: string;
  name: string;
  args: string;
  /** User-facing label, e.g. "Read file" or "Search code". */
  label: string;
  readOnly: boolean;
  status: ToolStatus;
  /** Accumulated output while the tool is running. */
  output?: string;
  /** Error message when tool fails. */
  err?: string;
  /** True when the backend truncated the output. */
  truncated?: boolean;
}

/** Sub-agent nested block — rendered as a collapsible group inside an assistant message. */
export interface SubAgentPart {
  type: 'subagent';
  agentId: string;
  description: string;
  status: 'running' | 'done' | 'error';
  /** Ordered parts produced by this sub-agent. */
  parts: AssistantPart[];
  /** Incremented on every mutation so React can subscribe without a global bump. */
  version: number;
}

export type AssistantPart = ReasonPart | TextPart | ToolCallPart | SubAgentPart;

// ── Messages ─────────────────────────────────────────────

export interface UserMessage {
  role: 'user';
  _id: MessageId;
  text: string;
  files?: FileAttachment[];
  /** Index into the agent session array at send time (for retract). */
  sessionIndex: number;
}

export interface AssistantMessage {
  role: 'assistant';
  _id: MessageId;
  /** Ordered parts — tool calls are interleaved between reasoning/text. */
  parts: AssistantPart[];
  /** Overall status of this assistant turn. */
  status: 'streaming' | 'done' | 'error';
  /** The user turn this assistant is responding to. */
  respondingTo: MessageId;
  /** Total tokens consumed this turn (accumulated across steps). */
  tokensUsed?: number;
  /** Error message when status is 'error'. */
  errorMessage?: string;
}

export interface NoticeMessage {
  role: 'notice';
  _id: MessageId;
  text: string;
  level: 'info' | 'warn' | 'error';
}

export type ChatMessage = UserMessage | AssistantMessage | NoticeMessage;

// ── Helpers ──────────────────────────────────────────────

/** Create a new user message. */
export function createUserMessage(text: string, files?: FileAttachment[], sessionIndex?: number): UserMessage {
  return {
    role: 'user',
    _id: nextMsgId(),
    text,
    files: files?.length ? files : undefined,
    sessionIndex: sessionIndex ?? -1,
  };
}

/** Create a new streaming assistant message. */
export function createAssistantMessage(respondingTo: MessageId): AssistantMessage {
  return {
    role: 'assistant',
    _id: nextMsgId(),
    parts: [],
    status: 'streaming',
    respondingTo,
  };
}

/** Create a notice message (info/warn/error banners). */
export function createNoticeMessage(text: string, level: NoticeMessage['level'] = 'info'): NoticeMessage {
  return { role: 'notice', _id: nextMsgId(), text, level };
}

/** Get the last text part (if any) for streaming append. */
export function lastTextPart(parts: AssistantPart[]): TextPart | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'text') return parts[i] as TextPart;
  }
  return undefined;
}

/** Find the last reasoning part in a parts array. */
export function lastReasoningPart(parts: AssistantPart[]): ReasonPart | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'reasoning') return parts[i] as ReasonPart;
  }
  return undefined;
}

/** Find a tool part by toolId. */
export function findToolPart(parts: AssistantPart[], toolId: string): ToolCallPart | undefined {
  return parts.find((p): p is ToolCallPart => p.type === 'tool' && p.toolId === toolId);
}
