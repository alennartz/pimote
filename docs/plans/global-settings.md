# Plan: Global settings

## Context

Pimote will replace the home-page Agent instructions button with a first-class Settings dialog. The dialog starts as a tabbed raw-file editor for well-known files, configured files, and Pimote-extension contributions. The direction and host-discovery decisions are recorded in [the brainstorm](../brainstorms/global-settings.md).

## Architecture

### Impacted Modules

- **Protocol** (`shared/src/**`) gains a session-independent `get_global_settings` request and response data for a manifest of resolved file paths and labels. `ServerCapabilitiesEvent` also carries the validated Markdown tag-snippet palette. The Android client has no Settings surface and does not initiate the command.
- **Server — configuration** (`server/src/config.ts` and a config-runtime seam) adds `settingsFiles`, validates it as an optional string array, resolves the effective Pimote config path through XDG rules, and applies safe native-config changes dynamically. Native Pimote config writes are validated before they reach `file_put`; invalid candidates leave disk and live state unchanged. Pi-native and third-party settings files receive no Pimote-specific reload handling.
- **Server — Pimote extension host** (new `server/src/pimote-extensions/**`) replaces the folder-sources-only loader with a trusted, jiti-backed Pimote extension host. It discovers direct modules and extension directories in `$XDG_CONFIG_HOME/pimote/extensions/`, and resolves user-level Pi-installed packages through Pi's public package manager, loading only each package's `pimote.extensions` entries. It does not load project-local Pi packages or Pi `pi.extensions` entries.
- **Server — folder model** (`server/src/repo-index.ts` with `replaceUserSources(sources)`, `server/src/folder-sources/**`, folder creation routing, manager ports) retains the public `FolderSource` discovery seam, replaces user sources atomically during Pimote extension reload, and broadcasts folder deltas. The public `FolderCreator` seam and external creator registration are removed. Built-in code, persona, and hub creation remains core behavior for the dashboard and manager.
- **Server — Global settings catalog** (new `server/src/global-settings.ts`) owns well-known files, config-listed paths, extension registrations, path resolution, canonical-path deduplication, stable labels, missing-file entries, and manifest snapshots. It is the only server authority for the client-visible Settings file list.
- **Server — WebSocket and lifecycle** (`server/src/server.ts`, `server/src/ws-handler.ts`, `server/src/session-manager.ts`) serves the manifest, routes native config validation and safe reloads, advertises tag snippets, and makes `/reload` reload Pimote extensions once server-wide before continuing the existing current-session Pi reload. Concurrent global reloads serialize. The old Pimote extension registry is invalidated and replaced even when individual modules fail; valid modules continue and diagnostics are reported.
- **Web Client — dashboard** (`client/src/lib/components/Dashboard.svelte`, `FolderList.svelte`, and home styling) moves the global entry point out of the folder header. The home-only gear is larger at desktop bottom-left and smaller at mobile top-left. The gear is not mounted on conversation surfaces.
- **Web Client — Settings editor** (new `GlobalSettingsDialog.svelte` and `global-settings.svelte.ts`, reusing `CodeEditorDialog`/`ExtensionCodeEditor` patterns) manages one manifest snapshot per opening, lazy file loads, independent per-tab drafts, dirty markers, per-file saves, missing-file creation hints, and one close-discard prompt. Language comes from the resolved file path. The Markdown tag toolbar appears only for Markdown tabs. Desktop keeps Cancel/Save in the editor footer; mobile keeps Close/Save in the header.
- **Web Client — existing file editor and capabilities** (`client/src/lib/stores/file-editor.svelte.ts`, `server-capabilities.svelte.ts`, `ConfigFileEditor.svelte`) stop hard-coding Pi and Pimote global paths. Tag snippets come from server capabilities. Folder-specific `AGENTS.md` editing remains available through its existing path-based operation.
- **SDK** (`packages/sdk/src/**`, package README, server SDK twin checks) adds the Pimote extension factory and context, keeps `FolderSource`, removes `FolderCreator`, and documents the two extension hosts. Pi-side `panels` and `activity` remain session EventBus bridges and are not exposed through the global Pimote context.
- **Documentation and tooling** (root README/config documentation, `packages/sdk/README.md`, package examples, injected `pimote-docs` guidance, and manual-test coverage) explains discovery scopes, package manifests, host lifecycles, reload boundaries, path resolution, SDK surfaces, and the removed creator seam.

### New Modules

**Pimote extension host** (`server/src/pimote-extensions/`)

