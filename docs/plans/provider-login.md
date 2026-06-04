# Plan: Interactive Provider Login (`/login` for pimote)

## Context

Give pimote a `/login` equivalent: an interactive PWA flow for logging into OAuth
subscription model providers (Claude Pro/Max, ChatGPT, GitHub Copilot) so a remote
operator can add those providers without SSHing into the server or hand-editing
`auth.json`. API-key and custom providers stay out of scope (file-on-disk / agent-
bootstrapped). See `docs/brainstorms/provider-login.md`.

## Architecture

### Impacted Modules

- **Protocol** — add login command types (`login_list`, `login_begin`, `login_input`,
  `login_cancel`) and a `login_step` event carrying a discriminated `LoginStep` union,
  plus the `login_list` response shape. No `sessionId` on these — login is global, not
  session-scoped.

- **Server** — `ws-handler` gains routing for the four `login_*` commands and registers
  `/login` in `get_commands` (autocomplete). It holds a per-connection map of pending
  login-input promises keyed by `requestId` (mirrors the existing `pendingUiResponses`
  mechanism) and resolves them on `login_input`/`login_cancel`. `session-manager`
  constructs and owns a single `LoginOrchestrator` (alongside the `AuthStorage` and
  `ModelRegistry` it already owns) and exposes it to `ws-handler`. No changes to session
  lifecycle — login does not open/touch a session.

- **Client** — a new global `LoginDialog.svelte` (mounted in `+layout.svelte` like
  `TreeDialog`) backed by a `LoginStore`. `InputBar` recognizes `/login` and opens the
  dialog (it does not send a `prompt`). On `login_step {kind:'done', success:true}` the
  store re-issues the existing `get_available_models` command for the viewed session so the
  model picker reflects the new provider (decision: initiating client re-pulls; no server
  broadcast). **Accepted trade-off:** _other_ connected clients/sessions stay stale until
  their next natural pull (e.g. reopening the picker). This is intentional for a single-
  operator system — a broadcast path was considered and rejected as unjustified complexity.

### New Modules

- **Login Orchestrator** (server) — `server/src/login-orchestrator.ts`. A server singleton
  owning references to the shared `AuthStorage` + `ModelRegistry`. Responsibilities:
  list OAuth providers with logged-in status; run a single login flow at a time (in-flight
  guard → "busy" for concurrent attempts); translate a connection-bound transport into pi's
  `OAuthLoginCallbacks`; on success call `modelRegistry.refresh()`. Pure-ish and unit-
  testable via an injected transport + an injected `AuthStorage`/`ModelRegistry` pair (or
  a thin login function seam). Depends on: pi SDK (`AuthStorage`, `ModelRegistry`,
  `OAuthLoginCallbacks`), Protocol (login step/command shapes).

### Interfaces

**Protocol additions** (`shared/src/protocol.ts`):

```ts
// Server → client, rendered generically by the modal.
type LoginStep =
  | { kind: 'auth'; url: string; instructions?: string }
  | { kind: 'device_code'; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { kind: 'prompt'; requestId: string; message: string; placeholder?: string; allowEmpty?: boolean }
  | { kind: 'select'; requestId: string; message: string; options: { id: string; label: string }[] }
  | { kind: 'progress'; message: string }
  | { kind: 'done'; success: boolean; providerName: string; error?: string };

interface LoginStepEvent {
  type: 'login_step';
  step: LoginStep;
}

// Client → server commands (CommandBase-shaped; carry the usual `id` for responses).
interface LoginListCommand {
  type: 'login_list';
} // resp: { providers: LoginProviderInfo[] }
interface LoginBeginCommand {
  type: 'login_begin';
  providerId: string;
} // resp: { ok: boolean; reason?: 'busy' }
interface LoginInputCommand {
  type: 'login_input';
  requestId: string;
  value: string;
}
interface LoginCancelCommand {
  type: 'login_cancel';
}

interface LoginProviderInfo {
  id: string;
  name: string;
  loggedIn: boolean;
}
```

`login_input` resolves the pending promise for `requestId`; `login_cancel` aborts the
in-flight flow (fires the `AbortSignal` and rejects any pending input).

**LoginOrchestrator** (`server/src/login-orchestrator.ts`):

