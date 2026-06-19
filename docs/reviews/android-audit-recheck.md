# Android client audit re-check

Re-verification of the `# Android client` section of `docs/reviews/codebase-audit.md`
against the **current** working tree.

- Commit assessed: `f221e2005d2c4122bd3732e8c754ea3a9d262f8b` (HEAD), plus the
  uncommitted server/client edits in the working tree (none of which touch
  `mobile/android/`, so the Android sources read here are the committed ones).
- Method: static reading only. `make android-build` / `android-test` is
  Docker-based and slow; not required for this analysis.
- The audit's line numbers were treated as hints. Every verdict below cites
  current `file:line` references located by reading the actual functions.

All paths below are relative to
`mobile/android/app/src/main/kotlin/com/pimote/android/`.

---

## C1 — Unhandled `WsConnectionLost` / `WsRequestTimeout` in `runOutgoing`

**Original claim:** WS exceptions thrown by `wsClient.request` in the dial/bind
phase propagate to the default handler (crash) and skip `terminate`, leaking the
Telecom Connection and sticking state.

**Verdict: STILL VALID.**

Evidence:

- `call/CallController.kt:454` `runOutgoing` issues `wsClient.request(...)` at
  lines **461** (open_session), **482** and **487** (call_bind / forced retry).
  None of these is wrapped in a try/catch. The only guard is around
  `peer.connect` (`:509–511`, catches `PeerConnectionFailed` only).
- `net/WsClient.kt:60-66` — `request` throws `WsConnectionLost` /
  `WsRequestTimeout` (both `RuntimeException`s). The watchdog
  (`WsClient.kt` `request`, `def.completeExceptionally(WsRequestTimeout())`) and
  `failAllPending()` (`WsClient.kt` `completeExceptionally(WsConnectionLost())`)
  make these reachable mid-request.
- The coroutine runs in `applicationScope` =
  `CoroutineScope(SupervisorJob() + Dispatchers.IO)` (`app/AppContainer.kt:53`),
  passed to `CallControllerImpl` (`AppContainer.kt:244`). There is **no**
  `CoroutineExceptionHandler`. A `SupervisorJob` prevents siblings from being
  cancelled but does **not** swallow an uncaught exception in a launched child —
  it still reaches the global default handler → process crash. `terminate` is
  never invoked, so the Connection is never destroyed and state stays in
  `Dialing`/`Binding`.

**Fix direction:** wrap the body of `runOutgoing` (or each `wsClient.request`)
in `try/catch (Throwable)` routing to `terminate(BIND_FAILED, failureReason=...)`,
rethrowing `CancellationException`.

---

## H1 — `CallState` never returns from `Ended` to `Idle`; second call never auto-opens the in-call UI

**Original claim:** Nothing resets `Ended → Idle`, and the in-call activity
launcher fires only on the `Idle → non-Idle` edge, so call #2 never auto-opens
the in-call screen.

**Verdict: ALREADY FIXED (the headline consequence); residual cosmetic-only.**

Evidence:

- The literal "`Ended` never returns to `Idle`" still holds:
  `performTermination` sets `_state = terminalState ?: Ended(...)`
  (`call/CallController.kt:407`), and only `onAppShutdown` passes
  `terminalState = Idle` (`:447`). No other reset exists.
- **But the described consequence is gone**, because the in-call activity launch
  was moved out of `AppContainer` and into the foreground service. `AppContainer`
  now only _starts the FGS_ on the edge
  `map { !Idle && !Ended }.onEdge { prev, cur -> cur && prev != true }`
  (`app/AppContainer.kt:264–268`). For call #2 the transition is
  `Ended → Dialing`, i.e. mapped `false → true`, so the edge **fires**.
- `call/CallForegroundService.kt:72` `startForegroundNow()` calls
  `launchInCallActivity()` (`:98–104`) on every `ACTION_START`. So call #2 _does_
  auto-open the in-call screen. The FGS self-stops on `Idle || Ended`
  (`CallForegroundService.kt:119`).
