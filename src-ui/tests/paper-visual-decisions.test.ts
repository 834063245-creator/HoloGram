// SPDX-License-Identifier: MIT

// 纸壳视觉定稿钉值（B 段审美循环，2026-08-23）——CSS 字面量断言防回漂。
// node 环境：readFileSync 读文件（jsdom 下 node: 模块 baseline 不可用，?raw 被 vitest css
// 管线吞成空串——两条替代路都试过，此文件头注释是唯一可行位）。
//
// 锁的定稿：
//   B3 环1（用户拍板 B 提墨）：信息承载五处 ink-3→ink-2
//   B4 环1（用户拍板 C）：来文身 18px→16px/1.9（seal-deep 不变，收正文 17 之下）
//   B5 环2（用户拍板 红绿墨色化）：diff add=松绿(--pass) / del=朱砂深(--seal-deep)+删除线
//   2026-09-02 贴纸纹理归属批（透明错觉根治）：纹理随纸走——桌面纹/流区纹各有其主；
//     帘纹不进流区（实机过审「横纹消失」）；文档级纹理/帘纹画布态退役，首页/面板照旧

// @vitest-environment node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const PANEL_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'), 'utf8');
/** 首页样式面（批 9e 起随 `sessions-home` 产物走）；壳文件只剩全局面（重置/纹理层/选区）。 */
const HOME_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'sessions-home', 'home.css'), 'utf8');
/** 壳全局样式面（body::before/after 纹理层、可访问性、字号交还——与首页不同生共死）。 */
const FOUNDATION_CSS = readFileSync(join(SRC, 'app', 'foundation.css'), 'utf8');
/** 纸壳源面（paper-panel-split 后）：PaperPanel.tsx + 同目录拆出的 use-*.ts
 *  hook 文件全量拼接——拆解把域逻辑（拖块/纸条/布局核心/消息操作…）物理
 *  移入 hook 文件，扫描面跟随代码物理位置；断言零改动（对齐
 *  paper-interaction-handoff.test.ts 的 readAllTs 目录递归既有范式）。
 *  CSS 不入本扫描面（样式断言仍单读 PANEL_CSS）。 */
const PANEL_TSX = readdirSync(join(SRC, 'plugins', 'builtin', 'paper-shell'))
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', f), 'utf8'))
  .join('\n');
const ICONS_TS = readFileSync(join(SRC, 'ui', 'icons.ts'), 'utf8');
// 批 9c-4b：测量引擎随 paper-shell 产物 ⇒ 断言点随迁产物源文件。
const MEASURE_TS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'measure.ts'), 'utf8');
const CANVAS_MATH_TS = readFileSync(join(SRC, 'paper', 'canvas-math.ts'), 'utf8');
// 批 9c-3：group 实现随 paper-shell 产物（形状契约留内核）——断言点随迁产物源文件。
const GROUP_TS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'group.ts'), 'utf8');
// 批 9c-3：WorkUnit 形状（含节律族字段）上收内核契约——形状断言查契约文件。
const GROUP_CONTRACT_TS = readFileSync(join(SRC, 'paper', 'group-contract.ts'), 'utf8');
const TYPE_TOKENS_TS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'type-tokens.ts'), 'utf8');
const TOKENS_CSS = readFileSync(join(SRC, 'app', 'tokens.css'), 'utf8');
/** 互斥两态的两块板（2026-09-21 侧栏纸面批：板面纹理三个消费面同源） */
const SIDEBAR_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'canvas-nav', 'session-sidebar.css'), 'utf8');
const SPINE_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'canvas-nav', 'spine-rack.css'), 'utf8');
const FONTS_TS = readFileSync(join(SRC, 'app', 'fonts.ts'), 'utf8');
const FONTS_CSS = readFileSync(join(SRC, 'app', 'fonts.css'), 'utf8');
const NORMALIZE_PS1 = readFileSync(join(__dirname, '..', '..', 'scripts', 'normalize-paper-texture.ps1'), 'utf8');
// M2 收口（2026-09-14）：渲染器实现从 composition/renderer-service.tsx 迁至
// app/paper/builtin-renderers.tsx（通道与实现分家）——本常量拼接两文件，保持
// 断言覆盖面与迁移前一致（正向 token 在实现文件，反向「无 inline 色」覆盖两处）。
// 批 8b（2026-09-25）：实现再迁产物包 paper-renderers/ ⇒ 第二个路径随迁（拼接面不变）。
const RENDERER_TS =
  readFileSync(join(SRC, 'composition', 'renderer-service.tsx'), 'utf8') +
  readFileSync(join(SRC, 'plugins', 'builtin', 'paper-renderers', 'renderers.tsx'), 'utf8');
const TRANSLATE_TS = readFileSync(join(SRC, 'paper', 'translate.ts'), 'utf8');
const GRAMMAR_TS = readFileSync(join(SRC, 'paper', 'grammar.ts'), 'utf8');

/** 从选择器名截取规则体（到下一个 `}` 为止——纸壳 CSS 规则无嵌套）。 */
function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
}

/** 截取 @keyframes 全体（含 from/to 嵌套块——花括号配平，规则体截取法够不着）。 */
function keyframesBody(css: string, name: string): string {
  const i = css.indexOf(`@keyframes ${name}`);
  if (i < 0) return '';
  let depth = 0;
  let started = false;
  for (let j = i; j < css.length; j++) {
    if (css[j] === '{') {
      depth += 1;
      started = true;
    } else if (css[j] === '}') {
      depth -= 1;
      if (started && depth === 0) return css.slice(i, j + 1);
    }
  }
  return '';
}

describe('纸壳视觉定稿钉值（B3/B4/B5）', () => {
  it('B4：来文 22px/1.65 朱砂深（token 化后守真源 + CSS 变量引用）', () => {
    // 真源钉值（type-tokens.ts）——2026-08-30 标题化：题 > 正文 17
    expect(TYPE_TOKENS_TS).toContain('user: { size: 22, lh: 1.65');
    // CSS 侧引用同一 token（不再写死字面量）
    const userBody = ruleBody(PANEL_CSS, '.pp-block.pp-user .pp-body');
    expect(userBody).toContain('font-size: var(--pp-type-user-size)');
    expect(userBody).toContain('line-height: var(--pp-type-user-lh)');
    expect(userBody).toContain('var(--seal-deep)');
  });

  it('B5：diff add 松绿 / del 朱砂深删除线', () => {
    expect(ruleBody(PANEL_CSS, '.pp-diff .pp-add')).toContain('var(--pass)');
    const del = ruleBody(PANEL_CSS, '.pp-diff .pp-del');
    expect(del).toContain('var(--seal-deep)');
    expect(del).toContain('line-through');
  });

  it('B3：信息承载五处 ink-2（tool/code 输出 + 案卷日期/卷号/页脚）', () => {
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-tool .pp-out')).toContain('color: var(--ink-2)');
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-code .pp-out')).toContain('color: var(--ink-2)');
    expect(ruleBody(HOME_CSS, '.sh-session-row .date')).toContain('color: var(--ink-2)');
    expect(ruleBody(HOME_CSS, '.sh-session-row .meta')).toContain('color: var(--ink-2)');
    expect(ruleBody(HOME_CSS, '.sh-foot')).toContain('color: var(--ink-2)');
  });

  it('界栏改档（2026-09-02 视觉迭代·用户拍板读法 B）：墨框退役 → 物理包边——纸缘 = 材料不是墨', () => {
    const region = ruleBody(PANEL_CSS, '.pp-region {');
    // 墨框全退役（旧案 2px 半墨 border + 飘浮 outline 实机判「难看又简陋」）
    expect(region).not.toContain('border:');
    expect(region).not.toContain('outline');
    // 物理包边：裱边带（纸色深一档）+ 受光缘 + 背光缘 + 接触落影，全走 token
    expect(region).toContain('var(--sheet-lit)');
    expect(region).toContain('var(--sheet-shade)');
    expect(region).toContain('var(--sheet-band)');
    expect(region).toContain('var(--shadow-sheet)');
    const active = ruleBody(PANEL_CSS, '.pp-region-active {');
    // 活跃卷「变色」判死：洗底退役，只走结构墨阶（落影加深一档）
    expect(active).not.toContain('background');
    expect(active).not.toContain('var(--seal)');
    expect(active).toContain('var(--shadow-sheet-active)');
  });

  it('拿纸动效（2026-09-10 拍板「拿纸 + 朱笔划界」）：激活落影过冲 lift 档再落「在手」——帧内只许 box-shadow', () => {
    // keyframes 红线（同 pp-enter / settle 立法）：帧内禁 transform（世界坐标
    // 换算与 InkLayer 对位）、禁 background（变色判死延伸到帧——纸纹层）
    const take = keyframesBody(PANEL_CSS, 'pp-region-take');
    expect(take).not.toBe('');
    expect(take).not.toMatch(/transform\s*:/);
    expect(take).not.toMatch(/background/);
    // 三档全字面复用既有影值（零新魔数）：from 平放 → 60% 过冲 lift（拖拽
    // 手势既有最高档）→ to 在手；to 帧 = 静态 active 值（播放完自然回落）
    expect(take).toContain('var(--shadow-sheet)');
    expect(take).toContain('var(--shadow-sheet-lift)');
    expect(take).toContain('var(--shadow-sheet-active)');
    expect(ruleBody(PANEL_CSS, '.pp-region-active {')).toContain('animation: pp-region-take');
    // 基座缓退：换主时旧卷影缓退非瞬移；整句钉死 = 单属性（只 box-shadow）
    // + 家风档，一石二鸟。**2026-10-15 §15 动效法批规格变更**：时长/曲线由
    // 散写 `320ms cubic-bezier(0.23, 1, 0.32, 1)` 收编为 `--m-sheet`（让位档，
    // 0.26s）——影随手动是「纸被推/被拿起」的物理过场，归纸律；值本身（320→260ms）
    // 是用户可见变更，已在 §15 与 commit 声明。「只 box-shadow 一项」这条钉子不变。
    expect(ruleBody(PANEL_CSS, '.pp-region {')).toContain('transition: box-shadow var(--m-sheet)');
  });

  it('物理包边 token 载入（tokens.css 真源）：band/lit/shade + 活跃落影一档', () => {
    expect(TOKENS_CSS).toContain('--sheet-band:');
    expect(TOKENS_CSS).toContain('--sheet-lit:');
    expect(TOKENS_CSS).toContain('--sheet-shade:');
    expect(TOKENS_CSS).toContain('--shadow-sheet-active:');
    // 剂量钉值（A/B 验证台 prototype/edge-ab.html 定档）：亮线 0.75 / 沉线 0.13
    expect(TOKENS_CSS).toContain('rgba(255, 250, 238, 0.75)');
    expect(TOKENS_CSS).toContain('rgba(38, 34, 28, 0.13)');
  });

  it('划词朱线（2026-09-02 视觉迭代）：流区原生洗底退役——选区以手写朱线呈现（纸不动、只落墨）', () => {
    // .pp-region 内 ::selection 透明化；UI 面（composer/菜单）照旧 seal-soft
    const sel = ruleBody(PANEL_CSS, '.pp-region ::selection');
    expect(sel).toContain('background: transparent');
    // 朱线层：固定视口层 z 62（纸内件带上沿之上、浮钮 70 之下）
    const ink = ruleBody(PANEL_CSS, '.pp-sel-ink {');
    expect(ink).toContain('position: fixed');
    expect(ink).toContain('pointer-events: none');
    expect(ink).toContain('z-index: 62');
    // 纯函数真源在册（行合并 + 手写路径）
    expect(existsSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'sel-ink.ts'))).toBe(true);
    expect(PANEL_TSX).toContain('mergeSelectionLines');
    expect(PANEL_TSX).toContain('selInkPaths');
  });

  it('块入场（2026-08-30 流式生命感）：入场动画单次（尾笔已由用户拍板拆除）', () => {
    // 尾笔（pp-tail）2026-08-30 用户拍板拆除——见 taste-ledger 翻案；只钉入场
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-tail')).toBe('');
    const enter = ruleBody(PANEL_CSS, '.pp-block.pp-enter');
    expect(enter).toContain('animation: pp-enter');
  });

  it('块入场定位纪律（2026-09-03 生产事故立法）：pp-enter 帧内禁 transform——上浮只走独立 translate 属性', () => {
    // 事故：块定位是内联 transform（2026-09-02 换装），pp-enter 的 from 帧残留
    // left/top 时代的 transform: translateY(8px)——声明即顶掉内联槽位，新块入场
    // 被摆到流容器左上角再飞回槽位（发消息后排版乱掉/输入似消失/文字乱飞）。
    // 纪律：凡打在 transform 定位块上的 keyframes，任何一帧都不得声明 transform；
    // 相对上浮改走独立 translate 属性（与内联 transform 合成，Chrome 104+）。
    const kf = keyframesBody(PANEL_CSS, 'pp-enter');
    expect(kf).not.toBe('');
    expect(kf).not.toMatch(/transform\s*:/);
    expect(kf).toContain('translate: 0 8px');
    expect(kf).toContain('translate: 0 0');
  });
});

