// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 结构化错误解析 — Rust 侧 `[CODE] message` 前缀契约的 TS 端路由。
// 从 browser.ts 的 parseBrowserError 泛化（browser/desktop 共用）：
// browser 用 [CDP_*] 码，desktop 用 [UIA_*] 码；无前缀（旧错误/权限引擎）返回 null。

/** Rust 侧错误字符串携带的 `[CODE]` 前缀（cdp/errors.rs / uia/errors.rs 构造）。 */
const ERROR_CODE_RE = /^\[([A-Z][A-Z0-9_]*)\]\s*([\s\S]*)$/;

export interface StructuredError {
  code: string;
  message: string;
}

/**
 * 解析 Rust 侧结构化错误：`[CODE] message` → `{ code, message }`。
 * 无前缀（旧错误/权限引擎错误）返回 null，调用方回退原文。
 */
export function parseStructuredError(raw: string): StructuredError | null {
  const m = ERROR_CODE_RE.exec(raw ?? '');
  if (!m) return null;
  return { code: m[1], message: m[2] };
}
