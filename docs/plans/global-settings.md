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

## Steps

### Step 1: Complete native configuration validation

Change `server/src/config.ts` to share candidate parsing between `loadConfig()` and `ConfigRuntime.validate()`. Keep existing defaults, home expansion, model-reference normalization, and manager-root validation. Validate optional `settingsFiles` and `tagSnippets` as string arrays without dropping invalid element types. Return `settingsFiles` in declared order. Keep native paths supplied by `server/src/paths.ts`, which already honors XDG configuration.

Implement `validate()` in `server/src/config-runtime.ts` against this parser. Reject malformed JSON, non-object candidates, empty roots, and invalid configuration before any write. Keep parsing separate from disk access and runtime mutation.

**Verify:** The validation and configured-order cases in `server/src/config-runtime.test.ts` pass. Existing configuration tests retain startup defaults and path behavior.
**Status:** not started

### Step 2: Implement the native configuration runtime

Complete `ConfigRuntime` in `server/src/config-runtime.ts` behind its existing constructor, `snapshot()`, `apply()`, `isNativeConfig()`, `capabilities()`, and `putFile()` interface. Keep an independent effective snapshot rather than changing the caller's configuration object.

Apply only the architecture's dynamic fields: settings files, tag snippets, future model defaults, idle timeout, and future buffer size. Preserve startup roots, manager root, listener port, VAPID values, and voice transport. Retain unspecified fields as startup configuration. Return independent snapshots so consumers cannot change live configuration.

Reuse `resolveFilePath()` and `writeEditableFile()` from `server/src/file-edit.ts`. Compare resolved native identity and canonical existing targets so symlink aliases receive native validation. Validate native contents before the atomic write. Apply the validated candidate only after a successful write. Ordinary files keep generic writes without configuration parsing. Return the existing `{ path }` result.

Produce `ServerCapabilitiesEvent` data with the validated snippet palette and voice availability. Production wiring will use the booted orchestrator as the authority for active voice availability.

**Verify:** All `server/src/config-runtime.test.ts` cases pass, including unchanged disk/live state after invalid writes, symlink identity, captured consumer policies, and ordinary last-write-wins writes.
**Status:** not started

### Step 3: Implement the global settings catalog

Complete `GlobalSettingsCatalog.snapshot()` in `server/src/global-settings.ts` using `GlobalSettingsCatalogOptions`. Keep all manifest construction behind this interface and leave contents to `file_get`.

Build entries in this order: effective Pi `AGENTS.md`, effective Pi `settings.json`, native Pimote config, configured paths, extension paths. Resolve config-relative paths from `dirname(configPath)`, leading `~` from the supplied home, and extension paths from the host's resolved registrations. Preserve missing targets. Deduplicate existing canonical targets by first occurrence while keeping the first resolved path as tab identity.

Compute basename labels and add parent segments until colliding labels become unique. Preserve declaration order. Copy option arrays and return independent file records for each snapshot.

**Verify:** `server/src/global-settings.test.ts` passes, including multi-segment label collisions, canonical aliases, missing files, and snapshot isolation.
**Status:** not started

### Step 4: Implement Pimote extension discovery and loading

Complete `createPimoteExtensionHost()` in `server/src/pimote-extensions/index.ts`. Add private implementation files under `server/src/pimote-extensions/` as needed. Preserve the interfaces in `types.ts` and the SDK factory contract in `packages/sdk/src/pimote/index.ts`.

Discover direct JS/TS modules and entry-bearing extension directories in deterministic order. Support the directory `package.json` main entry exercised by `host.test.ts` and index entry files. Read package `pimote.extensions` through the package adapter, not by scanning arbitrary package directories. Do not recursively treat package implementation files as independent extensions.

Adapt `PimotePackageManager.listConfiguredPackages()` and `getInstalledPath()` without installation or updates. Filter to user declarations before reading package manifests. Resolve only `pimote.extensions` from installed package roots. Never pass `pi.extensions` or project packages to this loader. Deduplicate resolved entry paths across directory and package discovery before factory execution.

Reuse the existing `jiti` dependency and the runtime SDK alias helper in `server/src/folder-sources/loader.ts`. Add `@pimote/sdk/pimote` to the aliases. Load each entry's default factory with a scoped context. Resolve relative settings registrations from the entry module and retain missing settings targets. Keep source registrations in discovery order. Validate registrations at the host interface and report entry failures through registry diagnostics without stopping valid modules.

**Verify:** Discovery, missing-registration, package-scope, and isolated-failure cases in `server/src/pimote-extensions/host.test.ts` pass. SDK imports resolve to Pimote's bundled SDK.
**Status:** not started

### Step 5: Complete extension lifecycle and source replacement

