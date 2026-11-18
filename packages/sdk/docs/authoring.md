# Authoring a Pimote extension

A Pimote extension is a process-global module. It adds folder sources and Settings files to the whole server, so it runs once for every session. Use one when the folders or instruction files you want in the dashboard no scan root can reach.

A Pimote extension has no session and no UI. For session behaviour, write a pi extension with `@pimote/sdk/panels`, `/activity`, or `/subagents`.

## Where modules load

The host reads one directory: `$XDG_CONFIG_HOME/pimote/extensions`, which defaults to `~/.config/pimote/extensions`. It reads the top level only. Each entry is a module file or a directory that holds an entry file.

A file loads when its extension is one of:

```text
.js  .mjs  .cjs  .ts  .mts  .cts
```

Other files are skipped without a diagnostic.

A directory loads through its `package.json` `main` field when present, and otherwise through the first `index` file it finds. A `main` that does not resolve produces a diagnostic and does not fall back to `index`. A directory with neither is skipped silently.

Modules load in this order:

1. Directory entries, sorted by name.
2. User-scope pi package entries, in the order of `packages` in pi's global settings.

A resolved path loads once. The first occurrence wins.

A missing extensions directory is not an error. The host starts with no extensions.

## Package entries

A pi package contributes Pimote extensions only through its `pimote.extensions` manifest field, resolved against the installed package root:

```json
{
  "name": "my-pimote-tools",
  "pimote": {
    "extensions": ["./dist/extension.js"]
  }
}
```

These never load in this host:

- Project-scoped packages. Only user-scope packages contribute.
- `pi.extensions` entries. A module listed in both fields runs twice, in two independent hosts.
- A package whose manifest has no `pimote.extensions` field. The field is the only source of entries, and the host does not fall back to `main`.
- A configured package that is not installed. The host skips it silently.

A `pimote.extensions` value that is not an array of strings produces a diagnostic, and that package contributes nothing.

## Module shape

A module exports a factory as its default export:

```ts
import type { PimoteExtension } from '@pimote/sdk/pimote';

const extension: PimoteExtension = async (context) => {
  // Register everything here.
};

export default extension;
```

The factory receives the context and returns nothing or a promise. The host awaits a promise.

The host transpiles TypeScript and CommonJS at load, so ESM and CJS source both work. `@pimote/sdk` and its subpaths resolve to the running Pimote installation, so the extension never installs the SDK itself.

A default export that is not a function fails the entry.

## Factory context

The context has three members and nothing else:

| Member                           | Contract                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `folders.registerSource(source)` | Adds a folder source. Throws `Invalid folder source` on a bad shape. See [folders.md](folders.md). |
| `settings.registerFile(path)`    | Adds a file to the global Settings catalog.                                                        |
| `on('shutdown', handler)`        | Registers a shutdown handler and returns a function that removes it.                               |

`registerSource` requires a non-empty string `id`, a `list` function, and either no `onFolderOpen` or a function.

`registerFile` requires a non-empty string. The host expands a leading `~` to the home directory, resolves a relative path from the module that calls it, and keeps an absolute path as given. It does not check that the file exists. A missing file stays listed in the catalog and is created by the first successful save.

`on` accepts only `'shutdown'`. Any other event name throws `Invalid shutdown handler`. A handler returns nothing or a promise, and the host awaits it.

The host offers no folder creation seam. Creating a code folder, a persona, or a hub stays a Pimote core operation.

## Register before you return

Registrations count only while the factory runs. The host seals the context when the factory resolves, and every later call does nothing and reports nothing.

```ts
import type { PimoteExtension, PimoteExtensionContext } from '@pimote/sdk/pimote';

const extension: PimoteExtension = (context) => {
  context.settings.registerFile('./instructions.md'); // accepted
  void later(context); // every registration inside is dropped
};

async function later(context: PimoteExtensionContext) {
  await delay(1000);
  context.settings.registerFile('./late.md'); // silently dropped
}
```

Await what you need before you return, and keep the context out of timers, sockets, and event handlers.

## Failure isolation

Each module loads on its own. A factory that throws does not stop the others:

- Its registrations are dropped.
- The shutdown handlers it registered before the throw run.
- One diagnostic reaches the server log.
- Every other module loads as usual.

A valid module with one invalid registration fails the same way, because the throw ends its factory.

## Reload and shutdown

`/reload` in any session reloads the host. This is the only trigger. A run in progress defers it.

Reload runs these steps in order:

1. Run every shutdown handler in registration order and await each one.
2. Discard the registrations.
3. Rediscover modules with a fresh transpile, so edited source takes effect.
4. Install the new registry, then replace the folder sources.

A module that fails on reload does not block it. The previous registry stays in place until the new one installs.

A shutdown handler has no timeout. Await everything it starts, or a reload waits with it.

Server shutdown runs the same handlers, in registration order, after the voice subsystem stops and before the sessions close.

## Diagnostics

Load failures and shutdown errors reach the server log under `[pimote-extensions]`. No client view and no tool reports them. Read the server log when an extension seems absent.

Silent skips are deliberate: a non-module file, a directory without an entry, a missing extensions directory, and an uninstalled package all produce nothing.

## Full example

A source that lists one repo, a Settings file, and a shutdown hook:

```ts
import type { PimoteExtension } from '@pimote/sdk/pimote';

export default (async (context) => {
  context.folders.registerSource({
    id: 'team-repos',
    async list() {
      return [{ kind: 'repo', path: '/srv/team/api', name: 'api', branch: 'main', dirty: false, ahead: 0, behind: 0 }];
    },
    async onFolderOpen(folderPath) {
      if (folderPath === '/srv/team/api') await ensureCheckout();
    },
  });

  context.settings.registerFile('./team-instructions.md');
  context.on('shutdown', () => releaseTeamClient());
}) satisfies PimoteExtension;
```

## Try it

1. Put the module in `$XDG_CONFIG_HOME/pimote/extensions/team.ts`.
2. Run Pimote, or `/reload` in a session.
3. Search the dashboard for the folder it lists, or open the Settings tab and find the file.
4. If nothing appears, read the server log for a `[pimote-extensions]` diagnostic.

The service that serves folders and Settings has no test seam for a third-party module. Test the module's own `list` and hook functions directly, and use a running Pimote for the host behaviour.
