# Plan: Hub Member Representation

## Context

Add a per-hub choice between the existing symlink layout and nested detached Git worktrees for code members. Persona members always remain symlinks. Worktree hubs are disposable feature workspaces with guarded worktree-only disband; users or agents own branch creation and remote PR work. See [the brainstorm](../brainstorms/hub-member-representation.md).

## Architecture

### Impacted Modules

- **Protocol (`shared/src/protocol.ts`).** Add the hub representation vocabulary, the hub summary on `FolderInfo`, representation and nested-checkout fields on `FolderMemberInfo`, an optional worktree checkout path on `RepoInfo`, the creation representation field, and the `disband_hub` command and response. Existing Android folder decoding remains safe because these are additive fields and Android does not consume hub-management commands.
- **Server folder registry (`server/src/folder-registry.ts`, `server/src/manager/types.ts`).** Keep curation in the registry, but replace the symlink-only hub probe with a combined member probe. Derive symlink members from the existing inventory and worktree members from valid nested Git worktrees. Route creation, add, remove, and disband through one serialized mutation seam. Add the activity guard needed to reject deletion while live sessions or external pi processes use the hub subtree.
- **Server hub materialization (`server/src/folder-sources/materialize.ts`, `server/src/hub-agents-md.ts`).** Keep the existing symlink renderer as the default. Add the worktree layout: code members become nested detached worktrees, persona members remain symlinks, member names and the marker are ignored by the hub repository, and generated instructions describe the selected layout. Preserve exact-string managed member-line behavior.
- **Server Git status and folder views (`server/src/repo-index.ts`, folder view assembly).** Keep the generic folder model and repo index independent of Git worktree membership. Worktree hubs enrich their `repos` facts from the nested checkout while retaining the canonical source path and exposing the checkout path separately.
- **Web client (`client/src/lib/components/FolderCreatorWizard.svelte`, `MemberPicker.svelte`, `HubMembersDialog.svelte`, `FolderList.svelte`, `FolderNatureIcon.svelte`, folder store).** Add a compact representation choice inside the existing Members phase, show each member's representation and checkout path where relevant, identify hubs from the new hub fact rather than shortcut count alone, and add the guarded worktree-only disband menu item and confirmation dialog.
- **Manager surface (`server/src/manager/extension.ts`).** Add the optional creation representation, update member descriptions to cover both shapes, and restore a guarded `pimote_disband_hub` twin for worktree hubs. The tool uses the same registry seam as the dashboard and returns actionable validation errors.
- **SDK and shipped documentation (`packages/sdk/src/folders/types.ts`, `server/src/sdk-twins.ts`, `docs/shipped/folders.md`, `docs/shipped/recipes.md`, `docs/shipped/manager.md`, codemap).** Keep SDK `RepoInfo` parity for the optional checkout path, document both hub recipes and the detached-worktree lifecycle, and update the living module map after implementation.
- **Development tooling (`tools/manual-test/**`).\*\* Extend the existing folder and hub smoke coverage with detached creation, representation-aware membership edits, detached commit reachability, and guarded worktree disband. The flow must exercise the same dashboard and manager mutation seams, not a separate fixture-only path.

### New Modules

- **Hub worktree Git adapter and shape probe (`server/src/hub-worktrees.ts`, approximate).** A deep server module that owns the Git CLI seam for detached worktree creation, nested-worktree recognition, status/reachability validation, and removal. It accepts a guarded `execFile` adapter in tests and uses the repository's existing environment protections and command timeouts. It never creates, names, attaches, merges, deletes, or fetches branches.
- **Hub mode marker seam (within the hub layout module).** Reads and writes `.pimote-hub.json` containing only `{ "memberRepresentation": "worktree" }` for worktree hubs. It has no version, branch, or member list. Membership remains shape-derived; the marker preserves the worktree choice after the last code worktree is removed. A valid nested worktree also proves worktree representation when the marker is absent.

### Interfaces

#### Hub representation and folder rows

```ts
type HubMemberRepresentation = 'symlink' | 'worktree';

interface HubInfo {
  representation: HubMemberRepresentation;
}

interface FolderMemberInfo {
  /** Canonical source/member identity used by add/remove commands. */
  path: string;
  /** Basename inside the hub. */
  name: string;
  nature: 'code' | 'persona';
  representation: HubMemberRepresentation;
  /** Present for code worktree members; the checkout inside the hub. */
  worktreePath?: string;
}
```

