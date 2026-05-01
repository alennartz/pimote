# Test Review: Native Android client (v1)

**Plan:** `docs/plans/native-android-client.md`
**Brainstorm:** `docs/brainstorms/native-android-client.md`
**Date:** 2026-05-01

## Summary

The pre-review test suite (72 tests) was solid on the pure-helper / DTO / state-machine layer — Backoff, Protocol JSON, PhoneAccountRules, SessionReducer, CallController — but left the three orchestration components (`WsClient`, `SessionRepository`, `PhoneAccountRegistrar`) untested even though the architecture explicitly built test seams (`WsTransport`, `NetworkAvailabilityMonitor`, `TelecomFacade`) to enable that. This review added 21 behavioral tests covering those orchestration paths, plus three small extensions to `CallControllerTest`. Final state: 93 tests total — 26 PASS (pure helpers / DTO / reducer) and 67 RED on `TODO()` placeholders, the expected post-test-write shape.

No non-deterministic tests, no over-specified assertions, no tests reaching into internals. All tests target component boundaries through the materialized interfaces.

## Findings

### 1. WsClient implementation orchestration was not tested

- **Category:** missing coverage
- **Severity:** critical
- **Location:** added `mobile/android/app/src/test/kotlin/com/pimote/android/net/WsClientTest.kt` (new, 9 tests)
- **Status:** resolved

The architecture deliberately defines two test seams — `WsTransport` and `NetworkAvailabilityMonitor` — explicitly so `WsClient` can be unit-tested without OkHttp / `ConnectivityManager`. No tests used them. The brainstorm specifically named "wait 16 s after coming back into wifi range" as a failure mode the network-aware reset prevents — that behavior had no regression test. Added a `WsClientImpl` constructor stub (consistent with the existing `CallControllerImpl` pattern) and a test file covering: request/response correlation by id, request timeout, in-flight request fails with `WsConnectionLost` on socket drop, events flow surfaces `PimoteEvent`s, unexpected close transitions to `Reconnecting(attempt, nextDelay)`, network-availability resumes immediately and resets backoff, `disconnect()` stops the reconnect loop permanently, `connect()` is idempotent for the same origin, and `connect()` with a different origin reconfigures.

### 2. SessionRepository orchestration was not tested

- **Category:** missing coverage
- **Severity:** critical
- **Location:** added `mobile/android/app/src/test/kotlin/com/pimote/android/session/SessionRepositoryImplTest.kt` (new, 4 tests)
- **Status:** resolved

`SessionReducerTest` covers the pure `reduceSessionEvent` step thoroughly, but the repository's responsibility for _acting on_ `SessionEffect.RefetchFolder`, bootstrapping (`ListFoldersCommand` then concurrent `ListSessionsCommand` per folder), and re-bootstrapping on `WsState` `Reconnecting → Connected` was uncovered. Added a `SessionRepositoryImpl` constructor stub and tests for: bootstrap on `start()`, `RefetchFolder` effect drives a `list_sessions` request and merges the result, WS reconnect re-bootstraps, and live events apply the pure reducer end-to-end.

### 3. PhoneAccountRegistrar live wiring was not tested

- **Category:** missing coverage
- **Severity:** critical
- **Location:** added `mobile/android/app/src/test/kotlin/com/pimote/android/telephony/PhoneAccountRegistrarImplTest.kt` (new, 5 tests)
- **Status:** resolved

`PhoneAccountRulesTest` covers the pure rules. The orchestration around them — debounce-500 ms before applying, diff-then-apply via `TelecomFacade`, `resolve()` lookup map — was uncovered. The architecture flagged "PhoneAccount registration churn" as a brainstorm-level concern that the 500 ms debounce explicitly addresses, so it deserves a regression test. Added a `PhoneAccountRegistrarImpl` constructor stub and tests for: bursty updates within the debounce window collapse to a single reconcile pass, the diff drives register / unregister / replace via the facade, removed sessions get unregistered, `resolve()` returns the right `AccountKind` for registered handles and `null` for unknown ones, and `stop()` best-effort unregisters everything.

### 4. CallController bind retry-also-fails was uncovered

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `mobile/android/app/src/test/kotlin/com/pimote/android/call/CallControllerTest.kt` — new test added inline
- **Status:** resolved

The plan's CallController flow says `call_bind_failed_owned` triggers a single retry with `force = true`. Test coverage existed for retry-then-success but not for retry-then-fail. Added a test that emits `OWNED` twice and asserts (a) only two `CallBindCommand`s are issued (no infinite loop), (b) state ends at `Ended(sessionId, BIND_FAILED)`, (c) `connection.markFailed` is called.

### 5. CallController wire→internal end-reason mapping was undertested

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `mobile/android/app/src/test/kotlin/com/pimote/android/call/CallControllerTest.kt` — new tests added inline
- **Status:** resolved

Pre-review tests covered only `CallEndReasonWire.SERVER_ENDED → CallEndReason.SERVER_ENDED`. Added tests for the other two cleanly-named mappings: `USER_HANGUP → USER_HANGUP` and `DISPLACED → DISPLACED`. The `ERROR` wire variant has no obvious 1:1 internal mapping (the internal enum has both `PEER_FAILED` and a generic `SERVER_ENDED` candidate), and the architecture/plan does not pin it. Left untested at this layer; the implementation phase should pick a mapping and add a test for it then. Noted to the implementer rather than blocking the review.

### 6. Settings interface has no tests

- **Category:** missing coverage
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/settings/Settings.kt`
- **Status:** dismissed

`Settings` is a trivial DataStore wrapper around a single `Config(pimoteOrigin)` value. The interface has three methods (`current`, `set`, `clear`); meaningful test coverage would require an Android test runner (DataStore is Android-resident). Dismissed: the persistence layer is more reasonably exercised by the manual-testing pass on a real device. Noted with the implementer's approval.

## Method Notes

- All new tests use `kotlinx.coroutines.test`'s `runTest` + `StandardTestDispatcher` for deterministic scheduling — no real time, no real I/O. Hand-rolled fakes (`FakeWsTransport`, `FakeNetworkMonitor`, `FakeRepo`, `FakeTelecom`) are kept colocated with their test files since they have no consumers outside that file.
- New impl stubs (`WsClientImpl`, `SessionRepositoryImpl`, `PhoneAccountRegistrarImpl`) follow the same pattern the test-write phase used for `CallControllerImpl`: constructor injection, every override is `TODO("not implemented")`, no behavior. The implementation phase fills them in.
- `make android-test` runs the full suite via the `pimote-android-builder:local` container.
