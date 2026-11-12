# @pimote/sdk

Pimote's extensibility SDK provides APIs for [Pi](https://github.com/earendil-works/pi) session extensions and process-global Pimote extensions. These hosts have separate entry points:

- **`@pimote/sdk/panels`** — push structured card data to the Pimote web client
- **`@pimote/sdk/folders`** — type-only folder discovery entries for Pimote extensions
- **`@pimote/sdk/activity`** — answer Pimote's idle-reap background-activity poll
- **`@pimote/sdk/subagents`** — register or discover a typed per-session subagent provider
- **`@pimote/sdk/pimote`** — define global `PimoteExtension` factories for sources and Settings files

The root `@pimote/sdk` import re-exports session-scoped modules and Pimote extension types.

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
- **`href`** — Optional same-origin URL. When set, the client renders the
  entire card as a clickable link that opens in a new tab. Use for cards
  that point at a hosted resource — e.g. a bundle served by pimote's
  static-host tool.

### How it works

Detection uses pi's EventBus for a synchronous in-process round-trip — pimote's server listens for `pimote:detect:request` and responds on `pimote:detect:response`. Card updates are emitted on the `pimote:panels` channel, which pimote's session manager picks up and pushes to the web client over WebSocket.

When pimote isn't present, the EventBus emit fires with no listener, `detect()` returns `null`, and there's zero overhead.

## Subagents — `@pimote/sdk/subagents`

This module defines the per-session provider seam for interactive subagent views. A provider publishes a root-relative hierarchy, replayable semantic events, and leases to existing child sessions. Pimote discovers providers on the root session's EventBus; child runtimes stay owned by the extension that created them.

Use `registerProvider(pi, provider)` to publish a provider. Use `discoverProvider(pi, onProvider)` or the discovery handle to find providers, including late registration and replacement. Registration and discovery return cleanup functions or handles. Cleanup stops discovery or registration; it does not dispose the provider or child sessions. The `SubagentProvider` contract, event data, cursors, snapshots, and borrowed-session lease types are exported from this module. The my-pi subagents extension implements this provider for Pimote.

A fact can include `transcriptPosition` from its owning native session. Set `afterEntryId` to the native leaf ID, or `null` before the first entry. Preserve this boundary in provider replay and native tool-result or custom-message metadata. Pimote derives `messageIndex` for the current transcript projection. Position controls insertion only. `relatedPiEvents` controls native replacement. Do not acquire a child lease to calculate placement.

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

`registerSource()` contributes folder discovery. `registerFile()` contributes a global Settings tab. Relative file paths resolve from the extension entry module, while absolute and leading-`~` paths remain explicit. Registrations become inert after shutdown or reload. The host replaces all extension registrations on `/reload`, awaits shutdown handlers, and reports isolated diagnostics while continuing valid modules. Shutdown handlers have no timeout, so an extension must let them settle. Folder creation remains a Pimote core capability, so the public SDK has no external creator registration seam.

## Folders — `@pimote/sdk/folders`

This type-only module defines the source discovery seam used by `PimoteExtensionContext.folders.registerSource()`. Sources contribute repos and hubs. Their optional `onFolderOpen(folderPath)` hook runs before an open and can provision a missing entry. Pimote materializes standard hubs and owns the dashboard and manager folder-creation flows.

### `FolderSource`

`list()` returns current entries without mutation. The optional `onFolderOpen(folderPath)` hook is awaited before row, new-session, and manager opens. A thrown error aborts the open.

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

Pimote reaps sessions that are idle past a timeout, with no connected client and no running bash command. Before closing, it emits `pimote:activity:request` on the session's EventBus and reads the answer synchronously. Register a responder if your extension manages work the root session cannot see:

```ts
import { answerActivity } from '@pimote/sdk/activity';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

const extension: ExtensionFactory = (pi) => {
  answerActivity(pi, () => myAgents.some((a) => a.state === 'running'));
};

export default extension;
```

The callback must be synchronous — the round-trip is a plain inline emit, so an async answer is indistinguishable from no answer. It is read at poll time, not registration time, so it may consult live state through a stable owner object. If it throws, the responder answers `active: true`: a broken predicate parks the session (recoverable by explicit close) instead of destroying work.

What counts as "live work" is extension policy — pimote learns only the boolean. With no responder, pimote reaps as it always did.

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
