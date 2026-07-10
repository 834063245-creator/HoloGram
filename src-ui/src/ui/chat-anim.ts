// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Panel — GSAP animations and panel mode morphing
// Extracted from chat.ts ChatPanel class.
// All functions receive AnimContext instead of accessing `this`.

import gsap from 'gsap';
import { iconHtml } from './icons';
import { shell } from './app-shell';
import { cancelPendingApprovals } from '../agent/permission';

// ── AnimContext — the bridge between standalone animation functions and ChatPanel state ──

export interface AnimContext {
  // DOM elements
  panel: HTMLElement;
  msgList: HTMLElement;
  inputArea: HTMLTextAreaElement;

  // Mutable mode state
  getMode: () => 'pill' | 'input' | 'panel' | 'hud';
  setMode: (m: 'pill' | 'input' | 'panel' | 'hud') => void;

  // Read-only ChatPanel state
  getRunning: () => boolean;
  getProjectPath: () => string;
  getActiveIdx: () => number;

  // Callbacks to ChatPanel methods
  updateFooter: () => void;
  scrollBottom: () => void;
  resetPillBadge: () => void;
  closeHistory: () => void;
  hideSlashPanel: () => void;
  saveActiveSession: (projectPath: string) => Promise<void>;
}

// ── Constants ──

/** Content elements that participate in morph animations */
const CONTENT_SEL =
  '.chat-header, .chat-messages, .chat-input-area, .chat-footer, .chat-expand-handle, .corner-brackets, .chat-resize, .chat-status-bar, .chat-panel-tabs, .chat-tab-content, .chat-progress';

// ── Content element helpers ──

export function contentEls(ctx: AnimContext): HTMLElement[] {
  return gsap.utils.toArray(CONTENT_SEL, ctx.panel);
}

export function killPanelTweens(ctx: AnimContext): void {
  gsap.killTweensOf(ctx.panel);
  gsap.killTweensOf(contentEls(ctx));
}

/** Strip all modal classes from the panel */
export function removeAllPanelClasses(ctx: AnimContext): void {
  ctx.panel.classList.remove('chat-pill', 'chat-input-mode', 'chat-open', 'chat-hud');
}

/** Animation guard — check if GSAP is actively tweening panel or content */
export function getAnimating(ctx: AnimContext): boolean {
  return gsap.isTweening(ctx.panel) || gsap.isTweening(contentEls(ctx));
}

/**
 * Snapshot CSS-computed opacities BEFORE GSAP touches inline styles.
 * `gsap.fromTo` applies `fromVars` (opacity:0) immediately, then evaluates
 * function-based `toVars` — at that point getComputedStyle returns 0, not the
 * CSS value. We save targets upfront to avoid the self-shadowing.
 */
export function snapshotContentOpacities(ctx: AnimContext): number[] {
  return contentEls(ctx).map(el => parseFloat(getComputedStyle(el).opacity));
}

/** Fade content in from 0 → current CSS opacities. For elements that were display:none. */
export function fadeContentIn(ctx: AnimContext, delay = 0.12, duration = 0.2): void {
  const c = contentEls(ctx);
  const targets = snapshotContentOpacities(ctx);
  gsap.fromTo(c,
    { opacity: 0 },
    { opacity: (i) => targets[i], duration, ease: 'power2.out', delay },
  );
}

/**
 * Cross-fade content between two visible modes (panel ↔ hud).
 * Snapshot current inline opacities BEFORE class change, apply new mode's CSS,
 * then tween from old → new CSS values. No flash to 0.
 */
export function crossfadeContent(ctx: AnimContext, fromOpacities: number[], duration = 0.2, ease = 'power2.out'): void {
  const c = contentEls(ctx);
  const targets = snapshotContentOpacities(ctx); // new mode's CSS opacities
  gsap.fromTo(c,
    { opacity: (i) => fromOpacities[i] },
    { opacity: (i) => targets[i], duration, ease },
  );
}

// ── Per-bubble entrance animation ──

export function animateBubbleIn(el: HTMLElement, delay = 0): gsap.core.Tween {
  return gsap.fromTo(el,
    { y: 12, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.28, ease: 'power2.out', delay, clearProps: 'transform,opacity' },
  );
}