```ts
interface LoginTransport {
  emit(step: LoginStep): void; // → login_step event
  requestInput(p: { requestId: string; message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
  requestSelect(p: { requestId: string; message: string; options: { id: string; label: string }[] }): Promise<string | undefined>;
  signal: AbortSignal;
}

class LoginOrchestrator {
  constructor(authStorage: AuthStorage, modelRegistry: ModelRegistry);
  listProviders(): LoginProviderInfo[]; // from getOAuthProviders + getAuthStatus
  isBusy(): boolean;
  // Resolves when the flow ends; throws on error. Emits a terminal 'done' step itself.
  runLogin(providerId: string, transport: LoginTransport): Promise<void>;
}
```

`runLogin` builds `OAuthLoginCallbacks` from the transport:
`onAuth(info) → emit{kind:'auth'}`; `onDeviceCode(info) → emit{kind:'device_code'}`;
`onPrompt(p) → requestInput(...)`; `onManualCodeInput() → requestInput(paste prompt)`;
`onSelect(p) → requestSelect(...)`; `onProgress(m) → emit{kind:'progress'}`;
`signal ← transport.signal`. Then `await authStorage.login(providerId, callbacks)` →
`modelRegistry.refresh()` → `emit{kind:'done', success:true}`. On throw/abort →
`emit{kind:'done', success:false, error}`. Concurrent `runLogin` while busy throws/returns
a busy signal that `ws-handler` maps to `login_begin` resp `{ ok:false, reason:'busy' }`.

**ws-handler transport binding:** for each connection, `requestInput`/`requestSelect`
create a `requestId`, emit the corresponding `prompt`/`select` step, store a resolver in a
per-connection `pendingLoginInputs` map, and await it; `login_input`/`login_cancel` resolve/
reject those entries. `emit` sends the `login_step` event over the connection.

**Client LoginStore** (`client/src/lib/stores/login.svelte.ts`): reactive flow state
(`idle | listing | picking | running | done`), current `LoginStep`, provider list; methods
`open()` (→ `login_list`), `begin(providerId)`, `submitInput(value)` (→ `login_input`),
`cancel()` (→ `login_cancel`); routes incoming `login_step` events; on terminal success
re-pulls `get_available_models`.

### Implementation-time investigations (non-architectural)

- **Soften Claude paste-back.** Verify whether pi's Anthropic flow (the `code=true` authorize
  param) can be driven so the post-auth redirect lands on a clean provider-hosted code-display
  page instead of a dead-localhost "can't connect" page. If so, the modal's instruction copy
  should say "copy the code shown" rather than "copy the URL off the error page." Carries no
  architectural impact (the modal shows URL + paste field either way); verify before promising.

### Technology Choices

None — no new dependencies. Reuses pi SDK auth/model APIs, the existing WS command/event
envelope, the existing request/response-by-requestId pattern, and the existing global-
overlay dialog mounting pattern.

## Tests

**Pre-test-write commit:** `437cbc62fa3918cd745a2cacd9d0307b0145c435`

### Interface Files

- `shared/src/protocol.ts` — added the provider-login wire contracts: `LoginProviderInfo`, the four client→server commands (`LoginListCommand`, `LoginBeginCommand`, `LoginInputCommand`, `LoginCancelCommand`) and their response shapes (`LoginListResponseData`, `LoginBeginResponseData`), the global `LoginStep` discriminated union + `LoginStepEvent`, and wired all of them into the `PimoteCommand` / `PimoteEvent` unions.
- `server/src/login-orchestrator.ts` — `LoginOrchestrator` class skeleton plus its dependency seams: `LoginAuthStorage` / `LoginModelRegistry` (narrow structural interfaces the real pi-SDK `AuthStorage` / `ModelRegistry` satisfy), the connection-bound `LoginTransport`, the locally-mirrored `LoginOAuthCallbacks` family, and the `LoginBusyError` type. Method bodies throw `not implemented`.
- `client/src/lib/stores/login.svelte.ts` — `LoginStore` class skeleton: `LoginStoreState` (flow state machine + provider list + current step + terminal result), the `LoginStoreSeams` injection point (`sendCommand` + `getViewedSessionId`), and the `open`/`begin`/`submitInput`/`cancel`/`handleStep`/`close` surface. Method bodies throw `not implemented`.

### Test Files

- `server/src/login-orchestrator.test.ts` — exercises `listProviders`, the single-flight in-flight guard, and `runLogin` happy/abort/failure paths against in-memory `AuthStorage` / `ModelRegistry` / transport fakes.
- `client/src/lib/stores/login.svelte.test.ts` — exercises the client flow state machine (open→pick→run→done), `login_step` routing, input submission, cancel/close, and the post-success model re-pull, all through an injected `sendCommand` fake.

### Behaviors Covered

#### LoginOrchestrator (server)

