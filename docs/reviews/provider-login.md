# Review: Interactive Provider Login (`/login`)

**Plan:** `docs/plans/provider-login.md`
**Diff range:** `2c5fdc04ac5afd91cc574b3f594887adeaad3691..HEAD` (commits `671944d`, `5f30010`, `c7d38dc`)
**Date:** 2026-06-04

## Summary

All nine plan steps were implemented faithfully and the server/client unit suites pass
(22 + 21 green); server `tsc --noEmit` is clean; test files were not modified during
implementation (immutability holds). The plan-adherence pass found no structural
deviations — the orchestrator, ws-handler routing, store, dialog, and `/login`
interception all match the architecture. The code-correctness pass found one **critical**
interaction bug between the orchestrator's callback mapping and pi's actual OAuth flow that
makes the Claude/ChatGPT (paste-back) path effectively unusable, plus a few low-severity
robustness/UX issues.

## Findings

### 1. Auth-URL step is clobbered by the manual-code prompt — Claude/ChatGPT login is unreachable

- **Category:** code correctness
- **Severity:** critical
- **Location:** `client/src/lib/stores/login.svelte.ts:103-122` (`handleStep`), `client/src/lib/components/LoginDialog.svelte:83-115` (auth branch); root cause spans `server/src/login-orchestrator.ts:120-167`
- **Status:** resolved

For the authorization-code providers (Anthropic, OpenAI), pi calls `onAuth({url,...})` and
then **immediately** `onManualCodeInput()` in the same tick (verified in
`node_modules/@earendil-works/pi-ai/dist/utils/oauth/anthropic.js:206-214` and
`openai-codex.js:258-261` — `onAuth` is followed by an un-awaited `onManualCodeInput()`
before `server.waitForCode()`).

The orchestrator maps `onAuth` → `emit{kind:'auth', url}` and `onManualCodeInput` →
`requestInput(...)` → `emit{kind:'prompt', message:'Paste the authorization code'}`. Both
land in the client as non-terminal steps, and `handleStep` stores every non-terminal step
in the single `state.currentStep` field, overwriting the previous one. So the sequence is:

1. `auth` step arrives → dialog briefly shows the "Open auth page" link + warning copy.
2. `prompt` step arrives a moment later → `currentStep` is overwritten → dialog now renders
   the bare prompt branch (`step.message` + plain input), and **the auth URL link is gone**.

The user is left on a "Paste the authorization code" prompt with no way to reach the
authorization URL — the primary action of the flow. This is the exact Claude/ChatGPT
paste-back path the brainstorm and plan centered on. (Device-code/Copilot is unaffected:
its terminal-relevant step is `device_code`, and its only preceding `prompt` — the
enterprise-URL question — is legitimately answered before the device code arrives.)

Secondary symptom from the same mismatch: the `auth` branch in `LoginDialog.svelte` renders
its own paste field whose submit calls `loginStore.submitInput()`, but `submitInput`
no-ops on `auth` steps (it only reads a `requestId` off `prompt`/`select` steps, and `auth`
has none). So even during the brief window the auth screen is visible, its Submit button
does nothing — the functional input is only the subsequent `prompt` step. The plan (step 8)
envisioned a single auth screen carrying both the link and the working paste field; the
orchestrator's two-step `onAuth` + `onManualCodeInput` mapping conflicts with that and the
store has no place to keep the auth URL alongside the prompt.

### 2. Pending login input can leak if the flow ends while an input is outstanding

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:1408-1430` (`createLoginTransport` / `awaitInput`), `server/src/login-orchestrator.ts:169-181`
- **Status:** resolved

`awaitInput` stores a `{resolve, reject}` in `pendingLoginInputs` and never removes it
except via a matching `login_input` (resolve+delete) or `login_cancel` (reject+clear). If
`authStorage.login` rejects or the flow ends for any reason _other_ than client cancel
while a `prompt`/`select` is still awaiting (e.g. provider-side timeout, network error
during the manual-input race), the map entry and its orphaned promise are never settled or
removed — a small per-flow leak, and the promise pi was awaiting never resolves. In the
common cancel path the entry is cleared, so impact is limited, but `runLogin` should clear
this connection's pending inputs in its `finally`/terminal path rather than relying on the
client to send `login_cancel`.

### 3. `loginAbort` is never reset after a flow ends

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/ws-handler.ts:766-779` (`login_cancel`), `1406-1409` (`createLoginTransport`)
- **Status:** resolved

`createLoginTransport` assigns `this.loginAbort = controller` but nothing clears it back to
`null` on completion. A `login_cancel` issued after a flow has already finished calls
`abort()` on a stale, completed controller. Harmless today (a new `login_begin` replaces it
before any new flow runs), but it leaves a dangling reference and a `login_cancel` that
reports success without anything to cancel.

### 4. Singleton login store subscription relies on transitive import, not an explicit side-effect import

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/routes/+layout.svelte:11-12`, `client/src/lib/stores/login-store.ts`
- **Status:** resolved

`voice-call-store` is wired with an explicit side-effect import (`import '$lib/stores/voice-call-store.js'`)
in `+layout.svelte` so its event subscription registers at boot. `login-store.ts` has no
such explicit import; its `connection.onEvent` subscription only registers because
`LoginDialog.svelte` and `InputBar.svelte` import `loginStore`. It works (both are in the
layout tree), but it's an implicit dependency inconsistent with the pattern step 7 said to
mirror — an explicit side-effect import would make the subscription robust to future
refactors that drop those component imports.

### 5. Busy `begin()` gives no user feedback

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/LoginDialog.svelte:11-13` (`pickProvider`), `client/src/lib/stores/login.svelte.ts:64-78` (`begin`)
- **Status:** resolved

`begin()` correctly returns `false` and leaves the flow on `picking` when the server
responds busy, but `pickProvider` discards the return value (`void loginStore.begin(id)`),
so a user tapping a provider while another flow is in progress sees nothing happen and no
explanation. Low stakes for a single-operator system, but a small toast/inline message
would avoid a dead-feeling tap.

## No Issues

- **Plan adherence:** no structural deviations. All nine steps are reflected in the diff
  (orchestrator `listProviders`/`isBusy`/`runLogin`, session-manager construction + accessor,
  ws-handler four-command routing + transport binding, `/login` autocomplete registration,
  client store, singleton wiring, `LoginDialog`, `InputBar` interception). Auth-step copy was
  softened to "copy the code shown (or from the page URL)" per the implementation-time
  paste-back investigation.
- **Test immutability:** `server/src/login-orchestrator.test.ts`, `client/src/lib/stores/login.svelte.test.ts`,
  and `shared/src/protocol.ts` are byte-identical between `pre-implementation-commit` and HEAD.
- **Single-flight guard / busy handling:** the synchronous `busy` check before the first
  `await` in `runLogin`, and the `isBusy()` pre-check in `login_begin`, are correct under
  Node's single-threaded model — no TOCTOU race.
