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

function matchGlob(pattern: string, name: string): boolean {
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

// ── Subject extraction ──

const subjectKeys = ['command', 'filePath', 'path', 'pattern', 'file_path'];

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

// ── Interactive approval — delegates to ChatPanel via EventBus ──

import { bus } from '../ui/events';

/** Pending approval request resolvers, keyed by unique request ID. */
const pending = new Map<string, (result: { allow: boolean; remember: boolean }) => void>();
let nextId = 1;

export function showApprovalDialog(
  toolName: string,
  description: string,
  args: Record<string, unknown>,
): Promise<{ allow: boolean; remember: boolean }> {
  return new Promise((resolve) => {
    const id = `perm-${nextId++}`;
    pending.set(id, resolve);
    bus.emit('agent:permission-request', { id, toolName, description, args });
  });
}

/** Called by ChatPanel when the user clicks a button on the inline permission card. */
export function resolveApproval(id: string, result: { allow: boolean; remember: boolean }): void {
  const resolve = pending.get(id);
  if (resolve) {
    pending.delete(id);
    resolve(result);
  }
}
