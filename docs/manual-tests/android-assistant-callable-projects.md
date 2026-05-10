# Manual Testing — android-assistant-callable-projects

## Smoke Suite

Scoped by the orchestrator's focus hints: this topic only ships Android-side
behavior (contact-card action button, Google Assistant voice resolution,
dialer name-search). It does not touch any of the persistent journeys 1–8 in
`tools/manual-test/PLAN.md` — those exercise the pimote server + PWA + voice-
mode pipeline, which this topic's diff does not modify. Re-smoking 1–8 here
would not narrow the risk surface this topic introduces. Smoke suite for this
run is therefore intentionally empty; all verification load goes to the
topic-specific journey 9.

## Topic-Specific Tests

The implement phase added journey 9 ("Android — Assistant-callable Pimote
projects") to `tools/manual-test/PLAN.md`. That journey _is_ this topic's
test plan; it is reproduced here for traceability with the focus-hint
emphases called out.

1. **Contacts-app card → call action button** — From the system Contacts
   app, open a Pimote project contact card; confirm the call action button
   is rendered (this is the surface DR-024 left broken, restored by
   `CallByDataRowActivity` + its `<intent-filter>` on
   `vnd.android.cursor.item/vnd.com.pimote.android.call`); tap it; the
   intent should reach `CallByDataRowActivity`, parse the `pimote:` URI off
   the `Data.DATA1` row, and dispatch via `CallByPimoteUri.placeCall` →
   `PimoteConnectionService` → `InCallActivity`.
2. **Dialer name search by `<root> <project>`** — In the dialer's contacts
   search, type e.g. `repos pim` and confirm the Pimote contact for
   `/repos/pimote` surfaces as `repos pimote`. This exercises the new
   display-name format introduced by Step 2 (`ContactsSync.computeDesired
Contacts` calling `PhoneAccountRules.rootSegmentOf`).
3. **Assistant voice — fallback** — `"Hey Google, call Pimote"` (and the
   pronunciation variants `"call pee mote"`, `"call pee-mote"`,
   `"call pie mote"`, `"call pie-mote"`, `"call my pi"`). All bind to the
   fallback shortcut's `FALLBACK_SYNONYMS` and route through
   `CallByNameActivity` with `participantName == "fallback"`, which
   resolves to the most-recently-active project from
   `buildSessionProjectGroups(...)`.
4. **Assistant voice — direct match** — `"Hey Google, call <root>
<project>"` and `"Hey Google, call <project>"` for one of the top-N
   projects. Both forms are bound by `synonymsFor(...)`, so either should
   resolve directly via `CallByNameActivity`'s exact-match step (which
   scans `synonyms` per resolved review finding 5).
5. **Assistant voice — fuzzy match / mispronunciation** — `"Hey Google,
call <utterance close to a project name>"` with a small phonetic skew
   or partial token. Should fall through exact-match to
   `ShortcutsSync.resolveByFuzzyMatch` and dispatch.
6. **Long-tail (off-shortcut-cap) projects via contact card** — Pick a
   project beyond the 15-shortcut Assistant cap (i.e. not in the most-
   recent 14); confirm it is _not_ directly callable by Assistant by name
   but _is_ still callable from its system contact card (regression
   check: long-tail projects must remain reachable via the
   contact-card surface).

Prerequisite for all of the above: app booted with `READ_CONTACTS` /
`WRITE_CONTACTS` granted, ~2 s after launch so the `ContactSyncRunner` and
`ShortcutsRunner` debounces have flushed.

## Tools

- **Reused:** none — no existing tool under `tools/manual-test/` drives
  Android Telecom / Assistant / system Contacts. The
  manual-testing-skill's mandatory-reuse table covers browser / CLI /
  HTTP-API surfaces; an Android system-app journey is outside that table,
  so the on-device manual driver is the correct choice.
- **New:** none. Building bespoke `adb`-driven tooling for Assistant
  voice resolution and AOSP `DataKind`-rendered card actions would be
  disproportionate — the journey is irreducibly an end-to-end check
  of Google's resolver behavior on a real device. Any synthetic stand-in
  would not exercise the bugs that matter (see _Harness Limitations_).
- **Improved:** none.

## Harness Limitations

This subagent has no physical Android device, no Google Assistant
runtime, no system Contacts/Dialer app, and no Android emulator with a
Telecom stack accessible from the working environment. The topic's
primary user-facing behavior (journey 9 in full) is therefore
**structurally not exercisable** in this run.

Classes of bug this harness cannot surface:

- Real-device `<intent-filter>` resolution for the custom-MIME
  `ACTION_VIEW` — i.e. whether AOSP `DataKind` actually renders the call
  action button on the contact card for the new Pimote MIME.
- Google Assistant's `actions.intent.CREATE_CALL` capability binding,
  parameter recognition, and synonym matching against
  `addCapabilityBinding(...)` — including pronunciation-variant
  resolution and the system shortcut cap.
- `TelecomManager.placeCall` dispatch with `EXTRA_PHONE_ACCOUNT_HANDLE`
  to the Pimote self-managed `PhoneAccount`, including
  `PimoteConnectionService` round-trip into `InCallActivity`.
