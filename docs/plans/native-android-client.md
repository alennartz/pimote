# Plan: Native Android client (v1)

## Context

Build a native Android client complementary to the PWA, optimized for sustained voice calls (PWAs lose mic on screen lock / app switch) and Android Auto integration (PWAs cannot integrate with car head units). Same wire protocol as the PWA, no server changes.

Brainstorm: [`docs/brainstorms/native-android-client.md`](../brainstorms/native-android-client.md).

## Architecture

### Brainstorm Supersession: Auth

The brainstorm's v1 auth section described an in-app Cloudflare Access OIDC flow (CustomTabs + cookie/header capture, persisted JWT, redirect handling on 401/302). During architect this was superseded: **auth is handled entirely at the network layer outside the app** (VPN, Tailscale, LAN, or any other network-level authentication the operator wires up). The app makes plain HTTP/WS requests to the configured pimote origin and does not implement OIDC, CustomTabs auth, cookie persistence, header injection, or service tokens. There is no `auth/` package and no Custom Tabs dependency. The Setup screen has a single field (pimote URL).

### Impacted Modules

- **Protocol (`shared/src/protocol.ts`)** — receives a comment block above the voice-call commands documenting that a Kotlin DTO mirror lives in `mobile/android/.../protocol/Protocol.kt` and any change to call-related types must be reflected there. Reciprocal comment in the Kotlin file points back. No type changes.
- **Server, Client (PWA), Panels, Voice** — unchanged. The native client is a new peer to the same voice-orchestrator + speechmux backend; existing modules treat it identically to the PWA.

### New Modules

#### `mobile/android` — Android client app

**Purpose.** Native Kotlin Android application. Voice-first, outgoing-only voice client targeting Android phone use and Android Auto. Complements the PWA; does not replicate its full chat/scrollback surface.

**Responsibilities.**

- Maintain a long-lived control connection to a configured pimote server.
- Mirror the server's session and project lists into Android Telecom as `PhoneAccount` registrations so sessions appear in the system contacts/dialer/Auto picker and respond to Google Assistant voice intents.
- Place outgoing voice calls — register the call with Android Telecom via `SelfManagedConnectionService`, perform the `call_bind` handshake, establish a WebRTC peer to speechmux, drive the in-call lifecycle.
- Provide three Compose UI screens: setup, contacts (phone-mode session picker), in-call screen.

**Dependencies.** None on the existing npm packages at runtime (separate Gradle project). Reads `shared/src/protocol.ts` only as a reference document for hand-written DTOs.

**Location.** `mobile/android/` — top-level folder inside the monorepo, independent Gradle project. Single Gradle module (`app`) for v1.

**Internal package layout (inside `app`).**

```
auth/         — (intentionally absent in v1; auth is handled at the network layer outside the app)
net/          — OkHttp WS client, reconnect/backoff, network-aware resume
protocol/     — hand-written Kotlin DTOs mirroring shared/src/protocol.ts subset
telephony/    — SelfManagedConnectionService, Connection impl, PhoneAccountRegistrar
voice/        — WebRTC peer (stream-webrtc-android) + speechmux signaling client
session/      — SessionRepository, sanitization/disambiguation rules
ui/setup/     — pimote URL config screen
ui/contacts/  — phone-mode contact list
ui/call/      — in-call screen + gesture island
app/          — Application class, AppContainer (manual DI), navigation
```

**DI:** manual constructor injection via a single `AppContainer` object. No Hilt for v1.

**Concurrency:** Kotlin coroutines + Flows throughout. `StateFlow` for held state, `SharedFlow` for events, structured concurrency with per-component `CoroutineScope`s tied to lifecycles. ViewModels expose `StateFlow<UiState>` to Compose; UI emits intents (UDF).

### Interfaces

> The Kotlin types below are pseudocode-precise enough for the test writer to materialize as real code. Where behavioral contracts are described in prose, those are part of the interface — tests must validate them.

#### Settings

Persistent app config. The user enters one value (pimote origin) on first launch.

```kotlin
interface Settings {
  data class Config(val pimoteOrigin: String)
  val current: StateFlow<Config?>          // null until setup completes
  suspend fun set(config: Config)
  suspend fun clear()
}
```

