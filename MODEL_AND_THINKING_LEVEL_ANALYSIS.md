# Model Selection & Thinking Level Analysis

Comprehensive investigation of how model selection and thinking level are tracked, initialized, and communicated between the pi SDK AgentSession and Pimote clients.

## Summary of Findings

This document is the result of a thorough search of the server/src/ directory. See the end for a summary table of all code locations.

### Key Insights

1. **Model and thinking level are NOT stored in ManagedSession** — they live only in the wrapped `session: AgentSession` and are accessed dynamically via `session.model` and `session.thinkingLevel`.

2. **Initialization involves timing concerns:**
   - Default model is set via `await session.setModel()` (async)
   - Default thinking level is set via `session.setThinkingLevel()` (sync)
   - Thinking level is set AFTER model setup

3. **session_opened event does NOT include model/thinking level** — the client must fetch this via a separate `get_state` command after receiving the event.

4. **No state-change events** — changing the model or thinking level does not emit an event (no `model_changed` or `thinking_level_changed` events).

5. **Client-side window of undefined values** — after `session_opened`, the client initializes with model: null and thinkingLevel: 'off', waiting for `get_state` to return.

6. **Event buffer does not track model/thinking level** — reconnecting clients miss changes unless a full_resync is triggered.

---

## Initialization Flow Diagram

```
+-- Session Creation (session-manager.ts:47-57) --+
|                                                  |
| createAgentSession({resourceLoader, ...})       |
|                                                  |
+--+----------------------------------------------+
   |
   |
   v
+-- Default Model (Lines 61-72) --+
|                                 |
| if (!sessionFilePath &&         |
|     config.defaultProvider &&   |
|     config.defaultModel) {      |
|   await session.setModel()      | ← ASYNC
| }                               |
|                                 |
+--+-----------------------------+
   |
   |
   v
+-- Default Thinking Level (Lines 76-78) --+
|                                          |
| if (!sessionFilePath &&                  |
|     config.defaultThinkingLevel) {       |
|   session.setThinkingLevel()             | ← SYNC
| }                                        |
|                                          |
+--+-------------------------------------+
   |
   |
   v
+-- ManagedSession Created (Lines 81-91) --+
|                                          |
| const managed: ManagedSession = {        |
|   session,  // model/thinking set above  |
|   ...                                    |
| }                                        |
|                                          |
+--+-------------------------------------+
   |
   | return sessionId
   |
   v
+-- WsHandler.openSession() --+
|                             |
| sessionManager.openSession  |
| await resolves              |
|                             |
+--+-------------------------+
   |
   | sendEvent({ type: 'session_opened', ... })
   |
   v
CLIENT
   |
   | receives session_opened
   v
sessionRegistry.addSession()  // model: null, thinkingLevel: 'off'
   |
   | Promise.all([
   |   get_state,
   |   get_messages,
   |   get_session_meta
   | ])
   |
   v
SERVER get_state retrieves session.model and session.thinkingLevel
   |
   | returns SessionState with actual model/thinking level
   v
CLIENT updates session.model and session.thinkingLevel
```

---

## Detailed Findings

### 1. ManagedSession Storage

**File:** `server/src/session-manager.ts:14`

```typescript
export interface ManagedSession {
  id: string;
  session: AgentSession; // ← Model/thinking level stored HERE
  folderPath: string;
  eventBuffer: EventBuffer;
  connectedClientId: string | null;
  lastActivity: number;
  status: 'idle' | 'working';
  needsAttention: boolean;
  sendLive: (event: PimoteSessionEvent) => void;
  unsubscribe: () => void;
}
```

**Key:** Model and thinking level are NOT direct properties. They're accessed via:

- `managed.session.model`
- `managed.session.thinkingLevel`

### 2. Default Model Initialization

**File:** `server/src/session-manager.ts:61-72`

```typescript
if (!sessionFilePath && this.config.defaultProvider && this.config.defaultModel) {
  const models = this.modelRegistry.getAvailable();
  const defaultModel = models.find((m) => m.provider === this.config.defaultProvider && m.id === this.config.defaultModel);
  if (defaultModel) {
    await session.setModel(defaultModel); // ← ASYNC
    console.log(`[pimote] Set default model: ${defaultModel.provider}/${defaultModel.id}`);
  } else {
    console.warn(`[pimote] Default model not found: ...`);
  }
}
```

**Observations:**

- Only for new sessions (`!sessionFilePath`)
- Both `defaultProvider` and `defaultModel` must be configured
- Uses `await` — is async
- Logs success or warning

### 3. Default Thinking Level Initialization

**File:** `server/src/session-manager.ts:76-78`

```typescript
if (!sessionFilePath && this.config.defaultThinkingLevel) {
  session.setThinkingLevel(this.config.defaultThinkingLevel as any); // ← SYNC
  console.log(`[pimote] Set default thinking level: ${this.config.defaultThinkingLevel}`);
}
```

**Observations:**

- Only for new sessions
- SYNC operation (no await)
- Runs AFTER model setup
- No validation of level value

### 4. Session Opening Events

**File:** `server/src/ws-handler.ts`

