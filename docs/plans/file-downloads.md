# Plan: File Downloads

## Context

Build a PWA-only way for an agent to make a project file available as a native, user-approved browser download. The settled product direction is captured in [the brainstorm](../brainstorms/file-downloads.md): downloads are live, single-use, session-scoped registrations rather than copied assets or a general transfer system.

## Architecture

### Impacted Modules

#### Server

The Server gains a process-lifetime download manager, a `/d/<opaque-id>` HTTP route, and a per-session persistence directory. `server/src/index.ts` bootstraps the manager alongside static hosting, runs orphan GC against known session IDs, and threads the download extension factory into every pi session. `server/src/server.ts` delegates matching `GET` requests to the download route before SPA fallback.

`PimoteSessionManager` gains a download EventBus listener and session-local download snapshot state, parallel to—but independent from—panel state. It forwards full snapshots to the current slot owner on live updates and on all state-recovery paths: full resync, incremental reconnect, viewed-session changes, and ownership transfer. A slot has only one current owner, so a direct-link redemption notifies that owner only; no multi-browser fan-out is introduced.

The route is the only consumer of an opaque registration. It uses a native attachment response (`Content-Disposition: attachment`) and streams the live file. It never moves or deletes the source file. Existing Cloudflare Tunnel / edge access authentication remains the access boundary: an unused copied URL is intentionally redeemable from any browser or device that can pass that edge access, while the first request consumes it. The opaque ID is a single-use capability, not a browser- or session-bound authorization mechanism.

#### Static Host Extension

Static hosting retains ownership of its bundle registry, route, and panel lifecycle under DR-026. Its feature-specific persistence adapter moves onto a shared per-session JSON-storage module, but it does not share a registry, EventBus channel, route handler, or UI contract with downloads.

#### Protocol

The shared protocol adds a typed session event for download snapshots. The event is distinct from `panel_update` and contains no server filesystem path. It becomes part of the normal server-to-client event union and client session-event reducer.

#### Client

The Client stores pending download snapshots per active session in `SessionRegistry`. A new download UI module presents:

- an immediate, actionable in-app toast for a newly offered file;
- a session-local fallback inbox for missed or multiple pending files;
- no global download aggregate and no Android-client surface.

The normal case is one click: the toast action is a native same-origin link to the one-shot route. The fallback inbox is a compact Downloads dropdown in the desktop `StatusBar` and a conditional control in the currently viewed mobile session header. It is intentionally visible only for the viewed session.

The service worker and push infrastructure add download notifications using the existing VAPID flow from DR-002. A background notification opens the owning session and its fallback inbox; it never follows the one-shot URL itself. Focused-client handling deduplicates the push notice against the live download event so a new offer produces one visible in-app prompt.

#### Paths and Push Notifications

`server/src/paths.ts` gains a dedicated download-state directory, separate from static-host state. The existing push payload gains a `download` reason carrying only presentation metadata needed to identify the offered file and open its session; it does not carry the opaque download URL.

### New Modules

#### Per-session JSON storage

A common Server module, approximately `server/src/session-json-store.ts`, owns atomic JSON read/write/remove and boot-time orphan collection for state files keyed by session ID. It is a deep module: callers supply a directory and typed document shape, while it hides temporary-file replacement, missing-file behavior, corrupt-document handling, and stale temporary-file cleanup.

Static hosting and downloads are its two real adapters. Each retains a separate directory and feature-specific persisted document; the common module does not understand slugs, paths, downloads, panels, or HTTP.

#### File-download extension and manager

A new `server/src/file-download/` module owns the feature. Its external seam is a `DownloadManager` that concentrates persistence, active registration lookup, lifecycle replay, ownership checks, and atomic consumption behind a small interface. The pi extension is a thin adapter: it obtains `ctx.sessionManager.getSessionId()` and `ctx.cwd`, calls the manager, and publishes its snapshots onto a dedicated EventBus channel. The HTTP route is another thin adapter over the same manager.

The module also owns its model-facing tool descriptions, download route handler, source-path validation, persisted document types, and test seams. It does not depend on client components or panel cards.

#### Client download UI

