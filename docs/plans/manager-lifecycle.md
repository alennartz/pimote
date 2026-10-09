# Plan: Manager lifecycle — the manager becomes a persona folder

## Context

The manager stops being an ephemeral per-connection special case and becomes a regular persona folder rooted at `managerRoot` (config key, default `~`): persona `AGENTS.md`, ordinary persisted sessions, manager-exclusive `pimote_*` toolset, shipped seed file. Brainstorm: `docs/brainstorms/manager-lifecycle.md`. Pull brief: `pulls/P0-2.2-manager-lifecycle.md` in the product-manager repo — where they conflict, the brainstorm wins (sessions persist; tool seam stays manager-exclusive; manager wire vocabulary is retired).

## Architecture

### Impacted Modules

- **Protocol (`shared/src/**`)** — `manager*prompt`/`manager_abort`commands and the`manager_event` stream are deleted (`protocol.ts:545-554`, `1162-1169`). No replacement vocabulary: manager sessions ride the ordinary session commands (`open_session`, `prompt`, `abort`) and session events with `folderPath = managerRoot`. Checklist item: grep the Android protocol mirror for `manager*` consumption; if present, it breaks without a shim (accepted debt, per the paging precedent).
- **Server, manager module (`server/src/manager/**`)** — `ManagerService` (per-client lazy creation, dispose-on-disconnect, idle reaper) and the in-memory session factory (`createManagerSessionFactory`, `buildManagerSession`, `session-manager.ts:841-965`) are deleted. What remains: the manager extension (toolset) and its resource handling; the 24-hour post-disposal artifact snapshot behavior dies with the disposal lifecycle (normal session artifact rules apply). The extension gains `pimote_create_persona`and`pimote_list_personas` (interfaces below).
- **Server, session assembly (`server/src/session-manager.ts`, `server/src/index.ts`)** — normal-session runtime assembly conditionally includes the manager extension factory when the session's canonical cwd equals the canonical `managerRoot`. The startup-built ports (`folderRegistry`, `repoIndex`, `folderTree`, session operations) keep their roles; only their consumer changes. `ws-handler.ts` loses the `manager_prompt`/`manager_abort` routing block (`349-379`).

**Session ownership across reconnect.** Sessions are server-owned; a WebSocket disconnect drops the viewer, never the session. A running manager session keeps processing server-side, and a reconnecting client reattaches through the ordinary `open_session` flow with its last cursor (`connection.svelte.ts:144-190`). No manager-specific reconnect logic exists or is added — deleting the per-connection manager lifecycle is what makes this true.

- **Server, boot seeding (new step in `server/src/index.ts` startup)** — after config load, before (or independent of) first session: canonicalize `managerRoot`; if `<managerRoot>/AGENTS.md` is absent write the shipped seed template; if `<managerRoot>/memory.md` is absent write a stub. Never overwrite or merge existing files. Seed template is a code constant in the server package: mission statement plus the maintain-`memory.md` indication; no tool listing (tools are injected).
- **Server, session records (`server/src/session-records.ts`)** — no changes; the manager session list is `listSessionRecords(managerRoot)`.
- **Web client (`client/src/lib/**`)** — `manager-store.svelte.ts`(synthetic slot,`manager_event`reduction, reset-on-disconnect) is deleted.`ManagerChat.svelte`becomes a thin manager area on the dashboard: composer plus a click-to-open session list backed by the manager session records. Composer behavior: if a manager session is currently being viewed, submit prompts it; otherwise it opens a new session at`managerRoot`and navigates into it (normal`open_session`flow,`session-route.ts`). Old sessions resume through the existing open flow; ActiveSessionBar and reconnect restore pick manager sessions up for free. DR-048's two-surface rule holds: the manager area stays part of the dashboard (side-by-side desktop, sheet mobile); opening a manager session is ordinary conversation navigation.
- **pi-065 (`docs/bugs/pi-065-extension-newsession-broken.md`)** — verified against SDK `^1.1.0`: the silent ghost-execution behavior is fixed upstream; a stale `pi.*` call now throws synchronously with guidance to use `withSession`. **No patch-package extension** — pimote's own code never captures extension ctx across a replacement (resets run through `slot.runtime.newSession()` + `applySessionReset` in `ws-handler.ts`), so a rebind patch would add upgrade-maintenance surface for an unused pattern. A regression test pins the 1.1.0 fail-fast contract; the verification result is recorded in the bug doc.

