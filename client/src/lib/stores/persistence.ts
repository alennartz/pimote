// Persistence — localStorage helpers for client session state.
// All setters silently swallow errors (quota exceeded, private browsing, etc.).
// Getters return null / empty array on missing or corrupted data.

const KEY_CLIENT_ID = 'pimote:clientId';
const KEY_ACTIVE_SESSIONS = 'pimote:activeSessions';
const KEY_VIEWED_SESSION_ID = 'pimote:viewedSessionId';

/** Minimal data needed to rehydrate a session tab. */
export interface PersistedSession {
  sessionId: string;
  folderPath: string;
}

// ---------------------------------------------------------------------------
// Client ID
// ---------------------------------------------------------------------------

export function getClientId(): string | null {
  try {
    return localStorage.getItem(KEY_CLIENT_ID);
  } catch {
    return null;
  }
}

export function setClientId(id: string): void {
  try {
    localStorage.setItem(KEY_CLIENT_ID, id);
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
// Viewed Session
// ---------------------------------------------------------------------------

export function getViewedSessionId(): string | null {
  try {
    return localStorage.getItem(KEY_VIEWED_SESSION_ID);
  } catch {
    return null;
  }
}

export function setViewedSessionId(id: string | null): void {
  try {
    if (id === null) {
      localStorage.removeItem(KEY_VIEWED_SESSION_ID);
    } else {
      localStorage.setItem(KEY_VIEWED_SESSION_ID, id);
    }
  } catch {
    // best-effort
  }
}
