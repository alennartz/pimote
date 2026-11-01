# Review: Per-user server-side open-session state (revision)

**Plan:** `docs/plans/per-user-open-session-state.md` (revised: shared rekey relink, client-owned `/new`, server guard)
**Diff range:** `6b5a2e1..3097f04` (`6b5a2e1` was the HEAD of the prior review; range covers `ef07229` fixes, `40b377b` plan revision, Steps 16–18, manual-test tooling)
**Date:** 2026-11-01

## Summary

All prior findings are resolved except one, partially: `unlinkAll` still uses bare `persist()` where `link`/`unlink` were hardened to catch-and-log, so a disk-write failure can abort the shared-rekey observer loop mid-sweep and roll back a fresh rekey. The revision itself is faithful — Steps 16–18 implement the revised contract exactly, including the non-observing-holder case the manual test exposed, and the plan's Step 9 text now matches the code. Two new warnings accompany that partial fix: the forwarded-`/new` server guard leaves the acting client subscribed to nothing with no event to correct it, and a fast double-fire of `replaceSessionWithFresh` strands a stray empty session.

## Prior Findings Disposition

| #   | Prior finding                                | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Rekeyed sessions never relink                | Resolved. `handleSessionReset` awaits `relinkSessionAcrossRekey` (`ws-handler.ts:1885`, `1980-1988`): `unlinkAll(oldId)` → `link(newId)` per affected user → per-user broadcast, shared across every holder per the revised Architecture bullet (supersedes the observer-only `ef07229` fix; that method is gone). Multi-observer idempotent: the second observer's `unlinkAll` returns empty. The original stale-transcript-resurrection scenario is closed. |
| 2   | `delete_session`/`close_session` stale links | Resolved. Both unlink all holders and broadcast per affected user inside `withSessionOperation`, mirroring archive (`ws-handler.ts:798-807`, `841-847`).                                                                                                                                                                                                                                                                                                      |
| 3   | `Object.prototype` collision crash           | Resolved. Null-prototype `users` map in `emptyDocument()` and `parseDocument()` (`user-profiles.ts:23-25`, `:36`); a hand-written `"constructor"`/`"__proto__"` JSON key becomes an ordinary own key. Covered by a new test.                                                                                                                                                                                                                                  |
| 4   | Concurrent persist rename inversion          | Resolved. `persistChain` serializes every write; `persist()` stringifies memory inside the chain; `gc` routes through it; every mutator awaits (`user-profiles.ts:59-63`, `:85`, `:162-168`).                                                                                                                                                                                                                                                                 |
| 5   | Plan Step 9 self-contradiction               | Resolved. `40b377b` amends the bullet and Verify line to the single surviving site (cancelled-open continuation, `session-registry.svelte.ts:1660`); code matches.                                                                                                                                                                                                                                                                                            |
| 6   | `setUser` no normalize                       | Resolved. `name.trim().slice(0, 64)` (`persistence.ts:103-108`), matching `resolveUserName`; covered by a new test.                                                                                                                                                                                                                                                                                                                                           |
| 7   | `takeover_folder` attach without link        | Resolved. `linkSessionForUser` after `claimSession` (`ws-handler.ts:966`).                                                                                                                                                                                                                                                                                                                                                                                    |
| 8   | Persist throw skips compensating broadcast   | **Partially resolved.** `link`/`unlink` use `persistOrLog`; `unlinkAll` still calls bare `persist()` (`user-profiles.ts:133`). See Finding 2.                                                                                                                                                                                                                                                                                                                 |

The two frozen test files were extended only additively (`ef07229`: one prototype-collision test, one `setUser`-normalization test); no pre-existing assertion changed.

## Findings

