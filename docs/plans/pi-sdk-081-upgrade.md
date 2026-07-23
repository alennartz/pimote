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

#### Lifetime cost

- A complete session-history fold includes assistant-message, compaction, and branch-summary `usage.cost.total` values exactly once.

#### Red Gate

- `server/src/session-cost.test.ts` runs with the new lifetime-cost test red through the explicit `not implemented` stub.
- `client/src/lib/stores/login.svelte.test.ts` runs with the new notice-retention test red because no accumulation behavior exists yet.
- Shared/server compilation and client checking remain green.
