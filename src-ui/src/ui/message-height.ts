// Message height estimator — provides estimated heights for the virtual list.
//
// Strategy:
//   - User messages: Pretext measures plain text precisely (body font, lh 1.6).
//   - Assistant text parts: Pretext measures (body font, lh 1.7 — .msg-markdown),
//     then × 1.15 when finalised to account for markdown paragraph/heading margins.
//   - Reasoning parts: collapsed by default (fixed header height); expanded while
//     the owning message is still streaming — measured with the real mono font.
//   - Tool parts: header only; running tools auto-expand in the DOM, so add the
//     running body estimate. Output is display:none unless the user expands it.
//   - Sub-agent parts: default collapsed → header only.
//   - Plan parts: Pretext-measured markdown content + card chrome.
//   - Notice messages: fixed height.
//
// Width model mirrors chat.css: .chat-messages padding 14px*scale each side,
// .msg-bubble max-width 90%, user bubble padding 13px*scale each side,
// assistant bubble padding-left/right 0.
//
// The virtual list's measureElement corrects these estimates after real DOM
// rendering, so slight over/under-estimates self-heal — but only for items that
// have been rendered. Off-screen estimates stay as-is, so keep them honest.

import { bodyFont, bodyLineHeight, fontScale, measureTextHeight, monoFont, monoLineHeight } from './pretext-cache';
import type {
  AssistantMessage,
  AssistantPart,
  ChatMessage,
  PlanPart,
  SubAgentPart,
  TextPart,
  ToolCallPart,
} from './message-model';

// ── Layout constants (match chat.css) ──

const MSG_GAP = 10; // vertical gap between messages (virtualizer gap option)
const CONTAINER_PADDING_X = 14; // .chat-messages padding per side, × font-scale
const BUBBLE_MAX_WIDTH_RATIO = 0.9; // .msg-bubble max-width
const USER_BUBBLE_PADDING_X = 26; // .msg-bubble.user padding left+right: 13px each, × font-scale
const BUBBLE_PADDING_Y = 20; // .msg-bubble padding top+bottom: 10px each, × font-scale

// Markdown inflation factor: paragraphs have 8px bottom margin, headings have
// larger margins, lists have spacing. 1.15 is a conservative average.
const MARKDOWN_INFLATION = 1.15;

// Assistant text line-height (.msg-markdown overrides .msg-bubble's 1.6)
const ASSISTANT_LINE_HEIGHT_MULT = 1.7;

// Tool card heights — cards are collapsed (output display:none) unless the
// user expands them; running tools auto-expand with a streaming body.
const TOOL_HEADER_HEIGHT = 36;
const TOOL_RUNNING_BODY_HEIGHT = 44;

// Reasoning block heights — collapsed after streaming ends; expanded (with the
// full mono text) only while the message is still streaming.
const REASONING_COLLAPSED_HEIGHT = 32;
const REASONING_EXPANDED_PADDING = 16 + 5 + 16; // content padding + margin-top + block padding

// Sub-agent cards are default-collapsed (header only)
const SUBAGENT_COLLAPSED_HEIGHT = 36;

// Plan card chrome: buttons row + card padding on top of markdown content
const PLAN_CHROME_HEIGHT = 64;

// Notice height
const NOTICE_HEIGHT = 28;

// Actions row (copy/retry buttons) at the bottom of each bubble
const ACTIONS_ROW_HEIGHT = 22;

// ── Height cache ──
// Key: `${msgId}:${contentHash}:${containerWidth}:${fontScale}`
// Width and font-scale are part of the key, so panel resize / font-scale
// changes naturally produce fresh entries instead of stale hits.
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

// ── Width model ──

function innerWidth(containerWidth: number, scale: number): number {
  return containerWidth - CONTAINER_PADDING_X * scale * 2;
}

// Width the bubble's text actually wraps at.
function bubbleTextWidth(containerWidth: number, scale: number, role: 'user' | 'assistant'): number {
  const bubble = innerWidth(containerWidth, scale) * BUBBLE_MAX_WIDTH_RATIO;
  const paddingX = role === 'user' ? USER_BUBBLE_PADDING_X * scale : 0; // assistant padding-x is 0
  return Math.max(50, bubble - paddingX);
}

// ── Per-part estimation ──

function estimateTextPartHeight(part: TextPart, contentWidth: number): number {
  if (!part.text) return 0;
  const rawHeight = measureTextHeight(part.text, contentWidth, bodyFont(), bodyLineHeight(ASSISTANT_LINE_HEIGHT_MULT));
  // Markdown renders with paragraph margins, headings, etc.
  // For streaming text (not finalised), the tail is rendered as plain text
  // so no inflation needed there. For finalised markdown, inflate.
  return part.finalised ? rawHeight * MARKDOWN_INFLATION : rawHeight;
}

