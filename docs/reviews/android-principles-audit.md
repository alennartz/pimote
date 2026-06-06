# Android coding-principles audit

Scope: `mobile/android/app/src/main/kotlin/com/pimote/android/**`. Principles
audited against (from `~/.pi/agent/AGENTS.md`):

1. No global mutable state.
2. No mutable captures in lambdas / closures.
3. Function names must reveal what the function actually does.
4. Prefer immutable objects.
5. Pure functions with return values beat side-effecting functions.

The headline: `CallControllerImpl` is, structurally, a state machine with the
state machine taken out — its "state" lives in six unsynchronised `var` fields
that several coroutines read and write. Wrapped around that is a global
`AppContainer.instance` singleton that the rest of the app reaches into. Most
other modules are healthier than these two; the rot is concentrated.

---

## Critical

### C1. `AppContainer.instance` is a textbook global mutable singleton

**File:** `com/pimote/android/app/AppContainer.kt:292–299`

```kotlin
companion object {
    @Volatile private var _instance: AppContainer? = null
    val instance: AppContainer
        get() = _instance ?: error("AppContainer not initialized")
    internal fun install(c: AppContainer) { _instance = c }
}
```

**Principle violated:** 1 (global mutable state). Also 5 — `install` is a
side-effecting void function whose name lies about its scope (it does not
"install" anything beyond writing one process-wide field).

**Why it's critical:** every framework-instantiated boundary in the app reaches
through this singleton — `CallForegroundService`, `PimoteConnectionService`,
`InCallScreen` viewmodel, `MainActivity`, `SetupScreen` viewmodel,
`ContactsScreen` viewmodel, `CallByDataRowActivity`, `CallByNameActivity`. That
means the _real_ dependency graph of the app is invisible at every call site:
you cannot look at `CallForegroundService` and know what it depends on without
grepping `AppContainer.instance`. Tests cannot construct any of those things
with fakes without first poking `_instance`. The `@Volatile` is cosmetic —
nothing in the type prevents `install` being called twice with different
containers mid-process.

**Fix sketch:** the framework-instantiated callers each have exactly one
constructor-time hook where DI can attach. For Activities/Services, that hook
is `((applicationContext) as PimoteApp).container`. Make `PimoteApp` the
single source of `AppContainer`, give every framework class a
`get container() = (application as PimoteApp).container` accessor, and delete
the companion entirely. The `Application` instance is the legitimate
process-scoped object the platform already gives us; we should not be
duplicating that with a parallel singleton.

For pure-Kotlin call sites (Compose viewmodels), pass the specific
collaborators (`CallController`, `SessionRepository`, …) in via the viewmodel
factory rather than reaching for the whole container.

---

### C2. `CallControllerImpl` is a state machine modeled as six unsynchronised mutable fields

**File:** `com/pimote/android/call/CallController.kt:229–239`

```kotlin
private var callJob: Job? = null
private var userHangup: CompletableDeferred<Unit>? = null
private var currentSessionId: String? = null
private var currentPeer: SpeechmuxPeer? = null
private var currentConnection: CallConnection? = null
private var finished: Boolean = false
```

**Principles violated:** 1 (the controller is an `AppContainer`-scoped
singleton, so these fields _are_ process-wide mutable state), 2 (every one of
them is read and written from inside `scope.launch { … }` blocks elsewhere in
the file), 4 (the call's identity — sessionId, peer, connection, terminal-ness
— is the natural value of a single immutable record, not six independent
fields), 5 (`finishCall` is a void function that mutates this bag, instead of
producing a new state value the caller could assign).

**Why it's critical:** every one of these fields is touched from more than one
coroutine and more than one Telecom callback thread:

- `startOutgoing` writes all of them, then `scope.launch { runOutgoing(…) }`
  reads them.
- `runOutgoing` writes `currentPeer` and `currentSessionId` and reads
  `userHangup`.
- `endCurrentCall` reads `userHangup`, `currentSessionId`, `callJob`, then
  calls `finishCall` which mutates `finished`, `currentPeer`,
  `currentConnection`, `_state`.
- `onAppShutdown` reads all six and nulls them — also on the main thread,
  while a worker coroutine may be writing them.
- `setMicMuted` and `setAudioRoute` read `currentPeer` and `currentConnection`
  from the UI thread.

