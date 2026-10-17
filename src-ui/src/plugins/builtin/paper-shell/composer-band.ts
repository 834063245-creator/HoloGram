// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composer-band — 创作坞**让位带的 CSS 下发面**（2026-10-18 性能批）。
//
// ## 病灶（用户报：「移」解锁后自由拖动非常卡，明显一顿一顿）
//
// 旧实现把让位带写成 `document.documentElement.style.setProperty('--composer-band', …)`
// ——拖动期**每帧一次**。未注册自定义属性写在 `:root` 上 = Blink 对**整棵文档树**
// 重算计算样式。CDP 实机取证（2560×1400 / 599 元素 / 2542 规则，与用户同机同窗）：
//
//   | 每帧写什么                          | 帧均   | RecalcStyleDuration |
//   |------------------------------------|-------|---------------------|
//   | 空帧循环（基线）                      |  9.9ms | 0                   |
//   | `:root` 内联 `--composer-band`（旧法） | 61.0ms | **59.3ms**          |
//   | `:root` 内联一个**无用**变量（同机制）  | 59.9ms | 58.9ms              |
//   | 坞自身 left/bottom 内联（现仍需）      | 10.0ms | 0.18ms              |
//
// 真机拖动实测：28 次 **64~70ms 长任务**（= 每一次让位带变化），p99 67ms ⇒ 纵向拖动
// 时段落式掉到 ~16fps。**与消费面多寡无关**（把值写在没有任何消费者的变量上一样贵）、
// 与是否把变量注册成属性无关（CSS.registerProperty 实测同样无效——`inherits` 亦然）。
//
// ## 治法：把值写在**只命中让位消费面**的一条规则上
//
// Blink 对「规则声明块变更」按**选择器**做定向失效 ⇒ 只有命中元素（+其子树）重算：
//
//   | 每帧写什么                                    | 帧均   | RecalcStyleDuration |
//   |----------------------------------------------|-------|---------------------|
//   | 规则式（本条）· 无消费者                       |  9.9ms | 0.97ms              |
//   | 规则式（本条）· 名单含一个真实消费者             |  9.9ms | 0.96ms              |
//   | 单元素内联                                     |  9.9ms | 0.30ms              |
//
// 选规则式而非「逐个元素写内联」：**后挂载的消费面自动命中**（递牒卡/插件 dock 都是
// 出没件，拖动中途随时可能出现——内联写法要额外挂 MutationObserver 才能补齐）。
// 值本身仍是同一个 `--composer-band`、同一套消费面 CSS（`var(--composer-band, 兜底算式)`），
// **只换载体，不换口径**：未下发时消费面照旧回落到静态算式。
//
// ## 纪律
//
//   - `COMPOSER_BAND_CONSUMERS` 是**让位消费面名册**（跨包选择器：外壳 `shell.css` 的
//     `.psh-host`、插件窗口 `plugin-windows.css` 的 `.pw-dock`）。**新增一个读
//     `var(--composer-band)` 的消费面，必须在此登记**——漏登记 = 该面读到静态兜底、
//     坞浮上去会压住它，且**不会报错**。守护测试 `tests/composer-float.test.ts`
//     的「名册 vs CSS 实读对拍」按 CSS 源码逐条对拍，漏登记即红。
//   - 规则元素由本模块自建自有（id = `BAND_STYLE_ID`），`dispose()` 摘除——摘除即回兜底。
//   - **不许退回 `:root` 内联**（哪怕只有一帧）：那是本文件全部实测数据的由来。

/** 让位带变量名（消费面 CSS 与测试三处同名）。 */
export const COMPOSER_BAND_VAR = '--composer-band';

/** **让位消费面名册**（读 `var(--composer-band)` 的元素选择器；新增消费面必须在此登记）。 */
export const COMPOSER_BAND_CONSUMERS = '.psh-host, .pw-dock';

/** 载体的元素 id（单一实例：重载/多实例时按 id 复用，不叠规则）。 */
export const BAND_STYLE_ID = 'lantai-composer-band';

/** 让位带下发面（use-composer-float 独占使用）。 */
export interface ComposerBandSink {
  /** 下发让位带（px；幂等，值不变时 Blink 不重算）。 */
  publish(band: number): void;
  /** 摘除载体（消费面回落到各自 CSS 里的静态兜底算式）。 */
  dispose(): void;
}

/**
 * 建一个让位带下发面（DOM 载体延迟到首次 publish 才建——未落笔的坞不产生死样式表）。
 * `doc` 只供测试注入；产品面一律用当前 document。
 */
export function createComposerBandSink(doc: Document = document): ComposerBandSink {
  let el: HTMLStyleElement | null = null;
  let rule: CSSStyleRule | null = null;
  let owns = false;
  let disposed = false;

  /** 载体与规则就位（返回可写的声明块；建不出来 = 无载体，静默退化到兜底算式）。
   *  **断连即重建**：多实例/产物热重载时，先前复用的载体可能被它的主人摘除——
   *  写在已脱离文档的样式表上等于什么都没发生（静默失聪），故每次先验 `isConnected`。 */
  const ensure = (): CSSStyleDeclaration | null => {
    if (rule && el?.isConnected) return rule.style;
    rule = null;
    el = null;
    owns = false;
    const existing = doc.getElementById(BAND_STYLE_ID) as HTMLStyleElement | null;
    if (existing) {
      el = existing;
    } else {
      const created = doc.createElement('style');
      created.id = BAND_STYLE_ID;
      created.textContent = `${COMPOSER_BAND_CONSUMERS} { }`;
      doc.head.appendChild(created);
      el = created;
      owns = true;
    }
    /* 空规则体在 CSSOM 里仍是一条规则；取不到（极端退化）= 无载体，不炸。 */
    const sheet = el.sheet;
    rule = sheet ? ((sheet.cssRules.item(0) as CSSStyleRule | null) ?? null) : null;
    return rule?.style ?? null;
  };

  return {
    publish(band: number): void {
      if (disposed) return;
      /* 写规则声明块（**不是** el.textContent——整表替换会让 Blink 无从定向失效）。 */
      ensure()?.setProperty(COMPOSER_BAND_VAR, `${Math.round(band)}px`);
    },
    dispose(): void {
      disposed = true;
      rule = null;
      if (owns) el?.parentNode?.removeChild(el);
      el = null;
      owns = false;
    },
  };
}
