# Extension-Initiated New Session Creation: Code Exploration Summary

## Task Completed ✓

Successfully mapped extension-initiated new session creation in the pimote codebase, including:

1. **Where extensions can trigger creating a new session**
2. **How sessions are associated with 'slots' (UI tabs/positions)**
3. **The complete flow from extension request to UI display**

## Key Findings

### 1. Slots = Server-Side Session Representation

- **Type**: `ManagedSlot` interface in `server/src/session-manager.ts`
- **Storage**: `Map<string, ManagedSlot>` in `PimoteSessionManager`
- **Contents**: runtime, folderPath, connection, sessionState, eventBusRef
- **UI Mapping**: Each slot appears as a session pill/tab in `ActiveSessionBar.svelte`

### 2. Extension Entry Point

- **File**: `server/src/ws-handler.ts` (lines 38-76)
- **Function**: `createCommandContextActions(slot)`
- **API**: `ctx.commandContextActions.newSession()`
- **Connection**: Extensions get direct reference to the slot they're running in

### 3. Session Creation Flow (6 Steps)

1. Extension calls `ctx.commandContextActions.newSession()`
2. Handler calls `slot.runtime.newSession()` (pi SDK)
3. On success, invokes `slot.connection?.onSessionReset?.(slot)`
4. Server rebuilds session state via `handleSessionReset()`
5. Server sends `SessionReplacedEvent` (wire protocol)
6. Client updates `SessionRegistry` and new pill appears in UI

### 4. Key Callbacks & Lifecycle

- **onSessionReset**: Bridges runtime completion to server session management
- **rebuildSessionState()**: Tears down old, creates new session state
- **reKeySession()**: Updates sessions map from oldId → newId
- **createExtensionUIBridge()**: Provides dialog/notification capabilities

### 5. Wire Protocol

- **Event Type**: `SessionReplacedEvent`
- **Fields**: oldSessionId, newSessionId, folder
- **Sent**: After successful session reset on server
- **Received**: Client's `handleEvent('session_replaced')` in SessionRegistry

### 6. Client-Side Update

- **File**: `client/src/lib/stores/session-registry.svelte.ts` (line 674)
- **Method**: `replaceSession(oldId, newId, folderPath, projectName)`
- **Actions**:
  - Delete old session from registry
  - Create new session state
  - Update viewed session if needed
  - Subscribe to new session events
  - Fetch full session data

### 7. UI Display

- **Component**: `client/src/lib/components/ActiveSessionBar.svelte`
- **Rendering**: Iterates `sessionRegistry.activeSessions` with Svelte each block
- **Display**: Session pills with status indicator (idle/working/attention)
- **Interaction**: Click to switch sessions, close buttons

## Core Concept: The Slot-Based Architecture

The pimote design uses a **slot-based** approach where:

- Each active session gets a `ManagedSlot` on the server
- Extensions execute in the context of a specific slot
- The slot holds direct references (runtime, connection, sessionState)
- This allows extensions to trigger mutations while maintaining server-side tracking
- Connections can change (reconnects) but the slot persists

## Important Files Reference

| File                                                | Lines          | Purpose                                                       |
| --------------------------------------------------- | -------------- | ------------------------------------------------------------- |
| `server/src/session-manager.ts`                     | 1-280          | Session storage, ManagedSlot, createSessionState              |
| `server/src/ws-handler.ts`                          | 38-76, 819-906 | createCommandContextActions, claimSession, handleSessionReset |
| `server/src/extension-ui-bridge.ts`                 | 1-200          | UI dialog/notification bridge for extensions                  |
| `shared/src/protocol.ts`                            | 300-400        | SessionReplacedEvent and wire protocol types                  |
| `client/src/lib/stores/session-registry.svelte.ts`  | 1-700          | SessionRegistry, replaceSession, event handling               |
| `client/src/lib/components/ActiveSessionBar.svelte` | 1-250          | Session pill UI rendering                                     |

## Generated Documentation

Two detailed documents have been created and saved:

1. **`session-creation-flow.md`**
   - Comprehensive walkthrough of the entire flow
   - Code snippets and interface definitions
   - Step-by-step explanation with line numbers
   - Extension UI bridge details
   - Session state lifecycle

2. **`session-creation-sequence.txt`**
   - ASCII sequence diagrams of the flow
   - Data structure visualizations
   - Extension-to-slot connection architecture
   - Server/client state organization

## Next Steps

This documentation can be used for:

- Onboarding new developers to the pimote codebase
- Designing new features that involve sessions/extensions
- Debugging session creation issues
- Understanding the slot-based architecture for future refactoring

All documentation is stored in `/home/alenna/repos/pimote/docs/codemap/`
