// 消息高度估算器 — 为虚拟列表提供估算高度。
//
// 策略：
//   - 用户消息：Pretext 精确测量纯文本（正文字体，行高 1.6）。
//   - 助手文本部分：Pretext 测量（正文字体，行高 1.7 — .msg-markdown），
//     最终化后 × 1.15 以计入 markdown 段落/标题边距。
//   - 推理部分：默认折叠（固定头部高度）；所属消息仍在流式时展开 —
//     用真实等宽字体测量。
//   - 工具部分：仅头部；运行中的工具在 DOM 中自动展开，加入运行中
//     主体估算。输出在用户展开前 display:none。
//   - 子 agent 部分：默认折叠 → 仅头部。
//   - 计划部分：Pretext 测量的 markdown 内容 + 卡片装饰。
//   - 通知消息：固定高度。
//
// 宽度模型镜像 chat.css：.chat-messages 两侧 padding 14px*scale，
// .msg-bubble max-width 90%，用户气泡每侧 padding 13px*scale，
// 助手气泡左右 padding 为 0。
//
// 虚拟列表的 measureElement 会在真实 DOM 渲染后修正这些估算，
// 因此轻微的高估/低估会自愈 — 但仅限于已渲染的项。
// 屏幕外的估算保持原样，因此需尽量准确。

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

// ── 布局常量（与 chat.css 匹配）──

const MSG_GAP = 10; // 消息间垂直间距（虚拟列表 gap 选项）
const CONTAINER_PADDING_X = 14; // .chat-messages 每侧 padding，× font-scale
const BUBBLE_MAX_WIDTH_RATIO = 0.9; // .msg-bubble max-width
const USER_BUBBLE_PADDING_X = 26; // .msg-bubble.user 左右 padding：各 13px，× font-scale
const BUBBLE_PADDING_Y = 20; // .msg-bubble 上下 padding：各 10px，× font-scale

// Markdown 膨胀因子：段落有 8px 底边距，标题有更大边距，列表有间距。
// 1.15 是保守的平均值。
const MARKDOWN_INFLATION = 1.15;

// 助手文本行高（.msg-markdown 覆盖 .msg-bubble 的 1.6）
const ASSISTANT_LINE_HEIGHT_MULT = 1.7;

// 工具卡片高度 — 卡片折叠（输出 display:none），用户展开前不显示；
// 运行中的工具自动展开并带流式主体。
const TOOL_HEADER_HEIGHT = 36;
const TOOL_RUNNING_BODY_HEIGHT = 44;

// 推理块高度 — 流式结束后折叠；仅在消息仍在流式时展开
// （完整等宽文本）。
const REASONING_COLLAPSED_HEIGHT = 32;
const REASONING_EXPANDED_PADDING = 16 + 5 + 16; // content padding + margin-top + block padding

// 子 agent 卡片默认折叠（仅头部）
const SUBAGENT_COLLAPSED_HEIGHT = 36;

// 计划卡片装饰：按钮行 + 卡片 padding，叠加在 markdown 内容上
const PLAN_CHROME_HEIGHT = 64;

// 通知高度
const NOTICE_HEIGHT = 28;

// 操作行（复制/重试按钮）位于每个气泡底部
const ACTIONS_ROW_HEIGHT = 22;

// ── 高度缓存 ──
// Key: `${msgId}:${contentHash}:${containerWidth}:${fontScale}`
// 宽度和 font-scale 是 key 的一部分，面板 resize / font-scale 变化
// 自然产生新条目而非命中过期缓存。
// 流式期间文本增长，hash 变化后重新估算。
// prepare() 在 pretext-cache.ts 中内部缓存，重复调用仅对新后缀
// 分段付费。

const heightCache = new Map<string, number>();

function hashString(s: string): string {
  // 快速 hash — 非加密，仅用于缓存失效
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return `${h}:${s.length}`;
}

// ── 宽度模型 ──

function innerWidth(containerWidth: number, scale: number): number {
  return containerWidth - CONTAINER_PADDING_X * scale * 2;
}

// 气泡文本实际换行宽度。
function bubbleTextWidth(containerWidth: number, scale: number, role: 'user' | 'assistant'): number {
  const bubble = innerWidth(containerWidth, scale) * BUBBLE_MAX_WIDTH_RATIO;
  const paddingX = role === 'user' ? USER_BUBBLE_PADDING_X * scale : 0; // assistant padding-x is 0
  return Math.max(50, bubble - paddingX);
}

// ── 逐部分估算 ──

function estimateTextPartHeight(part: TextPart, contentWidth: number): number {
  if (!part.text) return 0;
  const rawHeight = measureTextHeight(part.text, contentWidth, bodyFont(), bodyLineHeight(ASSISTANT_LINE_HEIGHT_MULT));
  // Markdown 渲染带段落边距、标题等。
  // 流式文本（未最终化）的尾部按纯文本渲染，无需膨胀。
  // 最终化的 markdown 需膨胀。
  return part.finalised ? rawHeight * MARKDOWN_INFLATION : rawHeight;
}

function estimateReasoningPartHeight(text: string, contentWidth: number, streaming: boolean): number {
  if (!text) return 0;
  if (!streaming) return REASONING_COLLAPSED_HEIGHT;
  // 流式：块展开。DOM 以 9px 等宽字体 / 行高 1.6 渲染
  // （.msg-reasoning-content），非正文字体 — 用真实字体测量。
  return (
    REASONING_COLLAPSED_HEIGHT +
    REASONING_EXPANDED_PADDING +
    measureTextHeight(text, contentWidth, monoFont(), monoLineHeight(1.6))
  );
}

function estimateToolPartHeight(part: ToolCallPart): number {
  // 运行中的工具自动展开（isExpanded = expanded || status === 'running'）。
  // done/error/pending 卡片折叠 → 仅头部。
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
      // 无论状态均默认折叠（36f7d6e）— 子项仅在用户展开卡片时渲染
      return SUBAGENT_COLLAPSED_HEIGHT;
    case 'plan':
      return estimatePlanPartHeight(part as PlanPart, contentWidth);
    default:
      return 0;
  }
}

// ── 公共 API ──

export function estimateMessageHeight(msg: ChatMessage, containerWidth: number): number {
  const scale = fontScale();
  const widthKey = Math.round(containerWidth);

  // 从完整内容构建缓存 key（不仅长度 — 等长编辑会命中过期条目）
  // 加上所有影响结果的输入。
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
      // 如有附件标签则加上高度
      if (msg.files && msg.files.length > 0) {
        height += Math.ceil(msg.files.length / 3) * 24; // 粗略：每行约 3 个标签，每个 24px
      }
      // 加上操作行
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
        // 部分间间距
        if (i < parts.length - 1) h += 6;
      }
      // 如无任何部分（刚创建），给予最小高度
      if (parts.length === 0) h = 40;
      // 加上操作行
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

  // 限制缓存大小
  if (heightCache.size > 1000) {
    const firstKey = heightCache.keys().next().value;
    if (firstKey !== undefined) heightCache.delete(firstKey);
  }

  return height;
}

// 清除所有缓存高度（如 font-scale 变更 — 通常不需要，因为
// font-scale 已是缓存 key 的一部分，但保留作为逃生通道）
export function clearHeightCache(): void {
  heightCache.clear();
}

// 获取虚拟列表的消息间距
export function getMessageGap(): number {
  return MSG_GAP;
}