- Persisted via `DataStore`.
- `WsClient` and `SpeechmuxPeer` read `pimoteOrigin` from here.
- No auth fields. Auth is handled at the network layer outside the app (VPN, Tailscale, LAN, whatever the user wires up). All HTTP/WS traffic is plain.

#### WsClient

Pimote control connection. Always-on while the app is running; auto-reconnect with network-aware backoff.

```kotlin
sealed interface WsState {
  object Disconnected : WsState                                       // explicit disconnect()
  object Connecting : WsState
  object Connected : WsState
  data class Reconnecting(val attempt: Int, val nextDelayMs: Long) : WsState
  data class Failed(val reason: String) : WsState
}

interface WsClient {
  val state: StateFlow<WsState>
  val events: SharedFlow<PimoteEvent>

  fun connect(pimoteOrigin: String)         // idempotent; reconfigures if origin changes
  fun disconnect()
  suspend fun <T> request(command: PimoteCommand, timeoutMillis: Long = 10_000): PimoteResponse<T>
}
```

- WS endpoint: `${pimoteOrigin}/ws` (the existing pimote WS path).
- Wire format: JSON, identical to the PWA's wire. Top-level message is `PimoteResponse` (object with `success` field) or `PimoteEvent` (everything else; discriminated by `type`).
- `request()` generates a UUID for the command's `id`, registers a pending continuation in an internal map, sends the command, awaits the matching response. Cancellation removes the entry.
- After `connect(origin)` is called once, the client stays in a "should be connected" state. Any unexpected close transitions to `Reconnecting`, schedules a retry with **exponential backoff + jitter** (`min(30s, 0.5s * 2^attempt) ± 20% jitter`). No attempt cap — mobile expects to come back eventually.
- **Network-aware resume:** subscribes to `ConnectivityManager`. When the OS reports the network is back, resets backoff to zero and triggers an immediate reconnect attempt. Avoids the "wait 16s after coming back into wifi range" failure mode.
- `disconnect()` is the only way to stop the reconnect loop — explicit user signout / app teardown, not network blips.
- Singleton in `AppContainer`. Owns a `CoroutineScope` (`SupervisorJob` + `Dispatchers.IO`) tied to the application's lifetime, not any screen's.
- On reconnect, `events` flow continues seamlessly. In-flight `request()` calls resume with a `WsConnectionLost` exception — caller decides whether to retry.

#### Protocol DTOs

Hand-written Kotlin data classes in `protocol/Protocol.kt` mirroring the **subset** of `shared/src/protocol.ts` used by the v1 native client.

Required commands (client → server):

- `OpenSessionCommand` (used with `folderPath`-only to create a new session for project hotline calls)
- `ListFoldersCommand`, `ListSessionsCommand`
- `CallBindCommand`, `CallEndCommand`

Required response payloads:

- `OpenSessionResponseData` (returns `sessionId`)
- `CallBindResponse` (returns `webrtcSignalUrl`)
- `FolderInfo[]`, `SessionInfo[]`

Required events (server → client, `PimoteEvent` variants the client subscribes to):

- `CallBindResponse` (also flows as a response, but the protocol emits some related signaling as events; subscriber handles both shapes per the existing `voice-call-seams.ts` pattern)
- `CallReadyEvent`, `CallEndedEvent`, `CallStatusEvent`
- `SessionOpenedEvent`, `SessionRenamedEvent`, `SessionArchivedEvent`, `SessionDeletedEvent`, `SessionReplacedEvent`

Drift mitigation: matching comments at the top of `shared/src/protocol.ts` (TS side) and `protocol/Protocol.kt` (Kotlin side) reminding any modifier of voice-call types to update both. No codegen.

JSON serialization: `kotlinx.serialization` with `JsonContentPolymorphic` deserializers keyed off the `type` discriminator for events / commands.

#### SpeechmuxPeer

WebRTC leg to speechmux. One peer per call.

```kotlin
sealed interface PeerState {
  object Idle : PeerState
  object Connecting : PeerState
  object Negotiating : PeerState
  object Connected : PeerState
  data class Failed(val reason: String) : PeerState
  object Closed : PeerState
}

interface SpeechmuxPeer {
  val state: StateFlow<PeerState>
  suspend fun connect(signalUrl: String, sessionId: String)
  fun disconnect()
  fun setMicMuted(muted: Boolean)
}
```

