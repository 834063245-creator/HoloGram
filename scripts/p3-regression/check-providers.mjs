#!/usr/bin/env node
// P3 真机回归 — API 级预检（不带 App）。
// Key 只从环境变量读取：DEEPSEEK_KEY / ANTHROPIC_KEY / GLM_KEY / OLLAMA_BASE_URL（默认 http://localhost:11434/v1）
// 用法：node check-providers.mjs

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
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

async function checkOpenAiToolCall(label, baseUrl, apiKey, model) {
  const data = await chatCompletion(`${baseUrl}/chat/completions`, apiKey, {
    model,
    temperature: 0,
    max_tokens: 512,
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
  return hasToolCall;
}

async function checkOpenAiTranslate(label, baseUrl, apiKey, model) {
  const data = await chatCompletion(`${baseUrl}/chat/completions`, apiKey, {
    model,
    temperature: 0,
    max_tokens: 256,
    messages: [
      { role: 'system', content: 'Translate the user text to English. Output only the translation.' },
      { role: 'user', content: '深空代码拓扑观测站' },
    ],
  });
  const text = data.choices?.[0]?.message?.content ?? '';
  const ok = text.trim().length > 0;
  record(`${label} 翻译器`, ok, ok ? text.trim().slice(0, 60) : 'empty reply');
  return ok;
}

async function checkAnthropicToolCall(apiKey, model = 'claude-sonnet-4-6') {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
      messages: [
        { role: 'user', content: 'Read src/main.ts and summarize its first import.' },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const hasToolUse = data.stop_reason === 'tool_use';
  record('Anthropic 带工具一轮', hasToolUse, hasToolUse ? 'stop_reason=tool_use' : `stop_reason=${data.stop_reason}`);
  return hasToolUse;
}

async function checkAnthropicTranslate(apiKey, model = 'claude-sonnet-4-6') {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
  return ok;
}

async function checkModelsList(label, baseUrl, apiKey) {
  const res = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const ids = data.data?.map((m) => m.id) ?? [];
  record(`${label} /models 枚举`, ids.length > 0, `${ids.length} models`);
  return ids.length > 0;
}

const checks = [];
if (process.env.DEEPSEEK_KEY) {
  checks.push(checkOpenAiToolCall('DeepSeek', 'https://api.deepseek.com/v1', process.env.DEEPSEEK_KEY, 'deepseek-v4-pro'));
  checks.push(checkOpenAiTranslate('DeepSeek', 'https://api.deepseek.com/v1', process.env.DEEPSEEK_KEY, 'deepseek-v4-pro'));
  checks.push(checkModelsList('DeepSeek', 'https://api.deepseek.com/v1', process.env.DEEPSEEK_KEY));
} else {
  console.log('SKIP  DeepSeek（未设置 DEEPSEEK_KEY）');
}

if (process.env.ANTHROPIC_KEY) {
  checks.push(checkAnthropicToolCall(process.env.ANTHROPIC_KEY));
  checks.push(checkAnthropicTranslate(process.env.ANTHROPIC_KEY));
} else {
  console.log('SKIP  Anthropic（未设置 ANTHROPIC_KEY）');
}

if (process.env.GLM_KEY) {
  checks.push(checkOpenAiToolCall('GLM', 'https://open.bigmodel.cn/api/paas/v4', process.env.GLM_KEY, 'glm-4.5'));
  checks.push(checkModelsList('GLM', 'https://open.bigmodel.cn/api/paas/v4', process.env.GLM_KEY));
} else {
  console.log('SKIP  GLM（未设置 GLM_KEY）');
}

const ollamaBase = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';
try {
  await checkModelsList('Ollama', ollamaBase, '');
} catch (e) {
  console.log(`SKIP  Ollama（本地服务不可用: ${e.message.slice(0, 80)}）`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length > 0 ? 1 : 0);