### New Modules

None. Seeding is a startup step, not a module; the toolset extension already exists.

### Interfaces

**Manager extension attachment rule.**

```
loadManagerExtension(session) =
  canonical(session.cwd) === canonical(config.managerRoot)
```

Evaluated once at session assembly, alongside the existing extension factories. No config flag; no runtime toggling. Because `managerRoot` is never a scan root, no folder-list session can satisfy the rule — exclusivity is by construction.

**`pimote_create_persona` tool.**

```
params:  { name: string, parentPath: string, description: string, prompt?: string }
result:  { folderPath: string }   // canonical path of the new persona folder
errors:  parentPath not under any scan root; name collision (folder exists);
         fs failure
```

Creates `<parentPath>/<name>/` containing `AGENTS.md` (front matter: `name`, `description`; body: persona prompt template — pre-seeded persona prompt text including the instruction to maintain `memory.md`, with the caller's `prompt` prepended or appended to the template's fixed sections) and `memory.md` (stub). After creation, folder-model discovery is invalidated so `folders_changed` fires and the dashboard list picks the persona up.

Placement validation: `parentPath` and scan roots are canonicalized before comparison; the parent may be a scan root itself; containment is checked on canonical paths so a symlink escape is rejected; `name` must be a single basename path segment (empty, `/`, and traversal segments rejected). Violations return tool error results, never throws. The tool never invents a default location; the manager chooses (or asks) using the folder tree.

Tool error semantics: dependency failures in `pimote_list_personas` (registry/index/records ports) return tool error results.

**`pimote_list_personas` tool.**

```
params:  none
result:  { personas: Array<{ name, description, folderPath, workingDirectory }> }
```

Rows come from the folder model (nature = persona) over the existing injected ports. `folderPath` is the canonical identity path; `workingDirectory` is the same path (personas run rooted in their folder). This is the groundwork P0-3's spawn-and-confer builds on.

**Existing toolset.** The seven current tools keep behavior and names unchanged. Port injection moves from the deleted manager factory to the startup-built extension factory consumed by normal session assembly.

**Seed contract.**

```
on boot:  seedManagerRoot(config.managerRoot)
          - AGENTS.md absent  -> write shipped template
          - AGENTS.md present -> untouched (no merge, ever)
          - memory.md absent  -> write stub
          - memory.md present -> untouched
```

The shipped template parses as a persona marker: YAML front matter with `name: manager` and a one-line `description`, followed by the mission body (mission statement plus the maintain-`memory.md` indication; no tool listing — tools are injected). Seed and attachment filesystem errors propagate: boot fails loudly if `managerRoot` is unusable.

**Manager composer decision (client, pure function).**

```
managerComposerAction(viewed: SessionView | undefined, viewedIsManager: boolean):
  | { action: 'continue', sessionId: string }   // a manager session is on screen
  | { action: 'open-new' }                      // manager landing, no manager session viewed
```

The dashboard manager composer consults this instead of session logic; submit either prompts the viewed manager session or opens a new session at `managerRoot` via the normal `open_session` flow. Component tests stay out of scope; the pure function carries the behavior.

**pi-065 regression test contract.** A test that replaces a runtime session (`runtime.newSession()`) with a pimote extension loaded and asserts the SDK 1.1.0 fail-fast contract: (1) a stale `pi.*` call throws synchronously — never a silent no-op; (2) the disposed session receives zero events and executes zero tools; (3) the replacement session prompts normally. This test is **green on arrival**: it pins external SDK behavior, not our code — a documented Red Gate exception (nothing exists to accidentally implement).

### DR Supersessions

- **DR-047** (The manager agent is global and ephemeral) — superseded: the manager gains a real folder, persisted sessions, and cross-connection identity; the per-connection in-memory lifecycle, temp cwd, idle reaper, and ports-only tool restriction are deleted. Replacement: manager = persona folder at `managerRoot` per this plan and DR-053's folder model. (User rulings in `docs/brainstorms/manager-lifecycle.md`; cutover ruling 2026-10-04 stands: straight replacement, no flag, git-revert rollback.)
- **DR-053** (Unified folder model) — partially amended, manager carve-out only: its persona-persistence model (folder-resident `memory.md`, folder = identity) is reinforced and extended to the manager; its "conversations are ephemeral" line no longer applies to the manager (manager sessions are ordinary persisted sessions). It still applies to persona conferrals (P0-3). Manager root remains excluded from discovery.

