// startOwned / ownedDisposer 所有权包装测试（agent-core-convergence Phase 1）。
// 现有 start/stop、disconnect 语义不变；包装器只加"返回清理器"这一层。
import { describe, expect, it } from 'vitest';
import { AgentLifecycleManager } from '../src/agent/lifecycle-manager';
import { SubAgentPool } from '../src/agent/coordinator';
import { TaskBoard } from '../src/agent/task-board';
import { MessageBus } from '../src/agent/message-bus';
import { MeshTopology } from '../src/agent/topology';
import type { ToolExecutor } from '../src/agent/tool';
import { McpClient } from '../src/agent/mcp/client';
import { createLoopbackTransport } from '../src/agent/mcp/transport';

function makeManager(): AgentLifecycleManager {
  const pool = new SubAgentPool();
  const board = new TaskBoard();
  const bus = new MessageBus();
  bus.setTopology(new MeshTopology());
  bus.register({ agentId: 'main', parentId: null, depth: 0 });
  const exec: ToolExecutor = async () => 'ok';
  return new AgentLifecycleManager(pool, board, bus, exec, () => {});
}

describe('AgentLifecycleManager.startOwned', () => {
  it('返回幂等清理器；重复调用与 stop() 混用均安全', () => {
    const mgr = makeManager();
    mgr.start();
    const dispose = mgr.startOwned(); // start 幂等——不产生第二个 timer
    dispose();
    expect(() => dispose()).not.toThrow();
    mgr.stop(); // 已停后再 stop 亦 no-op
  });

  it('dispose 后 isIdle 等查询接口不受影响', () => {
    const mgr = makeManager();
    const dispose = mgr.startOwned();
    dispose();
    expect(mgr.isIdle()).toBe(true);
  });
});

describe('McpClient.ownedDisposer', () => {
  /** 回环 fake server：initialize + tools/list 各回一条响应。 */
  function fakeHandler(line: string): string[] {
    const req = JSON.parse(line);
    if (req.id === undefined) return [];
    if (req.method === 'initialize') {
      return [
        JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'f', version: '1' } },
        }),
      ];
    }
    if (req.method === 'tools/list') {
      return [JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [] } })];
    }
    return [JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'no' } })];
  }

  it('连接后 dispose 断开；重复调用 no-op；未连接时 dispose 安全', async () => {
    const client = new McpClient({ serverName: 'fake', transport: createLoopbackTransport(fakeHandler) });
    // 未连接：disposer 走 disconnect 的 no-op 分支
    const early = client.ownedDisposer();
    await early();

    await client.connect();
    expect(client.isConnected).toBe(true);
    const dispose = client.ownedDisposer();
    await dispose();
    expect(client.isConnected).toBe(false);
    await dispose(); // 幂等
    expect(client.isConnected).toBe(false);
  });
});
