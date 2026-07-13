// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// subagent-sink.test.ts — verify event→SubAgentPart conversion

import { describe, it, expect, vi } from 'vitest';
import { createSubAgentSink } from '../src/agent/subagent-sink';
import { EventKind } from '../src/agent/agent-types';
import type { SubAgentPart } from '../src/ui/message-model';

function freshPart(overrides?: Partial<SubAgentPart>): SubAgentPart {
  return {
    type: 'subagent',
    agentId: 'test-agent',
    description: '测试子Agent',
    status: 'running',
    parts: [],
    version: 0,
    ...overrides,
  };
}

describe('createSubAgentSink', () => {
  it('reasoning → pushes a reasoning part and bumps', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({ kind: EventKind.Reasoning, text: 'thinking...' });

    expect(part.parts).toHaveLength(1);
    expect(part.parts[0]).toMatchObject({ type: 'reasoning', text: 'thinking...' });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('reasoning → merges chunks into one reasoning block', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({ kind: EventKind.Reasoning, text: 'I need to ' });
    sink({ kind: EventKind.Reasoning, text: 'think about this.' });

    expect(part.parts).toHaveLength(1);
    expect(part.parts[0]).toMatchObject({ type: 'reasoning', text: 'I need to think about this.' });
    expect(bump).toHaveBeenCalledTimes(2);
  });

  it('ignores reasoning with empty text', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({ kind: EventKind.Reasoning, text: '' });

    expect(part.parts).toHaveLength(0);
    expect(bump).not.toHaveBeenCalled();
  });

  it('text → creates a streaming text part', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({ kind: EventKind.Text, text: 'Hello' });

    expect(part.parts).toHaveLength(1);
    expect(part.parts[0]).toMatchObject({ type: 'text', text: 'Hello', finalised: false });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('text → appends to the last unfinalised text part (streaming merge)', () => {
    const part = freshPart();
    part.parts.push({ type: 'text', text: 'Hello', finalised: false });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({ kind: EventKind.Text, text: ' World' });

    expect(part.parts).toHaveLength(1);
    expect(part.parts[0]).toMatchObject({ type: 'text', text: 'Hello World', finalised: false });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('text → starts a new text part when the last one is finalised', () => {
    const part = freshPart();
    part.parts.push({ type: 'text', text: 'Done.', finalised: true });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({ kind: EventKind.Text, text: 'More' });

    expect(part.parts).toHaveLength(2);
    expect(part.parts[1]).toMatchObject({ type: 'text', text: 'More', finalised: false });
  });

  it('message → finalises the last text part', () => {
    const part = freshPart();
    part.parts.push({ type: 'text', text: 'streaming...', finalised: false });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({ kind: EventKind.Message, text: 'streaming...' });

    expect(part.parts[0]).toMatchObject({ type: 'text', finalised: true });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('message → bumps but does nothing when there is no text part', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({ kind: EventKind.Message });

    expect(part.parts).toHaveLength(0);
    // bump is called regardless — harmless re-render, no mutation
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('ToolDispatch → creates a tool part and bumps + onProgress', () => {
    const part = freshPart();
    const bump = vi.fn();
    const onProgress = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump, onProgress });

    sink({
      kind: EventKind.ToolDispatch,
      tool: { id: 't1', name: 'read_file', args: '{}', read_only: true, partial: true },
    });

    expect(part.parts).toHaveLength(1);
    expect(part.parts[0]).toMatchObject({
      type: 'tool', toolId: 't1', name: 'read_file', status: 'pending',
    });
    expect(bump).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith('🔧 read_file\n');
  });

  it('ToolDispatch → non-partial sets status to running', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({
      kind: EventKind.ToolDispatch,
      tool: { id: 't2', name: 'write_file', args: '{}', read_only: false },
    });

    expect(part.parts[0]).toMatchObject({ status: 'running' });
  });

  it('ToolProgress → appends output to existing tool part', () => {
    const part = freshPart();
    part.parts.push({
      type: 'tool', toolId: 't1', name: 'read_file', args: '{}',
      label: 'read_file', readOnly: true, status: 'running',
    });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({
      kind: EventKind.ToolProgress,
      tool: { id: 't1', name: 'read_file', output: 'line1\n', read_only: true },
    });

    expect(part.parts[0]).toMatchObject({ output: 'line1\n' });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('ToolProgress → accumulates multiple chunks (one bump per event)', () => {
    const part = freshPart();
    part.parts.push({
      type: 'tool', toolId: 't1', name: 'read_file', args: '{}',
      label: 'read_file', readOnly: true, status: 'running', output: 'a',
    });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({ kind: EventKind.ToolProgress, tool: { id: 't1', name: 'read_file', output: 'b', read_only: true } });
    sink({ kind: EventKind.ToolProgress, tool: { id: 't1', name: 'read_file', output: 'c', read_only: true } });

    expect(part.parts[0]).toMatchObject({ output: 'abc' });
    expect(bump).toHaveBeenCalledTimes(2);
  });

  it('ToolProgress → no-op when tool not found (no bump)', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({ kind: EventKind.ToolProgress, tool: { id: 'nonexistent', name: 'x', output: 'x', read_only: true } });

    expect(part.parts).toHaveLength(0);
    expect(bump).not.toHaveBeenCalled();
  });

  it('ToolResult → marks tool done and sets output', () => {
    const part = freshPart();
    part.parts.push({
      type: 'tool', toolId: 't1', name: 'read_file', args: '{}',
      label: 'read_file', readOnly: true, status: 'running',
    });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({
      kind: EventKind.ToolResult,
      tool: { id: 't1', name: 'read_file', output: 'file content', read_only: true },
    });

    expect(part.parts[0]).toMatchObject({ status: 'done', output: 'file content' });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('ToolResult → marks tool error and sets err', () => {
    const part = freshPart();
    part.parts.push({
      type: 'tool', toolId: 't1', name: 'bad', args: '{}',
      label: 'bad', readOnly: false, status: 'running',
    });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({
      kind: EventKind.ToolResult,
      tool: { id: 't1', name: 'bad', err: 'something broke', read_only: false },
    });

    expect(part.parts[0]).toMatchObject({ status: 'error', err: 'something broke' });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('ToolResult → sets truncated flag', () => {
    const part = freshPart();
    part.parts.push({
      type: 'tool', toolId: 't1', name: 'big', args: '{}',
      label: 'big', readOnly: true, status: 'running',
    });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({
      kind: EventKind.ToolResult,
      tool: { id: 't1', name: 'big', output: '...', read_only: true, truncated: true },
    });

    expect(part.parts[0]).toMatchObject({ truncated: true });
  });

  it('unknown event kinds are silently ignored', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({ kind: EventKind.TurnStarted });
    sink({ kind: EventKind.Usage } as any);
    sink({ kind: EventKind.SessionChanged });
    sink({ kind: EventKind.Notice, text: 'hello', level: 'info' });

    expect(part.parts).toHaveLength(0);
    expect(bump).not.toHaveBeenCalled();
  });

  it('full streaming sequence: reasoning → text → tool → progress → result → more text → message', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });

    sink({ kind: EventKind.Reasoning, text: 'Let me think...' });
    sink({ kind: EventKind.Text, text: 'I will read the file.' });
    sink({
      kind: EventKind.ToolDispatch,
      tool: { id: 't1', name: 'read_file', args: '{"path":"x.ts"}', read_only: true },
    });
    sink({
      kind: EventKind.ToolProgress,
      tool: { id: 't1', name: 'read_file', output: 'export const', read_only: true },
    });
    sink({
      kind: EventKind.ToolResult,
      tool: { id: 't1', name: 'read_file', output: 'export const x = 1;', read_only: true },
    });
    // ponytail: second Text merges into the first (both unfinalised, same thought block)
    sink({ kind: EventKind.Text, text: ' File reads:' });
    sink({ kind: EventKind.Message });

    // 3 parts: reasoning + merged text + tool
    expect(part.parts).toHaveLength(3);
    expect(part.parts[0]).toMatchObject({ type: 'reasoning' });
    expect(part.parts[1]).toMatchObject({
      type: 'text', text: 'I will read the file. File reads:', finalised: true,
    });
    expect(part.parts[2]).toMatchObject({ type: 'tool', name: 'read_file', status: 'done' });
    expect(bump).toHaveBeenCalledTimes(7); // one per event
    // version tracks total mutations
    expect(part.version).toBe(7);
  });
});
