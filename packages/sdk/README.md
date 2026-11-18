# @pimote/sdk

Pimote's extensibility SDK provides APIs for [Pi](https://github.com/earendil-works/pi) session extensions and process-global Pimote extensions. These hosts have separate entry points:

- **`@pimote/sdk/panels`** — push structured card data to the Pimote web client
- **`@pimote/sdk/folders`** — type-only folder discovery entries for Pimote extensions
- **`@pimote/sdk/activity`** — answer Pimote's idle-reap background-activity poll
- **`@pimote/sdk/subagents`** — register or discover a typed per-session subagent provider
- **`@pimote/sdk/pimote`** — define global `PimoteExtension` factories for sources and Settings files

The root `@pimote/sdk` import re-exports the panels, folders, activity, and subagents modules, plus the Pimote extension types.

## Install

```bash
npm install @pimote/sdk
```

Requires `@earendil-works/pi-coding-agent` as an optional peer dependency. Any pi extension already has it. The panels and activity modules import only its types, so the package has no runtime dependency on pi.

## Panels — `@pimote/sdk/panels`

Push structured card data from pi extensions to the pimote web client.

When your extension is running inside pimote, `detect()` returns a handle for sending cards to the panel UI. When running in a normal pi terminal session, it returns `null` — your extension keeps working either way.

### Usage

```ts
import { detect } from '@pimote/sdk/panels';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

const extension: ExtensionFactory = (pi) => {
  const panels = detect(pi, 'my-extension');

  if (panels) {
    // Running inside pimote — push cards to the web UI
    panels.updateCards([
      {
        id: 'status',
        color: 'success',
        header: { title: 'Build', tag: 'passed' },
        body: [{ content: 'All 42 tests passed', style: 'text' }],
        footer: ['2.3s'],
      },
    ]);
  }

  // Rest of your extension — works in both pimote and regular pi
};

export default extension;
```

### API

#### `detect(pi, key)`

Detects whether the extension is running inside pimote.

- **`pi`** — The `ExtensionAPI` object passed to your extension factory.
- **`key`** — A unique namespace string for your extension's cards. Cards from different keys don't interfere with each other.

Returns a `PanelHandle` if running inside pimote, or `null` otherwise.

Calling `detect()` again with the same key deactivates the previous handle (its methods become no-ops) and returns a new one. Handles are scoped to one pi session, so two sessions can detect the same key without deactivating each other.

#### `PanelHandle`

```ts
interface PanelHandle {
  /** Replace all cards for this namespace. Previous cards are discarded. */
  updateCards(cards: Card[]): void;
  /** Remove all cards for this namespace. */
  clear(): void;
}
```

#### `Card`

```ts
interface Card {
  id: string;
  color?: 'accent' | 'active' | 'success' | 'warning' | 'error' | 'muted';
  header: {
    title: string;
    tag?: string;
  };
  body?: BodySection[];
  footer?: string[];
  href?: string;
}

interface BodySection {
  content: string;
  style: 'text' | 'code' | 'secondary';
}
```

- **`id`** — Unique identifier for the card within your namespace.
- **`color`** — Optional semantic status hint for the card's host-rendered accent. Use `active` while work is in flight, `success` for a settled card without an error, `warning` for caution or waiting, `error` for failure, `muted` for low-priority information, and `accent` for general emphasis. The host controls the exact color and rendering.
- **`header.title`** — Card title, always visible.
- **`header.tag`** — Optional short label displayed next to the title.
- **`body`** — Optional content sections, each with a style (`text`, `code`, or `secondary`).
- **`footer`** — Optional array of short strings displayed at the bottom.
- **`href`** — Optional link. The session panel renders the whole card as a link that opens in a new tab. Use a same-origin path for a hosted resource, such as a bundle served by pimote's static-host tool (`/s/<slug>/`). Pimote does not validate the value, and other card lists render it without the new-tab behavior.

### How it works