- `InCallActivity` deliberately auto-finishes only on `Idle`
  (`ui/call/InCallScreen.kt:306`) and intentionally holds on `Ended` so the user
  can read the failure reason (`:296–301`). With `FLAG_ACTIVITY_SINGLE_TOP`
  (`CallForegroundService.kt:100`) a lingering `Ended` activity is reused and its
  VM re-renders `Dialing` for the new call.

**Residual:** the documented `Ended → Idle` reset is still unimplemented; it is
now benign given the FGS-driven launch, but the interface KDoc
(`CallController.kt:50-52`) still promises a reset that does not happen. Worth a
doc correction or an actual `Idle` reset for cleanliness.

---

## H2 — `startOutgoing` overwrites a live call without terminating it

**Original claim:** `startOutgoing` cancels `callJob` then replaces the `Live`
slot; cancellation does not run teardown, so the old peer (mic) and Telecom
Connection leak.

**Verdict: STILL VALID.**

Evidence:

- `call/CallController.kt:279-298` `startOutgoing` still does
  `live.value?.callJob?.cancel()` (`:282`) then `live.value = Live(...)`
  (`:297`). No `terminate` call on the existing slot.
- Cancelling `callJob` only kills the watcher coroutines; it does **not** run
  `terminate`/`performTermination`, so the old `SpeechmuxPeer.disconnect()`
  (mic/ADM release) and the old `connection.disconnectAsLocalHangup()` never
  fire. The old `Live` is dropped by the overwrite — the only references gone.
- This is the principle-6 violation the audit names: "start a new call" should
  route the displaced call through the single `terminate` operation.

**Fix direction:** `terminate(USER_HANGUP)` (or a dedicated reason) on the
existing slot before installing the new `Live`.

---

## H3 — Missing torn-down check after `peer.connect`

**Original claim:** No `live.value == null` check between `peer.connect`
returning and `reportActive()`; if a user hangup destroyed the Connection while
ICE connected concurrently, `reportActive()` runs on a destroyed Connection and
state is forced to `Active`, then the hangup bail leaves it stuck in `Active`.

**Verdict: STILL VALID.**

Evidence:

- `call/CallController.kt:509` `peer.connect(...)` is wrapped only for
  `PeerConnectionFailed` (`:510`). On normal return, control falls straight to
  `connection.reportActive()` (`:526`) and `_state = Active(sessionId)` (`:527`)
  with **no** `if (live.value == null) return` in between.
- `runOutgoing` does check `live.value == null` after sessionId resolution
  (`:478`) and after peer creation (`:502`), but **not** after connect returns.
- `endCurrentCall` for `Negotiating` calls `terminate` directly
  (`CallController.kt:330-334`), nulling `live` and destroying the Connection. If
  ICE reached CONNECTED concurrently, `connectedDeferred` completes,
  `peer.connect` returns normally, and `reportActive()` hits a destroyed
  Connection. Then `val hangup = live.value?.userHangup ?: return` (`:540`) bails
  with `_state` already forced to `Active` — stuck, FGS stays up, no path to
  terminate (slot already null).

**Fix direction:** add `if (live.value == null) return` between `peer.connect`
returning and `reportActive()`, or fold the post-connect transition into a
`live.update`-guarded step that observes the swap result.

---

## M1 — Transient ICE `DISCONNECTED` treated as fatal; no negotiation timeout

**Original claim:** `DISCONNECTED → Failed("ice_disconnected")` kills calls on
brief blips; `connect()` has no overall deadline and can suspend forever.

**Verdict: STILL VALID.**

Evidence:

- `voice/SpeechmuxPeerImpl.kt:184-186` —
  `IceConnectionState.DISCONNECTED -> _state.value = PeerState.Failed("ice_disconnected")`.
  No grace timer. (It does **not** complete `connectedDeferred`, matching the
  audit's note that a pre-connect DISCONNECTED that never recovers strands
  `connect()`.)
- The controller's watcher `peer.state.first { it is PeerState.Failed }`
  (`CallController.kt:551-554`) ends the active call immediately on that Failed.
