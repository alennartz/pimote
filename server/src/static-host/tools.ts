import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { CardColor } from '../../../shared/dist/index.js';
import type { StaticHostRegistry } from './registry.js';
import type { StaticHostStore, StaticHostStoreEntry, StaticHostStoreFile } from './store.js';

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
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateSlug(slug: string): string | null {
  if (typeof slug !== 'string') return null;
  if (slug.length === 0 || slug.length > 64) return null;
  if (!SLUG_RE.test(slug)) return null;
  return slug;
}

/**
 * Resolve a slug against the registry. Returns the input slug if it is free;
 * otherwise appends `-2`, `-3`, ... until a free slug is found.
 *
 * The caller must have already validated the input slug via `validateSlug`.
 */
export function resolveSlugCollision(slug: string, registry: StaticHostRegistry): string {
  if (!registry.has(slug)) return slug;
  for (let i = 2; ; i++) {
    const candidate = `${slug}-${i}`;
    if (!registry.has(candidate)) return candidate;
  }
}

/**
 * Execute the `pimote_static_host` tool body.
 *
 * Throws on validation failure (invalid slug, missing folder, no index.html).
 * On success: updates the in-memory list for the session, atomically rewrites
 * the persistence file, calls `registry.register(...)`, and emits the panel
 * snapshot.
 */
export async function executeRegisterTool(input: RegisterToolInput, deps: ToolDeps): Promise<RegisterToolOutput> {
  const validSlug = validateSlug(input.slug);
  if (validSlug === null) {
    throw new Error(`invalid slug: ${JSON.stringify(input.slug)}`);
  }

  if (typeof input.folder !== 'string' || !isAbsolute(input.folder)) {
    throw new Error(`folder must be an absolute path: ${JSON.stringify(input.folder)}`);
  }

  let folderStat;
  try {
    folderStat = await stat(input.folder);
  } catch {
    throw new Error(`folder does not exist: ${input.folder}`);
  }
  if (!folderStat.isDirectory()) {
    throw new Error(`folder is not a directory: ${input.folder}`);
  }

  const indexPath = join(input.folder, 'index.html');
  let indexStat;
  try {
    indexStat = await stat(indexPath);
  } catch {
    throw new Error(`folder has no index.html: ${input.folder}`);
  }
  if (!indexStat.isFile()) {
    throw new Error(`index.html is not a file: ${indexPath}`);
  }

  const resolved = resolveSlugCollision(validSlug, deps.registry);
  const cardMetadata: StaticHostStoreEntry['cardMetadata'] = {
    title: input.title,
    ...(input.tag !== undefined ? { tag: input.tag } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
  };

  const existing = (await deps.store.read(deps.sessionId)) ?? { version: 1 as const, entries: [] };
  const entries: StaticHostStoreEntry[] = [...existing.entries, { slug: resolved, folderPath: input.folder, cardMetadata }];
  const file: StaticHostStoreFile = { version: 1, entries };
  await deps.store.write(deps.sessionId, file);

  deps.registry.register({
    slug: resolved,
    folderPath: input.folder,
    sessionId: deps.sessionId,
    cardMetadata,
  });

  deps.emitPanelCards();

  return { slug: resolved, url: `/s/${resolved}/` };
}

/**
 * Execute the `pimote_static_host_remove` tool body. Returns `{ removed: false }`
 * when the slug is not owned by this session.
 */
export async function executeRemoveTool(input: RemoveToolInput, deps: ToolDeps): Promise<RemoveToolOutput> {
  const existing = deps.registry.lookup(input.slug);
  if (!existing || existing.sessionId !== deps.sessionId) {
    return { removed: false };
  }

  const file = (await deps.store.read(deps.sessionId)) ?? { version: 1 as const, entries: [] };
  const entries = file.entries.filter((e) => e.slug !== input.slug);
  await deps.store.write(deps.sessionId, { version: 1, entries });

  deps.registry.unregister(input.slug);
  deps.emitPanelCards();

  return { removed: true };
}