A deep server-side module that discovers, loads, validates, and replaces Pimote extension runtimes. It owns smart module discovery, Pi user-package adaptation, factory contexts, shutdown handlers, module-cache reset, diagnostics, and serialized reloads. It exposes a small registry interface to the folder model and Global settings catalog rather than leaking loader details into those callers.

**Global settings catalog** (`server/src/global-settings.ts`)

A deep manifest module that combines built-ins, native Pimote configuration, configured paths, and extension registrations. It resolves paths against the correct source base, canonicalizes existing targets for deduplication, preserves declared missing files, computes collision-safe labels, and returns a stable snapshot. It does not read file contents; callers use the existing file-edit seam.

**Pimote configuration runtime** (`server/src/config-runtime.ts` or the equivalent config-owned module)

A validated runtime snapshot and reload seam for native Pimote configuration. It separates safe dynamic fields from startup-only fields, provides the validated tag-snippet capability payload, and supplies the native-config predicate used by `file_put`. The dynamic matrix is explicit: `settingsFiles` and `tagSnippets` update immediately; `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `defaultInterpreterModel`, and `defaultWorkerModel` affect new sessions or new voice extensions; `idleTimeout` is read on the next idle check; and `bufferSize` applies to new session buffers. `roots`, `managerRoot`, `port`, VAPID keys, and active voice transport remain startup-only. Pi-native and third-party files have no Pimote reload policy.

**Global settings client store** (`client/src/lib/stores/global-settings.svelte.ts`)

A client-side state module that owns a manifest snapshot, active tab, per-file drafts, load/save state, dirty state, and close-discard decisions. The dialog remains a renderer of this store rather than a second file-edit implementation. Its `viewport`, `surface`, and `snippets` inputs control responsive rendering, the home-only gear, and capability-fed Markdown controls. It opens an accessible overlay through the gear. It has no visible Settings title, matching the approved mock.

### Interfaces

**Pimote extension SDK contract**

```ts
type PimoteExtension = (context: PimoteExtensionContext) => void | Promise<void>;

interface PimoteExtensionContext {
  readonly folders: {
    registerSource(source: FolderSource): void;
  };
  readonly settings: {
    registerFile(path: string): void;
  };
  on(event: 'shutdown', handler: () => void | Promise<void>): () => void;
}
```

A module in the standard Pimote directory or a package entry named by `pimote.extensions` exports one default `PimoteExtension`. Relative settings paths resolve from that entry module. Registration is scoped to the current runtime and becomes inert when the runtime is invalidated. `FolderCreator` is not part of this contract.

**Pimote extension discovery**

The host scans the user-level Pimote extension directory using Pi-like module rules: direct JavaScript/TypeScript modules and extension directories with an entry point. It reads user-level Pi package declarations through Pi's public package manager without installing or updating packages during discovery. For each installed package, it reads the package manifest and resolves only `pimote.extensions`; `pi.extensions` is never passed to the Pimote loader. Project-local Pi packages are ignored because the Pimote host is global.

A package can therefore contain separate host entries:

```json
{
  "pi": { "extensions": ["src/pi-extension.ts"] },
  "pimote": { "extensions": ["src/pimote-extension.ts"] }
}
```

The two hosts load their entries independently. The same physical entry listed in both sections is an explicit dual-host module and runs twice with separate lifecycles. Separate files are the normal form.

**Pimote extension lifecycle**

The host loads a fresh runtime at startup and on server-wide `/reload`. `WsHandler` accepts an injected `reloadPimoteExtensions` callback and awaits it before the current session's Pi reload. `RepoIndex.replaceUserSources(sources)` atomically replaces extension-owned sources, preserves core registrations, invalidates discovery, and emits folder deltas. Reload awaits registered `shutdown` handlers, invalidates the old context, clears the jiti/module cache, discovers a fresh set, and replaces the old registry. Individual module failures are isolated and reported. Concurrent reloads cannot overlap. The contract does not require distinct flights or coalescing. A successful replacement updates `FolderSource` registrations and extension settings registrations; a folder-index replacement invalidates discovery and emits the existing folders delta. Pi's per-session `/reload` remains responsible for Pi extension lifecycle and continues through `AgentSession.reload()`.

**Global settings manifest**

```ts
interface GlobalSettingsFile {
  path: string; // resolved path and stable tab identity
  label: string; // basename, with parent segments added on collision
}

