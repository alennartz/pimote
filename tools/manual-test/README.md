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

### agent-browser (cross-repo skill)

**Purpose:** Drive PWA user journeys end-to-end via a headless-Chromium
CLI — `open`, `snapshot -i`, `click @ref`, `fill`, `eval`, `console`,
`screenshot`. The manual-testing skill's mandatory-reuse table lists it
as the default driver for browser / PWA journeys; this repo uses it to
drive journey 8's PWA half (Call button, in-call banner, hangup).

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
agent-browser snapshot -i                     # expect Mute + End call
agent-browser click @<end-call-button>
agent-browser snapshot -i                     # banner gone
```

**Inputs:** pimote server URL + session refs from each snapshot.

**Outputs:** snapshot diffs, screenshots (`agent-browser screenshot`),
console log (`agent-browser console`).

**Prerequisites:** `agent-browser` on PATH; pimote server running
locally; for voice-mode, a `getUserMedia` shim injected via
`agent-browser eval` because headless Chromium has no microphone and
`agent-browser` doesn't currently expose Chromium's
`--use-fake-device-for-media-stream` flag.
