// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// subagent-sink — 用节流 React bump 包装 applyEventToParts。
// 所有 event→part 逻辑在 part-mutator.ts 中；此文件仅添加
// 子 agent 块渲染特有的节流渲染层。

import type { AgentEvent } from '../agent/agent-types';
import { EventKind } from '../agent/agent-types';
import type { SubAgentPart } from './message-model';
import { applyEventToParts } from './part-mutator';

export interface SubAgentSinkOpts {
  subPart: SubAgentPart;
  /** 调用以触发 React 重渲染（通常是 bumpChat）。节流为每 ~16ms 一次，
   *  使 5000 个流式 token 不至于导致 5000 次完整消息列表渲染。
   *  （用 setTimeout 而非 rAF — rAF 在后台 WebView 标签页中暂停，
   *  会卡住流。） */
  bump: () => void;
  /** 可选：将工具分发名称转发给父工具卡片以显示进度。 */
  onProgress?: (chunk: string) => void;
}

/** 创建一个 AgentEvent sink，将事件写入 SubAgentPart。
 *  变更委托给 applyEventToParts（与主 agent 共享）。
 *  Bump 节流为每 16ms 至多一次。
 *  subPart.version 统计总变更次数，供潜在细粒度订阅使用。 */
export function createSubAgentSink(opts: SubAgentSinkOpts): (ev: AgentEvent) => void {
  const { subPart, bump } = opts;

  let timerId: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    subPart.version++;
    if (timerId !== null) return; // 已有待处理的
    timerId = setTimeout(() => {
      timerId = null;
      bump();
    }, 16);
  };

  return (ev: AgentEvent) => {
    const mutated = applyEventToParts(subPart.parts, ev);
    if (!mutated) return;

    // 副作用：将工具名称转发给父级以显示进度
    if (ev.kind === EventKind.ToolDispatch && ev.tool) {
      opts.onProgress?.(`🔧 ${ev.tool.name}\n`);
    }

    tick();
  };
}
