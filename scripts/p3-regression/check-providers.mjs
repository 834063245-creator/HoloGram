#!/usr/bin/env node
// P3 真机回归 — API 级预检（不带 App）。
// Key 来源（按优先级）：
//   1. --from-stdin：stdin 传 JSON { deepseek, glm, anthropic, ... }
//      （由本机解密 credentials.enc 后管道传入，不落盘、不打印）
//   2. 环境变量：DEEPSEEK_KEY / GLM_KEY / ANTHROPIC_KEY
// 模型从 /models 自动发现，避免目录中的占位模型名打到真 API。
// 用法：
//   node check-providers.mjs --from-stdin
//   $env:DEEPSEEK_KEY='sk-...'; node check-providers.mjs

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function chatCompletion(url, apiKey, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function pickOpenAiModel(baseUrl, apiKey, prefer) {
  const data = await getJson(`${baseUrl}/models`, { authorization: `Bearer ${apiKey}` });
  const ids = (data.data?.map((m) => m.id) ?? [])
    .filter((id) => !/embed|rerank|tts|whisper|moderation/i.test(id));
  if (ids.length === 0) throw new Error('no chat model in /models');
  for (const p of prefer) {
    const hit = ids.find((id) => id.includes(p));
    if (hit) return hit;
  }
  return ids[0];
}

async function checkOpenAiToolCall(label, baseUrl, apiKey, model) {
  const data = await chatCompletion(`${baseUrl}/chat/completions`, apiKey, {
    model,
    temperature: 0,
    max_tokens: 1024,
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file_content',
          description: 'Read a file from disk',
          parameters: {
            type: 'object',
            properties: { filePath: { type: 'string' } },
            required: ['filePath'],
          },
        },
      },
    ],
    messages: [
      { role: 'system', content: 'You must call read_file_content to answer.' },
      { role: 'user', content: 'Read src/main.ts and summarize its first import.' },
    ],
  });
  const msg = data.choices?.[0]?.message;
  const hasToolCall = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
  record(`${label} 带工具一轮`, hasToolCall, hasToolCall ? `tool=${msg.tool_calls[0].function.name}` : 'no tool_calls');
}

async function checkOpenAiTranslate(label, baseUrl, apiKey, model) {
  const data = await chatCompletion(`${baseUrl}/chat/completions`, apiKey, {
    model,
    temperature: 0,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: 'Translate the user text to English. Output only the translation.' },
      { role: 'user', content: '深空代码拓扑观测站' },
    ],
  });
  const text = data.choices?.[0]?.message?.content ?? '';
  const ok = text.trim().length > 0;
  record(`${label} 翻译器`, ok, ok ? text.trim().slice(0, 60) : 'empty reply');
}

async function checkOpenAiProvider(label, baseUrl, apiKey, prefer) {
  let model;
  try {
    model = await pickOpenAiModel(baseUrl, apiKey, prefer);
  } catch (e) {
    record(`${label} /models 发现`, false, e.message.slice(0, 120));
    return;
  }
  record(`${label} /models 发现`, true, model);
  await checkOpenAiToolCall(label, baseUrl, apiKey, model);
  await checkOpenAiTranslate(label, baseUrl, apiKey, model);
}