- Backed by `org.webrtc.PeerConnection` from `io.getstream:stream-webrtc-android`.
- Signaling: WebSocket to `signalUrl`, JSON envelopes matching the existing speechmux contract used by the PWA (see `client/src/lib/stores/voice-call-seams.ts` for the reference protocol — `session` / SDP offer-answer / ICE candidate frames).
- Peer is constructed without `iceServers`; the `session` envelope from speechmux carries TURN credentials, applied via `setConfiguration` after receipt.
- ICE candidates buffered locally until the `session` frame arrives, then trickled. Same ordering constraint the PWA observes.
- Audio: `AudioRecord` with `MediaRecorder.AudioSource.VOICE_COMMUNICATION`, `AudioTrack` with `USAGE_VOICE_COMMUNICATION` — both managed by the WebRTC ADM. Single continuous stream for the call's lifetime; routing (earpiece / speaker / Bluetooth / wired / Auto) is owned by Android Telecom and the OS audio framework. Peer never tears down on route changes.
- `connect()` suspends until `state == Connected` (ICE established) or fails with a typed reason.
- `disconnect()` releases peer, signaling WS, and mic. Idempotent.
- Permissions: peer does **not** request `RECORD_AUDIO`. Caller (in-call UI / Connection) is responsible for ensuring permission is granted before `connect()`.

#### PhoneAccountRegistrar

Reconciles the live session/project list into Android Telecom as `PhoneAccount`s.

```kotlin
sealed interface AccountKind {
  data class Session(val sessionId: String, val folderName: String, val sessionName: String) : AccountKind
  data class Project(val folderPath: String, val folderName: String) : AccountKind
}

interface PhoneAccountRegistrar {
  fun start()
  fun stop()
  fun resolve(handleId: String): AccountKind?
}
```

**`PhoneAccountHandle.id` scheme.**

- Session: `"session:<sessionId>"`
- Project: `"project:<base64url(folderPath)>"`

**`PhoneAccount` construction.**

- `Address`: `Uri.fromParts("pimote", handleId, null)` — custom scheme (`tel:` is reserved for PSTN).
- Capabilities: `CAPABILITY_SELF_MANAGED` only.
- Label: sanitized display name.
- Short description: `"Pimote: <displayName>"`.

**Display names.**

- Session: `"<folderName>/<sessionName>"`.
- Project (hotline; calling it = create new session in that folder): `"<folderName>"`.

**Sanitization (applied in order).**

1. Trim leading/trailing whitespace.
2. Replace ASCII control chars (`\u0000`–`\u001F`) with single space.
3. Collapse runs of whitespace to one space.
4. Truncate to 50 graphemes (not codepoints).
5. If empty after sanitization → skip registration for that entity.

**Folder-name disambiguation.**

- When two or more `folderPath`s share the same basename, walk up the path one segment at a time on each colliding folder until labels are unique. Examples:
  - `/work/repo` and `/personal/repo` → `"work/repo"` and `"personal/repo"`.
  - Sessions inside disambiguated projects pick up the same prefix.
- Non-collided projects keep the basename only.

**Reconciliation.**

- Subscribes to `SessionRepository.sessions` and `.projects`. Combined upstream is **debounced 500ms** before reconciling, to avoid thrashing system UI on event bursts.
- On each emission, computes the desired account set, diffs against the currently-registered set:
  - Additions: `telecomManager.registerPhoneAccount(account)`.
  - Removals: `telecomManager.unregisterPhoneAccount(handle)`.
  - Label changes: unregister + reregister.
- Maintains `Map<String, AccountKind>` keyed by `handleId` to back `resolve()`.

**Lifecycle.**

- `start()` from `Application.onCreate` after `WsClient.connect()`. Reconciliation runs lazily as flows emit.
- `stop()` from `Application.onTerminate` and on user "clear settings" — best-effort unregistration.
- When the OS reaps the process without `stop()`, registered accounts persist in Telecom's database. They're cleaned up on the next launch's reconciliation pass — stale accounts may be visible until next launch. Accepted (per brainstorm).

#### PimoteConnectionService + PimoteConnection

Android Telecom entry point.