New Client modules, approximately a download store/coordinator plus `DownloadInbox` and `DownloadToast` components, own presentation and native-link invocation. They consume typed protocol state rather than infer downloads from tool-call rendering or panel cards. A small notification-intent coordinator owns the existing-session versus adopt-then-open split, so an OS download notification can open the owning session's local inbox without following its one-shot link. A service-worker push-planning seam chooses no visible action for a focused client (the live event already toasts) and an OS notification carrying only session/inbox intent for a background client.

### Interfaces

#### Common session persistence seam

```ts
interface SessionJsonStore<TDocument> {
  read(sessionId: string): Promise<TDocument | undefined>;
  write(sessionId: string, document: TDocument): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

function gcSessionJsonStore(args: { storeDir: string; validSessionIds: Set<string> }): Promise<void>;
```

`write` is atomic: once it resolves, a restart sees either the prior complete document or the new complete document, never a partial one. `gcSessionJsonStore` removes state for sessions absent from the boot-time allow-list and cleans abandoned temporary files. A failed session enumeration skips GC rather than treating every record as orphaned.

#### Download registration and snapshot contract

```ts
type DownloadUpdateCause = 'offered' | 'restored' | 'consumed' | 'revoked';

interface DownloadItem {
  id: string; // Server-generated opaque, high-entropy identifier.
  filename: string; // Derived from the validated source path.
  sizeBytes: number; // Captured when the file was offered; informational only.
  href: string; // One-shot same-origin route, e.g. `/d/<id>`.
}

interface DownloadOfferedUpdateEvent {
  type: 'download_update';
  sessionId: string;
  cause: 'offered';
  /** Identifies the newly offered member of this full snapshot. */
  offeredDownloadId: string;
  downloads: DownloadItem[];
}

interface DownloadSnapshotUpdateEvent {
  type: 'download_update';
  sessionId: string;
  cause: Exclude<DownloadUpdateCause, 'offered'>;
  downloads: DownloadItem[];
}

type DownloadUpdateEvent = DownloadOfferedUpdateEvent | DownloadSnapshotUpdateEvent;
```

The client receives no absolute path, workspace root, or server-only source metadata. Every event carries a full replacement snapshot, but only `offered` also carries `offeredDownloadId`; the toast coordinator finds that exact item rather than depending on snapshot ordering. `restored`, `consumed`, and `revoked` replace state without a new toast. `sizeBytes` is deliberately not refreshed when the source changes because the registration is live, not a snapshot.

#### Download manager seam

```ts
interface OfferDownloadInput {
  sessionId: string;
  workspaceRoot: string; // `ctx.cwd` captured at offer time.
  path: string; // Relative to workspaceRoot, or absolute within it.
}

interface DownloadClaim {
  sessionId: string;
  sourcePath: string; // Server-only; never crosses the protocol seam.
  workspaceRoot: string; // Captured root used for click-time validation.
  filename: string;
}

interface DownloadManager {
  activate(sessionId: string, publish: (update: DownloadUpdateEvent) => void): Promise<void>;
  deactivate(sessionId: string): void;
  offer(input: OfferDownloadInput): Promise<DownloadItem>;
  cancel(sessionId: string, id: string): Promise<{ cancelled: boolean }>;
  claim(id: string): Promise<DownloadClaim | undefined>;
  snapshot(sessionId: string): DownloadItem[];
}
```

`activate` rehydrates the session's persisted registrations into the process registry and publishes a `restored` full snapshot. `deactivate` removes only active process/publisher state; it leaves persistence intact so a later session load can restore it. Session IDs are the persistence key: ownership transfer preserves registrations, while `/new`, forks, and session replacement do not migrate them.

`offer` validates the file before persisting it: the source must be a regular file, and its resolved real path must remain within the resolved workspace root. Relative paths resolve from the captured root. An absolute path is valid only when it is contained by that root. The manager persists the lexical source path, captured root, derived filename, initial size, and opaque ID.

`cancel` succeeds only for a registration owned by the requesting session. It removes the persistent and in-memory entry and publishes a `revoked` snapshot. It never touches the source file.

`claim` is the single-use authorization operation. It synchronously reserves the ID against concurrent requests, durably removes it from the session document, removes it from the active registry, and publishes `consumed` before resolving its server-only claim. If durable removal cannot complete, `claim` rejects; the HTTP route returns a generic `500` without opening or streaming the source. Once `claim` resolves, no later browser can obtain the file with that ID, even if streaming later fails.

#### Agent tools

