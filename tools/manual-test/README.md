# Manual-test tools

Index of automated drivers used by the manual-test skill. Each entry:
purpose, invocation, inputs, outputs, prerequisites. New tools must be
registered here.

See `PLAN.md` in this directory for the list of primary user journeys
and which tool (if any) drives each.

## Tools

### voice-mock-smoke

**Purpose:** Exercise the pimote-side voice-mode pipeline end-to-end
without a real speechmux binary. Covers the `VoiceOrchestrator`
lifecycle, `bindCall` / `endCall` wire round-trip, displacement with
`force: true`, UI-bridge `isVoiceModeActive` predicate behaviour, and
the pure extension-runtime reducers' handling of synthetic speechmux
frames (user / abort / rollback). Drives journey 8 in `PLAN.md`.

**Location:** `scripts/voice-mock-smoke.mjs`

> Location note: this script predates the `tools/manual-test/`
> convention. Future voice-specific manual-test tooling should live
> under `tools/manual-test/<tool>/`; the existing script is left
> in-place to keep the plan-step deliverable references stable.

**Invocation:**

```bash
# Build the workspaces first so dist/ artifacts exist.
npm run build
node scripts/voice-mock-smoke.mjs
```

**Inputs:** none (all seams injected as fakes).

**Outputs:** stdout assertions; non-zero exit code on any failure.

**Prerequisites:** workspaces built (`server/dist`, `packages/voice/dist`,
`shared/dist`). No real speechmux, browser, or network required.

### static-host-smoke

**Purpose:** Exercise the server-side static-host pipeline end-to-end
without booting the full pimote server or requiring an LLM. Covers the
shipped `InMemoryStaticHostRegistry`, `FileStaticHostStore`,
`gcStaticHostStore`, `serveStaticHostRoute`, `executeRegisterTool`,
`executeRemoveTool`, slug validation + collision resolution,
persistence + replay across session evict/rehydrate, and boot-time GC
of orphan store files. Drives static-resources tests 1–11 in
`docs/manual-tests/static-resources.md`.

**Location:** `tools/manual-test/static-host-smoke/static-host-smoke.mjs`

**Invocation:**

```bash
npm run build
node tools/manual-test/static-host-smoke/static-host-smoke.mjs
```

**Inputs:** none (uses `fs.mkdtemp` for an isolated bundle + store dir).

**Outputs:** per-test ✓/✗ lines on stdout; non-zero exit on any failure.

**Prerequisites:** workspaces built (`server/dist`, `shared/dist`). No
real network, browser, or LLM required.

### static-host-pwa-smoke

**Purpose:** Verify the client-side behaviours the test-review phase
deferred for static-resources: `Panel.svelte` rendering `Card.href`
as a clickable `<a>`, the service worker passing `/s/*` through to the
network unmodified, and browser-back returning to the session view
after viewing a hosted bundle. Drives static-resources tests 12–14.

**Location:** `tools/manual-test/static-host-pwa-smoke/static-host-pwa-smoke.mjs`

**Invocation:**

```bash
npm run build
node tools/manual-test/static-host-pwa-smoke/static-host-pwa-smoke.mjs
```

**Inputs:** none. The script builds a fresh sandbox under `os.tmpdir()`
(its own `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`), fabricates a
pi session jsonl on disk, seeds the static-host persistence file,
boots `bin/pimote.js` on a free local port, and drives the PWA via
`agent-browser` against that sandboxed instance.

**Outputs:** per-test ✓/✗ lines on stdout; non-zero exit on any failure.
On failure the sandbox directory is preserved and its path printed for
inspection.

**Prerequisites:** workspaces built (`npm run build`), `agent-browser`
on `PATH`, writable `os.tmpdir()`. The script tracks the child PID it
spawns and only kills that PID on teardown — it never uses
pattern-based `pkill` against shared binary paths.

### cost-accumulation-smoke

