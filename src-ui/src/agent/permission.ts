// Permission system — allow/ask/deny per tool call
// Design adapted from Reasonix (internal/permission/permission.go)
// Pure policy evaluation + interactive approve modal + persistent rules

type Decision = 'allow' | 'ask' | 'deny';

interface Rule {
  tool: string;
  subject?: string; // glob pattern matching a tool arg (command, filePath, etc.)
}

interface PolicyData {
  defaultMode: Decision; // fallback for write tools not in any list
  allow: Rule[];
  ask: Rule[];
  deny: Rule[];
}

// ── Glob matching ──
// Supports *, **, ? — converts pattern to regex for correct ** (recursive) matching.

function globToRegex(pattern: string): RegExp {
  // 1. Replace ** with placeholder
  let p = pattern.replace(/\*\*/g, '\x00');
  // 2. Escape regex special chars (except placeholder and *)
  p = p.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // 3. Replace placeholder with .* (matches path separators)
  p = p.replace(/\x00/g, '.*');
  // 4. Replace * with [^/]* (doesn't cross directory boundary)
  p = p.replace(/\*/g, '[^/]*');
  // 5. Replace ? with [^/]
  p = p.replace(/\?/g, '[^/]');
  return new RegExp('^' + p + '$');
}

function matchGlob(pattern: string, name: string): boolean {
  // Fast path: no **, use simple algorithm
  if (!pattern.includes('**')) {
    let px = 0, nx = 0, starPx = -1, starNx = -1;
    while (nx < name.length) {
      if (px < pattern.length && (pattern[px] === '?' || pattern[px] === name[nx])) {
        px++; nx++;
      } else if (px < pattern.length && pattern[px] === '*') {
        starPx = px; starNx = nx;
        px++;
      } else if (starPx !== -1) {
        px = starPx + 1;
        starNx++;
        nx = starNx;
      } else {
        return false;
      }
    }
    while (px < pattern.length && pattern[px] === '*') px++;
    return px === pattern.length;
  }
  // ** path: use regex
  try {
    return globToRegex(pattern).test(name);
  } catch {
    return false;
  }
}

// ── Subject extraction ──

const subjectKeys = ['command', 'filePath', 'path', 'pattern', 'file_path', 'directory'];

function extractSubject(args: Record<string, unknown>): string {
  for (const k of subjectKeys) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

// ── Rule matching ──

function matchAny(rules: Rule[], toolName: string, subject: string): boolean {
  for (const r of rules) {
    if (r.tool !== toolName) continue;
    if (!r.subject) return true;
    if (subject && matchGlob(r.subject, subject)) return true;
  }
  return false;
}

// ── Policy ──

export class PermissionPolicy {
  private data: PolicyData;

  constructor(defaultMode: Decision = 'ask') {
    this.data = {
      defaultMode,
      allow: [],
      ask: [],
      deny: [],
    };
  }

  /** Set rules from a flat config (e.g. from settings) */
  configure(cfg: { allow?: string[]; ask?: string[]; deny?: string[]; defaultMode?: Decision }): void {
    this.data.defaultMode = cfg.defaultMode || 'ask';
    this.data.allow = parseRules(cfg.allow || []);
    this.data.ask = parseRules(cfg.ask || []);
    this.data.deny = parseRules(cfg.deny || []);
  }

  /** Add a remembered allow rule */
  rememberAllow(toolName: string, subject: string): void {
    const rule: Rule = subject ? { tool: toolName, subject } : { tool: toolName };
    // Remove from ask/deny first, then add to allow
    this.data.ask = this.data.ask.filter(r => !isSameRule(r, rule));
    this.data.deny = this.data.deny.filter(r => !isSameRule(r, rule));
    this.data.allow.push(rule);
  }

  /** Export rules for persistence */
  exportRules(): { allow: string[]; deny: string[] } {
    return {
      allow: this.data.allow.map(r => r.subject ? `${r.tool}(${r.subject})` : r.tool),
      deny: this.data.deny.map(r => r.subject ? `${r.tool}(${r.subject})` : r.tool),
    };
  }

  /** Load rules from persisted format */
  importRules(rules: { allow?: string[]; deny?: string[] }): void {
    this.data.allow = parseRules(rules.allow || []);
    this.data.deny = parseRules(rules.deny || []);
  }

  decide(toolName: string, readOnly: boolean, args: Record<string, unknown>): Decision {
    const subject = extractSubject(args);
    if (matchAny(this.data.deny, toolName, subject)) return 'deny';
    if (matchAny(this.data.ask, toolName, subject)) return 'ask';
    if (matchAny(this.data.allow, toolName, subject)) return 'allow';
    if (readOnly) return 'allow';
    return this.data.defaultMode;
  }
}

function parseRules(strings: string[]): Rule[] {
  const rules: Rule[] = [];
  for (const s of strings) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    const i = trimmed.indexOf('(');
    if (i >= 0 && trimmed.endsWith(')')) {
      const tool = trimmed.slice(0, i).trim();
      if (tool) {
        rules.push({ tool, subject: trimmed.slice(i + 1, -1) });
      }
    } else {
      rules.push({ tool: trimmed });
    }
  }
  return rules;
}