### 1. Forwarded `/new` guard leaves the acting client detached and uninformed

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:1746-1757` (guard), `2012-2027` (`detachSessionForUser`), `2000-2004` (`openNewSessionInFolder`)
- **Status:** resolved
- **Fix:** Broadcast `user_sessions_changed` without exclusion in the guard path (add an exclusion flag to `detachSessionForUser`, pass it off here), and include `{ sessionId, folderPath }` in the response.

The guard exists for clients that do not intercept `/new` locally (the realistic forwarder is the mobile app). For that actor the server claims the new session — making it an observer of a session it has never heard of, with the `session_opened` broadcast excluded — then `detachSessionForUser` wipes its subscription to the old session while the `user_sessions_changed` broadcast excludes it too. The actor receives `{ success: true }` with no session pointer, no view change, and no events: it displays a session it no longer receives, until its next reconnect. A no-exclusion broadcast lets its reconcile open the new id and drop the old, converging live.

### 2. `unlinkAll`'s bare `persist()` aborts the shared-rekey observer loop

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/user-profiles.ts:133` (callers `ws-handler.ts:1982`, `803`, `844`, `906`)
- **Status:** resolved
- **Fix:** `await this.persistOrLog();` in `unlinkAll` (one line; `gc` may keep the throwing variant since a boot abort is coherent there).

`unlinkAll` mutates memory, then a failed disk write (full disk, read-only state dir) throws after the mutation, skipping the per-user broadcasts in the archive, delete, and close paths. Worst in the rekey path: the throw propagates from `relinkSessionAcrossRekey` through `handleSessionReset` into `notifySessionReset`'s sequential await loop (`session-manager.ts:1241-1245`), so observers after the failing one never receive `session_replaced` and never swap their subscriptions; `handleRuntimeSessionReplacement`'s catch then rolls the freshly re-keyed slot back. The revision's hardening contract ("mutation stays applied, callers keep broadcasting") is implemented for `link`/`unlink` but missed here. This is also why prior finding 8 is only partially resolved.

### 3. `replaceSessionWithFresh` has no double-fire guard

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/stores/session-registry.svelte.ts:1934-1943`; `client/src/lib/components/ActiveSessionBar.svelte:336-344`
- **Status:** resolved
- **Fix:** Keep an in-flight promise per session and return the running promise on re-entry.

A fast double-tap on the "New session" control (no debounce) — or `/new` while a `pending-` placeholder from a previous open is still unresolved — runs `openNewSession` twice before the first `closeSession(oldId)` removes the registry entry. Two fresh sessions are created server-side and both link into the profile; the user keeps a stray empty session (a live runtime plus a persisted file) to close manually.

### 4. Relink rides observer delivery — an observerless rekey keeps stale links

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/session-manager.ts:1241-1245` (empty observer list → no relink); `server/src/ws-handler.ts:1885`
- **Status:** resolved
- **Fix:** No small one — trigger the relink sweep from the rekey itself (an `onSlotRekeyed` hook wired at boot) rather than from observer notification.

A runtime replacement with zero live observers (voice- or extension-driven switch, or all observers dropped mid-flight) re-keys the slot but never runs `relinkSessionAcrossRekey`, so every holder's profile keeps the dead old id. On the next reconcile those clients open the old id and, where the old file still exists on disk, resurrect the stale transcript — the original finding's failure shape, narrowed to an exotic trigger.

## No Issues

- **Plan adherence:** no deviations in this round. Steps 16–18 verified done and correct against the revised contract: shared rekey relink with the non-observing-holder wire test (`ws-user-profiles.test.ts:332`, `:361`); composer interception before send and steer branches, `/new` filtered from the command list, the "New session" control with the approved label and tooltip, and client tests asserting verb order and no `/new` prompt (`InputBar.new-session.test.ts`, `ActiveSessionBar.new-session.test.ts`); server guard on `prompt`/`steer`/`follow_up` with a wire test asserting pi never sees the text and other users are untouched (`ws-user-profiles.test.ts:380`). Every commit in the range classified: review-fix fallout (`ef07229`), manual-testing effort (`tools/manual-test/`, `docs/manual-tests/`), and one unrelated concurrent change (`c598f56` assistant-text-dedupe, not reviewed here). Full server suite (1399 tests), full client suite (1170 tests), and `npm run check` green.
- **Client `/new` interception:** clean. No leak path to pi — drafts and queued-draft restores re-intercept locally, and there is no offline send queue. Mid-sequence failures degrade to staying in the old session, which remains linked.
- **`isForwardedNew` parsing:** clean. Leading whitespace, trailing arguments, `/newfoo`, and markdown-wrapped text all behave; no queue-ownership intent is created for guarded input.
- **Client reconcile:** clean. `connection.svelte.ts` is untouched by this revision; the shared rekey keeps profile truth and client sets convergent.
- **Cross-user mid-flight inversion:** not practically reachable; a racing detach of the old id converges either way.
