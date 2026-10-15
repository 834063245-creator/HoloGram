// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 动效契约守卫（2026-10-15 §15 动效法立法批）——本文件是「散写时长」这一整类
// 缺陷的钉子，不是某个动画的钉值。全文与判例见 docs/design/lantai-design-spec.md §15。
//
// 病灶（立法前实测）：全仓 54 处 `animation:`/`transition:` 带**字面时长**，
// 同一种动作（浮层递出）在六个文件里写成 0.14s / 0.15s / 0.16s / 0.18s / 0.24s
// 五个值；两条 `var(--pp-grow-dur, 200ms)` / `var(--pp-grow-ease, …)` **全仓从无
// 声明**、只剩 fallback 字面量（且因回退值带逗号，paper-token-audit 的悬空扫描
// 抓不到）；相机飞行的 240 在同一个文件里写了两遍。改一处漏一处。
//
// 三条守卫：
//   ① 退役 token 不得复活（--glide / --pp-grow-*）——改名即删，不留双轨；
//   ② 三档 token 在册，且**结构性动作**必须走 token（带字面时长的声明只许落在
//      §15 登记表内：仪式/信号/环境/连续读数件）；
//   ③ 两条「跨语言镜像」必须同值：相机飞行时长（TS）↔ `--m-sheet`（CSS）、
//      `TOAST_FADE_MS`（TS）↔ `--m-sheet`（CSS）——不同步即红。

// @vitest-environment node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

const TOKENS_CSS = readFileSync(join(SRC, 'app', 'tokens.css'), 'utf8');
const PANEL_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'), 'utf8');
const PANEL_TSX = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.tsx'), 'utf8');
const FOCUS_TS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'use-paper-focus.ts'), 'utf8');
const TOAST_STORE_TS = readFileSync(join(SRC, 'state', 'toast-store.ts'), 'utf8');
const SETTINGS_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'settings-domain', 'settings-panel.css'), 'utf8');
const SETTINGS_TSX = readFileSync(join(SRC, 'plugins', 'builtin', 'settings-domain', 'SettingsPanel.tsx'), 'utf8');
const SETTINGS_INDEX_TS = readFileSync(join(SRC, 'plugins', 'builtin', 'settings-domain', 'index.ts'), 'utf8');
/** 壳层 Provider 页样式（`main.ts` 直接 import ⇒ 烧进 exe）。用于守卫「跨层同选择器」：
 *  凡与页签切换权同选择器的规则，必须与切换权同层（产物），否则会被产物 CSS 按源序顶掉。 */
const PROVIDER_CSS_SHELL = readFileSync(join(SRC, 'app', 'panels', 'dock-panels', 'provider-settings.css'), 'utf8');
const DOCK_TSX = readFileSync(join(SRC, 'app', 'panels', 'DockPanel.tsx'), 'utf8');
const CANVAS_NAV_INDEX_TS = readFileSync(join(SRC, 'plugins', 'builtin', 'canvas-nav', 'index.ts'), 'utf8');
const SPINE_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'canvas-nav', 'spine-rack.css'), 'utf8');
const SIDEBAR_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'canvas-nav', 'session-sidebar.css'), 'utf8');
const CANVAS_VIEW_STORE_TS = readFileSync(join(SRC, 'state', 'canvas-view-store.ts'), 'utf8');
const VIEWPORT_TS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'use-paper-viewport.ts'), 'utf8');

/** 剥 CSS 注释（病灶史注释里点名选择器是留痕，不是使用）——本文件 CSS 断言走它。 */
const stripCssComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');

function allCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allCssFiles(p));
    else if (name.endsWith('.css')) out.push(p);
  }
  return out;
}

