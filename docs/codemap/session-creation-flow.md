# Extension-Initiated New Session Creation in Pimote

## Overview

This document maps the complete flow of how extensions can trigger creating a new session in the pimote codebase, how sessions are associated with "slots" (UI tabs), and how the UI is updated when a new session is created.

## Key Concepts

### 1. Slots (Server-Side Session Representation)

A **slot** is the server's internal representation of an active session. The term comes from the UI concept where each open session appears as a tab/pill in the "session bar."

**File**: `/home/alenna/repos/pimote/server/src/session-manager.ts`

**Interface**:

```typescript
export interface ManagedSlot {
  runtime: AgentSessionRuntime; // The pi SDK runtime for this session
  folderPath: string; // Working directory path
  eventBusRef: { current: EventBusController | null };
  connection: ClientConnection | null; // WebSocket connection to client
  sessionState: SessionState; // Internal state tracking
  get session(): AgentSession; // Current session (from runtime)
}
```

**Storage**: Slots are stored in a `Map<string, ManagedSlot>` in the `PimoteSessionManager` class:

```typescript
private readonly sessions = new Map<string, ManagedSlot>();
```

### 2. Extension Command Context Actions

Extensions can trigger `newSession` through the `ExtensionCommandContextActions` interface.

**File**: `/home/alenna/repos/pimote/server/src/ws-handler.ts` (lines 38-76)

**Creation**:

```typescript
function createCommandContextActions(slot: ManagedSlot): ExtensionCommandContextActions {
  return {
    newSession: async (options) => {
      const result = await slot.runtime.newSession(options);
      if (!result.cancelled) await slot.connection?.onSessionReset?.(slot);
      return { cancelled: result.cancelled };
    },
    fork: async (entryId) => {
      /* similar */
    },
    navigateTree: async (targetId, options) => {
      /* similar */
    },
    switchSession: async (sessionPath) => {
      /* similar */
    },
    reload: () => slot.session.reload(),
  };
}
```

**Key Point**: The `onSessionReset` callback is invoked after the runtime completes the session reset, triggering the server-side flow.

### 3. Session Binding and Extension Setup

When a client claims a session, extensions are bound once.

**File**: `/home/alenna/repos/pimote/server/src/ws-handler.ts` (lines 819-853)

**Flow in `claimSession`**:

```typescript
private async claimSession(sessionId: string, slot: ManagedSlot): Promise<void> {
  const connection: ClientConnection = {
    ws: this.ws as EventSocket,
    connectedClientId: this.clientId,
    onSessionReset: (s) => this.handleSessionReset(s),  // Callback for session resets
  };
  slot.connection = connection;

  // Bind extensions on first claim
  if (!slot.sessionState.extensionsBound) {
    const uiContext = createExtensionUIBridge(slot, this.pushNotificationService);
    const commandContextActions = createCommandContextActions(slot);
    await slot.session.bindExtensions({ uiContext, commandContextActions });
    slot.sessionState.extensionsBound = true;
  }
}
```

## Session Creation Flow

### Step 1: Extension Triggers newSession

Extension code calls:

```typescript
const result = await ctx.commandContextActions.newSession();
```

### Step 2: Handler Calls Runtime.newSession()

In `ws-handler.ts`, the handler created at line 56:

```typescript
newSession: async (options) => {
  const result = await slot.runtime.newSession(options);
  if (!result.cancelled) await slot.connection?.onSessionReset?.(slot);
  return { cancelled: result.cancelled };
};
```

This:

1. Calls the pi SDK's `slot.runtime.newSession()`
2. If successful (not cancelled), invokes the `onSessionReset` callback

### Step 3: Server-Side Session Reset Handling

The `onSessionReset` callback invokes `handleSessionReset` (lines 856-906 in `ws-handler.ts`):

