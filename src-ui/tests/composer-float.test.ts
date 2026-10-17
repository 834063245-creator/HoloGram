// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞浮动化（2026-09-17 用户拍板：全画布自由浮动 + 吸附边缘 + 双击复位，
// 锚线跟随重算）——几何/命中/记忆纯函数考官（composer-float.ts）。
//
// 口径（与文件头注同源）：
//   - pos = { left, bottom }（视口坐标：左缘距 + 底缘距）；null = 无覆盖 =
//     CSS 默认位（版心居中 + 坐底抬高 96）；
//   - 让位带 band = bottom + 坞高（默认位恒 = 96 + 坞高 ⇒ 与浮动化前零漂移）；
//   - 命中判据 isComposerHandle：坞书眉行内的**非交互件**才是抓手。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BAND_STYLE_ID,
  COMPOSER_BAND_CONSUMERS,
  COMPOSER_BAND_VAR,
  createComposerBandSink,
} from '../src/plugins/builtin/paper-shell/composer-band';
import {
  COMPOSER_CHROME_H,
  COMPOSER_EDGE,
  COMPOSER_POS_KEY,
  COMPOSER_RISE,
  COMPOSER_SNAP,
  COMPOSER_TICK_H,
  COMPOSER_TICK_TOP,
  COMPOSER_TICK_W,
  COMPOSER_UNLOCK_KEY,
  clampComposerPos,
  composerAnchorOf,
  composerGeomOf,
  isComposerDragSurface,
  loadComposerPos,
  loadComposerUnlocked,
  RACK_BOTTOM_FLOOR,
  RACK_H,
  saveComposerPos,
  saveComposerUnlocked,
  snapComposerPos,
} from '../src/plugins/builtin/paper-shell/composer-float';

const PANEL_CSS = readFileSync(
  join(__dirname, '..', 'src', 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'),
  'utf8',
);
/** token 真源（坞抬高 96 的出处——TS 侧的 COMPOSER_RISE 是它的镜像）。 */
const TOKENS_CSS = readFileSync(join(__dirname, '..', 'src', 'app', 'tokens.css'), 'utf8');

/** 从选择器名截取规则体（到下一个 `}` 为止——同 paper-provenance 的既有范式）。 */
function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
}

const VP = { w: 1200, h: 800 };
const BOX = { w: 880, h: 110 };

describe('创作坞浮动化 · 几何（夹紧）', () => {
  it('坞整体留在视口内：左/右/下留屏缘，上不越顶部浮件带（坞顶 ≥ 浮件带高 + 屏缘）', () => {
    const far = clampComposerPos({ left: -500, bottom: -500 }, VP, BOX);
    expect(far).toEqual({ left: COMPOSER_EDGE, bottom: COMPOSER_EDGE });

    const beyond = clampComposerPos({ left: 9999, bottom: 9999 }, VP, BOX);
    expect(beyond.left).toBe(VP.w - BOX.w - COMPOSER_EDGE);
    // 上界 = 视口高 − 浮件带高 − 坞高 − 屏缘（坞顶恰好落在浮件带下缘 + 屏缘）
    expect(beyond.bottom).toBe(VP.h - COMPOSER_CHROME_H - BOX.h - COMPOSER_EDGE);
    expect(VP.h - beyond.bottom - BOX.h).toBe(COMPOSER_CHROME_H + COMPOSER_EDGE);
  });

  it('坞比视口还宽（窄窗口）：不产生负上界（退回屏缘，不炸布局）', () => {
    const narrow = clampComposerPos({ left: 400, bottom: 20 }, { w: 400, h: 300 }, { w: 880, h: 110 });
    expect(narrow.left).toBe(COMPOSER_EDGE);
    expect(narrow.bottom).toBe(20);
  });
});

