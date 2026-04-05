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
  id: string; // session ID (from runtime.session.sessionId)
  eventBuffer: EventBuffer;
  status: 'idle' | 'working';
  needsAttention: boolean;
  lastActivity: number;
  unsubscribe: () => void; // event subscription cleanup

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
          if (event.type === 'agent_end') {
            unsub();
            resolve();
          }
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

## Steps

**Pre-implementation commit:** `171c41fb61b29b73f31ce0a72b1f6267f6550468`

### Step 1: Define the three-layer data model types

In `server/src/session-manager.ts`, replace the `ManagedSession` interface with three new interfaces and remove the old export:

**`ClientConnection`** — connection-scoped fields extracted from `ManagedSession`:

```ts
export interface ClientConnection {
  ws: EventSocket;
  connectedClientId: string;
  onSessionReset: ((slot: ManagedSlot) => Promise<void>) | null;
}
```

**`SessionState`** — per-session-ID state that is torn down and rebuilt on replacement:

```ts
export interface SessionState {
  id: string;
  eventBuffer: EventBuffer;
  status: 'idle' | 'working';
  needsAttention: boolean;
  lastActivity: number;
  unsubscribe: () => void;
  pendingUiResponses: Map<string, PendingUiEntry>;
  extensionsBound: boolean;
  panelState: Map<string, Card[]>;
  panelListenerUnsubs: (() => void)[];
  panelThrottleTimer: ReturnType<typeof setTimeout> | null;
}
```

**`ManagedSlot`** — the slot object stored in the session map, spanning the full session lifecycle:

```ts
export interface ManagedSlot {
  runtime: AgentSessionRuntime;
  folderPath: string;
  eventBusRef: { current: EventBusController | null };
  connection: ClientConnection | null;
  sessionState: SessionState;
  get session(): AgentSession; // convenience: this.runtime.session
}
```

Note: since TypeScript interfaces can't have getters, implement `ManagedSlot` as a class with a `get session()` accessor, or use a plain object where callers access `slot.runtime.session`. The architecture lists a convenience getter — decide at implementation time whether a class or a `createManagedSlot()` factory with `Object.defineProperty` is cleaner. Either way, `slot.session` must return `slot.runtime.session`.

Add the new SDK imports to the file:

```ts
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, createEventBus, AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent';
import type { AgentSession, AgentSessionRuntime, EventBusController, CreateAgentSessionRuntimeFactory } from '@mariozechner/pi-coding-agent';
```

Remove the `ManagedSession` interface export. The `EventSocket` and `PendingUiEntry` interfaces remain unchanged.

**Verify:** `grep -n 'interface ManagedSession' server/src/session-manager.ts` returns nothing. `grep -n 'ClientConnection\|ManagedSlot\|SessionState' server/src/session-manager.ts` shows the three new interfaces.
**Status:** done

### Step 2: Implement session state lifecycle helpers

In `server/src/session-manager.ts`, add two helper functions:

**`createSessionState()`** — constructs a `SessionState` from an `AgentSession`, `EventBusController`, and event subscription callback. This consolidates the event subscription + EventBuffer setup that is currently duplicated in `openSession` and `adoptSession`:

```ts
function createSessionState(
  session: AgentSession,
  eventBus: EventBusController,
  config: PimoteConfig,
  callbacks: {
    onStatusChange?: (sessionId: string, folderPath: string) => void;
    onAgentEnd?: (sessionId: string, managed: ManagedSlot) => void;
    sendEvent: (event: PimoteEvent) => void;
  },
): SessionState;
```

Inside: creates `EventBuffer`, subscribes to `session.subscribe()` (handling `agent_start`/`agent_end` status transitions and forwarding events to `EventBuffer.onEvent`), sets up panel listeners on the `eventBus` (`pimote:detect:request`, `pimote:panels`), and returns the populated `SessionState`.

