import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** One open session in a user's profile. */
export interface SessionRef {
  sessionId: string;
  folderPath: string;
}

/** One open child view in a user's profile. */
export interface ViewRef {
  /** Child session id — the session the view renders. */
  sessionId: string;
  /** Root session that owns the borrowed runtime. */
  rootSessionId: string;
  /** Root-relative agent path. */
  path: string[];
  /** Folder of the root. */
  folderPath: string;
}

const DOCUMENT_VERSION = 1;

/** One user's persisted profile. `order` is always the same members as
 *  `sessions`; `selectedSessionId` is always one of them or null. */
interface UserProfile {
  sessions: SessionRef[];
  /** Open child views. Chip order and selection stay root-only. */
  views: ViewRef[];
  /** Session ids in chip order — the client owns the order, this stores it. */
  order: string[];
  selectedSessionId: string | null;
  /** Epoch of `order`, bumped on every accepted whole-order write. */
  orderVersion: number;
}

/** The user-profile JSON document at `PIMOTE_STATE_DIR/user-profiles.json`. */
interface ProfileDocument {
  version: number;
  users: { [name: string]: UserProfile };
}

/** A persisted document as handed to the parser. */
type PersistedDocument = {
  version?: number;
  users?: {
    [name: string]: {
      sessions?: SessionRef[];
      views?: ViewRef[];
      order?: string[];
      selectedSessionId?: string | null;
      orderVersion?: number;
    };
  };
};

/** The users map is null-prototype so user names colliding with Object
 *  prototype members (`constructor`, `__proto__`, ...) stay ordinary keys. */
function emptyDocument(): ProfileDocument {
  return { version: DOCUMENT_VERSION, users: Object.create(null) as ProfileDocument['users'] };
}

/** Parse a persisted document; a corrupt or malformed file degrades to empty.
 *  Documents written before this store carried order and selection load with
 *  the order seeded from the stored set — the adoption order. */
function parseDocument(raw: string): ProfileDocument {
  try {
    const parsed = JSON.parse(raw) as PersistedDocument;
    if (typeof parsed.users !== 'object' || parsed.users === null) return emptyDocument();
    const users = Object.create(null) as ProfileDocument['users'];
    for (const [name, profile] of Object.entries(parsed.users)) {
      if (!profile || typeof profile !== 'object' || !Array.isArray(profile.sessions)) return emptyDocument();
      const sessions = profile.sessions;
      users[name] = {
        sessions,
        views: parseViews(profile.views),
        order: normalizeOrder(sessions, profile.order),
        selectedSessionId: normalizeSelection(sessions, profile.selectedSessionId),
        orderVersion: typeof profile.orderVersion === 'number' && profile.orderVersion >= 0 ? profile.orderVersion : 0,
      };
    }
    return { version: DOCUMENT_VERSION, users };
  } catch {
    return emptyDocument();
  }
}

/** Keep `order` exactly the members of `sessions`: unknown and duplicate ids
 *  drop, and members the order omits append in set order. A reorder can never
 *  add or remove an open session, and a new session appends at the end. */