describe('创作坞浮动化 · 吸附边缘', () => {
  const snap = (left: number, bottom: number) => snapComposerPos({ left, bottom }, VP, BOX);

  it('横向三枚锚：左缘 / 版心中轴 / 右缘（阈内即吸）', () => {
    expect(snap(COMPOSER_EDGE + 10, 300).left).toBe(COMPOSER_EDGE);
    const center = (VP.w - BOX.w) / 2;
    expect(snap(center + COMPOSER_SNAP - 1, 300).left).toBe(center);
    expect(snap(VP.w - BOX.w - COMPOSER_EDGE - 10, 300).left).toBe(VP.w - BOX.w - COMPOSER_EDGE);
  });

  it('纵向两枚锚：经典底带（抬高 96）/ 最底缘（屏缘）', () => {
    expect(snap(300, COMPOSER_RISE + COMPOSER_SNAP - 1).bottom).toBe(COMPOSER_RISE);
    expect(snap(300, COMPOSER_EDGE + COMPOSER_SNAP - 1).bottom).toBe(COMPOSER_EDGE);
  });

  it('阈外不吸（自由浮动），且吸附幂等（吸过的位再吸不动）', () => {
    const free = { left: 500, bottom: 400 };
    expect(snap(free.left, free.bottom)).toEqual(free);
    const snapped = snap(COMPOSER_EDGE + 3, COMPOSER_RISE + 3);
    expect(snap(snapped.left, snapped.bottom)).toEqual(snapped);
  });
});

describe('创作坞浮动化 · 坞几何下发（两种口径由消费面各自派生）', () => {
  it('无覆盖（默认位）：bottom = 出厂抬高——让位带 = 抬高 + 坞高（与浮动化前同值）', () => {
    expect(composerGeomOf(null, 110)).toEqual({ bottom: COMPOSER_RISE, height: 110 });
  });

  it('浮动态：bottom = 坞的实际位置（让位带 = bottom + 坞高，坞越往上越大）', () => {
    expect(composerGeomOf({ left: 40, bottom: 300 }, 110)).toEqual({ bottom: 300, height: 110 });
    expect(composerGeomOf({ left: 40, bottom: 96 }, 110).bottom).toBe(96);
  });

  it('坞高变了 height 跟着变（思考展开/附件/墨量册——同一条式子）', () => {
    expect(composerGeomOf(null, 300).height).toBe(300);
  });
});

/* 版口引线（2026-09-22）：坞侧锚点 = 坞顶左端那枚**版口钮**的起端中点——坞的版口钮
 * 与活卷卷首规线左端那枚同名同形同墨（56×3 朱砂短横），线把两枚红连起来即「红对红」。
 * 锚点只用坞位 + 坞实测尺寸算（坞本体一字不知），与 CSS 字面量必须同值。 */
describe('创作坞浮动化 · 版口引线坞侧锚点（坞顶左端版口钮的起端中点）', () => {
  it('默认位（无覆盖）：锚点 = 版心居中左缘 × 坞顶线上方版口钮的中线', () => {
    // top = 视口高 − 抬高 96 − 坞高 110 = 594；锚 y = top − 3 + 1.5（钮悬在坞顶线上 3px、高 3px）
    expect(composerAnchorOf(null, VP, BOX)).toEqual({ x: (VP.w - BOX.w) / 2, y: VP.h - COMPOSER_RISE - BOX.h - 1.5 });
  });

  it('浮动态：锚点跟着坞位走（x = 槽左边 / y = 坞顶线 − 1.5）', () => {
    expect(composerAnchorOf({ left: 300, bottom: 200 }, VP, BOX)).toEqual({
      x: 300,
      y: VP.h - 200 - BOX.h - 1.5,
    });
  });

  it('坞高变（思考展开/附件）锚点跟着落——线不悬空', () => {
    const tall = composerAnchorOf(null, VP, { w: BOX.w, h: 300 });
    expect(tall.y).toBe(VP.h - COMPOSER_RISE - 300 - 1.5);
    expect(tall.y).toBeLessThan(composerAnchorOf(null, VP, BOX).y);
  });

  it('字面量与坞的版口钮 CSS **同值**（两处各写一遍就必须钉住）', () => {
    expect(COMPOSER_TICK_W).toBe(56);
    expect(COMPOSER_TICK_H).toBe(3);
    expect(COMPOSER_TICK_TOP).toBe(-3);
    const tick = ruleBody(PANEL_CSS, '.pp-composer::before {');
    expect(tick).toContain('left: 0');
    expect(tick).toContain(`top: ${COMPOSER_TICK_TOP}px`);
    expect(tick).toContain(`width: ${COMPOSER_TICK_W}px`);
    expect(tick).toContain(`height: ${COMPOSER_TICK_H}px`);
    expect(tick).toContain('var(--seal)'); // 朱砂短横——与活卷那枚同墨（红对红）
    // 案头态（匣退）：钮 content:none ⇒ 锚点不在场，引线随之不画（空态诚实）
    expect(ruleBody(PANEL_CSS, '.pp-composer-slot.pp-at-desk .pp-composer::before {')).toContain('content: none');
  });
});

