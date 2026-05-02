# Android — Handle voice-call displacement (`session_closed { reason: 'displaced' }`)

## Context

When another client takes over a session that has an active voice call (via
`call_bind { force: true }`), the server emits `session_closed { reason:
'displaced' }` on the displaced client's WS. The PWA observes this and
synthesises a local `call_ended { reason: 'displaced' }` so its voice store
tears down (`client/src/lib/stores/voice-call-store.ts`).

The native Android client does **not** handle `session_closed` at all —
`Protocol.kt`'s polymorphic deserializer doesn't know the type, and
`CallController` only observes `CallEndedEvent`. Result: a displaced
Android call sits in `CallState.Active` forever, Telecom keeps the
audio mode in `MODE_IN_COMMUNICATION`, and the mic stays hot until the
user hangs up manually.

Telecom can't help here: displacement is signalled over the pimote
application WebSocket, not over the SIP/Telecom plane.

## Architecture

**Decision: extend `CallController.runOutgoing`'s select-race with a
fourth branch.** No event injection / no synthesised events.

Considered alternative: synthesise a `CallEndedEvent` and pump it into
`wsClient.events`, mirroring the PWA's
`voice-call-store.handleServerEvent({ type: 'call_ended', … })` shortcut.
Rejected because:

- `wsClient.events` is a `SharedFlow` produced by `WsClientImpl`; injecting
  synthetic events from outside the producer requires a new seam and risks
  desynchronising tests.
- The Android `CallController` is the only consumer of voice events
  today, so localising the policy there has no downside.
- A second observer can be added later (e.g. an in-call analytics
  subscriber) without changing the WS layer.

The new branch listens for `SessionClosedEvent { reason == DISPLACED &&
sessionId == currentSessionId }` and resolves the select with
`Outcome.RemoteEnded(CallEndReason.DISPLACED)`. The existing
`Outcome.RemoteEnded` cleanup path (`markEndedRemotely` →
`peer.disconnect()` → `Ended(sessionId, DISPLACED)`) covers the rest —
no further plumbing needed.

### Scope notes

- **Only `reason == 'displaced'` triggers teardown.** Mirrors PWA. `killed`
  and `replaced` are not actively handled; if the agent session vanishes
  the WebRTC peer will fail organically and `Outcome.PeerFailed` covers
  it. Adding explicit handling for `killed`/`replaced` is a future
  decision once we have a concrete UX requirement.
- **Pre-Active displacement** (`Dialing` / `Binding` / `Negotiating`)
  is out of scope. In those phases the bind RPC or `peer.connect` will
  fail on its own; layering displacement detection on top adds complexity
  for a window measured in tens of milliseconds.

## Interface changes

### `mobile/android/app/src/main/kotlin/com/pimote/android/protocol/Protocol.kt`

Add the wire type and reason enum, mirroring `shared/src/protocol.ts`:

```kotlin
enum class SessionClosedReasonWire {
    @SerialName("displaced") DISPLACED,
    @SerialName("killed") KILLED,
    @SerialName("replaced") REPLACED,
}

@Serializable
@SerialName("session_closed")
data class SessionClosedEvent(
    val sessionId: String,
    val reason: SessionClosedReasonWire? = null,
    override val type: String = "session_closed",
) : PimoteEvent
```

Register `"session_closed" -> SessionClosedEvent.serializer()` in
`PimoteEventSerializer.selectDeserializer`. Other consumers
(`SessionRepository`) already discard unknown event types via the
`UnknownPimoteEventTypeException` filter, so adding the type is
backwards-compatible. `reason` is nullable to tolerate older servers
or non-displacement closes that omit the field.

### `mobile/android/app/src/main/kotlin/com/pimote/android/call/CallController.kt`

Add an import for `SessionClosedEvent` / `SessionClosedReasonWire`. In
the `Outcome` select inside `runOutgoing`, add a fourth `launch`:

```kotlin
val w4 = launch(Dispatchers.Unconfined) {
    val ev = wsClient.events.filterIsInstance<SessionClosedEvent>()
        .filter { it.sessionId == sessionId && it.reason == SessionClosedReasonWire.DISPLACED }
        .first()
    winner.complete(Outcome.RemoteEnded(CallEndReason.DISPLACED))
}
// remember to cancel w4 alongside w1/w2/w3 once a winner is chosen.
```

No new state, no new `Outcome` variant — `RemoteEnded(DISPLACED)` is
already plumbed through to `markEndedRemotely` (mapping
`CallEndReason.DISPLACED → DisconnectCause.CANCELED` in
`PimoteConnection.mapEndReasonToDisconnectCause`).

## Tests

`mobile/android/app/src/test/kotlin/com/pimote/android/protocol/ProtocolJsonTest.kt`:

1. Round-trip `session_closed` with each reason (`displaced`, `killed`,
   `replaced`) and with `reason` omitted entirely. Verifies the
   serializer registration and the nullable `reason` field.

`mobile/android/app/src/test/kotlin/com/pimote/android/call/CallControllerTest.kt`:

1. **happy path** — start call, advance to `Active`, emit
   `SessionClosedEvent(sessionId="S1", reason=DISPLACED)`; assert
   `state = Ended(_, DISPLACED)`, `peer.disconnected = true`, and
   `connection.transitions` contains `endedRemotely:DISPLACED`.
2. **wrong-session ignored** — emit `SessionClosedEvent("S2",
DISPLACED)` while the call is on `S1`; assert state remains `Active`.
3. **null-reason ignored** — emit `SessionClosedEvent("S1", reason=null)`;
   assert state remains `Active` (other close reasons don't end the
   call).
4. **killed/replaced ignored** — same as #3 but with `KILLED` / `REPLACED`.
   Documents the deliberate scope choice.

The existing `FakeWsClient.emit(...)` already supports any `PimoteEvent`,
so no fakes need extending.

## Steps

1. Extend `Protocol.kt` (enum + class + registry entry).
2. Add `ProtocolJsonTest` round-trip cases.
3. Extend `CallController.runOutgoing` with the fourth select branch and
   ensure `w4.cancel()` runs alongside the other winners.
4. Add the four `CallControllerTest` cases above.
5. `make android-test` green.
6. `make android-build`, install on device, displace from PWA, confirm
   in logcat that `PimoteCall: state -> Ended(..., reason=DISPLACED)`
   fires within ~100 ms of the takeover and the system mic indicator
   clears.

## Out of scope

- Pre-Active displacement (Dialing / Binding / Negotiating).
- Handling of `killed` / `replaced`.
- WS-drop-during-call detection (separate item from the divergence
  report; can be tackled independently).