Three places where `session_opened` is sent:

#### New Session (Lines 217-240)

```typescript
const sessionId = await this.sessionManager.openSession(command.folderPath, sessionFilePath);
// ...
this.sendEvent({
  type: 'session_opened',
  sessionId,
  folder: { path, name, activeSessionCount, externalProcessCount, activeStatus },
});
```

#### Existing Session Resumption (Lines 157-192)

```typescript
if (existing) {
  // Ownership check...
  await this.claimSession(command.sessionId, existing);
  this.viewedSessionId = command.sessionId;
  this.sendEvent({
    type: 'session_opened',
    sessionId: command.sessionId,
    folder: { ... },
  });
}
```

#### Takeover (Lines 336-349)

```typescript
const takeoverSessionId = await this.sessionManager.openSession(
  command.folderPath,
);
// ...
this.sendEvent({
  type: 'session_opened',
  sessionId: takeoverSessionId,
  folder: { ... },
});
```

**Issue:** None of these include model or thinking level in the event payload.

### 5. State Retrieval

**File:** `server/src/ws-handler.ts`

#### get_state Command (Lines 594-610)

```typescript
case 'get_state': {
  const model = session.model;
  const state: SessionState = {
    model: model
      ? { provider: model.provider, id: model.id, name: model.name }
      : null,
    thinkingLevel: session.thinkingLevel,
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    autoCompactionEnabled: session.autoCompactionEnabled,
    messageCount: session.messages.length,
  };
  this.sendResponse(id, true, { state });
  break;
}
```

#### Full Resync (Lines 748-772)

```typescript
private sendFullResyncForSession(pimoteSessionId: string, managed: ManagedSession): void {
  const session = managed.session;
  const model = session.model;
  const state: SessionState = {
    model: model
      ? { provider: model.provider, id: model.id, name: model.name }
      : null,
    thinkingLevel: session.thinkingLevel,
    // ... other fields
  };
  const messages = mapAgentMessages(session.messages);
  const fullResyncEvent: FullResyncEvent = {
    type: 'full_resync',
    sessionId: pimoteSessionId,
    state,
    messages,
  };
  this.sendEvent(fullResyncEvent);
}
```

**Used when:** Session is reset (newSession, fork, navigateTree, switchSession)

### 6. Model/Thinking Commands

#### set_model (Lines 531-541)

```typescript
case 'set_model': {
  const models = managed.session.modelRegistry.getAvailable();
  const model = models.find(
    (m) => m.provider === command.provider && m.id === command.modelId,
  );
  if (!model) {
    this.sendResponse(id, false, undefined, `Model not found: ...`);
    break;
  }
  await session.setModel(model);
  this.sendResponse(id, true);
  break;
}
```

#### set_thinking_level (Lines 570-572)

```typescript
case 'set_thinking_level': {
  session.setThinkingLevel(command.level as any);
  this.sendResponse(id, true);
  break;
}
```

#### cycle_model (Lines 545-555)

```typescript
case 'cycle_model': {
  const result = await session.cycleModel();
  if (result) {
    this.sendResponse(id, true, {
      model: { provider: result.model.provider, id: result.model.id, name: result.model.name },
      thinkingLevel: result.thinkingLevel,
      isScoped: result.isScoped,
    });
  } else {
    this.sendResponse(id, true, null);
  }
  break;
}
```

**Key:** `cycleModel()` returns BOTH model AND thinkingLevel together, suggesting they're coupled.

#### cycle_thinking_level (Lines 576-579)

```typescript
case 'cycle_thinking_level': {
  const level = session.cycleThinkingLevel();
  this.sendResponse(id, true, { level });
  break;
}
```

### 7. Client-Side Handling

**File:** `client/src/lib/stores/session-registry.svelte.ts:268-292`

```typescript
case 'session_opened': {
  const folder = (event as any).folder;
  const projectName = folder?.name ?? 'Unknown';
  sessionRegistry.addSession(event.sessionId, folder?.path ?? '', projectName);
  connection.addSubscribedSession(event.sessionId);
  sessionRegistry.switchTo(event.sessionId);

  // Request initial state, messages, and meta atomically
  Promise.all([
    connection.send({ type: 'get_state', sessionId: event.sessionId }),
    connection.send({ type: 'get_messages', sessionId: event.sessionId }),
    connection.send({ type: 'get_session_meta', sessionId: event.sessionId }),
  ]).then(([stateRes, msgRes, metaRes]) => {
    const session = sessionRegistry.sessions[event.sessionId];
    if (!session) return;
    if (stateRes.success && stateRes.data) {
      const state = (stateRes.data as any).state;
      session.model = state.model;
      session.thinkingLevel = state.thinkingLevel;
      // ... update other fields
    }
    // ... handle msgRes and metaRes
  });
}
```

**Initial state from addSession (Lines 197-198):**

```typescript
model: null,
thinkingLevel: 'off',
```

**Issue:** There's a window where the client shows these default fallback values before get_state returns.

### 8. Event Protocol

**File:** `shared/src/protocol.ts`

#### SessionOpenedEvent (Line 440)

