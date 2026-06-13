# Android Auto Car App — Project/Session Call Picker

## The idea

Add a minimal Android Auto surface to the native Android client: a launcher tile on the
head unit that opens a Pimote screen listing projects. Tapping a project places a call
(new session in that project); a header action opens a recency-sorted list of existing
sessions to resume. The car screen is purely a **picker** — it constructs a `pimote:` dial
URI and hands it to the existing call machinery.

## Why (the real motivation)

The Assistant / voice-name path (App Actions, contacts-name sync, dynamic shortcuts) **has
never worked** for the user — spoken-name resolution never fires `placeCall`, on-phone or
in-car alike, across many attempts. Crucially, the **call path itself works in the car**:
tapping the in-app phone `ContactsScreen` while connected to Android Auto places a call and
routes audio correctly.

So the missing piece is not calling infrastructure — it is a **tap surface that lives on the
head unit**. Today the only tap surface (`ContactsScreen`) is in the phone app, which can't be
used while driving. A `CarAppService` screen is "the proven in-app tap UI, re-hosted on the
head unit," reusing the exact `CallByPimoteUri.placeCall` path already shown to work in the car.
This de-risks the feature: the one thing that could have killed it (self-managed call audio not
routing through Auto) is already disproven by real-world use.

## Key decisions

### Platform & framework: Car App Library template app (POI category)

- **Decision:** Build a `CarAppService` using the Android for Cars App Library
  (`androidx.car.app` + `app-projected`), declared under the **POI** category, rendering
  `ListTemplate` screens.
- **Why:** This targets **Android Auto** (phone projecting to the head unit), not Android
  Automotive OS (the car's built-in full-Android OS — not something we sideload to a phone).
  For third-party **non-navigation** apps on Android Auto, the Car App Library templates are
  the _only_ UI option — you don't get a free canvas. POI is the natural "browse a list, take
  an action" category.
- **Rejected — media-browse hack:** Spotify / Podcast Addict get unbounded sectioned lists
  because they're media apps on `MediaBrowserService`, a different framework. We could
  masquerade as a media app to inherit big lists, but then "playing" an item would have to
  secretly place a call, the now-playing UI expects media transport controls, and a
  `MediaSession` would fight our self-managed Telecom call for audio focus. Fragile and
  semantically wrong for a "minimal, reliable" calling picker. (Corroborated by the prior
  `docs/plans/android-auto-ui-exploration.md`, which calls the media route "abuse of category.")

### Distribution: sideload / personal, dev-mode enabled

- **Decision:** Ship as a sideloaded personal build; rely on Android Auto → Developer settings
  → "Unknown sources" so the tile appears on the Desktop Head Unit and in a real car.
- **Why:** Android Auto only grants launcher tiles to Google-_approved_ categories, and there is
  no third-party "calling/dialer" category — a custom calling template surface essentially won't
  pass Play Store review. The user confirmed personal/sideload is fine "for now." Play-Store
  shippability is explicitly out of scope.

### List length: recency-sort, accept the host content limit

- **Decision:** Sort projects (Screen 1) and sessions (resume list) by most-recent activity.
  Accept the host's `ConstraintManager` content limit; do not paginate manually.
- **Why:** Google's "Design for Driving" guidance: the list cap "will not be less than 6 and may
  be higher in some vehicles," and the cap tightens while _driving_, relaxes when _parked_. This
  matches real usage — while driving you want a short list of the most-recent things (you
  shouldn't scroll 30 items at speed); while parked the host lifts the limit and it scrolls.
  Recency-sorting guarantees the top slots are the useful ones.

### Purely additive

- **Decision:** Leave the existing (flaky) Assistant / shortcuts / contacts-sync machinery
  entirely in place and untouched. The car screen is a parallel, reliable path.
- **Why:** The user explicitly wants additive scope, not a rewrite/removal of the Assistant surface.

### UI structure: tap-to-call, sessions behind a header action

Driven by a hard constraint: **Car App Library template `Row`s have a single tap target** — no
inline secondary button like the phone `ContactsScreen`'s per-row call icon. One row = one tap =
one action.

- **Screen 1 — Project list** (`ListTemplate`): one row per project, recency-sorted; subtitle
  shows session count + last activity. **Tapping a project immediately places the new-session
  hotline call** (`pimote:project:<base64(folderPath)>`). One tap for the dominant case.
- **Header `ActionStrip` "Sessions" button → Screen 2 — Resume list** (`ListTemplate`): a **flat,
  recency-sorted** list of existing sessions (no per-project grouping). Title = session display
  name; subtitle = relative time. **Tapping a session resumes it** (`pimote:session:<id>`).
- **Why this shape:**
  - New call is the ~90% case → it gets the single tap. Resuming a specific session is rarer and
    more intentional ("I know which conversation I want") → it takes the deliberate 2-tap path via
    the header action, where a recency list surfaces it fast.
  - Single-tap-target constraint rules out the phone's dual-action rows, so a project row can be a
    _call button_ OR a _folder_, not both. The user chose call button.
  - Flat recency list (no grouping) chosen for the resume screen — simpler, and in a car you're
    picking by "what I was just doing," which recency already encodes.
- **Rejected — pure folder drill-down** (project tap → project screen with "New session" on top +
  nested sessions): keeps sessions nested but costs **two taps even for the common new call**. New-call
  dominance won.

### Call mechanics: picker only, reuse the proven path

- **Decision:** The car screens never implement call flow. They build the correct `pimote:` URI
  and call `CallByPimoteUri.placeCall`. The existing `PimoteConnectionService` →
  `PhoneAccountRules.parseDialUri` → `CallController` machinery already branches correctly.
- **Why (the two flows differ in exactly one step):** In `CallController.runOutgoing`, only step 1
  ("resolve sessionId") differs; steps 2–5 (`call_bind` → WebRTC peer → `Active` → teardown) are
  identical.
  - **Project (new session):** `SessionTarget.NewSessionInProject(folderPath)` → `open_session
{ folderPath }` with no sessionId → server mints a brand-new empty session → bind.
  - **Resume (existing session):** `SessionTarget.ExistingSession(sessionId)` → skips
    `open_session`, binds directly onto the existing session (full history).
    So the picker only needs to emit the right URI form; no new call logic.

### Data & DI

- **Decision:** Read projects/sessions from the existing `SessionRepository.projects` /
  `.sessions` `StateFlow`s, accessed via `Context.pimoteContainer` (the `CarAppService` is
  framework-instantiated, same as every other entry point).
- **Why:** The WS control connection and `SessionRepository` are already process-wide and live;
  the car screen is just another reader. No new data plumbing.

## Direction

A `CarAppService` (POI category, sideloaded/dev-mode) with two `ListTemplate` screens:
project list (tap = new call) and a header-action recency resume list (tap = resume). Both reuse
`CallByPimoteUri.placeCall` and the existing Telecom/ConnectionService/CallController path. Purely
additive; recency-sorted to live within the host content limit.

## Open questions

- **Category/manifest specifics:** exact `androidx.car.app.category.POI` declaration, min car-api
  level meta-data, `automotive_app_desc`. (Architecture detail.)
- **Post-tap feedback:** after a tap places a call, Android Auto's own in-call UI takes over.
  Decide whether the car screen shows a transient `CarToast` ("Calling…") / pops, or just lets the
  system UI appear.
- **Active-call entry:** what the car app shows if opened while a call is already bound.
- **Degraded states:** WS disconnected / origin not configured / no projects — show a message
  template (origin can't be configured on the head unit).