describe('钉住与纸条（09-05 松手定夺批 → 09-19 便条批 · 用户拍板「甲+丙」）', () => {
  it('钉住块 = 纸片件：纸内白边 + sheet 细纹 + 四层包边 + --shadow-sheet 落影（§11 纸片件，2026-09-23 翻案）', () => {
    const pin = ruleBody(PANEL_CSS, '.pp-block.pp-pinned {');
    // 甲·留白：墨不再贴纸缘（流内 720 墨借 1440 纸的白边，钉住后必须自付）
    expect(pin).toContain('var(--pp-ch-pin-padTop)');
    expect(pin).toContain('var(--pp-ch-pin-padH)');
    expect(pin).toContain('var(--pp-ch-pin-padBottom)');
    // 纸色不动（--paper-deep），材质改由**纹**承担：桌面 fiber+grain 粗纹 / 卡片 sheet 细纹
    // ⇒ 两种纸，不是同一张纸的深浅。**推翻 09-19「实色深纸无纹」**（纹理是质感来源不是干扰）。
    expect(pin).toContain('background-color: var(--paper-deep)');
    expect(pin).toContain('paper-sheet.jpg');
    expect(pin).toContain('background-size: 900px 900px');
    // 四层物理包边（受光左上 / 背光右下）——与流区同配方
    expect(pin).toContain('inset 3px 4px 5px var(--sheet-lit)');
    expect(pin).toContain('inset -2px -3px 6px var(--sheet-shade)');
    // 落影：钉住块已离开流、躺在桌面上，按「**纸片件**」适用 --shadow-sheet 硬偏移族。
    // §11「纸内件无投影」原表列**于 2026-09-23 翻案**——那行说的是仍被夹在纸内的排印件。
    expect(pin).toContain('var(--shadow-sheet');
    expect(pin).not.toContain('var(--sheet-band)');
    expect(pin).toContain('var(--sheet-lit)');
    // 框取单线（双线加包边会互相吃，见 CSS 注释）
    expect(pin).toContain('inset 0 0 0 1px var(--ink-2)');
    expect(pin).not.toContain('outline');
    expect(pin).not.toContain('border:');
    // hover 不再提落影（落影已常显）——hover 信号在收回钮与文类签（各自规则）
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-pinned:hover {')).toBe('');
  });

  it('纸内报头：文类签从纸外页边注收进纸内成单行（方墨点 + 文类 + 出处），测高镜像在册', () => {
    const head = ruleBody(PANEL_CSS, '.pp-block.pp-pinned .pp-kind {');
    expect(head).toContain('position: static'); // 不再挂纸外 -128px
    expect(head).toContain('flex-direction: row');
    expect(head).toContain('var(--pp-ch-pin-headGap)');
    expect(head).toContain('var(--pp-ch-pin-headRuleGap)');
    // 2026-09-23 质感批：报头规线由弱线档（--rule-soft = ink-4）提到 ink-3 ——
    // 卡片外围有了框线之后，报头线落在同一档会跟框线抢读
    expect(head).toContain('1px solid var(--ink-3)');
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-pinned .pp-kind::after')).toContain('display: none');
    // 方墨点身份（D2 方点语言，常显、不占朱砂）替 hover 才显形的竖排「钉住」签
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-pinned .pp-kind .pp-zh::before')).toContain('var(--pp-ch-pin-dot)');
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-pinned .pp-kind .pp-prov')).toContain('margin-left: auto');
    // 竖排签退役（CSS + JSX 双面）
    expect(PANEL_CSS).not.toContain('.pp-pin-hint');
    expect(PANEL_TSX).not.toContain('pp-pin-hint');
    // 报头高进测高镜像：token 组 + 派生 + measure 的钉住态分支三处齐全
    expect(TYPE_TOKENS_TS).toContain('pinHeadH:');
    expect(TYPE_TOKENS_TS).toContain('pinChromeH:');
    expect(TYPE_TOKENS_TS).toContain('pinTextInset:');
    expect(MEASURE_TS).toContain("if (b.state === 'pinned')");
    expect(MEASURE_TS).toContain('CHROME_DERIVED.pinChromeH');
    expect(MEASURE_TS).toContain('CHROME_DERIVED.pinTextInset');
  });

  it('纸条 = 纸片件同族：纸内白边 18/20 + sheet 细纹 + 包边 + 落影（与钉块同套语言）；题签墨阶 + 方点（不占常驻朱砂）', () => {
    const strip = ruleBody(PANEL_CSS, '.pp-strip {');
    expect(strip).not.toContain('border:');
    expect(strip).toContain('background: var(--paper-deep)');
    expect(strip).toContain('padding: var(--pp-ch-strip-padV) var(--pp-ch-strip-padH)');
    expect(strip).toContain('var(--sheet-lit)');
    // 2026-09-23 质感批：纸条跟钉块**同一套语言**（同纹 / 同包边 / 同落影 / 同单线框）——
    // 「钉住块与纸条」换装纪律从 09-19 延续，只改钉块会让两者读起来是两代东西
    expect(strip).toContain('paper-sheet.jpg');
    expect(strip).toContain('background-size: 900px 900px');
    expect(strip).toContain('inset 3px 4px 5px var(--sheet-lit)');
    expect(strip).toContain('inset -2px -3px 6px var(--sheet-shade)');
    expect(strip).toContain('var(--shadow-sheet');
    expect(strip).not.toContain('var(--sheet-band)');
    // 内距定档走 token（真源 CHROME_TOKENS.strip）：10/12 → 18/20
    expect(TYPE_TOKENS_TS).toContain('strip: { size: 12.5, lh: 1.7, padV: 18, padH: 20 }');
    // 题签：方墨点 + ink 阶（旧案 seal-deep 常显 = 每屏多处红，违 §10 法则 3）
    const tag = ruleBody(PANEL_CSS, '.pp-strip-tag {');
    expect(tag).toContain('color: var(--ink-3)');
    expect(tag).not.toContain('seal');
    expect(ruleBody(PANEL_CSS, '.pp-strip-tag::before')).toContain('var(--ink-2)');
    // 两击销毁确认态：楷体（mono 栈无中文字形——P4 教训）+ 常显 + 朱砂深（人的动作）
    const confirm = ruleBody(PANEL_CSS, '.pp-strip-remove--confirm');
    expect(confirm).toContain('opacity: 1');
    expect(confirm).toContain('var(--f-kai)');
    expect(confirm).toContain('var(--seal-deep)');
  });

  it('纸条报头来源行：source.label 快照（拷贝语义）＋旧存档无字段不渲染', () => {
    expect(ruleBody(PANEL_CSS, '.pp-strip-src {')).toContain('var(--rule-soft)');
    expect(PANEL_TSX).toContain('className="pp-strip-src"');
    expect(PANEL_TSX).toContain('s.source?.label');
    // 快照取自流区显示名（唯一派生口 volumeDisplayName，禁调用点散写 label || …）
    expect(PANEL_TSX).toContain('volumeDisplayName(region.label, region.sessionNum)');
    // 批 9c-1：纸条形状上收内核契约（实现随 paper-shell 产物）——断言点随迁契约文件。
    const sel = readFileSync(join(SRC, 'paper', 'selection-contract.ts'), 'utf8');
    expect(sel).toContain('label?: string');
  });

  it('拖拽携带态 = 纸片件压印族（§11），且几何一律不动（不碰 padding/left/top/width）', () => {
    const drag = ruleBody(PANEL_CSS, '.pp-block.pp-dragging {');
    expect(drag).toContain('var(--elev-raise)');
    expect(drag).not.toContain('var(--shadow-sheet');
    expect(drag).not.toContain('paper-sheet.jpg');
    expect(drag).not.toContain('padding');
    // 落定 keyframes 只声明 translate（跨族影列形状不同，CSS 不插值）
    const settlePin = keyframesBody(PANEL_CSS, 'pp-settle-pin');
    expect(settlePin).toContain('translate: 0 -3px');
    expect(settlePin).not.toContain('box-shadow');
    const settleDrop = keyframesBody(PANEL_CSS, 'pp-settle-drop');
    expect(settleDrop).toContain('translate: 0 -2px');
    expect(settleDrop).not.toContain('box-shadow');
  });

  it('洞弱化一档：虚线语义保留（占位铁律），墨量收一档让位正文', () => {
    const ghost = ruleBody(PANEL_CSS, '.pp-ghost {');
    expect(ghost).toContain('dashed');
    expect(ghost).toContain('color-mix');
    expect(ghost).toContain('var(--ink-4)');
  });

  it('带显形：拖拽领域 = 接触落影第三档（lift token）——变色判死判例延续', () => {
    expect(TOKENS_CSS).toContain('--shadow-sheet-lift:');
    const band = ruleBody(PANEL_CSS, '.pp-region--band {');
    expect(band).toContain('var(--shadow-sheet-lift)');
    expect(band).not.toContain('background');
    expect(band).not.toContain('var(--seal)');
    // JSX 挂类（region 容器）
    expect(PANEL_TSX).toContain('pp-region--band');
  });

  it('松手定夺：路径 B（拖选跨带成条）退役——拖选只做选择，抽纸条唯二入口', () => {
    // pressStartRef/ghostRef 是路径 B 的手势状态，随路径 B 一并退役
    expect(PANEL_TSX).not.toContain('pressStartRef');
    expect(PANEL_TSX).not.toContain('ghostRef');
    // instant 旗标分流在册：眉批撕出族保留首动建钉（携带预览 = 孤儿钉跟手）
    expect(PANEL_TSX).toContain('instant: true');
    expect(PANEL_TSX).toContain('instant: false');
  });

  it('可发现性一次性眉批：localStorage 旗标 + eyebrow 族落位', () => {
    expect(PANEL_TSX).toContain("const PIN_HINT_KEY = 'lantai.hint.pinDragSeen'");
    expect(PANEL_TSX).toContain('pp-eyebrow-hint pp-hint-canvas');
    expect(ruleBody(PANEL_CSS, '.pp-hint-canvas')).toContain('position: absolute');
  });

  it('settle 动画纪律（同 pp-enter 事故立法）：keyframes 任何一帧不得声明 transform', () => {
    const pin = keyframesBody(PANEL_CSS, 'pp-settle-pin');
    expect(pin).not.toBe('');
    expect(pin).not.toMatch(/transform\s*:/);
    expect(pin).toContain('translate: 0 -3px');
    const drop = keyframesBody(PANEL_CSS, 'pp-settle-drop');
    expect(drop).not.toBe('');
    expect(drop).not.toMatch(/transform\s*:/);
    expect(drop).toContain('translate: 0 -2px');
    // 拿起态走 translate 独立属性（不占内联 transform 槽位）；opacity .92 退役
    const drag = ruleBody(PANEL_CSS, '.pp-block.pp-dragging {');
    expect(drag).toContain('translate: 0 -2px');
    expect(drag).not.toContain('opacity');
    // 回流预览态批注在册
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-drag-returning::after')).toContain('松手回流');
  });
});

describe('卷首 folio-head 钉值（2026-08-30 原型转录 → 2026-09-16「版心天头」重排 B 案）', () => {
  // ⚠ 本 describe 于 2026-09-16 随卷首重排**整体改写**——故意规格变更，显式声明
  // （用户拍板 B 案，原型台 prototype/folio-head-ab.html + 读数栏为证）。
  // 旧形态的病灶（实测）：玉徽居中于**整张纸**（默认 1440 宽流区的中轴 x=720），
  // 眉行/题字/档行却左齐于纸缘内距 16px，正文块居中于 720 版心（左缘 x=360）
  // ——题字比正文左缘还左 344px、组合芯片比版心右缘还右 326px：一块卷首三个轴。
  // 新形态：卷首收进版心内层，四行同轴居中，硬规线与版口钮一并锁版心宽。
  // 2026-10-08「墨占纸半」二次改写：版心封顶 720 退役——版心宽 = 流区宽 × 0.5
  // （真源 = measure.ts columnWidthFor；CSS 镜像 = .pp-folio-inner 的 50%）。
  it('卷首结构：版心内层（四行同轴）+ 硬规线锁版心 + 朱砂版口钮挂规线左端', () => {
    const head = ruleBody(PANEL_CSS, '.pp-folio-head {');
    // 硬规线已移出版心内层之外的外盒（随之上移到 .pp-folio-inner）——外盒只剩内距
    // （2026-10-08：左右内距 16 随版心改式退役——版心 = 纸半）
    expect(head).not.toContain('border-bottom');
    expect(head).toContain('padding: 24px 0 0');
    // pointer-events none：点击穿透流区背景，激活语义不变
    expect(head).toContain('pointer-events: none');
    // 版心内层：宽 min(720, 100%) 居中 + 硬规线 + 居中排印（= 与正文块同轴同宽）
    const inner = ruleBody(PANEL_CSS, '.pp-folio-inner {');
    expect(inner).toContain('width: 50%'); // 版心 = 纸半（2026-10-08）
    expect(inner).toContain('margin: 0 auto');
    expect(inner).toContain('border-bottom: var(--rule-hard)');
    expect(inner).toContain('text-align: center');
    expect(inner).toContain('padding-bottom: 22px');
    // 玉徽居中于**版心**（不再居中于整张纸）
    const yuwei = ruleBody(PANEL_CSS, '.pp-yuwei');
    expect(yuwei).toContain('margin: 0 auto 14px');
    expect(yuwei).toContain('width: 26px');
    // 版口钮 2026-09-02 改档：只挂活跃卷（.pp-region-active 前缀）——整屏至多一处红，
    // 红在哪卷即活卷（对原型 .folio-head 的主动偏离：原型卷卷都挂，先于一纸多卷定案）。
    // 2026-09-16：钮随硬规线移进版心内层，left: 0 = 版心左缘（不再飘在纸缘）。
    const tab = ruleBody(PANEL_CSS, '.pp-region-active .pp-folio-inner::after');
    expect(tab).toContain('left: 0');
    expect(tab).toContain('width: 56px');
    expect(tab).toContain('height: 3px');
    // 版口钮是朱砂——卷首钤印语义（朱砂=人/仪式），非状态色挪用
    expect(tab).toContain('background: var(--seal)');
    // 朱笔划界（2026-09-10 拍板「拿纸 + 朱笔划界」）：激活瞬间红条从 0 划到
    // 56px——落笔划界的书写感。宽度动画不走 transform（块级 transform 事故
    // 立法同源）；缓动走 §15 的 `--m-ease-out`（2026-10-15 动效法批：时长 0.24s
    // 属**仪式档**故原样保留、登记在案，只把散写 bezier 换成具名曲线 token）。
    expect(tab).toContain('animation: pp-seal-draw 0.24s var(--m-ease-out)');
    const draw = keyframesBody(PANEL_CSS, 'pp-seal-draw');
    expect(draw).not.toBe('');
    expect(draw).not.toMatch(/transform\s*:/);
    expect(draw).toContain('width: 0');
    expect(draw).toContain('width: 56px');
    // 标签带退役（卷首即卷名，不重复播报）
    expect(PANEL_CSS).not.toContain('.pp-region-label');
    expect(PANEL_TSX).toContain('pp-folio-head');
    expect(PANEL_TSX).toContain('pp-folio-inner');
    expect(PANEL_TSX).not.toContain('pp-region-label');
  });

  it('卷首排印：眉行/题字/档行（2026-09-16 单族重校——三体换代后层级只剩字号/字重/字距）', () => {
    // 10px 的 MiSans 压纸纹太弱 → 机读两行升 11px；居中天头要更松的机读感 → 眉行字距加宽
    const eyebrow = ruleBody(PANEL_CSS, '.pp-folio-eyebrow');
    expect(eyebrow).toContain('font-size: 11px');
    expect(eyebrow).toContain('letter-spacing: 0.34em');
    // 末字后的字距会把整行视觉左推 → 补同值缩进（居中是真空）
    expect(eyebrow).toContain('text-indent: 0.34em');
    expect(eyebrow).toContain('var(--ink-3)');
    const title = ruleBody(PANEL_CSS, '.pp-folio-title');
    expect(title).toContain('font-size: 36px');
    expect(title).toContain('line-height: 1.22');
    expect(title).toContain('var(--f-song)');
    const sub = ruleBody(PANEL_CSS, '.pp-folio-sub');
    expect(sub).toContain('letter-spacing: 0.18em');
    expect(sub).toContain('font-variant-numeric: tabular-nums');
  });

  it('卷首组合芯片（S6 P5a）：覆盖式落位（不进高度流水）+ 只放开本子树事件 + 卷首本体仍穿透', () => {
    // 覆盖式落位：绝对定位在**版心右上**、与眉行同行——**不进高度流水** ⇒ 卷首高度镜像
    // （FOLIO_TOKENS → measureFolioHeadHeight → 卷级几何）仍不被控件牵动。
    // 2026-09-16 改锚点：原为纸缘右上（top 16 / right 18），离版心右缘 +326px 孤悬，
    // 与居中的玉徽成对角；现以版心为参照系。
    const comp = ruleBody(PANEL_CSS, '.pp-folio-comp {');
    expect(comp).toContain('position: absolute');
    expect(comp).toContain('top: 1px');
    expect(comp).toContain('right: 0');
    // 卷首本体是 pointer-events:none（点击穿透流区背景）——芯片是**唯一例外**，
    // 只放开本子树（改掉下面这条 none = 卷首整块变成点击热区，激活语义被破坏）
    expect(comp).toContain('pointer-events: auto');
    expect(ruleBody(PANEL_CSS, '.pp-folio-head {')).toContain('pointer-events: none');
    // 菜单向下开（卷首在卷顶，下方是流区）
    expect(ruleBody(PANEL_CSS, '.pp-folio-comp-menu {')).toContain('top: calc(100% + 4px)');
    // 挂载点：芯片在版心内层里，作用对象 = **本 region 的卷**（不是"当前活跃卷"）
    expect(PANEL_TSX).toContain('<FolioCompositionChip core={core} sessionId={r.sessionId} />');
  });

  it('测量镜像：type-tokens.ts 卷首真源与 CSS **逐项**对映（改一处必改多处）+ 亭徽图标在册', () => {
    // token 化后单一真源 = type-tokens.ts（measure 派生自它，CSS 逐字对映它——
    // 2026-09-16 前只有 4 项被钉，其余 6 项改了没人拦：本测补齐为**全项对映**）
    expect(TYPE_TOKENS_TS).toContain('titleSize: 36');
    expect(TYPE_TOKENS_TS).toContain('titleLh: 1.22');
    expect(TYPE_TOKENS_TS).toContain('eyebrowH: 15');
    expect(TYPE_TOKENS_TS).toContain('subH: 15');
    expect(TYPE_TOKENS_TS).toContain('padTop: 24');
    expect(TYPE_TOKENS_TS).toContain('padBottom: 24');
    expect(TYPE_TOKENS_TS).toContain('yuweiH: 40');
    expect(TYPE_TOKENS_TS).toContain('titleMarginTop: 14');
    expect(TYPE_TOKENS_TS).toContain('subMarginTop: 14');
    expect(TYPE_TOKENS_TS).toContain('headGap: 28');
    // colW 不再是 token（2026-10-08）：版心宽 = 流区宽 × COLUMN_RATIO——真源在 measure.ts
    expect(TYPE_TOKENS_TS).not.toContain('colW');
    // ── CSS ↔ token 逐项对映（每项都要在对应规则体内找到字面量）──
    const head = ruleBody(PANEL_CSS, '.pp-folio-head {');
    const inner = ruleBody(PANEL_CSS, '.pp-folio-inner {');
    const yuwei = ruleBody(PANEL_CSS, '.pp-yuwei');
    const eyebrow = ruleBody(PANEL_CSS, '.pp-folio-eyebrow');
    const title = ruleBody(PANEL_CSS, '.pp-folio-title');
    const sub = ruleBody(PANEL_CSS, '.pp-folio-sub');
    expect(head).toContain('padding: 24px 0 0'); // padTop 24（左右内距 16×2 随版心改式退役）
    expect(inner).toContain('padding-bottom: 22px'); // padBottom 24 = 22 + rule-hard 2
    expect(inner).toContain('width: 50%'); // 版心 = 纸半（measure.ts COLUMN_RATIO 的 CSS 镜像）
    expect(yuwei).toContain('width: 26px'); // yuweiH 40 = 26 + margin 14
    expect(yuwei).toContain('margin: 0 auto 14px');
    expect(eyebrow).toContain('line-height: 15px'); // eyebrowH 15
    expect(sub).toContain('line-height: 15px'); // subH 15
    expect(title).toContain('margin-top: 14px'); // titleMarginTop 14
    expect(sub).toContain('margin-top: 14px'); // subMarginTop 14
    // 测高侧：入参 = **流区宽**，版心宽（纸半）在函数内算清（调用点不再手写换算）
    expect(MEASURE_TS).toContain('FOLIO_TOKENS.titleSize');
    expect(MEASURE_TS).toContain('export const COLUMN_RATIO = 0.5');
    expect(MEASURE_TS).toContain('export function columnWidthFor(regionWidth: number)');
    expect(MEASURE_TS).toContain('return regionWidth * COLUMN_RATIO');
    expect(MEASURE_TS).toContain('export function measureFolioHeadHeight(title: string, regionWidth: number)');
    // 行为面（版心随流区宽同比、换行真的计入高度）见 tests/paper-folio-height.test.ts
    expect(ICONS_TS).toContain('lantai: {');
    expect(ICONS_TS).toContain('M4 9.2 L12 3.4 L20 9.2');
  });
});

describe('浸墨法则钉值（规格书 §10，2026-08-31 用户拍板 B）', () => {
  it('法则入宪：tokens 载 --weight-display/--shadow-anchor/--vignette/--laid-lines，字体装载 900（2026-09-10 三体换代：MiSans VF 100-900 全字重）', () => {
    expect(TOKENS_CSS).toContain('--weight-display: 900');
    expect(TOKENS_CSS).toContain('--shadow-anchor: 2px 3px 0');
    expect(TOKENS_CSS).toContain('--vignette: radial-gradient');
    expect(TOKENS_CSS).toContain('--laid-lines: repeating-linear-gradient');
    expect(FONTS_TS).toContain("import './fonts.css'");
    expect(FONTS_CSS).toContain('font-family: "MiSans"');
    expect(FONTS_CSS).toContain('font-weight: 100 900');
  });

  it('墨阶锚点：首页书眉/列顶/脚线 + 坞顶升硬线，主钮投影（画布书眉底线已随标题栏退役）', () => {
    expect(ruleBody(HOME_CSS, '.sh-head {')).toContain('border-bottom: var(--rule-hard)');
    expect(ruleBody(HOME_CSS, '.sh-workspaces {')).toContain('border-top: var(--rule-hard)');
    expect(ruleBody(HOME_CSS, '.sh-foot {')).toContain('border-top: var(--rule-hard)');
    // 画布视图的屏级顶线（旧 .pp-topbar 的书眉底线）随 2026-09-17 标题栏拆除退役：
    // 画布铺满整窗，顶部控制件改为**覆盖件浮件**（弱线 + 浮起，不是分区硬线）——
    // 该视图的屏级分区线只剩坞顶线
    expect(ruleBody(PANEL_CSS, '.pp-chrome {')).toContain('border: var(--rule-soft)');
    expect(ruleBody(PANEL_CSS, '.pp-composer {')).toContain('border-top: var(--rule-hard)');
    const send = ruleBody(PANEL_CSS, '.pp-composer .pp-send');
    expect(send).toContain('box-shadow: var(--shadow-anchor)');
    expect(send).toContain('font-weight: 600');

    // 钤印单钮三态（2026-09-03）：停 = 朱砂实心章同构（实心 + 硬投影），
    // 与拟文墨印同形却不同色相——色相即语义（墨=落款/插话，朱=中止警示）
    // 注：ruleBody 会命中更早的钤印基座（公共选择器），故钉整块主规则文本
    expect(PANEL_CSS).toContain(
      '.pp-composer .pp-stop {\n  background: var(--seal);\n  border-color: var(--seal);\n  color: var(--paper);\n  box-shadow: var(--shadow-anchor);',
    );
  });

  it('版口钮：坞顶 56px 朱砂（全坞唯一暖色件）', () => {
    const btn = ruleBody(PANEL_CSS, '.pp-composer::before');
    expect(btn).toContain('width: 56px');
    expect(btn).toContain('var(--seal)');
  });

  it('字重极端：题字 900 / 卷首 700 / 卷名 600；句读点朱', () => {
    expect(ruleBody(HOME_CSS, '.sh-h1')).toContain('var(--weight-display)');
    expect(ruleBody(HOME_CSS, '.sh-h1 .sh-ju')).toContain('var(--seal)');
    expect(ruleBody(PANEL_CSS, '.pp-folio-title')).toContain('font-weight: 700');
    expect(ruleBody(PANEL_CSS, '.pp-composer-target')).toContain('font-weight: 600');
    expect(ruleBody(PANEL_CSS, '.pp-empty-title')).toContain('var(--weight-display)');
  });

  it('书眉卷名吃满余量（2026-09-13）：定宽 132px 退役——按内容长 + 封顶，不许回退', () => {
    // 病灶：书眉行右端只有翰/律两枚小钮，132px 定宽把卷名一律截在十来个字，
    // 白白空着大半行。定稿 = flex 按内容 + max-width 封顶（余量归 spacer）。
    const target = ruleBody(PANEL_CSS, '.pp-composer-target');
    expect(target).not.toContain('flex: 0 0');
    expect(target).toContain('flex: 0 1 auto');
    expect(target).toContain('max-width: 64%');
    // 余量吸收件仍在（右端控件不吃卷名宽度）
    expect(ruleBody(PANEL_CSS, '.pp-composer-settings-spacer')).toContain('flex: 1');
    // 书眉行不换行纪律不变（换行会与输入行抢高度）
    expect(target).toContain('text-overflow: ellipsis');
  });

  it('纸层次（2026-09-01 真纸化）：真纹理双资产乘印 + SVG 微颗粒 + 顶光边沉帘纹（body 文档级 before/after）', () => {
    // 真纸纹理资产接线（feTurbulence 程序噪声退役——真纤维/斑点，cover 免接缝；
    // 挂 body 文档级——2026-09-01 实机打回：错挂 .sh-root 时纹理被困首页，画布/面板无纹理）
    expect(FOUNDATION_CSS).toContain('../assets/paper/paper-grain.jpg');
    expect(FOUNDATION_CSS).toContain('../assets/paper/paper-fiber.jpg');
    expect(FOUNDATION_CSS).toContain('background-blend-mode: normal, multiply, multiply');
    expect(FOUNDATION_CSS).toContain('mix-blend-mode: multiply');
    expect(FOUNDATION_CSS).toContain('body::after');
    // 极弱 SVG 微颗粒保留（抗色带）
    expect(FOUNDATION_CSS).toContain("opacity='0.05'");
    // 纸层次：顶光 + 帘纹 + 边沉
    expect(FOUNDATION_CSS).toContain('body::before');
    expect(FOUNDATION_CSS).toContain('var(--light-fall)');
    expect(FOUNDATION_CSS).toContain('var(--laid-lines)');
    expect(FOUNDATION_CSS).toContain('var(--vignette)');
    expect(TOKENS_CSS).toContain('--light-fall: linear-gradient');
  });

  it('选中态文字语言：重墨 + 朱砂底线（2026-09-01 重皮拍板：盒装黑块退役——设置行唯一墨底锚点只留拟文印）', () => {
    const sel = ruleBody(PANEL_CSS, '.pp-mode-opt.selected');
    expect(sel).toContain('background: transparent');
    expect(sel).toContain('color: var(--ink-1)');
    expect(sel).toContain('border-bottom-color: var(--seal)');
  });

  it('节题墨块锚点（首页）', () => {
    expect(ruleBody(HOME_CSS, '.sh-section-title .t::before')).toContain('background: var(--ink-1)');
    expect(ruleBody(HOME_CSS, '.sh-section-title .n')).toContain('var(--seal-deep)');
  });

  it('材质批（2026-09-01）：印章印泥分材质 + 墨迹洇边', () => {
    // 印泥：全局「局部禁挂纹理」的唯一例外——印泥≠纸，中性灰纹理乘 --seal 实色
    const seal = ruleBody(HOME_CSS, '.sh-seal {');
    expect(seal).toContain('url("../../../assets/paper/seal-paste.jpg")');
    expect(seal).toContain('background-blend-mode: multiply');
    expect(seal).toContain('background-color: var(--seal)');
    // 洇边：重墨大字墨渗（同 folio-title 的 ink-solid alpha 残影手法）
    expect(ruleBody(HOME_CSS, '.sh-h1 {')).toContain('text-shadow: 0 0 1.5px');
    expect(ruleBody(HOME_CSS, '.sh-section-title .t {')).toContain('text-shadow: 0 0 1px');
    const anchor = ruleBody(HOME_CSS, '.sh-section-title .t::before');
    expect(anchor).toContain('box-shadow: 0 0 2px');
  });

  it('流区真纸（2026-09-01 材质批二 + 2026-09-02 物理包边改档）：每卷一张纸——不透明底 + 纸纹乘印 + 纸性三参', () => {
    const region = ruleBody(PANEL_CSS, '.pp-region {');
    expect(region).toContain('paper-sheet.jpg');
    expect(region).toContain('background-blend-mode: multiply');
    expect(region).toContain('var(--sheet-ox');
    expect(region).toContain('var(--sheet-j');
    // 接触落影仍在列序末位（2026-09-02 起前面叠裱边带/受光缘/背光缘——物理包边）
    expect(region).toContain('var(--shadow-sheet)');
    expect(TOKENS_CSS).toContain('--shadow-sheet:');
    // active 2026-09-02 改档：洗底退役（「变色」判死）——不动任何 background，
    // 只换落影一档；background 简写禁令延续（会抹纸纹层）
    const active = ruleBody(PANEL_CSS, '.pp-region-active {');
    expect(active).not.toContain('background');
    expect(active).toContain('var(--shadow-sheet-active)');
  });
});

describe('贴纸纹理归属（2026-09-02 透明错觉根治批）', () => {
  // 真因复盘：流区一直在画（实机活体双盲——荧光绿/品红桌面均画得出），
  // 「透」= 视口固定层以「不动之纹」出卖空间隐喻：拖动时纸走纹不走。
  // 三层固定纹：body::after 颗粒 / body::before 帘纹 / （已被材质批移除的流区自纹缺失）。

  it('文档级颗粒层画布退役：body:has(.pp-root)::after 隐去（fixed 纹理 = 不动之纹，出卖拖动）', () => {
    const retire = ruleBody(FOUNDATION_CSS, 'body:has(.pp-root)::after');
    expect(retire).toContain('display: none');
    // 文档级配方本体保留（首页/面板照旧）
    expect(ruleBody(FOUNDATION_CSS, 'body::after {')).toContain('mix-blend-mode: multiply');
  });

  it('帘纹归属：画布态 body::before 只剩光照类（顶光+边沉，光滑无纹）；非画布态保留完整三件', () => {
    const before = ruleBody(FOUNDATION_CSS, 'body::before');
    expect(before).toContain('var(--light-fall)');
    expect(before).toContain('var(--vignette)');
    expect(before).not.toContain('var(--laid-lines)');
    const home = ruleBody(FOUNDATION_CSS, 'body:not(:has(.pp-root))::before');
    expect(home).toContain('var(--laid-lines)');
    expect(home).toContain('var(--light-fall)');
    expect(home).toContain('var(--vignette)');
  });

  it('模态面板豁免（2026-09-10 两场景统一）：设置遮罩在场恢复文档级材质——工作区开设置不再被画布态连坐剥光', () => {
    // 纹理层恢复（id 特异性压过画布态退役的 display:none）
    const modal = ruleBody(FOUNDATION_CSS, 'body:has(#settings-panel-overlay)::after');
    expect(modal).toContain('display: block');
    // 帘纹+顶光+边沉三件齐回（与首页开设置同观感）
    const before = ruleBody(FOUNDATION_CSS, 'body:has(#settings-panel-overlay)::before');
    expect(before).toContain('var(--laid-lines)');
    expect(before).toContain('var(--light-fall)');
    expect(before).toContain('var(--vignette)');
    // 画布态退役本体不受影响（设置关掉即回画布无纹态）
    const retire = ruleBody(FOUNDATION_CSS, 'body:has(.pp-root)::after');
    expect(retire).toContain('display: none');
  });

  it('桌垫：世界内纸面——四层配方（微颗粒×grain×fiber×帘纹）+ 无界巨幅 + 不与流区混合', () => {
    const desk = ruleBody(PANEL_CSS, '.pp-desk {');
    // 桌面纸配方：与 body::after 同源 + 帘纹归桌面
    expect(desk).toContain('background-color: var(--paper)');
    expect(desk).toContain('paper-grain.jpg');
    expect(desk).toContain('paper-fiber.jpg');
    expect(desk).toContain('var(--laid-lines)');
    expect(desk).toContain('normal, multiply, multiply, multiply');
    expect(desk).toContain('brightness(1.05)');
    // 只混自身层（background-blend），不乘盖流区/纸条（无 mix-blend-mode）
    expect(desk).not.toContain('mix-blend-mode');
    // 无界近似：±200000px 世界坐标
    expect(desk).toContain('left: -200000px');
    expect(desk).toContain('width: 400000px');
    // 事件穿透（平移命中 .pp-world 语义）
    expect(desk).toContain('pointer-events: none');
    // TSX 挂载：world 第一子（DOM 序即层序，垫在一切世界内容之下）
    expect(PANEL_TSX).toContain('className="pp-desk"');
  });

  it('板面纹理同配方（2026-09-21 侧栏纸面批）：三处**内联**同一四层配方，禁提 token', () => {
    // 病灶交代：画布态把文档级纹理层整层退役（body:has(.pp-root)::after），固定家具
    // 只剩 flat --paper，用户判「死气沉沉」⇒ 侧栏/书脊各挂一层板面纹理。
    //
    // ⚠ 为什么是**内联三份**而不是一个 token（本批踩过的坑，勿回退）：
    // 三个消费面里 .pp-desk / .ss-sidebar / .sr-rack **全在插件产物里**（磁盘通道
    // 热更 ⇒ 换产物不重编译 exe），而 tokens.css 烧在 exe 里。产物一旦依赖「比壳层
    // 新的 token」，热更产物上了旧壳就解析成 none——实机症状 = 桌垫纸纹整片消失
    // （只剩流区有纹，因为它内联 paper-sheet.jpg）。产品自包含（图片 base64 内联进
    // entry.css）是硬约束 ⇒ 配方必须跟着产物走，复制品由本用例钉住不许漂移。
    const consumers: Array<[string, string]> = [
      [PANEL_CSS, '.pp-desk {'],
      [SIDEBAR_CSS, '.ss-sidebar::before {'],
      [SPINE_CSS, '.sr-rack::before {'],
    ];
    const recipes = consumers.map(([css, sel]) => {
      const body = ruleBody(css, sel);
      return {
        sel,
        img: /background-image:\s*([\s\S]*?);/.exec(body)?.[1].replace(/\s+/g, ' ').trim(),
        size: /background-size:\s*([\s\S]*?);/.exec(body)?.[1].replace(/\s+/g, ' ').trim(),
        blend: /background-blend-mode:\s*([^;]*);/.exec(body)?.[1].trim(),
        bright: /brightness\(([^)]*)\)/.exec(body)?.[1],
      };
    });
    for (const r of recipes) {
      expect(r.img, r.sel).toContain('paper-grain.jpg');
      expect(r.img, r.sel).toContain('paper-fiber.jpg');
      expect(r.img, r.sel).toContain('var(--laid-lines)');
      expect(r.size, r.sel).toBe('180px 180px, 2048px 2048px, 2048px 2048px, auto');
      expect(r.blend, r.sel).toBe('normal, multiply, multiply, multiply');
      expect(r.bright, r.sel).toBe('1.05');
    }
    // 三份逐字相同（图片层 / 尺寸 / 混合 / 提亮四项全等）
    for (const key of ['img', 'size', 'blend', 'bright'] as const) {
      expect(recipes[1][key], `${key} 侧栏 vs 桌垫`).toBe(recipes[0][key]);
      expect(recipes[2][key], `${key} 书脊 vs 桌垫`).toBe(recipes[0][key]);
    }
    // 纹理层落在面板底色之上、内容之下（z:-1），且不吃指针
    for (const [css, sel] of consumers.slice(1)) {
      const body = ruleBody(css, sel);
      expect(body, sel).toContain('z-index: -1');
      expect(body, sel).toContain('pointer-events: none');
    }
    // 两态同一块板：底色同族
    expect(ruleBody(SIDEBAR_CSS, '.ss-sidebar {')).toContain('background: var(--paper)');
    expect(ruleBody(SPINE_CSS, '.sr-rack {')).toContain('background: var(--paper)');
    // **回归守卫**：壳层/产物都不许再冒出 --panel-tex-*（提 token = 上面那条坑复现）
    expect(TOKENS_CSS).not.toContain('--panel-tex-');
    for (const [css, sel] of consumers) {
      expect(ruleBody(css, sel), sel).not.toContain('--panel-tex-');
    }
    // 尺寸走固定 tile（2048）而非 cover：cover 随容器高矮变缩放，家具与桌面颗粒
    // 不一就「不像同一批纸」（流区 1200 平铺的同一条判例）
    expect(TOKENS_CSS).not.toContain('--panel-tex-size: cover');
  });

  it('流区帘纹退役：单层纸纹（纸性由 paper-sheet 独自承载——帘纹叠乘读作屏纹，实机过审移除）', () => {
    const region = ruleBody(PANEL_CSS, '.pp-region {');
    expect(region).not.toContain('var(--laid-lines)');
    expect(region).toContain('paper-sheet.jpg');
  });

  it('中间形态退役：不留下任何视口级纹理覆盖层（pp-canvas-grain）', () => {
    expect(PANEL_CSS).not.toContain('pp-canvas-grain');
    expect(PANEL_TSX).not.toContain('pp-canvas-grain');
    expect(PANEL_TSX).not.toContain('grainStyle');
  });

  it('空态提层：桌垫入场后 pp-empty 须浮于世界单元之上', () => {
    expect(ruleBody(PANEL_CSS, '.pp-empty {')).toContain('z-index: 2');
  });

  it('贴纸纹预处理管道：-Sheet 模式线性扩幅回中（a=1.63/b=-0.555——振幅立得住、纸色不动）', () => {
    expect(NORMALIZE_PS1).toContain('[switch]$Sheet');
    expect(NORMALIZE_PS1).toContain('[double]$sheetA = 1.63');
    expect(NORMALIZE_PS1).toContain('[double]$sheetB = -0.555');
    expect(NORMALIZE_PS1).toContain('a=1.63 / b=-0.555');
  });
});