async function checkAnthropicToolCall(apiKey, baseUrl, model) {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      tools: [
        {
          name: 'read_file_content',
          description: 'Read a file from disk',
          input_schema: {
            type: 'object',
            properties: { filePath: { type: 'string' } },
            required: ['filePath'],
          },
        },
      ],
      messages: [{ role: 'user', content: 'Read src/main.ts and summarize its first import.' }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const hasToolUse = data.stop_reason === 'tool_use';
  record('Anthropic 带工具一轮', hasToolUse, hasToolUse ? 'stop_reason=tool_use' : `stop_reason=${data.stop_reason}`);
}

async function checkAnthropicTranslate(apiKey, baseUrl, model) {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      system: 'Translate the user text to English. Output only the translation.',
      messages: [{ role: 'user', content: '深空代码拓扑观测站' }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const out = data.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '';
  const ok = out.trim().length > 0;
  record('Anthropic 翻译器', ok, ok ? out.trim().slice(0, 60) : 'empty reply');
}

async function pickAnthropicModel(apiKey, baseUrl) {
  try {
    const data = await getJson(`${baseUrl}/v1/models`, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    });
    const ids = (data.data ?? [])
      .filter((m) => !m.type || m.type === 'model')
      .map((m) => m.id)
      .filter((id) => !/opus/i.test(id));
    if (ids.length === 0) return null;
    return ids.find((id) => /sonnet/i.test(id)) ?? ids.find((id) => /haiku/i.test(id)) ?? ids[0];
  } catch {
    return null;
  }
}

async function checkAnthropicProvider(apiKey, baseUrl) {
  const model = (await pickAnthropicModel(apiKey, baseUrl)) ?? process.env.ANTHROPIC_MODEL;
  if (!model) {
    record('Anthropic 模型发现', false, '无可用模型且未设置 ANTHROPIC_MODEL');
    return;
  }
  record('Anthropic 模型发现', true, model);
  await checkAnthropicToolCall(apiKey, baseUrl, model);
  await checkAnthropicTranslate(apiKey, baseUrl, model);
}

async function main() {
  const fromStdin = process.argv.includes('--from-stdin');
  let creds = {};
  if (fromStdin) {
    const raw = await new Promise((resolve) => {
      let s = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => (s += d));
      process.stdin.on('end', () => resolve(s));
    });
    try {
      creds = JSON.parse(raw || '{}');
    } catch {
      console.error('FAIL  stdin 凭据 JSON 解析失败');
      process.exit(2);
    }
    console.log(`凭据来源: credentials.enc（${Object.keys(creds).length} 个 provider，不落盘）`);
  } else {
    console.log('凭据来源: 环境变量');
  }

  const pick = (...names) => {
    for (const n of names) if (creds[n]) return creds[n];
    return undefined;
  };

  const deepseekKey = pick('deepseek') ?? process.env.DEEPSEEK_KEY;
  if (deepseekKey) {
    await checkOpenAiProvider('DeepSeek', 'https://api.deepseek.com/v1', deepseekKey, ['deepseek-chat', 'deepseek-v4', 'deepseek']);
  } else {
    console.log('SKIP  DeepSeek（无凭据）');
  }

  const glmKey = pick('glm', 'GLM') ?? process.env.GLM_KEY;
  if (glmKey) {
    await checkOpenAiProvider('GLM', 'https://open.bigmodel.cn/api/paas/v4', glmKey, ['glm-4.5', 'glm-4.6', 'glm-4']);
  } else {
    console.log('SKIP  GLM（无凭据）');
  }

  const anthropicKey = pick('anthropic') ?? process.env.ANTHROPIC_KEY;
  if (anthropicKey) {
    await checkAnthropicProvider(anthropicKey, process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com');
  } else {
    console.log('SKIP  Anthropic（无凭据）');
  }

  const ollamaBase = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';
  try {
    const data = await getJson(`${ollamaBase}/models`, {});
    const ids = (data.data?.map((m) => m.id) ?? []).filter((id) => !/embed|rerank/i.test(id));
    if (ids.length === 0) {
      console.log('SKIP  Ollama（/models 无可用模型）');
    } else {
      const model =
        ids.find((id) => /qwen2\.5-coder/i.test(id)) ?? ids.find((id) => /llama3\.1/i.test(id)) ?? ids[0];
      await checkOpenAiToolCall('Ollama', ollamaBase, '', model);
      await checkOpenAiTranslate('Ollama', ollamaBase, '', model);
    }
  } catch (e) {
    console.log(`SKIP  Ollama（本地服务不可用: ${e.message.slice(0, 80)}）`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
