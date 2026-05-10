# Manual-test plan — pimote

Primary user journeys for the pimote PWA + server. This is the persistent
list — each autoflow topic's manual-test run smokes this suite plus
whatever the topic adds on top.

"Primary" = high-value happy path a real user walks, the kind of
regression we do not ship. Edge cases and branch exploration live in the
per-topic artifacts under `docs/manual-tests/<topic>.md`, not here.

Every journey names a **driver**: an automated tool under
`tools/manual-test/` (or elsewhere, e.g. `scripts/`) when one exists, or
**manual-browser** when the journey requires a human clicking the PWA.
Journeys that have no automation yet are still listed — they remain
items that must be exercised each run even if only by a human.

## Journeys

### 1. Connect and open a session

**What:** PWA connects to the pimote server, `list_folders` populates
the folder picker, user opens an existing session or creates a new one,
session metadata appears in the active-session bar.

**Why:** Entry point for every other journey. If this breaks, everything
breaks.

**Driver:** manual-browser (no automation).

### 2. Prompt → streamed assistant response

**What:** User types a prompt in a session; the server routes to pi;
assistant message streams back live (markdown renders progressively,
tool calls render with their args/results); `agent_end` leaves the
session idle.

**Why:** The product's core loop. Correctness + latency here is the
primary UX.

**Driver:** manual-browser.

### 3. Extension UI bridge

**What:** pi extensions call `ui.select` / `ui.confirm` / `ui.input` /
`ui.editor`; the PWA renders the dialog (inline for select/confirm,
modal for input/editor), the user answers, the extension receives the
value.

**Why:** Extensions are a first-class pimote feature; the bridge is the
only way they can ask the user anything.

**Driver:** manual-browser (against a test extension that invokes each
dialog type).

### 4. Session takeover / displacement

**What:** Two clients are open on the same session. The second claims
with force → the first receives `session_closed { reason: 'displaced' }`
and its UI returns to the folder list. The second client takes over and
can prompt.

**Why:** Single-owner semantics is load-bearing: shared across regular
prompt ownership and voice-call ownership. If displacement breaks,
voice-mode displacement breaks with it.

**Driver:** manual-browser (two browsers / tabs).

### 5. Slash commands and tree navigation

**What:** `/new`, `/reload`, `/tree` intercepted by the client /
server. `/tree` opens the tree-navigation dialog; selection dispatches
`navigate_tree`; the session resyncs to the picked branch.

**Why:** Tree navigation is the user's handle on pi's branch model.

**Driver:** manual-browser.

### 6. Panel cards from extensions

**What:** An extension pushes cards via `@pimote/panels` detect; the
PWA's side panel (desktop) / overlay (mobile) renders them; updates
from the extension re-render; session switch swaps panel contents.

**Why:** Panels are how extensions surface structured state.

**Driver:** manual-browser (with a panel-emitting test extension).

### 7. Push notifications

**What:** User opts in to notifications; server sends Web Push on
interaction events (extension dialog prompts); the browser fires the
notification; clicking it focuses the relevant session.

**Why:** Off-screen notifications are the primary mechanism that makes
pimote usable as a phone client.

**Driver:** manual-browser (PWA + real browser-side push).

### 8. Voice call — bind, in-call, hangup

**What:** On a session, the user starts a call (mobile: via the
`Voice call` row in the session-settings dialog; desktop: via the
inline `Start voice call` button in the status bar); `call_bind` round-
trips; a full-screen **calling-mode** surface replaces the chat with
three regions — header (project label + duration + mic state +
listening / thinking / speaking pulse), read-only transcript, and a
bottom gesture zone with three gestures: **swipe up = hang up**, **tap
= mute toggle (with audio cue)**, **swipe down = abort current run
(with audio cue, call stays connected)**. On call end (hangup,
server-side end, displacement, or network drop) calling mode auto-
returns to the normal chat surface for the same session. While a call
is active, extension UI bridge dialogs reject with
`ui_bridge_disabled_in_voice_mode`. Displacement of a call owner
surfaces `call_ended { reason: 'displaced' }` to the old client. There
is no `CallBanner` strip and no inline phone button in the mobile
header — calling mode is the only in-call UI.

**Why:** The voice modality (v1) added in the `voice-mode` topic.
Covers the pimote-side seam — the real WebRTC / STT / TTS path lives
in speechmux and is exercised separately.

**Driver:**

- `scripts/voice-mock-smoke.mjs` (mock-speechmux, orchestrator +
  extension-runtime layer) for server-side behaviour.
- `agent-browser` skill for the PWA UI — Call button renders, click
  emits `call_bind`, full-screen calling-mode surface mounts (header +
  read-only transcript + bottom gesture zone), the three gestures
  (tap=mute, swipe-up=hangup, swipe-down=abort) drive their respective
  actions, and hangup tears down back to the chat surface. Real-
  speechmux end-to-end is blocked on speechmux-repo work; see
  `docs/manual-tests/voice-call-fullscreen-ui.md` for the current
  `agent-browser`-driven run.

### 9. Android — Assistant-callable Pimote projects

**What:** Pimote projects are voice-callable via Google Assistant
("Hey Google, call <project>" or "Hey Google, call Pimote") and
tappable from the system contact card. Boot the Android app, ensure
`READ_CONTACTS` / `WRITE_CONTACTS` are granted, and wait ~2 s for
the contact + shortcut sync debounce.

1. From the system Contacts app, locate a Pimote project contact,
   open its card, confirm the call action button is present, tap it,
   and observe the call dispatching through `PimoteConnectionService`
   (the in-app `InCallActivity` opens).
2. Say `"Hey Google, call Pimote"`. Confirm the fallback shortcut
   resolves to the most-recently-active project and the call
   dispatches.
3. Say `"Hey Google, call <project name>"` for one of the top-N
   projects (within the system shortcut cap). Confirm direct
   resolution dispatches.
4. Say `"Hey Google, call <utterance close to a project name>"`
   (small mispronunciation / partial match). Confirm fuzzy-match
   resolution dispatches.
5. Confirm long-tail projects beyond the system shortcut cap are
   still callable from the contact-card surface (repeat step 1
   against an off-list project).

**Why:** This journey is the integration test for the
`android-assistant-callable-projects` topic. The unit tests cover
`ContactsSync` / `ShortcutsSync` purely; nothing on the JVM exercises
`TelecomManager`, `ShortcutManagerCompat`, or Assistant
fulfillment — those need a physical device.

**Driver:** manual on a physical Android device (no automation).

## Automation gap (recorded, not an action item for this topic)

Journeys 1–7 currently have no automation driver. This is a deliberate
pre-existing gap; journey 8 was first to pick one up (`agent-browser`
skill as of Re-test 2026-04-21). As autoflow topics add user-facing
features, this plan gets the new primary journey and — when the topic
brings automation along with it — the driver. Journey 8 is the first
journey to combine a server-side automated driver with a UI-automation
driver.
