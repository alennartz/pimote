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
- `mobile/android/app/src/test/kotlin/com/pimote/android/net/WsClientTest.kt` — `WsClientImpl` orchestration via `WsTransport` + `NetworkAvailabilityMonitor` seams: request/response correlation, timeout, drop-while-pending, events flow, reconnect transitions, network-aware resume, idempotent connect, origin-change reconfigure, disconnect halts the loop.
- `mobile/android/app/src/test/kotlin/com/pimote/android/session/SessionRepositoryImplTest.kt` — `SessionRepositoryImpl` orchestration: bootstrap on `start`, reaction to `SessionEffect.RefetchFolder`, reconnect-driven re-bootstrap, live event reduction.
- `mobile/android/app/src/test/kotlin/com/pimote/android/telephony/PhoneAccountRegistrarImplTest.kt` — `PhoneAccountRegistrarImpl` orchestration: 500 ms debounce, register/unregister/replace via `TelecomFacade`, `resolve()` lookup, `stop()` clears the registry.

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
- `call_bind_failed_owned` retry that itself fails ends with `Ended(sessionId, BIND_FAILED)` and only two `call_bind` commands are issued (no infinite loop).
- Wire-reason mapping for `call_ended`: `user_hangup → USER_HANGUP`, `displaced → DISPLACED`, `server_ended → SERVER_ENDED`. (`ERROR` mapping pinned during implementation.)

#### WsClient orchestration (`WsClientTest`)

- `request()` correlates the response to the outgoing command's `id`.
- `request()` throws `WsRequestTimeout` when no response arrives in time.
- An in-flight `request()` cancels with `WsConnectionLost` when the underlying socket drops.
- `events` flow surfaces decoded `PimoteEvent`s.
- An unexpected close transitions `state` to `Reconnecting(attempt=1, nextDelayMs >= 0)`.
- A `NetworkAvailabilityMonitor` `false → true` transition resets backoff and triggers an immediate reconnect attempt.
- `disconnect()` stops the reconnect loop permanently; no further `transport.open()` calls are made.
- `connect(origin)` is idempotent for the same origin.
- `connect(otherOrigin)` reconfigures and reopens against the new origin.

#### SessionRepository orchestration (`SessionRepositoryImplTest`)

- `start()` issues `ListFoldersCommand` then concurrent `ListSessionsCommand` per folder, merging into the `projects` and `sessions` `StateFlow`s.
- Reducer-emitted `SessionEffect.RefetchFolder` drives a `list_sessions` request for that folder; the response merges into `sessions`.
- A `WsState` transition `Reconnecting → Connected` re-bootstraps.
- Live events apply the pure reducer end-to-end (a `session_opened` event appears in `sessions`).

#### PhoneAccountRegistrar orchestration (`PhoneAccountRegistrarImplTest`)

- A burst of updates within the 500 ms debounce window collapses to one reconcile pass.
- The reconcile diff drives `register` / `unregister` / unregister+reregister (replace on label change) on `TelecomFacade`.
- Sessions removed from the repository are unregistered from Telecom.
- `resolve(handleId)` returns the appropriate `AccountKind` for both project and session handles, and `null` for unknown ids.
- `stop()` unregisters all currently-registered handles best-effort.

**Review status:** approved (see `docs/reviews/native-android-client-tests.md`).

## Steps

**Pre-implementation commit:** `98cf0a0248e0c1780ee244c2b5a3b07c26ca21c1`

All steps run inside the `pimote-android-builder:local` container. `make android-test` runs unit tests; `make android-build` runs `assembleDebug`. The pre-existing 26 PASS tests cover `BackoffTest`, `ProtocolJsonTest`, and `SessionReducerTest` for the _opened_ event path that's already trivially `null`-handled — they should keep passing after every step. The remaining 67 RED tests gate each step's verification.

### Step 1: Implement `PhoneAccountRules` pure helpers