The event subscription callback receives a `sendEvent` function (not a direct WebSocket ref) so it can be routed through the slot's connection at call time.

**`teardownSessionState()`** — cleans up a `SessionState`:

```ts
function teardownSessionState(state: SessionState): void;
```

Inside: calls `resolveAllPendingUi(state)`, clears `panelThrottleTimer`, calls all `panelListenerUnsubs`, calls `state.unsubscribe()`.

**Verify:** Both functions exist and are callable. `grep -n 'function createSessionState\|function teardownSessionState' server/src/session-manager.ts` shows both.
**Status:** done

### Step 3: Update session-manager helper functions for new types

Update all exported helper functions in `server/src/session-manager.ts` to operate on `ManagedSlot` (or its sub-objects) instead of `ManagedSession`:

- **`sendManagedEvent(slot: ManagedSlot, event: PimoteEvent)`** — reads `slot.connection?.ws` instead of `managed.ws`. Rename to `sendSlotEvent` for clarity (update all call sites in extension-ui-bridge.ts and ws-handler.ts).
- **`waitForManagedUiResponse`** → `waitForSlotUiResponse(slot: ManagedSlot, ...)` — reads `slot.sessionState.pendingUiResponses`.
- **`resolveManagedPendingUi`** → `resolveSlotPendingUi(slot: ManagedSlot, ...)` — reads `slot.sessionState.pendingUiResponses`.
- **`resolveAllManagedPendingUi`** → `resolveAllSlotPendingUi(slot: ManagedSlot)` — reads `slot.sessionState.pendingUiResponses`.
- **`replayManagedPendingUiRequests`** → `replaySlotPendingUiRequests(slot: ManagedSlot)` — iterates `slot.sessionState.pendingUiResponses`, sends via `sendSlotEvent`.

Update `setupPanelListeners(eventBus, slot)` and `schedulePanelPush(slot)` — panel state reads from `slot.sessionState.panelState`, event routing goes through `sendSlotEvent(slot, ...)`.

These renames propagate to `extension-ui-bridge.ts` and `ws-handler.ts` (steps 5 and 7), but the function signatures are established here.

**Verify:** `grep -n 'ManagedSession' server/src/session-manager.ts` returns nothing (only the three new types remain). All helper functions compile with the new parameter types.
**Status:** done

### Step 4: Rewrite PimoteSessionManager with runtime factory

Rewrite `PimoteSessionManager` in `server/src/session-manager.ts`:

**Remove:**

- `ensureProviders()` method and `providerInitByFolder` map — provider registration is now handled inside `createAgentSessionServices`.
- `detachSession()` method — no longer needed; session replacement is in-place on the slot.
- `adoptSession()` method — no longer needed.

**Change the session map type:**

```ts
private readonly sessions = new Map<string, ManagedSlot>();
```

**Rewrite `openSession(folderPath, sessionFilePath?)`:**

1. Create an `eventBusRef: { current: null as EventBusController | null }`.
2. Build a `CreateAgentSessionRuntimeFactory` closure that:
   - Creates a fresh `EventBus` and writes it to `eventBusRef.current`.
   - Calls `createAgentSessionServices({ cwd, agentDir, authStorage: this.authStorage, modelRegistry: this.modelRegistry, resourceLoaderOptions: { eventBus } })`.
   - Calls `createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })`.
   - Returns `{ ...sessionResult, services, diagnostics: services.diagnostics }`.
3. Call `createAgentSessionRuntime(factory, { cwd: folderPath, agentDir: getAgentDir(), sessionManager: sessionFilePath ? SessionManager.open(sessionFilePath) : SessionManager.create(folderPath) })`.
4. Apply default model/thinking level for new sessions (same as current, post-creation).
5. Create `SessionState` via `createSessionState(runtime.session, eventBusRef.current!, ...)`.
6. Construct a `ManagedSlot` object with `runtime`, `folderPath`, `eventBusRef`, `connection: null`, `sessionState`.
7. Add the `session` getter that returns `this.runtime.session`.
8. Store in the sessions map keyed by `sessionState.id`.

