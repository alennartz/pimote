# Plan: Pi SDK 0.81 Upgrade

## Context

Upgrade Pimote from the installed `@earendil-works` 0.80.7 line to 0.81.1 without weakening its direct SDK embedding, server-global login flow, or type-derived SDK boundaries. The upgrade adopts Pi’s `ModelRuntime`, exposes provider-auth information notices in the PWA, counts all persisted billed work in `lifetimeCostUsd`, and deliberately keeps new summarization retry events server-local.

## Architecture

### Impacted Modules

- **Server** — `PimoteSessionManager` becomes the owner of one initialized `ModelRuntime`, shared with every session runtime and the server-global login orchestrator. This preserves DR-001’s direct embedding and DR-031’s rule that credentials and login are process-lifetime rather than session-scoped.
- **Server** — `LoginOrchestrator` remains the deep adapter between provider-owned Pi authentication and Pimote’s connection-bound login transport. It owns translation, request correlation, global single-flight behavior, and refresh completion; callers retain the existing small `listProviders`, `runLogin`, `logout`, and `isBusy` interface.
- **Protocol** — the global `LoginStep` union gains a provider-information notice that can carry zero or more labeled external links. Existing login commands remain global and unchanged.
- **Client** — `LoginStore` preserves every provider-information notice received during the current login flow, while `LoginDialog` renders those notices alongside the active interactive step. Notices must survive a later prompt, select, device-code, or progress event.
- **Server / Protocol boundary** — `EventBuffer` explicitly drops Pi’s new `summarization_retry_*` session events. Pimote’s existing client protocol will not grow retry-event variants in this upgrade; the exhaustive SDK-event mapper remains the one documented decision point.
- **Server cost accounting** — the pure lifetime-cost fold sums all persisted cost-bearing entries in the complete session history: assistant-message usage plus compaction and branch-summary usage. It remains idempotent, handles absent/invalid cost values as zero, and retains all-branch lineage semantics.
- **Panels** — the published package’s peer and development constraints are aligned with the target Pi line. Its EventBus-only `ExtensionAPI` use remains unchanged.

### Interfaces

#### Shared model runtime

`PimoteSessionManager` exposes an asynchronous construction seam so a fully initialized Pi model runtime exists before the manager is handed to WebSocket or voice infrastructure:

```ts
PimoteSessionManager.create(
  config: PimoteConfig,
  pushNotifications: PushNotificationService,
  options?: SessionManagerOptions,
): Promise<PimoteSessionManager>
```

The manager owns exactly one `ModelRuntime`. Every `createAgentSessionServices()` call receives that same runtime through its `modelRuntime` option. Session-level model commands read `session.modelRuntime`; no server code constructs or owns a second model/auth registry.

#### Provider login adapter

`LoginOrchestrator` accepts a narrow, injected model-runtime seam for tests, while production receives the real shared `ModelRuntime`. Its behavior is:

```ts
listProviders(): Promise<LoginProviderInfo[]>;
runLogin(providerId: string, transport: LoginTransport): Promise<void>;
logout(providerId: string): Promise<void>;
isBusy(): boolean;
```

`listProviders()` returns only providers with OAuth authentication. A provider is `loggedIn` only when the runtime’s asynchronous auth check reports OAuth credentials, not merely an ambient API key. `runLogin()` invokes the provider-owned OAuth flow with a connection-bound interaction adapter and waits for `ModelRuntime.refresh()` before emitting its successful terminal step. `logout()` awaits both credential removal and refresh before returning. Global single-flight and connection ownership remain unchanged.

The interaction adapter maps Pi authentication events as follows:

| Pi interaction             | Pimote login step |
| -------------------------- | ----------------- |
| `auth_url`                 | `auth`            |
| `device_code`              | `device_code`     |
| `progress`                 | `progress`        |
| `info`                     | `info`            |
| text or manual-code prompt | `prompt`          |
| select prompt              | `select`          |

A cancelled provider prompt rejects the Pi interaction rather than resolving an invalid empty value. SDK callback and event types are derived from the public `ModelRuntime.login` signature; Pimote does not add a direct dependency on `@earendil-works/pi-ai`, consistent with DR-039.

