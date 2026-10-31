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