```typescript
private async handleSessionReset(slot: ManagedSlot): Promise<void> {
  const newSessionId = slot.runtime.session.sessionId;
  const oldSessionId = slot.sessionState.id;

  // navigateTree stays in the same file — same session ID, just resync
  if (newSessionId === oldSessionId) {
    this.sendFullResyncForSession(oldSessionId, slot);
    return;
  }

  // Session ID changed — rebuild session state in-place on the same slot
  const folderPath = slot.folderPath;

  // Step 1: Rebuild session state (tears down old, creates new from runtime.session)
  this.sessionManager.rebuildSessionState(slot);

  // Step 2: Re-key the session map (oldId → newId)
  this.sessionManager.reKeySession(slot, oldSessionId, newSessionId);

  // Step 3: Update handler bookkeeping
  this.subscribedSessions.delete(oldSessionId);
  this.subscribedSessions.add(newSessionId);
  if (this.viewedSessionId === oldSessionId) {
    this.viewedSessionId = newSessionId;
  }

  // Step 4: Rebind extension UI bridge (new session state for dialog routing)
  const uiContext = createExtensionUIBridge(slot, this.pushNotificationService);
  const commandContextActions = createCommandContextActions(slot);
  await slot.session.bindExtensions({ uiContext, commandContextActions });
  slot.sessionState.extensionsBound = true;

  // Step 5: Notify client with session_replaced event
  this.sendEvent({
    type: 'session_replaced',
    oldSessionId,
    newSessionId,
    folder: { /* folder info */ },
  });

  // Step 6: Broadcast sidebar updates
  WsHandler.broadcastSidebarUpdate(oldSessionId, folderPath, ...);
  WsHandler.broadcastSidebarUpdate(newSessionId, folderPath, ...);
}
```

### Step 4: Wire Protocol - SessionReplacedEvent

**File**: `/home/alenna/repos/pimote/shared/src/protocol.ts`

**Event Definition**:

```typescript
export interface SessionReplacedEvent {
  type: 'session_replaced';
  oldSessionId: string;
  newSessionId: string;
  folder: FolderInfo;
}
```

This event is sent from server to client via WebSocket.

### Step 5: Client-Side Session Registry Update

**File**: `/home/alenna/repos/pimote/client/src/lib/stores/session-registry.svelte.ts` (lines 674-682)

```typescript
case 'session_replaced': {
  const replaced = event as SessionReplacedEvent;
  const folder = replaced.folder;
  const projectName = folder?.name ?? 'Unknown';

  // Replace the old session with the new one in the registry
  sessionRegistry.replaceSession(
    replaced.oldSessionId,
    replaced.newSessionId,
    folder?.path ?? '',
    projectName
  );

  // Update WebSocket subscriptions
  connection.removeSubscribedSession(replaced.oldSessionId);
  connection.addSubscribedSession(replaced.newSessionId, folder?.path ?? '');

  // Clear old command store entries
  commandStore.removeSession(replaced.oldSessionId);

  // Fetch full state for the new session
  fetchFullSessionData(replaced.newSessionId);
  break;
}
```

**replaceSession Implementation** (line 439):

```typescript
replaceSession(oldSessionId: string, newSessionId: string, folderPath: string, projectName: string): void {
  // Remove old session
  const rest = { ...this.sessions };
  delete rest[oldSessionId];

  // Create new session state
  const next = this.createSessionState(newSessionId, folderPath, projectName);
  rest[newSessionId] = next;

  // Update the registry
  this.sessions = rest;

  // Update viewed session if the old one was being viewed
  if (this.viewedSessionId === oldSessionId) {
    this.viewedSessionId = newSessionId;
  }

  this.persistSessions();
  this.persistViewedSession();
}
```

### Step 6: UI Update - New Session Appears as Tab

**File**: `/home/alenna/repos/pimote/client/src/lib/components/ActiveSessionBar.svelte`

The session bar iterates over `sessionRegistry.activeSessions` (which is now updated with the new session):