/** 取 token 的字面秒数（`--m-sheet: 0.26s cubic-bezier(…)` → 0.26）。 */
function tokenSeconds(name: string): number {
  const m = new RegExp(String.raw`--${name}:\s*([\d.]+)s\b`).exec(TOKENS_CSS);
  expect(m, `tokens.css 缺 --${name}`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}

/** §15 登记表 A：**仪式 / 信号 / 环境**动画——各有自有节拍，不受三档约束。
 *  新增任何一条都必须同批进 §15（未登记 = 散写，本测即红）。 */
const REGISTERED_ANIMATIONS = new Set([
  'sh-stamp', // 首页钤印按下（仪式）
  'sh-rise', // 首页列表分批升起（仪式）
  'pp-seal-draw', // 活卷卷首的朱笔划界（仪式：落笔划界的书写感）
  'pp-breathe', // 画布底缘呼吸线（环境）
  'pp-ink-live', // 落笔点/湿墨尾点/在跑折叠行 同拍呼吸（环境）
  'ss-breathe', // 侧栏运行点（环境）
  'sr-breathe', // 书脊运行点（环境）
  'pp-pulse', // 探测中脉冲（信号）
  'pp-spin', // 加载旋（信号）
  'ms-spin', // 模型列表加载旋（信号）
  'pp-trace-pulse', // 溯源落点一拍即散（信号）
  'pp-hint-fade', // 一次性眉批 6s 自散（存活期，不是节奏）
  'sp-upd-slide', // 检查更新条游走（信号）
]);

/** §15 登记表 B：**连续读数件**的 transition——量在连续变化，不是「一段过程」。 */
const REGISTERED_TRANSITION_PROPS = new Set([
  'width', // 墨量线/进度段：读数随 token 增长，非动作
  'background', // 状态点纸晕（0.5s 缓慢上色，读作信号不是动效）
]);

/** 承载「时长」的 token——出现即视为时长已 token 化（`--snap` = 态变轴同族）。 */
const MOTION_TOKEN = /^var\(--(snap|m-ink|m-sheet|m-scene|m-ease-out|m-ease-io)\)$/;
const TIME_LITERAL = /^[\d.]+m?s$/;

/** 按**顶层**空白/逗号切 token——括号组（cubic-bezier / var / steps）各自成一个 token。 */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && (ch === ' ' || ch === ',' || ch === '\t' || ch === '\n')) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 只按**顶层逗号**切（多动画 / 多属性过渡各成一条，必须独立受判）。 */
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.filter((p) => p.trim() !== '');
}

/** 扫全仓 CSS（注释已剥——注释里提退役 token 是留病史，不是使用）。
 *  只收「带字面时长的 animation/transition」，按顶层逗号拆成单条后逐条判。 */
function literalTimingDeclarations(): { file: string; decl: string }[] {
  const out: { file: string; decl: string }[] = [];
  for (const file of allCssFiles(SRC)) {
    const stripped = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const raw of stripped.split(';')) {
      const decl = raw
        .slice(raw.lastIndexOf('{') + 1)
        .replace(/\s+/g, ' ')
        .trim();
      const m = /^(animation|transition)\s*:\s*(.*)$/.exec(decl);
      if (!m) continue;
      for (const part of splitTopLevelCommas(m[2])) {
        const norm = part.replace(/\s+/g, ' ').trim();
        if (!norm || !/\b[\d.]+m?s\b/.test(norm)) continue;
        out.push({ file: file.replace(SRC, 'src'), decl: `${m[1]}: ${norm}` });
      }
    }
  }
  return out;
}

/** 判一条（单动画/单过渡）声明：时长是否已 token 化。
 *  返回 null = 合规；返回字符串 = 违规原因。 */
function offenseOf(decl: string): string | null {
  const isTransition = decl.startsWith('transition');
  const body = decl.replace(/^(animation|transition)\s*:\s*/, '');
  const tokens = splitTopLevel(body);
  const firstTiming = tokens.find((t) => MOTION_TOKEN.test(t) || TIME_LITERAL.test(t));
  // 无时长（不该到这，扫描入口已过滤）→ 不算违规
  if (firstTiming === undefined) return null;
  // 时长已 token 化：其后剩余的时间字面量只可能是**延迟**（编排错峰，PRD 允许散写）
  if (MOTION_TOKEN.test(firstTiming)) return null;
  if (isTransition) {
    const idx = tokens.indexOf(firstTiming);
    const props = tokens.slice(0, idx);
    const bad = props.filter((p) => !REGISTERED_TRANSITION_PROPS.has(p));
    return bad.length > 0 ? `字面时长 + 未登记属性 ${bad.join('/')}` : null;
  }
  // animation：第一条时长就是 duration（CSS 简写规定 duration 在 delay 之前）
  const name = tokens[0];
  return REGISTERED_ANIMATIONS.has(name) ? null : `字面时长 + 未登记动画名 ${name}`;
}

/** 取某选择器的规则体（注释已剥；从选择器后的第一个 `{` 到其中最后一个 `;`）。 */
function ruleBody(css: string, selector: string): string {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const i = stripped.indexOf(selector);
  if (i < 0) return '';
  const open = stripped.indexOf('{', i);
  const close = stripped.indexOf('}', open);
  return stripped.slice(open + 1, close);
}

