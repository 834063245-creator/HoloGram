// Message height estimator — provides estimated heights for the virtual list.
//
// Strategy:
//   - User messages: Pretext measures plain text precisely.
//   - Assistant text parts: Pretext measures, then × 1.15 to account for
//     markdown rendering margins (paragraphs, headings, lists).
//   - Reasoning parts: collapsed = fixed header height; expanded = Pretext.
//   - Tool parts: fixed estimates (header + optional output area).
//   - Sub-agent parts: recurse into child parts.
//   - Notice messages: fixed height.
//
// The virtual list's measureElement corrects these estimates after real DOM
// rendering, so slight over/under-estimates self-heal.

import { measureTextHeight } from './pretext-cache';
import type {
  AssistantMessage,
  AssistantPart,
  ChatMessage,
  SubAgentPart,
  TextPart,
  ToolCallPart,
} from './message-model';

// ── Layout constants (match chat.css) ──

const MSG_GAP = 10; // .chat-messages gap
const BUBBLE_PADDING_Y = 20; // .msg-bubble padding top+bottom: 10px each
const BUBBLE_PADDING_X = 26; // .msg-bubble padding left+right: 13px each

// Markdown inflation factor: paragraphs have 8px bottom margin, headings have
// larger margins, lists have spacing. 1.15 is a conservative average.
const MARKDOWN_INFLATION = 1.15;

// Tool card heights
const TOOL_HEADER_HEIGHT = 36;
const TOOL_OUTPUT_ESTIMATE = 200;
const TOOL_RUNNING_HEIGHT = 44;

// Reasoning block heights
const REASONING_COLLAPSED_HEIGHT = 32;
const REASONING_PADDING = 16;

// Notice height
const NOTICE_HEIGHT = 28;

// ── Height cache ──
// Key: `${msgId}:${contentHash}:${containerWidth}`
// We use a simple string hash of the message content to detect changes.
// During streaming, text grows, so the hash changes and we re-estimate.
// prepare() is internally cached in pretext-cache.ts, so repeated calls
// with growing text only pay for the new suffix's segmentation.

const heightCache = new Map<string, number>();

function hashString(s: string): string {
  // Fast hash — not cryptographic, just for cache invalidation
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return `${h}:${s.length}`;
}

// ── Per-part estimation ──

function estimateTextPartHeight(part: TextPart, contentWidth: number): number {
  if (!part.text) return 0;
  const rawHeight = measureTextHeight(part.text, contentWidth);
  // Markdown renders with paragraph margins, headings, etc.
  // For streaming text (not finalised), the tail is rendered as plain text
  // so no inflation needed there. For finalised markdown, inflate.
  return part.finalised ? rawHeight * MARKDOWN_INFLATION : rawHeight;
}

function estimateToolPartHeight(part: ToolCallPart): number {
  let h = TOOL_HEADER_HEIGHT;
  if (part.status === 'running' && !part.output) {
    h += TOOL_RUNNING_HEIGHT;
  } else if (part.output) {
    h += TOOL_OUTPUT_ESTIMATE;
  }
  if (part.err) {
    h += 60;
  }
  return h;
}

function estimateSubAgentHeight(part: SubAgentPart, contentWidth: number): number {
  // Collapsed: just header
  if (part.status !== 'running') {
    return 36; // header only
  }
  // Expanded during streaming: estimate child parts
  let h = 36; // header
  for (const child of part.parts) {
    h += estimatePartHeight(child, contentWidth);
  }
  return h;
}

function estimatePartHeight(part: AssistantPart, contentWidth: number): number {
  switch (part.type) {
    case 'text':
      return estimateTextPartHeight(part as TextPart, contentWidth);
    case 'reasoning':
      // During streaming, reasoning is expanded; collapsed otherwise.
      // We estimate expanded to be safe (over-estimate is fine for virtualization).
      if (!part.text) return 0;
      return REASONING_COLLAPSED_HEIGHT + REASONING_PADDING + measureTextHeight(part.text, contentWidth);
    case 'tool':
      return estimateToolPartHeight(part as ToolCallPart);
    case 'subagent':
      return estimateSubAgentHeight(part as SubAgentPart, contentWidth);
    default:
      return 0;
  }
}

// ── Public API ──

export function estimateMessageHeight(msg: ChatMessage, containerWidth: number): number {
  // Compute content width: container - padding - gap overhead
  const contentWidth = Math.max(50, containerWidth - BUBBLE_PADDING_X - MSG_GAP * 2);

  // Build cache key
  let contentKey: string;
  if (msg.role === 'user') {
    contentKey = hashString(msg.text);
  } else if (msg.role === 'assistant') {
    contentKey = hashString((msg as AssistantMessage).parts.map(p => `${p.type}:${p.type === 'text' ? (p as TextPart).text.length : p.type === 'reasoning' ? p.text.length : p.type === 'tool' ? (p as ToolCallPart).status : ''}`).join(','));
  } else {
    contentKey = hashString(msg.text);
  }

  const cacheKey = `${msg._id}:${contentKey}:${containerWidth}`;
  const cached = heightCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let height: number;
  switch (msg.role) {
    case 'user':
      height = measureTextHeight(msg.text, contentWidth) + BUBBLE_PADDING_Y;
      // Add attach pills height if any
      if (msg.files && msg.files.length > 0) {
        height += Math.ceil(msg.files.length / 3) * 24; // rough: ~3 pills per row, 24px each
      }
      // Add actions row
      height += 22;
      break;

    case 'assistant': {
      let h = BUBBLE_PADDING_Y;
      const parts = (msg as AssistantMessage).parts;
      for (let i = 0; i < parts.length; i++) {
        h += estimatePartHeight(parts[i], contentWidth);
        // Gap between parts
        if (i < parts.length - 1) h += 6;
      }
      // If no parts at all (just created), give minimum height
      if (parts.length === 0) h = 40;
      // Add actions row
      h += 22;
      height = h;
      break;
    }

    case 'notice':
      height = NOTICE_HEIGHT;
      break;

    default:
      height = 60;
  }

  heightCache.set(cacheKey, height);

  // Cap cache
  if (heightCache.size > 1000) {
    const firstKey = heightCache.keys().next().value;
    if (firstKey !== undefined) heightCache.delete(firstKey);
  }

  return height;
}

// Clear all cached heights (e.g. on font-scale change)
export function clearHeightCache(): void {
  heightCache.clear();
}

// Get the gap between messages for the virtual list
export function getMessageGap(): number {
  return MSG_GAP;
}