`FolderInfo.hub` is present for every discovered or promised hub, including a worktree hub with only persona symlinks. `FolderInfo.members` contains both symlink and worktree members. `shortcutCount` remains the count of symlink shortcuts and no longer determines whether a row is a hub. For a worktree member, `FolderMemberInfo.path` is the canonical source checkout identified from Git's worktree set, while `worktreePath` is the active nested checkout.

`RepoInfo` keeps its canonical `path` and adds optional `worktreePath`. For worktree hub rows, branch, dirty, ahead, and behind facts describe the nested checkout; tags and membership identity continue to resolve from the canonical source path. Symlink rows omit `worktreePath` and retain current behavior.

#### Worktree shape and Git operations

The worktree adapter exposes a small interface to the registry:

```ts
interface HubWorktreePort {
  inspectMember(path: string): Promise<WorktreeMemberFacts | null>;
  createDetached(input: { sourcePath: string; worktreePath: string }): Promise<void>;
  validateRemoval(input: { sourcePath: string; worktreePath: string }): Promise<WorktreeRemovalCheck>;
  remove(input: { sourcePath: string; worktreePath: string }): Promise<void>;
}

interface WorktreeMemberFacts {
  sourcePath: string;
  worktreePath: string;
  branch: string | null;
  dirty: boolean;
  detached: boolean;
  headReachableFromBranchRef: boolean;
}

interface WorktreeRemovalCheck {
  dirty: boolean;
  detached: boolean;
  headReachableFromBranchRef: boolean;
}
```

`inspectMember` accepts only a top-level hub child. It recognizes a worktree when the child has a `.git` file and `git worktree list --porcelain` confirms the exact checkout. It rejects ordinary nested directories, independent repositories with `.git` directories, and paths that Git cannot verify. The probe derives the source repository from the Git worktree set and returns status for the nested checkout.

`createDetached` runs `git worktree add --detach <hub-child> HEAD` from the canonical code member. It does not inspect or modify the member's branch, stash changes, move changes, or use the pi extension's shared `.git-worktrees` directory. `validateRemoval` for ordinary member removal requires an empty `git status --porcelain`. Disband adds the stronger detached-`HEAD` reachability check: `HEAD` must be reachable from a local `refs/heads/*` or remote-tracking `refs/remotes/*` ref. Neither path fetches or performs branch operations.

#### Registry mutation seam

`FolderRegistryPort` gains the following contracts:

```ts
createHub(input: {
  name: string;
  root: string;
  memberPaths: string[];
  memberRepresentation?: HubMemberRepresentation; // default: 'symlink'
  body?: string;
  description?: string;
  personaText?: string;
}): Promise<{ path: string }>;

disbandHub(hubPath: string): Promise<{ removedWorktreePaths: string[] }>;
```

`createHub` validates discovered members and basename/containment invariants before creating anything. Symlink mode follows the current all-or-nothing materialization. Worktree mode writes the marker, creates detached code worktrees at `hub/<basename>`, symlinks persona members, writes the generated files, and initializes the hub repository. Any failure removes created worktrees through Git before removing the fresh hub directory.

`addMember` follows the hub representation: persona members always symlink; code members use detached worktrees for a marked or detected worktree hub and symlinks otherwise. If Git creates a worktree and a later `AGENTS.md` or `.gitignore` update fails, the registry removes that worktree before reporting the failure. If rollback itself fails, the remaining worktree shape stays discoverable and the error names it for retry. `removeMember` identifies the member by canonical source path, requires only the clean-state guard for a worktree, removes the nested checkout or symlink, and preserves user-created branches and user prose. Exact managed-line cleanup is best effort after the shape mutation; a write failure may leave stale managed text but never removes the member before its preconditions pass.

`disbandHub` accepts only a worktree hub identified by the marker or a valid nested worktree member. Before mutation it checks the hub subtree for active Pimote sessions and external pi processes, then validates every worktree's clean state and detached-`HEAD` reachability. After all checks pass it removes worktrees through Git, deletes the hub directory, and emits one registry change with the hub path in `removedPaths`. It does not merge, commit, stash, delete branches, or follow member symlinks. A failure during removal leaves the hub and remaining shape discoverable for a retry.

The registry receives a narrow activity port rather than importing the session manager:

