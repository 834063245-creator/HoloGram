// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { MessageBus } from '../src/agent/message-bus';
import type { AgentAddress, AgentMessage } from '../src/agent/message-types';
import {
  AgentNotFoundError,
  InboxFullError,
  MessageNotFoundError,
  TopologyDeniedError,
} from '../src/agent/message-types';
import { MeshTopology, StarTopology, TreeTopology } from '../src/agent/topology';

// ── Helpers ──

function addr(agentId: string, parentId: string | null = null, depth = 0): AgentAddress {
  return { agentId, parentId, depth };
}

function makeBus(): MessageBus {
  return new MessageBus();
}

function setupTree(): { bus: MessageBus; parent: string; child1: string; child2: string; sibling: string } {
  const bus = makeBus();
  const parent = 'parent';
  const child1 = 'child1';
  const child2 = 'child2';
  const sibling = 'sibling'; // child of a different parent
  bus.register(addr(parent));
  bus.register(addr(child1, parent, 1));
  bus.register(addr(child2, parent, 1));
  bus.register(addr(sibling, 'other-parent', 1));
  bus.setTopology(new TreeTopology());
  return { bus, parent, child1, child2, sibling };
}

// ═══════════════════════════════════════════════════════
// send / receive
// ═══════════════════════════════════════════════════════