## Tests

**Pre-test-write commit:** `5bfe2c1ef968b90dca3dafbd9e3d08f409b9c596`

### Interface Files

- `server/src/manager/types.ts` — `CreatePersonaInput` and `PersonaRow` data shapes; `RepoIndexPort.invalidateListing()` (the folder-model discovery invalidation seam, matching the real `RepoIndex`); ManagerToolContext doc note for `pimote_create_persona`'s deliberate disk access.
- `server/src/manager/attachment.ts` — `loadManagerExtension(session, config)`: the manager extension attachment rule (canonical cwd equals canonical `managerRoot`), stub.
- `server/src/manager/seed.ts` — `seedManagerRoot(managerRoot)`: the boot seeding contract for `AGENTS.md`/`memory.md`, stub.
- `server/src/manager/extension.ts` — `pimote_create_persona` and `pimote_list_personas` tool registrations (parameter and output schemas, contract descriptions, stub executes). The seven existing tools are unchanged.
- `server/src/manager/index.ts` — exports for the new interfaces.
- `server/src/session-manager.ts` — `SessionManagerOptions.managerExtensionFactory`, the injection seam for normal persisted manager sessions.
- `client/src/lib/manager-composer.ts` — `SessionView`, `ManagerComposerAction`, and the pure `managerComposerAction` decision interface, stub.
- `server/src/manager/extension.test.ts` — structural update: pinned toolset now includes the two new names; fake repos port gains `invalidateListing`.
- `server/src/index.test.ts` — structural update: pinned manager toolset list.
- `tools/manual-test/manager-tools-smoke/manager-tools-smoke.mjs` — structural update: expected registration list.

### Test Files

- `server/src/manager/attachment.test.ts` — the manager extension attachment rule: equality, non-containment, canonical (symlink) identity.
- `server/src/manager/seed.test.ts` — manager-root boot seeding: write-if-absent, never-merge, never-overwrite, template contract.
- `server/src/manager/persona-tools.test.ts` — `pimote_create_persona` (disk effects, canonical result, error contract, discovery invalidation) and `pimote_list_personas` (persona rows from the folder model).
- `server/src/pi-065-newsession.test.ts` — pi-065 regression: stale `pi.*` rejection after `runtime.newSession()`, no ghost work, replacement session prompts normally.
- `server/src/session-manager-open-session.test.ts` — normal assembly injects the manager extension exclusively at `managerRoot`; persisted manager slots survive viewer loss and reopen through the normal slot map.
- `server/src/manager/protocol-cutover.test.ts` — shared source contains no `manager_prompt`, `manager_abort`, or `manager_event` vocabulary.
- `client/src/lib/manager-composer.test.ts` — continue the viewed manager session; open new from landing or a code session; handle a stale manager flag without a viewed session.

### Behaviors Covered

#### Manager extension attachment rule

- Attaches the manager extension when the session's canonical cwd equals the canonical `managerRoot`.
- Does not attach for a session in an unrelated folder.
- Does not attach for a session inside the manager root — equality, not containment.
- Attaches when the session cwd is a symlink alias of the manager root — canonical identity is the real path.

#### Boot seeding (`seedManagerRoot`)

- Writes the shipped `AGENTS.md` template and a `memory.md` stub when both are absent.
- The folder-model classifier recognizes the template as a persona named `manager` with a nonempty one-line description.
- The template is non-empty, carries the maintain-`memory.md` indication, and lists no tools (tools are injected).
- Unusable manager roots propagate filesystem errors without altering existing files.
- Leaves an existing `AGENTS.md` byte-identical — never merges — and still seeds the absent `memory.md`.
- Leaves an existing `memory.md` byte-identical and seeds the absent `AGENTS.md`.
- Changes nothing when both files are present.

#### `pimote_create_persona`