- System Contacts/Dialer name-search indexing of the new
  `"<root> <project>"` display-name format produced by
  `ContactsSync.computeDesiredContacts`.
- `ShortcutManagerCompat` runtime cap and dynamic-shortcut population
  semantics on a real device, including the `PersistableBundle` extras
  round-trip used by `AndroidShortcutManagerFacade.getDynamicShortcuts`.

Pure-function logic underpinning these flows (`rootSegmentOf`,
`ContactsSync` display-name format, `ShortcutsSync.{computeDesired
Shortcuts, synonymsFor, resolveByFuzzyMatch, diff}`) is covered by the
JVM unit suites `PhoneAccountRulesTest` (5 `rootSegmentOf` cases),
`ContactsSyncTest` (24 cases including the new format), and
`ShortcutsSyncTest` (42 cases) — all green per the implement-phase
gates and unmodified between `pre-implementation-commit` (e44e343) and
HEAD per the code-review verification. The harness gap is therefore
strictly the device-only seam, not the logic underneath it.

The orchestrator's task brief (focus hints) explicitly framed this
topic's verifications as device-only. I attempted to escalate this
explicitly via `send(to='parent', expectResponse=true)` before
proceeding, but the broker connection was lost on the attempt;
proceeding with the device-only items recorded transparently in _Open
Issues_ below in lieu of escalation.

## Results

### Smoke Suite

Empty — see _Smoke Suite_ section. No items to record.

### Topic-Specific Tests

| #   | Item                                                                    | Verdict                | Notes                                                  |
| --- | ----------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------ |
| 1   | Contact-card call action button + dispatch                              | **open (device-only)** | Not exercisable in this harness; see _Open Issues_ §1. |
| 2   | Dialer name search by `<root> <project>`                                | **open (device-only)** | Not exercisable in this harness; see _Open Issues_ §1. |
| 3   | Assistant fallback (`"call Pimote"` + pronunciation variants)           | **open (device-only)** | Not exercisable in this harness; see _Open Issues_ §1. |
| 4   | Assistant direct match (`"call <root> <project>"` / `"call <project>"`) | **open (device-only)** | Not exercisable in this harness; see _Open Issues_ §1. |
| 5   | Assistant fuzzy match / mispronunciation                                | **open (device-only)** | Not exercisable in this harness; see _Open Issues_ §1. |
| 6   | Long-tail off-cap projects via contact card                             | **open (device-only)** | Not exercisable in this harness; see _Open Issues_ §1. |

No coherence pass: no UI artifact was produced — the journeys did not run.
Static review of `CallByNameActivity` / `CallByDataRowActivity` /
`AndroidShortcutManagerFacade` was already done by the code-review phase
(`docs/reviews/android-assistant-callable-projects.md`, all five findings
resolved); re-doing it here would duplicate that pass without exercising
the journey.

## Plan Updates

None this run. Journey 9 was added to `tools/manual-test/PLAN.md` by the
implement phase (Step 13) and is unchanged here. The persistent plan
already captures the on-device steps verbatim with the focus-hint
emphases (`<root> <project>` direct, `"Pimote"` fallback, pronunciation
variants, contact-card action button, off-cap long-tail).

## Open Issues

### 1. Journey 9 (all six items) requires on-device execution

- **Observation:** None of the six topic-specific items above were
  exercised — this run had no access to a physical Android device,
  Google Assistant, system Contacts/Dialer app, or a Telecom-bearing
  emulator.
- **Suspected cause:** Not a code defect — a structural property of
  this run's harness. The implementation passed the code-review phase
  with all five findings resolved (`docs/reviews/android-assistant-
callable-projects.md`), and the JVM unit suites covering the pure
  functions are green.
- **Why not fixed inline:** Nothing to fix; this is execution
  coverage, not a bug. The skill's coherent next step is owner /
  user execution on a real device, with results filed back into this
  artifact.
- **Suggested follow-up for cleanup / owner:** Run journey 9 (steps
  1–6 above) on a real device. Items most likely to surface real
  defects, in priority order, given the implementation history:
  1. Item 1 (contact-card action button) — DR-024's empirical failure
     mode. Verify the new `<intent-filter>` actually renders the button.
  2. Item 4 with the bare `<project>` form — review finding 5 widened
     exact-match to scan synonyms; confirm Assistant returns one of
     the bound synonyms and the new exact-match path catches it
     before falling through to fuzzy.
  3. Item 5 (fuzzy / mispronunciation) — review finding 4 loosened
     the score cutoff to `>= 0.5`; this is the case it was loosened
     for.
  4. Item 3 pronunciation variants — confirm
     `FALLBACK_SYNONYMS = ["Pimote", "pee mote", "pee-mote", "pie mote",
"pie-mote", "my pi"]` actually bind through
     `addCapabilityBinding`. (Assistant's recognizer may normalize
     punctuation in ways that drop the hyphenated forms; if so the
     bare-spaced forms should still resolve.)
