export interface EditorWorkspaceKey {
  readonly sessionId: string;
  readonly requestId: string;
}

export interface EditorRequest {
  readonly key: EditorWorkspaceKey;
  readonly title?: string;
  readonly message?: string;
  readonly prefill?: string;
}

export type EditorAction = 'save' | 'cancel' | 'discard';

export type EditorWireAnswer = { value: string } | { cancelled: true };

export type EditorWorkspaceStatus = 'pending' | 'restoring' | 'answering';

export interface EditorWorkspaceRecord {
  readonly key: EditorWorkspaceKey;
  request: EditorRequest;
  value: string;
  readonly baseline: string;
  dirty: boolean;
  status: EditorWorkspaceStatus;
  readonly sequence: number;
}

export type EditorAnswerResult =
  | { kind: 'submitted' }
  | { kind: 'needs-discard-confirmation' }
  | { kind: 'retryable' }
  | { kind: 'stale' }
  | { kind: 'ignored'; reason: 'unknown-workspace' | 'not-pending' };

export interface ExtensionEditorWorkspaceOptions {
  sendResponse: (key: EditorWorkspaceKey, answer: EditorWireAnswer) => Promise<boolean>;
  /** Return false when another pending extension request owns the modal slot. */
  isModalOwner?: (key: EditorWorkspaceKey) => boolean;
}

interface RestoreWindow {
  epoch: number;
  replayed: Set<string>;
  completed: boolean;
}

interface InternalWorkspace extends EditorWorkspaceRecord {
  attempt: number;
}

/**
 * Session-owned lifecycle for extension editor workspaces.
 *
 * This module owns request identity, replay retention, presentation selection,
 * and response-attempt races. The editor renderer owns the live CodeMirror
 * runtime and keeps it mounted while a record remains in this host.
 */
export class ExtensionEditorWorkspaceHost {
  private readonly workspacesBySession = new Map<string, Map<string, InternalWorkspace>>();
  private readonly ordered: InternalWorkspace[] = [];
  private readonly restoreWindows = new Map<string, RestoreWindow>();
  private readonly listeners = new Set<() => void>();
  private readonly isModalOwner: (key: EditorWorkspaceKey) => boolean;
  private nextSequence = 0;
  private _viewedSessionId: string | null = null;

  constructor(private readonly options: ExtensionEditorWorkspaceOptions) {
    this.isModalOwner = options.isModalOwner ?? (() => true);
  }

  get viewedSessionId(): string | null {
    return this._viewedSessionId;
  }

  get workspaces(): readonly EditorWorkspaceRecord[] {
    return this.ordered;
  }