function isSameRule(a: Rule, b: Rule): boolean {
  return a.tool === b.tool && (a.subject || '') === (b.subject || '');
}

// ── Gate (Policy + Approver) ──

export type ApproveCallback = (
  toolName: string,
  description: string,
  args: Record<string, unknown>,
) => Promise<{ allow: boolean; remember: boolean }>;

export class PermissionGate {
  policy: PermissionPolicy;
  private approve: ApproveCallback | null;
  onRemember: ((rule: string) => void) | null = null;

  constructor(policy: PermissionPolicy, approve?: ApproveCallback) {
    this.policy = policy;
    this.approve = approve || null;
  }

  setApprover(fn: ApproveCallback): void { this.approve = fn; }

  async check(
    toolName: string,
    toolDescription: string,
    args: Record<string, unknown>,
    readOnly: boolean,
  ): Promise<{ allow: boolean; reason?: string }> {
    const decision = this.policy.decide(toolName, readOnly, args);

    switch (decision) {
      case 'deny':
        return {
          allow: false,
          reason: '此工具被权限策略拒绝。请选择其他方式。',
        };
      case 'ask':
        if (!this.approve) return { allow: false, reason: '审批通道未就绪，已拒绝。' }; // v4: fail-closed
        const result = await this.approve(toolName, toolDescription, args);
        if (!result.allow) {
          return {
            allow: false,
            reason: '用户拒绝了此工具调用。请选择其他方式或询问用户。',
          };
        }
        if (result.remember && this.onRemember) {
          const subject = extractSubject(args);
          const rule = subject ? `${toolName}(${subject})` : toolName;
          this.onRemember(rule);
        }
        return { allow: true };
      default: // allow
        return { allow: true };
    }
  }
}

// ── Interactive approval — floating modal (not inline in chat) ──

import { bus } from '../ui/events';

/** Pending approval request resolvers, keyed by unique request ID. */
const pending = new Map<string, {
  resolve: (result: { allow: boolean; remember: boolean }) => void;
  cleanup: () => void;
}>();
let nextId = 1;

