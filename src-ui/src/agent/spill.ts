// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// spill — 大输出溢写：超过内联阈值的内容落盘 .hologram/spill/，
// 模型拿到 locator + 预览，用 read_file 读全量。对标 DSH spill 的
// 「bounded preview + retrieval locator」语义 — 截断即丢信息，溢写不丢。

import { typedRpc } from '../rpc-contract';

export interface SpillOutcome {
  /** 展示给模型的文本：小内容 = 原文；大内容 = 预览 + locator 提示 */
  display: string;
  spilled: boolean;
  /** 落盘路径（仅 spilled=true 时存在） */
  path?: string;
}

/** 超长文本溢写：超过 maxInline 时写入 .hologram/spill/，
 *  返回预览 + locator；落盘失败退回截断（带标记，不静默）。 */
export async function spillToFile(opts: {
  projectPath: string;
  name: string;
  text: string;
  maxInline: number;
  extension?: string;
}): Promise<SpillOutcome> {
  const { projectPath, name, text, maxInline, extension } = opts;
  if (text.length <= maxInline) {
    return { display: text, spilled: false };
  }
  if (!projectPath) {
    return { display: fallbackTruncate(text, maxInline), spilled: false };
  }
  const base = projectPath.replace(/\\/g, '/').replace(/\/$/, '');
  const dir = `${base}/.hologram/spill`;
  const ts = Date.now();
  const path = `${dir}/${name}-${ts}.${extension ?? 'txt'}`;
  try {
    await typedRpc('create_directory', { path: dir });
    await typedRpc('write_file_content', { file_path: path, content: text });
  } catch (e) {
    // 尽力而为但不静默 — 退回截断并标明溢写失败
    const preview = fallbackTruncate(text, maxInline);
    return {
      display: `${preview}\n…[spill 溢写失败: ${String(e)} — 内容已截断]…`,
      spilled: false,
    };
  }
  const preview = `${text.slice(0, maxInline)}\n…[已溢写 ${text.length} 字符]…`;
  return {
    display: `${preview}\n完整内容: ${path}（用 read_file 读取全量）`,
    spilled: true,
    path,
  };
}

function fallbackTruncate(text: string, max: number): string {
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}…[truncated: ${text.length - max} chars omitted]…${text.slice(
    text.length - half,
  )}`;
}

/** 解析 agent_isolation_diff 命令返回的 JSON（小 diff 原文 / 大 diff 溢写标记）。 */
export function parseIsolationDiff(raw: string): {
  hasChanges: boolean;
  diff: string;
  spillPath?: string;
} | null {
  try {
    const j = JSON.parse(raw) as { has_changes?: boolean; diff?: string; spill_path?: string };
    return {
      hasChanges: j.has_changes ?? false,
      diff: j.diff ?? '',
      spillPath: j.spill_path,
    };
  } catch {
    return null;
  }
}
