# Plan: Static Resources

## Context

Let pimote serve arbitrary static HTML/asset bundles from local disk at `/s/<slug>/` so agents can produce reports, previews, or visualizations and surface them to the user as tappable panel cards. The hosting and its card share a single lifecycle owned by a new pi extension on the server. See `docs/brainstorms/static-resources.md`.

## Architecture

### Impacted Modules

- **Server.** Gains:
  - A new HTTP route prefix `/s/<slug>/*` slotted into `server.ts` between the existing static-asset lookup and the SPA fallback. Unknown slug returns 404 (does not fall through to SPA shell). Path normalisation + traversal prevention. MIME-by-extension. Directory paths resolve to `index.html`.
  - A new `StaticHostRegistry` singleton constructed once in `index.ts`, owned for the process lifetime, passed by closure to both the `PimoteSessionManager` (so it can build the static-host extension factory) and `createServer()` (so the HTTP handler can use it).
  - Boot-time GC sweep of `${PIMOTE_STATE_DIR}/static-host/` against the set of sessionIds known to `FolderIndex`. Runs after `FolderIndex` is initialised and before the HTTP server starts accepting connections.
  - A new `PIMOTE_STATIC_HOST_DIR` constant in `paths.ts`.
  - `PimoteSessionManager` threads the static-host extension factory into pi sessions via `resourceLoaderOptions.extensionFactories`, sibling to the existing voice factory. Unlike voice, this factory is always enabled (no config gate).
- **Protocol.** `Card` gains an optional `href?: string` field.
- **Panels (`@pimote/panels`).** `Card` in `packages/panels/src/types.ts` gains the same `href?: string` field. The two `Card` types are independent (separately published) but must stay in lock-step.
- **Client.** `Panel.svelte` renders a card whose root element is an `<a href={card.href}>` when `href` is present, with pointer cursor on hover. Same-tab navigation. The service worker (`client/src/sw.ts`) must let `/s/*` requests bypass caching and SPA-shell fallback — go to network unmodified.

### New Modules

- **Static Host (`server/src/static-host/`).** In-server pi extension plus supporting pieces. Internal to `@pimote/server`, not a published package — same model as `server/src/voice/`.

  **Responsibilities:**
  - Defines the `StaticHostRegistry` interface and a default in-memory implementation backed by a `Map<slug, StaticHostRegistration>` with secondary indexing by sessionId.
  - Provides an `ExtensionFactory` that registers two tools (`pimote_static_host`, `pimote_static_host_remove`) into each pi session's tool list, scoped to that session by capturing the sessionId at factory-invocation time.
  - On extension boot for a session: reads `${PIMOTE_STATE_DIR}/static-host/<sessionId>.json` if present, replays each entry into the registry, and emits a panel card per entry on the `pimote:panels` channel.
  - On extension dispose: calls `registry.unregisterAllForSession(sessionId)`. The persistence file is left on disk for the next session load.
  - Owns the HTTP route handler function called from `server.ts`. Pure file-streaming given a registration lookup; no session-state knowledge.
  - Owns the boot-time GC function.

  **Dependencies:** pi SDK (`ExtensionAPI`, `ExtensionFactory`), Protocol (`Card`, `CardColor`), Server (lives inside it; uses `paths.ts` constants).

  **Approximate location:**
  - `server/src/static-host/index.ts` — extension factory, public exports.
  - `server/src/static-host/registry.ts` — `StaticHostRegistry` interface + default implementation.
  - `server/src/static-host/store.ts` — atomic per-session JSON persistence (read, write, delete).
  - `server/src/static-host/http-handler.ts` — `/s/<slug>/*` request handler.
  - `server/src/static-host/gc.ts` — boot-time GC sweep.
  - `server/src/static-host/tools.ts` — tool implementations (register, unregister), including slug validation + collision resolution.
  - Plus `*.test.ts` files alongside.

### Interfaces

#### `Card` (both protocol and panels)

```ts
interface Card {
  id: string;
  color?: CardColor;
  header: { title: string; tag?: string };
  body?: BodySection[];
  footer?: string[];
  href?: string; // NEW. If set, the whole card is a clickable same-tab link.
  // No validation server-side; any string is allowed.
}
```

