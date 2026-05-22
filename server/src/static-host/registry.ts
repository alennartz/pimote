import type { CardColor } from '../../../shared/dist/index.js';

/** Card metadata captured at registration time and replayed on every session load. */
export interface StaticHostCardMetadata {
  title: string;
  tag?: string;
  color?: CardColor;
}

/** A single active static-host registration, owned by a pimote session. */
export interface StaticHostRegistration {
  slug: string;
  folderPath: string;
  sessionId: string;
  cardMetadata: StaticHostCardMetadata;
}

/**
 * Process-scoped registry of active static-host registrations.
 *
 * Constructed once in `server/src/index.ts`, shared by the extension factory
 * and the HTTP route handler. Slugs are globally unique within the process;
 * callers (the register tool) MUST resolve collisions before calling
 * `register()`.
 */
export interface StaticHostRegistry {
  /** Register a new bundle. Throws if `slug` is already present. */
  register(reg: StaticHostRegistration): void;

  /** Unregister by slug. No-op if absent. */
  unregister(slug: string): void;

  /** Remove every registration owned by a session. Used on extension dispose. */
  unregisterAllForSession(sessionId: string): void;

  /** Synchronous lookup for the HTTP handler. */
  lookup(slug: string): StaticHostRegistration | undefined;

  /** Test if a slug is taken. Used by collision resolution. */
  has(slug: string): boolean;

  /** Snapshot of all registrations for a session. */
  listForSession(sessionId: string): StaticHostRegistration[];
}

/**
 * Default in-memory implementation backed by a `Map<slug, StaticHostRegistration>`
 * with a secondary `Map<sessionId, Set<slug>>` for fast `unregisterAllForSession`.
 */
export class InMemoryStaticHostRegistry implements StaticHostRegistry {
  private readonly bySlug = new Map<string, StaticHostRegistration>();
  private readonly bySession = new Map<string, Set<string>>();

  register(reg: StaticHostRegistration): void {
    if (this.bySlug.has(reg.slug)) {
      throw new Error(`static-host slug already registered: ${reg.slug}`);
    }
    this.bySlug.set(reg.slug, reg);
    let set = this.bySession.get(reg.sessionId);
    if (!set) {
      set = new Set();
      this.bySession.set(reg.sessionId, set);
    }
    set.add(reg.slug);
  }

  unregister(slug: string): void {
    const entry = this.bySlug.get(slug);
    if (!entry) return;
    this.bySlug.delete(slug);
    const set = this.bySession.get(entry.sessionId);
    if (set) {
      set.delete(slug);
      if (set.size === 0) this.bySession.delete(entry.sessionId);
    }
  }

  unregisterAllForSession(sessionId: string): void {
    const set = this.bySession.get(sessionId);
    if (!set) return;
    for (const slug of set) this.bySlug.delete(slug);
    this.bySession.delete(sessionId);
  }

  lookup(slug: string): StaticHostRegistration | undefined {
    return this.bySlug.get(slug);
  }

  has(slug: string): boolean {
    return this.bySlug.has(slug);
  }

  listForSession(sessionId: string): StaticHostRegistration[] {
    const set = this.bySession.get(sessionId);
    if (!set) return [];
    const out: StaticHostRegistration[] = [];
    for (const slug of set) {
      const entry = this.bySlug.get(slug);
      if (entry) out.push(entry);
    }
    return out;
  }
}