function escapeText(s: string): string {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

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
    Object.assign(overlay.style, {
      position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
      background: 'rgba(3, 8, 18, 0.78)', zIndex: '10000',
      backdropFilter: 'blur(10px) saturate(0.5)', WebkitBackdropFilter: 'blur(10px) saturate(0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    });

    // ── Dialog ──
    const dialog = document.createElement('div');
    dialog.className = 'perm-dialog';
    Object.assign(dialog.style, {
      background: 'var(--panel-bg, rgba(4, 12, 28, 0.94))',
      border: '1px solid var(--panel-edge, rgba(54, 82, 128, 0.3))',
      borderRadius: '14px', padding: '24px 26px 20px', maxWidth: '460px', minWidth: '340px',
      color: 'var(--starlight, #e2edff)',
      fontFamily: 'var(--font-body, "Noto Sans SC", sans-serif)',
      boxShadow: '0 24px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(54, 82, 128, 0.15) inset',
      backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
    });

    // Header tag
    const tag = document.createElement('div');
    tag.textContent = '权限请求';
    Object.assign(tag.style, {
      fontSize: '10px', color: 'var(--signal, #68a8ff)', marginBottom: '10px',
      textTransform: 'uppercase', letterSpacing: '2px', fontWeight: '600',
      fontFamily: 'var(--font-hud, "Orbitron", sans-serif)',
    });

    // Tool name
    const nameEl = document.createElement('div');
    nameEl.innerHTML = `⚡ <strong>${escapeText(toolName)}</strong>`;
    Object.assign(nameEl.style, {
      fontSize: '15px', fontWeight: '600', marginBottom: '6px',
      color: 'var(--starlight, #e2edff)',
    });

    // Description
    const desc = document.createElement('div');
    desc.textContent = description.length > 140 ? description.slice(0, 137) + '...' : description;
    Object.assign(desc.style, {
      fontSize: '12px', color: 'var(--starlight-dim, rgba(195, 218, 248, 0.7))',
      marginBottom: '16px', lineHeight: '1.5',
    });

    // Key args (compact)
    const subject = extractSubject(args);
    const argsHint = document.createElement('div');
    argsHint.textContent = subject ? `参数: ${subject.length > 80 ? subject.slice(0, 77) + '...' : subject}` : '';
    Object.assign(argsHint.style, {
      fontSize: '10px', color: 'rgba(145, 165, 190, 0.5)',
      fontFamily: 'var(--font-mono)', marginBottom: '18px',
      wordBreak: 'break-all',
    });

    // ── Buttons ──
    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, {
      display: 'flex', gap: '8px',
    });

    const resolveAndClose = (result: { allow: boolean; remember: boolean }) => {
      cleanup();
      resolve(result);
    };

    const makeBtn = (label: string, hint: string, primary: boolean, result: { allow: boolean; remember: boolean }) => {
      const btn = document.createElement('button');
      btn.innerHTML = `${label} <kbd style="font-size:9px;opacity:0.5;font-family:var(--font-mono)">${hint}</kbd>`;
      Object.assign(btn.style, {
        flex: primary ? '1.4' : '1',
        padding: '10px 12px', fontSize: '13px', fontWeight: '600',
        fontFamily: 'var(--font-body, "Noto Sans SC", sans-serif)',
        background: primary
          ? 'rgba(80, 140, 240, 0.15)'
          : 'rgba(255, 255, 255, 0.04)',
        border: primary
          ? '1px solid var(--signal-glow, rgba(80, 140, 240, 0.3))'
          : '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '8px',
        color: primary ? 'var(--signal, #68a8ff)' : 'var(--starlight-dim, rgba(195, 218, 248, 0.7))',
        cursor: 'pointer',
        transition: 'all 0.12s ease',
      });
      btn.addEventListener('mouseenter', () => {
        btn.style.background = primary
          ? 'rgba(80, 140, 240, 0.25)'
          : 'rgba(255, 255, 255, 0.08)';
        btn.style.borderColor = primary
          ? 'var(--signal, #68a8ff)'
          : 'rgba(255, 255, 255, 0.16)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = primary
          ? 'rgba(80, 140, 240, 0.15)'
          : 'rgba(255, 255, 255, 0.04)';
        btn.style.borderColor = primary
          ? 'var(--signal-glow, rgba(80, 140, 240, 0.3))'
          : 'rgba(255, 255, 255, 0.08)';
      });
      btn.addEventListener('click', (e) => { e.stopPropagation(); resolveAndClose(result); });
      return btn;
    };

    btnRow.appendChild(makeBtn('始终允许', 'Ctrl+Y', true, { allow: true, remember: true }));
    btnRow.appendChild(makeBtn('允许', 'Enter', false, { allow: true, remember: false }));
    btnRow.appendChild(makeBtn('拒绝', 'Esc', false, { allow: false, remember: false }));

    // ── Assemble ──
    dialog.appendChild(tag);
    dialog.appendChild(nameEl);
    dialog.appendChild(desc);
    if (subject) dialog.appendChild(argsHint);
    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);

    // Close on clicking outside dialog
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

    // Notify chat panel (so it can log / show awareness — not for rendering)
    bus.emit('agent:permission-request', { id, toolName, description, args });
  });
}

/** Called by external code to resolve a pending approval by ID. */
export function resolveApproval(id: string, result: { allow: boolean; remember: boolean }): void {
  const entry = pending.get(id);
  if (entry) {
    entry.cleanup();
    entry.resolve(result);
  }
}

/** Dismiss all pending permission dialogs with "deny" — called on abort/stop. */
export function cancelPendingApprovals(): void {
  for (const [id, entry] of pending) {
    entry.cleanup();
    entry.resolve({ allow: false, remember: false });
  }
}