Behaviour:

- Client renders card root as `<a href={card.href}>` when `href` is set, otherwise as a plain block.
- No `target`, no `rel` — same-tab, same-origin assumption.

#### `StaticHostRegistry`

Process-scoped singleton. Constructed once in `server/src/index.ts`, shared by extension factory and HTTP handler.

```ts
interface StaticHostRegistration {
  slug: string;
  folderPath: string;
  sessionId: string;
  cardMetadata: {
    title: string;
    tag?: string;
    color?: CardColor;
  };
}

interface StaticHostRegistry {
  /** Register a new bundle. Throws if slug is already present (callers
   *  must resolve collisions before calling). */
  register(reg: StaticHostRegistration): void;

  /** Unregister by slug. No-op if absent. */
  unregister(slug: string): void;

  /** Remove every registration owned by a session. Used on extension dispose. */
  unregisterAllForSession(sessionId: string): void;

  /** Synchronous lookup for the HTTP handler. */
  lookup(slug: string): StaticHostRegistration | undefined;

  /** Test if a slug is taken. Used by collision resolution. */
  has(slug: string): boolean;

  /** Snapshot of all registrations for a session (for diagnostics / future use). */
  listForSession(sessionId: string): StaticHostRegistration[];
}
```

Contracts:

- Synchronous everywhere. HTTP handler calls `lookup` per request and must not block.
- Registrations are flat across sessions; slugs are globally unique within the process.

#### Persistence store

```ts
interface StaticHostStoreEntry {
  slug: string;
  folderPath: string;
  cardMetadata: { title: string; tag?: string; color?: CardColor };
}

interface StaticHostStoreFile {
  version: 1;
  entries: StaticHostStoreEntry[];
}

interface StaticHostStore {
  /** Read state for a session, or undefined if no file exists. */
  read(sessionId: string): Promise<StaticHostStoreFile | undefined>;
  /** Atomically write state (tmp + rename, same pattern as session-metadata.ts). */
  write(sessionId: string, file: StaticHostStoreFile): Promise<void>;
  /** Delete the file for a session. No-op if absent. */
  remove(sessionId: string): Promise<void>;
}
```

#### Boot-time GC

```ts
async function gcStaticHostStore(args: { storeDir: string; validSessionIds: Set<string> }): Promise<void>;
```

Reads `storeDir`, deletes any `<sessionId>.json` whose sessionId is not in `validSessionIds`. Returns when done. No knowledge of registry / extension / HTTP.

Called from `server/src/index.ts` after `FolderIndex` initialisation, before `createServer()` is awaited / starts listening.

#### Tools registered with the agent

Note on slug origin: the brainstorm left slug format as an open question (random / derived / hybrid). The decision landed during architecting on **agent-supplied slug with server-side collision resolution** — the agent picks a human-meaningful slug, the server only mutates it on collision. This gives readable URLs in dev/logs without escaping or disambiguation logic in the path-derived case.

```ts
// Tool 1 — register a bundle.
name: "pimote_static_host"
input: {
  slug: string;        // required; [a-z0-9-]+ with no leading/trailing dash; reasonable length cap
  folder: string;      // absolute path; must exist; must be a directory; must contain index.html
  title: string;       // panel card title
  tag?: string;        // optional card tag
  color?: CardColor;   // optional card color
}
output: {
  slug: string;        // resolved (may differ from input if collision-suffixed)
  url: string;         // "/s/<resolved-slug>/"
}

// Tool 2 — unregister.
name: "pimote_static_host_remove"
input: { slug: string }
output: { removed: boolean }
```