```kotlin
class PimoteConnectionService : ConnectionService() {
  override fun onCreateOutgoingConnection(
    connectionManagerPhoneAccount: PhoneAccountHandle?,
    request: ConnectionRequest
  ): Connection
  override fun onCreateIncomingConnection(...): Connection   // returns failed connection — outgoing-only in v1
}

class PimoteConnection(
  private val callController: CallController,
  private val target: SessionTarget
) : Connection() {
  // Telecom → app callbacks:
  override fun onDisconnect()
  override fun onCallAudioStateChanged(state: CallAudioState)
  override fun onAbort()
  override fun onReject()                                    // routed to onDisconnect
  override fun onAnswer()                                    // n/a, outgoing-only
  // (onHold / onUnhold deferred to v1.1)

  // App → Telecom transitions:
  fun markRinging()                                          // → setRinging()
  fun markActive()                                           // → setActive()
  fun markFailed(reason: String)                             // → setDisconnected(ERROR) + destroy()
  fun markEndedRemotely(reason: CallEndReason)               // → setDisconnected(...) + destroy()
}
```

- `onCreateOutgoingConnection` looks up the dialed `PhoneAccountHandle.id` in `PhoneAccountRegistrar.resolve()`; constructs a `PimoteConnection` with the appropriate `SessionTarget`; calls `setInitializing()` so Telecom shows "dialing"; sets `setAudioModeIsVoip(true)` and `setConnectionCapabilities(CAPABILITY_MUTE or CAPABILITY_SUPPORT_HOLD)`.
- Dependencies (`registrar`, `callController`) are looked up from `AppContainer` on first method call — Telecom instantiates the service via reflection, so we cannot inject through the constructor.
- Telecom drives audio-state changes via `onCallAudioStateChanged`; we forward to `CallController` for UI display only. No WebRTC pipeline manipulation on route change.
- `setAudioRoute(...)` is called by the in-call UI's route picker; Telecom handles the rest.
- **No `startForeground`.** A `SelfManagedConnectionService` with an active connection is sufficient to keep the process alive per Android telephony framework semantics.

#### CallController

Single orchestrator for the active call. Bridges WS, WebRTC, and `PimoteConnection`.

```kotlin
sealed interface SessionTarget {
  data class ExistingSession(val sessionId: String) : SessionTarget
  data class NewSessionInProject(val folderPath: String) : SessionTarget
}

sealed interface CallState {
  object Idle : CallState
  data class Dialing(val target: SessionTarget) : CallState
  data class Binding(val sessionId: String) : CallState
  data class Negotiating(val sessionId: String) : CallState
  data class Active(val sessionId: String) : CallState
  data class Ended(val sessionId: String?, val reason: CallEndReason) : CallState
}

enum class CallEndReason { USER_HANGUP, REMOTE_HANGUP, DISPLACED, SERVER_ENDED, PEER_FAILED, BIND_FAILED }

interface CallController {
  val state: StateFlow<CallState>
  fun startOutgoing(target: SessionTarget, connection: PimoteConnection)
  fun endCurrentCall()
  fun onAudioStateChanged(state: CallAudioState)             // forwarded from PimoteConnection
}
```

**Outgoing-call flow.**

```
startOutgoing(target, connection):
  state = Dialing(target)

  sessionId = when (target):
    ExistingSession(id) -> id
    NewSessionInProject(path) ->
      response = wsClient.request<OpenSessionResponseData>(OpenSessionCommand(folderPath = path))
      response.data.sessionId            // failure → connection.markFailed("open_session_failed"), Ended(null, BIND_FAILED)

  state = Binding(sessionId)
  bindResponse = wsClient.request<CallBindResponseData>(CallBindCommand(sessionId, force = false))
    // call_bind_failed_owned → retry once with force=true (single-owner displacement)
    // other failures → connection.markFailed(reason), Ended(sessionId, BIND_FAILED)
  signalUrl = bindResponse.data.webrtcSignalUrl

  state = Negotiating(sessionId)
  speechmuxPeer.connect(signalUrl, sessionId)                // suspends until ICE Connected or fails

  awaitBoth(call_ready_for_session, peer.state == Connected)
  connection.markActive()
  state = Active(sessionId)
```

**Concurrent event handling while in `Active`.**

- `call_ended { reason }` from server → `connection.markEndedRemotely(reason)` → `speechmuxPeer.disconnect()` → `state = Ended`.
- `SpeechmuxPeer.state == Failed` → best-effort `wsClient.send(CallEndCommand(sessionId))` → `connection.markFailed("peer_failed")` → `state = Ended`.
- `endCurrentCall()` (user hangup via `PimoteConnection.onDisconnect`) → best-effort `wsClient.send(CallEndCommand(sessionId))` → `speechmuxPeer.disconnect()` → `state = Ended`.