- Lists one entry per OAuth provider with `id`/`name`, marks `loggedIn` from auth status, and returns `[]` when no providers exist.
- Reports `isBusy()` false before a flow, true while a flow runs, and false again after it ends.
- Runs a single login flow at a time — a concurrent `runLogin` rejects with `LoginBusyError`; a second login is allowed once the first completes (including after a failure).
- Calls `authStorage.login` with the requested provider id and refreshes the model registry on success.
- Emits a terminal `done{success:true}` step on completion; translates provider callbacks into transport activity: `onAuth`→`auth` step, `onDeviceCode`→`device_code` step, `onProgress`→`progress` step, `onPrompt`→transport `requestInput`, `onSelect`→transport `requestSelect`, and threads the transport `AbortSignal` into the callbacks.
- On login failure emits a terminal `done{success:false, error}` step, does not refresh the model registry, and clears busy state so a retry can start.

#### LoginStore (client)

- `open()` sends `login_list`, populates the provider list from the response, and moves the flow to `picking`.
- `begin(id)` sends `login_begin` carrying the provider id, enters `running` and returns `true` on acceptance; on a `busy` response returns `false` and does not enter `running`.
- `handleStep` stores `auth` / `device_code` / `prompt` / `select` / `progress` steps as the current step.
- `submitInput(value)` sends `login_input` echoing the current prompt/select step's `requestId` and the submitted value.
- A terminal `done{success:true}` step moves the flow to `done`, records success, and re-pulls `get_available_models` for the viewed session (skipped when no session is viewed); a `done{success:false}` step records the failure + error and does not re-pull models.
- `cancel()` sends `login_cancel` and returns the flow to `idle`; `close()` resets the store to its initial idle state.

**Review status:** approved

## Steps

**Pre-implementation commit:** `2c5fdc04ac5afd91cc574b3f594887adeaad3691`

### Step 1: Implement `LoginOrchestrator.listProviders` and `isBusy`

In `server/src/login-orchestrator.ts`, fill in the two synchronous methods plus the
busy flag they depend on.

- Add a private `busy: boolean` field (initial `false`) and return it from `isBusy()`.
- `listProviders()` maps `authStorage.getOAuthProviders()` to `LoginProviderInfo[]`,
  setting `loggedIn` from `authStorage.getAuthStatus(p.id).configured`. Returns `[]`
  when `getOAuthProviders()` is empty.

The seam `LoginAuthStorage.getAuthStatus` returns `{ configured: boolean }`; the real
pi-SDK `AuthStatus` is a superset (`configured` + optional `source`/`label`), so the
real `AuthStorage` satisfies the seam unchanged.

**Verify:** the `LoginOrchestrator.listProviders` and `in-flight guard` (the
`isBusy() === false before any login`) describe blocks in
`server/src/login-orchestrator.test.ts` pass.
**Status:** done

### Step 2: Implement `LoginOrchestrator.runLogin`

In `server/src/login-orchestrator.ts`, implement the flow driver.

- Synchronously (before the first `await`) check `this.busy`; if set, throw
  `LoginBusyError`. Otherwise set `this.busy = true`. This ordering is what makes a
  concurrent `runLogin` issued in the same tick reject while the first is in flight.
- Build a `LoginOAuthCallbacks` object from the transport:
  - `onAuth(info)` → `transport.emit({ kind: 'auth', url, instructions })`
  - `onDeviceCode(info)` → `transport.emit({ kind: 'device_code', userCode,
verificationUri, expiresInSeconds })`
  - `onProgress(message)` → `transport.emit({ kind: 'progress', message })`
  - `onPrompt(prompt)` → allocate a `requestId`, return
    `transport.requestInput({ requestId, message, placeholder, allowEmpty })`
  - `onManualCodeInput()` → allocate a `requestId`, return `transport.requestInput(...)`
    with a paste-the-code message
  - `onSelect(prompt)` → allocate a `requestId`, return
    `transport.requestSelect({ requestId, message, options })`
  - `signal` ← `transport.signal`
- `await this.authStorage.login(providerId, callbacks)`; on success call
  `this.modelRegistry.refresh()` then `transport.emit({ kind: 'done', success: true,
providerName })`.
- On thrown error (including abort) emit `{ kind: 'done', success: false, providerName,
error: <message> }` and **do not** call `refresh()`. `runLogin` resolves (does not
  re-throw) in the failure/abort case — only `LoginBusyError` propagates.
- Always clear `this.busy = false` in a `finally` so a retry can start after success,
  failure, or abort.
