# Manual Testing — provider-login

## Smoke Suite

The persistent `tools/manual-test/PLAN.md` journeys are exercised for regression
via their automated drivers (the ones with drivers):

- **Journey 2 (settled write/markdown render):** `streaming-code-highlight-smoke`.
- **Journey "connect + StatusBar" slice:** `cost-accumulation-smoke` (boots the PWA,
  connects, opens a session, asserts StatusBar) — covers journey 1's connect/open path.
- **Static-host journeys:** `static-host-smoke` (server) + `static-host-pwa-smoke` (PWA).
- **Journey 8 (voice server-side):** `voice-mock-smoke`.

Browser-only journeys without automation (1 folder picker, 3 extension UI bridge,
4 takeover, 5 tree, 6 panels, 7 push, 9 Android) are not re-driven this run — provider
login does not touch them. The `/login` entry point lives in `InputBar`, which is the
same surface as journey 5's slash commands, so the new flow is exercised adjacent to
that journey.

## Topic-Specific Tests

The interactive `/login` flow (brainstorm + plan). Driven by a new
`provider-login-smoke` tool that boots a real pimote against a sandboxed (credential-
free) HOME and drives the real PWA + real pi-SDK `AuthStorage.login` end-to-end up to
the auth-URL / device-code / paste step.

1. **`/login` opens the LoginDialog, no prompt sent.** Typing `/login` in the InputBar
   and submitting opens the dialog and posts _no_ user message / does not hit the agent
   (plan step 9, the client-side interception).
2. **Provider list loads from `getOAuthProviders`, no credentials.** The picker lists
   all three OAuth providers (Anthropic, GitHub Copilot, ChatGPT) with no logged-in
   badge, in a fresh sandbox with no `auth.json` (plan step 1 / 6).
