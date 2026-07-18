// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// subagent-sink.test.ts — verify event→SubAgentPart conversion (rAF-throttled bump)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventKind } from '../src/agent/agent-types';
import { createSubAgentSink } from '../src/ui/subagent-sink';
import type { SubAgentPart } from '../src/ui/message-model';

function freshPart(overrides?: Partial<SubAgentPart>): SubAgentPart {
  return {
    type: 'subagent',
    agentId: 'test',
    description: 'test',
    status: 'running',
    parts: [],
    version: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Call sink, then flush rAF so the throttled bump fires. */
function flush(sink: (ev: any) => void, ev: any): void {
  sink(ev);
  vi.runAllTimers();
}

describe('createSubAgentSink', () => {
  // ── Reasoning ──
  it('reasoning → pushes a part, bump throttled to one per flush', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    flush(sink, { kind: EventKind.Reasoning, text: 'thinking...' });
    expect(part.parts).toHaveLength(1);
    expect(part.parts[0]).toMatchObject({ type: 'reasoning', text: 'thinking...' });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('reasoning → merges chunks, one bump total', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    sink({ kind: EventKind.Reasoning, text: 'A' });
    sink({ kind: EventKind.Reasoning, text: 'B' });
    vi.runAllTimers();
    expect(part.parts).toHaveLength(1);
    expect(part.parts[0]).toMatchObject({ type: 'reasoning', text: 'AB' });
    expect(bump).toHaveBeenCalledTimes(1); // throttled
    expect(part.version).toBe(2);
  });

  it('reasoning → text → reasoning creates two separate blocks (not merged across non-reasoning)', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    sink({ kind: EventKind.Reasoning, text: 'Round 1 thinking...' });
    sink({ kind: EventKind.Text, text: 'Tool output analysis' });
    sink({ kind: EventKind.Message }); // finalise text
    sink({ kind: EventKind.Reasoning, text: 'Round 2 thinking...' });
    vi.runAllTimers();
    expect(part.parts).toHaveLength(3); // reasoning, text, reasoning
    expect(part.parts[0]).toMatchObject({ type: 'reasoning', text: 'Round 1 thinking...' });
    expect(part.parts[2]).toMatchObject({ type: 'reasoning', text: 'Round 2 thinking...' });
    expect(bump).toHaveBeenCalledTimes(1); // throttled
  });

  it('ignores reasoning with empty text', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    sink({ kind: EventKind.Reasoning, text: '' });
    vi.runAllTimers();
    expect(part.parts).toHaveLength(0);
    expect(bump).not.toHaveBeenCalled();
  });

  // ── Text ──
  it('text → creates a streaming text part', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    flush(sink, { kind: EventKind.Text, text: 'Hello' });
    expect(part.parts).toHaveLength(1);
    expect(part.parts[0]).toMatchObject({ type: 'text', text: 'Hello', finalised: false });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('text → appends to unfinalised part (streaming merge)', () => {
    const part = freshPart();
    part.parts.push({ type: 'text', text: 'Hello', finalised: false });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    flush(sink, { kind: EventKind.Text, text: ' World' });
    expect(part.parts).toHaveLength(1);
    expect(part.parts[0]).toMatchObject({ type: 'text', text: 'Hello World', finalised: false });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('text → new part when last is finalised', () => {
    const part = freshPart();
    part.parts.push({ type: 'text', text: 'Done.', finalised: true });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    flush(sink, { kind: EventKind.Text, text: 'More' });
    expect(part.parts).toHaveLength(2);
    expect(part.parts[1]).toMatchObject({ type: 'text', text: 'More', finalised: false });
  });

  // ── Message ──
  it('message → finalises last text part', () => {
    const part = freshPart();
    part.parts.push({ type: 'text', text: 'streaming...', finalised: false });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    flush(sink, { kind: EventKind.Message });
    expect(part.parts[0]).toMatchObject({ type: 'text', finalised: true });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('message → bumps even when no text part', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    flush(sink, { kind: EventKind.Message });
    expect(part.parts).toHaveLength(0);
    expect(bump).toHaveBeenCalledTimes(1);
  });

  // ── ToolDispatch ──
  it('ToolDispatch → creates tool part, bumps, calls onProgress', () => {
    const part = freshPart();
    const bump = vi.fn();
    const onProgress = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump, onProgress });
    flush(sink, {
      kind: EventKind.ToolDispatch,
      tool: { id: 't1', name: 'read_file', args: '{}', read_only: true, partial: true },
    });
    expect(part.parts).toHaveLength(1);
    expect(part.parts[0]).toMatchObject({ type: 'tool', toolId: 't1', name: 'read_file', status: 'pending' });
    expect(bump).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith('🔧 read_file\n');
  });

  it('ToolDispatch → non-partial is running', () => {
    const part = freshPart();
    const sink = createSubAgentSink({ subPart: part, bump: vi.fn() });
    flush(sink, { kind: EventKind.ToolDispatch, tool: { id: 't2', name: 'write_file', args: '{}', read_only: false } });
    expect(part.parts[0]).toMatchObject({ status: 'running' });
  });

  it('ToolDispatch → upserts when same toolId arrives twice (ToolCallStart + ToolCall)', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    // First dispatch (ToolCallStart: partial=true, args='')
    sink({
      kind: EventKind.ToolDispatch,
      tool: { id: 't1', name: 'search_content', args: '', read_only: true, partial: true },
    });
    // Second dispatch (ToolCall: partial=false, full args)
    sink({
      kind: EventKind.ToolDispatch,
      tool: { id: 't1', name: 'search_content', args: '{"pattern":"test"}', read_only: true, partial: false },
    });
    vi.runAllTimers();
    expect(part.parts).toHaveLength(1); // upserted, not duplicated
    expect(part.parts[0]).toMatchObject({
      type: 'tool',
      toolId: 't1',
      name: 'search_content',
      status: 'running',
      args: '{"pattern":"test"}',
    });
    expect(bump).toHaveBeenCalledTimes(1); // throttled
  });

  // ── ToolProgress ──
  it('ToolProgress → appends output', () => {
    const part = freshPart();
    part.parts.push({
      type: 'tool',
      toolId: 't1',
      name: 'r',
      args: '{}',
      label: 'r',
      readOnly: true,
      status: 'running',
    });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    flush(sink, { kind: EventKind.ToolProgress, tool: { id: 't1', name: 'r', output: 'line\n', read_only: true } });
    expect(part.parts[0]).toMatchObject({ output: 'line\n' });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('ToolProgress → accumulates, one bump (throttled)', () => {
    const part = freshPart();
    part.parts.push({
      type: 'tool',
      toolId: 't1',
      name: 'r',
      args: '{}',
      label: 'r',
      readOnly: true,
      status: 'running',
      output: 'a',
    });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    sink({ kind: EventKind.ToolProgress, tool: { id: 't1', name: 'r', output: 'b', read_only: true } });
    sink({ kind: EventKind.ToolProgress, tool: { id: 't1', name: 'r', output: 'c', read_only: true } });
    vi.runAllTimers();
    expect(part.parts[0]).toMatchObject({ output: 'abc' });
    expect(part.version).toBe(2);
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('ToolProgress → no-op when tool not found', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    sink({ kind: EventKind.ToolProgress, tool: { id: 'x', name: 'x', output: 'x', read_only: true } });
    vi.runAllTimers();
    expect(part.parts).toHaveLength(0);
    expect(bump).not.toHaveBeenCalled();
  });

  // ── ToolResult ──
  it('ToolResult → marks done', () => {
    const part = freshPart();
    part.parts.push({
      type: 'tool',
      toolId: 't1',
      name: 'r',
      args: '{}',
      label: 'r',
      readOnly: true,
      status: 'running',
    });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    flush(sink, { kind: EventKind.ToolResult, tool: { id: 't1', name: 'r', output: 'ok', read_only: true } });
    expect(part.parts[0]).toMatchObject({ status: 'done', output: 'ok' });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('ToolResult → marks error', () => {
    const part = freshPart();
    part.parts.push({
      type: 'tool',
      toolId: 't1',
      name: 'bad',
      args: '{}',
      label: 'bad',
      readOnly: false,
      status: 'running',
    });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    flush(sink, { kind: EventKind.ToolResult, tool: { id: 't1', name: 'bad', err: 'broke', read_only: false } });
    expect(part.parts[0]).toMatchObject({ status: 'error', err: 'broke' });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('ToolResult → sets truncated', () => {
    const part = freshPart();
    part.parts.push({
      type: 'tool',
      toolId: 't1',
      name: 'big',
      args: '{}',
      label: 'big',
      readOnly: true,
      status: 'running',
    });
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    flush(sink, {
      kind: EventKind.ToolResult,
      tool: { id: 't1', name: 'big', output: '...', read_only: true, truncated: true },
    });
    expect(part.parts[0]).toMatchObject({ truncated: true });
  });

  // ── Ignored events ──
  it('unknown events ignored', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    sink({ kind: EventKind.TurnStarted });
    sink({ kind: EventKind.SessionChanged });
    sink({ kind: EventKind.Notice, text: 'hi', level: 'info' });
    vi.runAllTimers();
    expect(part.parts).toHaveLength(0);
    expect(bump).not.toHaveBeenCalled();
  });

  // ── Full sequence ──
  it('full streaming sequence → throttled to one bump', () => {
    const part = freshPart();
    const bump = vi.fn();
    const sink = createSubAgentSink({ subPart: part, bump });
    sink({ kind: EventKind.Reasoning, text: 'Hmm...' });
    sink({ kind: EventKind.Text, text: 'Let me check.' });
    sink({ kind: EventKind.ToolDispatch, tool: { id: 't1', name: 'read_file', args: '{}', read_only: true } });
    sink({ kind: EventKind.ToolProgress, tool: { id: 't1', name: 'read_file', output: 'data', read_only: true } });
    sink({ kind: EventKind.ToolResult, tool: { id: 't1', name: 'read_file', output: 'done', read_only: true } });
    sink({ kind: EventKind.Text, text: ' Done.' });
    sink({ kind: EventKind.Message });
    vi.runAllTimers();
    expect(part.parts).toHaveLength(3);
    expect(part.version).toBe(7); // each mutation increments
    expect(bump).toHaveBeenCalledTimes(1); // one rAF frame
  });
});