Import `getAgentDir` from the SDK: `import { getAgentDir } from '@mariozechner/pi-coding-agent'`. (Check the actual export — it may be from the config module; if not exported, use a hardcoded default or resolve from `~/.pi/agent`.)

**Rewrite `closeSession(sessionId)`:**

1. Get the `ManagedSlot` from the map.
2. Call `teardownSessionState(slot.sessionState)`.
3. Call `slot.eventBusRef.current?.clear()`.
4. Call `slot.runtime.session.dispose()` (or `slot.session.dispose()`).
5. Delete from the map.
6. Fire `onSessionClosed`.

**Update `getSession` and `getAllSessions` return types** to `ManagedSlot | undefined` and `ManagedSlot[]`.

**Add `reKeySession(slot, oldId, newId)`** — deletes the old key and sets the new key in the sessions map. Used by `handleSessionReset` in ws-handler.

**Update `startIdleCheck`** — reads `slot.connection?.connectedClientId` and `slot.sessionState.lastActivity` instead of flat fields.

**Update `extractFirstMessage` / `extractLastAgentMessage`** — takes `ManagedSlot` (reads `slot.session.messages`).

**Verify:** `npx tsc --noEmit 2>&1 | grep session-manager` shows no errors in session-manager.ts (other files may still error). `grep -n 'ensureProviders\|providerInitByFolder\|detachSession\|adoptSession' server/src/session-manager.ts` returns nothing.
**Status:** done

### Step 5: Update extension-ui-bridge for ManagedSlot

In `server/src/extension-ui-bridge.ts`:

- Change the import from `ManagedSession` to `ManagedSlot`.
- Change `createExtensionUIBridge(managed: ManagedSession, ...)` to `createExtensionUIBridge(slot: ManagedSlot, ...)`.
- Update all internal references:
  - `managed.id` → `slot.sessionState.id`
  - `managed.ws` → route through `sendSlotEvent(slot, event)` (import from session-manager)
  - `managed.pendingUiResponses` → `slot.sessionState.pendingUiResponses`
  - `managed.folderPath` → `slot.folderPath`
  - `managed.session?.sessionName` → `slot.session?.sessionName`
- Update `sendRequest()` to use `slot.sessionState.id` for `sessionId`.
- Update `dialogWithTimeout()` to read/delete from `slot.sessionState.pendingUiResponses`.
- Import `sendSlotEvent` and `waitForSlotUiResponse` from session-manager.

**Verify:** `grep -n 'ManagedSession' server/src/extension-ui-bridge.ts` returns nothing. `grep -n 'ManagedSlot' server/src/extension-ui-bridge.ts` shows the new type.
**Status:** done

### Step 6: Update createCommandContextActions for ManagedSlot and runtime

In `server/src/ws-handler.ts`, rewrite `createCommandContextActions`:

- Change parameter from `managed: ManagedSession` to `slot: ManagedSlot`.
- Session replacement calls use `slot.runtime`:
  - `slot.runtime.newSession(options)` — returns `{ cancelled: boolean }`. On success, call `slot.connection?.onSessionReset?.(slot)`.
  - `slot.runtime.fork(entryId)` — returns `{ cancelled: boolean, selectedText?: string }`. On success, call `slot.connection?.onSessionReset?.(slot)`.
  - `slot.runtime.switchSession(sessionPath)` — returns `{ cancelled: boolean }`. On success, call `slot.connection?.onSessionReset?.(slot)`.
- `navigateTree` stays on `slot.session.navigateTree(targetId, options)`. The existing `onSessionReset` call stays for the same-session-ID resync path.
- `waitForIdle` uses `slot.session.isStreaming` and `slot.session.subscribe()`.
- `reload` uses `slot.session.reload()`.

