// Standalone MCP test server (plain Node, spawned via stdio by tests).
// Speaks real MCP JSON-RPC over stdin/stdout: initialize / tools/list / tools/call.
// Also emits a notifications/progress when requested, to exercise client progress path.
"use strict";
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
  const id = req.id;
  const method = req.method;
  // Notifications: reply to nothing.
  if (id === undefined) { return; }
  switch (method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'fixture-mcp-server', version: '1.0.0' },
        instructions: 'fixture instructions',
      } });
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: [
        { name: 'greet', description: 'greet a name', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
        { name: 'add', description: 'add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a','b'] } },
        { name: 'slow', description: 'slow tool with progress', inputSchema: { type: 'object', properties: {} } },
      ] } });
      break;
    case 'tools/call': {
      const name = (req.params || {}).name;
      const args = (req.params || {}).arguments || {};
      const progToken = ((req.params || {})._meta || {}).progressToken;
      if (name === 'greet') {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'hello ' + (args.name || '') }] } });
      } else if (name === 'add') {
        const sum = (Number(args.a) || 0) + (Number(args.b) || 0);
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'sum=' + sum }] } });
      } else if (name === 'slow') {
        if (progToken !== undefined) {
          send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: progToken, progress: 1, total: 2, message: 'halfway' } });
        }
        setTimeout(() => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'done slowly' }] } }), 50);
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool: ' + name } });
      }
      break;
    }
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  }
});