```ts
pimote_send_file({ path: string })
  -> { id: string; filename: string; sizeBytes: number }

pimote_cancel_file_send({ id: string })
  -> { cancelled: boolean }
```

`pimote_send_file` returns after registration; it never waits for a user click or download completion. Its description tells the model that it creates a user-approved native download and that the source must remain available until the user acts. It accepts only `path`; filename and size are server-derived to prevent misleading presentation metadata.

#### HTTP download route

```ts
serveFileDownloadRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  downloads: DownloadManager,
): Promise<boolean>
```

The route recognizes only the download `GET` path and returns whether it handled the request. It calls `claim` before checking or opening the live source. An unknown or already-consumed ID returns no file. A claimed source that is missing, non-regular, or whose current real path escapes its captured workspace root returns a normal HTTP error and remains consumed; v1 deliberately adds no iframe containment or custom client failure toast.

For a valid source, the route streams a native attachment with the registration-time filename, no-cache headers, and safe content-disposition encoding. It is not a static asset route, does not permit path segments from the request to select files, and has no directory behavior.

#### EventBus, Server state, and push contract

The extension emits full download snapshots on a dedicated `pimote:downloads` EventBus channel. `PimoteSessionManager` stores the current snapshot in `SessionState`, routes it as `download_update` only to the current slot owner, and sends a silent `restored` snapshot after every recovery boundary: full resync, incremental reconnect, viewed-session change, and ownership takeover. `/new`, fork, and replacement construct a fresh session state with no migrated registrations. This gives direct HTTP consumption a way to remove a pending item from the current owner's PWA without coupling the route to client code.

Server boot creates one download manager/store/extension factory, skips its orphan GC when session enumeration fails, threads the factory into every pi session, and mounts the manager's `/d/<id>` route before SPA fallback. On an `offered` update, the server also sends the existing VAPID push notification with a download-specific reason and `{ downloadId, filename, sizeBytes }` presentation data; it never includes the one-shot href. The service worker uses its established focus policy: a focused client receives no extra download prompt because the live `download_update` already produced the actionable toast, while a background client receives an OS notification. That notification carries an `openDownloads` intent only; tapping it opens/adopts the owning session and then its session-local fallback inbox, without consuming a link.

#### Delivery, bootstrap, and notification seams

```ts
interface DownloadEventBus {
  on(type: 'pimote:downloads', listener: (update: unknown) => void | Promise<void>): () => void;
}

interface RouteSlotDownloadUpdateOptions {
  sessionId: string;
  folderPath: string;
  sessionName?: string;
  state: { downloads: DownloadItem[] };
  send(event: DownloadUpdateEvent): void;
  notify(payload: PushNotificationPayload): Promise<void>;
}

function setupSlotDownloadListener(eventBus: DownloadEventBus, options: RouteSlotDownloadUpdateOptions): () => void;

function routeSlotDownloadUpdate(update: DownloadUpdateEvent, options: RouteSlotDownloadUpdateOptions): Promise<void>;

function makeDownloadSnapshot(sessionId: string, downloads: DownloadItem[]): DownloadSnapshotUpdateEvent;

interface FileDownloadBootstrap {
  manager: DownloadManager;
  extensionFactory: ExtensionFactory;
}

function bootstrapFileDownloads(args: { storeDir: string; validSessionIds: Set<string> | null }): Promise<FileDownloadBootstrap>;

interface DownloadNotificationIntent {
  sessionId: string;
  folderPath?: string;
  openDownloads: true;
}

interface NotificationSessionPort {
  hasSession(sessionId: string): boolean;
  switchToSession(sessionId: string): void;
  openExistingSession(sessionId: string, folderPath: string): Promise<boolean>;
  openDownloadInbox(sessionId: string): void;
}

function handleDownloadNotificationIntent(intent: DownloadNotificationIntent, port: NotificationSessionPort): Promise<void>;
```

`routeSlotDownloadUpdate` is the EventBus-to-owner boundary: it replaces state and sends exactly one wire event to the owner, then sends VAPID only for an offered item resolved through `offeredDownloadId`. `makeDownloadSnapshot` is the silent recovery/view handoff. `bootstrapFileDownloads` is the index boot boundary and is dependency-injectable in tests so GC/factory ownership is observable without booting pi. The notification port makes the async adopt-before-open ordering explicit.