/* 图版架兜底（2026-09-23 丙案 D2）：架挂在坞下缘（880×38）⇒ 架在时「最底缘」吸附位
 * 顺延架高（8 → 46），架永在匣下、阅读位置一致（翻到匣顶就当场变回甲案=盖纸尾）。
 * 判据真源 = paper/asset-rack.ts 的 rackPresent（有活跃卷且架内非空），由槽主人
 * PaperPanel 算好递进 useComposerFloat。 */
describe('创作坞浮动化 · 图版架兜底（架在 ⇒ 最底缘 8 → 46）', () => {
  const snapBottom = (bottom: number, rack?: boolean): number =>
    snapComposerPos({ left: 300, bottom }, VP, BOX, rack === undefined ? undefined : { rack }).bottom;

  it('吸附表逐值：架不在 = [8, 96]（今日口径零漂）；架在 = [46, 96]', () => {
    expect(snapBottom(COMPOSER_EDGE + COMPOSER_SNAP - 1)).toBe(COMPOSER_EDGE);
    expect(snapBottom(COMPOSER_RISE + COMPOSER_SNAP - 1)).toBe(COMPOSER_RISE);
    expect(snapBottom(RACK_BOTTOM_FLOOR + COMPOSER_SNAP - 1, true)).toBe(RACK_BOTTOM_FLOOR);
    expect(snapBottom(COMPOSER_RISE + COMPOSER_SNAP - 1, true)).toBe(COMPOSER_RISE);
    // 架在时屏缘位不再是锚（它正是「架被屏缘切掉 30px」的那一位）
    expect(snapBottom(COMPOSER_EDGE + COMPOSER_SNAP - 1, true)).not.toBe(COMPOSER_EDGE);
  });

  it('夹紧下限同一条尺子：架在 ⇒ 46（吸附阈 24 < 架高 38——只改吸附表就还停得住被切位）', () => {
    expect(clampComposerPos({ left: 300, bottom: -500 }, VP, BOX).bottom).toBe(COMPOSER_EDGE);
    expect(clampComposerPos({ left: 300, bottom: -500 }, VP, BOX, { rack: true }).bottom).toBe(RACK_BOTTOM_FLOOR);
    expect(RACK_BOTTOM_FLOOR).toBe(COMPOSER_EDGE + RACK_H);
    // 横向与上界不受架影响（架只改屏缘那一位）
    const box = { w: 880, h: 110 };
    expect(clampComposerPos({ left: -500, bottom: -500 }, VP, box, { rack: true }).left).toBe(COMPOSER_EDGE);
  });

  it('常量与 CSS 对拍：RACK_H = .pp-rack 高（38）；坞抬高 96 与 --composer-rise 同源', () => {
    expect(RACK_H).toBe(38);
    expect(ruleBody(PANEL_CSS, '.pp-rack {')).toContain(`height: ${RACK_H}px`);
    expect(COMPOSER_RISE).toBe(96);
    expect(TOKENS_CSS).toContain(`--composer-rise: ${COMPOSER_RISE}px`);
  });
});

