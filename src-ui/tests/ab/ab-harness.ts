import { Agent } from '../../src/agent/agent';
import type { Provider, Usage } from '../../src/provider/types';
import { ChunkType } from '../../src/provider/types';
import {
  buildFileNodeIndex,
  createGraphContext,
  createGraphContextHook,
  createGraphPreflightHook,
  HookRegistry,
  PreflightHookRegistry,
} from '../../src/agent/hooks';
import { buildSystemPrompt } from '../../src/agent/runtime/agent-builder';
import { buildTrialRegistry } from './ab-tools';
import type { TrialGraphData } from './ab-graph';

export interface TrialAgent {
  agent: Agent;
  tokensUsed: () => number;
}

export function countTokens(provider: Provider): { provider: Provider; used: () => number } {
  let total = 0;
  const wrapped: Provider = {
    name: () => provider.name(),
    stream: async function* (signal, req) {
      for await (const chunk of provider.stream(signal, req)) {
        if (chunk.type === ChunkType.Usage && chunk.usage) {
          total += chunk.usage.total_tokens ?? 0;
        }
        yield chunk;
      }
    },
  };
  return { provider: wrapped, used: () => total };
}

export function buildTrialAgent(
  worktree: string,
  graph: TrialGraphData,
  arm: 'on' | 'off',
  provider: Provider,
): TrialAgent {
  const { fileIndex, fanIn, fanOut } = buildFileNodeIndex(graph as any);
  const ctx = createGraphContext(fileIndex, fanIn, fanOut);
  const registry = buildTrialRegistry(worktree, graph);

  const hooks = new HookRegistry();
  const preflightHooks = new PreflightHookRegistry();
  if (arm === 'on') {
    hooks.register(createGraphContextHook(ctx));
    preflightHooks.register(createGraphPreflightHook(ctx));
  }

  const systemPrompt = buildSystemPrompt(graph as any, worktree, '', '', '', 'DeepSeek');
  const agent = new Agent(provider, registry, systemPrompt, {
    agentId: `ab-${arm}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    contextWindow: 131072,
    temperature: 0.2,
  });
  agent.setHooks(hooks);
  agent.setPreflightHooks(preflightHooks);
  return { agent };
}