- Creates `<parentPath>/<name>/` with an `AGENTS.md` whose front matter carries `name` and `description` (parseable by the folder model's persona marker), whose body folds in the caller's `prompt` and keeps the maintain-`memory.md` instruction, and a `memory.md` stub.
- Returns `{ folderPath }` — the canonical path of the new persona folder.
- Invalidates folder-model discovery after creation, so `folders_changed` fires.
- Returns an error result and creates nothing when `parentPath` is not under any scan root; no invalidation.
- Returns an error result and leaves the existing folder untouched on a name collision; no invalidation.
- Returns an error result when creation fails on the filesystem; no invalidation.
- Uses the fixed persona template and writes both files when `prompt` is omitted.
- Accepts the scan root itself and canonical scan-root aliases.
- Rejects invalid basenames, symlink escapes, and sibling paths sharing only the scan-root prefix; no disk effects or invalidation.

#### `pimote_list_personas`

- Reports one row per persona folder (`nature = persona`) from the folder model: `name`, `description`, canonical `folderPath`, and `workingDirectory` equal to `folderPath`.
- Excludes code folders and hubs.
- Reports an empty list when the folder model knows no personas.
- Returns tool errors when folder-model dependencies fail.
- Does not constrain persona row ordering.

#### pi-065: `pi.*` after `runtime.newSession()` (external SDK contract)

Verification result (recorded in `docs/bugs/pi-065-extension-newsession-broken.md`): SDK ^1.1.0 fixed the silent ghost-execution half of pi-065 upstream as fail-fast. A stale `pi.*` call throws synchronously instead of targeting the disposed session; it does not rebind to the replacement session. Ruling: fail-fast is the accepted contract; no patch-package extension (pimote never captures extension ctx across a replacement). The plan's "if the stale binding persists, extend patch" conditional does not fire.

- A `pi.*` call on the ctx captured at load time throws synchronously after replacement — never silently no-ops.
- The disposed session receives zero events and executes zero tools — no ghost work.
- The replacement session still prompts normally through its own ctx: the run executes, events are delivered, the user message lands in its transcript.

### Assembly, cutover, and composer boundaries

- Normal assembly loads the manager extension only for manager-root sessions.
- Manager sessions use persisted pi session creation and the ordinary slot map. Viewer loss does not remove the slot; reopening its session file returns the same runtime.
- Shared source removes all three retired manager wire names, without replacement vocabulary.
- The pure composer decision continues only a viewed manager session. Landing, a code session, or a missing view opens new.

### Red Gate

Stub behavior tests remain red until implementation. Assembly injection and the static protocol cutover assertion are red until cutover. Existing persisted slot ownership is green through the normal session boundary. Filesystem propagation tests are green on the throwing stubs and must remain green on implementation. **External SDK exception:** `pi-065-newsession.test.ts` is green. It pins SDK behavior, not pimote implementation, and verifies the accepted fail-fast contract. Pre-existing tests remain green, including the structurally updated pinned-toolset tests.

**Review status:** approved

## Steps

**Pre-implementation commit:** `73dcbd555577df650a08407688b332f7012985ed`

Implementation changes must preserve the Red Gate tests and their behavioral contracts. Do not change the new attachment, seed, persona-tool, pi-065, protocol-cutover, composer, or assembly/ownership assertions.

**Investigation rulings:**

- Delete obsolete module-owned tests only when their module or lifecycle is deleted below. Retarget existing wiring assertions without weakening their generic coverage.
- The startup extension factory can use a stable, init-time context holder. Fill it exactly once before accepting session opens. It must not become a runtime service locator.
- Expose the canonical manager root through `ListFoldersResponseData`, beside `roots`. The dashboard's ordinary folder request supplies this fact. Do not add a bootstrap event or read raw configuration through `file_get`.
- Include manager-root records in persisted-resource enumeration and folderless session lookup, without adding the manager root to discovery.
- Verify manager-root resource enumeration through retargeted existing startup GC coverage. If that coverage cannot express the invariant, record the gap for implementation-phase red-green TDD.

### Step 1: Implement canonical attachment and boot seeds

Implement `loadManagerExtension` in `server/src/manager/attachment.ts`. Canonicalize both input paths through filesystem real paths. Return exact equality, not containment. Propagate filesystem errors.

Implement `seedManagerRoot` in `server/src/manager/seed.ts`. Keep the shipped manager mission and memory stub as immutable code constants. The `AGENTS.md` template must include persona-marker front matter, `name: manager`, a nonempty one-line description, and the maintain-`memory.md` instruction. Do not list tools.

Seed each absent file independently. Preserve existing files byte-for-byte, including races with another writer. Do not swallow errors other than an existing destination. An unusable manager root must fail startup. Keep these operations behind the existing exported interfaces in `server/src/manager/index.ts`.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/manager/attachment.test.ts src/manager/seed.test.ts` passes, including symlink identity and filesystem propagation.
**Status:** done

### Step 2: Implement persona creation

Replace the `pimote_create_persona` execute stub in `server/src/manager/extension.ts`. Preserve its registered name, parameter schema, and output schema. Use `CreatePersonaInput` from `server/src/manager/types.ts`.

Validate `name` as one nonempty basename, rejecting separators, `.` and `..`. Canonicalize `parentPath` and configured scan roots. Accept root equality or true descendant containment. Reject sibling prefix matches and symlink escapes before creating files. Do not choose a default parent.

Create only the new `<parentPath>/<name>` folder. Refuse existing destinations without altering them. Write a parseable persona marker with the caller's name and description. Compose the optional caller prompt with the fixed persona prompt and maintain-`memory.md` instruction. Write the memory stub. Keep text composition pure and filesystem effects in the creation operation. Serialize front-matter values safely for `parsePersonaFrontMatter` in `server/src/folder-model/marker.ts`.

Return `jsonToolResult({ folderPath })` with the created folder's canonical path. After successful materialization, call the injected `context.repos.invalidateListing()`. Validation, collision, and filesystem failures return `errorToolResult`, never an execute rejection. Do not invalidate failed creations. Leave the other seven tools unchanged.

**Verify:** The `pimote_create_persona` cases in `npm run test --workspace=@pimote/server -- --run src/manager/persona-tools.test.ts` pass. Invalid inputs leave no disk effects.
**Status:** done

### Step 3: Implement persona listing

Replace the `pimote_list_personas` execute stub in `server/src/manager/extension.ts`. Read complete folder rows through the injected folder-registry port. Select persona rows, excluding hubs as required by the tool contract. Shape immutable `PersonaRow` values with persona name, string description, canonical `folderPath`, and matching `workingDirectory`. Use an empty string for an absent description.

Return `jsonToolResult({ personas })`. Return `errorToolResult` for dependency failures. Do not perform new discovery or filesystem canonicalization on already-canonical folder-model rows. Keep the registration and schemas unchanged.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/manager/persona-tools.test.ts src/manager/extension.test.ts` passes. The existing tool registration and behavior assertions remain intact.
**Status:** done

### Step 4: Attach tools during ordinary session assembly

In `server/src/session-manager.ts`, retain `SessionManagerOptions.managerExtensionFactory` and store the injected factory as a readonly instance dependency. Add it to `resourceLoaderOptions.extensionFactories` only when `loadManagerExtension({ cwd }, config)` returns true.

Evaluate attachment during the existing runtime assembly, using the runtime's effective cwd. Resumed session files use their persisted cwd, not the requested folder. Runtime replacement must receive the same assembly rule. Skip attachment work when no manager extension factory is configured. Preserve voice, static-host, and file-download factories and their existing ordering.

Keep `PiSessionManager.create`/`open`, the ordinary slot map, replay buffers, reset flow, and server-owned session lifecycle. A disconnect must only clear viewer ownership. Do not add manager-specific reconnect or reset logic.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/session-manager-open-session.test.ts src/session-manager.test.ts src/pi-065-newsession.test.ts` passes. Manager sessions persist, reopen the same live slot, and load tools exclusively at the manager root. The external SDK regression remains green without a patch change.
**Status:** not started

### Step 5: Wire startup ports and persisted resources

In `server/src/index.ts`, canonicalize `config.managerRoot` after configuration load and before session assembly. Await `seedManagerRoot` before accepting session opens. Do not add the manager root to `config.roots`, `RepoIndex`, folder sources, or folder-model discovery.

Pass a manager extension factory into `PimoteSessionManager.create` beside the existing resource factories. Preserve the current `ManagerToolContext` ports for live sessions, disk records, opening, archiving, folder registry, repo index, and sparse tree.

Resolve startup ordering with a stable forwarding factory and an explicit init-time context holder. Construct the session manager and `FolderListing`, then bind the context exactly once before `createServer` can serve session commands. Consult-unfilled must be impossible through startup ordering. Capture stable bindings, not a reassignable local variable. Retain the existing client-registry forwarding reference for archive broadcasts, filled at startup.

Remove the `ManagerService` construction and manager-specific reaper. Keep the ordinary idle reaper and shutdown disposal.

Extend `enumerateValidSessionIds` to enumerate manager-root records alongside discovered entry and reach paths. Deduplicate enumeration paths. Preserve strict listing and the `null` allow-list on incomplete enumeration. Static hosting and downloads must retain persisted manager resources without discovering the manager root.

Retarget only `createManagerSessionFactory` wiring mocks/assertions in `server/src/index.test.ts` to the normal session-manager option. Preserve toolset, port behavior, configuration, bootstrap, and GC assertions. Update existing GC coverage to express the separate manager-root enumeration. If that requires additional behavioral coverage, record the implementation-phase TDD gap rather than weakening existing assertions.

**Verify:** Startup initializes the context before serving opens. `npm run test --workspace=@pimote/server -- --run src/index.test.ts` passes. Its resource allow-list includes manager records, while discovery still receives only scan roots. Existing incomplete-enumeration cases still suppress GC.
**Status:** not started

### Step 6: Remove the ephemeral server lifecycle

Delete `server/src/manager/service.ts` and its module-owned `service.test.ts`. Remove `ManagerSessionFactoryDeps`, `createManagerSessionFactory`, and `buildManagerSession` from `server/src/session-manager.ts`, including imports used only by that factory. Remove service exports from `server/src/manager/index.ts`.

Delete `server/src/manager/resources.ts` and `resources.test.ts`. Their artifact snapshots, retention timers, restart reset, and 24-hour leases belong to the deleted lifecycle. Remove `resetManagerResourceRoot` startup wiring and the manager resource-path constant in `server/src/paths.ts` if no consumer remains. Use ordinary static-host and download extensions for manager sessions. Do not change their generic retention options for other callers.

In `server/src/server.ts`, remove the manager-service parameter and forwarding argument. In `server/src/ws-handler.ts`, remove manager service/session imports, `managerListener`, prompt/abort routing, and manager-specific cleanup. Update `requireFolderDeps` to require only the remaining folder dependencies. Keep disconnect cleanup for ordinary slots and folder-order pins.

Update affected positional constructor calls and test fixtures only to reflect removed parameters. Do not retain an optional compatibility slot or dead lifecycle export.

**Verify:** `rg 'ManagerService|createManagerSessionFactory|buildManagerSession|createManagerResources|resetManagerResourceRoot' server/src` has no matches. Server type checking and the existing server/WS tests pass after the protocol cutover below. Disconnect leaves a working manager runtime in the ordinary slot map.
**Status:** not started

### Step 7: Cut over protocol and root metadata

In `shared/src/protocol.ts`, delete `ManagerPromptCommand`, `ManagerAbortCommand`, and `ManagerStreamEvent`, plus their union members. Do not add replacement manager command/event names.

Add `managerRoot: string` to `ListFoldersResponseData`, beside `roots`. This field is the server-canonical absolute manager path, never raw `~`. In `server/src/ws-handler.ts`, include it in every `list_folders` response. Thread the canonical startup fact from `server/src/server.ts` into the handler through an explicit dependency.

Extend `findSessionRecord` in `server/src/ws-handler.ts` so folderless disk lookup searches manager-root records as well as known folder records. Keep folder-specific lookup unchanged. Do not insert a synthetic manager row into discovery or the registry.

In `client/src/lib/stores/connection.svelte.ts`, store the server-provided manager-root fact with connection state. In `client/src/lib/stores/folder-store.svelte.ts`, adopt it from successful ordinary folder responses without creating a folder-list row. Manager controls must wait for a usable root fact and connected readiness.

Inspect the hand-written Android mirror for retired names. Investigation found no `manager_prompt`, `manager_abort`, or `manager_event` consumers in `mobile/android`. Add no shim.

**Verify:** `npm run build:shared` succeeds. `npm run test --workspace=@pimote/server -- --run src/manager/protocol-cutover.test.ts` passes. Root metadata remains separate from listed folders, and folderless manager-session reopening resolves disk records.
**Status:** not started

### Step 8: Implement composer and ordinary navigation

Implement the pure `managerComposerAction` stub in `client/src/lib/manager-composer.ts`. Continue only when a viewed session exists and `viewedIsManager` is true. Otherwise return `open-new`, including stale flags.

Rewrite `client/src/lib/components/ManagerChat.svelte` as a thin manager area with a composer and persisted session list. Consume the canonical root from connection state. Use `folderStore.loadSessions(managerRoot)` and its path-keyed session cache, which already supports arbitrary folder paths. Do not require a discovered folder row.

Submit through one operation shared by the manager area's entry controls. Pass the current view and manager identity into `managerComposerAction`. For `continue`, send ordinary `prompt` to that session. For `open-new`, await ordinary `open_session` at `managerRoot`, confirm success, prompt the returned session id, and navigate through the existing session registry. Preserve the draft on rejection. Do not prompt a placeholder id or select a historical manager session implicitly.

Open a listed session through `openExistingSession(id, managerRoot, { switchTo: true })`. Use normal session summary presentation and ownership handling. Reuse `switchToSession` and `session-route.ts` navigation. Do not add a manager URL, synthetic transcript, separate event reducer, or reconnect path.

**Verify:** `npm run test --workspace=client -- --run src/lib/manager-composer.test.ts` passes. Manual submission from landing creates a persisted session. Selecting an old record resumes it. Submission with a viewed manager session continues that exact session.
**Status:** not started

### Step 9: Replace dashboard manager surfaces

Update `client/src/lib/components/Dashboard.svelte` and `HomeToolbar.svelte` to remove `managerStore` dependencies. Drive desktop panel and mobile sheet presentation through local UI state, not transcript existence. Keep the manager area on the dashboard. Opening a session must navigate to the ordinary conversation surface.

Give the toolbar explicit manager-area inputs/callbacks instead of a new global mutable store. Keep composer submission logic in the operation from Step 8. Closing a panel or sheet must only close UI, not abort, erase, or dispose a session.

Delete `client/src/lib/stores/manager-store.svelte.ts` and its module-owned `manager-store.svelte.test.ts`. Remove manager reset comments from `connection.svelte.ts` and synthetic-manager comments from `session-registry.svelte.ts`. Preserve generic disconnect listeners used by other stores.

Remove obsolete 24-hour manager-link copy from `client/src/lib/components/ManagerResources.svelte`. Ordinary session panels and downloads now own manager artifacts. Do not keep that presentation in the landing area as a second conversation. Preserve generic card/download coverage. Do not delete unrelated resource tests or change generic renderers.

**Verify:** `rg 'manager-store|manager_prompt|manager_abort|manager_event' client/src --glob '!*.test.ts'` has no matches. `npm run check --workspace=client` succeeds. Desktop uses a dashboard manager panel, mobile uses a sheet, and both open ordinary session conversations.
**Status:** not started

### Step 10: Verify the complete replacement

Run the server and client test suites, shared build, and repository checks. Resolve only failures caused by this cutover. Keep the Red Gate contracts intact and preserve generic tests when adjusting removed constructor slots or mocks.

Run `tools/manual-test/manager-tools-smoke/manager-tools-smoke.mjs` using its documented driver command. Its nine-tool registration contract already includes the persona tools. Exercise dashboard submission, history reopening, disconnect during a run, reconnect replay, and ordinary report/download handling against an isolated manager root.

Confirm no per-connection manager lifecycle remains. Confirm configured scan roots remain unchanged. Confirm manager-root seeding preserves user files across restart and manager-session resources survive normal boot enumeration. The pi-065 fail-fast contract must stay green without a patch-package change.

**Verify:** `npm run test --workspace=@pimote/server -- --run`, `npm run test --workspace=client -- --run`, `npm run build:shared`, and `npm run check` pass. The manual manager-tool and lifecycle journeys pass. No manager-specific commands or stream wrappers remain in shared source.
**Status:** not started