- `connect()` (`SpeechmuxPeerImpl.kt:152`) has no `withTimeout`. It awaits
  `signalConnected.await()` and `connectedDeferred.await()` (`:373`) with no
  overall deadline, so a stalled `session`/`answer`/ICE leaves the call in
  `Negotiating` until manual hangup.

**Fix direction:** apply a 3–5 s grace timer on DISCONNECTED before declaring
Failed (mirror the PWA), and wrap the connect sequence in `withTimeout` mapping
to `PeerConnectionFailed("negotiation_timeout")`.

---

## M2 — `disconnect()` not idempotent under concurrency

**Original claim:** The snapshot-then-null sequence is plain unsynchronized
access on non-volatile vars; two threads can both snapshot non-null and spawn
two cleanup threads, double-disposing native objects.

**Verdict: STILL VALID.**

Evidence:

- `voice/SpeechmuxPeerImpl.kt:605-660` `disconnect()` snapshots `peer`,
  `signalingSocket`, `audioTrack`, `audioSource`, `audioSender`, `controlChannel`
  into locals (`:607-612`) then nulls the fields (`:613-619`). These backing
  fields are plain `var` (`:101-106`), **not** `@Volatile`, and there is **no**
  `AtomicBoolean`/CAS/`synchronized` gate. The KDoc still asserts "a second
  `disconnect()` is a no-op" (`:606`), which the field access does not guarantee.
- Concurrent callers exist: `terminate` → `snapshot.peer?.disconnect()` on the
  caller thread (`CallController.kt:391`) can race `connect()`'s
  `catch { disconnect(); ... }` on the IO thread
  (`SpeechmuxPeerImpl.kt:375,378`). Both can read the same non-null snapshot and
  each spawn a `"speechmux-peer-cleanup"` thread calling `peerToClose.close()`,
  `factory.dispose()`, `adm.release()` — double native dispose / use-after-free.
  The `try/catch (Throwable)` wrappers don't protect against a native SIGSEGV.

**Fix direction:** gate `disconnect` with `AtomicBoolean.compareAndSet`, or move
the per-call fields into one `AtomicReference<Snapshot?>` swapped to null (the
`Live`-record pattern already used in `CallController`).

---

## M3 — `pending` is global across sessions; dying loop can fail the new session's requests

**Original claim:** `pending` is client-wide; `failAllPending()` in the old
loop's non-suspending tail can fail requests issued against the new session, and
the old loop can stamp `_state = Reconnecting` over the new `Connecting`.

**Verdict: STILL VALID.**

Evidence:

- `net/WsClient.kt:158` — `pending` is still a single client-wide
  `ConcurrentHashMap`, **not** part of the per-connect `Session` record
  (`:168-172`). The `Session` refactor collapsed origin/scope/socket but left
  `pending` and `_state` global.
- `connectionLoop` runs its tail after `conn.events.collect` exits:
  `conn.close()`, `target.activeSocket.compareAndSet(conn, null)`,
  `failAllPending()`, `waitForRetry(attempt)` (`WsClient.kt:238-242`). None of
  these between collect-exit and `failAllPending` is a suspension point, so a
  scope cancellation issued by a concurrent `connect(newOrigin)` does not stop
  the old loop from reaching `failAllPending()` and clearing the new session's
  in-flight requests.
- `waitForRetry` sets `_state.value = Reconnecting(...)` (`WsClient.kt:255`)
  _before_ its first suspension (`coroutineScope { delay }`), so the old loop can
  also overwrite the new session's `Connecting`.
- `closeSession` does call `failAllPending()` synchronously in `connect`
  (`:204`), but that only covers requests outstanding _before_ the new session
  installs; it does not close the cross-thread window described above.

**Fix direction:** move `pending` (and ideally `_state` writes) into the
`Session` record, or have the loop tail check `session.value === target` before
`failAllPending()` / touching `_state`.

---

## M4 — Backoff-reset-on-network-availability contract is a lie

