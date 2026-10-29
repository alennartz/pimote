import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Type } from 'typebox';
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
  /** Present and true when this request reused an active registration. */
  alreadyHosted?: boolean;
  /** Explains that the active bundle already serves live source files. */
  message?: string;
}

/** TypeBox schema of {@link RegisterToolOutput} (the tool's outputSchema). */
export const RegisterToolOutputSchema = Type.Object({
  slug: Type.String(),
  url: Type.String(),
  alreadyHosted: Type.Optional(Type.Boolean({ description: 'True when this request reused an active registration instead of creating one.' })),
  message: Type.Optional(Type.String({ description: 'Explains the existing slug and that live source updates need no rehosting.' })),
});

/** Input to the `pimote_static_host_remove` tool. */
export interface RemoveToolInput {
  slug: string;
}

/** Output from the `pimote_static_host_remove` tool. */
export interface RemoveToolOutput {
  /** True if a registration was removed, false if the slug was unknown / not owned by this session. */
  removed: boolean;
}

/** TypeBox schema of {@link RemoveToolOutput} (the tool's outputSchema). */
export const RemoveToolOutputSchema = Type.Object({
  removed: Type.Boolean(),
});

/** Per-session deps for the tool handlers, threaded by the extension factory. */
export interface ToolDeps {
  registry: StaticHostRegistry;
  store: StaticHostStore;
  sessionId: string;
  /** Push the current panel-card snapshot for this session onto the EventBus. */
  emitPanelCards: () => void;
  /**
   * Request that the client navigate to `url`. Fired once per successful
   * `pimote_static_host` registration. Not fired on session_start replay —
   * the user only wants to be ferried over the first time a bundle is
   * registered, not every time the session reloads.
   */
  emitNavigate: (url: string) => void;
}

/** Serialize mutations that share one process-scoped static-host registry. */
const staticHostMutationQueues = new WeakMap<StaticHostRegistry, Promise<unknown>>();

/**
 * Run one complete static-host mutation after earlier mutations for this
 * registry. A rejected operation does not poison the queue for later work.
 */
export function withStaticHostMutation<T>(registry: StaticHostRegistry, operation: () => Promise<T>): Promise<T> {
  const previous = staticHostMutationQueues.get(registry) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.finally(() => {
    if (staticHostMutationQueues.get(registry) === settled) staticHostMutationQueues.delete(registry);
  });
  staticHostMutationQueues.set(registry, settled);
  return settled;
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

function statFailure(kind: 'folder' | 'index.html', path: string, error: unknown): never {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const detail = code ?? (error instanceof Error ? error.message : String(error));

  if (kind === 'folder') {
    if (code === 'ENOENT') throw new Error(`folder does not exist: ${path} (${code})`, { cause: error });
    throw new Error(`folder cannot be accessed: ${path} (${detail})`, { cause: error });
  }

  if (code === 'ENOENT') throw new Error(`folder has no index.html: ${path} (${code})`, { cause: error });
  throw new Error(`index.html cannot be accessed: ${path} (${detail})`, { cause: error });
}

/**
 * Execute the `pimote_static_host` tool body.
 *
 * Throws on validation failure (invalid slug, missing folder, no index.html).
 * On success: if the folder is already actively hosted, returns its existing
 * slug and URL without creating another registration. Otherwise it updates the
 * in-memory list for the session, atomically rewrites the persistence file,
 * calls `registry.register(...)`, and emits the panel snapshot. The complete
 * read-modify-write, registry, and emission transaction runs under the
 * process-wide registry mutation queue.
 */
export async function executeRegisterTool(input: RegisterToolInput, deps: ToolDeps): Promise<RegisterToolOutput> {
  const validSlug = validateSlug(input.slug);
  if (validSlug === null) {
    throw new Error(`invalid slug: ${JSON.stringify(input.slug)}`);
  }

  if (typeof input.folder !== 'string' || !isAbsolute(input.folder)) {
    throw new Error(`folder must be an absolute path: ${JSON.stringify(input.folder)}`);
  }
  // Normalize before stat/persist/register: a trailing slash or internal `..`
  // segment would otherwise break the http-handler's containment and
  // duplicate-folder checks.
  input.folder = resolve(input.folder);

  let folderStat;
  try {
    folderStat = await stat(input.folder);
  } catch (error) {
    statFailure('folder', input.folder, error);
  }
  if (!folderStat.isDirectory()) {
    throw new Error(`folder is not a directory: ${input.folder}`);
  }

  const indexPath = join(input.folder, 'index.html');
  let indexStat;
  try {
    indexStat = await stat(indexPath);
  } catch (error) {
    statFailure('index.html', indexPath, error);
  }
  if (!indexStat.isFile()) {
    throw new Error(`index.html is not a file: ${indexPath}`);
  }

  const cardMetadata: StaticHostStoreEntry['cardMetadata'] = {
    title: input.title,
    ...(input.tag !== undefined ? { tag: input.tag } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
  };

  return withStaticHostMutation(deps.registry, async () => {
    const active = deps.registry.findByFolderPath(input.folder);
    if (active) {
      const url = `/s/${active.slug}/`;
      return {
        slug: active.slug,
        url,
        alreadyHosted: true,
        message: `Already hosted at ${url}. The existing slug is "${active.slug}". The active bundle serves live source files and reflects edits on the next request, so no rehosting is needed.`,
      };
    }

    const resolved = resolveSlugCollision(validSlug, deps.registry);
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

    const url = `/s/${resolved}/`;
    deps.emitNavigate(url);

    return { slug: resolved, url };
  });
}

/**
 * Execute the `pimote_static_host_remove` tool body. Returns `{ removed: false }`
 * when the slug is not owned by this session. Lookup, persistence, registry,
 * and panel emission run as one process-wide registry transaction.
 */
export async function executeRemoveTool(input: RemoveToolInput, deps: ToolDeps): Promise<RemoveToolOutput> {
  return withStaticHostMutation(deps.registry, async () => {
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
  });
}
