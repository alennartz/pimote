# DR-016: Native Kotlin + Compose for the Android client

## Status

Accepted

## Context

Following DR-013, the Android client is the v2 voice surface — required to stay in a call across screen lock and to integrate with Android Auto. Both capabilities live behind Android's telephony stack (`SelfManagedConnectionService`, `ConnectionService`, `PhoneAccount`, `TelecomManager`, `CallAudioState`).

The natural question at architect time was whether to use a cross-platform framework — Flutter, React Native, KMP, or .NET MAUI — to keep a future iOS client cheap. iOS / CarPlay is out of scope for v1.

## Decision

**Build the Android client as a single-platform native Kotlin app with Jetpack Compose.**

Telephony has no shared abstraction across cross-platform frameworks. `SelfManagedConnectionService` (Android) and `CallKit` + `CarPlay` (iOS) expose fundamentally different APIs; every Flutter / React Native / KMP / MAUI integration of either is a hand-rolled native plugin per platform. The only code that could be shared is the WS / state-machine / DTO layer, which is small.

Rejected alternatives:

- **Flutter, React Native, MAUI.** Buy nothing on the telephony layer (still need a native Android plugin); add a second language and a second debugger to a problem space (Telecom + WebRTC + OEM quirks) that already requires deep Android-specific debugging.
- **Kotlin Multiplatform.** Genuine sharing only pays off if iOS happens. Until it does, KMP adds module structure and Gradle complexity for no win. The protocol/state-machine layer can be lifted to shared Kotlin at the point iOS actually starts.
- **A WebView-hosted PWA wrapper.** Cannot drive `SelfManagedConnectionService` and cannot hold the mic open through screen lock — defeats both reasons the native client exists.

## Consequences

- iOS support, if it ever happens, is a separate codebase (or a future KMP migration of the protocol layer). The wire protocol stays the only contract; no client-side abstraction has been pre-built for sharing.
- The Android module lives at `mobile/android/` with its own Gradle project and its own Docker-based build (`pimote-android-builder:local`). It does not participate in the npm workspace.
- Hand-written Kotlin DTOs mirror the subset of `shared/src/protocol.ts` the client uses. Drift risk is mitigated by reciprocal `KEEP IN SYNC` header comments on both files. No codegen.
- Every Android Telecom and `stream-webrtc-android` example, sample, and Stack Overflow answer is in Kotlin — debugging stays close to the documentation surface for the riskiest layer.
