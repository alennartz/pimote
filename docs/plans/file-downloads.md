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

New Client modules, approximately a download store/coordinator plus `DownloadInbox` and `DownloadToast` components, own presentation and native-link invocation. They consume typed protocol state rather than infer downloads from tool-call rendering or panel cards.

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

interface DownloadUpdateEvent {
  type: 'download_update';
  sessionId: string;
  cause: DownloadUpdateCause;
  downloads: DownloadItem[]; // Full replacement snapshot for this session.
}
```

The client receives no absolute path, workspace root, or server-only source metadata. `offered` permits the toast coordinator to prompt the user; `restored`, `consumed`, and `revoked` replace state without a new toast. `sizeBytes` is deliberately not refreshed when the source changes because the registration is live, not a snapshot.

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

`claim` is the single-use authorization operation. It synchronously reserves the ID against concurrent requests, durably removes it from the session document, removes it from the active registry, and publishes `consumed` before resolving its server-only claim. If durable removal cannot complete, it serves no bytes. Once `claim` resolves, no later browser can obtain the file with that ID, even if streaming later fails.

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

The extension emits full download snapshots on a dedicated `pimote:downloads` EventBus channel. `PimoteSessionManager` stores the current snapshot in `SessionState`, routes it as `download_update` to the slot owner, and explicitly sends the current snapshot after recovery or view changes. This gives direct HTTP consumption a way to remove a pending item from the current owner's PWA without coupling the route to client code.

On an `offered` update, the server also sends the existing VAPID push notification with a download-specific reason and `{ downloadId, filename, sizeBytes }` presentation data. The service worker uses its established focus policy: background clients receive an OS notification; a focused client avoids a duplicate toast because the live `download_update` already produced the actionable prompt. Tapping the OS notification opens/adopts the owning session, where the registration remains pending for an explicit download click.

#### Client state and interaction contract

Each per-session client state gains `downloads: DownloadItem[]`. A `download_update` fully replaces that session's list; the client does not merge or persist it independently of the server. The viewed session's fallback inbox reads only its own list.

For `cause: 'offered'`, the client shows a toast containing filename and formatted initial size. Its primary Download action is a native `<a href={item.href}>` attachment request, so the usual case is one explicit user click from notification to browser download. The fallback inbox renders the same native links for pending items after the toast is missed or more than one file is available. No click automatically follows an URL, including a system-notification click.