Detection uses pi's EventBus for a synchronous in-process round-trip — pimote's server listens for `pimote:detect:request` and responds on `pimote:detect:response`. Card updates are emitted on the `pimote:panels` channel, which pimote's session manager picks up and pushes to the web client over WebSocket.

When pimote isn't present, the EventBus emit fires with no listener and `detect()` returns `null`.

### Repaint on claim

The client can drop your cards: a browser claim and a session reset both clear the panel. Pimote then emits `pimote:panels:sync` with `{reason: 'claim' | 'reset'}` on the session's EventBus. Listen on that channel and call `updateCards()` again with your current cards.

### Validation

Pimote validates a card set before it stores it. One invalid card rejects the entire `updateCards()` message: the previous cards stay, and no error reaches your extension. Check the `Card` shape above against your payload.

Cards from different namespaces merge in the panel. Pimote prefixes each rendered id with its namespace, so two extensions can both use `status`. Pushes coalesce, so a burst of updates can arrive as one repaint.

## Subagents — `@pimote/sdk/subagents`

This module lets an extension supply the interactive subagent view for a root session. The provider publishes a root-relative hierarchy, typed operations, one ordered replay cursor, and leases to child sessions that already exist. Pimote discovers the provider on the root session's EventBus. The child runtimes stay owned by the extension that created them.

The my-pi subagents extension implements this provider for Pimote.

### Register and discover

```ts
import { discoverProvider, registerProvider } from '@pimote/sdk/subagents';

const unregister = registerProvider(pi, provider);

const discovery = discoverProvider(pi, (found) => {
  // `found` is the current provider, or undefined when none is registered.
});
```

Both functions accept an `ExtensionAPI` or a bare `EventBus`, so tests can use the seam without a full pi object.

`registerProvider` publishes one provider per session EventBus. Registering again on the same bus deactivates the previous responder and delivers the new provider to a discovery that already runs. It returns a function that stops answering. Neither call owns the provider or its child sessions: cleanup stops registration or discovery only.

`discoverProvider` reports the current provider, then every later registration and replacement. It returns a handle with `provider`, `subscribe` (alias `onProvider`), and `close`.

`SUBAGENT_PROVIDER_REQUEST` and `SUBAGENT_PROVIDER_RESPONSE` name the two EventBus channels. The `register` and `discover` aliases match the longer names.

### Provider contract

A provider implements the lifecycle controls and the presentation feed:

| Member                        | Purpose                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `acquire(path)`               | Lease an existing child session for a view.                      |
| `stop(request)`               | Stop one child.                                                  |
| `teardown(path, incarnation)` | Tear one child down and report the agents it affected.           |
| `resurrect(request)`          | Revive a torn-down child.                                        |
| `snapshot()`                  | Manifest, nodes, cursor, and active operations for a fresh view. |
| `subscribe(listener)`         | Stream provider events. Returns an unsubscribe function.         |
| `replay(after?)`              | Return events after a cursor, or ask for a new snapshot.         |
| `rehydrate({session, path})`  | Restore a persisted child view for one borrowed session.         |

`snapshot()` reports `hiddenToolNames` and `hiddenCustomTypes` in its manifest. Pimote suppresses those native renderers and renders the provider's own operation data instead.

### Operations and placement

An operation names its kind, its root-relative agent `path`, and where it belongs in the transcript:

```ts
type SubagentPlacement = { toolCallId: string; contentIndex: number; entryId?: string } | { entryId: string };
```

Placement follows the operation's source. A tool-backed operation uses `toolCallId` and `contentIndex`. An operation carried by a custom entry uses `entryId`. Pimote places each operation inside its originating assistant row and keeps the surrounding native content in order.

The operation kinds are `send`, `message_received`, `respond`, `await`, `delegation`, `completion`, `interrupt`, `teardown`, `resurrect`, and `protocol_error`.

### Payload envelope

A start and end payload for a tool-backed operation holds three fields:

```ts
{
  operation: 'await',
  parameters: { agents: [['worker']] },
  result: { statuses: [{ path: ['worker'], state: 'idle', output: 'Checks passed.' }] },
}
```

