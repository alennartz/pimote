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
