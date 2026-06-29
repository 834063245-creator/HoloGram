// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Permission UI — Security Clearance Hologram modal
// Rule matching + decision logic lives in Rust: has_permission_to_use_tool()
// This module handles the floating holographic dialog rendering and user interaction.
// The Rust backend emits permission-ask events → main.ts bridges to showApprovalDialog.

import { bus } from '../ui/events';

/** Pending approval request resolvers, keyed by unique request ID. */
const pending = new Map<string, {
  resolve: (result: { allow: boolean; remember: boolean }) => void;
  cleanup: () => void;
}>();
let nextId = 1;

// ── Helpers ──

const subjectKeys = ['command', 'filePath', 'path', 'pattern', 'file_path', 'directory'];

function extractSubject(args: Record<string, unknown>): string {
  for (const k of subjectKeys) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

function escapeText(s: string): string {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

// ── Interactive approval — holographic modal ──

export function showApprovalDialog(
  toolName: string,
  description: string,
  args: Record<string, unknown>,
): Promise<{ allow: boolean; remember: boolean }> {
  return new Promise((resolve) => {
    const id = `perm-${nextId++}`;

    // ── Overlay ──
    const overlay = document.createElement('div');
    overlay.className = 'perm-overlay';

    // ── Dialog shell ──
    const dialog = document.createElement('div');
    dialog.className = 'perm-dialog';

    // Corner accents — four L-shaped marks at panel corners
    for (const pos of ['tl', 'tr', 'bl', 'br']) {
      const corner = document.createElement('div');
      corner.className = `perm-corner perm-corner-${pos}`;
      dialog.appendChild(corner);
    }

    // ── Header — pulsing indicator + HUD label ──
    const header = document.createElement('div');
    header.className = 'perm-header';

    const indicator = document.createElement('div');
    indicator.className = 'perm-indicator';

    const hudLabel = document.createElement('div');
    hudLabel.className = 'perm-hud-label';
    hudLabel.textContent = '授权请求'; // 授权请求

    header.appendChild(indicator);
    header.appendChild(hudLabel);

    // ── Tool name — monospace command identifier ──
    const nameEl = document.createElement('div');
    nameEl.className = 'perm-tool-name';
    nameEl.textContent = toolName;

    // ── Description ──
    const desc = document.createElement('div');
    desc.className = 'perm-desc';
    const truncDesc = description.length > 160 ? description.slice(0, 157) + '...' : description;
    desc.textContent = truncDesc;

    // ── Args block — terminal-style parameter readout ──
    const subject = extractSubject(args);
    let argsBlock: HTMLElement | null = null;
    if (subject) {
      argsBlock = document.createElement('div');
      argsBlock.className = 'perm-args-block';

      const argsLabel = document.createElement('div');
      argsLabel.className = 'perm-args-label';
      argsLabel.textContent = '目标参数'; // 目标参数

      const argsValue = document.createElement('div');
      const truncSubject = subject.length > 100 ? subject.slice(0, 97) + '...' : subject;
      argsValue.textContent = truncSubject;

      argsBlock.appendChild(argsLabel);
      argsBlock.appendChild(argsValue);
    }

    // ── Buttons ──
    const btnRow = document.createElement('div');
    btnRow.className = 'perm-btn-row';

    const resolveAndClose = (result: { allow: boolean; remember: boolean }) => {
      cleanup();
      resolve(result);
    };

    const makeBtn = (
      label: string,
      hint: string,
      cssClass: string,
      result: { allow: boolean; remember: boolean },
    ) => {
      const btn = document.createElement('button');
      btn.className = `perm-btn ${cssClass}`;
      btn.innerHTML = `${escapeText(label)}<kbd>${escapeText(hint)}</kbd>`;
      btn.addEventListener('click', (e) => { e.stopPropagation(); resolveAndClose(result); });
      return btn;
    };

    btnRow.appendChild(makeBtn('始终允许', 'Ctrl+Y', 'perm-btn-always', { allow: true, remember: true }));
    btnRow.appendChild(makeBtn('允许', 'Enter', 'perm-btn-once', { allow: true, remember: false }));
    btnRow.appendChild(makeBtn('拒绝', 'Esc', 'perm-btn-deny', { allow: false, remember: false }));

    // ── Assemble ──
    dialog.appendChild(header);
    dialog.appendChild(nameEl);
    dialog.appendChild(desc);
    if (argsBlock) dialog.appendChild(argsBlock);
    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);

    // Click outside → deny
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) resolveAndClose({ allow: false, remember: false });
    });

    // ── Keyboard shortcuts ──
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolveAndClose({ allow: false, remember: false });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        resolveAndClose({ allow: true, remember: false });
      } else if (e.key === 'y' && e.ctrlKey) {
        e.preventDefault();
        resolveAndClose({ allow: true, remember: true });
      }
    };
    document.addEventListener('keydown', onKey);

    const cleanup = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      pending.delete(id);
    };

    pending.set(id, { resolve, cleanup });
    document.body.appendChild(overlay);

    // Notify chat panel (for logging / awareness — not for rendering)
    bus.emit('agent:permission-request', { id, toolName, description, args });
  });
}

/** Dismiss all pending permission dialogs with "deny" — called on abort/stop. */
export function cancelPendingApprovals(): void {
  for (const [id, entry] of pending) {
    entry.cleanup();
    entry.resolve({ allow: false, remember: false });
  }
}