Fill the bodies of `sanitize`, `disambiguateFolderLabels`, `projectHandleId`, `sessionHandleId`, `computeDesiredAccounts`, and `diff` in `mobile/android/app/src/main/kotlin/com/pimote/android/telephony/PhoneAccountRegistrar.kt` per the KDoc on each function and the architecture's sanitization/disambiguation rules.

Notes for the implementer:

- `sanitize` must truncate to **graphemes**, not codepoints — use `java.text.BreakIterator.getCharacterInstance()` so emoji ZWJ sequences count as one. The test pins this with an emoji string.
- `projectHandleId` uses `java.util.Base64.getUrlEncoder().withoutPadding()` over UTF-8 bytes of the path.
- `disambiguateFolderLabels` walks up segment-by-segment until **all** colliding labels become unique; non-colliding paths in the same input keep their basename (the three-way test pins this).
- `computeDesiredAccounts` propagates the disambiguated folder prefix into both project labels (`folderName`) and session labels (`folderName/sessionName`); session label uses the disambiguated prefix as `folderName`. Drop entries whose label sanitizes to empty. `null` sessionName falls back to a stable non-empty placeholder (e.g. `"untitled"`).
- `diff` partitions the `desired` keyset versus `current` keyset: keys only in desired → `toRegister`; only in current → `toUnregister`; in both with different labels → `toReplace`; identical entries omitted.

**Verify:** `make android-test` — all of `PhoneAccountRulesTest` (≈20 cases) goes green. No other tests regress.
**Status:** done

### Step 2: Implement `reduceSessionEvent`

Fill the body of `reduceSessionEvent` in `mobile/android/app/src/main/kotlin/com/pimote/android/session/SessionRepository.kt` per the KDoc table. Pure function — no I/O, no coroutines. Project list is never modified.

Reductions per event:

- `SessionOpenedEvent` → append `SessionMeta(sessionId, folder.path, folder.name, name = null, archived = false)`; idempotent on duplicate `sessionId`.
- `SessionRenamedEvent` → update `name` on the matching row; no-op when absent.
- `SessionArchivedEvent(archived = true)` → drop the row.
- `SessionArchivedEvent(archived = false)` → drop the row from the snapshot AND emit `SessionEffect.RefetchFolder(folderPath)`.
- `SessionDeletedEvent` → drop the row; no-op when absent.
- `SessionReplacedEvent` → swap `oldSessionId` for `newSessionId` preserving `folderName`/`name`/`archived`; no-op when old row is absent.
- All other event types (incl. unknown, call\_\*, session_state_changed, session_closed) → return `ReducerResult(snapshot, emptyList())` unchanged.

**Verify:** `make android-test` — all of `SessionReducerTest` goes green.
**Status:** done

### Step 3: Implement `WsClientImpl` orchestration

Flesh out `WsClientImpl` in `mobile/android/app/src/main/kotlin/com/pimote/android/net/WsClient.kt` against the existing `WsTransport` and `NetworkAvailabilityMonitor` seams. State machine driven by a single coroutine on the constructor-injected `scope`.

Key internal shape:

```
private val _state = MutableStateFlow<WsState>(Disconnected)
private val _events = MutableSharedFlow<PimoteEvent>(extraBufferCapacity = 64)
private var currentOrigin: String? = null
private var currentConnection: WsTransport.Connection? = null
private var loopJob: Job? = null
private val pending = ConcurrentHashMap<String, CompletableDeferred<PimoteResponse>>()
private var attempt = 0
```

Behavior:

- `connect(origin)`: if `currentOrigin == origin` and `loopJob?.isActive == true`, return (idempotent). Otherwise cancel the existing loop, close the existing connection, set `currentOrigin = origin`, start a new `connectionLoop()` job on `scope`. URL is `${origin}/ws` (replace `http`/`https` scheme with `ws`/`wss`).
- `connectionLoop()`: outer loop while not explicitly disconnected. Each iteration: `_state.value = Connecting`; `transport.open(url)`; collect events. On `Event.Open` → `attempt = 0`, `_state.value = Connected`. On `Event.TextMessage` → decode envelope (try `PimoteResponse` first by checking for `success` field; fall back to `PimoteEvent` polymorphic deserialization, swallow `UnknownPimoteEventTypeException`). Responses fulfil the matching `pending[id]`; events are emitted on `_events`. On `Event.Closed` / `Event.Failed` → fail every pending request with `WsConnectionLost`, increment `attempt`, set `_state.value = Reconnecting(attempt, computeReconnectDelayMs(attempt, random))`, `delay(nextDelayMs)` and continue (or exit loop if disconnected).
- A separate child coroutine subscribes to `networkMonitor.available` and on a `false → true` transition resets `attempt = 0` and cancels the in-progress `delay()` so the loop reconnects immediately. Implement by storing the loop's `delayJob: Job?` and calling `delayJob?.cancel()`.
- `disconnect()`: set a `disconnected = true` flag, cancel `loopJob`, close `currentConnection`, fail all `pending` with `WsConnectionLost`, set `_state.value = Disconnected`.
- `send(command)`: serialize via `json.encodeToString(PimoteCommand.serializer(), command)`, write to `currentConnection`. Throw `WsConnectionLost` if not currently `Connected`.
- `request(command, serializer, timeoutMillis)`: register `CompletableDeferred<PimoteResponse>()` in `pending[command.id]`, send the command, then `withTimeoutOrNull(timeoutMillis) { def.await() }`; on null, remove the entry and throw `WsRequestTimeout`. Otherwise decode `response.data` with the caller-supplied `serializer` (handle `success = false` by returning `TypedResponse(id, false, null, error)` without throwing). On cancellation, remove the entry.

JSON: use the constructor-injected `json` and `PimoteEventSerializer` for events; `PimoteResponse.serializer()` for envelopes; `PimoteCommand.serializer()` for outbound (sealed-interface dispatch handles the `type` discriminator).

**Verify:** `make android-test` — all 9 cases in `WsClientTest` go green: `request correlates response by id`, `request times out`, `in-flight request fails with WsConnectionLost on socket drop`, `events flow surfaces server events`, `unexpected close transitions to Reconnecting with attempt counter`, `network availability resumes immediately resetting backoff`, `disconnect stops the reconnect loop`, `connect is idempotent for the same origin`, `connect with a different origin reconfigures`.
**Status:** not started

### Step 4: Implement `SessionRepositoryImpl` orchestration

Fill the body of `SessionRepositoryImpl` in `mobile/android/app/src/main/kotlin/com/pimote/android/session/SessionRepository.kt`.

Internal shape:

```
private val _projects = MutableStateFlow<List<ProjectMeta>>(emptyList())
private val _sessions = MutableStateFlow<List<SessionMeta>>(emptyList())
private var eventJob: Job? = null
private var stateJob: Job? = null
```

Behavior:

- `start()` — launch (a) an event collector that calls `reduceSessionEvent` for each event, applies the resulting snapshot to `_projects`/`_sessions`, and dispatches each emitted `SessionEffect.RefetchFolder` via a follow-up `wsClient.request(ListSessionsCommand)` whose response merges into `_sessions`; (b) a state-watcher that observes `wsClient.state` and on a `Reconnecting → Connected` transition calls `refresh()`; (c) the initial bootstrap by calling `refresh()` once.
- `refresh()` — `wsClient.request(ListFoldersCommand(id = uuid()), ListFoldersResponseData.serializer())`. Set `_projects` from response. Then `coroutineScope { folders.map { f -> async { wsClient.request(ListSessionsCommand(id = uuid(), folderPath = f.path, includeArchived = false), ListSessionsResponseData.serializer()) } }.awaitAll() }` and union the returned sessions into `_sessions`. ⚠️ Sequence note for tests: the test scripts ListFolders response first, then list*sessions per folder \_in folder order*; issuing the list_sessions calls in `folders` iteration order satisfies this because each `async` enqueues its `request()` (and thus its pending entry) before the next.
- `stop()` — cancel both jobs.

