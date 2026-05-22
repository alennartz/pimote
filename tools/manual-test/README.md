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
