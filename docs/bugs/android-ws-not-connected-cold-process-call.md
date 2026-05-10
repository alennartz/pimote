# Bug: `WsConnectionLost` crash on cold-process outgoing call

**Surface:** Android client — `CallController.kt:326` (`CallControllerImpl.runOutgoing`)
**First observed device:** Pixel 8, Android 16
**Severity:** Crash — "Pimote Calls keeps stopping" system dialog. User-recoverable (just retry once the process has warmed up and the WS reconnected), but unfriendly.
**Pre-existing:** yes — race exists at `CallController.kt:326` independent of the `android-assistant-callable-projects` topic. Surfaced because the new entry points make cold-process dispatch the common case rather than the rare case.

## Summary

When the Android process is cold (Android killed it under memory pressure or it hasn't been launched since boot) and an outgoing Pimote call is dispatched via Telecom, `CallControllerImpl.runOutgoing` fires a WS `request(...)` before the `WsClient` has reconnected, throws `WsConnectionLost: not connected` at `WsClient.kt:347`, there's no catch handler in the call path, and the process is killed by the uncaught exception.

## Stack (paraphrased)

```
WsConnectionLost: not connected
    at WsClient.request (WsClient.kt:347)
    at CallControllerImpl.runOutgoing (CallController.kt:326)
    ... (called via PimoteConnectionService.onCreateOutgoingConnection)
```

## Why it surfaced now

Before `android-assistant-callable-projects`, the practical way to start a Pimote call was from the in-app `ContactsScreen` — which required the app to be foregrounded, which meant the WS was already connected by the time Telecom dispatched. The race at `CallController.kt:326` existed but was hard to hit.

The new entry points (`CallByNameActivity` for Assistant fulfillment, `CallByDataRowActivity` for the system contact-card path) let the user trigger an outgoing call from voice or contact card without ever bringing the app to the foreground first. Android can — and on Pixel 8 / Android 16 frequently does — launch the process cold just for the Telecom binding. The WS isn't connected yet when `onCreateOutgoingConnection` runs, the race is lost, the request throws, the process dies.

Net effect: a race that was previously rare is now the common case for the topic's primary user surfaces (voice and contact card → call).

## Repro

1. Force-stop the Android app (`adb shell am force-stop com.pimote.android`).
2. Verify the process is gone (`adb shell ps | grep pimote` returns nothing).
3. Trigger an outgoing call via Assistant: `adb shell am start -n com.pimote.android/.shortcuts.CallByNameActivity --es participantName fallback` (or via Google Assistant on-device).
4. **Expected:** the call dispatches once the WS has reconnected (with a brief delay), or fails gracefully with a user-visible message.
5. **Actual:** `WsConnectionLost: not connected` crash; "Pimote Calls keeps stopping" dialog; no call dispatched.

## Suggested fix sketch

`CallControllerImpl.runOutgoing` should not blindly fire a WS request. Options:

1. **Await WS connection with a timeout.** Suspend on a connection-ready signal (with a 5–10 s timeout). On timeout, complete the Telecom connection with `DisconnectCause.ERROR` and surface a Toast or in-call message ("Pimote server unreachable"). This preserves the call attempt for warm-process cases (which suspend trivially) and degrades gracefully for cold-process cases where the server is unreachable.
2. **Eagerly start WS reconnection at process launch.** Wire `WsClient` boot into the `Application.onCreate` path so the WS is connecting in parallel with whatever else is happening. Combined with (1), this minimizes the cold-call delay.
3. **Catch and fail the call cleanly.** As a minimum, wrap the `request(...)` call site in a try/catch that completes the Telecom connection with `DisconnectCause.ERROR` instead of letting the exception escape. This stops the crash but doesn't fix the race per se.

The combination (1) + (2) is what the next iteration of `CallController` should land on; (3) alone is a defensible safety net to ship sooner.

## Out of scope for `android-assistant-callable-projects`

Recording this as a follow-up; the topic's user-facing voice and dialer surfaces work, and the crash predates the topic at the call site (`CallController.kt:326`). The topic just makes it easier to hit.