describe('会话流版式节奏钉值（stream-rhythm 刀2，2026-09-03——D1 试值待用户真机终审）', () => {
  it('间距三档 + 转折/阶段放空：canvas-math 真源（intra 32 < 块距 48 < unit 64 < recovery/stage 96）', () => {
    expect(CANVAS_MATH_TS).toContain('intraUnitGap: 32');
    expect(CANVAS_MATH_TS).toContain('unitGap: 64');
    expect(CANVAS_MATH_TS).toContain('recoveryLeadGap: 96');
    expect(CANVAS_MATH_TS).toContain('stageGap: 96');
    // B1 基线不动（无节奏信息的外部调用面）：块距 48 / 来文尾距 8
    expect(CANVAS_MATH_TS).toContain('blockGap: 48');
    expect(CANVAS_MATH_TS).toContain('userTailGap: 8');
  });

  it('阶段细线（D2 最素形态）：弱线落阶段间距中线，跨块宽', () => {
    const rule = ruleBody(PANEL_CSS, '.pp-block.pp-stage-lead::before');
    expect(rule).toContain('top: -48px');
    expect(rule).toContain('border-top: var(--rule-soft)');
    expect(rule).toContain('left: 0');
    expect(rule).toContain('right: 0');
  });

  it('接线在册：工作单元 pass 进 PaperPanel 核心，来文块挂阶段类', () => {
    expect(PANEL_TSX).toContain('groupWorkUnits');
    // 刀5 演进：membership 内化进 rhythmAssign(blocks, units)——分派单一真源
    expect(PANEL_TSX).toContain('rhythmAssign(blocks, units)');
    expect(PANEL_TSX).toContain('sealedMessageIdsOf');
    expect(PANEL_TSX).toContain('pp-stage-lead');
    // 封口纪律 + 跨消息前瞻禁止（宪法条款在纯函数真源里在册）
    expect(GROUP_TS).toContain('跨消息前瞻禁止');
    expect(GROUP_TS).toContain('封口纪律');
  });
});

