# Plan: Per-user server-side open-session state

## Context

Move the dashboard's open-session list from browser local storage into server-side per-user profiles so all of one user's devices share and stay in sync on one set. Brainstorm: `docs/brainstorms/per-user-open-session-state.md`. Pull brief: product-manager repo, `pulls/per-user-open-session-state.md`.

Key brainstorm decisions carried in as settled: named users with no auth (client-side setting, `default` fallback); only `pimote:activeSessions` moves; broadcast to the user's other connections only (no echo); per-session semantics with no whole-set writes; lossless first-connect migration; survives server restarts; out of scope — auth, Android client work.

A late architecture decision supersedes part of the brainstorm: the profile is **derived from session opens**, not maintained by new tracking commands. There are no `track_session`/`untrack_session` commands. `open_session` links; `detach_session` unlinks. Migration rides the client's existing connect-time replay of its local set, so no fresh-flag or adopt handshake is needed.

## Architecture

### Impacted Modules

**Protocol** (`shared/src/protocol.ts`)

- New server→client event `user_sessions_changed` carrying the user's full open-session set plus a fresh marker (see Interfaces).
- New client→server command `list_users` with a response payload of profile names plus session counts.
- Term decision (resolves the brainstorm's fog item explicitly): the identity concept keeps the word **user** — it is the word the capture, the client setting, and the product language already use. The collision with pi's conversation-role "user" lives in disjoint contracts (message content roles vs connection identity and profile keys); they never appear in the same wire type. Disambiguation is a documentation duty: implementation adds glossary entries for **User** (connection identity, client-side setting) and **User profile** (server-side per-user open-session set), with a flagged-ambiguity note distinguishing them from the message-role sense.
- `detach_session` changes meaning, hard cut (house style: the ownership removal cut, DR-056): it was socket-scoped observer detach; it becomes **user-level unlink** — the requesting user's link to the session drops everywhere. The internal socket-scoped observer detach remains a server-side API (`sessionManager.detachObserver`), only the wire command changes.
- `close_session` stays on the wire and keeps its server handler, but no dashboard surface sends it anymore. Android consumes a subset and takes the hard cut in lockstep; per the pull brief this is recorded as a named Android follow-up, not work in this pull.

**Server** (`server/src/`)

- New module `user-profiles.ts` (see New Modules).
- `ws-handler.ts`: parse the `user` query param at WebSocket open (trim, cap length, empty/absent → `default`); bind it to the connection. In the `open_session` flow: after the observer attaches, link the session into the user's profile; on change, persist and broadcast `user_sessions_changed` to the user's **other** connections. New `detach_session` handling: resolve the requesting user, detach all of that user's observers on the session, unlink the profile entry, broadcast the new set to the user's other connections (the acting connection applies its own change locally — no echo). New `list_users` handling. Session archive: remove the session from every user's profile and broadcast to each affected user's connections. Boot: load the profile store, then GC it against the boot-time `validSessionIds` (same sweep that prunes other per-session stores).
- Membership semantics (the contract the tests protect):
  - Sticky: a socket dying (tab closed, laptop asleep, phone backgrounded) never removes profile entries. Only explicit `detach_session`, archive, or GC remove them.
  - Ref-free removal: `detach_session` unlinks the requesting user unconditionally, regardless of that user's other live connections, and detaches those connections from the session (their views exit; the broadcast tells them to drop the entry).
  - Other users' links to the same session are untouched.
  - Profile membership does not interact with the idle reaper; records stay restorable as today.

**Web Client** (`client/src/`)

- `connection.svelte.ts`: append `&user=<name>` from the new client setting to the WS URL. Handle the connect-burst `user_sessions_changed` event: reconcile `subscribedSessions` against the server set — open entries the client lacks (existing restore loop), drop entries the server set lacks. The migration rule rides the `fresh` flag and preserves the brainstorm's adopt-once semantics: when `fresh` is true, the connection's local-seeded entries are adopted (the restore loop links them into the new profile); when false, local entries absent from the server set are **dropped, never opened** — a stale second browser reconciles down to server truth instead of resurrecting closed sessions. After the first event of a connection, clear the local `pimote:activeSessions` key and never read it again.
- `session-registry.svelte.ts`: delete `persistSessions()` and its call sites — the mirror no longer exists. The user-facing close action sends `detach_session` instead of `close_session`. The `close_session` sends in the pending-placeholder cleanup paths stay (the command remains on the wire for them). `onSessionNotFound` / restore-failure handlers keep dropping local entries; the reconnect-restore cleanup that sent a socket-scoped `detach_session` must be reworked — under the new semantics it would unlink the user everywhere. Verify same-id eviction cleanup covers it (DR-067: a disconnected observer releases its cursor; the server's takeover eviction detaches the dead socket's observers) and remove the client-side detach call.
- `persistence.ts`: add `getUser()`/`setUser()` over a new `pimote:user` key; keep `getActiveSessions()` as the one-time migration seed; replace `setActiveSessions` usage with a `clearActiveSessions()`.
- `GlobalSettingsDialog.svelte`: new **User** tab — the first non-file tab. Renders a structured pane (form, not editor) inside the same `CodeEditorDialog` shell: name field, profile chips with session counts (from `list_users`), consequence copy. Save rides the dialog's existing Save (desktop footer / mobile header, per the approved mock), disabled until changed; saving persists the local setting and re-establishes the WebSocket so the new user's set loads.

### New Modules

**`user-profiles.ts`** (server, `server/src/user-profiles.ts`)

- Purpose: the per-user open-session profile store. Owns profile truth, persistence, and boot GC. Knows nothing about sockets or observers; callers translate wire traffic into `link`/`unlink` calls.
- Storage: single JSON document at `PIMOTE_STATE_DIR/user-profiles.json` — `{ version: 1, users: { [name]: { sessions: [{ sessionId, folderPath }] } } }`. Atomic temp-write-then-rename on every mutation (folder-registry precedent). Arbitrary user names key a JSON object, so there is no filename-encoding or sanitization surface.
- Boot: `load()` degrades a corrupt/missing file to an empty store (registry precedent); `gc(validSessionIds)` prunes entries naming dead sessions. Once a user key exists it persists even when its session list is empty — emptiness is meaningful state, and recycling absent keys would reopen the migration adoption window (see the migration semantics below).
- The `fresh` notion is derived, not stored: a user is fresh when no key exists for it yet. First `link` creates the key and ends freshness forever.
- User names are honor-system identity: trim, cap length, empty → `default`. No auth, no reserved names.

### Interfaces

**Wire contract** (shapes to materialize in `shared/src/protocol.ts`, following existing command/event envelope conventions):

```ts
/** Server → client. Sent in the connect burst and after any change to this
 *  user's profile. Recipients replace their local view with `sessions`. */
export interface UserSessionsChangedEvent {
  type: 'user_sessions_changed';
  /** The user's full open-session set — server truth, not a delta. */
  sessions: { sessionId: string; folderPath: string }[];
  /** True when this user has no server profile yet (never linked).
   *  Gates migration: only a fresh profile adopts a connection's
   *  pre-existing local set. */
  fresh: boolean;
}

/** Client → server. WAS socket-scoped observer detach; NOW user-level unlink. */
export interface DetachSessionCommand {
  type: 'detach_session';
  sessionId: string;
}

/** Client → server. Backs the settings pane's profile chips. */
export interface ListUsersCommand {
  type: 'list_users';
}
/** Profile names with open-session counts, alphabetically. */
export interface UserSummary {
  name: string;
  sessionCount: number;
}
```

Behavioral contract for the wire (what tests assert):

- Connect with `?user=alice` → Alice's connections receive `user_sessions_changed` with Alice's set in the connect burst, `fresh` true exactly when Alice has no profile yet. Connect without `user` → the `default` profile's set.
- Migration: fresh profile + non-empty local seed → local set adopted (linked server-side). Existing profile (`fresh: false`) + stale local seed → local-only entries dropped, never opened; no resurrection of closed sessions.
- Two connections of one user: A opens session S → both see S in their sets after A's own local application; the event reaches B but never echoes to A.
- A sends `detach_session` for S → A's other live connections drop S from their sets and detach from it; connections of other users holding S are unaffected and still hold it.
- Socket death changes nothing: kill a connection's socket, the profile set is unchanged.
- Archive session S → S leaves every profile; each affected user's connections are told.
- Restart the server → profiles survive; a fresh connection gets the pre-restart set.

**Server store seam** (`user-profiles.ts`):

```ts
export interface SessionRef {
  sessionId: string;
  folderPath: string;
}
export class UserProfiles {
  constructor(private readonly storePath: string) {}
  load(): Promise<void>; // corrupt/missing → empty
  gc(validSessionIds: Set<string>): Promise<void>; // prune dead session entries
  get(user: string): SessionRef[];
  /** True when no profile exists for this user yet. */
  isFresh(user: string): boolean;
  /** Idempotent add; creates the user key, ending freshness. Returns true when the profile changed. */
  link(user: string, ref: SessionRef): Promise<boolean>;
  /** Remove one session from one user. Returns true when changed. */
  unlink(user: string, sessionId: string): Promise<boolean>;
  /** Remove a session from all users; returns affected user names. */
  unlinkAll(sessionId: string): Promise<string[]>;
  /** Alphabetical names with counts, for list_users. */
  summaries(): { name: string; sessionCount: number }[];
}
```

**Client seams:**

- `persistence.ts`: `getUser(): string | null`, `setUser(name: string): void`, `clearActiveSessions(): void`. `getActiveSessions()` survives as the migration seed only.
- Connect flow: WS URL gains `&user=<name>` (null → omit → server default). On `user_sessions_changed`: reconcile subscribed sessions (open missing via the existing restore path, drop absent), with migration gated on `fresh` as described under Web Client. Clear the local active-sessions key after the first event of a connection.
- Settings pane: save → `setUser(name)` → reconnect WS → connect burst delivers the new profile's set.

### Interaction Mocks

- `docs/mocks/per-user-open-session-state/index.html` — approved visual and interaction contract for the Global Settings User pane: adaptive chrome (desktop footer Save ≥ 640 px, mobile header Save below, per CodeEditorDialog behavior), dirty state (tab marker, header hint, Save enablement), profile chips with session counts and click-to-adopt, consequence hints distinguishing known-profile switches from fresh profiles.

## Tests

**Pre-test-write commit:** `3a1a4b548f8f7554d4b08b0aecfe05343098e20d`

### Interface Files

- `shared/src/protocol.ts` — wire contract: `UserSessionsChangedEvent` (connect burst + change push, full set + `fresh` gate), `ListUsersCommand` with `ListUsersResponseData`/`UserSummary`, `detach_session` doc comment hardened to the user-level unlink meaning; both union memberships added. Runtime wire flows (connect burst delivery, broadcast targeting, echo suppression, query-param binding) land with the ws-handler wiring in the implementation phase.
- `server/src/user-profiles.ts` — `SessionRef`, `UserProfiles` profile store (load/gc/get/isFresh/link/unlink/unlinkAll/summaries), and `resolveUserName` (trim, cap length, blank/absent → `default`). All bodies are `not implemented` stubs.
- `client/src/lib/stores/persistence.ts` — `getUser`/`setUser` (per-device `pimote:user` setting) and `clearActiveSessions` (drops the local open-session mirror). Stubs.

### Test Files

- `server/src/user-profiles.test.ts` — full behavioral suite for the profile store and name resolution over real files in a temp dir.
- `client/src/lib/stores/persistence.test.ts` — extended with the User-setting round-trip and the active-session clear contract.

### Behaviors Covered

#### UserProfiles (server store)

- Boot degrades a missing or corrupt profile file to an empty store where every user is fresh.
- A user is fresh exactly until its first link; unlinking sessions or reloading never restores freshness.
- Link adds a session to a user's profile and reports the change.
- Re-linking the identical session reference duplicates nothing and reports no change.
- Re-linking a held session under a new folder updates that session's folder reference instead of duplicating it.
- `get` hands out snapshots — callers cannot mutate profile truth through a returned list.
- Unlink removes one session from one user, keeps their other sessions, and reports the change.
- Unlink of a session the user does not hold (or for an unknown user) changes nothing and reports no change.
- Unlinking one user leaves another user's link to the same session in place.
- `unlinkAll` removes a session from every holder and names exactly the affected users; an unheld session names no users.
- A user profile stays listed (count 0, non-fresh) after its last session is unlinked, across reloads too.
- `gc` prunes entries naming sessions outside the valid set; a fully pruned user keeps their empty, non-fresh key.
- Profiles survive a reload from disk; arbitrary user names (slashes, spaces, unicode) round-trip without encoding.
- A hand-written document in the storage shape loads as profile truth, and a later mutation persists to disk.

#### resolveUserName

- Absent (`null`/`undefined`) and blank names resolve to `default`.
- Surrounding whitespace is trimmed.
- Very long names are capped to a bounded length.

#### Client persistence

- `getUser` returns null before any user is set; `setUser` round-trips and overwrites the stored name.
- `clearActiveSessions` empties the active-session list and removes the stored key.

#### Implementation-phase test deliverables (required)

The behaviors below protect the plan's behavioral contract but depend on code that
does not exist yet. The implementation phase must deliver tests for them:

- Wire flows (`ws-handler` level): connect burst delivery of the user's set with
  correct `fresh` value; broadcast to the user's other connections only (no echo);
  user-level `detach_session` unlinking the requesting user everywhere while other
  users' links to the same session stay; socket death never removes profile
  entries; archive removes the session from every profile and notifies each
  affected user; profiles survive a server restart.
- Client reconcile (connect flow): `fresh: true` adopts the local set; `fresh: false`
  drops local-only entries without opening them; the local `pimote:activeSessions`
  key clears after the first `user_sessions_changed` of a connection.

The settings User pane stays intentionally untested by unit tests: no
component-test infrastructure exists in this repo, its visual contract is the
approved mock, and manual journeys (two browsers on one user, user switch via
settings) cover it end to end.

**Review status:** approved

## Steps

### Step 1: Implement the `UserProfiles` store and `resolveUserName`

Fill the stubs in `server/src/user-profiles.ts` (interfaces and signatures are already fixed there and in `server/src/user-profiles.test.ts`).

- Internal shape: `{ version: 1, users: { [name]: { sessions: SessionRef[] } } }`. `load()` reads the document at `storePath`; a missing file, unreadable file, or JSON that fails a shape check degrades to an empty store (folder-registry precedent — never throws).
- Persistence: every mutating call (`link`, `unlink`, `unlinkAll`, `gc` when it prunes) writes the whole document with temp-write-then-rename in the same directory (atomicity precedent: `folder-registry.ts`). Use `node:fs/promises`.
- `get(user)` returns a defensive copy (`sessions.map((s) => ({ ...s }))`) so callers cannot mutate truth.
- Freshness is derived: `isFresh(user)` is `!Object.hasOwn(users, user)`. Never delete a user key — `unlink` that empties a list keeps the key; `gc` that empties a list keeps the key.
- `link`: no entry with this `sessionId` → push, return true; identical entry → return false; same `sessionId` different `folderPath` → replace in place, return true.
- `unlink`/`unlinkAll`: filter by `sessionId`; `unlinkAll` returns the names whose list actually shrank, in any order the caller can sort (tests use `toContain`).
- `summaries()`: `Object.keys(users).sort()` with each count.
- `resolveUserName(raw)`: `raw?.trim()`; empty → `'default'`; cap length at 64.

**Verify:** `npx vitest run server/src/user-profiles.test.ts` — all green.
**Status:** not started

### Step 2: Implement the client persistence stubs

Fill `getUser`, `setUser`, `clearActiveSessions` in `client/src/lib/stores/persistence.ts` following the file's existing house pattern (try/catch swallowing, localStorage). New key constant `KEY_USER = 'pimote:user'`. `clearActiveSessions` removes `pimote:activeSessions` via `localStorage.removeItem` inside the same try/catch pattern. Leave `getActiveSessions`/`setActiveSessions` as-is (`setActiveSessions` loses its callers in Step 9; the test suite still covers it).

**Verify:** `npx vitest run client/src/lib/stores/persistence.test.ts` — all green.
**Status:** not started

### Step 3: Boot wiring — construct, load, and GC the profile store

- `server/src/paths.ts`: add `export const PIMOTE_USER_PROFILES_PATH = join(PIMOTE_STATE_DIR, 'user-profiles.json');`.
- `server/src/index.ts`: after `validSessionIds` is computed (the same sweep that GCs the static-host store and file downloads), construct `const userProfiles = new UserProfiles(PIMOTE_USER_PROFILES_PATH)`, `await userProfiles.load()`, and when `validSessionIds` is non-null `await userProfiles.gc(validSessionIds)`. Pass `userProfiles` through to `createServer`/the server factory and onward to `WsHandler` (same plumbing path as `folderRegistry`: `server/src/server.ts` factory params → `new WsHandler(...)` argument → `readonly userProfiles` field).
- `server/src/index.test.ts` asserts boot-shape interactions; if its `createServer` mock arity needs the new argument, extend the mock in lockstep with the real signature (that is contract plumbing, not a behavior change).

**Verify:** `npx vitest run server/src/index.test.ts` green; boot logs show no new errors.
**Status:** not started

### Step 4: Bind the user at connection and deliver the connect burst

- `server/src/server.ts`, in the `wss.on('connection')` handler: `const user = resolveUserName(url.searchParams.get('user'));` pass `user` to `WsHandler` (new constructor parameter, stored as `readonly user: string`). Console log line gains `user=${user}` alongside `clientId`.
- Still in the connect burst, right after `handler.sendToClient(capabilities)`: `handler.sendToClient({ type: 'user_sessions_changed', sessions: this-userProfiles.get(user), fresh: this.userProfiles.isFresh(user) })` — i.e. the event is the user's full snapshot with the derived freshness flag.
- Add a static broadcast helper on `WsHandler`:

```ts
/** Push the user's current profile set to their connections, excluding `exceptClientId` (no echo). */
static broadcastUserSessionsChanged(
  userProfiles: UserProfiles,
  clientRegistry: ClientRegistry,
  user: string,
  exceptClientId?: string,
): void
```

It iterates `clientRegistry.values()`, filters `handler.user === user && handler.clientId !== exceptClientId`, and sends each a `user_sessions_changed` snapshot (freshness recomputed per send; after any change it is false, which is correct — the gate only matters in the connect burst).

**Verify:** `npx vitest run server/src/ws-handler.test.ts` still green (existing cases unaffected); a manual `wscat`-style connect to `/ws?clientId=x&user=alice` receives `user_sessions_changed` with `fresh: true` in the burst.
**Status:** not started

### Step 5: Link sessions into the profile on `open_session`

In `server/src/ws-handler.ts`, `case 'open_session'` — all three success paths (new session, attach to existing, disk reopen) end by sending the success response. Before or immediately after each `sendResponse(id, true, ...)`:

```ts
if (await this.userProfiles.link(this.user, { sessionId, folderPath })) {
  WsHandler.broadcastUserSessionsChanged(this.userProfiles, this.clientRegistry, this.user, this.clientId);
}
```

using that path's `folderPath` (`newSlot.folderPath` / `existing.folderPath` / `reopenedSlot.folderPath`). The no-echo exclusion is the acting client: it applied the open locally. Keep the `link` inside the existing `withSessionOperation` block for the existing/disk paths so the folder path read is serialized with slot mutation. New-session path links after `broadcastSessionOpened`. Note: the client's restore loop (Step 10) drives migration through this same command — no separate migration code exists server-side.

**Verify:** unit test in Step 11; manually, two browsers as the same user: one opens a session, the other's dashboard gains the tab.
**Status:** not started

### Step 6: Rework `detach_session` into user-level unlink

Replace the body of `case 'detach_session'` in `server/src/ws-handler.ts`. New behavior:

1. Validate `sessionId` as today.
2. Inside `withSessionOperation`: for every handler in `clientRegistry.values()` with `handler.user === this.user` (including the requesting one), call `sessionManager.detachObserver(sessionId, handler.clientId, handler.ws)` when that handler has the session subscribed, then clear `handler.subscribedSessions.delete(sessionId)` and null its `viewedSessionId` if it pointed there. The server-side socket-scoped detach API stays exactly as-is — only the wire command semantics change.
3. `await this.userProfiles.unlink(this.user, sessionId)` — if it reports a change, `WsHandler.broadcastUserSessionsChanged(..., exceptClientId: this.clientId)`. The acting connection applies its own change locally.
4. `this.sendResponse(id, true)`.

Other users' handlers are never touched; their links survive. The existing observer-cleanup at socket close (`cleanup()`, line ~2371) stays detach-only — socket death never unlinks (sticky membership).

**Verify:** unit test in Step 11.
**Status:** not started

### Step 7: Handle `list_users`

Add `case 'list_users'` in `ws-handler.ts`: `this.sendResponse(id, true, { users: this.userProfiles.summaries() })`. No session operation, no broadcast. The response data shape matches `ListUsersResponseData` in `shared/src/protocol.ts`.

**Verify:** unit test in Step 11; the settings pane (Step 13) renders the chips from it.
**Status:** not started

### Step 8: Unlink everywhere on archive

In `case 'archive_session'` (`ws-handler.ts`, ~line 849), inside the per-session loop and only when `command.archived` is true: after the record is marked and observers closed,

```ts
for (const affectedUser of await this.userProfiles.unlinkAll(archiveSessionId)) {
  WsHandler.broadcastUserSessionsChanged(this.userProfiles, this.clientRegistry, affectedUser);
}
```

No exclusion here — the archiving connection can belong to a different user, and each affected user's connections (including any that archived) are told. Unarchive (`archived: false`) does not relink — reopening goes through `open_session`, which links (Step 5).

**Verify:** unit test in Step 11.
**Status:** not started

### Step 9: Strip the client's local mirror and switch the close action

`client/src/lib/stores/session-registry.svelte.ts`:

- Delete the `persistSessions()` method (lines ~408–413) and every call site (~990, 998, 1007, 1035, 1049, 1081). No behavior replaces it — the server owns the set now.
- Remove the `setActiveSessions` import (keep `getActiveSessions` — the boot hydration at line ~1868 stays as the one-time migration seed until Step 10 replaces its gating).
- `closeSession` (~line 1920): keep the optimistic local removal and the `pendingNewSessionRequests` guard, change the wire command from `close_session` to `detach_session`.
- The two `close_session` sends in the pending-placeholder cleanup paths (~line 1674 cancelled-open continuation, ~line 1924 placeholder discard) stay verbatim — that command remains on the wire for them.
- `onSessionNotFound` / `onSessionRestoreFailed` keep dropping local entries only. Rewrite the stale comment at ~line 1828 (`The connection store sends the socket-scoped detach first...`) — Step 10 removes that send; cleanup rests on the server's same-id takeover eviction (DR-067).

**Verify:** `npx vitest run client/src/lib/stores/session-registry.test.ts` green; grep shows no `persistSessions` remains; grep shows `close_session` sent only from the two placeholder paths.
**Status:** not started

### Step 10: Client connect flow — user param, profile-gated reconcile, one-time clear

`client/src/lib/stores/connection.svelte.ts`:

- Import `getUser` from persistence. Build the WS URL (line ~202) with `&user=${encodeURIComponent(getUser() ?? '')}` only when `getUser()` is non-null (null → omit → server `default`).
- Extract a pure reconcile helper (new function, exported for Step 12's tests, in this file or a sibling module):

```ts
export interface ReconcilePlan {
  toOpen: { sessionId: string; folderPath: string }[]; // open via existing restore path
  toDrop: string[]; // remove locally, never open
}
export function reconcileUserSessions(
  current: { sessionId: string; folderPath: string }[], // this connection's subscribed set
  server: { sessionId: string; folderPath: string }[], // user_sessions_changed payload
  fresh: boolean,
): ReconcilePlan;
```

Rules: entries in `server` missing from `current` → `toOpen`; entries in `current` missing from `server` → `toDrop` **unless** `fresh` (fresh adopts the whole local set into `toOpen`); the union is the fresh profile's migration.

- Restructure `onopen`'s restore dispatch: instead of immediately looping `subscribedSessions`, record the pending restore and dispatch once the first `user_sessions_changed` for this socket arrives (the server sends it in the connect burst; guard the continuation with the `this.ws !== ws` identity check like every other continuation in the file). Apply the plan: `toOpen` entries go through the existing `open_session` restore send loop (unchanged error handling — `session_archived`, `session_not_found`, generic failure); `toDrop` entries call `this.removeSubscribedSession` plus a new callback `onSessionDropped?: (sessionId: string) => void` that `session-registry.svelte.ts` binds to `dropSession`-style local removal (same as `onSessionNotFound`). Sync progress counters count `toOpen` only. When `toOpen` is empty, skip the syncing phase entirely.
- Add an `onmessage` branch for `user_sessions_changed` (before the generic `emitEvent`, like `session_archived`): store the profile event, run the reconcile on first arrival, and on subsequent arrivals mid-connection apply the same plan (open missing, drop absent — `fresh` is always false there, so drops are unconditional).
- One-time clear: a module-level `let localMirrorCleared = false`; after the first `user_sessions_changed` of a connection, call `clearActiveSessions()` and set the flag — never read `pimote:activeSessions` again this page load.
- Remove the `detach_session` send in the generic restore-failure branch (~lines 263–268): keep the warn, the `removeSubscribedSession`, and the `onSessionRestoreFailed` notify flow; the server's takeover eviction (DR-067) already detaches a dead socket's observers, and the new command semantics would unlink the user everywhere. Update the branch comment accordingly.

**Verify:** Step 12's tests; manually: two browsers on one user, A opens and closes sessions, B mirrors; a stale second browser with a stale local set reconciles down to server truth after this change only (clear the key once to simulate the pre-migration state).
**Status:** not started

### Step 11: Wire-flow tests (server)

New file `server/src/ws-user-profiles.test.ts`, following `server/src/ws-handler.test.ts`'s existing harness for constructing a handler/registry pair. Cover the plan's behavioral contract:

- Connect burst: a connection bound `?user=alice` receives `user_sessions_changed` with Alice's set and `fresh: true` exactly when Alice has no profile; a connection without `user` gets the `default` profile's set.
- Broadcast targeting: Alice A opens S (via the open path) → Alice B receives the event, A does not (no echo).
- User-level detach: Alice A sends `detach_session` → Alice B's set drops S and B's observer is detached; Bob's link to S survives and Bob still holds it.
- Socket death: close A's socket → the profile set is unchanged.
- Archive: archive S → S leaves Alice's and Bob's profiles; each affected user's connections receive the event.
- Restart: build a second `UserProfiles` over the same temp path, `load()`, and assert the pre-restart sets (the store-level reload already covers disk truth; this asserts the handler is wired to the same path).

**Verify:** `npx vitest run server/src/ws-user-profiles.test.ts` green.
**Status:** not started

### Step 12: Client reconcile tests

New test file `client/src/lib/stores/user-sessions-reconcile.test.ts`:

- `fresh: true` + non-empty local seed → the full local set lands in `toOpen` (adoption), nothing dropped.
- `fresh: false` + stale local seed → local-only entries land in `toDrop`, never `toOpen`; server-only entries land in `toOpen`.
- Mixed overlap under both flags partitions exactly (union with no duplicates).
- First-event clear: drive the connection store's event handling once (or the smallest exported seam that owns it) and assert `localStorage.getItem('pimote:activeSessions')` is null afterwards; a second event does not re-write or re-read it.

Keep assertions on `ReconcilePlan` outputs and storage state only — no socket internals.

**Verify:** `npx vitest run client/src/lib/stores/user-sessions-reconcile.test.ts` green.
**Status:** not started

### Step 13: Settings User tab

`client/src/lib/components/GlobalSettingsDialog.svelte`, inside the existing `CodeEditorDialog` shell — the mock at `docs/mocks/per-user-open-session-state/index.html` is the interaction oracle:

- New **User** tab, rendered first (before the file tabs), with a dirty marker (`*`) when the pane differs from the persisted setting. Selecting it shows a form pane instead of the editor pane; file tabs keep current behavior.
- Pane contents per the mock: **User name** input (`spellcheck="false" autocomplete="off"`, seeded from `getUser()`), the field note about same-user sharing and no authentication, a **Profiles on this server** section with chips from a `list_users` response (`{ users: UserSummary[] }` — fetch on dialog open and on tab select), each chip showing `name` + `N sessions`, the current user's chip marked current, click-to-adopt filling the input, and the switching-consequence copy.
- Dirty/save: the dialog's existing Save affordances (desktop footer ≥ 640 px, mobile header below — `CodeEditorDialog` already owns this split) enable only when the input differs from the persisted user. Save → `setUser(name.trim())` (empty input is invalid — keep Save disabled for it) then `connection.disconnect()` + `connection.connect()` so the new user's connect burst loads the new profile. Follow the mock's hint row (`Unsaved changes`) via the shell's `hint` prop.
- Refresh the chips after save (the adopted profile is now current).

State lives in the component; no new store. No unit tests (plan records the pane as manually covered).

**Verify:** manual journeys: open settings → User tab shows chips with counts; adopt a chip → Save enables → save reconnects and the dashboard shows that profile's sessions; two browsers on one user stay in sync; mobile-width check shows the header Save.
**Status:** not started

### Step 14: Glossary entries

`glossary.md` — add under **Language**:

- **User**: a connection identity presented by the client (`?user=` on the WS URL, `pimote:user` device setting); honor-system, no auth. _Avoid_: account.
- **User profile**: the server-side per-user open-session set persisted in `user-profiles.json`.

Add to **Flagged ambiguities**: "user" also names pi's conversation message role — resolved: the role stays in message-content contracts, the identity sense stays in connection/profile contracts; they never share a wire type.

**Verify:** entries present; terms used in new code match.
**Status:** not started

### Step 15: Full suite and commit cadence

Run the full test suites (`server/`, `client/`, `shared/` per repo scripts) and `npm run check`-equivalents for type/lint gates. Fix fallout only where a step above caused it. Record the Android follow-up noted in the architecture (Android consumes `detach_session`/`close_session` and takes the hard cut in lockstep) wherever the pull brief tracks follow-ups — confirm location with the user if no such file exists.

**Verify:** all suites green; commits made per step (`plan:` through implementation as work lands).
**Status:** not started