#### Provider-information protocol and client state

The global server-to-client login union gains:

```ts
type LoginInfoLink = { url: string; label?: string };
type LoginInfoStep = {
  kind: 'info';
  message: string;
  links?: LoginInfoLink[];
};
```

`LoginStore` adds a reset-per-flow ordered notice collection. Receiving `info` appends to that collection and does not replace `currentStep`; other interactive steps retain current behavior. `LoginDialog` renders accumulated notices above the active login control, including external links opened in a new tab with `rel="noopener noreferrer"`. The existing authorization-URL latch remains dedicated to authorization-code login and is not repurposed as a generic notice mechanism.

#### Lifetime-cost fold

The cost module’s public pure function becomes `sumLifetimeCostUsd(entries: SessionEntry[]): number`. For each entry in the complete session entry log, it contributes `usage.cost.total` exactly once when the entry is either:

- a message entry whose message role is `assistant`,
- a `compaction` entry, or
- a `branch_summary` entry.

All other entry kinds and missing, non-finite, or negative values contribute zero. The server continues to call this fold when hydrating `SessionMeta.lifetimeCostUsd`; no client-side accumulator is introduced.

### Technology Choices

- **Pi model/auth integration:** adopt the public `ModelRuntime` supplied by `@earendil-works/pi-coding-agent` 0.81.1. Retaining removed `AuthStorage` construction or creating a parallel auth abstraction would diverge from Pi’s canonical provider-owned authentication path.
- **Pi-AI imports:** derive interaction types from `ModelRuntime` rather than adding `@earendil-works/pi-ai` as a direct dependency. This follows the dependency discipline established by DR-039 and keeps the package graph no broader than needed.
- **Summarization retries:** explicitly drop the new SDK retry events at the existing mapper. Extending the live WebSocket protocol and client status UI is deferred; it is not required for a correct upgrade.

### DR Supersessions

- **DR-028** (Server-side idempotent cost recompute over the session branch) — superseded because Pi 0.81 persists usage for compaction and branch-summary work that the former assistant-message-only fold could not observe. `lifetimeCostUsd` now means every persisted billed operation across the complete session history, still computed server-side as a pure idempotent fold.

## Tests

**Pre-test-write commit:** `0634ecbb7a7a4e8787f348936541b7aedde3899a`

### Interface Files

- `shared/src/protocol.ts` — materializes the global `LoginStep` information-notice variant and its optional labeled links.
- `client/src/lib/stores/login.svelte.ts` — materializes the flow-scoped `infoSteps` state interface; accumulation behavior is intentionally unimplemented.
- `server/src/session-cost.ts` — materializes the `sumLifetimeCostUsd(entries)` pure-function interface as an explicit unimplemented stub.

### Test Files

- `client/src/lib/stores/login.svelte.test.ts` — extends the LoginStore behavioral contract for retaining a provider-information notice while a later interactive step is active.
- `server/src/session-cost.test.ts` — extends the cost-fold behavioral contract for persisted compaction and branch-summary usage.

### Behaviors Covered

#### LoginStore provider notices

- An `info` step remains available after a later prompt becomes the active interactive step, including its external link metadata.
- Starting a new login flow or closing the dialog clears all notices retained from the prior flow.

#### Lifetime cost

- A complete session-history fold includes assistant-message, compaction, and branch-summary `usage.cost.total` values exactly once.
- Missing, non-finite, negative, and non-cost-bearing values leave valid accumulated spend unchanged.

#### Red Gate

- `server/src/session-cost.test.ts` runs with the new lifetime-cost test red through the explicit `not implemented` stub.
- `client/src/lib/stores/login.svelte.test.ts` runs with the new notice-retention test red because no accumulation behavior exists yet.
- Shared/server compilation and client checking remain green.

**Review status:** approved

## Steps

### Step 1: Resolve the 0.81.1 package line and initialize one shared runtime