describe('Error 墨色家族（stream-rhythm 刀4c 确认，2026-09-03——现状合规零改动，钉防漂移）', () => {
  it('错误状态色 = --fail 墨浓红（非纯红、非朱砂——朱砂=人铁律不挪用）', () => {
    expect(TOKENS_CSS).toContain('--fail: #a9443f');
    // 纯红字面量不进纸面（B5 红绿墨色化纪律的延伸）
    expect(TOKENS_CSS).not.toMatch(/#f00;|#ff0000/i);
    expect(PANEL_CSS).not.toMatch(/#f00;|#ff0000/i);
  });

  it('错因墓碑（turn-error）：贴黄款——朱砂淡底只作纸晕（7%），墨身走 ink-2', () => {
    const rule = ruleBody(PANEL_CSS, '.pp-block.pp-turn-error {');
    expect(rule).toContain('color-mix(in oklch, var(--seal) 7%, var(--paper))');
    const body = ruleBody(PANEL_CSS, '.pp-block.pp-turn-error .pp-body');
    expect(body).toContain('color: var(--ink-2)');
    expect(body).not.toContain('var(--seal)');
  });

  it('工具/程文错误输出与状态签：--fail 单一真源（2026-09-14 起错误墨归 CSS 段类）', () => {
    expect(ruleBody(PANEL_CSS, '.pp-status.pp-error')).toContain('color: var(--fail)');
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-tool .pp-out--err')).toContain('color: var(--fail)');
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-code .pp-out--err')).toContain('color: var(--fail)');
    // 渲染端 inline style 退役（旧两处 inline 色 → 段类承载；改错误面色先过此钉改账）
    expect(RENDERER_TS).not.toContain("color: 'var(--fail)'");
    expect(RENDERER_TS).toContain('pp-out--err');
  });
});

describe('工具卡载荷可读性定稿（2026-09-14——「展开乱得像乱码」根治批）', () => {
  it('长 token 不再腰斩：break-all 在载荷族退役，只留 break-word', () => {
    // break-all 在 token 中间下刀（路径/JSON 串读成乱码）；break-word 只在单词超宽时断
    for (const sel of ['.pp-block.pp-tool .pp-args', '.pp-block.pp-tool .pp-out', '.pp-block.pp-code .pp-out']) {
      const rule = ruleBody(PANEL_CSS, `${sel} {`);
      expect(rule, sel).not.toContain('word-break: break-all');
      expect(rule, sel).toContain('overflow-wrap: break-word');
      expect(rule).toContain('white-space: pre-wrap');
    }
  });

  it('载荷段头（参数/输出/错误）：小字标 + 细规线，几何全走 token', () => {
    const head = ruleBody(PANEL_CSS, '.pp-sec-head {');
    expect(head).toContain('font-size: var(--pp-ch-secHead-size)');
    expect(head).toContain('line-height: var(--pp-ch-secHead-lh)');
    // 规格变更（2026-09-17 规线简写修复）：此处原钉 `1px solid var(--rule-soft)` ——
    // 那是**非法声明**（--rule-soft 是整条简写，拼起来展开成 `1px solid 1px solid …`
    // 被 CSS 丢弃 ⇒ 这条线从未画出来）。改为颜色位；依据 docs/plans/tool-image-context-plan.md §6。
    expect(ruleBody(PANEL_CSS, '.pp-sec-head::after')).toContain('border-top: 1px solid var(--rule-soft-ink)');
    expect(ruleBody(PANEL_CSS, '.pp-sec--gap')).toContain('margin-top: var(--pp-ch-secHead-marginTop)');
    // 语义色：入=石青（机器的输入）/ 出=中性注记墨（缺省）/ 错误=--fail
    expect(ruleBody(PANEL_CSS, '.pp-sec--args .pp-sec-label')).toContain('var(--indigo)');
    expect(ruleBody(PANEL_CSS, '.pp-sec-label {')).toContain('var(--ink-4)');
    expect(ruleBody(PANEL_CSS, '.pp-sec--err .pp-sec-label')).toContain('var(--fail)');
    // 测量镜像：真源在 type-tokens（CSS 走 --pp-ch-* 注入，paper-token-audit 守护零悬空）
    expect(TYPE_TOKENS_TS).toContain('secHead: { size: 10, lh: 1.4, marginTop: 6 }');
    expect(MEASURE_TS).toContain('SEC_HEAD_H');
  });

  it('载荷四档墨（键/值/字面量/结构符）：纸面墨阶不引新色相', () => {
    expect(ruleBody(PANEL_CSS, '.pp-tv-k')).toContain('var(--ink-3)');
    expect(ruleBody(PANEL_CSS, '.pp-tv-s')).toContain('var(--ink-1)');
    expect(ruleBody(PANEL_CSS, '.pp-tv-n')).toContain('var(--indigo)');
    expect(ruleBody(PANEL_CSS, '.pp-tv-p')).toContain('var(--ink-4)');
    // 接线在册：渲染端 tone → 类的映射单一真源
    expect(RENDERER_TS).toContain('pp-tv-k');
  });

  it('夹注折叠预览：最新一行恒一行（nowrap + ellipsis，不再 max-height 硬裁半截字）', () => {
    const preview = ruleBody(PANEL_CSS, '.pp-fold-preview {');
    expect(preview).toContain('white-space: nowrap');
    expect(preview).toContain('text-overflow: ellipsis');
    expect(preview).toContain('overflow: hidden');
    // 预览行取末行（真源在 paper/fold）
    expect(readFileSync(join(SRC, 'paper', 'fold.ts'), 'utf8')).toContain('最新一行');
  });
});

describe('程文输出换代（2026-09-19——「输出栏一点没处理，跟乱码一样」根治批）', () => {
  const TOOL_TEXT_TS = readFileSync(join(SRC, 'paper', 'tool-text.ts'), 'utf8');
  const BOOTSTRAP_TS = readFileSync(join(SRC, 'agent', 'code-run', 'bootstrap.ts'), 'utf8');
  const TOOL_TS = readFileSync(join(SRC, 'agent', 'code-run', 'code-execution-tool.ts'), 'utf8');

  it('完成值段（日志/完成值/错误）走 .pp-sec-head 同一套；完成值 = 石青答案段', () => {
    expect(ruleBody(PANEL_CSS, '.pp-sec--result .pp-sec-label')).toContain('var(--indigo)');
    // 段语义挂在渲染端（单一真源 = paper/tool-text 的 codeDisplay）
    expect(RENDERER_TS).toContain('codeDisplay');
    expect(TOOL_TEXT_TS).toContain('错误 · '); // 失败分类升格成段头文案
  });

  it('信封是自产契约：生成端与解析端成对（改一边即红）', () => {
    for (const mark of ['── logs ──', '── result ──', '── code run failed (', '[code_execution 失败] kind=']) {
      expect(TOOL_TS, mark).toContain(mark);
      expect(TOOL_TEXT_TS, mark).toContain(mark);
    }
  });

  it('测量镜像：code 块段高走 codeOutSections 单一入口（两处 y 累加同源）', () => {
    const hits = MEASURE_TS.split('codeOutSections(').length - 1;
    expect(hits).toBe(3); // 定义 1 + 墨迹 1 + 测高 1
  });

  it('字符串完成值不再二次 JSON 编码（数据面根治；展示面另有解转义兜旧卷）', () => {
    // worker 侧分支：字符串原样出，只有非字符串才 JSON.stringify
    expect(BOOTSTRAP_TS).toContain("if (typeof value === 'string')");
    expect(BOOTSTRAP_TS).toContain('text = value;');
    // 日志 inspect 有界（注释承诺过、旧实现并不存在的深度封顶）
    expect(BOOTSTRAP_TS).toContain('INSPECT_DEPTH');
    expect(BOOTSTRAP_TS).toContain('[Circular]');
    // 展示面解转义层数封顶（防套娃）
    expect(TOOL_TEXT_TS).toContain('MAX_UNWRAP');
  });

  it('值级展开与尽力结构打印在册（内嵌文档 / 截断 JSON 两条兜底）', () => {
    expect(TOOL_TEXT_TS).toContain('expandStringValue');
    expect(TOOL_TEXT_TS).toContain('bestEffortLines');
    expect(TOOL_TEXT_TS).toContain('JSON_SHAPE_RE'); // 不像 JSON 的长行不误判（shell 行）
    expect(TOOL_TEXT_TS).toContain('MAX_EXPAND');
    // 展示变换是渲染/测量的唯一上游（三面同源）
    expect(MEASURE_TS).toContain('codeDisplay');
  });
});

describe('会话流族节奏（stream-rhythm 刀5，2026-09-03——族边界切单元后真机判「瀑布未破」的根治批）', () => {
  it('族边界切单元在册：group 消费节律族 + translate 按族切组 + grammar 节律族面', () => {
    expect(GROUP_TS).toContain('族边界（刀5 A）');
    expect(GROUP_CONTRACT_TS).toContain('family?: RhythmFamily | null');
    expect(TRANSLATE_TS).toContain('族变断组');
    expect(GRAMMAR_TS).toContain('rhythmFamilyOfBlock');
  });

  it('单元界短规线（D）：比阶段全宽线弱一档——top -32（unitGap/2）/ 宽 96 / rule-soft', () => {
    // 2026-09-06 尸检改：原 .pp-block.pp-unit-lead::before 与脚注族注线
    // （.pp-tool/.pp-toolgroup/.pp-code::before）争同一伪元素槽，同特异性
    // (0,2,1) 平手按源序——注线在后必胜，工具族单元首块的单元线被静默顶掉。
    // 单元线改实元素 .pp-unit-rule（壳层条件渲染），层叠无关、两线并存。
    const rule = ruleBody(PANEL_CSS, '.pp-unit-rule');
    expect(rule).toContain('top: -32px');
    expect(rule).toContain('width: 96px');
    expect(rule).toContain('border-top: var(--rule-soft)');
    expect(rule).toContain('left: 0');
    // 阶段线仍是全宽（两级线语法：全宽 = 阶段界，短线 = 单元界）
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-stage-lead::before')).toContain('right: 0');
  });

  it('单元线槽位独立性（2026-09-06 尸检回归）：块级 ::before 的死者选择器不得复活', () => {
    // 病灶机理：单元线若以块级 ::before 实现，必与脚注族注线同槽——
    // (0,2,1) 平手源序定生死，注线（在文件后段）恒胜 → 单元界词汇在
    // 工具族首块上整体消失（刀5 D 名存实亡，真机「隐约不对」病灶之一）。
    // 断言取规则形态（选择器 + {）——尸检注释里的死者选择器字面量不误伤。
    expect(PANEL_CSS).not.toMatch(/\.pp-block\.pp-unit-lead::before\s*\{/);
    // 脚注族注线（块身份标记）原样在册——修复不得挪动它
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-tool::before')).toContain('background: var(--indigo)');
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-toolgroup::before')).toContain('background: var(--indigo)');
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-code::before')).toContain('background: var(--indigo)');
    // 实元素接线在册（壳层条件渲染，非绝对定位装饰不挡指针）
    expect(PANEL_TSX).toContain('pp-unit-rule');
  });

  it('验证链毕锚（C）：「✓ 阶段完成」小字 ink-3 mono（最素形态）', () => {
    const rule = ruleBody(PANEL_CSS, '.pp-block.pp-verify-done::after');
    expect(rule).toContain('content: "✓ 阶段完成"');
    expect(rule).toContain('color: var(--ink-3)');
    expect(rule).toContain('var(--f-mono)');
  });

  it('接线在册：unitLeadIds / verifyDoneIds 进壳层与 RegionView', () => {
    expect(PANEL_TSX).toContain('pp-unit-rule');
    expect(PANEL_TSX).toContain('pp-verify-done');
    expect(PANEL_TSX).toContain('unitLeadIds');
    expect(PANEL_TSX).toContain('verifyDoneIds');
  });
});

describe('纸面运行态（2026-09-06——「会话在跑而纸面死寂」根治批）', () => {
  it('动效族同律：pp-ink-live 0.45↔1（带宽亮于线条呼吸——点是定位信号）', () => {
    const kf = keyframesBody(PANEL_CSS, 'pp-ink-live');
    expect(kf).toContain('opacity: 0.45');
    expect(kf).toContain('opacity: 1');
    // 1.6s 与 pp-breathe 同频（整族同拍）
    expect(ruleBody(PANEL_CSS, '.pp-quill')).toContain('animation: pp-ink-live 1.6s ease-in-out infinite');
  });

  it('落笔点：卷轴线锚下石青方点（bottom 56 = 锚+9~16，7px 方形——圆角恒 0）', () => {
    const rule = ruleBody(PANEL_CSS, '.pp-quill');
    expect(rule).toContain('bottom: 56px');
    expect(rule).toContain('left: 50%');
    expect(rule).toContain('width: 7px');
    expect(rule).toContain('height: 7px');
    expect(rule).toContain('background: var(--indigo)'); // 机=石青铁律
    expect(rule).not.toContain('border-radius'); // 方点化（D2）——无圆角声明
  });

  it('湿墨尾点：续墨行位随正文左缘（left:0 底下 20px，拖拽回流让位）', () => {
    const rule = ruleBody(PANEL_CSS, '.pp-block.pp-writing:not(.pp-drag-returning)::after');
    expect(rule).toContain('left: 0');
    expect(rule).toContain('bottom: -20px');
    expect(rule).toContain('width: 7px');
    expect(rule).toContain('height: 7px');
    expect(rule).toContain('background: var(--indigo)');
  });

  it('行走秒/在跑折叠行：石青 + 同族呼吸', () => {
    expect(ruleBody(PANEL_CSS, '.pp-status.pp-status--live')).toContain(
      'animation: pp-ink-live 1.6s ease-in-out infinite',
    );
    const busy = ruleBody(PANEL_CSS, '.pp-fold.pp-fold--busy');
    expect(busy).toContain('color: var(--indigo)');
    expect(busy).toContain('animation: pp-ink-live 1.6s ease-in-out infinite');
    // running 状态签本色仍是石青（行走秒在其上叠呼吸）
    expect(ruleBody(PANEL_CSS, '.pp-status.pp-running')).toContain('color: var(--indigo)');
  });

  it('接线在册：落笔点/湿墨类/运行集进壳层，wet 判定进 block-model', () => {
    expect(PANEL_TSX).toContain('pp-quill');
    expect(PANEL_TSX).toContain("writing ? ' pp-writing'");
    expect(PANEL_TSX).toContain('runningSessions');
    expect(PANEL_TSX).toContain('writingBlockIdOf(blocks)');
    expect(readFileSync(join(SRC, 'paper', 'block-model.ts'), 'utf8')).toContain('export function writingBlockIdOf');
  });
});

describe('B4 多模态附图渲染面（multimodal-image-plan D-9，2026-09）', () => {
  it('来文附图缩略行：几何全走 --pp-ch-userImages-* token（measure 同源），圆角恒 0', () => {
    const row = ruleBody(PANEL_CSS, '.pp-user-images');
    expect(row).toContain('flex-wrap: wrap');
    expect(row).toContain('justify-content: center'); // 来文居中版式
    expect(row).toContain('gap: var(--pp-ch-userImages-gap)');
    expect(row).toContain('margin-top: var(--pp-ch-userImages-marginTop)');
    const thumb = ruleBody(PANEL_CSS, '.pp-user-image {');
    expect(thumb).toContain('width: var(--pp-ch-userImages-thumb)');
    expect(thumb).toContain('height: var(--pp-ch-userImages-thumb)');
    expect(thumb).toContain('border: 1px solid var(--ink-4)'); // 规线细框同创作坞 rail
    expect(thumb).not.toContain('border-radius');
    expect(thumb).toContain('cursor: zoom-in');
  });

  it('点击放大浮层取全局模态档（portal 到 body 之后必须盖过纸壳）', () => {
    const lb = ruleBody(PANEL_CSS, '.pp-image-lightbox {');
    expect(lb).toContain('position: fixed');
    /* 2026-09-22 病灶修复（用户报「点开图整个创作坞被糊住且收不回」）：坞槽
     * `.pp-composer-slot` 的 transform（版心居中）是 `position: fixed` 后代的包含块
     * ⇒ 浮层改 portal 到 body。**层级随之必须换轨**：坞内小档（旧 95）挂在 body 上
     * 会被 `.pp-root`（280）盖在底下——点开一片黑，比原病更难查。 */
    expect(lb).toContain('z-index: var(--z-dialog)');
    const rootZ = /z-index:\s*(\d+)/.exec(ruleBody(PANEL_CSS, '.pp-root {'))?.[1];
    const dialogZ = /--z-dialog:\s*(\d+)/.exec(TOKENS_CSS)?.[1];
    expect(Number(dialogZ)).toBeGreaterThan(Number(rootZ));
  });

  it('md 正文图固定盒：高走 --pp-md-imgBoxH token（D-9 钉值 160），border 计入盒高', () => {
    const box = ruleBody(PANEL_CSS, '.pp-md-imgbox');
    expect(box).toContain('height: var(--pp-md-imgBoxH)');
    expect(box).toContain('margin: 0 0 var(--pp-md-imgGap)');
    expect(box).toContain('border: var(--pp-md-imgBorder) solid var(--rule-soft-ink)');
    expect(box).toContain('overflow: hidden');
    // 点击放大入口（2026-10）：按钮吃满盒（100%×100%）+ 光标手势 + 无装饰重置
    const zoom = ruleBody(PANEL_CSS, '.pp-md-img-zoom');
    expect(zoom).toContain('width: 100%');
    expect(zoom).toContain('height: 100%');
    expect(zoom).toContain('cursor: zoom-in');
    expect(zoom).toContain('border: none');
    expect(TYPE_TOKENS_TS).toContain('imgBoxH: 160'); // D-9 裁定钉值
    expect(TYPE_TOKENS_TS).toContain('imgGap: 12');
    expect(TYPE_TOKENS_TS).toContain('userImages: { thumb: 64, gap: 8, marginTop: 10 }');
  });

  it('图源分类在解析层（imageSrcRef 单一真源：远端白名单 + 本地图）+ 非白名单不产图盒', () => {
    const md = readFileSync(join(SRC, 'paper', 'markdown.ts'), 'utf8');
    expect(md).toContain('export function imageSrcRef');
    expect(md).toContain("protocol === 'http:' || protocol === 'https:'");
    // 本地图判据：绝对路径形态 + 图片扩展名白名单（VIEWER_IMAGE_EXTS 单一表）
    expect(md).toContain('VIEWER_IMAGE_EXTS');
    expect(md).toContain('fileUrlToLocalPath');
    // 降级路径：alt 文本段落 / alt 空整行不产块（data: 巨串不灌纸面）
    expect(md).toContain("blocks.push({ t: 'p', inl: parseInline(img[1]) })");
    // 渲染端图盒只出分类幸存者；本地图字节经 fs_cap 用户口渲染期回读（块只携路径）；
    // 点击看大图入口（2026-10）：zoom 按钮 + 用户气泡/资产卡同款全局浮层
    expect(RENDERER_TS).toContain('pp-md-imgbox');
    expect(RENDERER_TS).toContain('referrerPolicy="no-referrer"');
    expect(RENDERER_TS).toContain("typedRpc('fs_cap'");
    expect(RENDERER_TS).toContain('pp-md-img-zoom');
    expect(RENDERER_TS).toContain('pp-media-preview-overlay');
  });

  it('INVARIANTS #14 渲染面：块只携引用，data URI 只在渲染期出现', () => {
    // translate 旁挂引用（不是字节/base64）；UserBody 经 readAttachmentBase64 渲染期回读
    expect(TRANSLATE_TS).toContain('msg.images?.length ? msg.images : undefined');
    expect(RENDERER_TS).toContain('readAttachmentBase64');
    expect(RENDERER_TS).toContain('previewUrlFor');
  });
});

/* ── 图版架（2026-09-23 拍板丙 · 匣下横架；设计真源 = 规格书 §9.5）──────────────
 * 架面语汇＝**禁「工具栏化」**：单元 = 物类签（mono 9px 石青 + 发丝框）+ 题名
 * （中墨）+ 更新点（石青 5px 圆 = 机），**签条不套方框**（一排灰边框按钮是工具栏
 * 的语言，不是「架上签条」的语言）；hover = 题名转重墨 + 一条朱砂底规线（坞内既有
 * hover 语言，同 `.pp-tool-btn`）。板面 = 深纸混色 + 上发丝线 + 受光缘内侧高光。
 * 扫描纪律同 tests/asset-ink-tiers（墨阶三级各就各位 + 不出现裸色值）。 */
describe('图版架段面（丙案 §9.5）· 墨阶与「不套方框」钉值', () => {
  /** `.pp-rack` 段的规则（选择器含 `.pp-rack`；剥注释后按 `}` 切块——同 asset-ink-tiers 手法）。 */
  function rackRules(): Array<{ selector: string; body: string }> {
    const stripped = PANEL_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const out: Array<{ selector: string; body: string }> = [];
    for (const chunk of stripped.split('}')) {
      const at = chunk.lastIndexOf('{');
      if (at < 0) continue;
      const selector = chunk.slice(0, at).trim();
      const body = chunk.slice(at + 1);
      if (!body.trim()) continue;
      if (selector.includes('.pp-rack')) out.push({ selector, body });
    }
    return out;
  }
  const bodyOf = (sel: string): string => {
    const hit = rackRules().find((r) => r.selector === sel);
    if (!hit) throw new Error(`规则不存在：${sel}`);
    return hit.body;
  };

  it('扫面非空（防选择器改名把守卫变成永真）', () => {
    expect(rackRules().length).toBeGreaterThanOrEqual(5);
  });

  it('.pp-rack 段不出现裸色值（墨/纸/线全走 token）', () => {
    const offenders: string[] = [];
    for (const r of rackRules()) {
      const decls = r.body
        .split(';')
        .map((d) => d.trim())
        .filter((d) => /^(color|background|border|box-shadow|fill|stroke|outline)/.test(d));
      for (const d of decls) {
        if (/#[0-9a-fA-F]{3,8}\b/.test(d) || /\b(rgba?|hsla?|oklch)\(/.test(d.replace(/color-mix\(in oklch,/g, ''))) {
          offenders.push(`${r.selector} { ${d} }`);
        }
      }
    }
    expect(offenders, `图版架段出现裸色值（应走 token）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('签条**不套方框**（反向钉值）：无边框无圆角无底色，hover 才出一条朱砂底规线', () => {
    const chip = bodyOf('.pp-rack-chip');
    expect(chip).toContain('border: none');
    expect(chip).toContain('border-radius: 0');
    expect(chip).toContain('background: none');
    // 底规线恒在（透明）——hover 才转朱砂，位移零变化（不跳）
    expect(chip).toContain('border-bottom: 1px solid transparent');
    const hover = bodyOf('.pp-rack-chip:hover');
    expect(hover).toContain('color: var(--ink-1)'); // 题名转重墨
    expect(hover).toContain('border-bottom-color: var(--seal)'); // 一条朱砂底规线
  });

  it('墨阶三级各就各位：物类签=石青 / 题名=中墨 / 更新点=石青 / 溢出读数=淡墨', () => {
    expect(bodyOf('.pp-rack-chip')).toContain('color: var(--ink-2)'); // 题名中墨
    expect(bodyOf('.pp-rack-sign')).toContain('color: var(--indigo)'); // 签 = 石青（机器语汇）
    expect(bodyOf('.pp-rack-sign')).toContain('color-mix(in oklch, var(--indigo) 45%, transparent)'); // 发丝框
    expect(bodyOf('.pp-rack-upd')).toContain('background: var(--indigo)'); // 更新点 = 机
    expect(bodyOf('.pp-rack-more')).toContain('color: var(--ink-3)'); // 溢出读数淡墨
  });

  it('板面 = 深纸混色 + 上发丝线 + 受光缘内侧高光（家具语言，不引新色）', () => {
    const rack = bodyOf('.pp-rack');
    expect(rack).toContain('color-mix(in oklch, var(--paper-deep) 58%, var(--paper))');
    expect(rack).toContain('border-top: 1px solid var(--rule-soft-ink)');
    expect(rack).toContain('box-shadow: inset 0 -1px 0 var(--sheet-lit)');
    // 一条板：横向不滚（架是家具，不是滚动条）
    expect(rack).toContain('overflow: hidden');
  });
});

/* ── 查看器公共壳（渲染面补全 B1，2026-09-23）─────────────────────────────────
 * 壳 = 题签行（.pp-plate 恒在）+ 题名行 + 内容区 + 降级行；查看器只管内容。
 * 扫描纪律同 tests/asset-ink-tiers（不出现裸色值）+ 壳件数值全走 token
 * （--pp-asset-viewer-*，真源 type-tokens.ASSET_TOKENS.viewer）。 */
describe('查看器公共壳段面（B1）· 不裸色 + 壳件走 token', () => {
  /** `.pp-viewer` 段的规则（选择器含 `.pp-viewer`；剥注释后按 `}` 切块——同上图版架手法）。 */
  function viewerRules(): Array<{ selector: string; body: string }> {
    const stripped = PANEL_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const out: Array<{ selector: string; body: string }> = [];
    for (const chunk of stripped.split('}')) {
      const at = chunk.lastIndexOf('{');
      if (at < 0) continue;
      const selector = chunk.slice(0, at).trim();
      const body = chunk.slice(at + 1);
      if (!body.trim()) continue;
      if (selector.includes('.pp-viewer')) out.push({ selector, body });
    }
    return out;
  }
  const bodyOf = (sel: string): string => {
    const hit = viewerRules().find((r) => r.selector === sel);
    if (!hit) throw new Error(`规则不存在：${sel}`);
    return hit.body;
  };

  it('扫面非空（防选择器改名把守卫变成永真）', () => {
    expect(viewerRules().length).toBeGreaterThanOrEqual(5);
  });

  it('.pp-viewer 段不出现裸色值（墨/纸/线全走 token）', () => {
    const offenders: string[] = [];
    for (const r of viewerRules()) {
      const decls = r.body
        .split(';')
        .map((d) => d.trim())
        .filter((d) => /^(color|background|border|box-shadow|fill|stroke|outline)/.test(d));
      for (const d of decls) {
        if (/#[0-9a-fA-F]{3,8}\b/.test(d) || /\b(rgba?|hsla?|oklch)\(/.test(d.replace(/color-mix\(in oklch,/g, ''))) {
          offenders.push(`${r.selector} { ${d} }`);
        }
      }
    }
    expect(offenders, `查看器壳段出现裸色值（应走 token）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('壳件走 viewer token：壳内距 / 题名行字号 / 降级行墨 / 音频固定盒高', () => {
    expect(bodyOf('.pp-viewer')).toContain('padding: var(--pp-asset-viewer-padV) 0');
    expect(bodyOf('.pp-viewer-label')).toContain('font-size: var(--pp-asset-viewer-labelSize)');
    expect(bodyOf('.pp-viewer-error')).toContain('color: var(--fail)'); // 失败 = 朱砂（错误不静默）
    expect(bodyOf('.pp-viewer-audio-el')).toContain('height: var(--pp-asset-viewer-audioBoxH)');
    expect(bodyOf('.pp-viewer-audio-meta')).toContain('color: var(--ink-3)'); // 读数 = 淡墨
  });

  it('B2 代码查看器：盒高走上限 token + 行号列淡墨 + 截断横幅朱砂（不裸色，同上一查）', () => {
    expect(bodyOf('.pp-viewer-code')).toContain('max-height: var(--pp-asset-viewer-codeBoxH)');
    expect(bodyOf('.pp-viewer-code')).toContain('overflow: auto'); // 超长内部滚动（不改纸面高度）
    expect(bodyOf('.pp-viewer-code-gutter')).toContain('color: var(--ink-3)');
    expect(bodyOf('.pp-viewer-code-note')).toContain('color: var(--seal-deep)'); // 截断 = 朱砂深（可见）
    expect(bodyOf('.pp-viewer-code-note')).toContain('position: sticky'); // 吸顶：盒高不随截断漂
  });

  it('hljs 墨阶映射三消费面**同源**（流内围栏码 ↔ 抄录块代码体 ↔ 代码查看器同一份配色）', () => {
    const groups = PANEL_CSS.replace(/\/\*[\s\S]*?\*\//g, '').match(/\.pp-md-code \.hljs-[^{]+/g) ?? [];
    expect(groups.length).toBeGreaterThanOrEqual(9); // 9 组语义类（防改名把守卫变成永真）
    for (const g of groups) {
      const md = (g.match(/\.pp-md-code \.hljs-/g) ?? []).length;
      const vw = (g.match(/\.pp-viewer-code \.hljs-/g) ?? []).length;
      const dc = (g.match(/\.pp-diff-code \.hljs-/g) ?? []).length;
      expect(vw, `高亮选择器组缺 .pp-viewer-code 一侧（补上）：${g.trim()}`).toBe(md);
      expect(dc, `高亮选择器组缺 .pp-diff-code 一侧（抄录块代码体，补上）：${g.trim()}`).toBe(md);
    }
  });
});

/* ═══ 机读位等宽（2026-09-24 等宽位复原批，用户拍板 B）═══
 * 两件事同批：① 机读位换真等宽字体（中文也等宽）；② 修 `<pre><code>` 的
 * UA 直接规则压继承（机器文本此前压根没走 var(--f-mono)）。 */
describe('机读位字体与 pre>code 交还（2026-09-24）', () => {
  /** tokens.css 的 --f-mono 值（去注释：注释在分号之后）。 */
  const tokenMono = (() => {
    const m = /--f-mono:\s*([^;]+);/.exec(TOKENS_CSS);
    return m ? m[1].trim() : '';
  })();

  it('--f-mono 是具名等宽栈（中文也等宽），且不再是 MiSans 单栈', () => {
    expect(tokenMono).toContain('"Noto Sans Mono CJK SC"');
    expect(tokenMono).toContain('monospace');
    expect(tokenMono).not.toBe('"MiSans", "PingFang SC", "Microsoft YaHei", sans-serif');
  });

  it('tokens.css --f-mono 与 type-tokens FONT_STACKS.mono **逐字同值**（测高与渲染两把尺子必须是一把）', () => {
    const m = /mono:\s*'([^']+)'/.exec(TYPE_TOKENS_TS);
    expect(m, 'type-tokens FONT_STACKS.mono 未找到').not.toBeNull();
    expect(tokenMono).toBe(m?.[1]);
  });

  it('等宽字体随包自托管：@font-face + 字体文件 + OFL 副本齐备（缺件即裸奔到系统字体）', () => {
    expect(FONTS_CSS).toContain('font-family: "Noto Sans Mono CJK SC"');
    expect(FONTS_CSS).toContain('NotoSansMonoCJKsc-Regular.otf');
    const dir = join(SRC, 'assets', 'fonts');
    expect(existsSync(join(dir, 'NotoSansMonoCJKsc-Regular.otf')), '等宽字体文件缺失').toBe(true);
    expect(existsSync(join(dir, 'LICENSE-NotoSansMonoCJK.txt')), 'OFL 授权副本缺失').toBe(true);
  });

  it('pre 里的 code 把字体交还父层（UA 对 code 有直接 font-family:monospace——直接规则压继承）', () => {
    expect(ruleBody(FOUNDATION_CSS, 'pre code {')).toContain('font: inherit');
    // 三个消费面都靠父层声明 var(--f-mono)（父层没声明 → code 落 UA 等宽 = 老 bug）
    expect(ruleBody(PANEL_CSS, '.pp-md-code {')).toContain('font-family: var(--f-mono)');
    expect(ruleBody(PANEL_CSS, '.pp-block.pp-diff pre {')).toContain('font-family: var(--f-mono)');
    expect(ruleBody(PANEL_CSS, '.pp-viewer-code-pre code {')).toContain('font: inherit');
  });
});