describe('创作坞浮动化 · 拖动面命中判据（默认锁定）', () => {
  function markup(html: string): HTMLElement {
    const slot = document.createElement('div');
    slot.className = 'pp-composer-slot';
    slot.innerHTML = `<div class="pp-composer">${html}</div>`;
    return slot;
  }
  const body = markup(
    '<div class="pp-composer-header"><span class="pp-composer-target">卷一</span>' +
      '<button type="button" class="pp-tool-btn">翰</button></div>' +
      '<div class="pp-composer-row"><textarea></textarea></div>' +
      '<div class="pp-composer-settings"><div class="pp-comp-sel">组合</div></div>',
  );

  it('**锁定态（默认）：一律不是拖动面**——坞是普通 DOM，划词/点选照旧（用户报的冲突即由此根治）', () => {
    for (const sel of ['.pp-composer-target', '.pp-composer-header', '.pp-composer', '.pp-composer-settings']) {
      expect(isComposerDragSurface(body.querySelector(sel), false)).toBe(false);
    }
  });

  it('解锁态：整坞皆是拖动面（书眉行 / 输入行空白 / 设置行空白都算）', () => {
    expect(isComposerDragSurface(body.querySelector('.pp-composer-target'), true)).toBe(true);
    expect(isComposerDragSurface(body.querySelector('.pp-composer-header'), true)).toBe(true);
    expect(isComposerDragSurface(body.querySelector('.pp-composer'), true)).toBe(true);
    expect(isComposerDragSurface(body.querySelector('.pp-composer-settings'), true)).toBe(true);
  });

  it('解锁态：交互件仍不承载拖坞手势（翰钮/输入框/组合控件自己接手势）', () => {
    expect(isComposerDragSurface(body.querySelector('.pp-tool-btn'), true)).toBe(false);
    expect(isComposerDragSurface(body.querySelector('textarea'), true)).toBe(false);
    /* 坞内**纯包裹层**（组合芯片外框这类无 role 的 div）仍算坞体 ⇒ 拖动面：
     * 真坞里可点的是它里面的 button（已被 blockers 拦下），外框留白拖坞无妨。 */
    expect(isComposerDragSurface(body.querySelector('.pp-comp-sel'), true)).toBe(true);
    expect(isComposerDragSurface(null, true)).toBe(false);
  });

  it('解锁态：坞之外（槽里的签条架/锁钮等）不是拖动面', () => {
    const outside = document.createElement('button');
    outside.className = 'pp-composer-lock';
    body.appendChild(outside);
    expect(isComposerDragSurface(outside, true)).toBe(false);
  });
});

describe('创作坞浮动化 · 坞位记忆（localStorage）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('往返：存整数 px，读回同值', () => {
    saveComposerPos({ left: 123.4, bottom: 96.6 });
    expect(loadComposerPos()).toEqual({ left: 123, bottom: 97 });
  });

  it('无键 = 无覆盖（null）', () => {
    expect(loadComposerPos()).toBeNull();
  });

  it('双击复位 = 清覆盖（键移除，坞回 CSS 默认位）', () => {
    saveComposerPos({ left: 10, bottom: 10 });
    saveComposerPos(null);
    expect(localStorage.getItem(COMPOSER_POS_KEY)).toBeNull();
    expect(loadComposerPos()).toBeNull();
  });

  it('毒化数据当无覆盖（坏 JSON / 缺字段 / 非有限数）——读侧容忍，不炸不静默兜成坐标', () => {
    localStorage.setItem(COMPOSER_POS_KEY, '{oops');
    expect(loadComposerPos()).toBeNull();
    localStorage.setItem(COMPOSER_POS_KEY, '{"left":12}');
    expect(loadComposerPos()).toBeNull();
    localStorage.setItem(COMPOSER_POS_KEY, '{"left":null,"bottom":"96"}');
    expect(loadComposerPos()).toBeNull();
  });
});

