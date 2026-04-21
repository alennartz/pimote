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
