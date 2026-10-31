/** One open session in a user's profile. */
export interface SessionRef {
  sessionId: string;
  folderPath: string;
}

/**
 * The per-user open-session profile store. Owns profile truth, persistence,
 * and boot GC. Knows nothing about sockets or observers; callers translate
 * wire traffic into link/unlink calls.
 *
 * Storage: single JSON document, atomic temp-write-then-rename on every
 * mutation. User names are honor-system identity: no auth, no reserved names.
 * A user key persists even when its session list is empty — emptiness is
 * meaningful state, and recycling absent keys would reopen the migration
 * adoption window. The `fresh` notion is derived, not stored: a user is fresh
 * when no key exists for it yet; the first link ends freshness forever.
 */
export class UserProfiles {
  constructor(private readonly storePath: string) {}

  /** Read the profile document; a corrupt or missing file degrades to an empty store. */
  load(): Promise<void> {
    throw new Error('not implemented');
  }

  /** Prune entries naming sessions outside `_validSessionIds` (boot-time sweep). */
  gc(_validSessionIds: Set<string>): Promise<void> {
    throw new Error('not implemented');
  }

  /** The user's full open-session set; empty for an unknown user. */
  get(_user: string): SessionRef[] {
    throw new Error('not implemented');
  }

  /** True when no profile exists for this user yet. */
  isFresh(_user: string): boolean {
    throw new Error('not implemented');
  }

  /** Idempotent add; creates the user key, ending freshness. Returns true when the profile changed. */
  link(_user: string, _ref: SessionRef): Promise<boolean> {
    throw new Error('not implemented');
  }

  /** Remove one session from one user. Returns true when changed. */
  unlink(_user: string, _sessionId: string): Promise<boolean> {
    throw new Error('not implemented');
  }

  /** Remove a session from all users; returns affected user names. */
  unlinkAll(_sessionId: string): Promise<string[]> {
    throw new Error('not implemented');
  }

  /** Alphabetical names with counts, for list_users. */
  summaries(): { name: string; sessionCount: number }[] {
    throw new Error('not implemented');
  }
}

/** Normalize a client-presented user name: trim, cap length, blank or absent → `default`. */
export function resolveUserName(_raw: string | null | undefined): string {
  throw new Error('not implemented');
}