Implement `start()`, `reload()`, `getRegistry()`, and `shutdown()` in the extension host. Serialize lifecycle operations so factory execution and shutdown never overlap. Await shutdown handlers, invalidate old contexts, clear loader caches, and discover a fresh runtime. Make late registrations through invalidated contexts inert. Replace the registry even when individual entries fail. Preserve diagnostics from the current runtime and continue loading valid entries.

Implement `RepoIndex.replaceUserSources()` in `server/src/repo-index.ts`. Separate extension-owned sources from `registerSource()` core registrations. Update discovery and `prepareFolderOpen()` consumers to use both sets. Replace the user set atomically, invalidate discovery, and publish changes through the existing `currentFacts()`/`notifyRefreshed()` delta machinery. Preserve core sources and guard against publishing an invalidated walk.

Keep built-in creation behind `BuiltinCodeFolderCreator` in `server/src/folder-sources/builtin.ts` and `createCodeFolder()` in `server/src/folder-create.ts`. Preserve the core manager creation port in `server/src/manager/types.ts` and `index.ts`. Do not restore external creator registration or SDK exports.

**Verify:** All host lifecycle cases and the user-source replacement cases in `server/src/repo-index.test.ts` pass. Existing folder creation tests pass for dashboard and manager consumers.
**Status:** not started

### Step 6: Wire server-global settings and reloads

In `server/src/paths.ts`, define the standard Pimote extensions directory under `PIMOTE_CONFIG_DIR`. In `server/src/index.ts`, construct one config runtime and one extension host after startup configuration preparation. Use Pi's public `getAgentDir()`, `SettingsManager`, and `DefaultPackageManager` exports for effective agent paths and installed user package declarations. Refresh package settings during host rediscovery without installing packages.

Replace the boot call to `loadFolderSources(resolveSourcesDir(...))` with host startup and `repoIndex.replaceUserSources(registry.sources)`. Keep the legacy source-only helper out of production discovery. Report registry diagnostics through server logging. Await host shutdown during graceful server shutdown.

Extend `createServer()` in `server/src/server.ts` to receive the global settings dependencies and pass them to `WsHandler`. Supply a manifest callback that constructs the catalog from the current config snapshot, effective runtime paths, and current extension settings registrations. The callback must not cache one manifest across dialog openings.

Implement `get_global_settings` in `server/src/ws-handler.ts` with the standard request/response envelope and no session lookup. Route `file_put` through the injected config runtime while preserving the existing `AGENTS.md` owning-folder invalidation. After a successful native write, broadcast updated capabilities to connected clients. Send the same current capability payload on connection, with voice determined by the booted orchestrator.

In the `/reload` prompt branch, await `reloadPimoteExtensions` before `session.reload()`. The server-wide callback reloads the host and replaces user sources before returning. Preserve the existing current-session Pi resync and reload response behavior.

**Verify:** The manifest and global-before-Pi reload cases in `server/src/ws-handler.test.ts` pass. Manual checks confirm connection capabilities, native-write broadcasts, extension settings replacement, and folder deltas across clients.
**Status:** not started

### Step 7: Connect dynamic configuration consumers

Change configuration access in `server/src/session-manager.ts` to accept a current-snapshot supplier while preserving callers that pass a fixed config. Wire the runtime supplier from `server/src/index.ts`. Capture the effective policy when creating a session, a voice extension, or an event buffer. Use the explicit snapshot for default model/thinking selection and `buildVoiceExtensionFactory()` model defaults. Existing sessions, voice extensions, and buffers keep their captured values.

Change `startIdleCheck()` to accept a timeout supplier as well as its existing fixed value. Read the current timeout during each idle check. Wire the runtime timeout supplier at boot. Keep roots, manager placement, HTTP listener, push keys, and the active voice orchestrator bound to startup configuration.

**Verify:** Existing session-manager tests pass. Manual checks show changed defaults and buffer size on new consumers, changed timeout on the next idle check, and no changes to active sessions or voice transport.
**Status:** not started

### Step 8: Implement client drafts and capability snippets

Complete `GlobalSettingsStore` in `client/src/lib/stores/global-settings.svelte.ts` using its injected transport. Store loaded/saved baselines independently per manifest path. Open one snapshot, select and load the first file, and lazy-load other files on selection. Preserve drafts across selection and guard against stale responses from closed or replaced openings.

Implement edits, complete-content per-file saves, dirty comparison, missing-file creation state, and load/save errors. Refuse saves before a successful load. Capture the submitted draft so later edits remain dirty after a save response. Reset loading/saving flags after rejected transports. Keep the opening manifest unchanged until close and reopen.

Implement clean close, one dirty-discard confirmation, Keep editing, and Discard without writes. Export a production store bound to `connection.send()` without changing the injectable constructor.

Add a snippet accessor to `client/src/lib/stores/server-capabilities.svelte.ts`, defaulting to an empty palette before advertisement. Remove global path constants, the native config fetch, and `parseTagSnippets` from `file-editor.svelte.ts` when no production caller remains. Feed `ConfigFileEditor.svelte` from capabilities while retaining `openFolderInstructions()` and ordinary path-based editing.

