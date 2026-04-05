# Plan: Pi SDK 0.65.0 Migration

## Context

Updating pimote's pi SDK from 0.64.0 to 0.65.0 and adopting the new `AgentSessionRuntime` pattern for session lifecycle. The 0.65.0 SDK removes session replacement methods (`newSession`, `fork`, `switchSession`) from `AgentSession` and moves them to `AgentSessionRuntime`. See [brainstorm](../brainstorms/sdk-065-migration.md).

## Architecture

### Impacted Modules

#### Server

The migration is entirely server-side. All changes are in `session-manager.ts` and `ws-handler.ts`, plus a `patch-package` patch on the SDK.

**`session-manager.ts`** — The current flat `ManagedSession` is restructured into three layers with distinct lifecycles. `PimoteSessionManager` creates runtimes via `createAgentSessionRuntime` with a factory that closes over shared `AuthStorage` and `ModelRegistry`. The `ensureProviders` / `providerInitByFolder` pattern is removed — provider registration is handled automatically by `createAgentSessionServices` inside the factory (duplicate registrations on the shared `ModelRegistry` are idempotent).

**`ws-handler.ts`** — `createCommandContextActions` calls `runtime.newSession()`, `runtime.fork()`, `runtime.switchSession()` instead of the removed `session.*` methods. `navigateTree` stays on `AgentSession`. The `/new` command and `new_session` handler use `runtime.newSession()`. `handleSessionReset` performs session state teardown/rebuild on the same slot instead of detach/adopt across two `ManagedSession` objects.

#### Protocol, Client, Panels

No changes. The wire format is unaffected — session replacement still produces the same `session_replaced`, `full_resync`, and `session_state_changed` events.

### Interfaces

#### Three-layer session data model

The current flat `ManagedSession` is split into three objects with distinct lifecycles:

**`ClientConnection`** — lives from claim to disconnect/displacement.

```ts
interface ClientConnection {
  ws: EventSocket;
  connectedClientId: string;
  onSessionReset: ((slot: ManagedSlot) => Promise<void>) | null;
}
```

**`ManagedSlot`** — lives from `openSession` to `closeSession`. Keyed by current session ID in the session map for client lookups. Re-keyed on session replacement.

```ts
interface ManagedSlot {
  runtime: AgentSessionRuntime;
  folderPath: string;
  eventBusRef: { current: EventBusController | null };
  connection: ClientConnection | null;
  sessionState: SessionState;
}
```

Convenience getter: `get session()` returns `this.runtime.session`.

The session map (`Map<string, ManagedSlot>`) is keyed by `sessionState.id`. On session replacement: delete old key, set new key, same slot object.

**`SessionState`** — lives for one session ID's lifetime. Torn down and rebuilt on session replacement.

```ts
interface SessionState {
  id: string;                    // session ID (from runtime.session.sessionId)
  eventBuffer: EventBuffer;
  status: 'idle' | 'working';
  needsAttention: boolean;
  lastActivity: number;
  unsubscribe: () => void;       // event subscription cleanup

  // Extension UI
  pendingUiResponses: Map<string, PendingUiEntry>;
  extensionsBound: boolean;

  // Panels
  panelState: Map<string, Card[]>;
  panelListenerUnsubs: (() => void)[];
  panelThrottleTimer: ReturnType<typeof setTimeout> | null;
}
```

#### Runtime factory

One factory per `ManagedSlot`, created in `openSession`. Closes over:
- Shared `AuthStorage` and `ModelRegistry` (process-lifetime, owned by `PimoteSessionManager`)
- `eventBusRef` (slot-lifetime mutable ref)

```ts
const eventBusRef = { current: null as EventBusController | null };

const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
  const eventBus = createEventBus();
  eventBusRef.current = eventBus;

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    authStorage: sharedAuthStorage,
    modelRegistry: sharedModelRegistry,
    resourceLoaderOptions: { eventBus },
  });

  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
```

Each factory invocation creates a fresh `EventBus`. The `eventBusRef` is written by the factory so the session state setup can read it to wire panel listeners.

#### Session replacement flow

After `runtime.newSession()` / `runtime.fork()` / `runtime.switchSession()` returns:

1. `runtime.session` is the new `AgentSession` (old one is disposed)
2. Resolve all pending UI responses on old session state (dialogs are dead)
3. Clear panel throttle timer, remove panel listener unsubs
4. Unsubscribe old event listener (already disposed, but clean up the reference)
5. Build new `SessionState` from `runtime.session` and `eventBusRef.current`
6. Subscribe to new session's events
7. Set up panel listeners on the new EventBus
8. Re-key the session map (old ID → new ID)
9. Rebind extension UI bridge (new session state for dialog routing)
10. Notify clients (`session_replaced`, sidebar updates)

`navigateTree` (same session ID, same session file) skips all of this — just sends a `full_resync`.

#### `createCommandContextActions`

Takes a `ManagedSlot` instead of a `ManagedSession`. Calls runtime methods:

```ts
function createCommandContextActions(slot: ManagedSlot): ExtensionCommandContextActions {
  return {
    newSession: async (options) => {
      const result = await slot.runtime.newSession(options);
      if (!result.cancelled) await slot.connection?.onSessionReset?.(slot);
      return { cancelled: result.cancelled };
    },
    fork: async (entryId) => {
      const result = await slot.runtime.fork(entryId);
      if (!result.cancelled) await slot.connection?.onSessionReset?.(slot);
      return { cancelled: result.cancelled };
    },
    switchSession: async (sessionPath) => {
      const result = await slot.runtime.switchSession(sessionPath);
      if (!result.cancelled) await slot.connection?.onSessionReset?.(slot);
      return { cancelled: result.cancelled };
    },
    navigateTree: async (targetId, options) => {
      const result = await slot.session.navigateTree(targetId, options);
      // Same session ID — no reset, just resync
      return result;
    },
    reload: () => slot.session.reload(),
    waitForIdle: () => {
      if (!slot.session.isStreaming) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const unsub = slot.session.subscribe((event) => {
          if (event.type === 'agent_end') { unsub(); resolve(); }
        });
      });
    },
  };
}
```

#### Default model and thinking level

Pimote's configured defaults (`config.defaultProvider`, `config.defaultModel`, `config.defaultThinkingLevel`) are applied in `openSession` only, after initial runtime creation, for new sessions (not resumed). This stays outside the factory because:
- `newSession()` replacements should get defaults — but the SDK's `createAgentSession` already resolves model from settings, which is sufficient.
- `fork()` inherits model/thinking from the source session (SDK handles this).
- `switchSession()` restores from the session file (SDK handles this).

No change from current behavior — defaults are applied post-creation in `openSession` for new sessions only.

#### `patch-package` patch

Removes `process.chdir()` from `AgentSessionRuntime.apply()` and `createAgentSessionRuntime()`. Already committed as `patches/@mariozechner+pi-coding-agent+0.65.0.patch`.

## Tests

> **Skipped.** No tests were written upfront. Follow red-green TDD as you implement —
> write a focused failing test, make it pass, move on. Aim for component-boundary
> behavioral tests (inputs, outputs, observable effects), not exhaustive coverage.

### Technology Choices

No new dependencies. The migration uses new APIs from the same `@mariozechner/pi-coding-agent` package (0.64.0 → 0.65.0):
- `AgentSessionRuntime`, `createAgentSessionRuntime`, `CreateAgentSessionRuntimeFactory`
- `createAgentSessionServices`, `createAgentSessionFromServices`
- `AgentSessionServices`, `AgentSessionRuntimeDiagnostic`