3. **Paste-back provider renders auth link AND paste field simultaneously (HEADLINE).**
   Picking Anthropic (a `usesCallbackServer` provider) drives the real
   `onAuth`→`onManualCodeInput` double-emit. The dialog must show the "Open auth page"
   link (href = the real `claude.ai/oauth/authorize` URL) AND a working paste field at
   the same time, and the link must survive the immediately-following manual-code
   `prompt` step (review finding #1, critical, resolved by the `authInfo` latch). This
   is the headline regression guard — verified structurally and visually.
4. **Device-code provider renders code + verification URI.** Picking GitHub Copilot
   answers the enterprise-domain prompt (blank → github.com), then renders the real
   device `userCode` + tappable verification-page link (device-code branch, plan step 8).
5. **Cancel.** Cancelling a running flow returns the dialog to idle/closed and aborts
   the server-side flow.
6. **Busy when a second login begins mid-flow.** While a flow is in-flight, a second
   `login_begin` (via a separate connection) is rejected `{ ok:false, reason:'busy' }`
   by the server single-flight guard (review confirmed no TOCTOU); the client surfaces
   the busy message (plan step 6 `begin()` returns false; review finding #5).

## Tools

- Reused: `agent-browser` (PWA driver); the boot/sandbox/`abCmd` harness pattern shared
  by `cost-accumulation-smoke` / `streaming-code-highlight-smoke`.
- New: `tools/manual-test/provider-login-smoke/` — boots a sandboxed pimote and drives
  the full `/login` flow (open dialog, list providers, paste-back auth screen, device
  code, cancel, busy) via `agent-browser` + a direct WS probe for the busy guard.
- Improved: none.

## Harness Limitations

- **Real OAuth completion is environment-bounded.** Finishing a real token exchange
  (submitting a valid authorization code for Anthropic/OpenAI, or completing GitHub
  device authorization for Copilot) requires real subscription credentials/accounts that
  are unreachable here. The harness exercises the flow up to and including the
  auth-URL / device-code / paste step; it deliberately does **not** complete a login.
  The terminal `done{success:true}` step and its model-registry refresh + model re-pull
  are therefore **not** exercised end-to-end by this harness (they are covered by the
  server + client unit suites against in-memory fakes).
- **Anthropic/OpenAI auth-URL emission is fully local** (PKCE-constructed URL + a
  localhost callback server, no network), so the headline test (#3) runs against the
  real flow with no stubbing — the exact `onAuth`→`onManualCodeInput` sequence that
  caused review finding #1.
- **Copilot device-code uses real network** to `github.com/login/device/code`
  (unauthenticated device-flow start), returning a real short-lived user code. If
  network to github.com is unavailable, test #4 is environment-bounded.
- Single PWA client: the client-side busy _toast_ path with two real browsers is not
  driven; the busy guard is exercised server-side over a second WS connection (the real
  rejection path), and the client `begin()→false` rendering is unit-tested.

## Results

**Regression smoke suite (persistent journeys with drivers):**

- **Server unit suite** (`server` vitest, 366 tests): **pass** after fixing 6
  stale `get_commands` fixtures (see below). Initially **6 red** — plan step 5
  added the `/login` built-in command but the ws-handler `get_commands` tests
  still asserted the pre-login built-in list. **fixed-inline.**
- **Client unit suite** (`client` vitest, 430 tests): **pass** (includes the 21
  LoginStore tests, green after the two inline store fixes).
- **cost-accumulation-smoke** (connect/open + StatusBar): **pass** — confirms the
  client connect/open primary journey is regression-free under the store change.
- **static-host-smoke** (server-side static-host pipeline): initially **red**
  with `deps.emitNavigate is not a function` — a _pre-existing_ break from the
  concurrent static-resources change (commit `83283b7` added the `emitNavigate`
  dep without updating this harness), unrelated to provider-login.
  **fixed-inline** (no-op `emitNavigate` stub per deps object). Now **pass**.
- Browser-only journeys without drivers (1 folder picker, 3 ext-UI bridge, 4
  takeover, 5 tree, 6 panels, 7 push, 9 Android) not re-driven — untouched by
  this topic.

**Topic-specific tests** (`provider-login-smoke`, full run **PASS**):

1. **`/login` opens dialog, no prompt sent** — **pass.** Typing `/login` opens
   "Provider Login"; no user message containing `/login` is posted.
2. **Provider list loads, no credentials** — **pass.** `login_list` returns all
   three OAuth providers (anthropic, github-copilot, openai-codex), all
   `loggedIn:false`; picker shows no logged-in badge.
3. **HEADLINE: paste-back auth link + paste field simultaneously** — **pass.**
   Anthropic renders the "Open auth page" link (real
   `claude.ai/oauth/authorize?...` URL) AND a working paste field + Submit at
   the same time; the link survives pi's immediately-following manual-code
   `prompt` step (driven against the _real_ `onAuth`→`onManualCodeInput`
   double-emit, no stubbing). Coherence screenshot `02-anthropic-auth.png`.
4. **Device-code provider** — **pass.** Copilot answers the enterprise-domain
   prompt (blank) then renders the real device user code (`C0D3-DE30`) +
   "Open verification page" link over real network. Screenshot
   `03-copilot-device.png`.
5. **Cancel** — **pass (fixed-inline).** Cancel now closes the dialog with no
   stale "Login failed" screen (see fix #1 below).
6. **Busy mid-flow** — **pass.** With a real Anthropic flow in-flight in the
   browser, a second `login_begin` over a separate WS is rejected
   `{ ok:false, reason:'busy' }`.

**Coherence pass:**

- Picker (`01-picker.png`): **looks coherent** — three OAuth providers listed by
  friendly name, no badges, clean modal.
- Anthropic auth screen (`02-anthropic-auth.png`): **looks coherent** — "Open
  auth page" button, the connection-error warning copy, "Paste the
  authorization code" field, and Submit all present together; matches the
  brainstorm's paste-back UX and the plan's single-auth-screen intent.
- Copilot device screen (`03-copilot-device.png`): **looks coherent** — "Enter
  this code at the verification page", large mono code, verification link,
  waiting spinner; matches the device-code UX in the brainstorm.

**Fixes applied inline this run:**

- **Fix #1 (client, `login.svelte.ts` `handleStep`):** cancelling a flow fired
  the server AbortSignal, whose `runLogin` emits a terminal
  `done{success:false}` step; `handleStep` flipped the just-cancelled dialog
  into a stale "Login failed" screen. Guarded `handleStep` to ignore a terminal
  `done` when the flow is already `idle`. (DR-worthy: cancel-vs-abort-echo race.)
- **Fix #2 (client, `login.svelte.ts` `begin`):** providers whose first OAuth
  callback fires synchronously inside the server's `login_begin` handling (e.g.
  Copilot's `onPrompt`) emit a `login_step` that reaches the client _before_
  the `login_begin` response resolves; `begin()` reset `currentStep=null`
  _after_ the await, wiping the already-arrived step and leaving the dialog
  stuck on a blank "Working…" screen. Moved the step-state reset to _before_
  sending the command. Anthropic was unaffected (it awaits `startCallbackServer`
  before `onAuth`). (DR-worthy: early-step-clobber race.)
- **Fix #3 (server test, `ws-handler.test.ts`):** updated 6 stale `get_commands`
  fixtures for the new `/login` built-in (regression from plan step 5).
- **Fix #4 (harness, `static-host-smoke.mjs`):** added a no-op `emitNavigate`
  stub to the deps objects (pre-existing break from concurrent static-resources
  change `83283b7`).

## Plan Updates

- **Added journey 10 — "Interactive provider login (`/login`)"** to
  `tools/manual-test/PLAN.md`. It is a new first-class capability (the only
  client-side path to add an OAuth model provider), driven by the new
  `provider-login-smoke` tool.

## Open Issues

None. All smoke-suite and topic-specific items are `pass` or `fixed-inline`.
The only environment-bound surface — completing a _real_ OAuth token exchange
— is out of reach without real subscription credentials and is covered by the
unit suites up to the seams; the flow is exercised end-to-end up to the
auth-URL / device-code / paste step as intended.
