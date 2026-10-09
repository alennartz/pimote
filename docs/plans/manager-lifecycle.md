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

Creates `<parentPath>/<name>/` containing `AGENTS.md` (front matter: `name`, `description`; body: persona prompt template — pre-seeded persona prompt text including the instruction to maintain `memory.md`, with the caller's `prompt` prepended or appended to the template's fixed sections) and `memory.md` (stub). After creation, folder-model discovery is invalidated so `folders_changed` fires and the dashboard list picks the persona up. `parentPath` is required and validated as inside a scan root — the tool never invents a default location; the manager chooses (or asks) using the folder tree.

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
- `server/src/manager/extension.test.ts` — structural update: pinned toolset now includes the two new names; fake repos port gains `invalidateListing`.
- `server/src/index.test.ts` — structural update: pinned manager toolset list.
- `tools/manual-test/manager-tools-smoke/manager-tools-smoke.mjs` — structural update: expected registration list.

### Test Files

- `server/src/manager/attachment.test.ts` — the manager extension attachment rule: equality, non-containment, canonical (symlink) identity.
- `server/src/manager/seed.test.ts` — manager-root boot seeding: write-if-absent, never-merge, never-overwrite, template contract.
- `server/src/manager/persona-tools.test.ts` — `pimote_create_persona` (disk effects, canonical result, error contract, discovery invalidation) and `pimote_list_personas` (persona rows from the folder model).
- `server/src/pi-065-newsession.test.ts` — pi-065 regression: stale `pi.*` rejection after `runtime.newSession()`, no ghost work, replacement session prompts normally.

### Behaviors Covered

#### Manager extension attachment rule

- Attaches the manager extension when the session's canonical cwd equals the canonical `managerRoot`.
- Does not attach for a session in an unrelated folder.
- Does not attach for a session inside the manager root — equality, not containment.
- Attaches when the session cwd is a symlink alias of the manager root — canonical identity is the real path.

#### Boot seeding (`seedManagerRoot`)

- Writes the shipped `AGENTS.md` template and a `memory.md` stub when both are absent.
- The template is non-empty, carries the maintain-`memory.md` indication, and lists no tools (tools are injected).
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

#### `pimote_list_personas`

- Reports one row per persona folder (`nature = persona`) from the folder model: `name`, `description`, canonical `folderPath`, and `workingDirectory` equal to `folderPath`.
- Excludes code folders and hubs.
- Reports an empty list when the folder model knows no personas.

#### pi-065: `pi.*` after `runtime.newSession()` (external SDK contract)

Verification result (recorded in `docs/bugs/pi-065-extension-newsession-broken.md`): SDK ^1.1.0 fixed the silent ghost-execution half of pi-065 upstream as fail-fast. A stale `pi.*` call throws synchronously instead of targeting the disposed session; it does not rebind to the replacement session. Ruling: fail-fast is the accepted contract; no patch-package extension (pimote never captures extension ctx across a replacement). The plan's "if the stale binding persists, extend patch" conditional does not fire.

- A `pi.*` call on the ctx captured at load time throws synchronously after replacement — never silently no-ops.
- The disposed session receives zero events and executes zero tools — no ghost work.
- The replacement session still prompts normally through its own ctx: the run executes, events are delivered, the user message lands in its transcript.

### Red Gate

All 16 new interface tests fail via `throw new Error("not implemented")` from the stubs. **One documented exception:** `pi-065-newsession.test.ts` is green. It pins external SDK behavior, not pimote implementation — there is no stub that could accidentally satisfy it — and its green result is the plan's pi-065 verification outcome (see above). Pre-existing tests stay green, including the structurally updated pinned-toolset tests.