Replace the superseded parser/config-fetch cases in `file-editor.svelte.test.ts` with capability-fed snippet behavior. Update existing editor tests affected by this supersession within this implementation step. Do not change the approved global-settings contract tests.

**Verify:** `client/src/lib/stores/global-settings.svelte.test.ts` passes. Existing folder editor tests pass under the capability contract, with no client read of a reconstructed Pimote config path.
**Status:** not started

### Step 9: Render the approved tabbed editor

Complete `globalSettingsPresentation()` in `client/src/lib/components/global-settings-presentation.ts`. Produce home-only gear placement, path-derived Markdown/JSON/text presentation, Markdown-only capability snippets, and desktop/mobile action locations. Reuse `inferLanguageFromPath()` from `client/src/lib/editor-language.ts` for the editor, mapping plain text to its existing unhighlighted mode.

Complete `GlobalSettingsDialog.svelte` as a renderer of the injected store and its `viewport`, `surface`, and `snippets` inputs. Follow `docs/mocks/global-settings/index.html`: accessible Open Settings gear, modal overlay, no visible Settings title, selected-file summary/path, tab labels, dirty markers, missing-file creation hint, and one close-discard alert dialog.

Reuse the dialog primitives and lazy `ExtensionCodeEditor` pattern from `CodeEditorDialog.svelte`. If shared chrome needs tab insertion or explicit viewport rendering, extend it without changing existing editor behavior. Keep inactive drafts in the store, not in separate editor instances. Mount the active editor only after a successful load. Show manifest/file errors and loading states without exposing an unsafe editable empty draft.

Provide Save for only the active file. Disable it for clean, unloaded, or saving state. Keep desktop Cancel/Save in a semantic footer and mobile Close/Save in the header. Route Escape and outside dismissal through the store's close decision.

Reuse `isValidTagName()` and `wrapWithTag()` from `client/src/lib/tag-wrap.ts` for the Tag row, freeform tag entry, and capability snippet buttons. Render these controls only for Markdown paths. Preserve the selection-wrap behavior used by `ConfigFileEditor.svelte`.

**Verify:** Presentation and actual-dialog tests pass. Manual checks cover tag wrapping, per-tab edits and saves, missing-file creation, error recovery, keyboard dismissal, Keep editing, and Discard in both mock viewports.
**Status:** not started

### Step 10: Mount the home Settings entry point

Mount `GlobalSettingsDialog.svelte` from `client/src/lib/components/Dashboard.svelte` with the production store and current capability snippets. Supply responsive viewport information using the client breakpoint convention. Position the large desktop gear at bottom-left and the small mobile gear at top-left, including safe-area spacing.

Remove the Agent instructions header button and its global-path import from `FolderList.svelte`. Keep its folder-row `openFolderInstructions()` action. Keep the Settings gear out of conversation mounts. Adjust dashboard/home styling only where needed for the approved placement.

**Verify:** The dashboard opens Settings through the gear at both breakpoints. Conversation surfaces have no gear. Folder instructions remain editable from folder rows.
**Status:** not started

### Step 11: Update extension guidance and verify integration

Update `README.md`, `packages/sdk/README.md`, and relevant folder recipes in `docs/shipped/folders.md` and `docs/shipped/recipes.md`. Replace the old source-array/creator example with a default `PimoteExtension` factory example. Document `@pimote/sdk/pimote`, `registerSource()`, `registerFile()`, shutdown, user XDG discovery, user-installed package adaptation, and separate `pi.extensions`/`pimote.extensions` entries. Explain explicit dual-host modules and independent lifecycles. Document the removed external creator seam without renaming the core folder wizard.

Document effective Settings paths, missing-file creation, config-relative and module-relative registrations, opening snapshots, native validation, capability snippets, and the exact dynamic/startup configuration matrix. Remove obsolete hard-coded-path warnings and old-loader production claims.

Update `server/src/pimote-docs/index.ts` guidance to distinguish the two hosts. Check `server/src/sdk-twins.ts` and SDK exports for the new type surface and absence of public `FolderCreator`. Update `codemap.md` to describe the host, catalog, runtime, client store/dialog, and source-only SDK seam.

Update `tools/manual-test/PLAN.md` and `tools/manual-test/README.md` to cover Settings instead of the global Agent instructions button. Include multi-client capability refresh, host reload failures, installed-package filtering, native validation, symlink writes, dynamic consumer policies, and retained folder instructions. Use the existing manual-test harness rather than adding dependencies.

**Verify:** Run `npm run build`, `npm run check`, `npm run test --workspace=@pimote/server -- --run`, and `npm run test --workspace=client -- --run`. Complete the plan's Manual Acceptance checks and the approved mock flows. SDK documentation and production discovery contain no external creator registration contract.
**Status:** not started