A client download coordinator consumes post-reducer updates and calls the toast presentation seam only for the offered item. The service-worker push planner consumes only download presentation metadata and returns either no focused-client delivery or a background OS notification whose click data is `DownloadNotificationIntent`.

#### Client state and interaction contract

Each per-session client state gains `downloads: DownloadItem[]`. A `download_update` fully replaces that session's list; the client does not merge or persist it independently of the server. The registry forwards the typed update to the download coordinator after reducing it. The viewed session's fallback inbox reads only its own list.

For `cause: 'offered'`, the coordinator finds `offeredDownloadId` in the snapshot and shows one toast containing that file's filename and formatted initial size. Its primary Download action is a native `<a href={item.href}>` attachment request, so the usual case is one explicit user click from notification to browser download. The fallback inbox renders the same native links for pending items after the toast is missed or more than one file is available. A notification-click coordinator switches an already-open session or awaits adoption of a closed one before opening that same session's inbox. No click automatically follows an URL, including a system-notification click.

## Tests

**Pre-test-write commit:** `1ae92c102105a0a8359fd5fd6fd29985c5823574`

### Interface Files

- `shared/src/protocol.ts` — `DownloadUpdateCause`, `DownloadItem`, and discriminated `DownloadUpdateEvent` wire contracts (`offeredDownloadId` on offers only), included in `PimoteEvent`.
- `server/src/session-json-store.ts` — generic per-session JSON persistence seam, filesystem adapter boundary, and orphan-GC contract.
- `server/src/file-download/manager.ts` — persisted registration shapes, `DownloadManager` lifecycle/offer/cancel/claim seam (including durable-failure rejection), and factory boundary.
- `server/src/file-download/tools.ts` — send/cancel tool input/output contracts and adapter boundaries.
- `server/src/file-download/prompt.ts` — model-facing tool description boundary.
- `server/src/file-download/index.ts` — extension-factory boundary and public file-download exports.
- `server/src/file-download/http-handler.ts` — one-shot attachment route boundary.
- `server/src/file-download/bootstrap.ts` — process-lifetime manager/store/factory boot seam with injectable GC dependencies.
- `server/src/server.ts` — `/d` route injection/mount boundary before SPA fallback.
- `server/src/session-manager.ts` — session-local pending-download state plus EventBus-to-owner routing and silent snapshot seams.
- `server/src/push-notification.ts` — download push reason and presentation-only metadata shape.
- `client/src/lib/stores/session-registry.svelte.ts` — per-session pending-download state, reducer, and post-reducer coordinator callback boundary.
- `client/src/lib/stores/connection.svelte.ts` — notification-driven pending-adopt `openDownloads` intent handoff.
- `client/src/lib/download-presentation.ts` — toast and viewed-session inbox presentation seams, including registration-size formatting.
- `client/src/lib/download-coordinator.ts` — typed update-to-toast coordinator boundary.
- `client/src/lib/download-push.ts` — focus-aware service-worker download-push planning seam.
- `client/src/lib/download-notification-intent.ts` — switch/adopt-then-open-inbox notification intent boundary.

### Test Files

- `server/src/session-json-store.test.ts` — JSON persistence round trips, atomic replacement, corruption handling, removal, and orphan cleanup.
- `server/src/file-download/manager.test.ts` — registration validation/persistence, session replay, ownership cancellation, snapshot publication, single-use claims, and durable-removal failure.
- `server/src/file-download/tools.test.ts` — send/cancel agent-tool delegation and server-derived metadata contract.
- `server/src/file-download/index.test.ts` — extension tool registration, lifecycle activation/deactivation, EventBus publication, and session context wiring.
- `server/src/file-download/http-handler.test.ts` — route recognition, claim-before-open, attachment streaming, path validation, consumed failure behavior, and generic durable-claim failure.
- `server/src/file-download/bootstrap.test.ts` — boot GC safety plus manager/factory singleton ownership.
- `server/src/index.test.ts` — main-process handoff of the enumerated allow-list, extension factory, and shared manager.
- `server/src/server.test.ts` — `/d` route mount before SPA fallback with the process-lifetime manager.
- `server/src/session-manager.test.ts` — EventBus routing, owner-only snapshot state, push metadata, recovery snapshots, and reset isolation seams.
- `server/src/session-manager-open-session.test.ts` — download extension factory injection into runtime resources.
- `server/src/ws-handler.test.ts` — full/incremental recovery, viewed-session, and takeover snapshot delivery.
- `server/src/push-notification.test.ts` — download VAPID serialization without an href.
- `client/src/lib/stores/session-registry.test.ts` — full-replacement download snapshots, per-session/reset isolation, and post-reducer coordinator handoff.
- `client/src/lib/download-presentation.test.ts` — exact-offer toast selection, native-link inbox, cause filtering, viewed-session gating, and size-copy contracts.
- `client/src/lib/download-coordinator.test.ts` — one-toast coordinator behavior for an offered ID in a multi-item snapshot.
- `client/src/lib/download-push.test.ts` — focused/background push deduplication and no-href inbox intent.
- `client/src/lib/download-notification-intent.test.ts` — existing-session and adopt-then-open session-local inbox flow.