**WS subscription.**

- Long-lived collector on `wsClient.events`, filtering `call_*` events. Reduces them when `state.sessionId` matches; ignores stale events for prior calls.

**WS down during call.**

- If the WS drops during an active call, the call cannot survive — server-side ownership and signaling are gone. Surface as `PEER_FAILED`; the WS auto-reconnect loop continues independently for the next call.

**Lifetime.**

- Long-lived `AppContainer` singleton. State stays at `Idle` between calls. The held `PimoteConnection` reference is released on `Ended`.

#### SessionRepository

Held state for projects and unarchived sessions, driven by WS events.

```kotlin
data class ProjectMeta(val folderPath: String, val folderName: String)
data class SessionMeta(
  val sessionId: String,
  val folderPath: String,
  val folderName: String,
  val name: String?,
  val archived: Boolean
)

interface SessionRepository {
  val projects: StateFlow<List<ProjectMeta>>
  val sessions: StateFlow<List<SessionMeta>>           // unarchived only
  fun start()
  fun stop()
  suspend fun refresh()
}
```

**Bootstrap (on `start()` and on every WS reconnect).**

- `wsClient.request(ListFoldersCommand)` → seeds `projects`.
- For each folder, `wsClient.request(ListSessionsCommand(folderPath, includeArchived = false))` concurrently → unions into `sessions`.

**Live event reduction (subscribes to `wsClient.events`).**

| Event                                     | Action                                                     |
| ----------------------------------------- | ---------------------------------------------------------- |
| `session_opened`                          | Add a `SessionMeta` (folderName from `event.folder.name`). |
| `session_renamed`                         | Update `name` on matching `sessionId`.                     |
| `session_archived { archived: true }`     | Remove.                                                    |
| `session_archived { archived: false }`    | Re-fetch matching folder via `list_sessions` and merge.    |
| `session_deleted`                         | Remove.                                                    |
| `session_replaced`                        | Replace `oldSessionId` entry with `newSessionId` entry.    |
| `session_state_changed`, `session_closed` | Ignored (not displayed in v1 contact list).                |

**Reconnect handling.**

- On `WsState` transition `Reconnecting → Connected`, automatically calls `refresh()` to re-bootstrap. The global event firehose is not buffered for reconnect; the bootstrap snapshot is the convergence point.

**Folder set.**

- Bootstrap-only. New projects appear after reconnect or manual `refresh()`. The contacts UI offers pull-to-refresh; setup screen offers "test connection" which also calls `refresh()`.

**Lifetime.**

- Singleton in `AppContainer`. `start()` from `Application.onCreate` after `WsClient.connect()`.

### UI Surfaces (architectural sketch)

Three Compose screens. Detailed layout/gesture vocabulary deferred to implementation; architectural points only:

- **Setup** — single field (pimote URL) + connect button. Surfaces `WsClient.state` and a "test connection" action that calls `SessionRepository.refresh()`.
- **Contacts** — list rendered from `SessionRepository.projects` + `.sessions`. Each row calls into `TelecomManager.placeCall(account.address)` on tap. Phone-mode use; on Auto, the system contact picker handles this surface natively.
- **In-call** — full-screen, follows DR-015's pattern (full-screen calling mode with a bottom gesture island). Native Compose port of the visual concept; not a port of the Svelte component code. Mute button, hangup button, audio-route display surfaced from `CallAudioState`. Specific gesture vocabulary (interrupt / abort / steer-equivalent) decided during implementation against the actual gesture-island affordances.

Auto integration is fully delegated to `SelfManagedConnectionService` — no `CarAppService`, no Android for Cars App Library work in v1.

**Custom in-call actions deferred.** v1 ships only the standard Telecom capabilities (`CAPABILITY_MUTE | CAPABILITY_SUPPORT_HOLD`). Pimote-specific actions (interrupt, abort, steer-equivalents) are not exposed to Auto's call-control surface or steering-wheel hardware in v1. The brainstorm flagged this as possible via `Connection.sendConnectionEvent` / `Connection.setExtras` / `CallEndpoint`; deferred until the action vocabulary is settled. Phone-mode in-call screen may surface its own gesture vocabulary on-screen even while Auto sees only mute/hang.