- `parameters` holds the complete normalized public inputs. Its type is `Record<string, unknown>`, so the shape is the provider's contract with its own tool, not an SDK guarantee.
- `result` holds output, errors, outcome flags, and received metadata. Each kind narrows its own result type, such as `SubagentAwaitResult` or `SubagentCompletionResult`.
- Target references use root-relative agent paths.

An asynchronous custom message carries a result-only payload instead of inventing tool parameters. A completion operation replaces an asynchronous subagent message.

Deltas arrive per kind: delegation children, send request and response text, respond text, and await statuses. Pimote renders these fields as labeled data and renders free-form prose with its transcript Markdown renderer.

### Leases

`acquire()` returns a `SubagentLease` for a child session that already exists. A lease exposes the borrowed `BorrowedAgentSession` with native `clearQueue` and `isBashRunning`, plus conversation controls.

- `lease.session` throws after the lease is released.
- `release()` is idempotent and never disposes the child.
- A lease event is `rebound` with a new session and optional capabilities, or `closed` with reason `removed` or `unavailable`.

Pimote restores a drained queue to the senders that queued the messages.

### Capabilities

`capabilities.operations` lists the identity-preserving commands the child view admits. An absent list admits no commands.

`capabilities` also carries `renderer.visible`, `resolveModel`, `getSettings`, and `nativeBash` with its `admitted`, `execute`, and `abort` members.

### Replay and persistence

`replay(after)` returns events after a cursor, or `{kind: 'snapshot_required'}` with reason `epoch_changed` or `history_unavailable`. Pimote requests a new snapshot in that case.

Pimote restores persisted operations through `rehydrate()` and then `replay()`. A provider normalizes older saved payloads into the current envelope, so the client never decodes extension-specific details.

## Pimote extensions — `@pimote/sdk/pimote`

Pimote extensions are process-global modules. The host loads direct JavaScript/TypeScript modules and entry-bearing directories from `$XDG_CONFIG_HOME/pimote/extensions/`. User-scoped Pi packages can contribute entries through their `pimote.extensions` manifest field. Project packages and `pi.extensions` entries never load in this host. A module listed in both sections is an explicit dual-host module and runs twice with independent lifecycles.

```ts
import type { PimoteExtension } from '@pimote/sdk/pimote';

const extension: PimoteExtension = (context) => {
  context.folders.registerSource({
    id: 'my-source',
    async list() {
      return [{ kind: 'repo', path: '/home/me/work/api', name: 'api', branch: 'main', dirty: false, ahead: 0, behind: 0 }];
    },
  });
  context.settings.registerFile('./instructions.md');
  context.on('shutdown', async () => {
    // Release process-global resources here.
  });
};

export default extension;
```

`registerSource()` contributes folder discovery. `registerFile()` contributes a global Settings tab. Relative file paths resolve from the extension entry module, while absolute and leading-`~` paths remain explicit. `on()` accepts only `'shutdown'` and returns a function that removes the handler.

Registrations count only while the factory runs. The host seals the context when the factory resolves, so a later call does nothing and reports nothing. Await setup before you return, and keep the context out of timers and event handlers.

Registrations become inert after shutdown or reload. The host replaces all extension registrations on `/reload`, awaits shutdown handlers, and reports isolated diagnostics while continuing valid modules. Shutdown handlers have no timeout, so an extension must let them settle. Diagnostics reach the server log only.

Folder creation remains a Pimote core capability, so the public SDK has no external creator registration seam.

## Folders — `@pimote/sdk/folders`

This type-only module defines the source discovery seam used by `PimoteExtensionContext.folders.registerSource()`. Sources contribute repos and hubs. Their optional `onFolderOpen(folderPath)` hook runs before an open and can provision a missing entry. Pimote materializes standard hubs and owns the dashboard and manager folder-creation flows.

### `FolderSource`

`list()` returns current entries without mutation. The optional `onFolderOpen(folderPath)` hook is awaited before row, new-session, and manager opens. A thrown error aborts the open.