/* 让位带载体（2026-10-18 性能批）：`--composer-band` 的**下发面**是「只命中让位
 * 消费面的一条规则」，不是 `:root` 内联——旧写法在拖动期每帧触发整棵文档树的样式
 * 重算（CDP 实测 62ms/帧、28 次 64ms 长任务；规则式 0.97ms/帧）。本组考两件事：
 *   ① 载体本身（建/写/复用/摘除）；
 *   ② **名册 vs CSS 实读对拍**——新增一个读让位带的消费面而忘了登记名册 = 那个面
 *      永远读到静态兜底（坞浮上去压住它）且不报错，故按 CSS 源码逐条对拍。 */
describe('创作坞浮动化 · 让位带载体（性能契约：不许退回 :root 内联）', () => {
  beforeEach(() => {
    localStorage.clear();
    document.getElementById(BAND_STYLE_ID)?.remove();
    document.documentElement.style.removeProperty(COMPOSER_BAND_VAR);
  });

  it('建载体：规则选择器 = 让位消费面名册；publish 写的是规则声明块', () => {
    const sink = createComposerBandSink(document);
    sink.publish(206);
    expect(document.getElementById(BAND_STYLE_ID)).not.toBeNull();
    const rule = carrierRule();
    expect(rule?.selectorText).toBe(COMPOSER_BAND_CONSUMERS);
    expect(rule?.style.getPropertyValue(COMPOSER_BAND_VAR)).toBe('206px');
    /* 关键：值落在**规则**上，不在 `:root` 内联上（后者 = 全树重算）。 */
    expect(document.documentElement.style.getPropertyValue(COMPOSER_BAND_VAR)).toBe('');
    /* 消费面（照真消费者挂一个 .psh-host）= 解析到实时值——后挂载者也自动命中。
     * ⚠ 每次**新建**元素再读：jsdom 的计算样式按元素缓存，同一个元素读第二次不刷新。 */
    const resolved = (): string => {
      const host = document.createElement('div');
      host.className = 'psh-host';
      document.body.appendChild(host);
      const v = getComputedStyle(host).getPropertyValue(COMPOSER_BAND_VAR).trim();
      host.remove();
      return v;
    };
    expect(resolved()).toBe('206px');
    sink.publish(306.4);
    expect(rule?.style.getPropertyValue(COMPOSER_BAND_VAR)).toBe('306px');
    expect(resolved()).toBe('306px');
  });

  it('幂等与摘除：重复建只留一条载体；dispose 摘除后消费面回落（读到空 = CSS 兜底生效）', () => {
    const a = createComposerBandSink(document);
    const b = createComposerBandSink(document);
    a.publish(200);
    b.publish(210);
    expect(document.querySelectorAll(`#${BAND_STYLE_ID}`).length).toBe(1);
    /* 后写者胜（同旧 :root 口径：多实例不叠规则）。 */
    expect(carrierRule()?.style.getPropertyValue(COMPOSER_BAND_VAR)).toBe('210px');
    /* 复用来的载体（非自有）dispose 不摘别人的：b 先摘 → 值仍在。 */
    b.dispose();
    expect(document.getElementById(BAND_STYLE_ID)).not.toBeNull();
    a.dispose();
    expect(document.getElementById(BAND_STYLE_ID)).toBeNull();
    a.publish(999); // 摘除后 publish 是空操作（不复活死载体、不炸）
    expect(document.getElementById(BAND_STYLE_ID)).toBeNull();
  });

  it('载体被摘除后仍能续命（热重载竞态）：publish 发现断连即重建，不写在死表上', () => {
    const owner = createComposerBandSink(document);
    const reuser = createComposerBandSink(document);
    owner.publish(100); // 首发者建载体（自有）
    reuser.publish(200); // 后来者复用同一条（不自有）
    owner.dispose(); // 自有者退场（产物热重载那一下）⇒ 载体被摘除
    expect(document.getElementById(BAND_STYLE_ID)).toBeNull();
    reuser.publish(210); // 仍须下发得出去（重建成自有）
    expect(carrierRule()?.style.getPropertyValue(COMPOSER_BAND_VAR)).toBe('210px');
    reuser.dispose();
  });

  it('名册 vs CSS 实读对拍：每条读 var(--composer-band) 的规则，主体元素都得登记', () => {
    const registered = new Set(COMPOSER_BAND_CONSUMERS.split(',').map((sel) => subjectClassOf(sel.trim())));
    const found = new Set<string>();
    for (const file of cssFilesUnder(join(__dirname, '..', 'src'))) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const sel of subjectsReadingBand(css)) found.add(subjectClassOf(sel));
    }
    // 现网两名消费者都得在（对拍本身有牙：漏登记即红、名册写错也红）
    expect(found).toEqual(new Set(['.psh-host', '.pw-dock']));
    expect([...found].filter((s) => !registered.has(s))).toEqual([]);
  });
});