### Risks (architect-level, decided to accept; flagged for implementation phase to monitor)

1. **Dead-app voice-intent routing.** "Hey Google, call pimote/X" may or may not route to a registered `PhoneAccount` when the app process is dead. v1 ships without a foreground service. If implementation testing reveals Assistant fails to wake the app for voice intents, add a foreground service in v1.1.

2. **OEM-skin Bluetooth/Auto routing quirks.** `SelfManagedConnectionService` + WebRTC has historical OEM-specific bugs (Samsung One UI, Xiaomi MIUI) around BT route switching. Stock Android (Pixel) is reliable. Verify on the actual target device early.

3. **Speechmux `/signal` accepting plain (non-cookie, non-token) requests.** Auth is handled at the network layer outside the app (VPN, Tailscale, LAN). Confirm the deployment topology actually exposes speechmux to the native client over the auth-free network path. If not, the user re-decides auth strategy.

4. **No live folder events.** New projects appear only after reconnect or manual refresh. Acceptable for v1 use.

### Technology Choices

- **Native Kotlin + Jetpack Compose.** Chosen over Flutter / React Native / KMP / MAUI because telephony (`SelfManagedConnectionService`) has no shared abstraction across cross-platform frameworks; with iOS out of scope for v1, abstraction tax buys nothing. Every Telecom example, sample, and SO answer is Kotlin. KMP would help only if iOS happens later — defer to that point and lift the protocol/state-machine layer at that time.
- **`io.getstream:stream-webrtc-android`** for WebRTC. Modern, actively maintained fork of Google's official libwebrtc Android bindings. The `org.webrtc` API surface is identical to the canonical one used in WebRTC samples worldwide.
- **OkHttp (`com.squareup.okhttp3:okhttp`)** for WebSocket and HTTP. Standard, ubiquitous, has built-in WS support.
- **`kotlinx.serialization`** for JSON — discriminated-union support via `JsonContentPolymorphic` matches the protocol's `type`-keyed shape cleanly.
- **`androidx.datastore:datastore-preferences`** for the small `Settings` config.
- **Manual DI** via a single `AppContainer` object — Hilt's annotation ceremony isn't justified at this size.
- **Single Gradle module.** No multi-module split for v1; reconsider if the project grows.

## Tests

**Pre-test-write commit:** `7781ea59a584fa19a965a2f08fa40419186223f2`

### Interface Files

