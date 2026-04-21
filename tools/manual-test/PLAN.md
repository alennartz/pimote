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

**What:** On a session, the user clicks **Call**; `call_bind` round-
trips; the in-call banner shows phase (binding → connecting →
connected) with mute + hangup controls; hangup sends `call_end` and
tears down. While a call is active, extension UI bridge dialogs reject
with `ui_bridge_disabled_in_voice_mode`. Displacement of a call owner
surfaces `call_ended { reason: 'displaced' }` to the old client.

**Why:** The voice modality (v1) added in the `voice-mode` topic.
Covers the pimote-side seam — the real WebRTC / STT / TTS path lives
in speechmux and is exercised separately.

**Driver:** `scripts/voice-mock-smoke.mjs` (mock-speechmux, orchestrator

- extension-runtime layer) for server-side behaviour;
  manual-browser for the PWA UI (Call button, in-call banner, mute,
  hangup). Real-speechmux end-to-end is blocked on speechmux-repo work —
  see `docs/manual-tests/voice-mode.md`.

## Automation gap (recorded, not an action item for this topic)

Journeys 1–7 currently have no automation driver. This is a deliberate
pre-existing gap; introducing browser automation (e.g. via
`agent-browser` or a playwright harness) is its own body of work. As
autoflow topics add user-facing features, this plan gets the new primary
journey and — when the topic brings automation along with it — the
driver. Journey 8 is the first journey with any automation at all.