### Behaviors Covered

#### Session JSON storage

- Missing session documents read as `undefined`, while typed documents round-trip without shape changes.
- Writes replace complete documents atomically, create parent directories, and leave no temporary sibling after success.
- Removal is idempotent; corrupt JSON is treated as absent state rather than rejecting session recovery.
- Boot GC removes orphan JSON and temporary files, preserves valid session records, tolerates a missing directory, and leaves unrelated files alone.

#### Download manager

- Session activation rehydrates registrations and emits one full `restored` snapshot; deactivation drops process ownership without deleting persistence.
- Offers accept regular files within the captured workspace, including contained absolute paths and symlinks that resolve inside it; derive filename/size/opaque href metadata; persist server-only source details; and publish an `offered` full snapshot.
- Offers reject missing paths, directories, and lexical or real-path escapes outside the workspace.
- Cancellation is session-owned, source-preserving, idempotently reports unknown IDs, and emits a full `revoked` snapshot.
- Claims return server-only source details only after durable single-use consumption, publish `consumed` before resolution, return `undefined` for unknown or raced IDs, and reject rather than expose source details when durable removal fails.

#### Agent extension and HTTP route

- The extension exposes only `pimote_send_file` and `pimote_cancel_file_send`, passes session cwd/ownership into the manager, returns only the agent-facing ID/filename/size metadata (not the one-shot href), replays lifecycle state, and emits updates on `pimote:downloads`.
- The route falls through for unrelated or non-`GET` requests, recognizes exactly one opaque ID segment, claims before opening the live source, streams the source as it exists at click time as a native attachment with no-cache headers, safely encodes filenames, consumes registrations even when click-time validation fails, and returns a generic `500` with no source/error bytes on durable-claim failure.
- Bootstrap skips GC after failed enumeration, shares one manager between the extension and HTTP route, threads the extension into each runtime, and mounts `/d` before SPA fallback.

#### Server delivery and push

- The dedicated EventBus listener accepts only its owning session's update, replaces its state, routes one full snapshot to that slot's current owner, and sends download VAPID only for an offered ID present in the snapshot.
- Recovery sends silent `restored` snapshots after incremental reconnect, full resync, viewed-session changes, and takeover. New/fork/replaced sessions do not inherit old registrations.
- Download VAPID contains only ID/filename/size presentation metadata, never an href.

#### Client session state

- A `download_update` replaces the owning session's pending list for every cause (`offered`, `restored`, `consumed`, `revoked`) without affecting other sessions.
- Newly offered items produce one actionable toast for `offeredDownloadId` with filename, formatted size, and native href; replay/removal causes stay silent even when their snapshots contain items.
- The fallback inbox exposes only pending items for the viewed session, hides for background/empty sessions, and preserves native hrefs.
- A focused push adds no second prompt; a background push carries only an `openDownloads` session intent. Its click switches or adopts the owner first, then opens that session's inbox without following a link.

**Review status:** approved

## Steps

**Pre-implementation commit:** `abbf2d14d5e4ab09cc3ef04e031013b58bbf6147`

### Step 1: Implement the common session JSON store

Complete `FileSessionJsonStore<TDocument>` and `gcSessionJsonStore` in `server/src/session-json-store.ts`. Store each document at `<storeDir>/<sessionId>.json`; return `undefined` for missing or corrupt JSON; create the directory on write; write a complete JSON document to `<sessionId>.json.tmp` and atomically rename it over the final file; and make removal idempotent. The GC function must tolerate a missing directory, delete abandoned `.json.tmp` files and JSON documents whose session ID is absent from `validSessionIds`, and leave valid documents, unrelated files, and directories untouched.

