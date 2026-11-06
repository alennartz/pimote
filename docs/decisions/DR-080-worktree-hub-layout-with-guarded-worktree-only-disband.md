# DR-080: Worktree hubs — detached code members with guarded worktree-only disband

## Status

Accepted

## Context

DR-063 removed hub disband from every surface because disband read as "dissolve the grouping" while it deleted a working folder — committed hub code, a persona's prompt and memory. DR-064 made the symlink inventory the membership truth. Both decisions assumed hub members are symlinks: cheap to unlink, with every real file living in the member's canonical home.

Feature work broke that assumption. A team of sessions needs a disposable workspace holding real checkouts of several repos at once. Symlink hubs cannot provide it: every session works in the canonical home, so the hub is a view, not a workspace. Nested detached worktrees can — but a worktree hub accumulates disposable checkouts whose only cleanup is `git worktree remove` plus directory deletion, one manual Git incantation per member, repeated per hub. With no disband, the cleanup burden falls entirely on users and agents, and agents are the consumers most likely to create such workspaces.

> Supersedes DR-063 (Hub disband removed from every surface), deleted at commit `bd54d26122f10d7f537d52a50c0e3ff9d3494e32`.
>
> Supersedes DR-064 (Hub shape is membership truth; registry stores curation only), deleted at commit `bd54d26122f10d7f537d52a50c0e3ff9d3494e32`.

## Decision

**Per-hub member representation; symlinks stay the default.** `create_hub` and `pimote_create_folder` accept `memberRepresentation: 'symlink' | 'worktree'`. Symlink hubs are unchanged. Worktree mode materializes code members as nested detached worktrees — `git worktree add --detach <hub-child> HEAD` from the member's current `HEAD` — and always symlinks persona members. Creation carries no branch name, no default-branch probe, and no warning: the checkout starts detached at source `HEAD`, and all branch lifecycle work belongs to the user or agent. We rejected naming or branching server-side because pimote would then own branch policy it cannot reason about, and we rejected the pi extension's shared `.git-worktrees` directory because hub members must sit at the hub's top level to be discovered as members. A failed creation removes the worktrees it already made before removing the fresh hub directory.

**Membership stays shape truth, extended to worktrees.** The registry probe recognizes a nested worktree only when the child carries a `.git` file and `git worktree list --porcelain` confirms the exact checkout; ordinary directories and independent repositories are not members. A `.pimote-hub.json` containing exactly `{"memberRepresentation":"worktree"}` preserves worktree mode after the last code worktree is removed. We rejected recording member lists in the marker: the shape remains the membership truth, so the marker carries mode only. DR-064's core decision stands unchanged — the registry still stores curation only, and on-disk shape plus source promises define hubs. What is superseded is the "symlink inventory" clause: membership is now symlinks plus Git-verified nested worktrees. Canonical member identity also survives: a worktree member's identity is its source checkout, with the nested checkout carried separately as `worktreePath`, so sessions, tags, and curation keep resolving to the canonical home.

**Disband returns, worktree-only and guarded.** DR-063's rejection remains sound for symlink hubs: unlinking symlinks is cheap, the hub's own content (committed code, persona prompt and memory) is the only thing at risk, and deletion stays a file-level action. A worktree hub changes the calculus: its nested checkouts are disposable by design, Git owns their cleanup, and the hub directory itself carries only generated files. Disband accepts a worktree hub identified by the marker or a valid nested worktree; symlink hubs reject. Before any mutation it checks the hub subtree for live sessions and external pi processes (failing closed when an activity source fails), then validates every worktree: clean `git status --porcelain`, and a detached `HEAD` reachable from a local or remote-tracking branch ref. Only after all checks pass does it remove worktrees through Git and delete the hub. It never merges, commits, stashes, fetches, or performs branch operations. We rejected forcing a branch name at disband: the guard verifies nothing is lost, and what to name the surviving branch is the user's decision, made before disband, not during it. We rejected keeping disband for symlink hubs: DR-063's blast-radius argument loses nothing with worktree hubs excluded.

The dashboard and the manager share the operation through the same registry seam: a `disband_hub` wire command behind a client confirmation, and the restored ninth manager tool `pimote_disband_hub` (DR-062's capability symmetry, amended).

## Consequences

- Every membership surface is representation-aware. Row facts, membership edits, and status enrichment must distinguish the canonical source from the nested checkout; `shortcutCount` counts symlinks only.
- Worktree members start detached. An agent that commits without creating a branch produces work the disband guard rejects; the error names the checkout and the fix. This is deliberate friction, not a bug.
- The reachability check is conservative: commits pushed to a remote but not yet fetched still block disband until a fetch brings the remote-tracking ref forward. No fetch happens during disband.
- A removal failure mid-disband leaves the hub and its remaining shape discoverable, so a retry sees only what is left.
- The manager surface grows to nine tools, restoring full capability symmetry with the dashboard's folder mutations.
- Two hub layouts must stay documented and probed; symlink coverage and worktree coverage both need smoke exercise.
