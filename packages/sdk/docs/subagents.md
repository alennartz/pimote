# Subagents

The subagents module supplies the interactive child view for a root session. One provider per session publishes a root-relative hierarchy, typed operations, one ordered replay cursor, and leases to child sessions that already exist.

Pimote renders the hierarchy in the session side panel. Opening a child attaches a view to the existing runtime, so the view never starts a second agent. The child runtimes stay owned by the extension that created them.

The my-pi subagents extension implements this provider for Pimote.

## Register a provider

```ts
import { registerProvider } from '@pimote/sdk/subagents';

const unregister = registerProvider(pi, provider);
```

`registerProvider(owner, provider)` publishes one provider on the session EventBus. `owner` is an `ExtensionAPI` or a bare `EventBus`, so a test can use the seam without a full pi object.

Registering again on the same bus deactivates the previous responder and delivers the new provider to a discovery that already runs.

The returned function stops answering. It never disposes the provider or its child sessions.

## Discover a provider

```ts
import { discoverProvider } from '@pimote/sdk/subagents';

const discovery = discoverProvider(pi, (provider) => {
  // The current provider, or undefined when none is registered.
});
```

`discoverProvider` reports the current provider, then every later registration and replacement. It returns a handle with `provider`, `subscribe` (alias `onProvider`), and `close`.

`SUBAGENT_PROVIDER_REQUEST` and `SUBAGENT_PROVIDER_RESPONSE` name the two EventBus channels. `register` and `discover` are aliases of the two functions.

## Provider contract

```ts
interface SubagentPresentationProvider extends SubagentProviderControls {
  snapshot(): SubagentProviderSnapshot;
  subscribe(listener: (event: SubagentProviderEvent) => void): () => void;
  replay(after?: FeedCursor): SubagentPresentationReplay;
  rehydrate(input: { session: BorrowedAgentSession; path: AgentPath }): Promise<void>;
}
```

| Member                         | Contract                                                         |
| ------------------------------ | ---------------------------------------------------------------- |
| `acquire(path)`                | Lease an existing child session for a view.                      |
| `stop(request)`                | Stop one child.                                                  |
| `teardown(path, incarnation)`  | Tear one child down and report the agents it affected.           |
| `resurrect(request)`           | Revive a torn-down child.                                        |
| `snapshot()`                   | Manifest, nodes, cursor, and active operations for a fresh view. |
| `subscribe(listener)`          | Stream events. Returns an unsubscribe function.                  |
| `replay(after?)`               | Return events after a cursor, or ask for a new snapshot.         |
| `rehydrate({ session, path })` | Restore a persisted child view for one borrowed session.         |

`snapshot()` reports `hiddenToolNames` and `hiddenCustomTypes` in its manifest. Pimote suppresses those native renderers and renders the provider's own operation data instead, so a suppressed tool cannot appear twice.

## Operations

An operation names its kind, a root-relative agent `path`, and where its content belongs:

```ts
type SubagentPlacement = { toolCallId: string; contentIndex: number; entryId?: string } | { entryId: string };
```

A tool-backed operation uses `toolCallId` and `contentIndex`. An operation carried by a custom entry uses `entryId`. Pimote places the operation inside its originating assistant row and keeps the surrounding native content in order.

The kinds are `send`, `message_received`, `respond`, `await`, `delegation`, `completion`, `interrupt`, `teardown`, `resurrect`, and `protocol_error`.

## Payload envelope

A tool-backed operation starts with three fields and ends with three fields:

```ts
{
  operation: 'await',
  parameters: { agents: [['worker']] },
  result: { statuses: [{ path: ['worker'], state: 'idle', output: 'Checks passed.' }] },
}
```

`parameters` holds the complete normalized public inputs. Its type is `Record<string, unknown>`, so the shape is your provider's contract with its own tool, and Pimote does not enforce it.

`result` holds output, errors, outcome flags, and received metadata. Each kind narrows its own result type, such as `SubagentAwaitResult` or `SubagentCompletionResult`.

An asynchronous custom message carries a result-only payload instead of tool parameters. A completion operation replaces an asynchronous subagent message.

Deltas arrive per kind: delegation children, send request and response text, respond text, and await statuses. Pimote renders these fields as labeled data and renders free-form prose with its transcript Markdown renderer.

## Leases

`acquire()` returns a `SubagentLease` for a child session that already exists.

```ts
interface SubagentLease {
  readonly path: AgentPath;
  readonly session: BorrowedAgentSession;
  readonly capabilities: SubagentCapabilities;
  subscribe(listener: (event: SubagentLeaseEvent) => void): () => void;
  release(): Promise<void>;
}
```

| Member         | Contract                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `session`      | The borrowed runtime. Reading it after the lease closes or releases throws.                                               |
| `capabilities` | What the child view may do.                                                                                               |
| `subscribe`    | Lease events: `rebound` with a new session and optional capabilities, or `closed` with reason `removed` or `unavailable`. |
| `release()`    | Idempotent. Never disposes the child.                                                                                     |

`BorrowedAgentSession` exposes native `clearQueue` and `isBashRunning` beside the conversation controls. Pimote restores a drained queue to the senders that queued the messages.

## Capabilities

`capabilities.operations` lists the identity-preserving commands the child view admits. An absent list admits no commands, which is the safe default.

`capabilities` also carries:

| Member         | Contract                                           |
| -------------- | -------------------------------------------------- |
| `renderer`     | `visible` decides whether the child view can open. |
| `resolveModel` | Child-local model resolution.                      |
| `getSettings`  | Child-local settings for the view.                 |
| `nativeBash`   | `admitted`, `execute`, and `abort` for child bash. |

## Replay and persistence

`replay(after)` returns events after a cursor, or `{ kind: 'snapshot_required' }` with reason `epoch_changed` or `history_unavailable`. Pimote requests a new snapshot in that case.

Pimote restores persisted operations through `rehydrate()`, then `replay()`. Normalize older saved payloads into the current envelope inside the provider, so the client never decodes extension-specific details.

`clearQueue` drains the child's queue, and Pimote restores each drained message to its sender. A provider that hides the queue from the view must still expose it here.

## Cursors

A cursor is an epoch and a sequence number:

```ts
type FeedCursor = { epoch: string; sequence: number };
```

`snapshot()` returns a cursor with the state it describes, and each event advances the sequence. A provider replies to `replay(after)` from that cursor.

Change the epoch when the previous sequence no longer means anything, such as after a provider restart. Pimote then gets `{ kind: 'snapshot_required' }` with reason `epoch_changed` and reads a fresh snapshot instead of a partial replay. Use `history_unavailable` when the events exist but are gone.

## Exports

`registerProvider`, `discoverProvider`, their aliases `register` and `discover`, the channel constants `SUBAGENT_PROVIDER_REQUEST` and `SUBAGENT_PROVIDER_RESPONSE`, and the types for providers, operations, placement, nodes, leases, capabilities, cursors, and replay.
