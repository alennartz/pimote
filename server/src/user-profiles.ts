import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** One open session in a user's profile. */
export interface SessionRef {
  sessionId: string;
  folderPath: string;
}

const DOCUMENT_VERSION = 1;

/** The user-profile JSON document at `PIMOTE_STATE_DIR/user-profiles.json`. */
interface ProfileDocument {
  version: number;
  users: { [name: string]: { sessions: SessionRef[] } };
}

/** A persisted document as handed to the parser. */
type PersistedDocument = Partial<ProfileDocument>;

/** The users map is null-prototype so user names colliding with Object
 *  prototype members (`constructor`, `__proto__`, ...) stay ordinary keys. */
function emptyDocument(): ProfileDocument {
  return { version: DOCUMENT_VERSION, users: Object.create(null) as ProfileDocument['users'] };
}

/** Parse a persisted document; a corrupt or malformed file degrades to empty. */
function parseDocument(raw: string): ProfileDocument {
  try {
    const parsed = JSON.parse(raw) as PersistedDocument;
    if (typeof parsed.users !== 'object' || parsed.users === null) return emptyDocument();
    for (const profile of Object.values(parsed.users)) {
      if (!profile || typeof profile !== 'object' || !Array.isArray(profile.sessions)) return emptyDocument();
    }
    return { version: DOCUMENT_VERSION, users: Object.assign(Object.create(null), parsed.users) as ProfileDocument['users'] };
  } catch {
    return emptyDocument();
  }
}

/** Longest client-presented user name honored before capping. */
const MAX_USER_NAME_LENGTH = 64;

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
  private document: ProfileDocument = emptyDocument();
  /** Serializes persist I/O: mutations are synchronous, but the writes must
   *  not race, or an older rename can land last and resurrect a mutated-away
   *  entry on disk. Each write stringifies current memory inside the chain. */
  private persistChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly storePath: string) {}

  /** Read the profile document; a corrupt or missing file degrades to an empty store. */
  async load(): Promise<void> {
    try {
      this.document = parseDocument(await readFile(this.storePath, 'utf-8'));
    } catch {
      this.document = emptyDocument();
    }
  }

  /** Prune entries naming sessions outside `validSessionIds` (boot-time sweep). */
  async gc(validSessionIds: Set<string>): Promise<void> {
    let pruned = false;
    for (const [name, profile] of Object.entries(this.document.users)) {
      const kept = profile.sessions.filter((ref) => validSessionIds.has(ref.sessionId));
      if (kept.length !== profile.sessions.length) {
        this.document.users[name] = { sessions: kept };
        pruned = true;
      }
    }
    if (pruned) await this.persist();
  }

  /** The user's full open-session set; empty for an unknown user. */
  get(user: string): SessionRef[] {
    return (this.document.users[user]?.sessions ?? []).map((s) => ({ ...s }));
  }

  /** True when no profile exists for this user yet. */
  isFresh(user: string): boolean {
    return !Object.hasOwn(this.document.users, user);
  }

  /** Idempotent add; creates the user key, ending freshness. Returns true when the profile changed. */
  async link(user: string, ref: SessionRef): Promise<boolean> {
    const profile = this.ensureProfile(user);
    const existing = profile.sessions.find((s) => s.sessionId === ref.sessionId);
    if (existing) {
      if (existing.folderPath === ref.folderPath) return false;
      existing.folderPath = ref.folderPath;
    } else {
      profile.sessions.push({ ...ref });
    }
    await this.persistOrLog();
    return true;
  }

  /** Remove one session from one user. Returns true when changed. */
  async unlink(user: string, sessionId: string): Promise<boolean> {
    const profile = this.document.users[user];
    if (!profile) return false;
    const kept = profile.sessions.filter((s) => s.sessionId !== sessionId);
    if (kept.length === profile.sessions.length) return false;
    profile.sessions = kept;
    await this.persistOrLog();
    return true;
  }

  /** Remove a session from all users; returns affected user names. */
  async unlinkAll(sessionId: string): Promise<string[]> {
    const affected: string[] = [];
    for (const [name, profile] of Object.entries(this.document.users)) {
      const kept = profile.sessions.filter((s) => s.sessionId !== sessionId);
      if (kept.length !== profile.sessions.length) {
        profile.sessions = kept;
        affected.push(name);
      }
    }
    if (affected.length > 0) await this.persist();
    return affected;
  }

  /** Alphabetical names with counts, for listusers. */
  summaries(): { name: string; sessionCount: number }[] {
    return Object.keys(this.document.users)
      .sort()
      .map((name) => ({ name, sessionCount: this.document.users[name].sessions.length }));
  }

  private ensureProfile(user: string): { sessions: SessionRef[] } {
    let profile = this.document.users[user];
    if (!profile) {
      profile = { sessions: [] };
      this.document.users[user] = profile;
    }
    return profile;
  }

  /** Persist without throwing: the mutation stays applied and callers keep
   *  their mutation-then-broadcast contract; memory stays ahead of disk until
   *  the next successful write. */
  private async persistOrLog(): Promise<void> {
    try {
      await this.persist();
    } catch (error) {
      console.warn('[user-profiles] persist failed:', error instanceof Error ? error.message : error);
    }
  }

  /** Atomic replace: write to a unique `.tmp`, then rename over the final path. */
  private async persist(): Promise<void> {
    const write = this.persistChain.then(() => this.writeDocument());
    this.persistChain = write.catch(() => {});
    await write;
  }

  private async writeDocument(): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    const temporaryPath = `${this.storePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(this.document, null, 2)}\n`, 'utf-8');
      await rename(temporaryPath, this.storePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

/** Normalize a client-presented user name: trim, cap length, blank or absent → `default`. */
export function resolveUserName(raw: string | null | undefined): string {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return 'default';
  return trimmed.slice(0, MAX_USER_NAME_LENGTH);
}
