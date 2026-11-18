# @pimote/sdk

Pimote's extension SDK. It provides two extension points:

- **Session extensions** run inside the pi process that hosts one session. They use pi's `ExtensionAPI` and work in a plain pi terminal too.
- **Pimote extensions** run in the Pimote server process. They contribute folder discovery and global Settings files.

## Modules

| Import                  | Purpose                                                          | Guide                                  |
| ----------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| `@pimote/sdk/panels`    | Push card data to the Pimote web client                          | [docs/panels.md](docs/panels.md)       |
| `@pimote/sdk/activity`  | Veto the idle reaper while your extension holds live work        | [docs/activity.md](docs/activity.md)   |
| `@pimote/sdk/folders`   | Type-only folder source contract                                 | [docs/folders.md](docs/folders.md)     |
| `@pimote/sdk/subagents` | Publish the interactive subagent view                            | [docs/subagents.md](docs/subagents.md) |
| `@pimote/sdk/pimote`    | Define a process-global extension for sources and Settings files | [docs/authoring.md](docs/authoring.md) |
| `@pimote/sdk`           | Everything above except the process-global runtime types         | [docs/index.md](docs/index.md)         |

## Install

```bash
npm install @pimote/sdk
```

`@earendil-works/pi-coding-agent` is an optional peer dependency. Every pi extension already has it. The SDK imports it for types only.

## Push a card

```ts
import { detect } from '@pimote/sdk/panels';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

const extension: ExtensionFactory = (pi) => {
  const panels = detect(pi, 'my-extension');
  if (!panels) return; // Running in a plain pi terminal.

  panels.updateCards([
    {
      id: 'build',
      color: 'success',
      header: { title: 'Build', tag: 'passed' },
      body: [{ content: 'All 42 tests passed', style: 'text' }],
    },
  ]);
};

export default extension;
```

[docs/panels.md](docs/panels.md) covers handle lifetime, colors, links, validation, and repaint on client claim.

## Contribute folders and Settings files

```ts
import type { PimoteExtension } from '@pimote/sdk/pimote';

const extension: PimoteExtension = (context) => {
  context.folders.registerSource({
    id: 'team-repos',
    async list() {
      return [{ kind: 'repo', path: '/srv/team/api', name: 'api', branch: 'main', dirty: false, ahead: 0, behind: 0 }];
    },
  });
  context.settings.registerFile('./team-instructions.md');
  context.on('shutdown', () => releaseTeamClient());
};

export default extension;
```

[docs/authoring.md](docs/authoring.md) covers where modules load, package manifests, the registration window, reload, and diagnostics.

## Breaking changes

### 0.15.0 (0.x breaking)

The SDK now exposes two independent hosts:

- `@pimote/sdk/pimote` runs process-global Pimote extensions for folder sources and Settings files.
- `@pimote/sdk` and its `panels` and `activity` modules run inside Pi sessions through EventBus bridges.

Folder creation is a Pimote core operation. External creation registration was removed. Existing source modules must move their exported source arrays into a default `PimoteExtension` factory and call `context.folders.registerSource()`. Pi package manifests can list separate `pi.extensions` and `pimote.extensions` entries; Pimote loads only the latter from user scope.

## License

MIT
