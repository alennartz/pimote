# Review: Per-user server-side open-session state

**Plan:** `docs/plans/per-user-open-session-state.md`
**Diff range:** `3a1a4b5..6b5a2e1` (`3a1a4b548f8f7554d4b08b0aecfe05343098e20d..HEAD`)
**Date:** 2026-02-06

## Summary

The plan was implemented faithfully: all 15 steps verified done and correct, the settings User pane matches the approved mock, the listed test files are byte-identical across implementation, and both implementation-phase test deliverables exist and assert the required behaviors. The correctness pass found four warnings, all real: the profile is not updated on session rekey (`/new`, fork, tree switch), on `delete_session`/`close_session`, and on `takeover_folder`; user names colliding with `Object.prototype` members crash `link`; and concurrent profile mutations can persist in an inverted order, resurrecting unlinked sessions after restart.

## Findings

### 1. Rekeyed sessions never relink — profile desyncs after `/new`, fork, or tree switch

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:1872-1901` (`handleSessionReset`); client counterpart `client/src/lib/stores/session-registry.svelte.ts:1765-1775`
- **Status:** resolved
- **Fix:** On the `rekeyed` outcome, `unlink(user, oldId)` + `link(user, { sessionId: newId, folderPath })` and broadcast, exactly like `linkSessionForUser`.

`handleSessionReset` updates server-side `subscribedSessions` (old→new) and the client swaps its subscription on `session_replaced`, but nothing touches `userProfiles`. After any rekey, the profile still holds the dead `oldId` and never holds the live `newId`. On the next reload/reconnect the reconcile drops the current session (`toDrop`) and opens `oldId`; if the pre-reset file still exists on disk, the server reopens the stale transcript and relinks it — the user's current session vanishes from the open set and a pre-reset duplicate resurrects, persistently.

### 2. `delete_session` and `close_session` leave stale profile links — dead/cancelled sessions resurrect or churn

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:805-825` (`close_session`), `827-905` (`delete_session`)
- **Status:** resolved
- **Fix:** `unlinkAll(sessionId)` + per-affected-user `broadcastUserSessionsChanged` in both handlers, mirroring the `archive_session` path at `ws-handler.ts:911-913`.

Only `detach_session` and archive unlink. `SessionItem.deleteSession` sends `close_session` (detach) only `if (isActive)`, so deleting a non-viewed session from the folder list removes the file but keeps the profile entry: every reconnect re-attempts a doomed `open_session` → `session_not_found` → local drop, forever until server reboot GC. Likewise the cancelled-open path (`session-registry.svelte.ts:1660`) sends `close_session` for a session the open already linked: the runtime closes, the file persists, and the next reload reopens the session the user explicitly cancelled.

### 3. `UserProfiles.link` crashes for user names colliding with `Object.prototype` members

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/user-profiles.ts:23` (`users: {}`), `138-145` (`ensureProfile`)
- **Status:** resolved
- **Fix:** Make the `users` map null-prototype — `Object.create(null)` in `emptyDocument()` and `Object.assign(Object.create(null), parsed.users)` in `parseDocument()`.

`ensureProfile` reads `this.document.users[user]`; for `constructor`, `toString`, `valueOf`, `__proto__`, etc. the lookup resolves to an inherited function/object, which is truthy, so it is returned as the "profile" and `profile.sessions.find` throws `TypeError`. Every `open_session` for a user with such a name fails with an error response. Additionally `__proto__` assignment never creates an own key, so that name never persists and stays `fresh` forever. User names are freeform text in the settings dialog, so the input is reachable.

### 4. Concurrent `link`/`unlink` can invert the persist rename order — file resurrects an unlinked session

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/user-profiles.ts:93-135` (mutations), `148-160` (`persist`)
- **Status:** resolved
- **Fix:** Serialize each mutate+persist through an internal promise chain inside `UserProfiles` (same pattern as `withSessionOperation`).

`withSessionOperation` serializes per session id, but a user's profile spans sessions: a reconnecting device's restore loop fires concurrent `link`s while another device detaches (`unlink`). `persist()` stringifies after an `await mkdir`, and the two temp-file renames complete in OS order; if the link's rename lands after the unlink's, the final file contains the unlinked session while memory does not. The next server restart resurrects the entry in the user's profile.