```ts
interface HubActivityPort {
  findBusyPaths(paths: ReadonlyArray<string>): Promise<ReadonlyArray<string>>;
}
```

The server adapter checks live session working directories and external pi working directories against each requested path and its descendants. It fails closed when an activity source fails. `HubActivity` implements the port over injected `sessionWorkingDirectories` and `externalPiWorkingDirectories` sources. Production sources enumerate live session and external pi working directories, preserving the existing external-process exclusions. The current exact-directory process probe must also support this subtree check.

#### Wire and manager contracts

`CreateHubCommand` and `pimote_create_folder` carry the optional `memberRepresentation` field. Omission means symlink mode. No branch name, branch source, default-branch probe, or warning is part of the contract. Worktree creation always uses the source repository's current `HEAD` and leaves all branch lifecycle work to the user or agent.

`DisbandHubCommand` carries only `hubPath` and returns `DisbandHubResponseData` with `removedWorktreePaths`. The client asks for confirmation before sending it; server validation remains authoritative. The manager twin `pimote_disband_hub` accepts a canonical `hubPath` and returns the same removal summary or a structured error. `add_hub_member`, `remove_hub_member`, and `pimote_update_hub_members` keep their current path-based inputs and report the registry's clean-state errors; disband additionally reports detached-`HEAD` reachability failures.

#### Client interaction contract

The approved interaction is captured in the mock below. The existing folder creation wizard keeps its four-kind row and three phases. The Members phase adds a compact two-button choice: `Symlinks` (default) or `Detached worktrees`. The helper text states that only code members use worktrees and personas always use symlinks. The Vision or Persona phase remains unchanged, and Create still opens a session in the new hub.

Folder rows use the existing context menu. Worktree hubs add `Disband worktree hub…`; symlink hubs do not. The confirmation dialog states that the action removes nested worktrees and the hub without merging or deleting branches. Validation errors list the blocking worktree state and keep the dialog open. The existing member dialog lists representation and nested checkout path while preserving its search picker and per-member remove buttons.

### Interaction Mocks

- `docs/mocks/hub-member-representation/index.html` — approved creation, member-management, and guarded worktree-disband interactions grounded in the existing dashboard components.

### DR Supersessions

- **DR-062** (Small-but-powerful manager toolset with freshness flags and a materialized skill) — superseded only where it permanently retires hub disband. New decision: restore a manager disband tool for worktree hubs so the manager and dashboard share the guarded lifecycle operation.
- **DR-063** (Hub disband removed from every surface) — superseded because ephemeral detached worktree hubs need an explicit cleanup operation. New decision: disband is worktree-only, validates activity, clean state, and detached-`HEAD` reachability, then removes worktrees and the hub without branch operations.
- **DR-064** (Hub shape is membership truth; registry stores curation only) — superseded because nested worktrees are real directories rather than symlink shortcuts. New decision: membership remains on-disk shape truth, with symlink members plus Git-verified nested worktree members; a minimal mode marker preserves worktree representation after the last worktree disappears, while the registry still stores curation only.

## Tests

**Pre-test-write commit:** `82ca4d80b95f26835d4fe06cd3f0db816b0b0bdd`

### Interface Files

- `shared/src/protocol.ts` — `HubMemberRepresentation`, `HubInfo`, `representation`/`worktreePath` on `FolderMemberInfo`, `hub` on `FolderInfo`, `worktreePath` on `RepoInfo`, `memberRepresentation` on `CreateHubCommand`, `DisbandHubCommand`, `DisbandHubResponseData`, and the `disband_hub` entry in the `PimoteCommand` union
- `packages/sdk/src/folders/types.ts` — `worktreePath` on the SDK `RepoInfo` twin (key-set parity kept for `sdk-twins.ts`)
- `server/src/manager/types.ts` — `memberRepresentation` on `FolderRegistryPort.createHub`, `disbandHub` on `FolderRegistryPort`, and the `HubActivityPort` activity seam
- `server/src/hub-worktrees.ts` — `WorktreeGitRunner`, `WorktreeMemberFacts`, `WorktreeRemovalCheck`, `HubWorktreePort`, and the `HubWorktrees` adapter with `not implemented` stubs
- `server/src/hub-activity.ts` — `HubActivitySources` and the `HubActivity` adapter with a `not implemented` stub
- `server/src/folder-registry.ts` — worktree/activity ports as optional constructor seams, the `memberRepresentation` input, the `disbandHub` stub, and `representation` on merged member rows

