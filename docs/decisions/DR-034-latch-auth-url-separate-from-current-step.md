# DR-034: Latch the auth URL separately, and guard the pi-callback-ordering races

## Status

Accepted

## Context

The login modal renders a single "current step" emitted by the server
orchestrator (auth / device_code / prompt / select / progress / done). The
plan's clean model was one auth screen carrying both the "Open auth page" link
and the paste field. Implementation against pi's _actual_ OAuth callback
sequencing exposed three ordering hazards that a single `currentStep` field
mishandles — all rooted in _when_ pi fires its callbacks, not in the protocol
shape:

1. **Same-tick `onAuth` → `onManualCodeInput`.** For the authorization-code
   providers (Anthropic, OpenAI), pi calls `onAuth({url})` and then
   _immediately_, in the same tick, `onManualCodeInput()` before
   `server.waitForCode()` (verified in pi-ai's `anthropic.js` / `openai-codex.js`).
   The orchestrator maps these to two non-terminal steps — `auth` then `prompt`.
   A single `currentStep` field stores the latest, so the `prompt` step clobbers
   the `auth` step: the dialog flips to a bare "Paste the authorization code"
   input and **the auth URL link vanishes** — destroying the primary action of
   the headline paste-back flow (review finding #1, critical).

2. **Cancel vs. abort-echo.** Cancelling fires the server `AbortSignal`, whose
   `runLogin` emits a terminal `done{success:false}` step. If `handleStep`
   processes that echo unconditionally it flips the just-cancelled (idle) dialog
   into a stale "Login failed" screen.

3. **Early-step-clobber.** Providers whose first callback fires synchronously
   inside the server's `login_begin` handling (e.g. Copilot's `onPrompt`) emit a
   `login_step` that reaches the client _before_ the `login_begin` response
   resolves. If `begin()` resets step-state _after_ its await, it wipes the
   already-arrived step, leaving the dialog stuck on a blank "Working…" screen.

## Decision

- **Latch the auth URL independently of `currentStep`.** The store keeps the
  `auth` info in its own field that survives the immediately-following
  manual-code `prompt` step, so `LoginDialog` renders the "Open auth page" link
  _and_ the working paste field together. The paste field's submit targets the
  prompt step's `requestId` (the functional input), while the link comes from the
  latch.
- **Ignore a terminal `done` when the flow is already `idle`** in `handleStep`,
  so a cancel's abort-echo doesn't paint a "Login failed" screen over a dialog
  the user already dismissed.
- **Reset step-state _before_ sending `login_begin`,** not after the await, so a
  synchronously-arriving first step is preserved rather than clobbered.

## Consequences

- The store carries login-flow state in more than one field (latched auth info +
  current step + terminal result) rather than a single step pointer. This is
  load-bearing: collapsing them back into one field reintroduces hazard #1.
- These guards encode assumptions about pi's callback _timing_ (same-tick double
  emit; synchronous-vs-async first callback). If a pi upgrade changes that
  sequencing, the guards may become unnecessary or, worse, subtly wrong — they
  are the first place to look when login rendering misbehaves after a pi bump.
- The component chrome that depends on all three (link-plus-field auth screen,
  clean cancel, no blank Copilot screen) is verified in the manual-test phase via
  `provider-login-smoke`, which drives the _real_ `onAuth`→`onManualCodeInput`
  double-emit with no stubbing — the regression guard for hazard #1 specifically.