Note the return type change: the old code's `session.newSession()` returned `boolean` (success), the old `session.switchSession()` returned `boolean`. The runtime's versions all return `{ cancelled: boolean }`. The `createCommandContextActions` return type (`ExtensionCommandContextActions`) already expects `{ cancelled: boolean }` — verify this matches.

**Verify:** `grep -n 'session\.newSession\|session\.fork\|session\.switchSession' server/src/ws-handler.ts` returns nothing (all moved to `slot.runtime.*`). `grep -n 'slot\.runtime\.newSession\|slot\.runtime\.fork\|slot\.runtime\.switchSession' server/src/ws-handler.ts` shows the new calls.
**Status:** done

### Step 7: Rewrite handleSessionReset for in-place slot update

In `server/src/ws-handler.ts`, rewrite `handleSessionReset`:

The method now takes a `ManagedSlot` (the stable slot, not an "old managed session"). After the runtime has already replaced the session (called by `onSessionReset` from `createCommandContextActions`), `slot.runtime.session` is the new `AgentSession`.

**Same-session-ID path** (navigateTree): `slot.runtime.session.sessionId === slot.sessionState.id` → just send `full_resync`, no state rebuild. Same as current.

**Different-session-ID path** (newSession, fork, switchSession):

1. Capture `oldId = slot.sessionState.id`.
2. Call `teardownSessionState(slot.sessionState)` — resolves pending UI, clears timers, unsubscribes listeners.
3. Build new `SessionState` via `createSessionState(slot.runtime.session, slot.eventBusRef.current!, ...)` — the factory already created a fresh EventBus and wrote it to `eventBusRef.current`.
4. Assign `slot.sessionState = newState`.
5. Call `this.sessionManager.reKeySession(slot, oldId, newState.id)` — re-key the session map.
6. Rebind extension UI bridge: create a new bridge via `createExtensionUIBridge(slot, ...)`, create new command context actions via `createCommandContextActions(slot)`, call `slot.session.bindExtensions({ uiContext, commandContextActions })`. Set `slot.sessionState.extensionsBound = true`.
7. Update handler bookkeeping: `this.subscribedSessions.delete(oldId)`, `this.subscribedSessions.add(newState.id)`, update `viewedSessionId`.
8. Send `session_replaced` event to owning client.
9. Broadcast sidebar updates for both old and new session IDs.

This replaces the old detach → adopt → claimSession flow entirely.

**Verify:** `grep -n 'detachSession\|adoptSession' server/src/ws-handler.ts` returns nothing. The `handleSessionReset` method no longer creates new `ManagedSession` objects.
**Status:** done

### Step 8: Update remaining WsHandler methods for ManagedSlot

In `server/src/ws-handler.ts`, update all remaining references from `ManagedSession` to `ManagedSlot`:

**Imports:**

- Change `import type { PimoteSessionManager, ManagedSession }` to `import type { PimoteSessionManager, ManagedSlot }`.
- Change `import { resolveAllManagedPendingUi, ... }` to `import { resolveAllSlotPendingUi, resolveSlotPendingUi, replaySlotPendingUiRequests }`.

**`claimSession(sessionId, slot: ManagedSlot)`:**

- Create `ClientConnection` object: `{ ws: this.ws, connectedClientId: this.clientId, onSessionReset: (s) => this.handleSessionReset(s) }`.
- Set `slot.connection = connection`.
- Set `slot.sessionState.lastActivity = Date.now()`.
- Extension binding check uses `slot.sessionState.extensionsBound`.
- Create bridge with `createExtensionUIBridge(slot, ...)` and command actions with `createCommandContextActions(slot)`.
- Replay pending UI via `replaySlotPendingUiRequests(slot)`.

**`cleanup()`:**

- For each subscribed session, set `slot.connection = null` and `slot.sessionState.lastActivity = Date.now()`.