```svelte
{#each sessionRegistry.activeSessions as session (session.sessionId)}
  {@const isViewed = sessionRegistry.viewedSessionId === session.sessionId}
  <button class="group/chip {isViewed ? 'bg-primary' : 'bg-secondary'} ..." onclick={() => handlePillClick(session.sessionId)} ...>
    <!-- Status indicator -->
    <span class="relative flex size-2">
      {#if session.status === 'working'}
        <span class="absolute inline-flex size-full animate-ping rounded-full ..."></span>
      {/if}
    </span>
    <!-- Session name/project name -->
    <span class="max-w-[80px] truncate">{session.projectName}</span>
  </button>
{/each}
```

## Extension UI Bridge

Extensions interact with the UI through the `ExtensionUIContext`, which is created by `createExtensionUIBridge`.

**File**: `/home/alenna/repos/pimote/server/src/extension-ui-bridge.ts`

**Key Features**:

- The bridge holds a direct reference to the `ManagedSlot`
- Dialog methods (select, confirm, input, editor) send `extension_ui_request` events and wait for responses
- Fire-and-forget methods (notify, setStatus, setWidget, setTitle, setEditorText) send events without waiting
- Pending UI requests survive reconnects via the `sessionState.pendingUiResponses` map

**Dialog Flow**:

1. Extension calls `ui.select(title, options)` or similar
2. Bridge sends `extension_ui_request` event with `requestId`
3. Creates a pending promise in `slot.sessionState.pendingUiResponses`
4. Client receives event and displays dialog
5. User responds with `extension_ui_response` command
6. Server resolves the pending promise
7. Extension continues execution

## Session State Lifecycle

**Creation**: `PimoteSessionManager.openSession(folderPath, sessionFilePath?)`

- Creates a new `AgentSessionRuntime`
- Calls `createSessionState()` to set up state tracking
- Creates a `ManagedSlot` and stores it in the sessions map
- Returns the `sessionId`

**Reset**: `handleSessionReset(slot)` (after newSession, fork, navigateTree, switchSession)

- Rebuilds session state via `rebuildSessionState()`
- Re-keys the sessions map
- Rebinds extensions with new UI bridges
- Sends `session_replaced` event

**Cleanup**: `PimoteSessionManager.closeSession(sessionId)`

- Calls `teardownSessionState()` to clean up listeners
- Disposes the runtime
- Removes from sessions map
- Notifies callbacks

## Key Files and Line References

| File                                                | Purpose                       | Key Functions/Classes                                               |
| --------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `server/src/session-manager.ts`                     | Session storage and lifecycle | `PimoteSessionManager`, `createSessionState`, `ManagedSlot`         |
| `server/src/ws-handler.ts`                          | WebSocket command handler     | `createCommandContextActions`, `handleSessionReset`, `claimSession` |
| `server/src/extension-ui-bridge.ts`                 | Extension UI integration      | `createExtensionUIBridge`                                           |
| `shared/src/protocol.ts`                            | Wire protocol types           | `SessionReplacedEvent`, `ExtensionUiRequestEvent`                   |
| `client/src/lib/stores/session-registry.svelte.ts`  | Client-side session state     | `SessionRegistry`, `replaceSession`, `handleEvent`                  |
| `client/src/lib/components/ActiveSessionBar.svelte` | UI tabs/pills                 | Session pill rendering and tab switching                            |

## Summary

1. **Slots** = Server-side session objects stored in a map and representing UI tabs
2. **Extension Flow**: Extension calls `newSession()` → Runtime resets → Server sends `session_replaced` event → Client updates registry → New session pill appears in tab bar
3. **UI Concept**: Each "slot" maps to a session pill/tab in the ActiveSessionBar component
4. **Key Callbacks**: `onSessionReset` bridges the runtime completion to the server's session management logic
5. **Extension UI Bridge**: Provides dialog/notification capabilities to extensions with pending request tracking for reconnect resilience
