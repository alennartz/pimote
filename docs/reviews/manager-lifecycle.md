# Review: manager-lifecycle

**Plan:** `docs/plans/manager-lifecycle.md`
**Diff range:** `73dcbd5..HEAD` (commits 36974f0, c917387, 9a21e23)
**Date:** 2026-10-09

## Summary

Plan fidelity is high. All ten steps were implemented with correct intent: the canonical attachment rule, race-safe boot seeding, the persona tool contracts, full deletion of the ephemeral lifecycle, and the protocol cutover all match the plan. Test immutability held and every Red Gate and verify command passes. One critical correctness risk dominates: boot seeding writes the manager persona prompt into the default `managerRoot` of `~`, where pi loads it as ancestor context for every session under home. Three warnings and six nits follow, clustered around the dashboard composer's draft/submit wiring and a missing `folders_changed` broadcast.

## Passes

- Plan adherence: run on `medium` (per skill).
- Code correctness: `frontier` is billing-blocked (402). Two `smart` sessions died to provider errors (encrypted-content). Per fallback order, the pass ran on `medium`.

## Findings

### 1. Boot seeding writes the manager persona prompt into `~`

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/manager/seed.ts:31-61`, `server/src/index.ts:46-47`, `server/src/config.ts:59`
- **Status:** open

`DEFAULT_MANAGER_ROOT` is `~`. First boot writes `~/AGENTS.md` (persona marker, "You are the manager of this Pimote installation…") and `~/memory.md` when absent. pi's `loadProjectContextFiles` walks every ancestor of a session cwd and loads each `AGENTS.md` into context. After upgrade, every pi session started anywhere under the home tree — all pimote code sessions and plain pi CLI usage — silently gains the manager persona prompt and the `memory.md` maintenance instruction. This steers every agent on the machine toward "manager" and can drive `memory.md` writes outside the persona folder. The brainstorm records this as an open question (`docs/brainstorms/manager-lifecycle.md:26`); the ancestor-injection mechanism widens the blast radius beyond what that question assumed. The effect fires once, persists, and is invisible.

### 2. `open-new` navigation is gated on prompt admission

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `client/src/lib/manager-composer.ts:57-62`
- **Status:** open

Step 8 specifies: prompt the opened session, then navigate, preserving the draft on rejection. The implementation navigates (`ports.switchToSession`) only when the prompt is admitted (`if (sent)`). On a transient prompt rejection after a successful open, the created session is orphaned and a retry of the preserved draft runs `open-new` again, creating a duplicate session. The plan's order makes the retry continue the just-opened session instead. The orchestration is unpinned by tests: `manager-composer.test.ts` covers only the pure decision, so nothing caught the drift.

### 3. `pimote_create_persona` never broadcasts `folders_changed`

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/manager/extension.ts:501-505` (also `server/src/manager/types.ts:64-71`, `server/src/repo-index.ts:568-571`)
- **Status:** open

`RepoIndex.invalidateListing()` only clears the listing cache. It notifies nobody. `folders_changed` reaches clients via `folderRegistry.onChange` and `repoIndex.setOnRefreshed` (`server/src/server.ts:216-225`), and the post-invalidate cold re-walk never calls `notifyRefreshed`, so the event never fires. Failure scenario: the manager creates a persona, the tool succeeds, and every connected dashboard keeps its old folder list until reload. Compare `create_folder` (`server/src/ws-handler.ts:376-382`), which pairs `invalidateListing()` with `WsHandler.broadcastFoldersChanged`. The comments at `extension.ts:471` and `extension.ts:504` promise behavior the code does not deliver. The same "publish a new folder" business operation now lives in two places and has already drifted.

### 4. HomeToolbar's manager draft is not bound to the shared draft

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/Dashboard.svelte:27, 73-79, 270`; `client/src/lib/components/HomeToolbar.svelte:20-35`
- **Status:** open

`Dashboard.svelte:270` passes `bind:managerOpen` and `onSubmitManager` but no `bind:managerDraft`, so the toolbar's `$bindable('')` draft is local state. A successful submit clears Dashboard's `managerDraft`, which binds only to the ManagerChat composer. The toolbar text never clears, violating the comments at `Dashboard.svelte:27` and `HomeToolbar.svelte:32-33`. In desktop split view both composers show different text. On the happy open-new path the stale text is masked because navigation unmounts the dashboard; the bug shows on any submit that does not navigate and as draft divergence while composing. Note `session_opened` navigation also defeats the "rejected submit keeps the shared draft" path. `ManagerChat.test.ts:40-44` asserts only that both files contain `bind:value={managerDraft}` and passes vacuously.

### 5. No in-flight guard on manager submit

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/HomeToolbar.svelte:74-78`, `client/src/lib/components/ManagerChat.svelte:50-58`, `client/src/lib/components/Dashboard.svelte:64-80`
- **Status:** open

