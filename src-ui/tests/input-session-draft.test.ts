// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 回归：会话输入草稿隔离 —— 输入框 live 状态始终只属于活跃会话。
// 切换会话 tab 时，未发送的文字应留在原会话的草稿槽，切回时恢复，
// 而非"漂移"到另一个会话的输入框。
//
// 直接测 input-store 层的 save/restore/clear primitives（纯 zustand，无需 DOM/Agent）。

import { beforeEach, describe, expect, it } from 'vitest';
import { getInputStore } from '../src/state/input-store';

// 新面板 id，避免用例间被 createScopedStore 复用到旧 store
let panelSeq = 0;
function freshPanel(): string {
  return `draft-test-panel-${panelSeq++}-${Date.now()}`;
}

// 施加一个非空草稿（inputText + 附件 + 历史 + draftText）
function seedDraft(storeId: string, text: string): void {
  const s = getInputStore(storeId).getState();
  s.setInputText(text);
  s.setAttachedFiles([{ path: `/x/${text}`, name: text, size: 1 }]);
  s.pushInputHistory(`hist-${text}`);
  s.setDraftText(`draft-${text}`);
}

describe('input session draft isolation', () => {
  let storeId: string;

  beforeEach(() => {
    localStorage.clear();
    storeId = freshPanel();
  });

  it('切离会话时保存草稿、切回时恢复 —— 文字留在原会话', () => {
    // 会话 1 正在输入
    seedDraft(storeId, 'AAA');
    // 切离：保存会话 1 的草稿，清空 live（模拟切到无草稿的会话 2）
    getInputStore(storeId).getState().saveSessionDraft(1);
    getInputStore(storeId).getState().restoreSessionDraft(2); // 会话 2 无草稿槽 → live 清空
    expect(getInputStore(storeId).getState().inputText).toBe('');

    // 会话 2 输入另一段文字
    seedDraft(storeId, 'BBB');
    getInputStore(storeId).getState().saveSessionDraft(2);

    // 切回会话 1：恢复其草稿 → 输入框应还是 AAA（不泄漏 BBB）
    getInputStore(storeId).getState().restoreSessionDraft(1);
    expect(getInputStore(storeId).getState().inputText).toBe('AAA');
    expect(getInputStore(storeId).getState().attachedFiles[0]?.path).toBe('/x/AAA');

    // 再切回会话 2：恢复 BBB
    getInputStore(storeId).getState().saveSessionDraft(1);
    getInputStore(storeId).getState().restoreSessionDraft(2);
    expect(getInputStore(storeId).getState().inputText).toBe('BBB');
  });

  it('无草稿槽的会话 restore 后 live 清空，不残留上一会话文字', () => {
    seedDraft(storeId, 'AAA');
    getInputStore(storeId).getState().saveSessionDraft(1);
    // 会话 5 从未写过草稿
    getInputStore(storeId).getState().restoreSessionDraft(5);
    const s = getInputStore(storeId).getState();
    expect(s.inputText).toBe('');
    expect(s.attachedFiles).toHaveLength(0);
    expect(s.inputHistory).toHaveLength(0);
  });

  it('clearSessionDraft 丢弃被关闭会话的草稿，不影响其他槽', () => {
    seedDraft(storeId, 'AAA');
    getInputStore(storeId).getState().saveSessionDraft(1);
    seedDraft(storeId, 'BBB');
    getInputStore(storeId).getState().saveSessionDraft(2);

    getInputStore(storeId).getState().clearSessionDraft(1);
    // 2 槽仍在
    expect(getInputStore(storeId).getState().sessionDrafts[2]?.inputText).toBe('BBB');
    expect(getInputStore(storeId).getState().sessionDrafts[1]).toBeUndefined();
    // restore 已清空的 1 槽 → 空（不再复活关闭会话的文字）
    getInputStore(storeId).getState().restoreSessionDraft(1);
    expect(getInputStore(storeId).getState().inputText).toBe('');
  });

  it('clearSessionDrafts 重建会话树时清空全部槽与 live', () => {
    seedDraft(storeId, 'AAA');
    getInputStore(storeId).getState().saveSessionDraft(1);
    seedDraft(storeId, 'BBB');
    getInputStore(storeId).getState().saveSessionDraft(2);

    getInputStore(storeId).getState().clearSessionDrafts();
    const s = getInputStore(storeId).getState();
    expect(s.sessionDrafts).toEqual({});
    expect(s.inputText).toBe('');
  });

  it('发送后清空 live，切离再切回不会复活已发送文字', () => {
    seedDraft(storeId, '已发送');
    // 发送行为：清空 live + 清空该会话草稿槽（等价 sendMessage 后 live 置空）
    const s = getInputStore(storeId).getState();
    s.setInputText('');
    s.setAttachedFiles([]);
    s.setInputHistory([]);
    s.setDraftText('');
    getInputStore(storeId).getState().clearSessionDraft(1);
    // 此时切离再切回
    getInputStore(storeId).getState().saveSessionDraft(1);
    getInputStore(storeId).getState().restoreSessionDraft(1);
    expect(getInputStore(storeId).getState().inputText).toBe('');
  });
});
