// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 委派不可扩权 — 子 Agent 工具集剥离面回归。
// 子 Agent 是工人不是编排者：不得递归派生、杀兄弟、观测池；
// 不得直接问用户（ask_user）、不得翻父级 plan 模式（enter/exit_plan_mode
// 闭包绑定父 planState — 调用即越权）。

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../src/agent/tool';
import { defineTool } from '../src/agent/tools/define-tool';
import { buildSubAgentTools } from '../src/agent/agent';

function fake(name: string) {
  return defineTool({
    name,
    description: name,
    schema: z.object({}),
    execute: async () => name,
  });
}

describe('buildSubAgentTools — delegation boundary', () => {
  it('strips orchestration, human-interaction and plan-mode tools', () => {
    const source = new ToolRegistry();
    for (const n of [
      'read_file',
      'edit_file',
      'agent_spawn',
      'agent_kill',
      'agent_status',
      'ask_user',
      'enter_plan_mode',
      'exit_plan_mode',
    ]) {
      source.register(fake(n));
    }
    const sub = buildSubAgentTools(source, null);
    const names = sub.all().map((t) => t.name());
    expect(names).toContain('read_file');
    expect(names).toContain('edit_file');
    for (const stripped of ['agent_spawn', 'agent_kill', 'agent_status', 'ask_user', 'enter_plan_mode', 'exit_plan_mode']) {
      expect(names).not.toContain(stripped);
    }
  });

  it('applies the tool allowlist on top of the strip list', () => {
    const source = new ToolRegistry();
    for (const n of ['read_file', 'edit_file', 'grep']) source.register(fake(n));
    const sub = buildSubAgentTools(source, ['read_file', 'grep']);
    expect(sub.all().map((t) => t.name()).sort()).toEqual(['grep', 'read_file']);
  });

  it('does not mutate the source registry', () => {
    const source = new ToolRegistry();
    source.register(fake('ask_user'));
    source.register(fake('read_file'));
    buildSubAgentTools(source, null);
    expect(source.all().map((t) => t.name())).toContain('ask_user');
  });
});