### Test Files

- `server/src/hub-worktrees.test.ts` — Git-adapter behaviors over deterministic git fixtures: nested-worktree recognition and its rejects, detached creation, removal preconditions, and removal without touching the source
- `server/src/folder-registry-worktree.test.ts` — registry worktree-mode creation, row facts, rollback, worktree-aware membership edits, and the guarded disband lifecycle
- `server/src/hub-activity.test.ts` — activity checks for live sessions and external pi processes in a hub subtree
- `server/src/ws-folder-commands.test.ts`, `server/src/ws-handler.test.ts` — dashboard command routing for worktree creation and disband
- `server/src/manager/extension.test.ts`, `server/src/index.test.ts` — manager creation, disband tool, and server port wiring
- `client/src/lib/components/FolderCreatorWizard.representation.test.ts` — the Members-phase layout choice, its helper text, and the `memberRepresentation` wire field on create
- `client/src/lib/components/FolderList.disband.test.ts` — the worktree-only disband menu item, hub identification from the hub fact, the confirmation dialog, and the failed-validation flow
- `client/src/lib/components/HubMembersDialog.representation.test.ts` — per-member representation display, the nested checkout path, and the picker's representation hint

### Behaviors Covered

#### HubWorktrees (Git adapter)

- `inspectMember` recognizes a nested detached worktree and reports source path, checkout path, branch, dirty state, detached flag, and detached-`HEAD` reachability
- `inspectMember` returns null for an ordinary nested directory, an independent repository with a `.git` directory, and a path Git cannot verify
- `createDetached` creates a detached worktree at the hub child from the source `HEAD` and rejects when the target already exists
- `validateRemoval` reports clean reachable state, dirty state on uncommitted changes, and unreachable `HEAD` for a detached-`HEAD` commit
- `remove` deletes the nested worktree through Git, leaves the source repository and its `HEAD` intact, and preserves user-created branches
- The checkout starts detached at source `HEAD`; staged, unstaged, and untracked states are dirty, and detached commits reachable from local or remote-tracking branch refs pass reachability

#### FolderRegistry — worktree mode

- `createHub` with `memberRepresentation: 'worktree'` writes the `.pimote-hub.json` marker, materializes code members as nested detached worktrees, and symlinks persona members
- The merged row reports the `hub` representation fact, per-member `representation` and `worktreePath`, and `worktreePath` on code member `repos`
- Symlink-mode rows report the `hub` fact with `symlink` representation
- A failed worktree creation rolls back every created worktree through the Git adapter and removes the fresh hub directory
- `addMember` on a worktree hub materializes a code member as a detached worktree with its checkout path on the row
- `removeMember` removes a worktree member's nested checkout, preserves the canonical source repository and its branch, and drops the member from the row
- Creation leaves dirty source files unchanged, defaults to symlinks, and ignores hub member names and the marker
- Worktree repo facts describe the nested checkout while retaining the canonical source identity
- Adding a persona creates a symlink; a later file-update failure rolls back a newly created worktree through Git
- Removing a dirty member rejects without deleting its checkout; after the last code member is removed, the marker preserves worktree mode for later additions

#### FolderRegistry — guarded disband

- `disbandHub` removes every nested worktree and the hub directory and returns the removed checkout paths
- `disbandHub` accepts a worktree hub identified by the marker or by a valid nested worktree when the marker is absent
- `disbandHub` rejects a symlink hub without a marker or nested worktree and keeps the hub on disk
- `disbandHub` rejects a worktree with uncommitted changes and a detached `HEAD` unreachable from a local or remote-tracking ref, keeping the hub
- `disbandHub` checks the hub subtree through `HubActivityPort` before validating worktree state and rejects busy paths, keeping the hub
- Every worktree is validated before removal; a partial removal failure leaves remaining members discoverable for retry
- A successful disband emits a registry change with the removed hub path
- `HubActivity` reports paths containing live session or external pi working directories, excludes siblings, and fails closed if a source fails
- WebSocket and manager creation forward representation; disband returns the removal summary and surfaces registry guard errors

#### FolderCreatorWizard

- The hub Members phase offers Symlinks and Detached worktrees and states that personas always use symlinks
- Choosing Detached worktrees sends `create_hub` with `memberRepresentation: 'worktree'`; the default creates symlinks
- A successful create opens a session in the returned hub folder

