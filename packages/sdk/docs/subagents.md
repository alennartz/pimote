# Subagents

The subagents module lets an extension show its child agents in Pimote. One provider per root session supplies four things:

- the child hierarchy
- guarded lifecycle controls
- leases on existing child sessions
- pure presenters that turn native pi data into typed cards

The my-pi subagents extension implements the provider.

## Register a provider

```ts
import { registerProvider } from '@pimote/sdk/subagents';

const unregister = registerProvider(pi, provider);
```

`owner` is an `ExtensionAPI` or a bare `EventBus`. The registration answers discovery until `unregister()` runs. `unregister()` publishes `{ provider: undefined }`, so hosts learn the provider is gone. It never disposes the provider. Unregister before you register a replacement.

## Discover a provider

```ts
import { discoverProvider } from '@pimote/sdk/subagents';

const discovery = discoverProvider(pi);
discovery.subscribe((provider) => {
  // The provider, a replacement, or undefined after removal.
});
```

Discovery installs its listener before it asks. A provider registered earlier is always reported.

## Provider contract

```ts
interface SubagentPresentationProvider extends SubagentProviderControls {
  snapshot(): SubagentTopologySnapshot;
  subscribe(listener: (event: SubagentTopologyEvent) => void): () => void;
  readonly presenters: SubagentPresenters;
}
```

### Topology

`snapshot()` returns the live nodes and a `sequence`. Subscribe first, then read the snapshot, then drop events whose `sequence` is at or below it. Events are `node_added`, `node_updated`, `node_removed`, `runtime_replaced`, and `ready`.

`ready` is false until the provider has restored every persisted child. Before `ready`, an absent path does not mean the child is gone.

Each node carries a path, an `incarnation`, and the current `sessionId`. The path is the public identity. The incarnation is unique for each spawn or resurrection at a path and survives runtime replacement. `held` and `heldSettlement` report the user hold.

### Controls

| Member                                           | Contract                                            |
| ------------------------------------------------ | --------------------------------------------------- |
| `acquire({ path, incarnation })`                 | Lease an existing child session for a view.         |
| `stop({ path, incarnation, expectedSessionId })` | Stop the current run. Rejected for another runtime. |
| `setHold({ path, incarnation, held })`           | Hold or release the child's settled results.        |
| `teardown({ path, incarnation })`                | Remove the child and its subtree.                   |
| `resurrect(request)`                             | Revive a torn-down child from its saved session.    |

Every control validates the full path and incarnation inside the owner's mutation queue.

A lease never changes orchestration. Opening or closing a view has no effect on what the parent agent receives. Only the explicit hold does.

### Leases

```ts
interface SubagentLease {
  readonly path: AgentPath;
  readonly incarnation: string;
  readonly session: BorrowedAgentSession;
  readonly capabilities: SubagentCapabilities;
  subscribe(listener: (event: SubagentLeaseEvent) => void): () => void;
  release(): void;
}
```

`session` throws after the lease closes or releases. Lease events are `rebound`, which carries a new session and capabilities, and `closed`, with reason `removed` or `unavailable`. `release()` is idempotent and never disposes the child.

`BorrowedAgentSession` exposes conversation controls and omits `abort`. Stop goes through `stop()`.

`capabilities.operations` lists the commands the child view admits. An absent list admits none.

## Presenters

```ts
interface SubagentPresenters {
  readonly toolNames: ReadonlyArray<string>;
  readonly customTypes: ReadonlyArray<string>;
  presentToolCall(input: SubagentToolCallInput): SubagentPresentation | undefined;
  presentMessage(input: SubagentMessageInput): ReadonlyArray<SubagentPresentation> | undefined;
  runningToolProgress(input: { sessionId: string; toolCallId: string }): unknown;
}
```

Presenters are pure. They read only their input and return the same output for the same input. For input they cannot read, they return `undefined`, and Pimote renders the native content.

The data comes from pi's own channels:

- **Tool arguments.** pi-ai parses partial arguments while they stream. `argsComplete` turns true at the end of the tool call.
- **Progress.** A tool calls `onUpdate` with details that hold its complete current state, never a delta. Pimote passes the latest details as `execution.progress`.
- **Results.** A tool result's `details` and text arrive as `execution: { state: 'complete' | 'error' }`. pi saves a result for every executed call, including validation failures.
- **Aborted calls.** A call in an assistant message that ended without a result arrives as `execution: { state: 'aborted' }`.
- **Custom messages.** A message whose `customType` is listed arrives through `presentMessage`. One message can carry several operations.

`runningToolProgress` returns the latest progress of a call that still runs, so a view that opens late shows current state.

Pimote annotates the native transcript in place. A presented tool call keeps its position and gains a card. A presented custom message keeps its row. Live changes travel as patches of presenter output, and snapshots carry full cards.

## Exports

`registerProvider`, `discoverProvider`, the channel constants `SUBAGENT_PROVIDER_REQUEST` and `SUBAGENT_PROVIDER_RESPONSE`, and the types for providers, topology, controls, leases, capabilities, and presentations.