**Purpose:** Verify the per-session lifetime dollar cost surfaced in the
StatusBar (the `cost-accumulation` topic). Covers the full server +
client path without a live LLM: fabricates pi session JSONLs whose
assistant entries carry real-format `usage.cost.total` values (which
pi's `SessionManager` rehydrates into the in-memory branch on open —
the same path the plan relies on for restart survival), then asserts:
(1) `get_session_meta` succeeds with a numeric `lifetimeCostUsd` equal
to the sum over _assistant_ entries only (user / toolResult /
`model_change` entries excluded); (2) the StatusBar renders the
`formatSessionCost` figure (`$1.23`) for a priced session; (3) a
zero-spend session reports `lifetimeCostUsd: 0` and renders no
`[title="Session cost"]` span. Exercises StatusBar rendering within
the connect-and-open primary journey.

**Location:** `tools/manual-test/cost-accumulation-smoke/cost-accumulation-smoke.mjs`

**Invocation:**

```bash
npm run build
node tools/manual-test/cost-accumulation-smoke/cost-accumulation-smoke.mjs
```

**Inputs:** none. Builds a fresh sandbox under `os.tmpdir()` (its own
`HOME` + XDG dirs), fabricates two pi session JSONLs (priced +
zero-spend), boots `bin/pimote.js` on a free local port, checks
`get_session_meta` directly over the WebSocket, and drives the PWA via
`agent-browser` to assert the rendered StatusBar figure.

**Outputs:** per-test ✓/✗ lines + a `priced-statusbar.png` /
`zero-statusbar.png` screenshot pair in the sandbox; non-zero exit on
any failure. On failure the sandbox is preserved and its path printed.

**Prerequisites:** workspaces built (`npm run build`), `agent-browser`
on `PATH`, writable `os.tmpdir()`. Tracks and kills only the child PID
it spawns — no pattern-based `pkill`. No real LLM, speechmux, or
network required.

### streaming-code-highlight-smoke

**Purpose:** Verify the FINALIZED render contracts of the `write` tool
visualization (the `streaming-code-highlight` topic) without a live LLM:
fabricates a pi session with completed `write` tool calls (code + markdown,
short + long), boots pimote, opens it in the PWA via `agent-browser`, and
asserts (1) mode routing by extension (`.ts`→highlighted `<pre><code>`,
`.md`→rendered markdown), (2) the copy button yields RAW source verbatim in
BOTH modes, (3) the show-more/collapse wrapper bounds long files in BOTH modes,
(4) real hljs span markup in code mode, and (5) rendered markdown + highlighted
inner fence in markdown mode. Exercises the settled half of journey 2's
tool-call visualization.

> Harness limitation: disk-fabricated sessions show the settled state only, so
> the streaming-only behaviors (auto-expand/collapse during a write stream,
> mid-stream highlight in the write view) are NOT exercised here — their logic
> is covered by client unit tests. See
> `docs/manual-tests/streaming-code-highlight.md`.

**Location:** `tools/manual-test/streaming-code-highlight-smoke/streaming-code-highlight-smoke.mjs`

**Invocation:**

```bash
npm run build
node tools/manual-test/streaming-code-highlight-smoke/streaming-code-highlight-smoke.mjs
```

**Inputs:** none (fresh `os.tmpdir()` sandbox; `SCH_SHOT=<path>` optionally
redirects the coherence screenshot outside the sandbox).

**Outputs:** per-test ✓/✗ lines + a `write-blocks.png` screenshot; non-zero exit
on any failure. On failure the sandbox is preserved and its path printed.

**Prerequisites:** workspaces built (`npm run build`), `agent-browser` on PATH,
writable `os.tmpdir()`. Tracks and kills only the child PID it spawns. No real
LLM, speechmux, or network required.

### provider-login-smoke