interface GetGlobalSettingsResponseData {
  files: GlobalSettingsFile[];
}
```

`get_global_settings` returns a snapshot for one dialog opening. The server orders built-ins first, then `settingsFiles` in config order, then Pimote-extension registrations in deterministic discovery order. Existing canonical paths deduplicate by first occurrence. Missing files stay in the manifest. Config paths resolve relative to Pimote's config directory; extension paths resolve relative to their entry module; absolute and leading-`~` paths remain explicit. The response has no source badges, file contents, or native-config path field.

Well-known files use effective runtime paths: Pi's effective agent directory for `AGENTS.md` and `settings.json`, and Pimote's effective XDG config path for its native config. The client never reconstructs these paths.

**File operations and native config reload**

The existing `file_get`/`file_put` commands remain the content seam. `file_get` keeps missing-file and UTF-8 behavior from DR-051. `file_put` keeps its wire shape and generic last-write-wins behavior for ordinary files. When the resolved target is the native Pimote config, the server validates the candidate before writing, then applies safe Pimote fields and broadcasts updated capabilities. A failed native-config validation returns an error without changing disk or live state.

**Server capabilities**

`ServerCapabilitiesEvent` adds the validated `tagSnippets: string[]` payload. It is sent on connection and after native Pimote config reload. The client uses this data for Markdown editor controls and performs no Pimote-config file read.

**Global settings client store**

The store exposes operations equivalent to `loadManifest()`, `select(path)`, `edit(path, draft)`, `save(path)`, `hasDirtyDrafts()`, and `close()`. It lazy-loads file contents through `file_get`, keeps drafts independently per path, sends complete contents through `file_put`, marks a missing file as created after a successful save, and lets tab switching preserve drafts. Closing with any dirty draft requires one discard confirmation. The manifest does not change while the dialog is open; config-list changes apply on the next opening.

### Interaction Mocks

- `docs/mocks/global-settings/index.html` — approved home gear placement, tabbed Settings editor, Markdown-only tag row, per-tab drafts, missing-file save, responsive Cancel/Save behavior, and close-discard confirmation. Shared mock styling lives in `docs/mocks/shared/pimote.css`; the feature folder contains the hosted CSS copy.

### DR Supersessions

- **DR-051** (generic file-edit seam for server-side files, last-write-wins) — superseded only for the native Pimote configuration target because dynamic safe reload requires server validation before writing. All other files retain the generic command and last-write-wins contract. The new decision keeps the existing wire shape and generic behavior elsewhere.
- **DR-052** (tag snippet palette via client-side lenient parse of config.json) — superseded because the server-owned configuration workflow now provides validated `tagSnippets` capability data and the client no longer parses a hard-coded path.

## Tests

**Pre-test-write commit:** `506df5312a4e7a47195c53baff086c5fe9555f2f`

### Interface Files

- `shared/src/protocol.ts` — `get_global_settings`, manifest response, global settings file identity, and server capability tag snippets.
- `server/src/config.ts` — `settingsFiles` configuration field.
- `server/src/config-runtime.ts` — native configuration validation, reload, write, and capability interfaces.
- `server/src/global-settings.ts` — global settings manifest catalog interface.
- `server/src/pimote-extensions/types.ts` — extension host, package discovery, registry, and diagnostic interfaces.
- `server/src/pimote-extensions/index.ts` — extension host factory seam.
- `server/src/repo-index.ts` — atomic user-source replacement with folder deltas and preserved core registrations.
- `server/src/folder-sources/builtin.ts` — core built-in folder creator contract after removing the public creator seam.
- `server/src/folder-sources/index.ts` — folder-source exports without `FolderCreator`.
- `server/src/folder-sources/loader.ts` — source-only loading boundary.
- `server/src/folder-create.ts` — core folder creation boundary using the built-in creator contract.
- `server/src/manager/types.ts` and `server/src/manager/index.ts` — internal core code-folder creation port without the removed external creator vocabulary.
- `server/src/index.ts`, `server/src/server.ts`, and `server/src/ws-handler.ts` — structural wiring for core folder creation, capabilities, and the new command stub.
- `packages/sdk/src/pimote/index.ts` — `PimoteExtension` and `PimoteExtensionContext` types.
- `packages/sdk/src/folders/types.ts`, `packages/sdk/src/folders/index.ts`, and `packages/sdk/src/index.ts` — public SDK surface with the removed creator seam and new Pimote extension types.
- `packages/sdk/package.json` — `@pimote/sdk/pimote` export.
- `client/src/lib/stores/global-settings.svelte.ts` — client global-settings store operations and per-file state shape.
- `client/src/lib/components/GlobalSettingsDialog.svelte` — dialog renderer boundary.
- `client/src/lib/components/global-settings-presentation.ts` — gear, language, toolbar, and responsive action presentation seam.

### Test Files

- `server/src/pimote-extensions/host.test.ts` — direct and package discovery, scope filtering, registration lifecycle, diagnostics, and serialized reload behavior.
- `server/src/global-settings.test.ts` — manifest ordering, path resolution, canonical deduplication, labels, missing files, and snapshot isolation.
- `server/src/config-runtime.test.ts` — native-config validation, dynamic reload policy, startup-only preservation, symlink identity, ordinary writes, and capabilities.
- `server/src/ws-handler.test.ts` — session-independent manifest command envelope.
- `client/src/lib/stores/global-settings.svelte.test.ts` — manifest snapshots, lazy reads, independent drafts, saves, missing-file creation, errors, and close-discard behavior.
- `client/src/lib/components/global-settings-presentation.test.ts` — home gear placement, conversation omission, Markdown controls, path language, and responsive actions.
- `client/src/lib/components/GlobalSettingsDialog.test.ts` — actual accessible gear/overlay rendering, tabs, dirty state, missing-file hints, Markdown Tag row, and responsive actions.
- `server/src/repo-index.test.ts` — user-source replacement, preserved core sources, invalidated listings, and folder deltas.

### Behaviors Covered

#### Pimote extension SDK and host

- A Pimote extension receives folder-source and settings-file registration handles plus a shutdown lifecycle hook.
- Direct JavaScript/TypeScript modules and extension directories load in deterministic discovery order.
- Relative settings registrations resolve from their entry module, and missing targets remain registered.
- Only user-scoped Pi package `pimote.extensions` entries load. Pi-only entries and project-scoped packages do not load.
- Reload awaits controlled asynchronous shutdown, reads changed module contents, invalidates old registrations, replaces the registry even after module failures, reports isolated diagnostics, and prevents overlapping concurrent reloads.
- The WebSocket reload command awaits global Pimote reload before the current-session Pi reload. Source replacement preserves core sources and publishes folder deltas.
- The public SDK exports no `FolderCreator` seam. Built-in folder creation remains a Pimote core boundary.

#### Global settings catalog and protocol

- The manifest orders effective built-ins, config-listed files, and extension registrations.
- Existing canonical targets deduplicate by first occurrence, while declared missing files remain visible.
- Config-relative, leading-`~`, absolute, and extension-resolved paths produce stable identities without client path reconstruction.
- Basename labels expand with parent segments only when collisions require it.
- Each snapshot is independent, and `get_global_settings` uses the standard request/response envelope without a session target.

#### Native configuration runtime and capabilities

- Invalid native configuration candidates fail before disk or live state changes.
- `settingsFiles` and `tagSnippets` reload dynamically, model defaults apply to future consumers, idle timeout applies to the next idle check, and buffer size applies to new buffers.
- Roots, manager root, port, VAPID keys, and active voice transport remain startup-only.
- Symlink aliases identify the native target, while Pi-native and third-party files keep generic write behavior.
- Capabilities expose the validated Markdown snippet palette.

#### Client global settings experience

- Opening a dialog keeps one server manifest snapshot until the next opening and lazy-loads inactive files.
- Each tab preserves its own draft and dirty marker across selection, saves complete contents per file, and marks a missing file created after success.
- Load and save errors preserve safe drafts, while a dirty tab cannot overwrite content after a failed load.
- Closing with any dirty tab requests one discard confirmation; keeping edits preserves them, and discarding closes without writes.
- The home gear is large at desktop bottom-left, small at mobile top-left, and absent from conversation surfaces.
- Markdown paths expose server capability snippets only; JSON and plain-text paths do not. Desktop actions stay in the footer, and mobile actions move to the header.
- Actual dialog rendering covers accessible overlay opening, no visible Settings title, tab labels, dirty markers, missing-file creation hints, and the Markdown-only Tag row.
- Manifest response errors and rejected transports leave safe state. Multi-segment basename collisions receive unique labels.

### Manual Acceptance

- Verify documentation, examples, SDK guidance, and removal of the public `FolderCreator` vocabulary during implementation.
- Verify production capability broadcasts and dynamic configuration wiring into session, voice, idle-check, and buffer consumers. Contract tests cover the runtime policy through captured consumer adapters, not production wiring.

**Review status:** approved
