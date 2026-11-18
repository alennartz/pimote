# Pimote extensions

A Pimote extension is a process-global module that adds folder sources and Settings files to the whole server. Use one to feed folders or instruction files that no scan root can reach.

This page describes the host. `@pimote/sdk` documents the types and the factory context.

## Where modules load

The host reads one directory: `$XDG_CONFIG_HOME/pimote/extensions`, which defaults to `~/.config/pimote/extensions`. It reads the top level only. Each entry is a module file or a directory that holds an entry file.

A **file** loads when its extension is one of:

```text
.js  .mjs  .cjs  .ts  .mts  .cts
```

Other files are skipped without a diagnostic.

A **directory** loads through its `package.json` `main` field when present, and otherwise through the first `index` file it finds. A `main` that does not resolve produces a diagnostic and does not fall back to `index`. A directory with neither is skipped silently.

Modules load in this order:

1. Directory entries, sorted by name.
2. User-scope pi package entries, in the order of `packages` in pi's global settings.

A resolved path loads once. The first occurrence wins.

A missing extensions directory is not an error. The host starts with no extensions.

## Package entries

A pi package contributes extensions only through its `pimote.extensions` manifest field, resolved against the installed package root:

```json
{
  "name": "my-pimote-tools",
  "pimote": {
    "extensions": ["./src/extension.ts"]
  }
}
```

These never load in this host:

- Project-scoped packages.
- `pi.extensions` entries. A module listed in both fields runs twice, in two independent hosts.
- A package whose manifest has no `pimote.extensions` field.
- A configured package that is not installed. The host skips it silently.

## Module shape

A module exports a factory as its default export. The host transpiles TypeScript and CommonJS at load, so either ESM or CJS source works.

```ts
import type { PimoteExtension } from '@pimote/sdk/pimote';

export default (async (context) => {
  context.folders.registerSource({
    id: 'team-folders',
    list: async () => [{ kind: 'repo', path: '/srv/repos/api', name: 'api', branch: 'main', dirty: false, ahead: 0, behind: 0 }],
  });
  context.settings.registerFile('./team-instructions.md');
  context.on('shutdown', async () => {
    await releaseTeamClient();
  });
}) satisfies PimoteExtension;
```

`@pimote/sdk` and its subpaths resolve to the running Pimote installation. An extension never installs the SDK itself.

## Factory context

A factory receives exactly three members:

| Member                           | Effect                                                               |
| -------------------------------- | -------------------------------------------------------------------- |
| `folders.registerSource(source)` | Adds a folder source. Throws `Invalid folder source` on a bad shape. |
| `settings.registerFile(path)`    | Adds a file to the global Settings catalog. See `settings.md`.       |
| `on('shutdown', handler)`        | Registers a shutdown handler. Returns a function that removes it.    |

Any other event name throws `Invalid shutdown handler`.

A relative `registerFile` path resolves from the module that calls it. A leading `~` expands to the home directory.

Folder creation is a Pimote core capability. The host offers no creation seam.

### Register before you return

Registrations count only while the factory runs. The host seals the context when the factory resolves, and every later call does nothing and reports nothing.

```ts
export default (context) => {
  context.settings.registerFile('./instructions.md'); // accepted
  void laterSetup(context); // every registration inside is dropped
};
```

Await what you need before you return, and keep the context out of timers and event handlers.

## Reload and shutdown

`/reload` in any session reloads the host. This is the only trigger, and a run in progress defers it.

Reload runs these steps in order:

1. Run every shutdown handler in registration order and await each one.
2. Discard the registrations.
3. Rediscover modules with a fresh transpile, so edited source takes effect.
4. Install the new registry, then replace the folder sources.

A module that fails to load does not block the reload. Its registrations are dropped, its own shutdown handlers run, and one diagnostic reaches the server log. The other modules load.

A shutdown handler has no timeout. Await everything it starts, or a reload waits with it.

Server shutdown runs the same handlers before the sessions close.

## Diagnostics

Load failures and shutdown errors reach the server log under `[pimote-extensions]`. No client view and no tool reports them. Read the server log when an extension seems absent.

Silent skips are by design: a non-module file, a directory without an entry, a missing extensions directory, and an uninstalled package all produce nothing.