### 5. Plan Step 9's verify line is unsatisfiable as written

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `docs/plans/per-user-open-session-state.md` (Step 9, third bullet and Verify); `client/src/lib/stores/session-registry.svelte.ts:1660`
- **Status:** resolved
- **Fix:** Amend the plan text to name only the cancelled-open continuation (~old line 1674) as the surviving `close_session` site.

The plan says two `close_session` sends stay verbatim (~1674 and ~1924 "placeholder discard"), while its main bullet orders `closeSession` (~1920) — the ~1924 send itself — to become `detach_session`. The pre-implementation code shows `closeSession`'s `pendingNewSessionRequests` guard meant placeholders never sent `close_session` from there, so only one placeholder-path send ever existed. The implementation followed the coherent reading: exactly one `close_session` send remains (cancelled-open continuation), and `closeSession` sends `detach_session`. No code change needed; the plan text is the defect.

### 6. `setUser` does not normalize — client and server names diverge past 64 characters

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/stores/persistence.ts:101`
- **Status:** resolved
- **Fix:** Apply the server's rule in `setUser` — `name.trim().slice(0, 64)`.

The server caps at 64 (`resolveUserName`); the client stores and displays the untrimmed, uncapped string. A long or padded name yields a server key that matches no chip in `list_users`, so the settings pane reports the current profile wrong and `adoptedProfileKnown` misleads ("has no open sessions yet" for a populated profile).

### 7. `takeover_folder` attaches an observer without linking the profile

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/ws-handler.ts:965-990`
- **Status:** resolved
- **Fix:** Add `await this.linkSessionForUser(takeoverSessionId, takeoverSlot.folderPath);` after `claimSession`.

The web client relinks by accident (its `session_opened` handling sends a follow-up `open_session`), but any client that relies on the command response alone ends up attached-but-unlinked. A later same-user `detach_session` from another device then returns `unlink === false`, skips the `user_sessions_changed` broadcast, yet has already force-detached that connection and cleared its server-side subscription — it keeps showing a session that no longer streams, with no event to correct it.

### 8. `link`/`unlink` mutate memory before `persist`; a persist throw skips the compensating broadcast

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/user-profiles.ts:93-116`
- **Status:** resolved
- **Fix:** Catch-and-log persist failures inside `link`/`unlink` so the mutation/broadcast contract holds (memory is then intentionally ahead of disk, as it already is on throw).

On disk-full, `linkSessionForUser` throws inside the session lock: the command answers failure for an open that succeeded, and the `detach_session` path detaches other connections' observers without broadcasting, leaving them stale until their next reconnect.

## No Issues

- **Plan adherence:** no critical or warning deviations. All 15 steps verified done and correct. The Interaction Mock was compared point by point (adaptive chrome, dirty state, Save enablement, chips with counts and click-to-adopt, consequence copy, chips refresh) — implemented behavior matches; the User tab rendering first per the plan supersedes the mock's tab order, an approved deviation. Test immutability holds: `server/src/user-profiles.test.ts` and `client/src/lib/stores/persistence.test.ts` are byte-identical between `cc9ab25` and HEAD. All changes in the diff trace to plan steps. Both implementation-phase test deliverables (`server/src/ws-user-profiles.test.ts`, `client/src/lib/stores/user-sessions-reconcile.test.ts`) cover the behaviors the plan requires.
- **Same-session races:** none found. Every profile mutation for a given session id runs inside `withSessionOperation`; broadcasts read the in-memory document inside the lock; client reconcile is single-threaded per socket with correct socket-identity guards, and `restoreDispatched` is set synchronously before dispatch.
- **Path traversal / injection via user names or session ids:** none. Names are JSON object keys only, capped at 64, never used in filesystem paths; the atomic write uses a randomUUID temp name inside the store directory and removes it on failure.
- **Client reconcile logic:** sound. `reconcileUserSessions` cannot emit duplicates; two first-ever devices converge to the union; the module-level `localMirrorCleared` one-shot is safe with the single global `connection` store.
