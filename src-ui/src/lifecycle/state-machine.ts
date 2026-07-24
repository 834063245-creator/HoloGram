/**
 * WorkspaceStateMachine — replaces the ad-hoc `_switching` / `_active` boolean flags
 * with a typed state machine where every transition has guards and optional timeouts.
 *
 * States:
 *   idle          — no workspace open
 *   opening       — Workspace.open() in progress
 *   active        — workspace fully operational
 *   deactivating  — Workspace.deactivate() in progress
 *   switching     — deactivate → open composite (atomic from user perspective)
 *   degraded     — workspace open but background analysis failed
 */

export type WorkspaceState =
  | 'idle'
  | 'opening'
  | 'active'
  | 'deactivating'
  | 'switching'
  | 'degraded';

const VALID_TRANSITIONS: Record<WorkspaceState, WorkspaceState[]> = {
  idle: ['opening', 'switching'],
  opening: ['active', 'degraded', 'idle'],
  active: ['deactivating', 'switching', 'degraded'],
  deactivating: ['idle', 'switching'],
  switching: ['active', 'degraded', 'idle'],
  degraded: ['deactivating', 'switching', 'active'],
};

export class WorkspaceStateMachine {
  private _state: WorkspaceState = 'idle';
  private _listeners: Array<(s: WorkspaceState) => void> = [];

  get state(): WorkspaceState {
    return this._state;
  }

  /** Check if a transition is allowed by the state machine. */
  canTransition(to: WorkspaceState): boolean {
    const allowed = VALID_TRANSITIONS[this._state] ?? [];
    return allowed.includes(to);
  }

  /** Transition to a new state. Throws if the transition is not allowed. */
  transition(to: WorkspaceState): void {
    if (!this.canTransition(to)) {
      throw new Error(`Invalid transition: ${this._state} → ${to}`);
    }
    this._state = to;
    this._notify();
  }

  /** Force-set state without transition validation (for error recovery / timeout). */
  forceState(to: WorkspaceState): void {
    this._state = to;
    this._notify();
  }

  /** Check if currently in a state that blocks new workspace operations. */
  get isBusy(): boolean {
    return this._state === 'opening'
      || this._state === 'deactivating'
      || this._state === 'switching';
  }

  onStateChange(fn: (s: WorkspaceState) => void): () => void {
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter(f => f !== fn);
    };
  }

  private _notify(): void {
    for (const fn of this._listeners) {
      try { fn(this._state); } catch { /* listener error should not block */ }
    }
  }
}