  get active(): EditorWorkspaceRecord | null {
    const sessionId = this._viewedSessionId;
    if (sessionId === null) return null;
    return this.ordered.find((workspace) => workspace.key.sessionId === sessionId && workspace.status === 'pending' && this.isModalOwner(workspace.key)) ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notify presentation consumers when an external modal owner changed. */
  refresh(): void {
    this.notify();
  }

  setViewedSession(sessionId: string | null): void {
    this._viewedSessionId = sessionId;
    this.notify();
  }

  ingestRequest(request: EditorRequest): void {
    const existing = this.find(request.key);
    const restore = this.restoreWindows.get(request.key.sessionId);
    const requestKey = workspaceKeyId(request.key);
    if (restore) restore.replayed.add(requestKey);

    if (existing) {
      existing.request = { ...request, key: { ...request.key } };
      if (existing.status === 'restoring' || existing.status === 'answering') {
        existing.status = 'pending';
        existing.attempt += 1;
      }
      this.notify();
      return;
    }

    const prefill = request.prefill ?? '';
    const workspace: InternalWorkspace = {
      key: { ...request.key },
      request: { ...request, key: { ...request.key } },
      value: prefill,
      baseline: prefill,
      dirty: false,
      status: 'pending',
      sequence: this.nextSequence++,
      attempt: 0,
    };
    this.ordered.push(workspace);
    let sessionWorkspaces = this.workspacesBySession.get(request.key.sessionId);
    if (!sessionWorkspaces) {
      sessionWorkspaces = new Map();
      this.workspacesBySession.set(request.key.sessionId, sessionWorkspaces);
    }
    sessionWorkspaces.set(request.key.requestId, workspace);
    this.notify();
  }

  getValue(key: EditorWorkspaceKey): string | undefined {
    return this.find(key)?.value;
  }

  setValue(key: EditorWorkspaceKey, value: string): void {
    const workspace = this.find(key);
    if (!workspace || workspace.status === 'answering') return;
    workspace.value = value;
    workspace.dirty = value !== workspace.baseline;
    this.notify();
  }

  async answer(key: EditorWorkspaceKey, action: EditorAction): Promise<EditorAnswerResult> {
    const workspace = this.find(key);
    if (!workspace) return { kind: 'ignored', reason: 'unknown-workspace' };
    if (workspace.status !== 'pending') return { kind: 'ignored', reason: 'not-pending' };
    if (action === 'cancel' && workspace.dirty) return { kind: 'needs-discard-confirmation' };

    const answer: EditorWireAnswer = action === 'save' ? { value: workspace.value } : { cancelled: true };
    workspace.status = 'answering';
    const attempt = ++workspace.attempt;
    this.notify();

    let accepted: boolean;
    try {
      accepted = await this.options.sendResponse(workspace.key, answer);
    } catch {
      accepted = false;
    }

    if (this.find(key) !== workspace || workspace.attempt !== attempt || workspace.status !== 'answering') {
      return { kind: 'stale' };
    }
    if (!accepted) {
      workspace.status = 'pending';
      this.notify();
      return { kind: 'retryable' };
    }

    this.remove(workspace);
    return { kind: 'submitted' };
  }

  resolved(key: EditorWorkspaceKey): void {
    const workspace = this.find(key);
    if (workspace) this.remove(workspace);
    else this.notify();
  }

  restoreStarted(sessionId: string): void {
    const previous = this.restoreWindows.get(sessionId);
    const restore: RestoreWindow = {
      epoch: (previous?.epoch ?? 0) + 1,
      replayed: new Set(),
      completed: false,
    };
    this.restoreWindows.set(sessionId, restore);
    for (const workspace of this.sessionWorkspaces(sessionId)) {
      workspace.status = 'restoring';
      workspace.attempt += 1;
    }
    this.notify();
  }

  /** The wire event is not the prune barrier. Replay can follow it. */
  restoreCompleted(sessionId: string): void {
    const restore = this.restoreWindows.get(sessionId);
    if (!restore) return;
    restore.completed = true;
    this.notify();
  }

  /** Called after the matching open_session response has arrived. */
  restoreBarrier(sessionId: string): void {
    const restore = this.restoreWindows.get(sessionId);
    if (!restore) return;
    for (const workspace of [...this.sessionWorkspaces(sessionId)]) {
      if (!restore.replayed.has(workspaceKeyId(workspace.key))) this.remove(workspace, false);
      else if (workspace.status === 'restoring') workspace.status = 'pending';
    }
    this.restoreWindows.delete(sessionId);
    this.notify();
  }

  sessionClosed(sessionId: string): void {
    for (const workspace of [...this.sessionWorkspaces(sessionId)]) this.remove(workspace, false);
    this.restoreWindows.delete(sessionId);
    this.notify();
  }

  sessionReplaced(oldSessionId: string, _newSessionId: string): void {
    this.sessionClosed(oldSessionId);
  }

  private sessionWorkspaces(sessionId: string): readonly InternalWorkspace[] {
    return [...(this.workspacesBySession.get(sessionId)?.values() ?? [])];
  }

  private find(key: EditorWorkspaceKey): InternalWorkspace | undefined {
    return this.workspacesBySession.get(key.sessionId)?.get(key.requestId);
  }

  private remove(workspace: InternalWorkspace, notify = true): void {
    const sessionWorkspaces = this.workspacesBySession.get(workspace.key.sessionId);
    if (sessionWorkspaces?.get(workspace.key.requestId) !== workspace) return;
    sessionWorkspaces.delete(workspace.key.requestId);
    if (sessionWorkspaces.size === 0) this.workspacesBySession.delete(workspace.key.sessionId);
    const index = this.ordered.indexOf(workspace);
    if (index >= 0) this.ordered.splice(index, 1);
    if (notify) this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export function workspaceKeyId(key: EditorWorkspaceKey): string {
  return JSON.stringify([key.sessionId, key.requestId]);
}
