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

  register(_reg: StaticHostRegistration): void {
    throw new Error('not implemented');
  }

  unregister(_slug: string): void {
    throw new Error('not implemented');
  }

  unregisterAllForSession(_sessionId: string): void {
    throw new Error('not implemented');
  }

  lookup(_slug: string): StaticHostRegistration | undefined {
    throw new Error('not implemented');
  }

  has(_slug: string): boolean {
    throw new Error('not implemented');
  }

  listForSession(_sessionId: string): StaticHostRegistration[] {
    throw new Error('not implemented');
  }
}
