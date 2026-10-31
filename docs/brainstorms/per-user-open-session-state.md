# Brainstorm — Per-user server-side open-session state

Pulled from the product manager as 0.16 must-have #1. Brief: `../../product-manager` repo, `pulls/per-user-open-session-state.md`. Captured intent (Alenna, 2026-10-26): move the open-session list out of browser local storage into server-side storage keyed by "user", so all of one user's devices share and stay in sync on one open-session set. A second goal added during brainstorm: introduce the "user" concept itself as a client-side setting.

## Key decisions

### 1. Identity: named users, no auth

A user is a plain name declared client-side in a new setting and sent at connect. Anyone can claim any name; that is acceptable for now. The deployment is a personal server behind a network boundary, so auth is out of scope unless a future pull re-scopes it.

- The `user` setting itself lives client-side (a new local-storage key). It is the key into server-side profiles, not part of the server profile.
- **Unset user falls back to one shared `default` profile.** Zero-config on personal servers: laptop, phone, and Android sync with nothing to set up. On shared servers, unset devices share one set, which is tolerable because identity is honor-system anyway.

### 2. Key split: only `pimote:activeSessions` moves

Full local-storage inventory reviewed. `showArchived` was argued to be workspace state that could follow the user; the decision went capture-literal instead: only the list of open sessions moves. Criterion recorded as intent — _workspace state moves, device UX stays_ — but applied narrowly.

- Stays per-device: `pimote:showArchived`, `pimote:sessionPillSwipeHintShown`, `pimote:dismissedUpdateVersion`, `pimote-install-dismissed`.
- Stays per-tab by design: `pimote:clientId` (sessionStorage; two tabs must not share identity).

### 3. Sync: per-session operations + push, no echo

The server profile is the source of truth for the open-session set.

- Mutations are per-session open/close operations carrying `{sessionId, folderPath}`, not whole-set writes. Set operations commute, so concurrent edits from two devices cannot drop each other's changes. A whole-set write would silently lose a concurrent add.
- The server persists, then broadcasts the change to the user's **other** connections only. The originator applies its own op locally; echoing it back is redundant traffic and would only force dedupe logic (Alenna, explicit).
- Each connection receives the user's current set at connect and rehydrates from it. Local storage stops being authoritative.
- Fits the existing typed command/event WS protocol (`shared/src/protocol.ts`); reconnect replay rides the existing event-buffer machinery.

### 4. Migration: adopt-once

The connect handshake includes a fresh-profile marker. When a connection sees a fresh profile _and_ holds non-empty local state, it replays its local set as open ops, clears the local key, and follows the server from then on.

- Once a profile exists server-side, local state is never consulted again.
- Accepted consequence: two old browsers both holding sets — first to connect wins, second's local set is dropped.
- Always-merge was rejected: a session closed on the phone would resurrect forever from a stale laptop copy.

### 5. Storage: per-user JSON documents, registry precedent

Follows the folder-registry persistence pattern: one JSON document per user in the server's store directory, atomic temp-write-then-rename, loaded at boot, written through on every mutation.

- Profiles are tiny; no cleanup or GC machinery. A profile accumulates until someone deletes it.

### Accepted daily-UX change

Phone and laptop always show the same open sessions. Opening a session on the phone makes it appear on the laptop's list. That is the feature, named here so it is a decision, not a surprise.

## Sharp questions for architecting

- **Stale entries.** Profile entries can outlive the sessions they name (deleted transcripts, stale runs). Who prunes: server-side validation against session existence, or client-side filtering at render? The server cannot cheaply know whether a session file is deletable, since the rehydration list exists precisely to name not-loaded sessions.
- **Wire shape.** Exact command/event names, connect-handshake fields (`user`, fresh-profile marker, initial set), and payload types, in the existing `shared/src/protocol.ts` style.

## Fog

- **Term collision:** "user" already means conversation roles in pi's message model. Whether the same word can safely name this identity concept in glossary, wire, and code is unresolved. Domain-modeling pass should settle it (candidate alternatives: profile owner, device group). Dies with this artifact unless promoted.
- **Android impact:** the wire contract gains a connect-time `user`. Out of scope per the pull brief; if handshake changes land, record the Android follow-up with the PM rather than expanding this pull.

## Success shape

A user with a laptop, phone, and Android on one server sees one identical open-session set everywhere, synced live, surviving restarts, with existing local state adopted on first connect and no disruption to the dogfooding loop.