- `mobile/android/settings.gradle.kts`, `mobile/android/build.gradle.kts`, `mobile/android/gradle.properties`, `mobile/android/app/build.gradle.kts`, `mobile/android/gradle/wrapper/*`, `mobile/android/gradlew`, `mobile/android/gradlew.bat`, `mobile/android/.gitignore` — Gradle skeleton for the new Android module (Kotlin 1.9.24, AGP 8.5.2, Compose, kotlinx.serialization, OkHttp, stream-webrtc-android, JUnit 5, kotlinx-coroutines-test, MockK).
- `mobile/android/app/src/main/AndroidManifest.xml` — manifest registering `PimoteConnectionService` and the v1 permission set (`INTERNET`, `RECORD_AUDIO`, `MANAGE_OWN_CALLS`, etc.).
- `mobile/android/app/src/main/kotlin/com/pimote/android/app/PimoteApp.kt` — `Application` class placeholder.
- `mobile/android/app/src/main/kotlin/com/pimote/android/settings/Settings.kt` — `Settings` interface + `Config` data class.
- `mobile/android/app/src/main/kotlin/com/pimote/android/protocol/Protocol.kt` — hand-written DTOs for `FolderInfo`, `SessionInfo`, `OpenSessionCommand`/`OpenSessionResponseData`, `ListFoldersCommand`/`ListSessionsCommand`, `CallBindCommand`/`CallEndCommand`, `CallBindResponseData`/`CallBindResponseEvent`, `CallReadyEvent`, `CallEndedEvent`/`CallEndReasonWire`, `CallStatusEvent`/`CallStatusWire`, `Session{Opened,Renamed,Archived,Deleted,Replaced}Event`, `PimoteResponse`, `CallBindErrorCodes`, plus a `JsonContentPolymorphicSerializer` for `PimoteEvent`.
- `mobile/android/app/src/main/kotlin/com/pimote/android/net/WsClient.kt` — `WsClient` interface + `WsState`, `WsConnectionLost`, `WsRequestTimeout`, `TypedResponse<T>`.
- `mobile/android/app/src/main/kotlin/com/pimote/android/net/Backoff.kt` — pure `computeReconnectDelayMs` schedule.
- `mobile/android/app/src/main/kotlin/com/pimote/android/net/WsTransport.kt` — `WsTransport` + `NetworkAvailabilityMonitor` test seams.
- `mobile/android/app/src/main/kotlin/com/pimote/android/voice/SpeechmuxPeer.kt` — `SpeechmuxPeer` interface + `PeerState` + `PeerConnectionFailed`.
- `mobile/android/app/src/main/kotlin/com/pimote/android/telephony/PhoneAccountRegistrar.kt` — `PhoneAccountRegistrar` interface + `AccountKind` sealed type + `PhoneAccountRules` pure-helpers (sanitize, disambiguateFolderLabels, computeDesiredAccounts, diff, projectHandleId, sessionHandleId).
- `mobile/android/app/src/main/kotlin/com/pimote/android/telephony/TelecomFacade.kt` — `TelecomFacade` test seam over `TelecomManager` keyed by handleId.
- `mobile/android/app/src/main/kotlin/com/pimote/android/telephony/CallConnection.kt` — `CallConnection` test seam over `android.telecom.Connection`.
- `mobile/android/app/src/main/kotlin/com/pimote/android/telephony/PimoteConnection.kt` — `PimoteConnection extends Connection implements CallConnection` (placeholder bodies).
- `mobile/android/app/src/main/kotlin/com/pimote/android/telephony/PimoteConnectionService.kt` — `ConnectionService` subclass (placeholder bodies).
- `mobile/android/app/src/main/kotlin/com/pimote/android/call/CallController.kt` — `CallController` interface + `CallState` sealed type + `SessionTarget`, `CallEndReason`, `AudioRouteSnapshot`, `AudioRoute`, plus a `CallControllerImpl` constructor stub for testing.
- `mobile/android/app/src/main/kotlin/com/pimote/android/session/SessionRepository.kt` — `SessionRepository` interface + `ProjectMeta`, `SessionMeta`, `SessionSnapshot`, `SessionEffect`, `ReducerResult`, and the pure `reduceSessionEvent` function.
- `shared/src/protocol.ts` — added a "KEEP IN SYNC WITH … Protocol.kt" header block listing every type the Kotlin mirror replicates. No type changes.

### Test Files

- `mobile/android/app/src/test/kotlin/com/pimote/android/net/BackoffTest.kt` — exhaustive coverage of the reconnect-delay schedule.
- `mobile/android/app/src/test/kotlin/com/pimote/android/protocol/ProtocolJsonTest.kt` — command encoding, response decoding, polymorphic event dispatch by `type`.
- `mobile/android/app/src/test/kotlin/com/pimote/android/telephony/PhoneAccountRulesTest.kt` — sanitization (whitespace, control chars, grapheme truncation, empty drops), folder-label disambiguation (basename, walk-up, three-way), handleId encoding (project base64url + session id), `computeDesiredAccounts` (label rules, prefix propagation, empty-drop), and the reconcile `diff` operations.
- `mobile/android/app/src/test/kotlin/com/pimote/android/session/SessionReducerTest.kt` — every `session_*` event reduction path including the unarchive `RefetchFolder` effect and the no-op cases.
- `mobile/android/app/src/test/kotlin/com/pimote/android/call/Fakes.kt` — hand-rolled `FakeWsClient`, `FakeSpeechmuxPeer`, `FakeCallConnection` used by the controller tests.
- `mobile/android/app/src/test/kotlin/com/pimote/android/call/CallControllerTest.kt` — outgoing-call state machine driven through every documented branch with `kotlinx-coroutines-test` (`runTest` + `StandardTestDispatcher`).

### Behaviors Covered

#### Backoff schedule (`computeReconnectDelayMs`)

- Rejects `attempt < 1`.
- Attempt 1 with midpoint random == base delay (500 ms).
- Doubles per attempt before saturation (500 → 1000 → 2000 → 4000 → 8000 → 16000).
- Saturates at `maxMs` (30 000 ms) for any attempt past the saturation point.
- Jitter at `random == 1.0` adds `+jitterFraction * base`; at `0.0` subtracts.
- Result is never negative even with extreme jitter fraction.
- Sweep across random seeds stays within `[0, maxMs * (1 + jitterFraction)]`.