#### FolderList

- Worktree hub rows offer "Disband worktree hub…" in the context menu; symlink hubs do not
- A row with the hub fact and no members or shortcut occurrences is identified as a hub
- The disband action asks for confirmation stating nested worktrees are removed without merging or deleting branches
- Confirmation sends `disband_hub` with the canonical hub path
- A failed disband keeps the dialog open and lists the blocking worktree state; cancellation sends no disband command

#### HubMembersDialog

- Member rows list each member's representation and, for worktree members, the nested checkout path
- Persona symlink members are distinguishable from code worktree members
- The add-member picker states the representation a new code member will use in a worktree hub
- The picker and remove buttons send the canonical member path

**Review status:** approved

## Steps

**Pre-implementation commit:** `278f371fedd2ae6b22d147bcb9ecef85fd895728`

### Step 1: Implement the Git worktree adapter

Implement `HubWorktrees` in `server/src/hub-worktrees.ts` behind the existing `HubWorktreePort` and `WorktreeGitRunner` interfaces. Recognize only directories with a `.git` file that Git confirms in its worktree list. Return the canonical source checkout, nested checkout, branch, dirty state, detached state, and branch-ref reachability. Reject ordinary directories, independent repositories, and unverifiable paths.

Create detached checkouts from source `HEAD`, validate staged, unstaged, and untracked changes, and remove checkouts through Git. Check reachability against local and remote-tracking branch refs. Do not perform branch operations. Supply a production runner using `execFile`, the existing Git environment protections, and a timeout. Preserve the injected runner for tests.

**Verify:** `npm run build:shared && npm run test --workspace=@pimote/server -- --run src/hub-worktrees.test.ts` passes.
**Status:** done

### Step 2: Wire the activity guard

Implement `HubActivity.findBusyPaths` in `server/src/hub-activity.ts`. Normalize requested paths and working directories before matching each requested path against sessions and external pi processes at that path or below it. Reject when either source fails.

Extend `server/src/takeover.ts` with an external pi working-directory enumeration that supports subtree checks. Preserve the current process and descendant exclusions and exact-directory behavior for takeover. Preserve the existing per-directory exclusion behavior when enumerating multiple directories. Do not convert an enumeration failure into an empty result for disband.

In `server/src/index.ts`, construct `FolderRegistry` after `PimoteSessionManager` is available. Inject `HubActivity` with live slot folder paths and the external pi enumeration. Inject the production worktree adapter, or give the registry an equivalent production default. Keep session-manager access out of the registry.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/hub-activity.test.ts src/takeover.test.ts src/index.test.ts` passes the activity and existing takeover checks. The manager disband test passes after Step 9.
**Status:** done

### Step 3: Derive hub membership from disk shape

Replace the symlink-only inventory in `server/src/folder-registry.ts` with a combined top-level member probe. Retain `readHubLinks` rules for live and dangling symlinks, canonical identity, nature, containment, and managed-line provenance. Probe real child directories through `HubWorktreePort.inspectMember`; do not treat independent nested repositories as members.

Add the marker read/write seam to `server/src/folder-sources/materialize.ts` for `.pimote-hub.json` containing only `{ "memberRepresentation": "worktree" }`. A valid marker or nested worktree selects worktree mode, including after the last worktree is removed. Source-promised and symlink-shaped hubs select symlink mode otherwise.

Update `FolderViewInputs`, `mergedFolders`, `viewOver`, `update`, and `isManageableHub` in `server/src/folder-registry.ts` to use the combined inventory. Emit `FolderInfo.hub` for discovered and promised hubs, and emit each member's canonical `path`, nature, representation, and optional `worktreePath`. Keep `shortcutCount` as the symlink count. Preserve source promises, canonical source tags, missing-member behavior, and tag-change fan-out.

**Verify:** The row, marker, symlink, and worktree discovery cases in `server/src/folder-registry-worktree.test.ts` pass once creation is implemented in Step 4. Existing `server/src/folder-registry.test.ts` membership and curation cases remain passing.
**Status:** done

### Step 4: Materialize both hub layouts

Extend `materializeHubFolder` in `server/src/folder-sources/materialize.ts` and `FolderRegistry.createHub` in `server/src/folder-registry.ts` to choose the layout from `memberRepresentation`, defaulting to symlinks. Keep source-listed hub materialization on the existing symlink path. For worktree mode, write the marker, create detached code worktrees, symlink personas, ignore the marker and all member basenames, write the generated files, and initialize the hub repository.

Validate discovered members, reserved names, duplicate basenames, and containment before creating the target. If creation fails, remove every created worktree through Git before removing the fresh hub directory. Include persona `memory.md` in the same rollback scope. Update `hubAgentsMarkdown` in `server/src/hub-agents-md.ts` to describe the selected layout while retaining its exact seeded member lines and managed block.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/folder-registry-worktree.test.ts src/folder-registry.test.ts src/hub-agents-md.test.ts` passes the creation, default layout, source preservation, ignore, rollback, and existing managed-line cases.
**Status:** done

