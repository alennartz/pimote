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
- **pi-065 (`docs/bugs/pi-065-extension-newsession-broken.md`)** — verify against SDK `^1.1.0` (bug doc covers 0.65.0–0.66.1 only). If the stale runtime binding persists after `runtime.newSession()`, extend the existing patch-package patch (DR-006 precedent). Regression test lands either way; the verification result is recorded in the bug doc.

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

**pi-065 regression test contract.** A test that replaces a runtime session (`runtime.newSession()`) with a pimote extension loaded and asserts post-replacement `pi.*` calls act on the new session (event delivery to the new session, no ghost execution on the old one). Fails against the bug, passes after fix/patch.

### DR Supersessions

- **DR-047** (The manager agent is global and ephemeral) — superseded: the manager gains a real folder, persisted sessions, and cross-connection identity; the per-connection in-memory lifecycle, temp cwd, idle reaper, and ports-only tool restriction are deleted. Replacement: manager = persona folder at `managerRoot` per this plan and DR-053's folder model. (User rulings in `docs/brainstorms/manager-lifecycle.md`; cutover ruling 2026-10-04 stands: straight replacement, no flag, git-revert rollback.)
- **DR-053** (Unified folder model) — partially amended, manager carve-out only: its persona-persistence model (folder-resident `memory.md`, folder = identity) is reinforced and extended to the manager; its "conversations are ephemeral" line no longer applies to the manager (manager sessions are ordinary persisted sessions). It still applies to persona conferrals (P0-3). Manager root remains excluded from discovery.
