# @pimote/sdk

Pimote's extensibility SDK — everything a [pi](https://github.com/mariozechner/pi-coding-agent) extension imports to talk to [pimote](https://github.com/alennartz/pimote). One subpath module per extension seam:

- **`@pimote/sdk/panels`** — push structured card data to the pimote web client
- **`@pimote/sdk/folders`** — contribute folder discovery and creation to pimote's folder layer

The root `@pimote/sdk` import re-exports both modules.

## Install

```bash
npm install @pimote/sdk
```

Requires `@earendil-works/pi-coding-agent` as an optional peer dependency (already present in any pi extension; only the panels seam imports from it).

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

Calling `detect()` again with the same key deactivates the previous handle (its methods become no-ops) and returns a new one.

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
  color?: 'accent' | 'success' | 'warning' | 'error' | 'muted';
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
- **`color`** — Optional color theme for the card.
- **`header.title`** — Card title, always visible.
- **`header.tag`** — Optional short label displayed next to the title.
- **`body`** — Optional content sections, each with a style (`text`, `code`, or `secondary`).
- **`footer`** — Optional array of short strings displayed at the bottom.
- **`href`** — Optional same-origin URL. When set, the client renders the
  entire card as a clickable link (same-tab navigation). Use for cards
  that point at a hosted resource — e.g. a bundle served by pimote's
  static-host tool.

### How it works

Detection uses pi's EventBus for a synchronous in-process round-trip — pimote's server listens for `pimote:detect:request` and responds on `pimote:detect:response`. Card updates are emitted on the `pimote:panels` channel, which pimote's session manager picks up and pushes to the web client over WebSocket.

When pimote isn't present, the EventBus emit fires with no listener, `detect()` returns `null`, and there's zero overhead.

## Folders — `@pimote/sdk/folders`

Type-only module for user-authored folder-source modules: pimote scans a folder-sources directory (default `~/.config/pimote/folder-sources`, configurable via `folderSourcesDir`), dynamic-imports every JS/TS module it finds, and collects each module's exported `sources` and `creators` arrays. Sources contribute repos and hub folders to pimote's folder layer; creators make new folders from user-supplied form params.

### Writing a module

```ts
// ~/.config/pimote/folder-sources/my-source.ts
import type { FolderSource, FolderCreator } from '@pimote/sdk/folders';

export const sources: FolderSource[] = [
  {
    id: 'my-source',
    async list() {
      return [
        {
          kind: 'repo',
          path: '/home/me/work/api',
          name: 'api',
          branch: 'main',
          dirty: false,
          ahead: 0,
          behind: 0,
        },
      ];
    },
  },
];

export const creators: FolderCreator[] = [
  {
    id: 'my-creator',
    describe() {
      return { label: 'New API folder', paramSchema: { name: 'string', tags: 'string[]' } };
    },
    async create(params) {
      const path = `/home/me/work/${String(params.name)}`;
      // ... scaffold the folder ...
      return { path };
    },
  },
];
```

### `FolderSource`

The discovery seam. `list()` is called on cache miss and must return the current entries without mutating anything. The optional `onFolderOpen(folderPath)` hook is awaited before any open of a listed entry proceeds — whether the target exists on disk or not, and from every open path (row click, new session, manager tool). Sources self-filter by path: probe the disk and scaffold if the entry is theirs and missing; do other open-time work otherwise. A thrown error aborts the open and surfaces the message to the user.

### `FolderCreator`

The creation seam. `describe()` returns the human-readable form for the creation UI — a `label` plus a `paramSchema` mapping param names to `'string' | 'string[]'`. `create(params)` receives the user-supplied params, makes the folder, and returns its `{ path }`.

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

Repo facts as contributed by sources: `path`, `name`, `branch` (`string | null`), `dirty`, `ahead`, `behind`, and optional `lastActivity` (epoch ms), `missing` (repo path no longer exists on disk), and `tags`. It mirrors pimote's wire `RepoInfo` type — same name, same fields — so extension authors can write `interface MyEntry extends RepoInfo` against the SDK alone.

## Breaking changes

### 0.15.0 (0.x breaking)

The discovery/creation seam is renamed to folder vocabulary — "project" is gone from the SDK surface. No compatibility type aliases exist; source modules must be updated against these successors:

| Retired name (≤0.14.x)                         | Replacement (0.15.0)                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `@pimote/sdk/projects` subpath                 | `@pimote/sdk/folders`                                                                  |
| `ProjectSource`                                | `FolderSource`                                                                         |
| `ProjectCreator`                               | `FolderCreator`                                                                        |
| `ProjectCreatorDescriptor`                     | `FolderCreatorDescriptor`                                                              |
| `ProjectCreatorParamType`                      | `FolderCreatorParamType`                                                               |
| `MultiRepoSourceEntry`                         | `HubSourceEntry`                                                                       |
| entry discriminator `kind: 'project'`          | entry discriminator `kind: 'hub'`                                                      |
| `onProjectOpen(projectPath)`                   | `onFolderOpen(folderPath)`                                                             |
| config key `projectSourcesDir`                 | `folderSourcesDir` (legacy key still read as a deprecated fallback)                    |
| sources dir `~/.config/pimote/project-sources` | `~/.config/pimote/folder-sources` (legacy dir still loaded when the new one is absent) |

Every name in the left column is retired; each is listed here only so existing modules can be migrated. The wire command for the built-in creation flow is likewise renamed (`create_project` → `create_folder`).

## License

MIT