### Step 5: Make member edits representation-aware

Update `FolderRegistry.addMember` and `removeMember` in `server/src/folder-registry.ts` to use the combined inventory and canonical source identities. Add code as a detached worktree in a worktree hub and as a symlink otherwise. Always add personas as symlinks. Keep the existing serialized mutation seam and basename, containment, and discovered-member checks.

If an add fails after creating a worktree, remove it through Git. If rollback fails, report the remaining checkout path so it stays discoverable for retry. Before removing a worktree member, reject dirty state without changing disk. Remove clean worktrees through Git and symlinks by unlinking only the hub-side link. Preserve branches and user prose. Treat exact managed-line and ignore-line cleanup after removal as best effort.

**Verify:** The add, rollback, dirty removal, persona symlink, canonical identity, and last-worktree marker cases in `server/src/folder-registry-worktree.test.ts` pass. Existing membership tests in `server/src/folder-registry.test.ts` pass.
**Status:** done

### Step 6: Implement guarded disband

Implement `FolderRegistry.disbandHub` in `server/src/folder-registry.ts` through the same serialized mutation seam. Accept only a marked or Git-verified worktree hub. Check activity for the hub and its worktree paths before validating any worktree. Validate every checkout before removing any: reject dirty checkouts and detached `HEAD` commits unreachable from local or remote-tracking branch refs.

After all checks pass, remove worktrees through Git and delete the hub without following member symlinks. Preserve branches. Return `removedWorktreePaths`, invalidate discovery, and emit one change with the hub in `removedPaths`. If removal fails, leave the hub and remaining worktrees discoverable for retry.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/folder-registry-worktree.test.ts src/hub-activity.test.ts` passes all guarded disband, partial-failure, retry, and notification cases.
**Status:** done

### Step 7: Enrich rows from nested checkout status

Update `server/src/repo-index.ts` to support bounded, cached Git-status probes for requested checkout paths even when discovery did not list those paths. Keep this capability independent of hub membership. Preserve the existing TTL and stale-while-revalidate behavior for ordinary repos.

Update `FolderRegistry.requestStatusRefresh` and `enrichRows` in `server/src/folder-registry.ts` to probe `repo.worktreePath ?? repo.path`. Apply branch, dirty, ahead, and behind from the checkout while keeping `RepoInfo.path` and tags tied to the canonical source. Route asynchronous checkout status changes to the owning hub row without making the repo index own hub membership.

**Verify:** The checkout-status and canonical-identity cases in `server/src/folder-registry-worktree.test.ts` pass. Run `npm run test --workspace=@pimote/server -- --run src/repo-index.test.ts src/folder-registry-worktree.test.ts src/folder-listing.test.ts` and confirm existing windowed status behavior remains passing.
**Status:** done

### Step 8: Route dashboard commands

In `server/src/ws-handler.ts`, forward `CreateHubCommand.memberRepresentation` to `FolderRegistry.createHub` when supplied. Add `disband_hub` routing to `FolderRegistry.disbandHub`, returning its removal summary and preserving user-presentable guard errors. Keep registry notifications authoritative.

The protocol interfaces already exist in `shared/src/protocol.ts` and the SDK `RepoInfo.worktreePath` twin already exists in `packages/sdk/src/folders/types.ts`. Verify their response and union wiring and keep `server/src/sdk-twins.ts` parity intact.

**Verify:** `npm run build:shared && npm run build --workspace=@pimote/sdk && npm run test --workspace=@pimote/server -- --run src/ws-folder-commands.test.ts src/ws-handler.test.ts` passes. `npm run check` verifies SDK twin parity.
**Status:** done

### Step 9: Restore the manager twin

Update `RepoInfoSchema`, `FolderMemberInfoSchema`, and `FolderInfoSchema` in `server/src/manager/extension.ts` for hub facts, member representations, and checkout paths. Make `pimote_find_folders` filter by the hub fact rather than shortcut count alone. Update its descriptions, membership descriptions, and `NESTING_HINT` to cover symlinks and worktrees.

Add the optional `memberRepresentation` schema to `pimote_create_folder` and forward it for both hub kinds. Register `pimote_disband_hub` with canonical `hubPath`, an output schema for `removedWorktreePaths`, and structured guard errors. Keep `pimote_update_hub_members` path-based and route all mutations through the existing registry port.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/manager/extension.test.ts src/index.test.ts` passes the schema, hub filter, create, disband, and server wiring cases.
**Status:** done