**`displaceOwner(sessionId, slot: ManagedSlot)`:**

- Reads `slot.connection?.connectedClientId`.

**`syncSessionToClient(sessionId, slot: ManagedSlot, lastCursor?)`:**

- Reads `slot.sessionState.eventBuffer` for replay.
- Reads `slot.sessionState.panelState` for panel snapshot.

**`sendFullResyncForSession(sessionId, slot: ManagedSlot)`:**

- Reads `slot.session` for state, `slot.sessionState.panelState` for panels.

**Session command handlers (`handleSessionCommand`):**

- All `managed.session` → `slot.session`.
- `managed.id` → `slot.sessionState.id`.
- `/new` command in prompt handler: `slot.runtime.newSession()` instead of `session.newSession()`. On success, trigger `slot.connection?.onSessionReset?.(slot)`.
- `new_session` command: same — `slot.runtime.newSession()` + `onSessionReset`.
- `abort` handler: `resolveAllSlotPendingUi(slot)` then `slot.session.abort()`.
- `set_model`: reads `slot.session.modelRegistry`.

**Other references:**

- `managedById` map in `list_sessions` handler: `Map<string, ManagedSlot>`.
- `open_session` handler: reads `slot.connection?.connectedClientId`, `slot.folderPath`.
- `close_session` handler: `resolveAllSlotPendingUi(slot)`.
- `view_session` handler: `slot.sessionState.needsAttention`, `slot.sessionState.panelState`.
- `broadcastSidebarUpdate`: `slot.sessionState.status`, `slot.sessionState.needsAttention`, `slot.connection?.connectedClientId`.

**Update the comment in `server/src/server.ts`** (line 183) to reference `ManagedSlot` instead of `ManagedSession`.

**Verify:** `grep -rn 'ManagedSession' server/src/ --include='*.ts' | grep -v test | grep -v node_modules` returns nothing (only comment updates remain, if any). `cd server && npx tsc --noEmit` passes.
**Status:** done

### Step 9: Update tests

Update test files to use the new types:

**`server/src/session-manager.test.ts`:**

- Replace `createFakeSession()` with `createFakeSlot()` returning a `ManagedSlot`.
- The fake slot needs: `runtime` (mock with `{ session: mockAgentSession }`), `folderPath`, `eventBusRef`, `connection` (null or mock `ClientConnection`), `sessionState` (mock `SessionState` with `id`, `eventBuffer`, `status`, etc.).
- Add a `get session()` that returns `this.runtime.session`.
- Update `injectSession` to inject `ManagedSlot` objects.
- Update `detachSession` tests → remove entirely (method no longer exists).
- Update `adoptSession` tests → remove entirely.
- Update idle reaper tests: read `slot.connection?.connectedClientId` for connected status, `slot.sessionState.lastActivity` for activity time.

**`server/src/ws-handler.test.ts`:**

- Replace `createMockManagedSession()` with `createMockSlot()` returning a `ManagedSlot`.
- Update all test assertions that access `.id`, `.ws`, `.connectedClientId`, `.status`, `.pendingUiResponses`, `.panelState`, etc. to go through `.sessionState.*` and `.connection.*`.
- Update `createMockSessionManager()` to return `ManagedSlot` from `getSession`/`getAllSessions`.
- Remove references to `detachSession` and `adoptSession` from mock session managers.

**`server/src/extension-ui-bridge.test.ts`:**

- Replace `createMockManaged()` with `createMockSlot()` returning a `ManagedSlot`.
- Update all `managed.id` → `slot.sessionState.id`, `managed.ws` → `slot.connection.ws`, `managed.pendingUiResponses` → `slot.sessionState.pendingUiResponses`, etc.
- Update `resolveUi()` helper to read from `slot.sessionState.pendingUiResponses`.

**Verify:** `cd server && npm test` passes. All existing test behaviors are preserved with updated type references.
**Status:** done