The `finished` flag in particular is a check-then-set without a lock
(`if (finished) return; finished = true`) — under contention (e.g.
`PimoteConnection.onDisconnect` racing the server's `call_ended` event), both
callers can pass the gate and double-trigger teardown. The code's comments
already acknowledge this ("Two paths, both funnel into finishCall
(idempotent)…", "Snapshot + null out everything up front so this is
idempotent and a concurrent endCurrentCall / runOutgoing race can't
double-fire the teardown") — the proposed defence is to manually snapshot
locals before nulling, which is an admission that the type doesn't make the
invariant true; it relies on every caller getting the dance right.

The doc comment on the file describes the state machine cleanly:
`Idle → Dialing → Binding → Negotiating → Active → Ended → Idle`. The states
already exist as a sealed `CallState`. The associated data (sessionId, peer,
connection) belongs _inside_ those states, not in parallel fields.

**Fix sketch:** the answer is the state machine the doc already describes.
Hold all per-call data on the state itself:

```kotlin
private sealed interface InternalState {
    object Idle : InternalState
    data class Live(
        val sessionId: String?,
        val peer: SpeechmuxPeer?,
        val connection: CallConnection,
        val callJob: Job,
        val userHangup: CompletableDeferred<Unit>,
        val phase: CallState,   // Dialing/Binding/Negotiating/Active
    ) : InternalState
    data class Ended(val state: CallState.Ended) : InternalState
}
private val internal = MutableStateFlow<InternalState>(InternalState.Idle)
```

Then:

- Every transition becomes a pure helper `(InternalState, Event) →
InternalState` that returns the new state plus the side effects to run
  (close peer, tell Telecom, send `call_end`).
- The controller's public methods become `internal.update { current → reduce(current, ev) }`
  followed by `runEffects(effects)`. `update` is atomic, so the "finished"
  guard is replaced by "the state already moved to Ended so the reducer
  ignores this event" — no flag, no race.
- `currentPeer`, `currentConnection`, `currentSessionId`, `finished`, `callJob`,
  `userHangup` all disappear as fields. They live on the `Live` variant for
  exactly as long as a call is alive.
- Effects (`peer.disconnect()`, `wsClient.send(CallEndCommand)`,
  `conn.markEndedLocally()`) are returned from the reducer and applied by a
  thin shell in deterministic order. The "order matters" comment on
  `finishCall` becomes a property of the reducer's effect list, not of where
  fields happen to be nulled.

This is also the only way to honestly test the call lifecycle — today the
tests have to drive a stateful object through a maze of races; with a pure
reducer they can pin transitions to a table.

Do not paper over this with `Mutex`-guarding the existing fields. That keeps
the violation of principle 4 (mutable record in disguise) and makes the
concurrency contract worse, not better, by hiding it inside ad-hoc locks.

---

### C3. `finishCall` is the largest single concentration of side effects in the app, hidden behind a verb

**File:** `com/pimote/android/call/CallController.kt:323–360`

`finishCall(sessionId, reason, sendCallEnd, failureReason)`:

1. reads and writes `finished`,
2. reads and nulls `currentPeer`,
3. reads and nulls `currentConnection`,
4. fire-and-forget launches a coroutine to send `CallEndCommand`,
5. calls `peer.disconnect()`,
6. calls one of `markEndedLocally` / `markFailed` / `markEndedRemotely` on
   the connection (each of which itself runs two side effects — see M1),
7. assigns `_state.value = CallState.Ended(…)`.

**Principles violated:** 3 (`finish` does seven things, the name reveals none
of them), 5 (it's a void function whose entire purpose is mutation of shared
state and external side effects).

**Fix sketch:** under the reducer redesign in C2 this becomes "the reducer
moved to `Ended`; the effect list is `[notifyServer(sessionId), releasePeer,
notifyTelecom(reason)]`; apply them in order." The function `finishCall`
ceases to exist as such — the _decision_ lives in the reducer, the _effects_
are tiny, named functions (`sendCallEnd`, `releasePeer`,
`disconnectTelecom`) each doing exactly the thing their name says.

---

## Major

### M1. `CallConnection.mark*` are dishonest names — every one is `setDisconnected(…).destroy()`

**File:** `com/pimote/android/telephony/PimoteConnection.kt:63–76`,
`com/pimote/android/telephony/CallConnection.kt:15–35`.

```kotlin
override fun markFailed(reason: String) {
    setDisconnected(DisconnectCause(DisconnectCause.ERROR, reason))
    destroy()
}
override fun markEndedRemotely(reason: CallEndReason) {
    setDisconnected(DisconnectCause(mapEndReasonToDisconnectCause(reason)))
    destroy()
}
override fun markEndedLocally() {
    setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
    destroy()
}
```

**Principle violated:** 3. The user-level guide explicitly bans `mark*` as a
name for a function that does anything beyond setting one named property.
These functions tear down a Telecom connection — they don't "mark" anything.
The fact that the controller's docstring has to write
"`connection.markFailed("peer_failed")` → `Ended(sessionId, PEER_FAILED)`"
to describe the consequence is evidence the name doesn't carry it.

The interface comment even admits the lie indirectly: "The single place
[CallController] tells Telecom that an app-initiated end has fully torn the
call down — without it the self-managed `Connection` stays alive…". The name
"mark" doesn't convey "fully torn down".

`markActive` (calls `setActive()`) and `markRinging` (calls `setRinging()`)
_are_ honest — single named state transition, no extra effects — but they
should still be renamed for symmetry once the destructive siblings are
fixed.

**Fix sketch:** rename to verbs that describe the actual effect:

- `markFailed(reason)` → `disconnectWithError(reason)`
- `markEndedRemotely(reason)` → `disconnectAsRemoteEnded(reason)`
- `markEndedLocally()` → `disconnectAsLocalHangup()`
- `markActive()` → `reportActive()` (or leave; it's a single setter)
- `markRinging()` → `reportRinging()`

The pattern is: if the method _destroys_ the connection, the name should say
so. Telecom's own API uses `setDisconnected` + `destroy`; the abstraction
should not soften that into "mark".

---

### M2. `AppContainer.init` blocks capture `var` locals across `state.collect`

**File:** `com/pimote/android/app/AppContainer.kt:242–289` (three separate
launches, each with the same pattern).

```kotlin
applicationScope.launch {
    var prevOngoing = false
    callController.state.collect { s ->
        val ongoing = s !is CallState.Idle && s !is CallState.Ended
        if (ongoing && !prevOngoing) { CallForegroundService.start(appContext) }
        prevOngoing = ongoing
    }
}
// …and the proximity launch, and:
applicationScope.launch {
    var prevIdle = true
    callController.state.collect { s ->
        val nowIdle = s is CallState.Idle
        if (prevIdle && !nowIdle) { appContext.startActivity(intent) }
        prevIdle = nowIdle
    }
}
```

Same pattern again inside `CallControllerImpl.init` at lines 256–267 with
`var routerActive = false`.

**Principle violated:** 2 (the lambda owns a mutable local across resumptions
and reads/writes it). These ones are single-coroutine so there is no race in
practice — but they're textbook examples of the pattern the principle bans,
and they're the wrong tool: edge detection on a Flow has a first-class
operator.

**Fix sketch:** `Flow.distinctUntilChangedBy { it is CallState.Idle ||
it is CallState.Ended }.scan(... ) { prev, cur → Pair(prev?.second, cur) }`
or just `Flow.runningFold(false) { prev, cur → …; emit }`. The intent —
"detect a true-to-false edge" — is `.map { … }.distinctUntilChanged().collect
{ on → if (on) start() else stop() }`. Same for `prevIdle`.

---

### M3. `WsClientImpl` holds the connection lifecycle in seven `@Volatile var` fields

**File:** `com/pimote/android/net/WsClient.kt:157–164`

```kotlin
private var currentOrigin: String? = null
@Volatile private var currentConnection: WsTransport.Connection? = null
private var loopJob: Job? = null
private var netJob: Job? = null
@Volatile private var delayJob: Job? = null
@Volatile private var attempt = 0
@Volatile private var disconnected = false
```

**Principles violated:** 4 (a connection-lifecycle record modelled as
independent fields), 2 (`connectionLoop`, `observeNetwork`, and `scheduleRetry`
all read and mutate `attempt`, `disconnected`, `currentConnection`,
`delayJob` across coroutine resumptions).

**Why "Major" not "Critical":** unlike `CallControllerImpl`, every public
mutator on `WsClientImpl` (`connect`, `disconnect`) is `@Synchronized`, and
the internal mutations are scoped to a single long-running loop coroutine
plus one network-observer coroutine. The races are real but bounded, and
`@Volatile` makes the observed values legal under the JMM. The structural
problem is still that "what state is the WS in" is six fields, not one.

**Fix sketch:** the same reducer-and-effects shape as C2, scaled down: a
`sealed class WsLifecycle { Disconnected, Connecting(origin, attempt),
Connected(connection, origin), Reconnecting(attempt, delayJob, origin) }` in
a single `MutableStateFlow`. `connect`/`disconnect`/network-event handlers
become atomic `update { reduce(state, event) }`. `attempt` lives on
`Reconnecting`. `currentConnection` lives on `Connected`. There stop being
race windows because there stop being independent fields to race over.

---

### M4. `CallControllerImpl.onAppShutdown` is non-suspending and has the same races it pretends to defend against

**File:** `com/pimote/android/call/CallController.kt:382–419`

The method snapshots fields to locals, nulls the fields, _then_ runs side
effects on the locals. The comment claims this makes it idempotent. It does
not, in any meaningful sense — two concurrent invocations can both reach the
snapshot before either nulls, and both will run the teardown on the same
peer/connection. The peer's own `disconnect` is documented as idempotent, so
the practical damage is small, but the structural argument is the same as C2:
the only correct fix is to push the state into a single atomic value.

**Principles violated:** 2, 3 (the name is fine for an Android lifecycle
hook, but the body does six unrelated things — send, release mic, destroy
Telecom, cancel coroutines, complete hangup deferred, reset state).

**Fix sketch:** falls out of C2. Under the reducer, this becomes:
`internal.update { reduce(it, Event.AppShutdown) }; runEffects(effects)`. The
effects list is identical to a user hangup, modulo the connection-disconnect
cause — express the difference in the reducer, not by hand-writing a
parallel teardown.

---

### M5. `CallForegroundService` reaches into `AppContainer.instance` from `onStartCommand` and from inside a coroutine, and tracks `collecting: Boolean`

**File:** `com/pimote/android/call/CallForegroundService.kt:47, 55, 74, 93, 90–119`

The `collecting: Boolean` field is captured-and-read across `scope.launch
{ … combine(…).collect { … } }`. The service also reaches `AppContainer.instance`
three times to fetch the controller / container. Once C1 is fixed (the
service grabs its container from `application`), the second issue goes away
on its own. The `collecting` field is a guard-once-per-process pattern that
should be a `if (scope.coroutineContext[Job]!!.children.none()) …` check or
simply moved to `onCreate` so it can't happen twice. Minor under M5 because
the service is short-lived and the field is touched only from the main
thread, but it still earns a flag.

---

## Minor

### m1. `SpeechmuxPeerImpl` has 12+ `private var` fields covering peer/track/signaling state

**File:** `com/pimote/android/voice/SpeechmuxPeerImpl.kt:88–116`

`peer`, `signalingSocket`, `audioSource`, `audioTrack`, `audioSender`,
`controlChannel`, `playheadJob`, `inboundAudioReceiver`, `lastReportedPlayhead`,
`muteRestoreToken`, `sessionFrameApplied`, `offerSent`, `remoteDescriptionSet`.

These are the state of a single WebRTC session and naturally belong on a
`Session` data class held in one `AtomicReference` or `Mutex`-guarded slot,
which would also let `disconnect` be a single atomic transition rather than a
sequence of nullings. Marked Minor because the file already uses a `Mutex`
for most of its work and the lifecycle is tightly scoped — it's a smell, not
a hazard. Worth folding into the same reducer-style refactor as C2 if it ever
gets touched.

### m2. `CallAudioRouter.active` and `speakerphoneRequested` are `@Volatile var` reached from listeners

**File:** `com/pimote/android/call/CallAudioRouter.kt:52–53`

Mitigated by `@Synchronized` on every public method, so the racy reads are
bounded to the `AudioDeviceCallback` early-return `if (!active) return`.
Worth modelling as a `sealed class State { Inactive, Active(requestedSpeaker:
Boolean) }` for symmetry with C2/M3 but not load-bearing.

### m3. `SessionRepositoryImpl.eventJob / stateJob / bootstrapJob` are nullable `var`s

**File:** `com/pimote/android/session/SessionRepository.kt:221–223`

Standard "store the cancellation handle in a field" pattern. Could be a
single `SupervisorJob` parented from `scope` and cancelled wholesale. Not a
real correctness issue — flagged for consistency with C2/M3, since the
underlying pattern ("the lifecycle is a state machine smeared across fields")
is the same.

### m4. `ContactSyncRunner.job` / `ShortcutsRunner.job` — same as m3

**Files:** `com/pimote/android/contacts/ContactSyncRunner.kt:50`,
`com/pimote/android/shortcuts/ShortcutsRunner.kt:36`.

Single nullable `Job?`. Same recommendation as m3.

### m5. `OkHttpWsTransport.socket: WebSocket?` — single `@Volatile var`

**File:** `com/pimote/android/net/OkHttpWsTransport.kt:28`

Bottom-of-the-stack adapter over OkHttp's callback API. The mutable field is
the result of an inherently stateful native API. Acceptable, but the same
"connection is a state, not a nullable field" argument as M3 applies; the
field would be cleaner on a `sealed class Connection { Opening, Open(socket),
Closed }` value.

### m6. Logging tag string `"Call"` / `"Audio"` repeated everywhere; not a principle violation, ignored.

---

# Principle 6 — Business logic lives in one place

Second pass against the new sixth principle (added to the user-level
AGENTS.md): if the same logical operation is reachable from multiple code
paths, the _doing_ of it lives in exactly one function and every entry path
routes to it with arguments. Structural duplication, not textual — and
differences between branches become parameters, not justification for copies.

The finding that motivated the principle in the first place is still present
in the code, in `CallControllerImpl.onAppShutdown`. Beyond that, the worst
offender is a UI call-dispatch helper that has a self-admitted twin in
`CallByPimoteUri`.

## Critical

### C4. `CallControllerImpl.onAppShutdown` reimplements `finishCall` instead of routing through it

**File:** `com/pimote/android/call/CallController.kt:382–419` vs
`com/pimote/android/call/CallController.kt:323–360` (`finishCall`).

The controller has a single canonical teardown helper, `finishCall`, that
every other terminal branch routes through:

- the two `BIND_FAILED` early returns,
- the `peer.connect` failure return,
- the three outcomes (`RemoteEnded`, `PeerFailed`, `UserHangup`) of the
  in-`Active` race,
- the pre-Active branches of `endCurrentCall`.

`onAppShutdown` does not. It open-codes its own variant of the same
operation:

```kotlin
override fun onAppShutdown() {
    val peer = currentPeer
    val conn = currentConnection
    val sid = currentSessionId
    currentPeer = null
    currentConnection = null
    currentSessionId = null
    callJob?.cancel()
    callJob = null
    userHangup?.complete(Unit)
    userHangup = null
    if (sid != null) {
        scope.launch {
            try { wsClient.send(CallEndCommand(id = newId(), sessionId = sid)) } catch (_: Throwable) { }
        }
    }
    try { peer?.disconnect() } catch (_: Throwable) { }
    try { conn?.markFailed("app_shutdown") } catch (_: Throwable) { }
    _state.value = CallState.Idle
}
```

Compare against `finishCall`, which already does _exactly_ this sequence —
send `CallEndCommand`, disconnect the peer, tell Telecom — and which is the
only place the rest of the controller permits the sequence to happen.

**Principle violated:** 6. This is the canonical case from the principle
statement: “two or more branches open-coding the same teardown will drift,
and the bug surfaces only on the rarer path.” The drift is already visible:

- `finishCall` for `USER_HANGUP` calls `conn.markEndedLocally()` (Telecom
  `LOCAL` cause). `onAppShutdown` calls `conn.markFailed("app_shutdown")`
  (Telecom `ERROR` cause). The user swiping away the app is a local hangup,
  not an error; the only reason this isn't visibly wrong is that the user
  doesn't see the Telecom log entry.
- `finishCall` flips state to `CallState.Ended(sessionId, reason)`.
  `onAppShutdown` flips it to `CallState.Idle`, skipping the `Ended`
  observable transition that `AppContainer`'s subscribers (notification
  start/stop, in-call activity launch, proximity lock) all use to detect
  end-of-call. The notification service handles the `Idle` case, so this
  works _today_ — but every other terminal path emits `Ended` first, and
  whoever next subscribes to `state` expecting an `Ended` will silently
  break on app-shutdown.
- `finishCall` is guarded by the `finished` flag (idempotent). `onAppShutdown`
  is not — it relies on snapshot-then-null-fields to claim idempotence, which
  is the violation of principle 4 in C2 wearing a different hat. If
  `endCurrentCall` is in flight and races `onAppShutdown`, both teardown
  sequences run and `CallEndCommand` is sent twice.

The differences between `onAppShutdown` and a normal user hangup are exactly
what the principle calls “parameters of the one function, not justification
for keeping two copies”:

1. After `onAppShutdown` the process is dying, so the terminal state can
   reasonably be `Idle` rather than `Ended` to avoid races with subscribers
   that haven't been torn down yet — but that is a one-bit parameter.
2. The Telecom cause should be `LOCAL` (the user dismissed the app); using
   `ERROR` was a bug.

**Fix sketch:** delete the open-coded sequence. Replace `onAppShutdown`'s
body with:

```kotlin
override fun onAppShutdown() {
    finishCall(
        sessionId = currentSessionId,
        reason = CallEndReason.USER_HANGUP,
        sendCallEnd = currentSessionId != null,
        // terminate quickly without leaving an Ended observable behind
        terminalState = CallState.Idle,
    )
    callJob?.cancel(); callJob = null
    userHangup?.complete(Unit); userHangup = null
}
```

— adding a single `terminalState: CallState = CallState.Ended(sessionId,
reason)` parameter to `finishCall`. The `callJob` cancellation and the
`userHangup.complete` belong outside the helper because they're
coroutine-bookkeeping unrelated to the business operation. Everything else
flows through the one function and drift becomes impossible.

(Under the reducer refactor proposed in C2 this drops out for free: an
`Event.AppShutdown` reducer arm returns the same effect list as
`Event.UserHangup` with a `terminalState = Idle` flag, and the shell applies
them.)

---

## Major

### M6. `ContactsScreen.placeCall` is an admitted duplicate of `CallByPimoteUri.placeCall`

**Files:**

- `com/pimote/android/ui/contacts/ContactsScreen.kt:327–338` — `private fun
placeCall(context, sourceId)`.
- `com/pimote/android/shortcuts/CallByPimoteUri.kt:24–69` — `object
CallByPimoteUri { fun placeCall(context, pimoteUri, telecom) }`.

The duplication is not just real, it is explicitly acknowledged in code.
`CallByPimoteUri`'s class docstring says:

> Mirrors the inline implementation at `ui/contacts/ContactsScreen.placeCall`
> so URI construction round-trips through `Uri.fromParts(scheme, ssp, null)`
> and `PhoneAccountRules.parseDialUri` continues to decode the inbound
> percent-encoded form on the ConnectionService side.

Both functions:

1. Look up `TelecomManager`.
2. Build a `ComponentName(PimoteConnectionService::class.java)`.
3. Build the `PhoneAccountHandle(component, PIMOTE_SERVICE_HANDLE_ID)`.
4. Build the URI via `Uri.fromParts(PIMOTE_URI_SCHEME, ssp, null)`.
5. Stuff the handle into `extras` as `EXTRA_PHONE_ACCOUNT_HANDLE`.
6. Call `tm.placeCall(uri, extras)`.

The sole differences:

- `ContactsScreen.placeCall` takes the SSP (`session:xxx` / `project:xxx`)
  directly; `CallByPimoteUri.placeCall` takes the full `pimote:…` URI and
  strips the prefix before doing the same `Uri.fromParts`.
- `CallByPimoteUri.placeCall` is defensive (`PhoneAccountRules.parseDialUri`
  validation, null `TelecomManager` guard, `SecurityException` / `Throwable`
  catch); `ContactsScreen.placeCall` lets exceptions bubble out into the
  caller's `try/catch` for snackbar display.

**Principle violated:** 6. “Two entry paths, both reach the same Telecom
operation, both build the same intent locally.” The two helpers will drift
— in fact they already differ in how they validate the URI, which is a
latent bug: a malformed `handleId` from a `ContactsRow` would slip past the
UI helper but be rejected by the shortcut helper.

**Fix sketch:** delete `ContactsScreen.placeCall`. Have `ContactsScreen`
call `CallByPimoteUri.placeCall(context, "pimote:$handleId",
container.telecomFacade)` and turn its boolean return into the snackbar /
spinner-clear path the UI needs. The `SecurityException` is already squashed
inside `CallByPimoteUri`, so the UI needs to surface the “false” return as
the failure case — either change the return type to a sealed result
(`Dispatched` / `RejectedUri` / `NoTelecomManager` / `Denied(SecurityException)`
/ `Threw(Throwable)`) so the caller can render the right snackbar, or leave
`CallByPimoteUri` to log and have the UI just show a generic “Couldn't place
call” on `false`.

The “build the Telecom intent for a pimote URI” operation must live in one
place; the principle is explicit that this is the structural fix, not a
style nit.

---

## Minor

### m7. `WsClientImpl`'s connection-loop cleanup duplicates `teardown()`

**File:** `com/pimote/android/net/WsClient.kt:191–263` (loop) vs `194–207`
(`teardown`).

`teardown(failPending: Boolean)` is the canonical “drop the current
connection” operation: cancel `delayJob` / `loopJob` / `netJob`, close
`currentConnection`, null it out, and fail pending requests. It is called
from `connect()` (with `failPending = true`) and from `disconnect()`.

The inner connection loop, after a connection drops or fails, does its own
shortened version of the same operation inline:

```kotlin
try { conn.close() } catch (_: Throwable) { }
if (currentConnection === conn) currentConnection = null
failAllPending()
if (disconnected) break
scheduleRetry()
```

It would not be unreasonable for the loop's per-iteration cleanup to share
the close/null/fail-pending sequence with `teardown` via a smaller helper —
e.g. `releaseConnection(conn: WsTransport.Connection, failPending: Boolean)`
that both `teardown` and the loop call. Today the two write the same
sequence out by hand, with subtly different ordering (`teardown` cancels
jobs before closing the socket; the loop is inside the job and skips that
step).

**Principle violated:** 6, lightly. It's a single sequence of three effects
in two places — small, but the next person to add e.g. a per-connection
metrics flush will have to remember both sites.

**Fix sketch:** extract `releaseConnection(conn, failPending)` that does
`conn.close()` + null out `currentConnection` if it's still the same
instance + `if (failPending) failAllPending()`. Both `teardown` and the
loop's per-iteration cleanup call it.

(This is also a pre-cursor to M3's larger structural fix: once the
connection lifecycle is a single value, “release the connection on this
transition” is one reducer-effect.)

### m8. `endCurrentCall` pre-Active vs Active branches differ in `sendCallEnd` choice

**File:** `com/pimote/android/call/CallController.kt:262–280` and `544–559`.

The pre-Active branch of `endCurrentCall` calls
`finishCall(sid, USER_HANGUP, sendCallEnd = sid != null)`, while the
in-`Active` UserHangup outcome inside `runOutgoing` calls
`finishCall(sessionId, USER_HANGUP, sendCallEnd = true)`. Both are correct
as written (the Active branch only reaches that point with a non-null
`sessionId`), but the _decision_ “do we tell the server?” is now made in two
places with two different formulations.

**Principle violated:** 6, very lightly. The duplication is not of an
operation but of a _policy_: “send `CallEndCommand` iff a session was
bound.”

**Fix sketch:** make the policy live on `finishCall` — drop the
`sendCallEnd` parameter entirely and let `finishCall` derive
`sendCallEnd = (sessionId != null && reason != BIND_FAILED &&
reason != REMOTE_HANGUP && reason != SERVER_ENDED && reason != DISPLACED)`.
The table of “who already knows” sits in one place. Callers just pass the
reason; the policy of when to notify the server is the helper's job.

---

## What the audit did _not_ find as a violation

- The reducer-style code that already exists in
  `com/pimote/android/session/SessionRepository.kt` (`reduceSessionEvent`,
  `SessionSnapshot`, `SessionEffect`) is exactly the shape the rest of the
  app should be moving toward. It is principle 4/5 done well.
- `client/`-side Compose state, e.g. `MainActivity.currentRoute by
mutableStateOf(...)`, is the Compose-sanctioned state primitive and is
  scoped to the activity instance, not global. Not a violation.
- `CallStateHelpers.kt`, `callNotificationStatusText`, `shouldHoldProximityLock`
  and similar — these are exactly the "pure helper computes the new value"
  shape principle 5 endorses.
