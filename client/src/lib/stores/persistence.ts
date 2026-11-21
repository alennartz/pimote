// Persistence — browser-storage helpers for client session state.
// Per-tab state lives in sessionStorage and survives a page reload. Shared
// preferences and the migration seed live in localStorage.
// All setters silently swallow errors (quota exceeded, private browsing, etc.).
// Getters return null / empty values on missing or corrupted data.

const KEY_CLIENT_ID = 'pimote:clientId';
const KEY_SESSION_DRAFTS = 'pimote:sessionDrafts';
const KEY_ACTIVE_SESSIONS = 'pimote:activeSessions';
const KEY_USER = 'pimote:user';
const KEY_SHOW_ARCHIVED = 'pimote:showArchived';
const KEY_SESSION_PILL_SWIPE_HINT_SHOWN = 'pimote:sessionPillSwipeHintShown';
const KEY_DISMISSED_UPDATE_VERSION = 'pimote:dismissedUpdateVersion';

/** Minimal data needed to rehydrate a session tab. */
export interface PersistedSession {
  sessionId: string;
  folderPath: string;
}

/** Client-owned composer state for one session. It stays per tab so two tabs
 *  can edit the same server session without sharing unsent text. */
export interface SessionDraft {
  text: string;
}

const emptySessionDraft = (): SessionDraft => ({ text: '' });

function sessionDraftKey(sessionId: string): string {
  const user = getUser();
  return `${user?.trim() || 'default'}\u0000${sessionId}`;
}

function readSessionDrafts(): Record<string, SessionDraft> {
  try {
    const raw = sessionStorage.getItem(KEY_SESSION_DRAFTS);
    if (raw === null) return Object.create(null) as Record<string, SessionDraft>;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.create(null) as Record<string, SessionDraft>;
    const drafts = Object.create(null) as Record<string, SessionDraft>;
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const candidate = value as { text?: unknown };
      const text = typeof candidate.text === 'string' ? candidate.text : '';
      if (text !== '') drafts[sessionId] = { text };
    }
    return drafts;
  } catch {
    return Object.create(null) as Record<string, SessionDraft>;
  }
}

// ---------------------------------------------------------------------------
// Client ID (per tab — sessionStorage)
// ---------------------------------------------------------------------------

/** This tab's client id. sessionStorage, not localStorage: two tabs must not
 *  share an identity (the server treats a repeat id as a stale-connection
 *  takeover and closes the live socket, so two tabs evict each other in a
 *  loop), but a reload must reclaim its own id so queued-draft attribution
 *  and takeover of the tab's own stale socket keep working. */
export function getClientId(): string | null {
  try {
    return sessionStorage.getItem(KEY_CLIENT_ID);
  } catch {
    return null;
  }
}

export function setClientId(id: string): void {
  try {
    sessionStorage.setItem(KEY_CLIENT_ID, id);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Session drafts (per tab — sessionStorage)
// ---------------------------------------------------------------------------

export function getSessionDraft(sessionId: string): SessionDraft {
  const draft = readSessionDrafts()[sessionDraftKey(sessionId)];
  return draft ? { text: draft.text } : emptySessionDraft();
}

export function setSessionDraft(sessionId: string, draft: SessionDraft): void {
  try {
    const drafts = readSessionDrafts();
    const key = sessionDraftKey(sessionId);
    if (draft.text === '') delete drafts[key];
    else drafts[key] = { text: draft.text };
    if (Object.keys(drafts).length === 0) sessionStorage.removeItem(KEY_SESSION_DRAFTS);
    else sessionStorage.setItem(KEY_SESSION_DRAFTS, JSON.stringify(drafts));
  } catch {
    // best-effort
  }
}

export function clearSessionDraft(sessionId: string): void {
  setSessionDraft(sessionId, emptySessionDraft());
}

// ---------------------------------------------------------------------------
// Active Sessions
// ---------------------------------------------------------------------------

export function getActiveSessions(): PersistedSession[] {
  try {
    const raw = localStorage.getItem(KEY_ACTIVE_SESSIONS);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate each entry has the required shape
    return parsed.filter(
      (entry: unknown): entry is PersistedSession =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).sessionId === 'string' &&
        typeof (entry as Record<string, unknown>).folderPath === 'string',
    );
  } catch {
    return [];
  }
}

export function setActiveSessions(sessions: PersistedSession[]): void {
  try {
    localStorage.setItem(KEY_ACTIVE_SESSIONS, JSON.stringify(sessions));
  } catch {
    // best-effort
  }
}

/** Drop the local open-session mirror for good: the server's per-user profile
 *  is the only open-session set once the first user_sessions_changed lands. */
export function clearActiveSessions(): void {
  try {
    localStorage.removeItem(KEY_ACTIVE_SESSIONS);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// User (this device's identity on the server)
// ---------------------------------------------------------------------------

/** This device's user name, or null when never set — the connection omits the
 *  parameter and the server falls back to its default profile. Stored under
 *  the `pimote:user` localStorage key. */
export function getUser(): string | null {
  try {
    return localStorage.getItem(KEY_USER);
  } catch {
    return null;
  }
}

/** Store a user name. Mirrors the server's resolveUserName (trim, cap 64) so
 *  the stored name always equals the server-side profile key. */
export function setUser(name: string): void {
  try {
    localStorage.setItem(KEY_USER, name.trim().slice(0, 64));
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Sidebar preferences
// ---------------------------------------------------------------------------

export function getShowArchived(): boolean {
  try {
    return localStorage.getItem(KEY_SHOW_ARCHIVED) === 'true';
  } catch {
    return false;
  }
}

export function setShowArchived(show: boolean): void {
  try {
    localStorage.setItem(KEY_SHOW_ARCHIVED, String(show));
  } catch {
    // best-effort
  }
}

export function getSessionPillSwipeHintShown(): boolean {
  try {
    return localStorage.getItem(KEY_SESSION_PILL_SWIPE_HINT_SHOWN) === 'true';
  } catch {
    return false;
  }
}

export function setSessionPillSwipeHintShown(shown: boolean): void {
  try {
    localStorage.setItem(KEY_SESSION_PILL_SWIPE_HINT_SHOWN, String(shown));
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Update notification
// ---------------------------------------------------------------------------

export function getDismissedUpdateVersion(): string | null {
  try {
    return localStorage.getItem(KEY_DISMISSED_UPDATE_VERSION);
  } catch {
    return null;
  }
}

export function setDismissedUpdateVersion(version: string): void {
  try {
    localStorage.setItem(KEY_DISMISSED_UPDATE_VERSION, version);
  } catch {
    // best-effort
  }
}