**Tool description text for `pimote_static_host`.** The tool ships with substantive prompt guidance attached as its description (visible to the model in the system prompt's tool listing). The text must cover: the two primary use cases (rich reports and ad-hoc interactive tools), the mandatory responsive-layout rule with explicit mobile + desktop breakpoints, the no-secrets-in-bundle rule, and a brief workflow note. If long enough to warrant its own file, lives at `server/src/static-host/prompt.ts`. Verbatim draft text:

> Host a static HTML/asset bundle from a local folder so the user can view it in their browser. Returns a URL and creates a tappable card in the user's session pointing at the bundle.
>
> **When to use this:**
>
> 1. **On-the-fly reports and visualisations.** Reach for this whenever you need to present information that would benefit from richer formatting than plain markdown — charts, comparison tables across many dimensions, syntax-highlighted code walkthroughs, before/after diffs, navigable trees of nested structures. A well-designed HTML report is much easier to read and navigate than a wall of markdown in the chat.
> 2. **Ad-hoc interactive tools.** Small single-purpose tools the user can play with for a little while — calculators, form-driven explorers, lightweight UIs that call external APIs via embedded JavaScript, in-memory data playgrounds, anything where interactivity adds value beyond static text. The bundle is real same-origin JS; it can fetch, do DOM things, persist to localStorage, whatever. Use this when the user needs a temporary tool tailored to the task at hand rather than a hand-rolled answer.
>
> **Mandatory: responsive, mobile-and-desktop layout.** Always design the bundle to work equally well on both desktop and mobile form factors. The user may view the same report on either device — even the same report on both. Use fluid layouts, relative units, and media queries. Mentally test your layout at ~360px wide and ~1440px wide before considering it done.
>
> **No secrets in the bundle.** Bundle files are served verbatim to the browser. Do not embed API keys, tokens, or any other credentials, and do not build bundles that depend on calling services that require them — there is no secret-management story for static-hosted bundles. Stick to public endpoints, in-memory state, and APIs that work without auth.
>
> **Workflow.** Generate the bundle (with at minimum an `index.html`) in a folder, then call this tool with the folder's absolute path, a short descriptive slug, and a title for the card. The user sees a card in their session; tapping it navigates them to the bundle, and browser-back returns them to the main pimote UI.

Server-side behaviour:

- Validate `slug` shape, `folder` existence/type/index.html.
- Collision resolution: if requested slug is free → use as-is; otherwise append `-2`, `-3`, ... until free.
- On success: update in-memory list for the session, atomically rewrite persistence file, call `registry.register(...)`, push refreshed panel cards (one per current entry) on the `pimote:panels` channel.
- `pimote_static_host_remove`: mirror — remove from in-memory list, rewrite file, `registry.unregister(slug)`, push refreshed cards. `removed: false` if slug isn't owned by this session.

#### HTTP route

Slotted into `server.ts` between the static-file lookup and SPA fallback:

```ts
async function serveStaticHostRoute(req: http.IncomingMessage, res: http.ServerResponse, registry: StaticHostRegistry): Promise<boolean>; // true if handled, false to fall through (only on prefix mismatch)
```

- Match prefix `/s/<slug>/`. On miss → `return false` (fall through to SPA fallback).
- `registry.lookup(slug)` — undefined → respond 404, return true. **Does not fall through to SPA.**
- Resolve remainder against `folderPath`. Normalise. Reject any resolved path that escapes `folderPath` (defence against `..` traversal).
- If resolved path is a directory → append `index.html`.
- Stat the file. Missing → 404. Set `Content-Type` from extension. Stream to response. No-cache headers (these are ephemeral artifacts; we don't want the browser pinning a stale bundle after slug reuse).

**Auth posture.** Pimote has no application-level HTTP auth — per DR-017, auth is handled at the network layer by whatever the operator deploys (reverse proxy, mTLS, VPN, etc.). The `/s/*` route inherits this exact posture; it adds no app-level auth and needs no special treatment. This matches the brainstorm's "same auth as the rest of pimote" intent and is consistent with the accepted same-origin threat model ("user's own trusted agent on user's own machine").

#### Lifecycle summary

```
boot:
  ensure dirs
  init FolderIndex
  gcStaticHostStore({ storeDir, validSessionIds: folderIndex.sessionIds })
  registry = new StaticHostRegistry()
  sessionManager = new PimoteSessionManager({ ..., staticHostFactory(registry) })
  server = await createServer({ ..., staticHostRegistry: registry })
  server.listen()

session load (extension factory invoked for sessionId S):
  state = store.read(S)
  for each entry in state.entries:
    registry.register({ ...entry, sessionId: S })
  emit pimote:panels cards for all entries

tool: pimote_static_host (in session S):
  validate slug, folder
  resolvedSlug = resolveCollision(slug, registry)
  in-memory list += entry
  await store.write(S, { version: 1, entries: list })
  registry.register({ slug: resolvedSlug, ..., sessionId: S })
  emit pimote:panels cards
  return { slug: resolvedSlug, url: `/s/${resolvedSlug}/` }

tool: pimote_static_host_remove (in session S):
  if slug owned by S:
    in-memory list -= entry
    await store.write(S, ...)
    registry.unregister(slug)
    emit pimote:panels cards
    return { removed: true }
  else:
    return { removed: false }

extension dispose (session S evicted from memory):
  registry.unregisterAllForSession(S)
  // store file stays on disk

HTTP GET /s/<slug>/<path>:
  reg = registry.lookup(slug)
  if !reg: 404
  resolve+normalise path inside reg.folderPath
  stream file (or 404)
```

## Technology Choices

No new dependencies. Everything uses Node built-ins (`node:fs/promises`, `node:path`, `node:http`, `node:crypto` for nothing — slug comes from the agent). MIME detection: use the existing approach in `serveStatic` (read `server/src/server.ts` to confirm and align).

## Tests

**Pre-test-write commit:** `c2492401cd57ac2a95b12c073eb979b1a5c70749`

### Interface Files

- `shared/src/protocol.ts` — added optional `href?: string` to `Card`.
- `packages/panels/src/types.ts` — added optional `href?: string` to `Card` (kept in lock-step with protocol).
- `server/src/paths.ts` — added `PIMOTE_STATIC_HOST_DIR` constant.
- `server/src/static-host/registry.ts` — `StaticHostRegistration`, `StaticHostCardMetadata`, `StaticHostRegistry` interface, `InMemoryStaticHostRegistry` class (stubbed).
- `server/src/static-host/store.ts` — `StaticHostStoreEntry`, `StaticHostStoreFile`, `StaticHostStore` interface, `FileStaticHostStore` class (stubbed).
- `server/src/static-host/gc.ts` — `gcStaticHostStore({ storeDir, validSessionIds })` boot-time GC function (stubbed).
- `server/src/static-host/http-handler.ts` — `serveStaticHostRoute(req, res, registry)` HTTP route handler (stubbed).
- `server/src/static-host/tools.ts` — `RegisterToolInput/Output`, `RemoveToolInput/Output`, `ToolDeps`, `validateSlug`, `resolveSlugCollision`, `executeRegisterTool`, `executeRemoveTool` (stubbed).
- `server/src/static-host/index.ts` — public exports, `CreateStaticHostExtensionOptions`, `createStaticHostExtension(opts)` extension factory builder (stubbed).

### Test Files

- `server/src/static-host/registry.test.ts` — behavior of the in-memory registry: register/lookup/has/unregister, dup-throw, per-session removal, list-by-session.
- `server/src/static-host/store.test.ts` — file-store round-trip, overwrite, dir-auto-create, atomic write (no `.tmp` leak), remove (existing + missing), corrupt-JSON rejection, per-session file naming.
- `server/src/static-host/gc.test.ts` — GC deletes orphan files, keeps live ones, tolerates missing dir, leaves unrelated files alone.
- `server/src/static-host/tools.test.ts` — slug validation, collision resolution, register success path (registry + store + panel emit + url shape), validation failures (bad slug, missing folder, no index.html), remove (owned / unknown / cross-session).
- `server/src/static-host/http-handler.test.ts` — index.html serving, nested asset MIME, subdirectory → index.html, unknown-slug 404 (no fall-through), prefix-mismatch fall-through, missing file 404, traversal rejection, no-cache headers.
- `server/src/static-host/index.test.ts` — extension factory wiring against a fake `ExtensionAPI`: tool registration, register-tool description content, session_start replay, register/remove tool happy paths emit panel cards with `href`, session_shutdown releases the session, persistence file survives shutdown.

### Behaviors Covered

#### `Card.href` (protocol + panels)

- `href` is an optional string field on both `Card` types; existing consumers that don't set it continue to compile.

#### `InMemoryStaticHostRegistry`

- Registering a slug makes it retrievable via `lookup` and `has`.
- Unknown slugs are absent from `lookup` and `has`.
- Registering a duplicate slug throws.
- A slug can be re-registered after `unregister`.
- `unregister` removes a registration; unknown slugs are a no-op.
- `unregisterAllForSession` removes every registration owned by that session and only those.
- `listForSession` returns the full set owned by a session, or `[]` for unknown sessions.

#### `FileStaticHostStore`

- `read` returns `undefined` when no file exists for the session.
- `write` then `read` round-trips entries verbatim, including optional `tag`/`color`.
- `write` overwrites prior state for the same session.
- `write` creates the storage directory tree if missing.
- `write` is atomic — no `.tmp` siblings remain after a successful write.
- `remove` deletes an existing file; missing files are a no-op.
- `read` of a corrupt JSON file rejects rather than silently returning data.
- Files are stored one-per-session as `<sessionId>.json`.

#### `gcStaticHostStore`

- Deletes `<sessionId>.json` files whose sessionId is not in `validSessionIds`.
- Keeps files whose sessionId is in `validSessionIds`.
- Tolerates a missing store directory (no throw, no work).
- Empty `validSessionIds` deletes every json file.
- Leaves unrelated non-json files (and subdirectories) alone.

#### Tools — `validateSlug` / `resolveSlugCollision`

- Accepts lowercase alphanumeric + hyphen slugs without leading/trailing dashes.
- Rejects empty strings, leading/trailing dashes, uppercase, whitespace, path separators, dots, non-ASCII, and over-length slugs.
- `resolveSlugCollision` returns the input slug when free; otherwise appends `-2`, `-3`, ... until free.

#### Tools — `executeRegisterTool`

- Valid input registers the bundle, persists it to the per-session store, emits a panel-card snapshot, and returns `{ slug, url: "/s/<slug>/" }`.
- `cardMetadata` (including optional `tag`/`color`) is persisted as provided.
- Slug collisions are resolved before registering — the returned `slug` reflects the suffixed value.
- Rejects invalid slugs, missing folders, and folders without `index.html`.
- A validation failure does not mutate the registry, the store, or emit a panel update.

#### Tools — `executeRemoveTool`

- Removing an entry owned by the session reports `removed: true`, drops it from the registry, persists the new state, and re-emits the panel snapshot.
- Returns `removed: false` for unknown slugs.
- Returns `removed: false` for slugs owned by a different session, and does not mutate the registration.

#### `serveStaticHostRoute`

- `/s/<slug>/` serves the bundle's `index.html` with an HTML content-type.
- Nested asset requests are served with content-type inferred from the file extension.
- A request whose path resolves to a subdirectory is served the subdirectory's `index.html`.
- Unknown slugs return 404 and the handler reports "handled" (does NOT fall through to the SPA).
- Paths that don't match the `/s/<slug>/` prefix return "not handled" (caller falls through).
- Missing files inside a registered bundle return 404.
- Path-traversal attempts that resolve outside the bundle folder return 404 and never expose external content.
- Successful responses set a no-cache `Cache-Control` header.

#### `createStaticHostExtension`

- Registers exactly two tools: `pimote_static_host` and `pimote_static_host_remove`.
- The register tool carries a substantive description covering responsive layout and the no-secrets rule.
- On `session_start`, replays persisted entries for the session into the registry and emits a panel-card snapshot.
- On `session_start` with no persisted file, completes without error and leaves the registry untouched.
- The register tool registers, persists, and emits a panel card whose `href` matches `/s/<slug>/`.
- The remove tool unregisters, persists the new state, and re-emits the panel snapshot.
- On `session_shutdown`, releases every registration owned by the session.
- On `session_shutdown`, the persistence file is left on disk for the next session load to replay.