`submitManagerDraft` awaits two WS round-trips before clearing the draft. Both composers fire it fire-and-forget from Enter keydown and Send, with no busy state. A second Enter (or keydown repeat) within the window duplicates the work: both submits see no viewed session and create two persisted manager sessions with the same message; if the second lands after `session_opened` sets the viewed id, it double-prompts the same session. The old `managerStore.sendDraft` cleared the draft synchronously before awaiting, which made the second Enter a no-op. This is a regression introduced by clear-on-completion. Manager prompts start agent runs and spawn persisted sessions, so accidental duplicates are user-visible and costly.

### 6. `managerComposerAction`'s continue branch is unreachable as a feature

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/manager-composer.ts:10-13, 44-64`
- **Status:** open

The manager area exists only on the Dashboard route, where `sessionRegistry.viewed` is always `null`. The conversation lives at `/sessions/<id>`, which unmounts the dashboard. The `continue` branch fires only inside the `switchTo()`-to-route-commit window, i.e. exactly as finding 5's failure mode, never as the documented UX. The behavioral claims in `submitManagerMessage`'s docstring have no test coverage.

### 7. Manager identity and placeholder rules duplicated with divergent semantics

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/Dashboard.svelte:73-74` vs `server/src/manager/attachment.ts:24-27`; `client/src/lib/manager-composer.ts:17-19`
- **Status:** open

"Is this session the manager?" is answered twice, differently. The server attaches the manager toolset on canonical identity (`realpath(cwd) === realpath(managerRoot)`); the client decides by lexical `viewed.folderPath === managerRoot`. A manager session opened through a symlink alias carries manager tools server-side but is treated as a code session client-side, so submit opens a second manager session instead of continuing. The `pending-` placeholder-id rule is likewise spelled out in both `Dashboard.svelte:73` and `manager-composer.ts`'s `isPlaceholderSessionId`. These rules belong in one place.

### 8. `PersonaInfoSchema` requires `persona.name` after the migration made it optional

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/manager/extension.ts:53-57, 63-67` vs `shared/src/protocol.ts:61`, `server/src/folder-model/marker.ts:30-35`
- **Status:** open

The `kind: persona` migration types `persona.name` as optional and `parsePersonaFrontMatter` returns `{}` for a nameless marker. The manager tool's `PersonaInfoSchema` still declares `name: Type.String()` required, so structured output for a nameless persona folder violates its own `outputSchema`. The SDK passes `structuredContent` through unvalidated, so this is a lying contract, not a runtime failure.

### 9. `ManagerResources.svelte` is orphaned dead code

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/components/ManagerResources.svelte:1-30` (plus `ManagerResources.test.ts`)
- **Status:** open

Step 9 removed `ManagerResources` from `ManagerChat` while ordinary session surfaces own artifacts via `Panel.svelte`/`CardList.svelte` and `StatusBar.svelte`/`DownloadInbox.svelte`. No non-test file imports it now. The diff even edits the component (removing the 24-hour copy) while orphaning it. Component and test form an island that exercises dead code. The implementation follows the plan's letter ("remove obsolete copy", "do not delete unrelated resource tests"), so this is a plan-level leftover. Route it to the cleanup phase.

### 10. Attachment rule's "exclusivity by construction" claim is unenforced

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/manager/attachment.ts:14-24`, `server/src/config.ts:109-111`
- **Status:** open

The comment asserts that `managerRoot` is never a scan root, so no folder-list session can satisfy the rule. Nothing enforces this. Config validation does no disjointness checks, so `roots: ['~']` with the default `managerRoot: '~'` puts the manager root in discovery, and any session opened at that folder row loads the manager toolset. The invariant is load-bearing but held by convention.

### 11. Folderless session resolution duplicated across server modules

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/ws-handler.ts:1599-1608`, `server/src/index.ts:164-172, 397-407`
- **Status:** open

`findSessionRecord` and `resolveSessionAcrossFolders` implement the same business operation: resolve a session id across known folders plus the manager root. This diff edited both in lockstep; the comment at `index.ts:164` admits the mirroring. The next folder-scope change will fix one path and miss the other. One resolver should own the operation.

## Clean Checks

- **Test immutability: clean.** All seven listed test files are byte-identical between `73dcbd5` and HEAD. Listed interface files were extended per their steps only. Deletions of `manager-store.svelte.test.ts`, `service.test.ts`, and `resources.test.ts` trace to steps 6 and 9. No Red Gate assertion was weakened. The 7 Red Gate suites pass (59 tests); server (945) and client (781) suites are green; `npm run build:shared` and `npm run check` pass.
- **Reverse check (unplanned work): clean.** Every hunk traces to a plan step or the declared `kind: persona` marker migration (in-scope per the owner ruling).
- **Plan adherence:** all ten steps done with correct intent. Findings 2 and 9 are the only deviations.
- **Design doctrine (plan pass): clean** at the seams the plan specified. Findings 3, 6, 7, and 11 are doctrine findings from the correctness pass (duplicated business operations, dead branch).
- Both passes were run; neither was skipped.