### Step 10: Add dashboard representation controls

In `client/src/lib/components/FolderCreatorWizard.svelte`, add the approved compact `Symlinks` and `Detached worktrees` choice to the Members phase. Default and reset to symlinks, explain that personas remain symlinks, and show the selected code-member worktree count, including selections from search results. Pass the selected representation through `creationCommand` for both hub kinds. Keep the four-kind row, identity and Vision or Persona phases, and successful session opening unchanged.

In `HubMembersDialog.svelte` and `MemberPicker.svelte`, show each member's representation and nested checkout path when present. Show the layout a new code member will use. Keep the existing shortcut description for symlink hubs and use worktree-specific wording for worktree hubs. Retain asynchronous search and canonical-path add and remove actions.

In `FolderNatureIcon.svelte` and `FolderList.svelte`, identify hubs from `FolderInfo.hub`, including rows with no members or shortcuts. Preserve the existing shortcut and member signals where present. Add `Disband worktree hub…` only for worktree hubs. The confirmation must explain checkout and hub removal, branch preservation, clean-state requirements, and detached-`HEAD` reachability. Cancel sends nothing. Keep the dialog open with the server's blocking state on failure.

Add the command wrapper to `client/src/lib/stores/folder-store.svelte.ts`. When an authoritative folder row omits a prior hub fact, clear that fact from the existing canonical object so a stale disband action cannot survive a shape change. Let `removedPaths` remove rows after successful disband.

**Verify:** `npm run test --workspace=client -- --run src/lib/components/FolderCreatorWizard.representation.test.ts src/lib/components/FolderList.disband.test.ts src/lib/components/HubMembersDialog.representation.test.ts` and `npm run check --workspace=client` pass. Compare creation, member management, cancellation, failure, and success states with `docs/mocks/hub-member-representation/index.html`.
**Status:** done

### Step 11: Update shipped guidance and smoke coverage

Update `docs/shipped/folders.md`, `docs/shipped/recipes.md`, and `docs/shipped/manager.md` for both hub layouts, canonical member identity, detached checkout lifecycle, clean and reachability guards, and worktree-only disband. Update `codemap.md` for the new modules and flows. Update the hub and member definitions in `glossary.md` to include verified worktrees without changing the domain terms. Follow the decision-records skill to record the architecture's decisions: partially supersede DR-062 and supersede DR-063 and DR-064, preserving the remaining decisions.

Extend `tools/manual-test/project-management-smoke/project-management-smoke.mjs` and `tools/manual-test/manager-tools-smoke/manager-tools-smoke.mjs` through their real dashboard, wire, and manager mutation seams. Preserve symlink coverage and update the retired-disband and manager tool-count assertions. Exercise detached creation, code and persona membership edits, active-session and dirty-state rejection, unreachable detached commits, branch-ref reachability, and successful guarded disband after closing the hub session. Use an isolated fixture for destructive manager smoke flows, including when `MTMS_ROOT` is set. Update `tools/manual-test/PLAN.md` and `tools/manual-test/README.md` to match the new coverage.

**Verify:** Run `npm run build`, `npm run check`, `npm run test --workspace=@pimote/server -- --run`, and `npm run test --workspace=client -- --run`. Run `node tools/manual-test/manager-tools-smoke/manager-tools-smoke.mjs` and `node tools/manual-test/project-management-smoke/project-management-smoke.mjs` with the documented browser prerequisites. Both smoke drivers pass.
**Status:** not started