```typescript
export interface SessionOpenedEvent {
  type: 'session_opened';
  sessionId: string;
  folder: FolderInfo;
}
```

**Does NOT include** model or thinking level.

#### SessionState (Lines 35-44)

```typescript
export interface SessionState {
  model: { provider: string; id: string; name: string } | null;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  sessionFile: string | undefined;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
}
```

**DOES include** model and thinking level.

#### FullResyncEvent (Line 767)

```typescript
export interface FullResyncEvent {
  type: 'full_resync';
  sessionId: string;
  state: SessionState; // ← Includes model & thinkingLevel
  messages: PimoteAgentMessage[];
}
```

### 9. Config Defaults

**File:** `server/src/config.ts:7-12`

```typescript
export interface PimoteConfig {
  roots: string[];
  idleTimeout: number;
  bufferSize: number;
  port: number;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  // ... VAPID keys
}
```

**Applied in:** `session-manager.ts:62-78`

**Conditions:**

- Only for new sessions (`!sessionFilePath`)
- Only if the optional fields are configured

### 10. Event Buffer

**File:** `server/src/event-buffer.ts`

The event buffer does NOT track model/thinking level changes. It coalesces streaming deltas (message_update, tool_execution_update) but does not emit:

- `model_changed` events
- `thinking_level_changed` events

**Implications:**

- A reconnecting client won't know if model/thinking changed while disconnected
- Must wait for full_resync or manually query get_state
- Changes only visible in full_resync or get_state responses

---

## Timing Issues

### Issue #1: Async setModel Before Event Sent

The `session_opened` event is sent immediately after `openSession()` returns, but the default model setup uses `await session.setModel()`, which is async. There's no guarantee the model is fully set in the session object when the event is sent.

### Issue #2: Thinking Level Set After Model

The thinking level setup runs AFTER the default model setup. If setModel() takes time, there's a moment where the thinking level is set but the model is still resolving.

### Issue #3: Client Window of Undefined Values

After receiving `session_opened`, the client immediately adds the session with `model: null` and `thinkingLevel: 'off'`. These values remain until `get_state` returns (which is made in a Promise.all with get_messages and get_session_meta).

### Issue #4: No Atomic State in session_opened

The session_opened event doesn't include SessionState. If the client tries to use model/thinking level immediately after session_opened (before get_state returns), it will get the default fallback values.

---

## Missing Features

1. **No state-change events** — Changing the model or thinking level doesn't emit an event, so clients must poll or catch it via full_resync
2. **No ManagedSession caching** — Model/thinking level must be accessed via the wrapped session object every time
3. **No thinking level validation** — No check that the value is in the allowed set
4. **No "scoped" metadata** — No indication if a thinking level is scoped to a session vs global
5. **Event buffer ignores state changes** — Reconnecting clients miss changes unless full_resync is triggered

---

## Recommendations for Investigation

1. **Verify setModel() timing** — Confirm that `session.model` is set before `openSession()` returns and before the event is sent
2. **Test client race conditions** — Verify that the client doesn't use model/thinkingLevel before get_state returns
3. **Event-based state changes** — Consider emitting `model_changed` and `thinking_level_changed` events so reconnecting clients don't miss changes
4. **Atomic session_opened** — Consider including initial SessionState in the session_opened event
5. **ManagedSession caching** — Consider caching model/thinking level directly in ManagedSession for quick access
6. **Detailed timing logs** — Add logs around setModel() and setThinkingLevel() to identify bottlenecks

---

## Code Locations Reference Table

| Feature                                 | File                                             | Lines   |
| --------------------------------------- | ------------------------------------------------ | ------- |
| ManagedSession interface                | session-manager.ts                               | 14      |
| Default model initialization            | session-manager.ts                               | 61-72   |
| Default thinking level initialization   | session-manager.ts                               | 76-78   |
| session_opened event (new session)      | ws-handler.ts                                    | 221     |
| session_opened event (existing session) | ws-handler.ts                                    | 184     |
| session_opened event (takeover)         | ws-handler.ts                                    | 343     |
| set_model command handler               | ws-handler.ts                                    | 531-541 |
| set_thinking_level command handler      | ws-handler.ts                                    | 570-572 |
| cycle_model command handler             | ws-handler.ts                                    | 545-555 |
| cycle_thinking_level command handler    | ws-handler.ts                                    | 576-579 |
| get_state command handler               | ws-handler.ts                                    | 594-610 |
| sendFullResyncForSession method         | ws-handler.ts                                    | 748-772 |
| SessionState type definition            | shared/src/protocol.ts                           | 35-44   |
| SessionOpenedEvent type definition      | shared/src/protocol.ts                           | 440     |
| Client session_opened handler           | client/src/lib/stores/session-registry.svelte.ts | 268-292 |
| Client session initialization           | client/src/lib/stores/session-registry.svelte.ts | 197-198 |
| Config interface                        | server/src/config.ts                             | 7-14    |
| Config defaults loading                 | server/src/config.ts                             | 74-79   |
| PimoteSessionManager class              | server/src/session-manager.ts                    | 28-165  |

---

Generated by thorough code search of `server/src/` and related client/shared code.