- `providerName` comes from `listProviders()`/`getOAuthProviders()` lookup by id; fall
  back to `providerId` if not found.

Use a monotonic counter or `crypto.randomUUID()` for `requestId`s — they only need to
be unique within the flow.

**Verify:** the `LoginOrchestrator.runLogin success`, `runLogin failure`, and the
remaining `in-flight guard` blocks in `server/src/login-orchestrator.test.ts` pass.
Run `cd server && npx vitest run src/login-orchestrator.test.ts`.
**Status:** done

### Step 3: Construct and expose the `LoginOrchestrator` from `PimoteSessionManager`

In `server/src/session-manager.ts`, the manager already owns `this.authStorage`
(`AuthStorage.create()`) and `this.modelRegistry` (`ModelRegistry.create(...)`).

- Import `LoginOrchestrator` from `./login-orchestrator.js`.
- Add a `private readonly loginOrchestrator: LoginOrchestrator` field, constructed in
  the constructor after `authStorage`/`modelRegistry`:
  `new LoginOrchestrator(this.authStorage, this.modelRegistry)`. The real
  `AuthStorage`/`ModelRegistry` satisfy the `LoginAuthStorage`/`LoginModelRegistry`
  structural seams (`getOAuthProviders`, `getAuthStatus`, `login`; `refresh`).
- Add a public accessor `getLoginOrchestrator(): LoginOrchestrator` returning it.