Use npm workspace dependency commands to move the root and server runtime dependencies, plus the panels peer and development dependency, to the `0.81.1` line and regenerate `package-lock.json`. Do not add `@earendil-works/pi-ai` as a direct dependency. Replace synchronous `AuthStorage`/`ModelRegistry` construction in `server/src/session-manager.ts` with asynchronous `ModelRuntime.create()` ownership behind `PimoteSessionManager.create(...)`; pass the one resulting runtime to every `createAgentSessionServices({ modelRuntime })` call. Update `server/src/index.ts` and all `PimoteSessionManager` construction tests to await the factory, and migrate `server/src/session-manager-open-session.test.ts` mocks to assert that exact runtime is threaded into services.

**Verify:** `npm ls @earendil-works/pi-coding-agent @earendil-works/pi-agent-core` resolves only 0.81.1 for the live workspace path; session-manager lifecycle/open-session tests pass with the shared target runtime.
**Status:** not started

### Step 2: Adapt session model controls and global provider login to ModelRuntime

In `server/src/login-orchestrator.ts`, replace the old auth-storage/model-registry seams with a narrow injected seam derived from `ModelRuntime`’s public methods. Make listing and logout asynchronous; list only OAuth-capable providers, identify an active OAuth credential through `checkAuth`, drive `login(providerId, 'oauth', interaction)`, map all provider interaction events including `info`, reject cancelled input, and await refresh before successful completion or logout return. Preserve the current global single-flight and connection-bound transport behavior. Update `server/src/ws-handler.ts` to await provider listing/logout and to await `session.modelRuntime.getAvailable()` for model selection/listing. Update default-model selection and diagnostics in `server/src/session-manager.ts` to await its shared runtime. Rewrite the existing login and WebSocket/session test fakes to the target seam while retaining their behavioral assertions and add coverage for information-event mapping and refresh ordering.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/login-orchestrator.test.ts src/session-manager-open-session.test.ts src/ws-handler.test.ts` and `tsc --noEmit -p server/tsconfig.json` pass.
**Status:** not started

### Step 3: Complete provider-information handling in the PWA

Implement the `LoginStore` flow-scoped notice collection: append `info` steps without replacing the active interactive step, and clear notices in both `begin()` and `close()`. Extend `client/src/lib/components/LoginDialog.svelte` to render notices above the active login control, including all optional external links with the established safe new-tab attributes. Leave the authorization-code URL latch separate. Keep the existing shared protocol commands and client-side post-login model re-pull behavior unchanged.

**Verify:** `npm run test --workspace=client -- --run src/lib/stores/login.svelte.test.ts` and `npm run check --workspace=client` pass.
**Status:** not started

### Step 4: Preserve exhaustive event mapping while dropping summary retries

Update `server/src/event-buffer.ts` to explicitly return `null` for Pi 0.81’s `summarization_retry_scheduled`, `summarization_retry_attempt_start`, and `summarization_retry_finished` events. Add focused `EventBuffer` assertions that all three events produce no client event, preserving the existing protocol decision without weakening the `never` exhaustiveness guard.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/event-buffer.test.ts` and the server type check pass.
**Status:** not started

### Step 5: Replace assistant-only cost accounting with the lifetime fold

Replace the `sumLifetimeCostUsd` stub in `server/src/session-cost.ts` with the pure complete-history fold, remove the superseded assistant-only export and tests, and update `server/src/ws-handler.ts` to use the new function for `SessionMeta.lifetimeCostUsd`. The implementation must count exactly one finite, non-negative `usage.cost.total` for assistant message, compaction, and branch-summary entries, and ignore every other entry. Update comments to describe the complete persisted-cost policy and retain all-branch recomputation.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/session-cost.test.ts src/ws-handler.test.ts` passes, including the red lifetime-cost tests from the plan.
**Status:** not started

### Step 6: Run the complete upgrade verification suite

Run formatting checks, full workspace type checks, server/client/panels tests, and the provider-login smoke driver. Exercise an existing session containing compaction and a branch summary to confirm session reopening, tree navigation, full resync, and lifetime-cost hydration remain valid. Confirm no configured default model refers to a removed upstream model before release.

**Verify:** `npm run format:check`, `npm run check`, `npm run test --workspace=@pimote/server -- --run`, `npm run test --workspace=client -- --run`, `npm run test --workspace=@pimote/panels -- --run`, and `node tools/manual-test/provider-login-smoke/provider-login-smoke.mjs` all pass.
**Status:** not started
