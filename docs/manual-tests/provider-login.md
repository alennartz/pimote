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

_(populated after execution)_

## Plan Updates

_(populated after execution)_

## Open Issues

_(populated after execution)_