/** 载体规则（测试读面；用 `cssRules.item()` 取，避开索引取值的 lint）。 */
function carrierRule(): CSSStyleRule | null {
  const el = document.getElementById(BAND_STYLE_ID) as HTMLStyleElement | null;
  return (el?.sheet?.cssRules.item(0) as CSSStyleRule | undefined) ?? null;
}

/** 规则主体里的 `.class` 名（取选择器末端那个简单选择器——`.pp-root .psh-host` ⇒ `.psh-host`）。 */
function subjectClassOf(selector: string): string {
  const last = selector.split(/\s+/).filter(Boolean).pop() ?? '';
  const m = last.match(/\.[A-Za-z0-9_-]+/g);
  return m ? m[m.length - 1] : '';
}

/** src 下全部 `.css` 文件（递归；升序保证对拍确定性）。 */
function cssFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cssFilesUnder(p));
    else if (entry.name.endsWith('.css')) out.push(p);
  }
  return out;
}

/** 逐条报出「声明块里读了 var(--composer-band)」的规则的**主体选择器**。
 *  朴素扫描：按 `{` 回溯到上一条规则的 `}` 或块首（覆盖 @media 内嵌规则——
 *  选择器串里混进 `@media (...)` 前缀不影响主体取词）。 */
function subjectsReadingBand(css: string): string[] {
  const out: string[] = [];
  const needle = `var(${COMPOSER_BAND_VAR}`;
  for (let i = css.indexOf(needle); i >= 0; i = css.indexOf(needle, i + 1)) {
    const open = css.lastIndexOf('{', i);
    if (open < 0) continue;
    const boundary = Math.max(css.lastIndexOf('}', open), css.lastIndexOf(';', open), css.lastIndexOf('{', open - 1));
    const sel = css
      .slice(boundary + 1, open)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    out.push(...sel);
  }
  return out;
}

describe('创作坞浮动化 · 拖动锁记忆（默认锁定）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('默认锁定（键缺席 = false）——用户方案：「点击解锁之后坞才对鼠标有响应」', () => {
    expect(loadComposerUnlocked()).toBe(false);
  });

  it('解锁 → 落盘 → 读回 true；再锁 → 键移除', () => {
    saveComposerUnlocked(true);
    expect(localStorage.getItem(COMPOSER_UNLOCK_KEY)).toBe('1');
    expect(loadComposerUnlocked()).toBe(true);
    saveComposerUnlocked(false);
    expect(localStorage.getItem(COMPOSER_UNLOCK_KEY)).toBeNull();
    expect(loadComposerUnlocked()).toBe(false);
  });

  it('毒化值一律当锁定（读侧容忍，不炸）', () => {
    localStorage.setItem(COMPOSER_UNLOCK_KEY, 'yes');
    expect(loadComposerUnlocked()).toBe(false);
  });
});