describe('§15 动效契约（散写时长守卫）', () => {
  it('三档 + 两曲线 + 态变轴在 tokens.css 在册，且档间单调', () => {
    for (const t of ['snap', 'm-ink', 'm-sheet', 'm-scene', 'm-ease-out', 'm-ease-io']) {
      expect(TOKENS_CSS, `缺 --${t}`).toContain(`--${t}:`);
    }
    // 写反了就是「小事慢、大事快」的观感错
    expect(tokenSeconds('m-ink')).toBeLessThan(tokenSeconds('m-sheet'));
    expect(tokenSeconds('m-sheet')).toBeLessThan(tokenSeconds('m-scene'));
  });

  it('退役 token 不得复活：--glide / --pp-grow-dur / --pp-grow-ease 全仓零引用', () => {
    const offenders: string[] = [];
    for (const file of allCssFiles(SRC)) {
      // 剥注释：病灶史注释里点名退役 token 是留痕，不是使用
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const dead of ['--glide', '--pp-grow-dur', '--pp-grow-ease']) {
        if (css.includes(dead)) offenders.push(`${file.replace(SRC, 'src')} → ${dead}`);
      }
    }
    expect(offenders, `退役 token 复活（改名即删，不留双轨）：\n${offenders.join('\n')}`).toEqual([]);
    // 反向自证：真读过一套 token（防路径漂移把上面扫成空集而恒真）
    expect(TOKENS_CSS.length).toBeGreaterThan(1000);
  });

  it('禁 `transition: all`（会把将来每个新增属性都拖进过渡）', () => {
    // 2026-10-15 批 2：全仓原有 19 处（全是按钮/芯片的 hover·active 态变），逐站点按
    // **状态变体实际会变的属性并集**改成具名表——零行为变化。留着 all 的害处：
    // 日后给同一元素加 width/padding/left 等布局属性，它们会**静默**获得过渡
    // （看着像卡顿，查起来像玄学）。
    const offenders: string[] = [];
    for (const file of allCssFiles(SRC)) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/transition:\s*all\b/.test(css)) offenders.push(file.replace(SRC, 'src'));
    }
    expect(offenders, `transition: all（改为具名属性表）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('散写贝塞尔不得回潮：曲线只有 tokens.css 里那两条', () => {
    const offenders: string[] = [];
    for (const file of allCssFiles(SRC)) {
      if (file.endsWith(join('app', 'tokens.css'))) continue;
      // 剥注释：病灶史注释里写曲线字面量是留痕，不是使用
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/cubic-bezier\(/.test(css)) offenders.push(file.replace(SRC, 'src'));
    }
    expect(offenders, `散写贝塞尔（改用 var(--m-ease-out) / var(--m-ease-io)）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('纸律：让位过渡**常驻**（不挂 .pp-stream-live 门）且只动 transform', () => {
    // 旧案 `.pp-canvas.pp-stream-live .pp-block` 的门必须已摘——否则用户自己
    // 展开/收起时的重排又是瞬移（本轮的主犯）
    expect(PANEL_CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\.pp-canvas\.pp-stream-live\s+\.pp-block\s*\{/);
    const m = /(?:^|\n)\s*transition:\s*([^;]+);/.exec(ruleBody(PANEL_CSS, '.pp-block {'));
    expect(m, '`.pp-block` 基座缺 transition（让位过渡常驻位）').not.toBeNull();
    const value = (m as RegExpExecArray)[1];
    expect(value).toContain('transform');
    expect(value).toContain('var(--m-sheet)');
    // 铁律：绝不挂 left/top/height（流式高频必卡）
    expect(value).not.toMatch(/\b(left|top|height|width)\b/);
  });

  it('首帧入场必须走 `@starting-style`（挂载即终态的元素上，transition 声明永不生效）', () => {
    // 病灶（2026-10-15 批 3 实测）：设置面板 panel-def 标 `unmountOnClose`（关即卸载），
    // 而 TSX 首帧就带 `.sp-open` ⇒ `opacity: 0 → 1` 的过渡**一次都没跑过**（挂载即终态，
    // 没有前一个计算值可比）——全应用最大的模态是「啪」地出现的。属「声明存在但不生效」
    // 那一类（同 49 处 border 简写被拼装）。
    // 判据：起手式在 `@starting-style` 里；承载它的 `.sp-open` 死抽象不得复活。
    // （剥注释再查——病灶史注释里点名 `.sp-open` 是留痕，不是使用。）
    const settingsCssCode = SETTINGS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const settingsTsxCode = SETTINGS_TSX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(settingsCssCode).toContain('@starting-style');
    expect(settingsCssCode).not.toContain('.sp-open');
    expect(settingsTsxCode).not.toContain('sp-open');
    // 面板本体：终态 + 开合档的两项过渡（opacity / transform）+ 起手式里的托起位移
    expect(settingsCssCode).toMatch(/@starting-style\s*\{[\s\S]*#settings-panel\s*\{[\s\S]*opacity:\s*0;/);
    expect(settingsCssCode).toContain('transform: translate(-50%, calc(-50% + 8px))');
    // 幕布与面板同档（一次动作至多一个动效主体）
    const overlay = /#settings-panel-overlay\s*\{([^}]*)\}/.exec(settingsCssCode);
    expect(overlay, '缺 #settings-panel-overlay 规则').not.toBeNull();
    expect((overlay as RegExpExecArray)[1]).toContain('transition: opacity var(--m-sheet)');
  });

  it('退场对称：animateExit 的面真收到退场窗，且窗长 = `--m-sheet`', () => {
    // 壳层常量 ↔ CSS token 镜像：CSS 侧播 260ms 的出场，壳层侧就要等 260ms 才卸载
    // （等短了 = 动画播到一半被卸载掐断；等长了 = 面消失了还占着一个空窗）。
    const ms = /const PANEL_LEAVE_MS = (\d+);/.exec(DOCK_TSX);
    expect(ms, 'DockPanel.tsx 缺 PANEL_LEAVE_MS').not.toBeNull();
    expect(Number((ms as RegExpExecArray)[1])).toBe(Math.round(tokenSeconds('m-sheet') * 1000));

    // 相位机 + 标记层（`display: contents` = 不生成盒子 ⇒ 对既有布局零影响）
    expect(DOCK_TSX).toContain('data-panel-leaving');
    expect(DOCK_TSX).toContain("display: 'contents'");
    expect(DOCK_TSX).toContain("useState<'open' | 'leaving' | 'closed'>");
    expect(DOCK_TSX).toContain("canLeave ? 'leaving' : 'closed'");

    // 三个面：声明（壳层供钩）+ 各自的出场规则（产物消费）——两边都必须在
    expect(SETTINGS_INDEX_TS).toContain('animateExit: true');
    expect([...CANVAS_NAV_INDEX_TS.matchAll(/animateExit: true/g)].length, '书脊 + 侧栏各一条').toBe(2);
    const surfaces: [string, string][] = [
      ['settings-panel', SETTINGS_CSS],
      ['spine-rack', SPINE_CSS],
      ['session-sidebar', SIDEBAR_CSS],
    ];
    for (const [name, css] of surfaces) {
      const code = stripCssComments(css);
      expect(code, `${name} 缺 [data-panel-leaving] 出场规则`).toContain('[data-panel-leaving]');
      // 退场期一律不接点击（否则连点会打在正在消失的面上）
      expect(
        /\[data-panel-leaving\][^{]*\{[^}]*pointer-events:\s*none/.test(code),
        `${name} 的退场规则必须含 pointer-events: none`,
      ).toBe(true);
      // 出场必须真的把面藏起来
      expect(
        /\[data-panel-leaving\][^{]*\{[^}]*opacity:\s*0/.test(code),
        `${name} 的出场规则必须把面淡出（opacity: 0）`,
      ).toBe(true);
    }
    // 侧栏/书脊把 transition 写在**退场规则里**（CSS Transitions L1：起手判据看的是
    // 「变更后样式」的 transition-property，故「加属性同时给 transition + 目标值」成局）。
    // 设置面板的 transition 在基座（入场/出场共用一条），已由上一例钉死。
    for (const [name, css] of [
      ['spine-rack', SPINE_CSS],
      ['session-sidebar', SIDEBAR_CSS],
    ] as const) {
      const leaving = /\[data-panel-leaving\][\s\S]*?\}/.exec(stripCssComments(css));
      expect(leaving, `${name} 缺退场规则`).not.toBeNull();
      expect((leaving as RegExpExecArray)[0], `${name} 退场时长必须走 --m-sheet`).toContain('var(--m-sheet)');
    }
  });

  it('设置页签换景：显隐权收在 `.is-on` 类（含 allow-discrete 出场）+ 切页复位滚动', () => {
    const css = stripCssComments(SETTINGS_CSS);
    // 切换权在产物 CSS：`.is-on` 切 display，`allow-discrete` 让 display 的**出场**
    // 也真的播（浏览器把元素留到过渡结束才隐藏——这是该关键字对 display 的特例语义）
    expect(css).toContain('.sp-tab-content.is-on');
    expect(css).toContain('allow-discrete');
    expect(css).toMatch(/\.sp-tab-content\s*\{[^}]*display:\s*none/);
    // 入场起手走 @starting-style（同设置面板本体那条判据）
    expect(css).toMatch(/@starting-style\s*\{[\s\S]*\.sp-tab-content\.is-on\s*\{[\s\S]*opacity:\s*0/);

    // 跨层归位：provider 页版式（原壳层规则）必须与切换权同层，否则同选择器同特异度
    // 下会被产物 CSS 按源序顶掉（provider 页错落成 block）
    expect(stripCssComments(PROVIDER_CSS_SHELL)).not.toContain('.sp-tab-content');
    expect(css).toContain('.sp-tab-content[data-tab="provider"].is-on');

    // TSX：不再有内联 display 互斥；改为类；切页复位滚动容器
    expect(SETTINGS_TSX).not.toContain('display: activeTab');
    expect([...SETTINGS_TSX.matchAll(/\$\{activeTab === '\w+' \? ' is-on' : ''\}/g)].length, '八个页').toBe(8);
    expect(SETTINGS_TSX).toContain('contentRef');
    expect(SETTINGS_TSX).toMatch(/el\.scrollTop = 0/);
  });

  it('读数微动效：只有**离散步进**抬计数（滚轮连续缩放不抬，否则重播成抖动）', () => {
    // store 供计数 + 唯一抬升口
    expect(CANVAS_VIEW_STORE_TS).toContain('zoomTick');
    expect(CANVAS_VIEW_STORE_TS).toContain('markZoomStep');
    expect(CANVAS_VIEW_STORE_TS).toMatch(
      /markZoomStep:\s*\(\)\s*=>\s*set\(\(s\)\s*=>\s*\(\{\s*zoomTick:\s*s\.zoomTick \+ 1/,
    );

    // 只有 stepZoom / resetZoom 两处抬（滚轮路径 setView 直接写，不经计数）
    expect([...VIEWPORT_TS.matchAll(/markZoomStep\(\)/g)].length, 'stepZoom + resetZoom 各一处').toBe(2);
    // 端点守卫：档位夹持返回同值时不抬（否则读数空跳一下）
    expect(VIEWPORT_TS).toContain('if (target === v.zoom) return;');
    expect(VIEWPORT_TS).toMatch(/Math\.abs\(v\.zoom - 1\) < 1e-9\) return;/);

    // 消费面：key 挂在内层 span（重挂按钮会丢焦点），且动画只挂在 span 上
    expect(PANEL_TSX).toContain('<span key={zoomTick} className="pp-zoom-num">');
    expect(PANEL_TSX).toMatch(/const zoomTick = useCanvasViewStore\(\(s\) => s\.zoomTick\)/);
    const css = stripCssComments(PANEL_CSS);
    expect(css).toMatch(/\.pp-zoom-num\s*\{[^}]*animation:\s*pp-readout-tick var\(--m-ink\)/);
    // 量纲钉死：2px + .72 起墨（读数位移一大会读成「字在跳」）
    const kf = /@keyframes pp-readout-tick\s*\{[\s\S]*?\n\}/.exec(css);
    expect(kf, '缺 pp-readout-tick').not.toBeNull();
    expect((kf as RegExpExecArray)[0]).toContain('translate: 0 2px');
    expect((kf as RegExpExecArray)[0]).toContain('opacity: 0.72');
  });

  it('让位过渡不被状态变体静默掐掉（`transition:` 是整表替换，不是合并）', () => {
    // 病灶形态：日后有人给 `.pp-block.pp-pinned { transition: box-shadow … }`——
    // 整表被替换，该状态下的块**丢掉 transform**，让位平滑静默失效（声明看着都在）。
    // 判据：凡以 `.pp-block` 单复合选择器开头的规则，若声明 transition 就必须含 transform。
    const stripped = PANEL_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const offenders: string[] = [];
    for (const m of stripped.matchAll(/(?:^|\n)(\.pp-block[\w.-]*)\s*\{([^}]*)\}/g)) {
      const [, selector, body] = m as RegExpMatchArray;
      const t = /(?:^|\n)\s*transition\s*:\s*([^;]+);/.exec(body);
      if (t && !t[1].includes('transform')) offenders.push(`${selector} { transition: ${t[1].trim()} }`);
    }
    expect(
      offenders,
      `这些块的 transition 整表替换会掐掉让位过渡（要么别在变体上声明 transition，要么把 transform 一并写上）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('手律：手驱动布局零缓动——豁免在册 + 壳层真发放 pp-live-hand', () => {
    expect(PANEL_CSS).toContain('.pp-canvas.pp-live-hand .pp-block');
    expect(PANEL_CSS).toContain('.pp-canvas .pp-block.pp-dragging');
    // 类必须真由壳层按手势发放（只在 CSS 写选择器 = 永不命中的死规则）
    expect(PANEL_TSX).toMatch(/edgeDragPos \|\| regionCornerPos \? ' pp-live-hand' : ''/);
  });

  it('约束律：相机飞行自觉读 matchMedia（CSS 的 reduced-motion 豁免管不到 rAF）', () => {
    expect(FOCUS_TS).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    // 两处飞行（flyToPoint / glideViewTo）都必须走同一守卫
    const guards = [...FOCUS_TS.matchAll(/if \(prefersReducedMotion\(\)\) \{/g)].length;
    expect(guards, '两处 rAF 飞行都要有 reduced-motion 短路').toBe(2);
    // 时长不再在本文件散写两遍魔数
    expect(FOCUS_TS).not.toMatch(/DURATION = \d+/);
  });

  it('跨语言镜像同值（TS ↔ CSS token）：相机飞行 ↔ --m-sheet、TOAST_FADE_MS ↔ --m-sheet', () => {
    const flight = /const FOCUS_FLIGHT_MS = (\d+);/.exec(FOCUS_TS);
    expect(flight, 'use-paper-focus.ts 缺 FOCUS_FLIGHT_MS').not.toBeNull();
    expect(Number((flight as RegExpExecArray)[1])).toBe(Math.round(tokenSeconds('m-sheet') * 1000));

    const fade = /export const TOAST_FADE_MS = (\d+);/.exec(TOAST_STORE_TS);
    expect(fade, 'toast-store.ts 缺 TOAST_FADE_MS').not.toBeNull();
    expect(Number((fade as RegExpExecArray)[1])).toBe(Math.round(tokenSeconds('m-sheet') * 1000));
  });

  it('全仓 CSS：带字面时长的 animation/transition 只许落在 §15 登记表内', () => {
    const decls = literalTimingDeclarations();
    expect(decls.length, '一个字面时长都没扫到 = 扫描面失灵').toBeGreaterThan(5);

    const offenders = decls
      .map(({ file, decl }) => ({ file, decl, why: offenseOf(decl) }))
      .filter((r) => r.why !== null)
      .map((r) => `${r.file} → ${r.decl}  [${r.why}]`);
    expect(
      offenders,
      '散写时长。结构性动作必须走 --m-ink / --m-sheet / --m-scene；' +
        '若确属仪式/信号/环境/读数件，把它登记进本文件的两张 §15 表并同批写进规格书：\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('扫描器自证：登记表内的字面时长确实被判合规（防守卫变永真）', () => {
    // 三支取样：仪式（sh-stamp）、环境（pp-ink-live）、读数件（width 过渡）
    expect(offenseOf('animation: sh-stamp 0.6s cubic-bezier(0.23, 1, 0.32, 1) 0.12s both')).toBeNull();
    expect(offenseOf('animation: pp-ink-live 1.6s ease-in-out infinite')).toBeNull();
    expect(offenseOf('transition: width 0.4s cubic-bezier(0.23, 1, 0.32, 1)')).toBeNull();
    // 反向：未登记的字面时长必须被抓（否则本测白跑）
    expect(offenseOf('animation: pp-enter 0.24s cubic-bezier(0.23, 1, 0.32, 1) backwards')).not.toBeNull();
    expect(offenseOf('transition: transform 0.3s ease')).not.toBeNull();
    // 时长走 token 时，尾随的 delay 字面量放行（编排错峰不属时长）
    expect(offenseOf('animation: pp-empty-in var(--m-sheet) 0.08s both')).toBeNull();
    expect(offenseOf('animation: foo 0.5s var(--m-ease-out)')).not.toBeNull();
  });
});