**Original claim:** Docs say network-availability resets `attempt` to 0;
`waitForRetry` only cuts the current delay short and keeps incrementing
`attempt`.

**Verdict: STILL VALID.**

Evidence:

- Interface KDoc still states "Network-availability events reset `attempt` to 0
  and trigger an immediate retry." (`net/WsClient.kt:88-89`).
- `waitForRetry` (`:248-261`): the wake-watcher cancels `delayJob` early on a
  `false→true` edge, but the function unconditionally `return next` (the
  incremented attempt), with the trailing comment "If a network wake reset us to
  attempt=0, callers handle it" (`:260`) — nothing resets it. The only place
  `attempt = 0` is set is on `WsTransport.Event.Open` (`:223`).
- Consequence is exactly as described: after a long outage the first post-wake
  attempt fires immediately, but if it fails the next delay jumps to the 30 s cap
  rather than restarting the schedule.

**Fix direction:** have `waitForRetry` return 0 when the wake fired (restart the
schedule), or fix the docs to match the intended behavior.

---

## L1 — `updateRawContactOps` never converges for half-broken contacts

**Original claim:** Updates select on `RAW_CONTACT_ID + MIMETYPE`; if one data
row is missing (only the both-rows-missing case is handled), the update no-ops
and `diff` re-emits the same `UpdatePair` forever.

**Verdict: STILL VALID.**

Evidence:

- `contacts/ContactSyncRunner.kt:302-321` `updateRawContactOps` issues two
  `newUpdate` ops, one selecting `MIMETYPE = StructuredName`, one selecting
  `MIMETYPE = MIME_CALLABLE`. A missing target row → zero matches → silent no-op.
- `readExistingContacts` only routes to the `orphan:<rawId>` delete path when
  **both** values are blank: `if (display.isNullOrBlank() && uri.isNullOrBlank())`
  (`ContactSyncRunner.kt:213`). A half-orphan (one blank) falls through to a
  normal `ExistingContact` with `display.orEmpty()` / `uri.orEmpty()`
  (`:224-229`), which won't match the desired non-empty values, so `diff` emits
  an `UpdatePair` every reconcile while the broken row's update keeps no-opping.

**Fix direction:** detect half-orphans in `readExistingContacts` (exactly one of
the two blank) and route them through delete+reinsert like full orphans, or use
insert-or-update semantics for the data rows.

---

## L2 — Connection left in `STATE_INITIALIZING` until `Active`; `setDialing()` never called

**Original claim:** `onCreateOutgoingConnection` calls `setInitializing()` and
nothing transitions the Connection until `reportActive()`, so it reads
"initializing" through the whole dial/bind/negotiate phase — off-contract for
in-car UIs.

**Verdict: STILL VALID.**

Evidence:

- `telephony/PimoteConnectionService.kt:52` — `conn.setInitializing()` at
  creation.
- `telephony/PimoteConnection.kt:59-61` — `reportActive()` → `setActive()` is the
  only forward transition used. `reportRinging()` (`:55-57`) exists but a repo-wide
  grep shows it is **never called**; `setDialing()` is never declared on the
  `CallConnection` seam nor invoked. The sole `reportActive` call site is
  `CallController.kt:526`, reached only after bind + ICE.
- So the Connection stays `STATE_INITIALIZING` for the entire dial/bind/negotiate
  window — off the self-managed contract, which expects a prompt move to
  `STATE_DIALING`.

**Fix direction:** add a `reportDialing()` to the `CallConnection` seam (→
`setDialing()`) and call it from `startOutgoing`/`runOutgoing` once dispatch
begins.

---

## L3 — `connect` swallows `CancellationException`

**Original claim:** The `catch (Throwable)` converts cooperative cancellation
into `PeerConnectionFailed`, so a cancelled `callJob` takes the error path
instead of unwinding as cancelled.

**Verdict: STILL VALID.**

Evidence:

