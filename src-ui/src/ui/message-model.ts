// ── Message model — data-driven chat rendering
// Replaces the old "one currentBubble + appendChild" pattern with
// a flat message array. Each message is an immutable-like record;
// streaming updates replace the array entry, the renderer diffs.
//
// Inspired by Claude Code (messages/*.tsx) and Hermes (@assistant-ui).

// ── Types ────────────────────────────────────────────────

export type MessageId = string;

let _idSeq = 0;
export function nextMsgId(): MessageId {
  return `m${++_idSeq}`;
}

/** Resets the global message id counter (for test isolation or /clear). */
export function resetMsgIdCounter(): void {
  _idSeq = 0;
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

export type AssistantPart = ReasonPart | TextPart | ToolCallPart;

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

export interface PermissionMessage {
  role: 'perm';
  _id: MessageId;
  toolName: string;
  reason: string;
  subject: string;
  resolve: (result: { allow: boolean; remember: boolean }) => void;
}

export type ChatMessage = UserMessage | AssistantMessage | NoticeMessage | PermissionMessage;

// ── Helpers ──────────────────────────────────────────────

/** Create a new user message. */
export function createUserMessage(
  text: string,
  files?: FileAttachment[],
  sessionIndex?: number,
): UserMessage {
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
export function createNoticeMessage(
  text: string,
  level: NoticeMessage['level'] = 'info',
): NoticeMessage {
  return { role: 'notice', _id: nextMsgId(), text, level };
}

/** Create a permission request message. */
export function createPermissionMessage(
  toolName: string,
  reason: string,
  subject: string,
  resolve: (result: { allow: boolean; remember: boolean }) => void,
): PermissionMessage {
  return { role: 'perm', _id: nextMsgId(), toolName, reason, subject, resolve };
}

/** Get the last text part (if any) for streaming append. */
export function lastTextPart(parts: AssistantPart[]): TextPart | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'text') return parts[i] as TextPart;
  }
  return undefined;
}

/** Find a tool part by toolId. */
export function findToolPart(
  parts: AssistantPart[],
  toolId: string,
): ToolCallPart | undefined {
  return parts.find(
    (p): p is ToolCallPart => p.type === 'tool' && p.toolId === toolId,
  );
}
