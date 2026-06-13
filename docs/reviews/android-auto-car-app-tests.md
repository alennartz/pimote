# Test Review: Android Auto Car App — Project/Session Call Picker

**Plan:** `docs/plans/android-auto-car-app.md`
**Brainstorm:** `docs/brainstorms/android-auto-car-app.md`
**Date:** 2026-06-12

## Summary

The tests in `CarRowModelsTest.kt` cover the full testable seam of the car surface — the three
pure `CarRowModels` helpers — and map cleanly onto both the brainstorm intent (recency-sorted
picker, project=new-call URI, session=resume URI, degraded-state messaging that distinguishes a
phone-side origin fix from a transient disconnect) and the architecture's behavioral contracts.
Tests are deterministic (fixed injected `now`), stay at the component boundary, and reference only
existing pure DTOs/helpers plus the materialized interface. One over-specification around the
project-row title was found and resolved by pinning the title contract to the app-wide
`<root> <basename>` display form (DR-025 alignment). Framework glue (CarAppService/Screens) is
correctly excluded from unit tests.

## Findings

### 1. Project-row title was over-specified against a deliberately-loose contract

- **Category:** over-specified
- **Severity:** warning
- **Location:** `mobile/android/app/src/test/kotlin/com/pimote/android/car/CarRowModelsTest.kt:91-102`
- **Status:** resolved

The architecture's Interfaces section left the project title as "implementer's choice (basename OR
`<root> <basename>` style), must be stable & non-empty," yet the no-session-ordering test asserted
exact titles (`["beta","alpha","zeta"]`, i.e. `title == folderName`). A correct implementation that
chose the `<root> <basename>` form would fail. The looseness also made the no-session tiebreak
("ordered by title") non-deterministic, since the ordering key's format was unspecified.

Resolved (per user direction) by pinning the title contract to the same `<root> <basename>`
derivation the rest of the app uses — `PhoneAccountRules.rootSegmentOf(folderPath)` + `folderName`,
falling back to the bare `folderName` when there is no root segment (mirrors `ContactsSync`, aligns
with DR-025's display-name convention). Updated:

- Plan Interfaces + Behaviors sections to specify the title derivation and tiebreak ordering.
- Interface doc-comment in `CarRowModels.kt`.
- Test fixtures/assertions: the ordering test now uses rooted paths (`/work/...`) and asserts via a
  `projectTitle(...)` helper that mirrors the ContactsSync derivation (rather than hardcoding),
  consistent with how dial URIs are already asserted through `PhoneAccountRules`. Replaced the weak
  `titles are stable and non-empty` test with two positive title tests: the `<root> <basename>`
  form (`/work/repo` → `"work repo"`) and the bare-basename fallback (`/repo` → `"repo"`).

## No Issues

Beyond the finding above, the review was clean:

- **Brainstorm intent coverage** is complete for the unit-tested seam: recency ordering and
  truncation to the host content limit, project-call dial URI (`pimote:project:<b64>`), resume dial
  URI (`pimote:session:<id>`), flat cross-project recency for resume, subtitle pluralization /
  "No sessions yet", and the degraded-state precedence (origin → connection → emptiness) with the
  origin message explicitly directing the user to their phone and never reading "Connecting…".
- **Abstraction level** is correct — every test exercises the public `CarRowModels` surface; no
  internals or private functions are touched. Framework glue (CarAppService, Screens, tap→placeCall,
  CarToast, invalidate) is intentionally and appropriately left untested.
- **Interface-only** — tests import only existing pure helpers/DTOs (`ProjectMeta`, `SessionMeta`,
  `sessionDisplayName`, `formatRelativeTime`, `PhoneAccountRules`) plus the materialized
  `CarRowModels`/`CarRow`.
- **Path coverage** — happy paths, ordering/tiebreak boundaries, truncation, empty-input, and the
  full degraded-state matrix are present.
- **No non-deterministic tests** — `now` is a fixed injected epoch millis; no timing, randomness,
  network, or filesystem dependence.
- **Reasonable expectations** — subtitle assertions use `contains` (lenient on separators/cwd
  hints); exact-string assertions are confined to contract-pinned strings ("No sessions yet",
  "No projects yet") and the now-pinned title form.