- `voice/SpeechmuxPeerImpl.kt:374-380` — the catch ladder is
  `catch (e: PeerConnectionFailed) { disconnect(); throw e }` then
  `catch (e: Throwable) { disconnect(); throw PeerConnectionFailed(...) }`. There
  is **no** `catch (e: CancellationException) { disconnect(); throw e }` before
  the generic catch, so a `CancellationException` (a `Throwable`) is rewritten to
  `PeerConnectionFailed`.
- Mostly masked today by `terminate`'s CAS, but it is the standard
  catch-Throwable-without-rethrowing-cancellation bug.

**Fix direction:** add `catch (e: CancellationException) { disconnect(); throw e }`
ahead of the generic `Throwable` catch.

---

## L4 — `OkHttpWsTransport` can silently drop inbound frames under backpressure

**Original claim:** `callbackFlow` + `trySend` with the default 64-element
channel drops messages — including command responses → spurious
`WsRequestTimeout`s — when the collector falls behind.

**Verdict: STILL VALID.**

Evidence:

- `net/OkHttpWsTransport.kt:30-58` — the `callbackFlow` uses `trySend(...)` in
  `onOpen`/`onMessage`/`onClosed`/`onFailure` (default `BUFFERED` = 64-slot
  channel). `trySend` drops on a full buffer.
- Downstream is `connectionLoop` → `handleMessage` → `_events.emit`
  (`WsClient.kt:285`), where `emit` suspends when the 64-slot `MutableSharedFlow`
  is full with a slow subscriber — that backpressure can fill the callbackFlow
  channel and `trySend` then silently drops, including responses routed via
  `pending.remove(resp.id)?.complete(...)`.

**Fix direction:** use `trySendBlocking`/`sendBlocking` (OkHttp listener threads
tolerate blocking) or `Channel.UNLIMITED` on the callbackFlow.

---

## L5 — Principle violations / dead code

### L5a — `CallForegroundService.ACTION_STOP` + `stop()` dead; `stop()` uses `startService`

**Verdict: STILL VALID.**

Evidence: `call/CallForegroundService.kt` — `ACTION_STOP` is handled
(`:58`) and declared (`:200`), and the companion `stop()` (`:213-217`) builds an
`ACTION_STOP` intent via `context.startService(...)`. A repo-wide grep shows
`ACTION_STOP` / `stop()` are referenced **only** inside this file — no external
callers. The service self-stops via `stopForegroundAndSelf()` on `Idle`/`Ended`
(`:119`, `:169-172`). `startService` from the background throws
`BackgroundServiceStartNotAllowedException` on O+.

**Fix direction:** delete `ACTION_STOP` + `stop()`, or, if kept, route through
`startForegroundService`.

### L5b — `mapEndReasonToDisconnectCause` maps `USER_HANGUP → REMOTE` (unreachable + wrong)

**Verdict: STILL VALID.**

Evidence: `telephony/PimoteConnection.kt:98-103` —
`USER_HANGUP, REMOTE_HANGUP -> DisconnectCause.REMOTE`. The function is only
reached via `disconnectAsRemoteEnded` (`:68-70`), which `performTermination`
calls only for `REMOTE_HANGUP`/`DISPLACED`/`SERVER_ENDED`
(`CallController.kt:399-401`); `USER_HANGUP` goes through
`disconnectAsLocalHangup` (`:397`). So the `USER_HANGUP` branch is unreachable
but mislabels a local hangup as REMOTE.

**Fix direction:** drop the unreachable reasons (`error("unreachable")`) or fix
the mapping to `LOCAL`.

### L5c — `WsState.Failed` declared but never emitted

**Verdict: STILL VALID.**

Evidence: `net/WsClient.kt:55` declares `data class Failed(...)`. A grep for
`_state.value = ... Failed` in `net/` returns no emission site — the loop only
ever sets `Connecting`/`Connected`/`Reconnecting`/`Disconnected`. `lastFailure`
carries the diagnostic string instead.

**Fix direction:** wire `Failed` up (e.g. surface it for UI) or remove it.

---

## Summary table

