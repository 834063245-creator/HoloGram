// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话恢复/自动保存的 epoch 代际防护 + setAgent(null) 会话列表清理
// （landmine-map 工作区生命周期/状态管理家族 H5 + 中危#5）。
//
// 冻结文件 chat-session.ts 只做最小外科手术（每处 ≤3 行 + import），
// 用 T0 静态断言钉住 epoch 校验存在；行为由现有 chat-session.test.ts 回归。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sessionSrc = readFileSync(path.resolve(process.cwd(), 'src/ui/chat-session.ts'), 'utf8');
const coreSrc = readFileSync(path.resolve(process.cwd(), 'src/app/chat/chat-core.ts'), 'utf8');

describe('chat-session H5 — autoRestoreLastSession epoch 防护', () => {
  it('入口记 epoch（getWorkspaceEpoch）', () => {
    const body = sessionSrc.slice(sessionSrc.indexOf('autoRestoreLastSession'));
    expect(body.indexOf('getWorkspaceEpoch()')).toBeLessThan(body.indexOf('const freshSys'));
  });

  it('最终写 store 前有 isCurrentEpoch 校验', () => {
    const restore = sessionSrc.slice(sessionSrc.indexOf('autoRestoreLastSession'));
    // 写 block（setAgent/setState/setMessages）之前必须有代际校验
    const guardIdx = restore.indexOf('if (!isCurrentEpoch(epoch)) return;');
    expect(guardIdx).toBeGreaterThan(-1);
    const writeIdx = restore.indexOf('agentSessionState.setAgent(ctx.storeId, data.id, newAgent)');
    expect(guardIdx).toBeLessThan(writeIdx);
  });
});

describe('chat-session H5 — scheduleAutoSave epoch 防护', () => {
  it('timer 闭包记 epoch 且触发前校验', () => {
    const body = sessionSrc.slice(sessionSrc.indexOf('export function scheduleAutoSave'));
    expect(body).toContain('const epoch = getWorkspaceEpoch()');
    expect(body).toContain('if (!isCurrentEpoch(epoch)) return;');
  });
});

describe('chat-core 中危#5 — setAgent(null) 清会话列表', () => {
  it('null 拆除路径清 sessions + activeIdx', () => {
    const teardown = coreSrc.slice(coreSrc.indexOf('setAgent(agent: OwnedAgentHandle | null)'));
    const nullBranch = teardown.slice(0, teardown.indexOf('// 替换所有会话'));
    expect(nullBranch).toContain('sess.setState({ sessions: [], activeIdx: -1 })');
  });
});