**Verify:** `npm test --workspace=@pimote/server -- --run src/session-json-store.test.ts`
**Status:** done

### Step 2: Move static hosting onto the common store

Replace the duplicated filesystem implementation in `server/src/static-host/store.ts` with a typed adapter over `SessionJsonStore<StaticHostStoreFile>` and `FileSessionJsonStore<StaticHostStoreFile>`, while retaining the existing `StaticHostStoreEntry`, `StaticHostStoreFile`, `StaticHostStore`, and `FileStaticHostStore` names used by the extension. Make `server/src/static-host/gc.ts` delegate to or re-export `gcSessionJsonStore` as `gcStaticHostStore`. Keep `server/src/static-host/index.ts` and `server/src/static-host/tools.ts` feature-specific: they still own static-host document shapes, replay, registry, and tool behavior, but no longer own JSON filesystem mechanics.

**Verify:** `npm test --workspace=@pimote/server -- --run src/static-host/store.test.ts src/static-host/gc.test.ts src/static-host/tools.test.ts src/static-host/index.test.ts`
**Status:** done

### Step 3: Implement the download manager

Implement `createDownloadManager` in `server/src/file-download/manager.ts`, adding an internal source-file validation helper under `server/src/file-download/` for use here and by the HTTP route. Validation must resolve relative paths from `workspaceRoot`, allow absolute paths only inside that root, require both lexical and real-path containment, follow in-root symlinks, reject escaping symlinks/missing paths/directories, and return the regular file's resolved path, basename, and registration-time size without changing the lexical `sourcePath` that is persisted.

Keep the process-lifetime mutable state private to the manager: active per-session registrations and publishers, an opaque-ID lookup, per-session serialization for persistence changes, and an in-flight claim reservation. Implement the lifecycle and ordering contracts as follows:

- `activate` reads the session document, rebuilds only that session's active ID lookup, installs its publisher, and emits one full `restored` snapshot (including an empty one); `deactivate` removes active lookup/publisher state without touching disk.
- `offer` generates a high-entropy, route-safe ID, validates and derives all metadata, durably appends the server-only entry before exposing it, and publishes one full `offered` snapshot with `offeredDownloadId` when the session is active. It must also persist correctly when exercised directly through the manager seam before activation.
- `cancel` checks ID ownership, durably removes only the owned registration, leaves the source file untouched, updates the active lookup, and publishes a full `revoked` snapshot; unknown or foreign IDs return `{ cancelled: false }` without mutation.
- `claim` reserves the ID synchronously before its first await, durably removes it, then removes active state and publishes `consumed` before returning `DownloadClaim`. A racing/used/unknown ID returns `undefined`. A persistence failure rejects without returning source details or publishing consumption.
- `snapshot` derives fresh public `DownloadItem` values only from the requested active session and never includes `sourcePath` or `workspaceRoot`.

**Verify:** `npm test --workspace=@pimote/server -- --run src/file-download/manager.test.ts`
**Status:** done

### Step 4: Implement the agent tools and extension lifecycle

In `server/src/file-download/tools.ts`, make `executeSendFileTool` pass `{ sessionId, workspaceRoot, path }` to `DownloadManager.offer` and return only `{ id, filename, sizeBytes }`; make `executeCancelFileSendTool` pass the owning session ID and requested ID to `cancel`. Replace the placeholder in `server/src/file-download/prompt.ts` with model guidance that explains the explicit user click/approval, one-shot native download, and requirement that the live source remain available until the user acts.

Implement `createFileDownloadExtension` in `server/src/file-download/index.ts` using TypeBox schemas that expose exactly `pimote_send_file({ path })` and `pimote_cancel_file_send({ id })`. Resolve `ctx.sessionManager.getSessionId()` and `ctx.cwd` at execution time, return the adapters' values in both text content and `details`, call `manager.activate` on `session_start`, publish its updates as `pimote:downloads`, and call `manager.deactivate` on `session_shutdown` without deleting persistence.

**Verify:** `npm test --workspace=@pimote/server -- --run src/file-download/tools.test.ts src/file-download/index.test.ts`
**Status:** done

