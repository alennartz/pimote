// Persistence — browser-storage helpers for client session state.
// The client id lives in sessionStorage (per tab, survives reload); everything
// else is shared localStorage state.
// All setters silently swallow errors (quota exceeded, private browsing, etc.).
// Getters return null / empty array on missing or corrupted data.

const KEY_CLIENT_ID = 'pimote:clientId';
const KEY_ACTIVE_SESSIONS = 'pimote:activeSessions';
const KEY_SHOW_ARCHIVED = 'pimote:showArchived';
const KEY_SESSION_PILL_SWIPE_HINT_SHOWN = 'pimote:sessionPillSwipeHintShown';
const KEY_DISMISSED_UPDATE_VERSION = 'pimote:dismissedUpdateVersion';

/** Minimal data needed to rehydrate a session tab. */
export interface PersistedSession {
  sessionId: string;
  folderPath: string;
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