function estimateReasoningPartHeight(text: string, contentWidth: number, streaming: boolean): number {
  if (!text) return 0;
  if (!streaming) return REASONING_COLLAPSED_HEIGHT;
  // Streaming: block is expanded. DOM renders it at 9px mono / line-height 1.6
  // (.msg-reasoning-content), not the body font — measure with the real font.
  return (
    REASONING_COLLAPSED_HEIGHT +
    REASONING_EXPANDED_PADDING +
    measureTextHeight(text, contentWidth, monoFont(), monoLineHeight(1.6))
  );
}

function estimateToolPartHeight(part: ToolCallPart): number {
  // Running tools auto-expand (isExpanded = expanded || status === 'running').
  // Done/error/pending cards are collapsed → header only.
  return part.status === 'running' ? TOOL_HEADER_HEIGHT + TOOL_RUNNING_BODY_HEIGHT : TOOL_HEADER_HEIGHT;
}

function estimatePlanPartHeight(part: PlanPart, contentWidth: number): number {
  const content = measureTextHeight(part.content || '', contentWidth, bodyFont(), bodyLineHeight(ASSISTANT_LINE_HEIGHT_MULT));
  return PLAN_CHROME_HEIGHT + content * MARKDOWN_INFLATION;
}

function estimatePartHeight(part: AssistantPart, contentWidth: number, streaming: boolean): number {
  switch (part.type) {
    case 'text':
      return estimateTextPartHeight(part as TextPart, contentWidth);
    case 'reasoning':
      return estimateReasoningPartHeight(part.text, contentWidth, streaming);
    case 'tool':
      return estimateToolPartHeight(part as ToolCallPart);
    case 'subagent':
      // Default collapsed regardless of status (36f7d6e) — children only render
      // when the user expands the card.
      return SUBAGENT_COLLAPSED_HEIGHT;
    case 'plan':
      return estimatePlanPartHeight(part as PlanPart, contentWidth);
    default:
      return 0;
  }
}

// ── Public API ──

export function estimateMessageHeight(msg: ChatMessage, containerWidth: number): number {
  const scale = fontScale();
  const widthKey = Math.round(containerWidth);

  // Build cache key from full content (not just lengths — equal-length edits
  // would otherwise hit stale entries) plus every input that changes the result.
  let contentKey: string;
  if (msg.role === 'assistant') {
    const am = msg as AssistantMessage;
    contentKey = hashString(
      am.status +
        '|' +
        am.parts
          .map((p) => {
            switch (p.type) {
              case 'text':
                return `t:${hashString((p as TextPart).text)}:${(p as TextPart).finalised ? 1 : 0}`;
              case 'reasoning':
                return `r:${hashString(p.text)}`;
              case 'tool':
                return `tool:${(p as ToolCallPart).status}`;
              case 'subagent':
                return `sa:${(p as SubAgentPart).status}`;
              case 'plan':
                return `p:${hashString((p as PlanPart).content || '')}:${(p as PlanPart).status}`;
              default:
                return '';
            }
          })
          .join(','),
    );
  } else {
    contentKey = hashString(msg.text + (msg.role === 'user' && msg.files ? `|f:${msg.files.length}` : ''));
  }

  const cacheKey = `${msg._id}:${contentKey}:${widthKey}:${scale}`;
  const cached = heightCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let height: number;
  switch (msg.role) {
    case 'user': {
      const contentWidth = bubbleTextWidth(containerWidth, scale, 'user');
      height = measureTextHeight(msg.text, contentWidth) + BUBBLE_PADDING_Y * scale;
      // Add attach pills height if any
      if (msg.files && msg.files.length > 0) {
        height += Math.ceil(msg.files.length / 3) * 24; // rough: ~3 pills per row, 24px each
      }
      // Add actions row
      height += ACTIONS_ROW_HEIGHT;
      break;
    }

    case 'assistant': {
      const am = msg as AssistantMessage;
      const contentWidth = bubbleTextWidth(containerWidth, scale, 'assistant');
      const streaming = am.status === 'streaming';
      let h = BUBBLE_PADDING_Y * scale;
      const parts = am.parts;
      for (let i = 0; i < parts.length; i++) {
        h += estimatePartHeight(parts[i], contentWidth, streaming);
        // Gap between parts
        if (i < parts.length - 1) h += 6;
      }
      // If no parts at all (just created), give minimum height
      if (parts.length === 0) h = 40;
      // Add actions row
      h += ACTIONS_ROW_HEIGHT;
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

// Clear all cached heights (e.g. on font-scale change — normally unnecessary
// since font-scale is part of the cache key, but kept as an escape hatch)
export function clearHeightCache(): void {
  heightCache.clear();
}

// Get the gap between messages for the virtual list
export function getMessageGap(): number {
  return MSG_GAP;
}