### Step 5: Implement the one-shot attachment route

Complete `serveFileDownloadRoute` in `server/src/file-download/http-handler.ts`. Recognize only `GET /d/<one opaque segment>` after URL pathname parsing and return `false` for every other method or shape. For a match, call `DownloadManager.claim` before any source lookup or open; return a handled `404` for an absent/used ID and a generic handled `500` for claim persistence failure without exposing the error or source bytes.

After a successful claim, reuse the file-download source validator to resolve the persisted lexical path against the captured root and re-check that the live target is a contained regular file. Treat validation failure as a handled `404` while leaving the claim consumed. Stream the current file with `Content-Disposition: attachment` using a CR/LF/quote-safe ASCII fallback plus RFC 5987 UTF-8 filename encoding, `application/octet-stream` (or a safe derived type), and no-cache headers. Preserve the source file and contain post-header stream errors by closing the response rather than rejecting the server request.

**Verify:** `npm test --workspace=@pimote/server -- --run src/file-download/http-handler.test.ts`
**Status:** done

### Step 6: Complete process bootstrap and route composition

Finish the process-level composition across `server/src/file-download/bootstrap.ts`, `server/src/paths.ts`, `server/src/index.ts`, and `server/src/server.ts`. `bootstrapFileDownloads` must construct one `FileSessionJsonStore<DownloadStoreDocument>`, skip orphan GC when `validSessionIds` is `null`, otherwise sweep `PIMOTE_FILE_DOWNLOAD_DIR`, and create one manager captured by one extension factory. In `main`, enumerate session IDs once with the existing failure-to-`null` safety, pass the extension factory into `PimoteSessionManager`, and pass the same manager into `createServer`. Keep `PIMOTE_FILE_DOWNLOAD_DIR` separate from static-host state. Mount `serveFileDownloadRoute` with that manager after client static-file lookup but before static-host/SPA fallback so an unknown handled download never becomes the PWA shell.

**Verify:** `npm test --workspace=@pimote/server -- --run src/file-download/bootstrap.test.ts src/index.test.ts src/server.test.ts`
**Status:** done

### Step 7: Route download updates through session state

Implement `setupSlotDownloadListener`, `makeDownloadSnapshot`, and `routeSlotDownloadUpdate` in `server/src/session-manager.ts`. Add an honest download-listener cleanup field to `SessionState`, install the listener when `createSessionState` binds the EventBus, and unsubscribe it in `teardownSessionState`. The listener must reject malformed/non-download payloads at the `unknown` EventBus seam and route only updates whose `sessionId` matches the state it owns.

For an accepted update, replace `state.downloads`, send that exact full `download_update` through the slot's current-owner send closure, and send VAPID only for `cause: 'offered'` when `offeredDownloadId` resolves to an item in the new snapshot. Build the push payload from the slot's session/folder metadata and only `{ downloadId, filename, sizeBytes }`; never copy `href`. A push failure must not undo the state replacement or wire event. Make `makeDownloadSnapshot` return the silent `restored` variant. Ensure new and rebuilt session states start with `downloads: []`, and retain the file-download extension factory after the voice/static-host factories in every runtime's `resourceLoaderOptions`.

**Verify:** `npm test --workspace=@pimote/server -- --run src/session-manager.test.ts src/session-manager-open-session.test.ts src/push-notification.test.ts`
**Status:** done

### Step 8: Deliver silent snapshots at every WebSocket recovery boundary

In `server/src/ws-handler.ts`, add one private operation that sends `makeDownloadSnapshot(slot.sessionState.id, slot.sessionState.downloads)` directly to this handler. Invoke it exactly once after a slot is claimed by a connection so incremental reconnects, full-resync reconnects, forced takeovers, and direct ownership transfers all receive the current snapshot only on the new owner. Also invoke it after same-slot session reset/replacement resync and from `view_session` after switching the viewed session. Do not send through the client registry or broadcast to displaced/background clients; live consumption continues to flow through the slot owner installed in Step 7.

**Verify:** `npm test --workspace=@pimote/server -- --run src/ws-handler.test.ts`
**Status:** done

### Step 9: Implement client reduction and presentation models

