// CDP 交互截图：无头 Chrome 里点开聊天信标/面板，验证 P5 迁移后的样式
// 用法: node scripts/cdp-shot.cjs <outPrefix> [actionsJSON]
const { execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9223;
const URL_BASE = 'http://localhost:1420/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: 'localhost', port: PORT, path }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(JSON.parse(d)));
      })
      .on('error', reject);
  });
}

async function main() {
  const prefix = process.argv[2] || '/tmp/cdp';
  const actions = JSON.parse(process.argv[3] || '[]');

  const chrome = spawn(
    CHROME,
    [
      '--headless',
      '--disable-gpu',
      `--remote-debugging-port=${PORT}`,
      '--window-size=2560,1400',
      '--no-first-run',
      '--user-data-dir=/tmp/cdp-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  try {
    let targets;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        targets = await getJson('/json');
        break;
      } catch {}
    }
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));

    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    };
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const mid = ++id;
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      return r.result?.result?.value;
    };

    await send('Page.enable');
    await send('Page.navigate', { url: URL_BASE });
    await sleep(9000); // mock 启动 + 图渲染

    // 内置动作序列: [{js}|{shot:name}|{wait:ms}]
    for (const a of actions) {
      if (a.wait) await sleep(a.wait);
      if (a.js) console.log('eval →', JSON.stringify(await evaluate(a.js))?.slice(0, 300));
      if (a.shot) {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(`${prefix}-${a.shot}.png`, Buffer.from(r.result.data, 'base64'));
        console.log('shot', a.shot);
      }
    }
    ws.close();
  } finally {
    chrome.kill('SIGKILL');
    try {
      execSync(`taskkill //F //PID ${chrome.pid} //T 2>/dev/null`, { stdio: 'ignore' });
    } catch {}
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
