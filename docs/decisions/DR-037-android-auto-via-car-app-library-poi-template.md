# DR-037: Android Auto surface via Car App Library POI template app, additive to DR-025

## Status

Accepted

## Context

DR-013 deferred Android Auto to "v2" and assumed it would arrive natively through the
self-managed `ConnectionService` / Telecom path — it never contemplated a dedicated car UI.
DR-025 then established App Actions (`shortcuts.xml` capability + dynamic shortcuts) as the
sanctioned voice surface and kept `ContactsContract` sync as a supporting-visibility surface,
claiming voice resolution worked on Pixel 8 / Android 16.

In lived use, the Assistant / spoken-name path has never actually placed a call for the user
— neither on the phone nor in the car, across many attempts. What _is_ proven in the car: the
call path itself works. Tapping the in-app phone `ContactsScreen` while connected to Android
Auto places a call and routes audio correctly through the head unit. So the missing piece was
never calling infrastructure — it was a **tap surface that lives on the head unit**, since the
only existing tap surface (`ContactsScreen`) is in the phone app and unusable while driving.

This forced a platform/framework choice for how to render that head-unit tap surface.

## Decision

\*\*Build a `CarAppService` using the Android for Cars App Library (`androidx.car.app:app:1.7.0`

- `androidx.car.app:app-projected:1.7.0`), declared under the POI category, rendering
  `ListTemplate` screens. Ship it sideloaded with Android Auto developer "Unknown sources"
  enabled. The work is purely additive — DR-025's App Actions / contacts-sync surfaces are left
  in place and untouched, and DR-025 is not superseded.\*\*

The car screens are a **picker only**: they build a `pimote:` dial URI and hand it to the
existing `CallByPimoteUri.placeCall` → `PimoteConnectionService` → `PhoneAccountRules.parseDialUri`
→ `CallController` machinery, which already branches correctly between a new-session project
hotline and an existing-session resume. No new call orchestration is introduced.

Rejected alternatives:

- **Media-browse hack** (`MediaBrowserService`, the way Spotify / Podcast Addict get unbounded
  sectioned lists). Rejected: "playing" a list item would have to secretly place a call, the
  now-playing UI expects media transport controls, and a `MediaSession` would fight the
  self-managed Telecom call for audio focus. Semantically wrong and fragile for a minimal,
  reliable calling picker. (The prior `android-auto-ui-exploration` notes already flagged this
  as an abuse of category.)
- **Android Automotive OS native app.** Rejected: that targets the car's built-in full-Android
  OS, not a phone projecting onto the head unit. It is a different platform, not something we
  sideload to a phone — out of scope for a personal projected-Auto build.

`1.7.0` is the latest **stable** Car App Library release; `1.8.x` / `1.9.x` are alpha/beta and
excluded per the latest-stable rule. `minSdk 26` / `compileSdk 36` are compatible.

## Consequences

- For third-party **non-navigation** apps on Android Auto, the Car App Library templates are
  the only UI option — there is no free-draw canvas and no third-party "calling/dialer"
  launcher category. A custom calling template surface essentially can't pass Play Store
  review, so distribution is locked to sideload + dev-mode. Play-Store shippability is
  explicitly out of scope.
- Two parallel "call by name/tap" surfaces now coexist: the flaky Assistant/contacts path
  (DR-025) and the reliable car tap surface. This is deliberate redundancy, not duplication to
  consolidate — the additive stance was a hard requirement (no rewrite/removal of the Assistant
  surface). The tension with DR-025's "voice works in practice" claim is recorded for
  visibility but intentionally left unresolved.
- The car surface inherits the exact, already-proven call path, so the one risk that could have
  killed the feature (self-managed call audio not routing through Auto) was disproven before
  any car code was written. The car module carries no call logic of its own to drift.
- **Not verified on a head unit.** There was no Android Auto host / DHU / device available to
  exercise the rendered car screens; verification stopped at `make android-build` /
  `make android-test` (the pure `CarRowModels` seam and a clean manifest merge). The
  framework-glue screens have not been observed running on a real or emulated head unit.
