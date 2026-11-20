# Extending Pimote

Pimote has two extension points. Choose the one that matches what your extension needs to reach:

| Surface           | Runs in                               | Reach                                                              | Entry point                                     |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| Session extension | The pi process that hosts one session | One session: its UI, its activity, its subagents                   | `@pimote/sdk/panels`, `/activity`, `/subagents` |
| Pimote extension  | The Pimote server process             | Every session: folder discovery, global Settings files, and themes | `@pimote/sdk/pimote`, `/folders`                |

A session extension uses pi's `ExtensionAPI`, so it also runs in a plain pi terminal. Pimote answers when it is present and declines when it is not. A Pimote extension has no pi counterpart, because it has no session.

Both forms can ship in one module. A module listed in both `pi.extensions` and `pimote.extensions` runs twice, in two independent hosts with separate lifecycles.

## Module map

| Module                  | Surfaces                                                  | Guide                                                |
| ----------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| `@pimote/sdk/panels`    | Card data for the web client panel                        | [panels.md](panels.md)                               |
| `@pimote/sdk/activity`  | The background-work veto for Pimote's idle reaper         | [activity.md](activity.md)                           |
| `@pimote/sdk/folders`   | Folder source types                                       | [folders.md](folders.md)                             |
| `@pimote/sdk/subagents` | The interactive subagent view provider                    | [subagents.md](subagents.md)                         |
| `@pimote/sdk/pimote`    | The process-global extension factory context              | [authoring.md](authoring.md), [themes.md](themes.md) |
| `@pimote/sdk`           | All of the above except the process-global types' runtime | —                                                    |

`@pimote/sdk/folders` is type-only. The server materializes everything a folder source contributes.

## Install

```bash
npm install @pimote/sdk
```

`@earendil-works/pi-coding-agent` is an optional peer dependency. Every pi extension already has it. The SDK imports it for types only, so the package carries no runtime dependency on pi.

Pimote resolves `@pimote/sdk` and its subpaths to its own installation, so an extension loaded by Pimote does not need its own copy.

## Example

A session extension that pushes one card:

```ts
import { detect } from '@pimote/sdk/panels';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

const extension: ExtensionFactory = (pi) => {
  const panels = detect(pi, 'build-status');
  if (!panels) return;

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

In a pi terminal, `detect()` returns `null` and the extension does nothing.

## EventBus channels

Pimote talks to session extensions over pi's EventBus. The SDK wraps most channels in a function. These are the channels themselves, so a non-TypeScript consumer can speak them directly.

| Channel                     | Direction           | Payload                                                             | Wrapped by             |
| --------------------------- | ------------------- | ------------------------------------------------------------------- | ---------------------- |
| `pimote:detect:request`     | Extension to Pimote | None.                                                               | `detect()`             |
| `pimote:detect:response`    | Pimote to extension | `{detected: true}`                                                  | `detect()`             |
| `pimote:panels`             | Extension to Pimote | `{type: 'cards', namespace, cards}` or `{type: 'clear', namespace}` | `PanelHandle`          |
| `pimote:panels:sync`        | Pimote to extension | `{reason: 'claim' \| 'reset'}`                                      | None. Listen directly. |
| `pimote:activity:request`   | Pimote to extension | None.                                                               | `askActivity()`        |
| `pimote:activity:response`  | Extension to Pimote | `{active: boolean}`                                                 | `answerActivity()`     |
| `pimote:subagents:request`  | Pimote to extension | `{version?}`                                                        | `discoverProvider()`   |
| `pimote:subagents:response` | Extension to Pimote | `{provider}`                                                        | `registerProvider()`   |
| `pimote:navigate`           | Extension to Pimote | `{url}`                                                             | None. Emit directly.   |

`pimote:navigate` asks the browser to open a URL. Static-host paths such as `/s/<slug>/` open in a new tab on desktop and in the current tab on mobile. A desktop popup blocker can suppress the new tab. Pimote forwards the request only for the session the reader is viewing. Emit a path on the Pimote origin.

Every channel is per session. A message never crosses into another session.

## Breaking changes

### 0.15.0 (0.x breaking)

The SDK exposes two independent hosts:

- `@pimote/sdk/pimote` runs process-global Pimote extensions for folder sources and Settings files.
- `@pimote/sdk` and its `panels` and `activity` modules run inside Pi sessions through EventBus bridges.

Folder creation is a Pimote core operation. External creation registration was removed. Existing source modules must move their exported source arrays into a default `PimoteExtension` factory and call `context.folders.registerSource()`. Pi package manifests can list separate `pi.extensions` and `pimote.extensions` entries; Pimote loads only the latter from user scope.

## Versioning

The SDK follows the Pimote version. A breaking change ships with a major or a pre-1.0 minor bump and a note in [Breaking changes](#breaking-changes). Read that section before you upgrade across a minor version in the 0.x range.
