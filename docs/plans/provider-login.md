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
