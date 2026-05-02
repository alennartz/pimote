# DR-018: Sessions and projects register as Telecom PhoneAccounts

## Status

**Superseded by [DR-019](DR-019-sessions-and-projects-as-contactscontract-contacts.md).**

The central decision — "each unarchived session and each project registers as a self-managed `PhoneAccount`" — was wrong. Android Telecom caps PhoneAccount registrations at **10 per package**, and PhoneAccount is the wrong primitive entirely: it models a calling _service_ (a SIM, a VoIP line), not a callee. Manual testing immediately hit the cap (`IllegalArgumentException: cannot register phone account ... because the limit, 10, has been reached`). DR-019 supersedes this with the correct architecture: one Pimote service PhoneAccount, sessions and projects synced into ContactsContract under a Pimote AccountManager Account, dial routing via a `pimote:` URI scheme.

## Context

The native Android client's two driving use cases are sustained voice calls and Android Auto integration. Both want sessions to feel like calls — appearing in the system dialer, the Auto contact picker, and the recents list, and responding to "Hey Google, call pimote/X" voice intents. Hardware controls (mute, hangup on the steering wheel or head unit) should work without per-OEM custom code.

The Android telephony stack offers exactly this surface via `SelfManagedConnectionService` + `PhoneAccount` registration. The alternative path — a custom Auto UI via `CarAppService` and the Android for Cars App Library — is effectively a second app with its own Play review track.

A live session list can churn (forks, renames, archives, project creation) and the system Telecom database is not designed for high-rate registration thrash.

## Decision

**Each unarchived session and each project registers as a self-managed `PhoneAccount` via a single `PimoteConnectionService extends SelfManagedConnectionService`. Calling a session-account binds to that session; calling a project-account creates a new session in that folder and binds to it.**

Concretely:

- `PhoneAccountHandle.id` encodes intent: `"session:<sessionId>"` or `"project:<base64url(folderPath)>"`. `PhoneAccountRegistrar.resolve(handleId)` decodes them back into a `SessionTarget`.
- `PhoneAccountRegistrar` reconciles the live session/project lists from `SessionRepository` against the currently-registered set on a debounced (500 ms) flow combine, applying additions, removals, and label-change replacements via a thin `TelecomFacade` over `TelecomManager`.
- Display names use `<folderName>/<sessionName>` for sessions and `<folderName>` for projects, with a sanitization pipeline (control-char strip, whitespace collapse, 50-grapheme truncate, empty-drop) and folder-name disambiguation (walk up path segments until colliding basenames become unique).
- No `CarAppService`. No Android for Cars App Library. Auto integration is fully delegated to Telecom — `PhoneAccount`s appear automatically in Auto's native contact picker, in-call screen, recents, and Assistant voice intents.

Rejected alternatives:

- **Custom `CarAppService` Auto app.** A separate app surface with its own Play review process, its own UI vocabulary, and its own state-management code. Not justified until we've shipped the Telecom-only path and found something it can't do.
- **One `PhoneAccount` per pimote server, with sessions surfaced inside the in-call UI.** Defeats the use case — sessions don't appear in Auto's contact picker, voice intents can't target a specific session, and there's no system-level recents entry per session.
- **No Telecom integration; build a foreground-service WebRTC client with a custom UI.** Loses Auto integration entirely and requires re-implementing call-state UI for the lock screen and head unit.

## Consequences

- The app inherits the Telecom contract: outgoing calls go through `onCreateOutgoingConnection`; the in-call screen is launched by Telecom; audio routing (earpiece/speaker/Bluetooth/wired/Auto) is owned by the OS. The app must not tear down the WebRTC peer on route changes.
- Custom in-call actions ("interrupt", "abort", PWA-style gestures) are not surfaced to Auto's call-control surface or steering-wheel hardware in v1 — only the standard Telecom capabilities (`CAPABILITY_MUTE | CAPABILITY_SUPPORT_HOLD`). Phone-mode UI may surface its own gesture vocabulary on-screen even while Auto sees only mute/hang. The `Connection.sendConnectionEvent` / `setExtras` / `CallEndpoint` mechanisms are noted as the path for adding them later.
- Session and project list churn is real. The 500 ms debounce + diff-then-apply pattern is the regression boundary; `PhoneAccountRegistrarImplTest` exists specifically to pin it.
- When the OS reaps the app process without `stop()`, registered accounts persist in Telecom's database. They're cleaned up on the next launch's reconcile pass — stale accounts may be visible in the dialer until then. Accepted for v1.
- `SelfManagedConnectionService` interacts subtly with OEM Bluetooth/Auto routing on some skins (Samsung One UI, Xiaomi MIUI). Stock Android (Pixel) is the verified target; OEM quirks remain an explicit risk.
- No foreground service in v1. A `SelfManagedConnectionService` with an active connection is sufficient to keep the process alive while a call is bound. If "Hey Google, call pimote/X" fails to wake the app from a dead state, this is the v1.1 escalation path.