#### Protocol DTOs (`ProtocolJsonTest`)

- `OpenSessionCommand`, `ListSessionsCommand`, `CallBindCommand`, `CallEndCommand` encode the right `type` discriminator and required fields.
- `PimoteResponse` decodes both `success: true` (with embedded `CallBindResponseData`) and `success: false` (with error code).
- `OpenSessionResponseData` decodes minimal payload.
- `PimoteEventSerializer` polymorphically dispatches on `type` to: `session_opened`, `session_renamed`, `session_archived`, `session_deleted`, `session_replaced`, `call_bind_response`, `call_ready`, `call_ended` (all four `CallEndReason` values), `call_status` (all four `CallStatus` values).
- Unknown `type` values throw `UnknownPimoteEventTypeException` carrying the offending discriminator.
- Missing `type` discriminator throws `IllegalArgumentException`.
- `CallBindErrorCodes` constants pin to the wire strings the server returns.

#### PhoneAccountRules

- `sanitize`: trims, replaces `\u0000`–`\u001F` with single space, collapses whitespace runs, truncates to 50 graphemes (ASCII and emoji), returns `null` for empty result (whitespace, empty, or all control chars).
- `disambiguateFolderLabels`: non-colliding basenames stay as basename; two-way collision walks up one segment; three-way collision walks up enough to disambiguate; non-colliding paths in a mixed set keep their basename.
- `sessionHandleId(id)` == `"session:<id>"`. `projectHandleId(path)` is `"project:<base64url>"` (no `+`/`/`/`=`), stable, and distinct per path.
- `computeDesiredAccounts`: emits both project and session entries; session label is `"<folderName>/<sessionName>"`; project label is `"<folderName>"`; disambiguated folder prefix propagates to session labels; entries that sanitize to empty are silently dropped; `null` sessionName falls back to a non-empty stable placeholder.
- `diff`: emits `toRegister` for handles only in desired, `toUnregister` for handles only in current, `toReplace` for label-changed handles, and is fully empty when current == desired.

#### SessionRepository event reducer (`reduceSessionEvent`)

- `session_opened` appends a new unarchived `SessionMeta`; idempotent on duplicate `sessionId`.
- `session_renamed` updates `name` on the matching row; no-op when sessionId unknown.
- `session_archived archived=true` removes the row.
- `session_archived archived=false` emits a `SessionEffect.RefetchFolder` for the folder path.
- `session_deleted` removes the row; no-op when sessionId unknown.
- `session_replaced` swaps `oldSessionId` for `newSessionId` preserving metadata; no-op when old row absent.
- Reduction never mutates the projects list.

#### CallController state machine

- `state` starts at `Idle`.
- `ExistingSession` target: `Idle → Dialing → Binding → (peer.connect → call_ready) → Active`; bind command issued for `sessionId` with `force = false`; peer asked to connect with the URL from the bind response; `connection.markActive()` called on transition to `Active`.
- `NewSessionInProject` target: issues `OpenSessionCommand(folderPath)` first, then proceeds with the bind using the returned `sessionId`.
- `call_bind_failed_owned` triggers a single retry with `force = true`; second success transitions to `Active`.
- Other bind failure codes (e.g. `session_not_found`) end with `Ended(sessionId, BIND_FAILED)` and `connection.markFailed`.
- `OpenSessionCommand` failure ends with `Ended(null, BIND_FAILED)` without ever issuing a `call_bind`.
- Peer-connect failure during `Negotiating` ends with `Ended(sessionId, PEER_FAILED)`, fires a best-effort `CallEndCommand`, and calls `connection.markFailed`.
- `call_ended` event for the active session triggers `connection.markEndedRemotely`, `peer.disconnect()`, and `Ended(sessionId, mappedReason)`.
- Peer state transitioning to `Failed` while `Active` ends with `Ended(sessionId, PEER_FAILED)` and a best-effort `CallEndCommand`.
- `endCurrentCall()` sends best-effort `CallEndCommand`, disconnects the peer, and ends with `Ended(sessionId, USER_HANGUP)`.
- Events whose `sessionId` doesn't match the controller's current call are ignored — `Active` state is preserved.