// ── Tool card expand/collapse (GSAP height) ──

export function toggleToolCard(card: HTMLElement): void {
  const result = card.querySelector('.msg-tool-result') as HTMLElement;
  if (!result) return;
  gsap.killTweensOf(result);
  const isOpen = card.classList.contains('tool-expanded');

  if (isOpen) {
    // Collapse → animate to 0, then remove class
    gsap.to(result, {
      height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0,
      duration: 0.2, ease: 'power2.in',
      onComplete: () => {
        card.classList.remove('tool-expanded');
        gsap.set(result, { clearProps: 'all' });
      },
    });
  } else {
    // Expand → add class (triggers display:block), measure, animate from 0
    card.classList.add('tool-expanded');
    const h = result.scrollHeight;
    gsap.fromTo(result,
      { height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0 },
      { height: h, opacity: 1, paddingTop: '', paddingBottom: '', duration: 0.25, ease: 'power2.out',
        onComplete: () => gsap.set(result, { clearProps: 'height,opacity,paddingTop,paddingBottom' }) },
    );
  }
}

// ── Reasoning block toggle (GSAP height) ──

export function toggleReasoning(toggleBtn: HTMLElement, content: HTMLElement): void {
  gsap.killTweensOf(content);
  const isOpen = content.classList.contains('msg-reasoning-open');

  if (isOpen) {
    // Collapse
    gsap.to(content, {
      height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0, marginTop: 0,
      duration: 0.2, ease: 'power2.in',
      onComplete: () => {
        content.classList.remove('msg-reasoning-open');
        gsap.set(content, { clearProps: 'all' });
        toggleBtn.innerHTML = `${iconHtml('chevron-right')} 思考过程`;
      },
    });
  } else {
    // Expand
    content.classList.add('msg-reasoning-open');
    content.style.display = 'block';
    const h = content.scrollHeight;
    content.style.display = '';
    gsap.fromTo(content,
      { height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0, marginTop: 0 },
      { height: h, opacity: 1, paddingTop: '', paddingBottom: '', marginTop: '', duration: 0.28, ease: 'power2.out',
        onComplete: () => {
          gsap.set(content, { clearProps: 'height,opacity,paddingTop,paddingBottom,marginTop' });
        },
      },
    );
    toggleBtn.innerHTML = `${iconHtml('chevron-down')} 收起思考`;
  }
}

// ── Mode morphing ──

/** Expand: pill → input/panel (full morph) or input → panel (height only) */
export function morphToMode(ctx: AnimContext, mode: 'input' | 'panel', cls: string): void {
  if (getAnimating(ctx)) return;
  const prevMode = ctx.getMode();  // capture before overwriting
  ctx.setMode(mode);
  killPanelTweens(ctx);

  const fromH = ctx.panel.offsetHeight;

  removeAllPanelClasses(ctx);
  ctx.panel.classList.add(cls);
  ctx.panel.style.maxHeight = ''; ctx.panel.style.minHeight = '';
  ctx.updateFooter();

  if (prevMode === 'pill') {
    // ── Pill → Input/Panel: full radial expand ──
    ctx.panel.style.width = '560px';
    ctx.panel.style.borderRadius = '0';
    ctx.panel.style.height = 'auto';
    const toH = ctx.panel.offsetHeight;
    // Reset to pill dimensions for animation start (sync — no paint between set+read)
    ctx.panel.style.width = '48px';
    ctx.panel.style.height = fromH + 'px';
    ctx.panel.style.borderRadius = '50%';

    gsap.to(ctx.panel, {
      width: 560, height: toH, borderRadius: 0,
      duration: 0.38, ease: 'power2.out',
      onComplete: () => { ctx.panel.style.height = ''; },
    });
    fadeContentIn(ctx, 0.2, 0.22);

    // Handle — elastic stretch-in
    const hi = ctx.panel.querySelector('.chat-expand-handle-inner') as HTMLElement;
    gsap.fromTo(hi,
      { scaleX: 0, transformOrigin: 'center center' },
      { scaleX: 1, duration: 0.5, delay: 0.24, ease: 'elastic.out(1, 0.4)' },
    );
  } else {
    // ── Input → Panel: already at 560px, animate height only ──
    ctx.panel.style.width = '560px';
    ctx.panel.style.borderRadius = '0';
    ctx.panel.style.height = fromH + 'px';
    // Measure natural target height
    ctx.panel.style.height = 'auto';
    const toH = ctx.panel.offsetHeight;
    ctx.panel.style.height = fromH + 'px';

    gsap.to(ctx.panel, {
      height: toH, duration: 0.3, ease: 'power2.out',
      onComplete: () => { ctx.panel.style.height = ''; },
    });
    fadeContentIn(ctx, 0.1, 0.18);

    // Handle — quick pulse (already visible)
    const hi = ctx.panel.querySelector('.chat-expand-handle-inner') as HTMLElement;
    gsap.to(hi, {
      scaleX: 1.15, duration: 0.1, ease: 'power2.out', transformOrigin: 'center center',
      onComplete: () => gsap.to(hi, { scaleX: 1, duration: 0.25, ease: 'elastic.out(1, 0.5)' }),
    });
  }

  setTimeout(() => ctx.inputArea.focus(), 380);
  shell.notifyPanelChanged();
}