describe('MessageBus — send & receive', () => {
  it('test_message_bus_send_receive', () => {
    const { bus, parent, child1 } = setupTree();
    const msgId = bus.send({ from: parent, to: child1, type: 'question', payload: 'hello' });
    expect(msgId).toBeTruthy();
    expect(msgId.startsWith('msg-')).toBe(true);

    const inbox = bus.peekInbox(child1);
    expect(inbox.length).toBe(1);
    expect(inbox[0].from).toBe(parent);
    expect(inbox[0].to).toBe(child1);
    expect(inbox[0].type).toBe('question');
    expect(inbox[0].payload).toBe('hello');
  });

  it('send throws TopologyDeniedError when not allowed', () => {
    const { bus, child1, sibling } = setupTree();
    // child1 and sibling are not parent-child → tree denies
    expect(() => bus.send({ from: child1, to: sibling, type: 'msg', payload: 'x' })).toThrow(TopologyDeniedError);
  });

  it('send throws AgentNotFoundError for unknown agent', () => {
    const { bus, parent } = setupTree();
    bus.setTopology(new MeshTopology()); // allow any
    expect(() => bus.send({ from: parent, to: 'nonexistent', type: 'msg', payload: 'x' })).toThrow(AgentNotFoundError);
  });

  it('unreadCount returns correct count', () => {
    const { bus, parent, child1 } = setupTree();
    bus.send({ from: parent, to: child1, type: 'msg', payload: '1' });
    bus.send({ from: parent, to: child1, type: 'msg', payload: '2' });
    expect(bus.unreadCount(child1)).toBe(2);
    expect(bus.unreadCount(parent)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════
// broadcast
// ═══════════════════════════════════════════════════════

describe('MessageBus — broadcast', () => {
  it('test_message_bus_broadcast', () => {
    const { bus, parent, child1, child2, sibling } = setupTree();
    bus.setTopology(new MeshTopology()); // mesh allows all
    const delivered = bus.broadcast(parent, 'status', 'update');
    // parent is excluded; child1, child2, sibling should all receive
    expect(delivered).toContain(child1);
    expect(delivered).toContain(child2);
    expect(delivered).toContain(sibling);
    expect(delivered).not.toContain(parent);
    expect(bus.peekInbox(child1).length).toBe(1);
    expect(bus.peekInbox(child2).length).toBe(1);
    expect(bus.peekInbox(sibling).length).toBe(1);
  });

  it('test_topology_broadcast_respects — tree only delivers to children', () => {
    const { bus, parent, child1, child2, sibling } = setupTree();
    // TreeTopology: parent can only broadcast to its direct children
    const delivered = bus.broadcast(parent, 'status', 'update');
    expect(delivered).toContain(child1);
    expect(delivered).toContain(child2);
    expect(delivered).not.toContain(sibling); // sibling is not a child of parent
    expect(bus.peekInbox(child1).length).toBe(1);
    expect(bus.peekInbox(sibling).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════
// reply
// ═══════════════════════════════════════════════════════

describe('MessageBus — reply', () => {
  it('test_message_bus_reply', () => {
    const { bus, parent, child1 } = setupTree();
    const msgId = bus.send({ from: parent, to: child1, type: 'question', payload: 'what is 2+2?' });

    // child1 replies
    const replyId = bus.reply(child1, msgId, '4');
    expect(replyId).toBeTruthy();

    // original message removed from child1's inbox (auto-ack)
    expect(bus.peekInbox(child1).length).toBe(0);

    // reply delivered to parent
    const parentInbox = bus.peekInbox(parent);
    expect(parentInbox.length).toBe(1);
    expect(parentInbox[0].from).toBe(child1);
    expect(parentInbox[0].to).toBe(parent);
    expect(parentInbox[0].replyTo).toBe(msgId);
    expect(parentInbox[0].payload).toBe('4');
  });

  it('test_reply_wrong_agent — cannot reply to another agent message', () => {
    const { bus, parent, child1, child2 } = setupTree();
    // parent sends to child1
    const msgId = bus.send({ from: parent, to: child1, type: 'msg', payload: 'for child1' });

    // child2 tries to reply — should fail (message not in child2's inbox)
    expect(() => bus.reply(child2, msgId, 'intercepted')).toThrow(MessageNotFoundError);
  });

  it('reply throws MessageNotFoundError for unknown msgId', () => {
    const { bus, child1 } = setupTree();
    expect(() => bus.reply(child1, 'nonexistent-msg', 'reply')).toThrow(MessageNotFoundError);
  });

  it('reply preserves original message when topology denies delivery', () => {
    // Bug 4: reply() should not ack (remove) original message if delivery fails
    const bus = new MessageBus();
    bus.register(addr('a', null, 0));
    bus.register(addr('b', 'a', 1));
    bus.register(addr('c', 'a', 1));
    bus.setTopology(new TreeTopology());

    // a sends to b
    bus.send({ from: 'a', to: 'b', type: 'msg', payload: 'hello' });
    expect(bus.peekInbox('b').length).toBe(1);

    // Now switch to a topology that blocks b → a
    bus.setTopology(new MeshTopology()); // temporarily allow for setup
    bus.setTopology(new TreeTopology()); // back to tree — b→a is allowed in tree
    // Actually tree allows child→parent, so let's test with sibling
    // b tries to reply to a message that came from c — but b can't reach c
    // Let's send from c to b first (via mesh)
    bus.setTopology(new MeshTopology());
    const msgFromC = bus.send({ from: 'c', to: 'b', type: 'msg', payload: 'from c' });
    expect(bus.peekInbox('b').length).toBe(2);

    // Now switch to tree — b can reach parent (a) but not sibling (c)
    bus.setTopology(new TreeTopology());

    // b tries to reply to c's message — tree blocks b→c
    expect(() => bus.reply('b', msgFromC, 'reply to c')).toThrow(TopologyDeniedError);

    // Original message from c should still be in b's inbox (not acked)
    const inbox = bus.peekInbox('b');
    expect(inbox.length).toBe(2); // both messages still there
    expect(inbox.some((m) => m.id === msgFromC)).toBe(true);
  });

  it('reply preserves original message when target agent unregistered', () => {
    // Bug 5: reply() should not silently succeed when target is gone
    const bus = new MessageBus();
    bus.register(addr('a', null, 0));
    bus.register(addr('b', 'a', 1));
    bus.setTopology(new TreeTopology());

    // a sends to b
    const msgId = bus.send({ from: 'a', to: 'b', type: 'msg', payload: 'hello' });
    expect(bus.peekInbox('b').length).toBe(1);

    // a unregisters
    bus.unregister('a');

    // b tries to reply to a — should throw AgentNotFoundError
    expect(() => bus.reply('b', msgId, 'reply')).toThrow(AgentNotFoundError);

    // Original message should still be in b's inbox (not acked)
    expect(bus.peekInbox('b').length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════
// ack
// ═══════════════════════════════════════════════════════

describe('MessageBus — ack', () => {
  it('test_message_bus_ack', () => {
    const { bus, parent, child1 } = setupTree();
    const msgId = bus.send({ from: parent, to: child1, type: 'msg', payload: 'hello' });
    expect(bus.peekInbox(child1).length).toBe(1);

    const ok = bus.ackMessage(child1, msgId);
    expect(ok).toBe(true);
    expect(bus.peekInbox(child1).length).toBe(0);
    expect(bus.unreadCount(child1)).toBe(0);
  });

  it('ack returns false for unknown msgId', () => {
    const { bus, child1 } = setupTree();
    const ok = bus.ackMessage(child1, 'nonexistent');
    expect(ok).toBe(false);
  });

  it('ack returns false for wrong agent', () => {
    const { bus, parent, child1 } = setupTree();
    const msgId = bus.send({ from: parent, to: child1, type: 'msg', payload: 'hello' });
    // parent tries to ack a message in child1's inbox
    const ok = bus.ackMessage(parent, msgId);
    expect(ok).toBe(false);
    // message still in child1's inbox
    expect(bus.peekInbox(child1).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════
// peek does not consume
// ═══════════════════════════════════════════════════════

describe('MessageBus — peek does not consume', () => {
  it('test_inbox_peek_does_not_consume', () => {
    const { bus, parent, child1 } = setupTree();
    bus.send({ from: parent, to: child1, type: 'msg', payload: 'hello' });

    // peek multiple times — message should still be there
    expect(bus.peekInbox(child1).length).toBe(1);
    expect(bus.peekInbox(child1).length).toBe(1);
    expect(bus.unreadCount(child1)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════
// topology
// ═══════════════════════════════════════════════════════

describe('MessageBus — topology', () => {
  it('test_topology_tree — parent↔child allowed, sibling↔sibling denied', () => {
    const { bus, parent, child1, child2, sibling } = setupTree();

    // parent → child: allowed
    expect(bus.getTopology().canSend(parent, child1, bus)).toBe(true);
    // child → parent: allowed
    expect(bus.getTopology().canSend(child1, parent, bus)).toBe(true);
    // child1 → child2 (siblings): denied
    expect(bus.getTopology().canSend(child1, child2, bus)).toBe(false);
    // child1 → sibling: denied
    expect(bus.getTopology().canSend(child1, sibling, bus)).toBe(false);
  });

  it('test_topology_mesh — all communication allowed', () => {
    const { bus, parent, child1, child2, sibling } = setupTree();
    bus.setTopology(new MeshTopology());

    expect(bus.getTopology().canSend(parent, child1, bus)).toBe(true);
    expect(bus.getTopology().canSend(child1, child2, bus)).toBe(true);
    expect(bus.getTopology().canSend(child1, sibling, bus)).toBe(true);
    // self is denied
    expect(bus.getTopology().canSend(child1, child1, bus)).toBe(false);
  });

  it('test_topology_star — center can talk to all, spokes only to center', () => {
    const { bus, parent, child1, child2 } = setupTree();
    bus.setTopology(new StarTopology(parent));

    // center → spoke: allowed
    expect(bus.getTopology().canSend(parent, child1, bus)).toBe(true);
    // spoke → center: allowed
    expect(bus.getTopology().canSend(child1, parent, bus)).toBe(true);
    // spoke → spoke: denied
    expect(bus.getTopology().canSend(child1, child2, bus)).toBe(false);
  });

  it('allowedTargets returns correct list for tree', () => {
    const { bus, parent, child1, child2, sibling } = setupTree();
    // parent can talk to child1 and child2
    const targets = bus.getTopology().allowedTargets(parent, bus);
    expect(targets).toContain(child1);
    expect(targets).toContain(child2);
    expect(targets).not.toContain(sibling);
    expect(targets).not.toContain(parent);
  });

  it('allowedTargets returns correct list for mesh', () => {
    const { bus, parent, child1, child2, sibling } = setupTree();
    bus.setTopology(new MeshTopology());
    const targets = bus.getTopology().allowedTargets(parent, bus);
    expect(targets).toContain(child1);
    expect(targets).toContain(child2);
    expect(targets).toContain(sibling);
    expect(targets).not.toContain(parent);
  });
});

// ═══════════════════════════════════════════════════════
// backpressure
// ═══════════════════════════════════════════════════════

describe('MessageBus — backpressure', () => {
  it('test_backpressure_reject — inbox full throws InboxFullError', () => {
    const { bus, parent, child1 } = setupTree();
    bus.setInboxCapacity(3);
    bus.setBackpressureStrategy('reject');

    bus.send({ from: parent, to: child1, type: 'msg', payload: '1' });
    bus.send({ from: parent, to: child1, type: 'msg', payload: '2' });
    bus.send({ from: parent, to: child1, type: 'msg', payload: '3' });

    // 4th message should throw
    expect(() => bus.send({ from: parent, to: child1, type: 'msg', payload: '4' })).toThrow(InboxFullError);
    // inbox still has 3 messages
    expect(bus.peekInbox(child1).length).toBe(3);
  });

  it('test_backpressure_drop — oldest message dropped when inbox full', () => {
    const { bus, parent, child1 } = setupTree();
    bus.setInboxCapacity(3);
    bus.setBackpressureStrategy('drop');

    bus.send({ from: parent, to: child1, type: 'msg', payload: '1' });
    bus.send({ from: parent, to: child1, type: 'msg', payload: '2' });
    bus.send({ from: parent, to: child1, type: 'msg', payload: '3' });
    bus.send({ from: parent, to: child1, type: 'msg', payload: '4' });

    const inbox = bus.peekInbox(child1);
    expect(inbox.length).toBe(3);
    // oldest ('1') should have been dropped
    expect(inbox[0].payload).toBe('2');
    expect(inbox[1].payload).toBe('3');
    expect(inbox[2].payload).toBe('4');
  });
});

// ═══════════════════════════════════════════════════════
// unregister
// ═══════════════════════════════════════════════════════

describe('MessageBus — unregister', () => {
  it('test_agent_unregister — messages not delivered after unregister', () => {
    const { bus, parent, child1 } = setupTree();
    bus.send({ from: parent, to: child1, type: 'msg', payload: 'before' });
    expect(bus.peekInbox(child1).length).toBe(1);

    bus.unregister(child1);

    // send should fail — agent not found
    expect(() => bus.send({ from: parent, to: child1, type: 'msg', payload: 'after' })).toThrow(AgentNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════
// subscribe
// ═══════════════════════════════════════════════════════

describe('MessageBus — subscribe', () => {
  it('test_subscribe_unsubscribe', () => {
    const { bus, parent, child1 } = setupTree();
    const received: string[] = [];
    const unsub = bus.subscribe({ from: parent }, (msg) => {
      received.push(msg.payload as string);
    });

    bus.send({ from: parent, to: child1, type: 'msg', payload: 'hello' });
    bus.send({ from: parent, to: child1, type: 'msg', payload: 'world' });

    expect(received).toEqual(['hello', 'world']);

    unsub();
    bus.send({ from: parent, to: child1, type: 'msg', payload: 'after-unsub' });
    expect(received).toEqual(['hello', 'world']);
  });

  it('subscribe filters by type', () => {
    const { bus, parent, child1 } = setupTree();
    const received: string[] = [];
    bus.subscribe({ type: 'status' }, (msg) => {
      received.push(msg.payload as string);
    });

    bus.send({ from: parent, to: child1, type: 'question', payload: 'q1' });
    bus.send({ from: parent, to: child1, type: 'status', payload: 's1' });
    bus.send({ from: parent, to: child1, type: 'question', payload: 'q2' });
    bus.send({ from: parent, to: child1, type: 'status', payload: 's2' });

    expect(received).toEqual(['s1', 's2']);
  });

  it('subscribe filters by type array', () => {
    const { bus, parent, child1 } = setupTree();
    const received: string[] = [];
    bus.subscribe({ type: ['status', 'alert'] }, (msg) => {
      received.push(msg.payload as string);
    });

    bus.send({ from: parent, to: child1, type: 'question', payload: 'q1' });
    bus.send({ from: parent, to: child1, type: 'status', payload: 's1' });
    bus.send({ from: parent, to: child1, type: 'alert', payload: 'a1' });

    expect(received).toEqual(['s1', 'a1']);
  });

  it('subscribe with predicate', () => {
    const { bus, parent, child1 } = setupTree();
    const received: string[] = [];
    bus.subscribe(
      { predicate: (msg) => typeof msg.payload === 'string' && msg.payload.startsWith('IMPORTANT') },
      (msg) => received.push(msg.payload as string),
    );

    bus.send({ from: parent, to: child1, type: 'msg', payload: 'normal' });
    bus.send({ from: parent, to: child1, type: 'msg', payload: 'IMPORTANT: do this' });

    expect(received).toEqual(['IMPORTANT: do this']);
  });
});

// ═══════════════════════════════════════════════════════
// flush / restore (no-op without store)
// ═══════════════════════════════════════════════════════

describe('MessageBus — flush & restore', () => {
  it('test_flush_noop_without_store', async () => {
    const bus = makeBus();
    bus.register(addr('a'));
    bus.register(addr('b'));
    bus.setTopology(new MeshTopology());
    bus.send({ from: 'a', to: 'b', type: 'msg', payload: 'hello' });

    // flush and restore should be no-ops without a store
    await expect(bus.flush()).resolves.toBeUndefined();
    await expect(bus.restore()).resolves.toBeUndefined();

    // inbox should be unchanged
    expect(bus.peekInbox('b').length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════
// Transport interface
// ═══════════════════════════════════════════════════════

describe('MessageBus — transport', () => {
  it('uses custom transport when provided', () => {
    const delivered: Array<{ agentId: string; msg: AgentMessage }> = [];
    const customTransport = {
      deliver(agentId: string, msg: AgentMessage) {
        delivered.push({ agentId, msg });
      },
    };
    const bus = new MessageBus(customTransport);
    bus.register(addr('a', null, 0));
    bus.register(addr('b', 'a', 1));
    bus.setTopology(new MeshTopology());

    bus.send({ from: 'a', to: 'b', type: 'msg', payload: 'hello' });

    expect(delivered.length).toBe(1);
    expect(delivered[0].agentId).toBe('b');
    expect(delivered[0].msg.payload).toBe('hello');
  });

  it('default InProcessTransport delivers to inbox', () => {
    const { bus, parent, child1 } = setupTree();
    bus.send({ from: parent, to: child1, type: 'msg', payload: 'hello' });
    expect(bus.peekInbox(child1).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════
// Communication tools error propagation
// ═══════════════════════════════════════════════════════

describe('MessageBus — error propagation', () => {
  it('topology denied error has from and to', () => {
    const { bus, child1, sibling } = setupTree();
    try {
      bus.send({ from: child1, to: sibling, type: 'msg', payload: 'x' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TopologyDeniedError);
      expect((e as TopologyDeniedError).from).toBe(child1);
      expect((e as TopologyDeniedError).to).toBe(sibling);
    }
  });

  it('agent not found error has agentId', () => {
    const { bus, parent } = setupTree();
    bus.setTopology(new MeshTopology());
    try {
      bus.send({ from: parent, to: 'ghost', type: 'msg', payload: 'x' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AgentNotFoundError);
      expect((e as AgentNotFoundError).agentId).toBe('ghost');
    }
  });

  it('inbox full error has agentId', () => {
    const { bus, parent, child1 } = setupTree();
    bus.setInboxCapacity(1);
    bus.setBackpressureStrategy('reject');
    bus.send({ from: parent, to: child1, type: 'msg', payload: '1' });
    try {
      bus.send({ from: parent, to: child1, type: 'msg', payload: '2' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InboxFullError);
      expect((e as InboxFullError).agentId).toBe(child1);
    }
  });

  it('message not found error has msgId', () => {
    const { bus, child1 } = setupTree();
    try {
      bus.reply(child1, 'ghost-msg', 'reply');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MessageNotFoundError);
      expect((e as MessageNotFoundError).msgId).toBe('ghost-msg');
    }
  });
});

// ═══════════════════════════════════════════════════════
// Communication tools
// ═══════════════════════════════════════════════════════

import type { Tool } from '../src/agent/tool';

function findTool(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name() === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool;
}

describe('Communication tools', () => {
  it('agent_message sends and returns success', async () => {
    const { bus, parent, child1 } = setupTree();
    const { createCommunicationTools } = await import('../src/agent/tools/communication');
    const tools = createCommunicationTools(bus, () => parent);
    const agentMessage = findTool(tools, 'agent_message');
    const result = await agentMessage.execute({ target: child1, type: 'question', content: 'hello' });
    expect(result).toContain('Message sent');
    expect(bus.peekInbox(child1).length).toBe(1);
  });

  it('agent_message returns error string on topology denied', async () => {
    const { bus, child1, sibling } = setupTree();
    const { createCommunicationTools } = await import('../src/agent/tools/communication');
    const tools = createCommunicationTools(bus, () => child1);
    const agentMessage = findTool(tools, 'agent_message');
    const result = await agentMessage.execute({ target: sibling, type: 'msg', content: 'x' });
    expect(result).toContain('Failed: topology denied');
  });

  it('agent_message returns error string on agent not found', async () => {
    const { bus, parent } = setupTree();
    bus.setTopology(new MeshTopology());
    const { createCommunicationTools } = await import('../src/agent/tools/communication');
    const tools = createCommunicationTools(bus, () => parent);
    const agentMessage = findTool(tools, 'agent_message');
    const result = await agentMessage.execute({ target: 'ghost', type: 'msg', content: 'x' });
    expect(result).toContain("Failed: agent 'ghost' not found");
  });

  it('agent_message returns error string on inbox full', async () => {
    const { bus, parent, child1 } = setupTree();
    bus.setInboxCapacity(1);
    bus.setBackpressureStrategy('reject');
    const { createCommunicationTools } = await import('../src/agent/tools/communication');
    const tools = createCommunicationTools(bus, () => parent);
    const agentMessage = findTool(tools, 'agent_message');
    await agentMessage.execute({ target: child1, type: 'msg', content: '1' });
    const result = await agentMessage.execute({ target: child1, type: 'msg', content: '2' });
    expect(result).toContain('Failed: inbox full');
  });

  it('agent_reply sends reply and acks original', async () => {
    const { bus, parent, child1 } = setupTree();
    const msgId = bus.send({ from: parent, to: child1, type: 'question', payload: 'hi' });

    const { createCommunicationTools } = await import('../src/agent/tools/communication');
    const tools = createCommunicationTools(bus, () => child1);
    const agentReply = findTool(tools, 'agent_reply');
    const result = await agentReply.execute({ message_id: msgId, content: 'hello back' });

    expect(result).toContain('Reply sent');
    expect(bus.peekInbox(child1).length).toBe(0); // original acked
    expect(bus.peekInbox(parent).length).toBe(1); // reply delivered
    expect(bus.peekInbox(parent)[0].payload).toBe('hello back');
  });

  it('agent_reply returns error for unknown message', async () => {
    const { bus, child1 } = setupTree();
    const { createCommunicationTools } = await import('../src/agent/tools/communication');
    const tools = createCommunicationTools(bus, () => child1);
    const agentReply = findTool(tools, 'agent_reply');
    const result = await agentReply.execute({ message_id: 'ghost', content: 'reply' });
    expect(result).toContain('Failed: message');
    expect(result).toContain('not found');
  });

  it('agent_ack removes message from inbox', async () => {
    const { bus, parent, child1 } = setupTree();
    const msgId = bus.send({ from: parent, to: child1, type: 'msg', payload: 'hello' });

    const { createCommunicationTools } = await import('../src/agent/tools/communication');
    const tools = createCommunicationTools(bus, () => child1);
    const agentAck = findTool(tools, 'agent_ack');
    const result = await agentAck.execute({ message_id: msgId });

    expect(result).toContain('acknowledged');
    expect(bus.peekInbox(child1).length).toBe(0);
  });

  it('agent_ack returns not found for unknown message', async () => {
    const { bus, child1 } = setupTree();
    const { createCommunicationTools } = await import('../src/agent/tools/communication');
    const tools = createCommunicationTools(bus, () => child1);
    const agentAck = findTool(tools, 'agent_ack');
    const result = await agentAck.execute({ message_id: 'ghost' });
    expect(result).toContain('not found');
  });

  it('agent_inbox lists unread messages', async () => {
    const { bus, parent, child1 } = setupTree();
    bus.send({ from: parent, to: child1, type: 'question', payload: 'hello' });
    bus.send({ from: parent, to: child1, type: 'status', payload: 'done' });

    const { createCommunicationTools } = await import('../src/agent/tools/communication');
    const tools = createCommunicationTools(bus, () => child1);
    const agentInbox = findTool(tools, 'agent_inbox');

    // No params → summary only (id/from/type, no payload)
    const summary = await agentInbox.execute({});
    expect(summary).toContain('msg_id:');
    expect(summary).toContain('from:parent');
    expect(summary).toContain('type:question');
    expect(summary).toContain('type:status');
    expect(summary).not.toContain('hello');

    // With message_id → full content
    const summaryLines = summary;
    const idMatch = summaryLines.match(/msg_id:(msg-[\w-]+)/);
    const firstMsgId = idMatch?.[1];
    const fullResult = await agentInbox.execute({ message_id: firstMsgId });
    expect(fullResult).toContain('hello');
  });

  it('agent_inbox shows empty when no messages', async () => {
    const { bus, child1 } = setupTree();
    const { createCommunicationTools } = await import('../src/agent/tools/communication');
    const tools = createCommunicationTools(bus, () => child1);
    const agentInbox = findTool(tools, 'agent_inbox');
    const result = await agentInbox.execute({});
    expect(result).toContain('inbox empty');
  });

  it('agent_list shows communicable agents', async () => {
    const { bus, parent, child1, child2, sibling } = setupTree();
    const { createCommunicationTools } = await import('../src/agent/tools/communication');
    const tools = createCommunicationTools(bus, () => parent);
    const agentList = findTool(tools, 'agent_list');
    const result = await agentList.execute({});

    expect(result).toContain(child1);
    expect(result).toContain(child2);
    expect(result).not.toContain(sibling); // tree topology, sibling is not a child
  });

  it('agent_list shows empty when no targets', async () => {
    const { bus, sibling } = setupTree();
    const { createCommunicationTools } = await import('../src/agent/tools/communication');
    const tools = createCommunicationTools(bus, () => sibling);
    const agentList = findTool(tools, 'agent_list');
    const result = await agentList.execute({});
    expect(result).toContain('no communicable agents');
  });
});