**Verify:** `cd server && npx tsc --noEmit` (or the package's typecheck) passes; the
manager exposes a single shared orchestrator instance.
**Status:** done

### Step 4: Route the `login_*` commands in `ws-handler`

In `server/src/ws-handler.ts`, add handling for the four global login commands and a
per-connection pending-input map mirroring the existing `pendingUiResponses` pattern.

- Add a private field `private pendingLoginInputs = new Map<string, { resolve: (v: string) => void; reject: (e: unknown) => void }>()` and a
  `private loginAbort: AbortController | null = null` on `WsHandler`.
- Add four `case` branches in the top-level `switch (command.type)` in
  `handleMessage` (these are global — they must NOT go through
  `handleSessionCommand`, which requires a `sessionId`):
  - `case 'login_list'`: respond with
    `{ providers: this.sessionManager.getLoginOrchestrator().listProviders() }`.
  - `case 'login_begin'`: build a `LoginTransport` bound to this connection (see
    below), then call `getLoginOrchestrator().runLogin(command.providerId, transport)`.
    Guard with `isBusy()` / catch `LoginBusyError`: respond `{ ok: false, reason:
'busy' }` when busy, else respond `{ ok: true }` and let `runLogin` proceed
    (do not await it before responding — the flow drives async via `login_step`
    events). On terminal completion the transport's `emit` has already sent the
    `done` step.
  - `case 'login_input'`: look up `pendingLoginInputs.get(command.requestId)`, call
    its `resolve(command.value)`, delete the entry, respond `true`.
  - `case 'login_cancel'`: `this.loginAbort?.abort()`, reject + clear all
    `pendingLoginInputs`, respond `true`.
- The `LoginTransport` for a connection:
  - `emit(step)` → `this.sendEvent({ type: 'login_step', step })`.
  - `requestInput({ requestId, message, placeholder, allowEmpty })` → emit a
    `{ kind: 'prompt', requestId, message, placeholder, allowEmpty }` step, return a
    Promise stored in `pendingLoginInputs` keyed by `requestId`.
  - `requestSelect({ requestId, message, options })` → emit a
    `{ kind: 'select', requestId, message, options }` step, return a Promise stored
    in `pendingLoginInputs` keyed by `requestId` (resolves to the chosen id string;
    `login_input` carries it as `value`).
  - `signal` → a fresh `AbortController` stored in `this.loginAbort` for the duration
    of the flow.
- Add the four command types to the `PimoteCommand` discriminated switch so they no
  longer hit the `default: Unknown command type` arm.

Note: login is global, but the transport is connection-bound — only the initiating
connection receives the `login_step` events and resolves inputs.

**Verify:** `cd server && npx tsc --noEmit` passes. Manually: a `login_list` command
returns the provider list; `login_begin` for a busy orchestrator returns
`{ ok: false, reason: 'busy' }`.
**Status:** done

### Step 5: Register `/login` in `get_commands` autocomplete

In `server/src/ws-handler.ts`, in the `get_commands` handler's "Pimote built-in
commands" block (alongside `new`/`reload`/`tree`), push
`{ name: 'login', description: 'Log in to a model provider', hasArgCompletions: false }`.

**Verify:** `get_commands` response includes a `login` entry; `/login` appears in the
client slash-command autocomplete.
**Status:** done

### Step 6: Implement the client `LoginStore`

In `client/src/lib/stores/login.svelte.ts`, fill in the six method bodies against the
existing `LoginStoreState` + `LoginStoreSeams`.

- `open()`: set `flow = 'listing'`, send `{ type: 'login_list', id }` via
  `seams.sendCommand`, populate `state.providers` from the response
  `LoginListResponseData`, set `flow = 'picking'`.
- `begin(providerId)`: send `{ type: 'login_begin', id, providerId }`; read
  `LoginBeginResponseData`. If `ok`, set `flow = 'running'`, reset
  `currentStep`/`succeeded`/`error`, return `true`. If `!ok` (busy), leave flow
  unchanged and return `false`.
- `handleStep(step)`: for non-terminal kinds (`auth`/`device_code`/`prompt`/`select`/
  `progress`) set `state.currentStep = step`. For `kind === 'done'`: set
  `flow = 'done'`, `succeeded = step.success`, `error = step.error ?? null`; on
  `success === true` call `getViewedSessionId()` and, when non-null, send
  `{ type: 'get_available_models', id, sessionId }`. Do not re-pull on failure or when
  no session is viewed.
- `submitInput(value)`: read the `requestId` off the current `prompt`/`select` step
  and send `{ type: 'login_input', id, requestId, value }`.
- `cancel()`: send `{ type: 'login_cancel', id }`, set `flow = 'idle'`.
- `close()`: reset `state` to the initial idle object (`flow: 'idle'`, `providers:
[]`, `currentStep: null`, `succeeded: null`, `error: null`).

Each command needs an `id` — generate one (e.g. `crypto.randomUUID()`); the
test's `sendCommand` fake ignores it.

**Verify:** `cd client && npx vitest run src/lib/stores/login.svelte.test.ts` — all
`LoginStore.*` blocks pass.
**Status:** done

### Step 7: Wire the singleton `LoginStore` + `login_step` event routing

Create `client/src/lib/stores/login-store.ts` mirroring `voice-call-store.ts`:

- Construct `export const loginStore = new LoginStore({ sendCommand: (cmd) =>
connection.send(cmd), getViewedSessionId: () => sessionRegistry.viewedSessionId })`.
- Subscribe via `connection.onEvent((event) => { if (event.type === 'login_step')
loginStore.handleStep(event.step); })`.

Import `connection` from `./connection.svelte.js` and `sessionRegistry` from the
session-registry store (match how other singletons reach it).

**Verify:** importing `loginStore` routes incoming `login_step` events into the store;
`cd client && npx svelte-check` / typecheck passes.
**Status:** done

### Step 8: Build the `LoginDialog.svelte` component and mount it globally

Create `client/src/lib/components/LoginDialog.svelte`, a global overlay backed by
`loginStore` (pattern: `TreeDialog.svelte`). It renders by `loginStore.state.flow`:

- `picking`: list `state.providers` (name + logged-in badge); tapping one calls
  `loginStore.begin(id)`.
- `running`: render `state.currentStep` generically —
  - `auth`: a tappable "Open auth page" link to `step.url` + paste field that calls
    `loginStore.submitInput(value)`, with copy warning that a connection-error page is
    expected (paste-back guidance from the brainstorm).
  - `device_code`: show `userCode` + tappable `verificationUri`, waiting state.
  - `prompt`: message + text input → `submitInput`.
  - `select`: message + option buttons → `submitInput(optionId)`.
  - `progress`: message + spinner.
- `done`: success or `error` message; a button calls `loginStore.close()`.
- A cancel/close affordance calls `loginStore.cancel()` (while running) or
  `loginStore.close()` (terminal).

Mount `<LoginDialog />` in `client/src/routes/+layout.svelte` next to `<TreeDialog />`.

**Verify:** `/login` opens the modal; a full login flow (provider pick → auth/device
step → done) renders end-to-end against a running server.
**Status:** done

### Step 9: Intercept `/login` in `InputBar` to open the dialog

In `client/src/lib/components/InputBar.svelte`, before the prompt-send path in
`sendMessage()`, detect a bare `/login` command (trimmed input equals `/login`, mirror
how `/tree`'s server response is special-cased but here intercept client-side so no
`prompt` is sent). On match: call `loginStore.open()`, clear the input/autocomplete
state, and return without sending a `prompt`.

**Verify:** typing `/login` and submitting opens the login dialog and does not post a
user message or hit the agent.
**Status:** done