/** Pill → Input: 44px circle morphs into floating input bar */
export function expandToInput(ctx: AnimContext): void {
  morphToMode(ctx, 'input', 'chat-input-mode');
}

/** Any state → Panel: summon the full conversation card */
export function summonPanel(ctx: AnimContext): void {
  // If agent is running in background, restore to full panel
  if (ctx.getRunning()) ctx.panel.classList.remove('chat-pill-running');
  ctx.resetPillBadge();
  morphToMode(ctx, 'panel', 'chat-open');
  ctx.scrollBottom();
}

/** Panel/HUD → Input: collapse card to floating input bar */
export function collapseToInput(ctx: AnimContext): void {
  if (getAnimating(ctx)) return;
  killPanelTweens(ctx);
  const c = contentEls(ctx);
  const targets = snapshotContentOpacities(ctx);
  const fromH = ctx.panel.offsetHeight;

  // Restore panel from any HUD transform
  gsap.to(ctx.panel, { scale: 1, y: 0, opacity: 1, duration: 0.1, ease: 'power2.out' });

  // Content out → class switch → height down + content in (all overlapped)
  gsap.to(c, {
    opacity: 0, duration: 0.1, ease: 'power2.in',
    onComplete: () => {
      ctx.setMode('input');
      removeAllPanelClasses(ctx);
      ctx.panel.classList.add('chat-input-mode');
      ctx.panel.style.maxHeight = ''; ctx.panel.style.minHeight = '';
      gsap.set(ctx.panel, { clearProps: 'scale,y,opacity' });

      // Measure target input-bar height then lock back to panel height
      ctx.panel.style.width = '560px';
      ctx.panel.style.borderRadius = '0';
      ctx.panel.style.height = 'auto';
      const toH = ctx.panel.offsetHeight;
      ctx.panel.style.height = fromH + 'px';

      // Height + content animate together, snappy ease
      gsap.to(ctx.panel, {
        height: toH, duration: 0.24, ease: 'power3.out',
        onComplete: () => { ctx.panel.style.height = ''; },
      });
      gsap.fromTo(c,
        { opacity: 0 },
        { opacity: (i) => targets[i], duration: 0.16, ease: 'power2.out' },
      );

      const hi = ctx.panel.querySelector('.chat-expand-handle-inner') as HTMLElement;
      gsap.fromTo(hi,
        { scaleX: 0, transformOrigin: 'center center' },
        { scaleX: 1, duration: 0.35, delay: 0.08, ease: 'elastic.out(1, 0.5)' },
      );
    },
  });

  if (ctx.getRunning()) ctx.panel.classList.add('chat-pill-running');
  if (ctx.getProjectPath() && ctx.getActiveIdx() >= 0) {
    ctx.saveActiveSession(ctx.getProjectPath()).catch(() => {});
  }
  // ponytail: don't cancel pending permissions while agent is running —
  // sub-agents may be mid-write and the dialog is their only path through.
  if (!ctx.getRunning()) cancelPendingApprovals();
  ctx.closeHistory();
  ctx.hideSlashPanel();
  shell.notifyPanelChanged();
}