**Purpose:** Exercise the interactive `/login` OAuth provider flow (the
`provider-login` topic) end-to-end without real subscription credentials.
Boots a real pimote against a sandboxed, credential-free HOME and drives the
real PWA + real pi-SDK `AuthStorage.login` up to the auth-URL / device-code /
paste step. Asserts: (1) typing `/login` opens the LoginDialog and posts no
user message; (2) `getOAuthProviders` lists Anthropic / GitHub Copilot /
ChatGPT with no logged-in badge in a fresh sandbox; (3) HEADLINE — the
Anthropic (paste-back) flow renders the "Open auth page" link (real
`claude.ai/oauth/authorize` URL) AND a working paste field simultaneously,
with the link surviving pi's immediately-following manual-code prompt step
(the review #1 critical fix / `authInfo` latch); (4) the GitHub Copilot
device-code flow answers the enterprise prompt and renders the real device
user code + verification link; (5) cancel closes the dialog with no stale
"Login failed" screen; (6) a concurrent `login_begin` while a flow is
in-flight is rejected `{ ok:false, reason:'busy' }` by the server
single-flight guard.

> Environment bound: completing a real token exchange needs real subscription
> credentials, unreachable here. The harness stops at the auth-URL /
> device-code / paste step and never submits a real code. Anthropic/OpenAI
> auth-URL emission is fully local (PKCE + localhost callback); Copilot
> device-code uses real network to `github.com/login/device/code`
> (unauthenticated device-flow start) — if unavailable, test 4 reports
> environment-bounded instead of failing.

**Location:** `tools/manual-test/provider-login-smoke/provider-login-smoke.mjs`

**Invocation:**

```bash
npm run build
node tools/manual-test/provider-login-smoke/provider-login-smoke.mjs
# Keep the coherence screenshots outside the (auto-removed) sandbox:
PL_SHOTS=/tmp/pl-shots node tools/manual-test/provider-login-smoke/provider-login-smoke.mjs
```

**Inputs:** none (fresh `os.tmpdir()` sandbox with its own HOME + XDG dirs;
`PL_SHOTS=<dir>` optionally redirects the screenshots outside the sandbox).

**Outputs:** per-test ✓/✗/⊝ lines + `01-picker.png` / `02-anthropic-auth.png` /
`02b-after-cancel.png` / `03-copilot-device.png` screenshots; non-zero exit on
any hard failure (environment-bounded items do not fail the run). On failure
the sandbox is preserved and its path printed.

**Prerequisites:** workspaces built (`npm run build`), `agent-browser` on
PATH, writable `os.tmpdir()`. Tracks and kills only the child PID it spawns.
No real LLM, speechmux, or subscription credentials required; Copilot test 4
uses real network to github.com (degrades to environment-bounded if absent).

### agent-browser (cross-repo skill)

**Purpose:** Drive PWA user journeys end-to-end via a headless-Chromium
CLI — `open`, `snapshot -i`, `click @ref`, `fill`, `eval`, `console`,
`screenshot`. The manual-testing skill's mandatory-reuse table lists it
as the default driver for browser / PWA journeys; this repo uses it to
drive journey 8's PWA half (Call button, full-screen calling-mode
surface, gesture-driven mute/hangup/abort).

**Location:** external skill at `~/.agents/skills/agent-browser/` — not
vendored into this repo. Installed globally as the `agent-browser` CLI.

**Invocation (journey 8 PWA half):**

```bash
# 1. Build + start pimote with a sandboxed XDG_CONFIG_HOME and a stub
#    voice block (see docs/manual-tests/voice-mode.md for the exact
#    config and the getUserMedia shim).
npm run build
XDG_CONFIG_HOME=... XDG_STATE_HOME=... node bin/pimote.js --port <free>

# 2. Drive the UI.
agent-browser open http://localhost:<free>/
agent-browser snapshot -i                     # find @refs
agent-browser click @<new-session-button>
agent-browser eval "$(cat patch-getusermedia.js)"  # real MediaStream shim
agent-browser click @<call-button>
agent-browser snapshot -i                     # expect calling-mode surface
                                              # (header + transcript + gesture zone)
# In-call interactions are gesture-driven: tap = mute toggle,
# swipe-up = hang up, swipe-down = abort. There is no inline
# `End call` button; drive hangup via a synthetic swipe-up
# pointer sequence on the gesture zone, or via
# `agent-browser eval 'window.__voiceCallStore?.endCall()'`
# when wired for tests. See docs/manual-tests/voice-call-
# fullscreen-ui.md for the recipe used in the most recent run.
agent-browser snapshot -i                     # calling mode gone, chat returns
```

**Inputs:** pimote server URL + session refs from each snapshot.

**Outputs:** snapshot diffs, screenshots (`agent-browser screenshot`),
console log (`agent-browser console`).

**Prerequisites:** `agent-browser` on PATH; pimote server running
locally; for voice-mode, a `getUserMedia` shim injected via
`agent-browser eval` because headless Chromium has no microphone and
`agent-browser` doesn't currently expose Chromium's
`--use-fake-device-for-media-stream` flag.
