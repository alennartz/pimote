# Review: Native Android client (v1)

**Plan:** `docs/plans/native-android-client.md`
**Diff range:** `98cf0a0..HEAD` (six commits under `mobile/android/`, ~1700 LOC added)
**Date:** 2026-05-01

## Summary

The plan was implemented faithfully across all 17 steps. Pure helpers (`PhoneAccountRules`, `reduceSessionEvent`), DTOs, and the four orchestration components (`WsClientImpl`, `SessionRepositoryImpl`, `PhoneAccountRegistrarImpl`, `CallControllerImpl`) match the architecture; 93/93 unit tests pass. The production wiring (OkHttp, ConnectivityManager, DataStore, stream-webrtc-android, Telecom) is straightforward. Test files are immutable since `pre-implementation-commit` (no changes under `mobile/android/app/src/test/`).

Five findings worth flagging — two plan deviations that affect documented behavior (`endCurrentCall` doesn't honor the pre-Active branch from step 6; the `InCallActivity` is missing the intent-filter step 16 prescribed), one off-spec default that silently changes runtime behavior (`request` timeout), and two correctness issues in the WebRTC/UI lifecycle (factory/EglBase leak per call, GlobalScope collector in `InCallActivity`). None are blockers for the v1 ship — risks #1–#4 from the plan remain explicitly accepted as deferred.

## Findings

### 1. `endCurrentCall` does not honor the pre-Active branch from the plan

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/call/CallController.kt:175-177`
- **Status:** resolved

Plan step 6 explicitly says:

> `endCurrentCall()` — complete the `userHangup` deferred. If state is pre-Active, also cancel `callJob` and transition to `Ended(currentSessionId, USER_HANGUP)`.

The implementation does only the first half:

```kotlin
override fun endCurrentCall() {
    userHangup?.complete(Unit)
}
```

The `userHangup` deferred is awaited only inside the post-`Active` `select` race (lines 222-242). If the user hangs up while the controller is in `Dialing`, `Binding`, or `Negotiating`, the deferred completes but is not observed; the call continues to issue `OpenSession`/`CallBind` requests, runs `peer.connect`, and waits for `call_ready` before honoring the hangup. If the server is slow or `peer.connect` blocks, the hangup is silently buffered indefinitely. The existing test only exercises the Active-state hangup branch, so this deviation isn't caught by the suite.

### 2. `InCallActivity` is missing the intent-filter prescribed by step 16

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `mobile/android/app/src/main/AndroidManifest.xml:30-35`
- **Status:** open

Plan step 16 requires:

> the app must register an activity with the `android.intent.action.MAIN` + `android.intent.category.CALL_LAUNCHER` filter and the `android:showWhenLocked`/`android:turnScreenOn` flags.

The manifest declares the activity with the two flags but no `<intent-filter>` at all:

```xml
<activity android:name=".ui.call.InCallActivity"
    android:exported="true"
    android:launchMode="singleTask"
    android:showWhenLocked="true"
    android:turnScreenOn="true" />
```

Nothing in the codebase explicitly starts `InCallActivity` either, so step 17's manual-smoke acceptance criterion ("place a call from contacts, see the in-call screen, tap hangup, screen dismisses") will not work as written — the call will progress through `Dialing → Binding → Negotiating → Active` invisibly. The exact intent vocabulary the plan named is unusual (the canonical Telecom path is the system in-call UI plus `setVideoState`/UI events on the `Connection`), so the implementer may have intentionally deferred this — but if so, that deviation deserves to be called out explicitly rather than silently dropped.

### 3. `WsClient.request` default timeout differs from architecture

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/net/WsClient.kt:111-118`
- **Status:** resolved

Plan architecture (line 96):

> `suspend fun <T> request(command: PimoteCommand, timeoutMillis: Long = 10_000): PimoteResponse<T>`

Implementation:

```kotlin
suspend fun <T> request(
    command: PimoteCommand,
    responseSerializer: KSerializer<T>,
    timeoutMillis: Long = Long.MAX_VALUE,
): TypedResponse<T>
```

All in-tree callers (`CallController`, `SessionRepositoryImpl`) rely on the default. With `Long.MAX_VALUE`, a server that drops the response without closing the socket will hang the call setup or the bootstrap forever instead of failing fast with `WsRequestTimeout`. The unit test passes an explicit short timeout, so the regression isn't caught. The 10 s default the plan specified was chosen deliberately for the mobile use case ("mobile expects to come back eventually" applies to the connect loop, not to in-flight commands).

### 4. `SpeechmuxPeerImpl` leaks `PeerConnectionFactory` and `EglBase` per call

- **Category:** code correctness
- **Severity:** warning
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/voice/SpeechmuxPeerImpl.kt:64-65, 261-272`
- **Status:** resolved

`AppContainer` constructs a fresh `SpeechmuxPeerImpl` per call via `peerFactory: () -> SpeechmuxPeer = { SpeechmuxPeerImpl(appContext) }`. Each instance lazily creates its own `PeerConnectionFactory` (which initializes the WebRTC native libs and allocates non-trivial native state) and `EglBase`. `disconnect()` releases the peer/track/source/socket but never disposes `factory` or `eglBase`:

```kotlin
override fun disconnect() {
    try { signalingSocket?.close(...) } ...
    try { peer?.close() } ...
    try { audioTrack?.dispose() } ...
    try { audioSource?.dispose() } ...
    scope.cancel()
    _state.value = PeerState.Closed
    // factory and eglBase remain
}
```

Over repeated calls within a single process the leaked native state accumulates. The conventional fix is to hoist `PeerConnectionFactory.initialize` and the factory itself into `AppContainer` (process-singleton) and pass a shared factory into each instance, then dispose `eglBase` and (optionally) the factory only when the process winds down. This is a real risk for users who place several calls per session — exactly the v1 use case.

### 5. `InCallActivity` uses `GlobalScope` for state observation

- **Category:** code correctness
- **Severity:** warning
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/ui/call/InCallScreen.kt:82-92`
- **Status:** resolved

```kotlin
@OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
kotlinx.coroutines.GlobalScope.launch {
    vm.state.collect { s ->
        if (s is CallState.Ended || s is CallState.Idle) runOnUiThread { finish() }
    }
}
```

The collector is never cancelled when the activity is destroyed; it leaks the coroutine and a strong reference to the activity through the captured `vm`/`runOnUiThread` lambda. After `finish()`, subsequent state emissions still call `finish()` on a destroyed activity (no-op, but kept alive by the ongoing collector). Standard fix is `lifecycleScope.launch { repeatOnLifecycle(STARTED) { ... } }`. Marked `@OptIn(DelicateCoroutinesApi)` — the implementer is aware this is delicate, but the canonical alternative is right there.

### 6. `scheduleRetry` declares an unused `parent` value

- **Category:** code correctness
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/net/WsClient.kt:202-211`
- **Status:** resolved

```kotlin
val parent = kotlinx.coroutines.coroutineScope { ... }
```

`parent` is never read. Dead binding; the `coroutineScope { ... }` block is what does the work. Trivially removable.

### 7. ContactsScreen disambiguation differs from registrar

- **Category:** code correctness
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/ui/contacts/ContactsScreen.kt:55-66`
- **Status:** resolved

The UI calls `disambiguateFolderLabels(projects.map { it.folderPath })` — projects only. The registrar feeds the union of project + session folder paths (`PhoneAccountRules.computeDesiredAccounts`), so a session whose folder isn't in the current `projects` snapshot gets `folderName` as the displayed prefix in the contact list while Telecom registers it under a disambiguated label. Cosmetic divergence; the user-visible label and the Telecom label can disagree on the same row. Easy to align by either using the same union, or extracting the prefix-resolver helper as the plan step 15 suggested ("extract as a UI helper").

## Plan Adherence Summary

- All 17 plan steps have corresponding implementations and are reflected in the diff.
- Test files (`mobile/android/app/src/test/...`) are unchanged from `98cf0a0..HEAD`. Test immutability respected.
- Risks #1–#4 from the architecture remain explicitly deferred; source comments in `PimoteApp.kt` and `SpeechmuxPeerImpl.kt` flag them as designed. Not findings.
- Reasonable adaptations not flagged: the `Root()` if/else in `MainActivity` standing in for the planned NavHost; the explicit reuse of `currentSessionId` instead of a passed argument in some helper paths; the `runCatching`/swallow patterns around best-effort `CallEnd` sends.

## Code Correctness Summary

The orchestration layer is the riskiest surface and is well-covered by the tests. The four issues above (1, 4, 5 are the substantive ones; 2 and 3 cross plan adherence + correctness; 6, 7 are nits) are all in the production-wiring/UI layer that the test suite intentionally doesn't reach. None of them are catastrophic — but #1 and #3 in particular can produce hangs that look like the app is misbehaving rather than failing, which is the worst diagnostic shape.