| Finding                                                      | Verdict                               |
| ------------------------------------------------------------ | ------------------------------------- |
| C1 — unhandled WS exceptions in `runOutgoing`                | STILL VALID                           |
| H1 — `Ended → Idle` reset / second-call UI                   | ALREADY FIXED (residual doc/cosmetic) |
| H2 — `startOutgoing` overwrites live call w/o terminate      | STILL VALID                           |
| H3 — missing torn-down check after `peer.connect`            | STILL VALID                           |
| M1 — ICE DISCONNECTED fatal + no negotiation timeout         | STILL VALID                           |
| M2 — `disconnect()` not idempotent under concurrency         | STILL VALID                           |
| M3 — global `pending` across sessions                        | STILL VALID                           |
| M4 — backoff-reset contract lie                              | STILL VALID                           |
| L1 — half-orphan contacts never converge                     | STILL VALID                           |
| L2 — Connection stuck in INITIALIZING (`setDialing` missing) | STILL VALID                           |
| L3 — `connect` swallows `CancellationException`              | STILL VALID                           |
| L4 — `OkHttpWsTransport` drops frames under backpressure     | STILL VALID                           |
| L5a — `CallForegroundService` `ACTION_STOP`/`stop()` dead    | STILL VALID                           |
| L5b — `mapEndReasonToDisconnectCause` wrong/unreachable      | STILL VALID                           |
| L5c — `WsState.Failed` never emitted                         | STILL VALID                           |

Net: 14 of 15 findings survive against the current tree; only H1's headline
consequence has been resolved (by relocating the in-call-activity launch into
`CallForegroundService`, keyed off the non-Idle/Ended edge). The `Session`
refactor noted in the codemap did **not** address M3/M4 — `pending` and `_state`
were left out of the per-connect record.

---

## New issues noticed while verifying (NOT in the original audit)

These are observations made while reading the same code; they are separate from
the audit's findings and were not part of the re-check scope.

1. **`reportRinging()` is dead on the `CallConnection` seam.**
   `telephony/PimoteConnection.kt:55` and `telephony/CallConnection.kt:15`
   declare `reportRinging()`, but a repo-wide grep finds no caller. It is the
   same dead-code class as L5; combine with the L2 fix (the seam needs
   `reportDialing`, not `reportRinging`, for an outgoing-only client).

2. **`onAppShutdown` cancels `callJob` then calls `terminate` — relies on
   `terminate`'s CAS for the peer/connection teardown ordering.**
   `CallController.kt:444-449` does `current.callJob.cancel()` then
   `terminate(USER_HANGUP, terminalState = Idle)`. Because `terminate` snapshots
   the `Live` it swaps out, the teardown still runs on the cancelled job's
   snapshot — correct, but it means teardown effects run on the shutdown caller
   thread synchronously while the cancelled `runOutgoing` may still be unwinding
   its `coroutineScope` race. Not observed to break (the race watchers are
   children of the cancelled job), but worth a targeted test given C1/H2/H3 all
   live in the same teardown-ordering surface.

3. **`request`'s watchdog is launched into the long-lived `scope`
   (`applicationScope`), not the per-request coroutine.**
   `WsClient.kt` `request` does `scope.launch(Dispatchers.IO) { delay(...) }`. It
   is cancelled on the normal/await paths, but if the awaiting coroutine is
   cancelled between `pending.remove` and `watchdog.cancel()` the watchdog is
   still cancelled in the `catch` — so no leak. Flagged only because the watchdog
   lifetime is coupled to the client scope rather than the call; a structured
   `withTimeout` around `def.await()` would be cleaner and removes the manual
   `isActive` check.

4. **`SpeechmuxPeerImpl` reconfigures ICE servers via `pc.setConfiguration`
   after the offer path has begun gathering.** `applySessionFrame`
   (`SpeechmuxPeerImpl.kt:` `pc.setConfiguration(cfg)`) runs before the offer is
   created (guarded by `offerSent`), so this is ordered correctly today — noted
   only because it depends on `session` always arriving before any local
   candidate is sent, which the `pendingLocalCandidates` queue enforces. No bug,
   but it is load-bearing and untested at the integration level.
