// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// parseStructuredError 契约 — Rust 侧 `[CODE] message` 前缀（cdp/errors.rs 与
// uia/errors.rs 构造）的 TS 端解析。browser/desktop 共用；parseBrowserError
// 是别名（防破坏既有导入），行为必须一致。

import { describe, expect, it } from 'vitest';
import { parseBrowserError } from '../src/agent/tools/browser';
import { parseStructuredError } from '../src/agent/tools/structured-error';

describe('parseStructuredError', () => {
  it('解析 [CODE] message 形态', () => {
    const r = parseStructuredError('[UIA_LEASE_BUSY] 桌面输入租约被占用（holder: agent-1）');
    expect(r).toEqual({
      code: 'UIA_LEASE_BUSY',
      message: '桌面输入租约被占用（holder: agent-1）',
    });
  });

  it('支持多行 message 与含方括号的正文', () => {
    const r = parseStructuredError('[CDP_TIMEOUT] line1\nline2 [not-a-code] end');
    expect(r?.code).toBe('CDP_TIMEOUT');
    expect(r?.message).toContain('line2 [not-a-code] end');
  });

  it('无前缀错误返回 null（权限引擎/旧错误回退原文）', () => {
    expect(parseStructuredError('用户拒绝了此操作')).toBeNull();
    expect(parseStructuredError('[lower_case] 前缀必须全大写')).toBeNull();
    expect(parseStructuredError('[] 空码')).toBeNull();
    expect(parseStructuredError('')).toBeNull();
  });

  it('parseBrowserError 是同行为别名（browser/desktop 共用契约）', () => {
    const raw = '[UIA_STALE_REF] ref 42 不存在';
    expect(parseBrowserError(raw)).toEqual(parseStructuredError(raw));
  });
});