Merging rule for refetch: replace any existing rows with `folderPath == f.path` with the freshly-returned ones (preserve other folders' rows untouched).

Use `java.util.UUID.randomUUID().toString()` for command ids — there's no test seam needed here.

**Verify:** `make android-test` — all 4 cases in `SessionRepositoryImplTest` go green.
**Status:** not started

### Step 5: Implement `PhoneAccountRegistrarImpl` orchestration

Fill the body of `PhoneAccountRegistrarImpl` in `mobile/android/app/src/main/kotlin/com/pimote/android/telephony/PhoneAccountRegistrar.kt`.

Internal state:

```
private val resolved = mutableMapOf<String, AccountKind>()
private var job: Job? = null
```

Behavior:

- `start()` — launch a single coroutine on `scope` that combines `repository.projects` and `repository.sessions` into a `Pair`, debounces by `debounceMs` via `kotlinx.coroutines.flow.debounce`, then on each emission:
  1. Build inputs (`PhoneAccountRules.ProjectInput`, `PhoneAccountRules.SessionInput`).
  2. `desiredMap = PhoneAccountRules.computeDesiredAccounts(...)`.
  3. `current = telecom.registeredAccounts()` — current label map = `current.mapValues { it.value.label }`.
  4. `desiredLabels = desiredMap.mapValues { it.value.label }`.
  5. `ops = PhoneAccountRules.diff(currentLabels, desiredLabels)`.
  6. Apply: `toUnregister + toReplace` first → `telecom.unregisterPhoneAccount(id)` and drop from `resolved`. Then `toRegister + toReplace` → `telecom.registerPhoneAccount(Account(handleId, label, shortDescription))` and store `resolved[handleId] = desiredMap[handleId]!!.kind`.
- `stop()` — cancel `job`; iterate over `resolved.keys.toList()` and call `telecom.unregisterPhoneAccount(id)`; clear `resolved`.
- `resolve(handleId)` — return `resolved[handleId]`.

Note: `combine + debounce` from `kotlinx.coroutines.flow` is `@FlowPreview` in 1.8.x — annotate the method with `@OptIn(kotlinx.coroutines.FlowPreview::class)`.

**Verify:** `make android-test` — all 5 cases in `PhoneAccountRegistrarImplTest` go green.
**Status:** not started

### Step 6: Implement `CallControllerImpl` state machine

Fill the body of `CallControllerImpl` in `mobile/android/app/src/main/kotlin/com/pimote/android/call/CallController.kt`.

Internal state:

```
private val _state = MutableStateFlow<CallState>(CallState.Idle)
private var callJob: Job? = null
private var connection: CallConnection? = null
private var peer: SpeechmuxPeer? = null
private var currentSessionId: String? = null
```

`startOutgoing(target, connection)` cancels any existing `callJob` and launches a new one on `scope` that runs the pseudocode from the architecture's `CallController` section:

1. `_state = Dialing(target)`. Save `connection`. Construct `peer = peerFactory()`.
2. Resolve `sessionId`: `ExistingSession` → use directly; `NewSessionInProject(path)` → `wsClient.request(OpenSessionCommand(id = uuid(), folderPath = path), OpenSessionResponseData.serializer())`. On failure: `connection.markFailed(error ?: "open_session_failed")`, `_state = Ended(null, BIND_FAILED)`, return.
3. `_state = Binding(sessionId)`. `currentSessionId = sessionId`. Issue `wsClient.request(CallBindCommand(id = uuid(), sessionId, force = false), CallBindResponseData.serializer())`. On `error == CallBindErrorCodes.OWNED` retry **once** with `force = true`. Other failures (incl. retry-also-failed): `connection.markFailed(error ?: "call_bind_failed")`, `_state = Ended(sessionId, BIND_FAILED)`, return.
4. `_state = Negotiating(sessionId)`. `try { peer.connect(signalUrl, sessionId) } catch (PeerConnectionFailed)` → best-effort `wsClient.send(CallEndCommand(uuid(), sessionId))` (swallow exceptions), `connection.markFailed("peer_failed")`, `_state = Ended(sessionId, PEER_FAILED)`, return.
5. Await `call_ready` for `sessionId`: `wsClient.events.filterIsInstance<CallReadyEvent>().filter { it.sessionId == sessionId }.first()`. (At this point `peer.state == Connected` already because `peer.connect` only returns then.) `connection.markActive()`. `_state = Active(sessionId)`.
6. While `Active`, race three concurrent watchers (use `select` or three child coroutines that all cancel siblings on first to resolve):
   - `wsClient.events.filterIsInstance<CallEndedEvent>().filter { it.sessionId == sessionId }.first()` → `connection.markEndedRemotely(mapped)`, `peer.disconnect()`, `_state = Ended(sessionId, mapWire(reason))`.
   - `peer.state.first { it is PeerState.Failed }` → best-effort `wsClient.send(CallEndCommand(...))`, `connection.markFailed("peer_failed")`, `_state = Ended(sessionId, PEER_FAILED)`.
   - User-hangup signal (set by `endCurrentCall()`): use a private `userHangup = CompletableDeferred<Unit>()` reset per call; awaited in this select. On completion → best-effort `wsClient.send(CallEndCommand)`, `peer.disconnect()`, `_state = Ended(sessionId, USER_HANGUP)`.

Wire mapping:

```
fun mapWire(w: CallEndReasonWire) = when (w) {
    CallEndReasonWire.USER_HANGUP -> CallEndReason.REMOTE_HANGUP
    CallEndReasonWire.DISPLACED -> CallEndReason.DISPLACED
    CallEndReasonWire.SERVER_ENDED -> CallEndReason.SERVER_ENDED
    CallEndReasonWire.ERROR -> CallEndReason.SERVER_ENDED
}
```

⚠️ The test `server call_ended maps wire user_hangup to USER_HANGUP` asserts `USER_HANGUP` (not `REMOTE_HANGUP`). Use `CallEndReasonWire.USER_HANGUP -> CallEndReason.USER_HANGUP` to match the test. Pin `ERROR` → `SERVER_ENDED` for now (test doesn't exercise it).

`endCurrentCall()` — complete the `userHangup` deferred. If state is pre-Active, also cancel `callJob` and transition to `Ended(currentSessionId, USER_HANGUP)`.

`onAudioStateChanged(_)` — store on a `MutableStateFlow<AudioRouteSnapshot?>` for UI consumption; no other side effects (per architecture).

**Verify:** `make android-test` — all 14 cases in `CallControllerTest` go green.
**Status:** not started

### Step 7: Implement production `WsTransport` over OkHttp

Add `mobile/android/app/src/main/kotlin/com/pimote/android/net/OkHttpWsTransport.kt` — a non-test-covered production binding behind the existing `WsTransport` interface.

Shape:

```
class OkHttpWsTransport(private val client: OkHttpClient = OkHttpClient()) : WsTransport {
    override fun open(url: String): WsTransport.Connection { ... }
}
```

The `Connection` impl wraps `okhttp3.WebSocket` and a `MutableSharedFlow<WsTransport.Event>` whose events are pumped by an `okhttp3.WebSocketListener` (`onOpen` → `Open`; `onMessage(text)` → `TextMessage(text)`; `onClosed` → `Closed`; `onFailure` → `Failed`). `send(text)` calls `WebSocket.send(text)`. `close(code, reason)` calls `WebSocket.close(code, reason ?: "")`.

**Verify:** `make android-build` succeeds — file compiles.
**Status:** not started

### Step 8: Implement production `NetworkAvailabilityMonitor` over ConnectivityManager

Add `mobile/android/app/src/main/kotlin/com/pimote/android/net/AndroidNetworkAvailabilityMonitor.kt`.

Shape:

```
class AndroidNetworkAvailabilityMonitor(context: android.content.Context) : NetworkAvailabilityMonitor {
    override val available: Flow<Boolean> = callbackFlow { ... }
}
```

Uses `ConnectivityManager.NetworkCallback` registered via `registerDefaultNetworkCallback` to emit `true` on `onAvailable` and `false` on `onLost`. Replay-1 `MutableStateFlow` upstream so consumers see the current value on subscription.

**Verify:** `make android-build` succeeds.
**Status:** not started

### Step 9: Implement production `Settings` over DataStore

Add `mobile/android/app/src/main/kotlin/com/pimote/android/settings/SettingsImpl.kt`.

Shape:

```
class SettingsImpl(
    context: Context,
    private val scope: CoroutineScope,
) : Settings {
    private val store: DataStore<Preferences> = ...preferencesDataStore("pimote_settings")
    private val originKey = stringPreferencesKey("pimote_origin")
    private val _current = MutableStateFlow<Settings.Config?>(null)
    override val current: StateFlow<Settings.Config?> = _current.asStateFlow()
    init { /* prime _current from store */ }
    override suspend fun set(config: Settings.Config) { ... }
    override suspend fun clear() { ... }
}
```

No unit tests scoped — behavior is ~5 lines of DataStore access.

**Verify:** `make android-build` succeeds.
**Status:** not started

### Step 10: Implement production `SpeechmuxPeer` over stream-webrtc-android

Add `mobile/android/app/src/main/kotlin/com/pimote/android/voice/SpeechmuxPeerImpl.kt`. Backed by `org.webrtc.PeerConnectionFactory` from `io.getstream:stream-webrtc-android`.

Key wiring (per architecture's `SpeechmuxPeer` section):

- `PeerConnectionFactory.initialize()` once via a static `init {}` block on the impl (or in `AppContainer`).
- `connect(signalUrl, sessionId)`:
  1. Open a signaling `WebSocket` (OkHttp) to `signalUrl`.
  2. Wait for the `session` envelope; apply TURN credentials via `peer.setConfiguration`.
  3. Buffer locally-produced ICE candidates until the `session` frame arrives, then trickle them over the signaling socket.
  4. Add a local audio track (`AudioRecord` source=`VOICE_COMMUNICATION`).
  5. Create offer, set local desc, send to signaling. Apply remote answer.
  6. Suspend until `IceConnectionState.CONNECTED` → set `state.value = PeerState.Connected`. Throw `PeerConnectionFailed` on any signaling/ICE failure.
- `disconnect()` — close peer, signaling WS, mic. Idempotent.
- `setMicMuted(muted)` — `localAudioTrack.setEnabled(!muted)`.

No unit tests scoped (WebRTC requires native libs unavailable on the JVM unit-test classpath).

⚠️ **Risk flag:** the architecture's risk #2 (OEM Bluetooth route quirks) and risk #3 (speechmux `/signal` accepting plain requests) interact here — if signaling auth turns out to require a cookie/header, this is the file that grows. Don't plan around it.

**Verify:** `make android-build` succeeds.
**Status:** not started

### Step 11: Implement production `TelecomFacade` adapter

Add `mobile/android/app/src/main/kotlin/com/pimote/android/telephony/AndroidTelecomFacade.kt` implementing the `TelecomFacade` interface against the real `android.telecom.TelecomManager`.

Shape:

```
class AndroidTelecomFacade(
    private val context: Context,
    private val componentName: ComponentName, // PimoteConnectionService
) : TelecomFacade { ... }
```

- `registerPhoneAccount(account)` — build `PhoneAccountHandle(componentName, account.handleId)`; build `PhoneAccount.builder(handle, account.label).setShortDescription(account.shortDescription).setAddress(Uri.fromParts("pimote", account.handleId, null)).setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED).build()`; `telecomManager.registerPhoneAccount(...)`.
- `unregisterPhoneAccount(handleId)` — `telecomManager.unregisterPhoneAccount(PhoneAccountHandle(componentName, handleId))`.
- `registeredAccounts()` — query `telecomManager.selfManagedPhoneAccounts` (API 26+) and map into `Map<handleId, Account>`.

No unit tests scoped.

**Verify:** `make android-build` succeeds.
**Status:** not started

### Step 12: Implement `PimoteConnection` body

Fill the bodies of `PimoteConnection` in `mobile/android/app/src/main/kotlin/com/pimote/android/telephony/PimoteConnection.kt`.

Mappings:

- `markRinging()` → `setRinging()`
- `markActive()` → `setActive()`
- `markFailed(reason)` → `setDisconnected(DisconnectCause(DisconnectCause.ERROR, reason))`; `destroy()`
- `markEndedRemotely(reason)` → `setDisconnected(DisconnectCause(mapEndReasonToDisconnectCause(reason)))`; `destroy()` — `USER_HANGUP/REMOTE_HANGUP → REMOTE`, `DISPLACED → CANCELED`, `SERVER_ENDED → REMOTE`, `PEER_FAILED → ERROR`, `BIND_FAILED → ERROR`.
- `onDisconnect()` → `callController.endCurrentCall()`; `setDisconnected(DisconnectCause(DisconnectCause.LOCAL))`; `destroy()`
- `onCallAudioStateChanged(state)` → if `state != null`, `callController.onAudioStateChanged(toSnapshot(state))` where the helper maps `CallAudioState.route` and `supportedRouteMask` into the `AudioRoute` enum.
- `onAbort()` → forward to `onDisconnect()`.

**Verify:** `make android-build` succeeds.
**Status:** not started

### Step 13: Implement `PimoteConnectionService.onCreateOutgoingConnection` + AppContainer wiring

Add `mobile/android/app/src/main/kotlin/com/pimote/android/app/AppContainer.kt` — manual DI singleton constructed in `PimoteApp.onCreate`. Owns: `applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)`, `Settings`, `WsClient` (with OkHttp transport + Android network monitor), `SessionRepository`, `PhoneAccountRegistrar` (with `AndroidTelecomFacade`), `CallController`, and a `peerFactory: () -> SpeechmuxPeer` lambda returning a fresh `SpeechmuxPeerImpl`. Exposes `instance` companion access for the framework-instantiated service to look itself up.

Fill `PimoteConnectionService.onCreateOutgoingConnection`:

1. Read `request.accountHandle.id`. Look up `AppContainer.instance.registrar.resolve(handleId)`.
2. If null → return a failed `Connection()` with `DisconnectCause(ERROR, "unknown account")`.
3. Map `AccountKind` to `SessionTarget`:
   - `AccountKind.Session(id, _, _)` → `SessionTarget.ExistingSession(id)`.
   - `AccountKind.Project(path, _)` → `SessionTarget.NewSessionInProject(path)`.
4. Construct `PimoteConnection(callController, target)`. Call `setInitializing()`, `setAudioModeIsVoip(true)`, `setConnectionCapabilities(CAPABILITY_MUTE or CAPABILITY_SUPPORT_HOLD)`, `setAddress(request.address, TelecomManager.PRESENTATION_ALLOWED)`.
5. `callController.startOutgoing(target, conn)`.
6. Return `conn`.

Fill `PimoteApp.onCreate` — instantiate `AppContainer`, store on companion, call `wsClient.connect(settings.current.value?.pimoteOrigin ?: return)`, call `sessionRepository.start()`, call `phoneAccountRegistrar.start()`. (When `pimoteOrigin == null`, defer until the setup screen sets it; observe `settings.current` and start when non-null.)

Update `mobile/android/app/src/main/AndroidManifest.xml`: add `android:name=".app.PimoteApp"` to the `<application>` element so the framework loads our subclass.

⚠️ **Risk flag:** architecture risk #1 (dead-app voice-intent routing). v1 deliberately ships without a foreground service. If manual testing shows Assistant fails to wake the app for voice intents, add a foreground service in v1.1 — but do NOT add `startForeground` here.

**Verify:** `make android-build` succeeds. All 67 RED unit tests now green. `make android-test` reports all 93 tests passing.
**Status:** not started

### Step 14: Setup screen (Compose, minimal)

Add `mobile/android/app/src/main/kotlin/com/pimote/android/ui/setup/SetupScreen.kt` and a `SetupViewModel` reading `Settings.current` and `WsClient.state`.

UI: single `OutlinedTextField` for `pimoteOrigin`, a `"Connect"` button that calls `settings.set(Config(origin))` then `wsClient.connect(origin)`, a connection-state line bound to `WsClient.state`, and a `"Test connection"` button that calls `sessionRepository.refresh()` and surfaces the result in a Snackbar. No theme work beyond the default Material3 theme.

Also add `MainActivity.kt` (`androidx.activity.ComponentActivity`) registered in the manifest with the `LAUNCHER` intent filter, hosting a single-screen NavHost: setup if `settings.current.value == null`, contacts otherwise.

**Verify:** `make android-build` succeeds. Manual: install APK, enter URL, see state become `Connected`.
**Status:** not started

### Step 15: Contacts screen (Compose, minimal)

Add `mobile/android/app/src/main/kotlin/com/pimote/android/ui/contacts/ContactsScreen.kt` and a `ContactsViewModel` reading `SessionRepository.projects` and `.sessions`.

UI: a `LazyColumn` rendering project rows then session rows. Each row shows the disambiguated label (use `PhoneAccountRules.disambiguateFolderLabels` + the same label rules as the registrar — extract as a UI helper). Tapping a row builds the `Uri.fromParts("pimote", handleId, null)` and calls `telecomManager.placeCall(uri, bundleOf(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE to PhoneAccountHandle(componentName, handleId)))`. Pull-to-refresh calls `sessionRepository.refresh()`.

**Verify:** `make android-build` succeeds. Manual: tap a row, see the system dialer launch via Telecom and an in-call screen appear.
**Status:** not started

### Step 16: In-call screen (Compose, minimal)

Add `mobile/android/app/src/main/kotlin/com/pimote/android/ui/call/InCallScreen.kt` and a `CallViewModel` reading `CallController.state` and exposing `endCall()` + `toggleMute()`.

UI: full-screen layout with the session label, a state line (`Dialing...` / `Binding...` / `Connected`), a mute toggle button, a hangup button (`endCall` → forwarded to `connection.onDisconnect()` semantics via `CallController.endCurrentCall()`), and a route display from the latest `AudioRouteSnapshot`. Gesture vocabulary (interrupt/abort/steer) deliberately omitted in v1 — see architecture §UI Surfaces. No Auto-side custom actions per architecture (custom in-call actions are deferred).

This screen is **launched by Telecom**, not by us — the app must register an activity with the `android.intent.action.MAIN` + `android.intent.category.CALL_LAUNCHER` filter and the `android:showWhenLocked`/`android:turnScreenOn` flags. Provide a thin `InCallActivity` that hosts the Compose screen and routes `CallController.state` transitions to `Idle/Ended` into `finish()`.

**Verify:** `make android-build` succeeds. Manual: place a call from contacts, see the in-call screen, tap hangup, screen dismisses.
**Status:** not started

### Step 17: Final compile + smoke

Run the full pipeline from a clean state:

- `make android-test` — all 93 unit tests pass.
- `make android-build` — `assembleDebug` succeeds; APK lands in `mobile/android/app/build/outputs/apk/debug/`.

**Verify:** the two commands above succeed cleanly. The APK installs on a stock-Android device, the setup screen accepts an origin, the contacts screen lists projects/sessions, and tapping a row places a call through Telecom that progresses through `Dialing → Binding → Negotiating → Active`. Risks #1–#4 from the architecture remain explicitly accepted and documented; no regressions hidden behind workarounds in this step.
**Status:** not started