function normalizeOrder(sessions: readonly SessionRef[], order: readonly string[] | undefined): string[] {
  const members = new Set(sessions.map((session) => session.sessionId));
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const id of order ?? []) {
    if (typeof id !== 'string' || !members.has(id) || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  for (const session of sessions) {
    if (!seen.has(session.sessionId)) {
      seen.add(session.sessionId);
      kept.push(session.sessionId);
    }
  }
  return kept;
}

/** Drop malformed view entries and duplicates of the same root-relative path. */
function parseViews(raw: unknown): ViewRef[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const views: ViewRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Partial<ViewRef>;
    if (typeof candidate.sessionId !== 'string' || typeof candidate.rootSessionId !== 'string' || typeof candidate.folderPath !== 'string') continue;
    if (!Array.isArray(candidate.path) || candidate.path.some((part) => typeof part !== 'string')) continue;
    const key = `${candidate.rootSessionId}\u0000${JSON.stringify(candidate.path)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    views.push({ sessionId: candidate.sessionId, rootSessionId: candidate.rootSessionId, path: [...candidate.path], folderPath: candidate.folderPath });
  }
  return views;
}

/** Selection is either an open session or nothing — never a stale id. */
function normalizeSelection(sessions: readonly SessionRef[], selected: unknown): string | null {
  if (typeof selected !== 'string') return null;
  return sessions.some((session) => session.sessionId === selected) ? selected : null;
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
const samePath = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((part, index) => part === right[index]);

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

  /** Prune entries naming sessions outside `validSessionIds` (boot-time sweep).
   *  Throws on persist failure — a boot sweep that cannot be written aborts
   *  coherently; runtime mutators use persistOrLog instead. */
  async gc(validSessionIds: Set<string>): Promise<void> {
    let pruned = false;
    for (const [name, profile] of Object.entries(this.document.users)) {
      const kept = profile.sessions.filter((ref) => validSessionIds.has(ref.sessionId));
      // A view whose root is gone can never be served again: the borrowed
      // runtime died with the root slot.
      const views = profile.views.filter((view) => kept.some((ref) => ref.sessionId === view.rootSessionId));
      if (kept.length === profile.sessions.length && views.length === profile.views.length) continue;
      const order = normalizeOrder(kept, profile.order);
      const selectedSessionId = normalizeSelection(kept, profile.selectedSessionId);
      this.document.users[name] = { ...profile, sessions: kept, views, order, selectedSessionId };
      pruned = true;
    }
    if (pruned) await this.persist();
  }

  /** Drop every persisted child view. A view needs a live borrowed runtime, and
   *  the root session that owns one does not rebuild it at boot. */
  async dropAllViews(): Promise<void> {
    let pruned = false;
    for (const [name, profile] of Object.entries(this.document.users)) {
      if (profile.views.length === 0) continue;
      this.document.users[name] = { ...profile, views: [] };
      pruned = true;
    }
    if (pruned) await this.persist();
  }

  /** The user's full open-session set; empty for an unknown user. */
  get(user: string): SessionRef[] {
    return (this.document.users[user]?.sessions ?? []).map((s) => ({ ...s }));
  }

  /** Every open session id in chip order; empty for an unknown user. */
  order(user: string): string[] {
    return [...(this.document.users[user]?.order ?? [])];
  }

  /** The user's selected session, or null. Always a member of the set. */
  selection(user: string): string | null {
    return this.document.users[user]?.selectedSessionId ?? null;
  }

  /** Epoch of the stored order, for the client's `baseVersion`. */
  orderVersion(user: string): number {
    return this.document.users[user]?.orderVersion ?? 0;
  }

  /** True when no profile exists for this user yet. */
  isFresh(user: string): boolean {
    return !Object.hasOwn(this.document.users, user);
  }

  /** The user's open child views; empty for an unknown user or root. */
  views(user: string): ViewRef[] {
    return (this.document.users[user]?.views ?? []).map((view) => ({ ...view, path: [...view.path] }));
  }

  /** Idempotent view add by root-relative path. Returns true when the profile changed. */
  async linkView(user: string, ref: ViewRef): Promise<boolean> {
    const profile = this.ensureProfile(user);
    const existing = profile.views.find((view) => view.rootSessionId === ref.rootSessionId && samePath(view.path, ref.path));
    if (existing) {
      if (existing.sessionId === ref.sessionId && existing.folderPath === ref.folderPath) return false;
      existing.sessionId = ref.sessionId;
      existing.folderPath = ref.folderPath;
    } else {
      profile.views.push({ ...ref, path: [...ref.path] });
    }
    await this.persistOrLog();
    return true;
  }

  /** Remove one view by root-relative path. Returns true when changed. */
  async unlinkView(user: string, rootSessionId: string, path: readonly string[]): Promise<boolean> {
    const profile = this.document.users[user];
    if (!profile) return false;
    const kept = profile.views.filter((view) => !(view.rootSessionId === rootSessionId && samePath(view.path, path)));
    if (kept.length === profile.views.length) return false;
    profile.views = kept;
    await this.persistOrLog();
    return true;
  }

  /** Remove one root's views from every user, or from one user; returns
   *  affected user names. */
  async unlinkViewsUnder(rootSessionId: string, user?: string): Promise<string[]> {
    const affected: string[] = [];
    for (const [name, profile] of Object.entries(this.document.users)) {
      if (user !== undefined && name !== user) continue;
      const kept = profile.views.filter((view) => view.rootSessionId !== rootSessionId);
      if (kept.length === profile.views.length) continue;
      profile.views = kept;
      affected.push(name);
    }
    if (affected.length > 0) await this.persistOrLog();
    return affected;
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
    // A new session appends to the persisted order; the order is never re-sorted.
    profile.order = normalizeOrder(profile.sessions, profile.order);
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
    profile.order = normalizeOrder(kept, profile.order);
    profile.selectedSessionId = normalizeSelection(kept, profile.selectedSessionId);
    await this.persistOrLog();
    return true;
  }

  /** Remove a session from all users; returns affected user names. */
  async unlinkAll(sessionId: string): Promise<string[]> {
    const affected: string[] = [];
    for (const [name, profile] of Object.entries(this.document.users)) {
      // Identity is the root-relative path. A stored child session id is
      // informational, so a rebound runtime cannot make this remove the wrong
      // view.
      const keptViews = profile.views.filter((view) => view.rootSessionId !== sessionId);
      const viewsChanged = keptViews.length !== profile.views.length;
      if (viewsChanged) profile.views = keptViews;
      const kept = profile.sessions.filter((s) => s.sessionId !== sessionId);
      const sessionsChanged = kept.length !== profile.sessions.length;
      if (sessionsChanged) {
        profile.sessions = kept;
        profile.order = normalizeOrder(kept, profile.order);
        profile.selectedSessionId = normalizeSelection(kept, profile.selectedSessionId);
      }
      if (viewsChanged || sessionsChanged) affected.push(name);
    }
    if (affected.length > 0) await this.persistOrLog();
    return affected;
  }

  /** Replace the user's whole chip order. Whole-order writes do not commute,
   *  so `baseVersion` must still be current: a write computed against a
   *  superseded order is refused and the caller re-reads the truth. Ids the
   *  set does not hold drop, and members the list omits append, so a reorder
   *  can never change which sessions are open. */
  async reorder(user: string, nextOrder: readonly string[], baseVersion: number): Promise<{ accepted: boolean; version: number }> {
    const profile = this.document.users[user];
    if (!profile) return { accepted: false, version: 0 };
    if (profile.orderVersion !== baseVersion) return { accepted: false, version: profile.orderVersion };
    profile.order = normalizeOrder(profile.sessions, nextOrder);
    profile.orderVersion += 1;
    await this.persistOrLog();
    return { accepted: true, version: profile.orderVersion };
  }

  /** Select one of the user's open sessions. Returns true when the selection
   *  changed. A session outside the set is ignored — the caller links first. */
  async select(user: string, sessionId: string): Promise<boolean> {
    const profile = this.document.users[user];
    if (!profile) return false;
    if (profile.selectedSessionId === sessionId) return false;
    if (!profile.sessions.some((session) => session.sessionId === sessionId)) return false;
    profile.selectedSessionId = sessionId;
    await this.persistOrLog();
    return true;
  }

  /** Alphabetical names with counts, for listusers. */
  summaries(): { name: string; sessionCount: number }[] {
    return Object.keys(this.document.users)
      .sort()
      .map((name) => ({ name, sessionCount: this.document.users[name].sessions.length }));
  }

  private ensureProfile(user: string): UserProfile {
    let profile = this.document.users[user];
    if (!profile) {
      profile = { sessions: [], views: [], order: [], selectedSessionId: null, orderVersion: 0 };
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
