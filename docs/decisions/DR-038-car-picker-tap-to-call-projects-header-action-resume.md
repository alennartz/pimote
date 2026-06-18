# DR-038: Car picker UI — tap-to-call projects, header-action resume list, under the single-tap-target constraint

## Status

Accepted

## Context

The Android Auto car surface (DR-037) renders with Car App Library templates. A hard
framework constraint shapes the UI: template `Row`s have a **single tap target** — there is no
inline secondary button, so the phone `ContactsScreen`'s per-row layout (a project header plus
a separate call `IconButton`) cannot be reproduced. One row = one tap = one action. The screen
also has to live within the host `ConstraintManager` content limit, which tightens while
driving and relaxes when parked.

This forces two decisions the phone UI never had to make: what a project row's single tap
_does_, and how resuming a specific existing session is reached when a row can't carry both a
"call" and a "drill in" affordance.

## Decision

**Two `ListTemplate` screens, both recency-sorted, both tap-to-call:**

- **Screen 1 — project list.** One row per project, sorted by most-recent session activity;
  subtitle shows session count + last activity. **Tapping a project immediately places the
  new-session hotline call** (`pimote:project:<base64(folderPath)>`). One tap for the dominant
  case.
- **Screen 2 — resume list**, reached via a header `ActionStrip` "Sessions" button. A **flat,
  recency-sorted** list of existing sessions (no per-project grouping); title = session display
  name, subtitle = relative time. **Tapping a session resumes it** (`pimote:session:<id>`).

Recency-sort everywhere and accept the host content limit rather than paginating manually — the
top slots are then always the useful ones, which matches the driving constraint (short list at
speed, scrolls when parked).

Rejected alternative — **pure folder drill-down** (project tap → a per-project screen with "New
session" on top + nested sessions). Rejected because it costs **two taps even for the common
new-call case**. Placing a new call is the ~90% case, so it gets the single tap; resuming a
specific session is rarer and more intentional ("I know which conversation I want"), so it
takes the deliberate two-tap path behind the header action, where a recency list still surfaces
it fast.

The single-tap-target constraint also means a project row must be a _call button_ OR a _folder_,
not both — the call button was chosen. The resume list is flat (not grouped by project) because
in a car you pick by "what I was just doing," which recency already encodes, and flat is simpler.

## Consequences

- New-call dominance is baked into the interaction cost: one tap to start a fresh session in a
  project, two taps to resume a specific older one. If resume-by-session ever becomes the common
  case, this ordering is what to revisit.
- No per-project grouping on the resume screen means a session's parent project isn't visible
  there beyond what the display name/subtitle convey — acceptable given recency-driven picking,
  but a constraint to remember if grouping is later wanted.
- The entire testable surface is the pure `CarRowModels` seam (`projectCallRows`,
  `resumeSessionRows`, `carListMessage`): ordering, subtitle pluralization, dial-URI form,
  truncation to the host limit, and the degraded-state message precedence (origin-not-configured,
  which can't be fixed from the head unit, takes precedence over disconnected, which takes
  precedence over empty). The screens themselves are thin shells over it. The rendered
  interaction was not exercised on a head unit (no host/DHU/device available) — only the pure
  seam is test-covered.