/** Input → Pill: collapse to 48px star circle */
export function collapseToPill(ctx: AnimContext): void {
  if (getAnimating(ctx)) return;
  killPanelTweens(ctx);
  const c = contentEls(ctx);

  // Handle snaps shut instantly
  const hi = ctx.panel.querySelector('.chat-expand-handle-inner') as HTMLElement;
  gsap.to(hi, { scaleX: 0, duration: 0.05, ease: 'power2.in', transformOrigin: 'center center' });

  // Restore panel to full presence
  gsap.to(ctx.panel, { scale: 1, y: 0, opacity: 1, duration: 0.1, ease: 'power2.in' });

  // Content fades AND panel shrinks simultaneously — no stagger, no dead zone
  gsap.to(c, { opacity: 0, duration: 0.18, ease: 'power2.in' });

  gsap.to(ctx.panel, {
    width: 48, height: 48, borderRadius: '50%',
    duration: 0.3, ease: 'power3.in',
    onComplete: () => {
      ctx.setMode('pill');
      removeAllPanelClasses(ctx);
      ctx.panel.classList.add('chat-pill');
      if (ctx.getRunning()) {
        ctx.panel.classList.add('chat-pill-running');
      }
      ctx.panel.style.maxHeight = '';
      ctx.panel.style.minHeight = '';
      ctx.panel.style.height = '';
      gsap.set(c, { clearProps: 'opacity' });
      gsap.set(ctx.panel, { clearProps: 'scale,y,opacity' });
    },
  });

  if (ctx.getProjectPath() && ctx.getActiveIdx() >= 0) {
    ctx.saveActiveSession(ctx.getProjectPath()).catch(() => {});
  }
  if (!ctx.getRunning()) cancelPendingApprovals();
  ctx.closeHistory();
  ctx.hideSlashPanel();
  shell.notifyPanelChanged();
}

/** Panel → HUD: ghost the card — panel retreats into star field, messages dissolve bottom→top */
export function fadeToHud(ctx: AnimContext): void {
  if (ctx.getMode() !== 'panel' || getAnimating(ctx)) return;
  killPanelTweens(ctx);
  // Snapshot current content opacities BEFORE changing classes
  const fromOpacities = snapshotContentOpacities(ctx);
  ctx.setMode('hud');
  removeAllPanelClasses(ctx);
  ctx.panel.classList.add('chat-hud');
  ctx.panel.style.maxHeight = ''; ctx.panel.style.minHeight = '';

  // Panel retreat: scale down, push back, go translucent
  gsap.to(ctx.panel, {
    scale: 0.96, y: 14, opacity: 0.62,
    duration: 0.45, ease: 'power2.out',
  });
  // Content elements fade to HUD opacities
  crossfadeContent(ctx, fromOpacities, 0.4);
}

/** HUD → Panel: restore the full card — reverse retreat animation */
export function restoreFromHud(ctx: AnimContext): void {
  if (ctx.getMode() !== 'hud' || getAnimating(ctx)) return;
  killPanelTweens(ctx);
  const fromOpacities = snapshotContentOpacities(ctx);
  ctx.setMode('panel');
  removeAllPanelClasses(ctx);
  ctx.panel.classList.add('chat-open');
  ctx.panel.style.maxHeight = ''; ctx.panel.style.minHeight = '';

  // Reverse the retreat
  gsap.to(ctx.panel, {
    scale: 1, y: 0, opacity: 1,
    duration: 0.35, ease: 'power2.out',
    onComplete: () => {
      // Clear GSAP inline transform so CSS translateX(-50%) takes over cleanly
      gsap.set(ctx.panel, { clearProps: 'scale,y,opacity' });
    },
  });
  crossfadeContent(ctx, fromOpacities, 0.3);
  setTimeout(() => ctx.inputArea.focus(), 150);
}
