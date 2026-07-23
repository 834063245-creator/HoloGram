// 把 assets/icon.svg 渲染成高清 PNG 头像（无头 Chrome 截图）
// 用法: node scripts/render-icon.cjs [size] [outPng]
//   默认: node scripts/render-icon.cjs 1024 assets/avatar-1024.png
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const size = parseInt(process.argv[2] || '1024', 10);
const out = path.resolve(process.argv[3] || `assets/avatar-${size}.png`);

const svgPath = path.resolve(__dirname, '../assets/icon.svg');
let svg = fs.readFileSync(svgPath, 'utf8');
// 根元素放大到目标尺寸（viewBox 不变，内部矢量自动缩放）
svg = svg.replace('width="512" height="512"', `width="${size}" height="${size}"`);

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent}
  svg{display:block}
</style></head><body>${svg}</body></html>`;

const tmpHtml = path.join(os.tmpdir(), `hologram-icon-${size}.html`);
fs.writeFileSync(tmpHtml, html);

execFileSync(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    `--window-size=${size},${size}`,
    `--screenshot=${out}`,
    `file:///${tmpHtml.replace(/\\/g, '/')}`,
  ],
  { stdio: 'inherit' },
);

fs.unlinkSync(tmpHtml);
console.log(`OK ${out} (${size}x${size})`);
