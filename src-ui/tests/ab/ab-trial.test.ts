import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createProvider } from '../../src/provider';
import { buildTrialAgent, countTokens } from './ab-harness';
import { resolveGraphData } from './ab-graph';

const enabled = Boolean(process.env.AB_ARM);

interface TrialVerdict {
  mustContain?: string[];
  fileCheck?: { path: string; contains: string };
}

function checkVerdict(verdict: TrialVerdict, finalText: string, worktree: string): { ok: boolean; why: string } {
  if (verdict.fileCheck) {
    const p = path.join(worktree, verdict.fileCheck.path);
    if (!fs.existsSync(p)) return { ok: false, why: `file missing: ${p}` };
    const content = fs.readFileSync(p, 'utf8');
    if (!content.includes(verdict.fileCheck.contains)) {
      return { ok: false, why: `file missing content: ${verdict.fileCheck.contains}` };
    }
    return { ok: true, why: 'file ok' };
  }
  const lower = finalText.toLowerCase();
  for (const s of verdict.mustContain ?? []) {
    if (lower.includes(s.toLowerCase())) {
      return { ok: true, why: `answer matched: "${s}"` };
    }
  }
  return { ok: false, why: `answer missing all of: ${(verdict.mustContain ?? []).join(' / ')}` };
}

describe.skipIf(!enabled)('AB trial', () => {
  it(
    'runs single trial',
    async () => {
      const arm = process.env.AB_ARM as 'on' | 'off';
      let task = JSON.parse(process.env.AB_TASK_JSON!);
      if (Array.isArray(task)) task = task[0];
      const worktree = process.env.AB_WT!;
      const outPath = process.env.AB_OUT!;
      const graphDb = process.env.AB_GRAPH_DB || '';
      const started = Date.now();

      const graph = resolveGraphData(worktree, graphDb);
      const rawProvider = createProvider({
        kind: 'openai',
        name: 'ab',
        apiKey: process.env.AB_API_KEY!,
        baseUrl: process.env.AB_BASE_URL || 'https://api.deepseek.com',
        model: process.env.AB_MODEL || 'deepseek-v4-flash',
      } as any);
      const { provider, used } = countTokens(rawProvider);
      const { agent } = buildTrialAgent(worktree, graph, arm, provider);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 13 * 60 * 1000);
      try {
        await agent.run(controller.signal, task.prompt);
      } finally {
        clearTimeout(timer);
      }

      const messages = agent.getSession();
      const toolCalls = messages.filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
      const toolNames = messages
        .filter((m) => m.role === 'assistant' && m.tool_calls)
        .flatMap((m) => m.tool_calls!.map((tc) => tc.name));
      const finalAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
      const finalText = finalAssistant?.content ?? '';
      const verdict = checkVerdict(task.verdict, finalText, worktree);

      const result = {
        taskId: task.id,
        arm,
        success: verdict.ok,
        why: verdict.why,
        tokens: used(),
        toolCallEvents: toolCalls,
        toolCalls: toolNames.length,
        toolNames,
        durationMs: Date.now() - started,
        finalAnswer: finalText.slice(0, 600),
      };
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

      expect(verdict.ok, `verdict failed: ${verdict.why}`).toBe(true);
    },
    14 * 60 * 1000,
  );
});