Complete `client/src/lib/download-presentation.ts` with deterministic binary-unit size formatting (`B`, `KB`, `MB`, and larger as needed), exact `offeredDownloadId` lookup for actionable toast models, silence for `restored`/`consumed`/`revoked`, and viewed-session/empty-list gating for inbox models. Implement `coordinateDownloadUpdate` in `client/src/lib/download-coordinator.ts` so it calls the sink once only when `buildDownloadToast` returns a model.

In `client/src/lib/stores/session-registry.svelte.ts`, make `download_update` replace the owning session's array before invoking `onDownloadUpdate`. Keep snapshots isolated per session, initialize new sessions with an empty array, and continue resetting downloads rather than migrating them in `replaceSession` and `full_resync`; the subsequent server `restored` event is authoritative.

**Verify:** `npm test --workspace=client -- --run src/lib/download-presentation.test.ts src/lib/download-coordinator.test.ts src/lib/stores/session-registry.test.ts`
**Status:** done

### Step 10: Build the toast and session-local inbox surfaces

Add a rune-based UI state holder at `client/src/lib/stores/download-ui.svelte.ts` that implements `DownloadToastSink`, owns the current actionable toast queue, and records an inbox-open request for one session; it must not persist downloads or aggregate them across sessions. Construct the exported `sessionRegistry` with a callback that passes reduced events through `coordinateDownloadUpdate` into this holder, while leaving separately constructed `SessionRegistry` instances injectable for tests.

Create `client/src/lib/components/DownloadToast.svelte` and `client/src/lib/components/DownloadInbox.svelte`. The global toast shows filename and formatted registration size, has dismiss behavior, and uses a plain same-origin `<a href={item.href}>` for its primary Download action. The inbox reads only `sessionRegistry.viewed.downloads`, renders the same native links and size copy, shows a pending-count affordance, and honors an inbox-open request only after that exact session is viewed. Mount the toast globally in `client/src/routes/+layout.svelte`; place the compact inbox dropdown in `client/src/lib/components/StatusBar.svelte`; and add the conditional mobile inbox control to the current-session header in `client/src/routes/+layout.svelte`. Hide both inbox controls when the viewed session has no pending items.

**Verify:** `npm test --workspace=client -- --run src/lib/download-presentation.test.ts src/lib/download-coordinator.test.ts src/lib/stores/session-registry.test.ts && npm run check --workspace=client`
**Status:** done

### Step 11: Implement push planning and inbox notification intent

Complete `planDownloadPushDelivery` in `client/src/lib/download-push.ts`: focused delivery returns `{ kind: 'none' }`; background delivery derives a session/project title, a filename-bearing body, tag `pimote-<sessionId>`, and data containing only `{ sessionId, folderPath, openDownloads: true }`. Do not include or derive a one-shot href.

Complete `handleDownloadNotificationIntent` in `client/src/lib/download-notification-intent.ts`. If the session is already active, switch to it and then open only that session's inbox. Otherwise require `folderPath`, await `openExistingSession`, and open the inbox only after successful adoption. Never navigate to a download URL.

**Verify:** `npm test --workspace=client -- --run src/lib/download-push.test.ts src/lib/download-notification-intent.test.ts`
**Status:** done

### Step 12: Wire service-worker delivery and notification adoption

Integrate the pure push planner into `client/src/sw.ts` without changing idle/interaction behavior. After computing the existing cross-platform focus state, suppress focused download push UI (the live WebSocket event owns the toast) and show the planned OS notification only for background delivery. Preserve the planner's `openDownloads` data on notification click: post the intent to an existing window, or encode `sessionId`, `folderPath`, and an `openDownloads` flag in the URL used to open a new window.

In `client/src/routes/+layout.svelte`, parse that cold-start flag and pass notification-click messages through one shared app adapter over `handleDownloadNotificationIntent`. In `client/src/lib/stores/connection.svelte.ts` and `client/src/lib/stores/session-registry.svelte.ts`, carry `PendingSessionAdopt.openDownloads` through reconnect and use the same adapter after subscribed-session restoration, with ports backed by `switchToSession`, `openExistingSession(..., { force: true, switchTo: true })`, and the download UI holder's `openDownloadInbox`. Keep ordinary notification clicks working and never follow `DownloadItem.href` from a system notification.

**Verify:** `npm test --workspace=client -- --run && npm test --workspace=@pimote/server -- --run && npm run check && npm run build`
**Status:** done
