import type { CardColor } from '../../../shared/dist/index.js';
import type { StaticHostRegistry } from './registry.js';
import type { StaticHostStore } from './store.js';

/** Input to the `pimote_static_host` tool. */
export interface RegisterToolInput {
  /** Required; `[a-z0-9-]+` with no leading/trailing dash; reasonable length cap (validated). */
  slug: string;
  /** Absolute path; must exist; must be a directory; must contain index.html. */
  folder: string;
  /** Panel card title. */
  title: string;
  tag?: string;
  color?: CardColor;
}

/** Successful output from the `pimote_static_host` tool. */
export interface RegisterToolOutput {
  /** Resolved slug (may differ from input if collision-suffixed `-2`, `-3`, ...). */
  slug: string;
  /** `/s/<resolved-slug>/`. */
  url: string;
}

/** Input to the `pimote_static_host_remove` tool. */
export interface RemoveToolInput {
  slug: string;
}

/** Output from the `pimote_static_host_remove` tool. */
export interface RemoveToolOutput {
  /** True if a registration was removed, false if the slug was unknown / not owned by this session. */
  removed: boolean;
}

/** Per-session deps for the tool handlers, threaded by the extension factory. */
export interface ToolDeps {
  registry: StaticHostRegistry;
  store: StaticHostStore;
  sessionId: string;
  /** Push the current panel-card snapshot for this session onto the EventBus. */
  emitPanelCards: () => void;
}

/**
 * Validates and normalises a slug.
 *
 * Rules: lowercase alphanumerics and hyphens, no leading/trailing dash,
 * non-empty, and a reasonable length cap (<= 64).
 *
 * Returns `null` if invalid.
 */
export function validateSlug(_slug: string): string | null {
  throw new Error('not implemented');
}

/**
 * Resolve a slug against the registry. Returns the input slug if it is free;
 * otherwise appends `-2`, `-3`, ... until a free slug is found.
 *
 * The caller must have already validated the input slug via `validateSlug`.
 */
export function resolveSlugCollision(_slug: string, _registry: StaticHostRegistry): string {
  throw new Error('not implemented');
}

/**
 * Execute the `pimote_static_host` tool body.
 *
 * Throws on validation failure (invalid slug, missing folder, no index.html).
 * On success: updates the in-memory list for the session, atomically rewrites
 * the persistence file, calls `registry.register(...)`, and emits the panel
 * snapshot.
 */
export async function executeRegisterTool(_input: RegisterToolInput, _deps: ToolDeps): Promise<RegisterToolOutput> {
  throw new Error('not implemented');
}

/**
 * Execute the `pimote_static_host_remove` tool body. Returns `{ removed: false }`
 * when the slug is not owned by this session.
 */
export async function executeRemoveTool(_input: RemoveToolInput, _deps: ToolDeps): Promise<RemoveToolOutput> {
  throw new Error('not implemented');
}