Pimote owns the facts it can observe. For a path that exists, Pimote probes `branch`, `dirty`, `ahead`, and `behind` itself and replaces the source values, while `tags` and `lastActivity` merge into the row. A source entry whose path classifies as a persona home appears as a persona row, not a repo row. Duplicate hub paths keep the first source, and a throwing `list()` skips only that source.

### Entry shapes

`list()` returns `SourceEntry[]` — a repo or a hub folder:

```ts
/** Feeds a single-repo folder. Extends `RepoInfo`. */
interface RepoSourceEntry extends RepoInfo {
  kind: 'repo';
}

/** Feeds a hub folder over member paths. */
interface HubSourceEntry {
  kind: 'hub';
  path: string;
  name: string;
  memberPaths: string[];
  /** Source-contributed tags; shown to the user but not user-removable. */
  tags?: string[];
}
```

### `RepoInfo`

Repo facts: `path`, `name`, `branch` (`string | null`), `dirty`, `ahead`, `behind`, and optional `worktreePath`, `lastActivity` (epoch ms), `missing` (repo path no longer exists on disk), and `tags`. In a worktree hub row, `path` stays the canonical source path; `worktreePath` identifies the nested checkout whose Git status Pimote reports. It mirrors Pimote's wire `RepoInfo` type — same name, same fields — so extension authors can write `interface MyEntry extends RepoInfo` against the SDK alone.

## Activity — `@pimote/sdk/activity`

Answer pimote's background-activity poll so the idle reaper does not close a session that holds live work (for example: background subagents still running while the root session is settled).

Pimote reaps sessions that hold no work. It checks every 60 seconds and closes a session whose idle time exceeds `idleTimeout`, which defaults to 30 minutes. A session is busy while a browser observes it, a voice call is active, a bash command runs or is dispatching, tree navigation runs, a turn has not settled, or an extension reports activity.

Before closing, Pimote emits `pimote:activity:request` on the session's EventBus and reads the answer synchronously. Register a responder if your extension manages work the root session cannot see:

```ts
import { answerActivity } from '@pimote/sdk/activity';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

const extension: ExtensionFactory = (pi) => {
  answerActivity(pi, () => myAgents.some((a) => a.state === 'running'));
};

export default extension;
```

The callback must be synchronous — the round-trip is a plain inline emit, so an async answer is indistinguishable from no answer. It is read at poll time, not registration time, so it may consult live state through a stable owner object. If it throws, the responder answers `active: true`: a broken predicate parks the session (recoverable by explicit close) instead of destroying work.

What counts as "live work" is extension policy — pimote learns only the boolean. With no responder, pimote applies its own busy rule.

The same answer also holds a session open when archiving or disbanding a hub needs it to close, so an extension that answers `true` forever keeps its sessions alive across those operations.

### API

#### `answerActivity(pi, isActive)`

Registers the responder on the session's EventBus. Returns an unsubscribe function (for symmetry and tests — the bus dies with the session).

- **`pi`** — The `ExtensionAPI` object passed to your extension factory.
- **`isActive`** — Synchronous `() => boolean`: true when closing the session now would destroy live work.

#### `askActivity(bus)`

The pimote-side twin, used by the server's idle reaper. Performs the synchronous poll on an `EventBus` and returns whether any responder asserted live work (multiple answers are OR-ed). Extensions do not need it; it ships in the SDK so the whole protocol lives in one module.

## Breaking changes

### 0.15.0 (0.x breaking)

The SDK now exposes two independent hosts:

- `@pimote/sdk/pimote` runs process-global Pimote extensions for folder sources and Settings files.
- `@pimote/sdk` and its `panels` and `activity` modules run inside Pi sessions through EventBus bridges.

Folder creation is a Pimote core operation. External creation registration was removed. Existing source modules must move their exported source arrays into a default `PimoteExtension` factory and call `context.folders.registerSource()`. Pi package manifests can list separate `pi.extensions` and `pimote.extensions` entries; Pimote loads only the latter from user scope.

## License

MIT
