# Hub Member Representation

## The idea

Add a creation option that controls how hub members are represented. A hub can keep the current symlink layout or create disposable Git worktrees for code members. Persona members remain symlinks in either mode.

The worktree mode supports short-lived feature hubs that span several repositories. The symlink mode supports long-lived groupings that point at canonical member folders.

## Key decisions

- **Representation is chosen per hub.** The choice is not global. Symlink mode remains the default because it is the current layout and suits long-lived groupings. This is a product default, not an old-client compatibility requirement.
- **Worktrees are nested in the hub.** Each code member gets a real checkout at `hub/<member>`. The hub does not use the pi extension's shared `.git-worktrees` directory. A self-contained layout makes the ephemeral lifecycle clear.
- **Persona members always use symlinks.** Worktree mode applies only to code members because personas are persistent folders, not Git branch checkouts.
- **Worktrees start detached.** Creation does not name, create, attach, merge, or delete branches. Each code worktree starts from its member repository's current `HEAD`, unless the user chooses the detected default-branch tip during preflight. The canonical member folders remain untouched. Users or agents create and push branches inside the worktrees when needed.
- **Branch source is chosen at creation, not persisted.** If any member is not on its detected default branch, the UI warns before creation and offers only two choices: use current `HEAD`s or use each repository's default-branch tip. If every member is already on its default branch, no question appears.
- **Creation fails closed.** A member that cannot create its detached worktree must not leave a partially created hub. Creation does not stash or move changes from canonical members.
- **Membership remains editable.** Adding a code member to a worktree hub creates a detached worktree from that member's current `HEAD`. Adding a persona creates a symlink. Removing a code member requires a clean worktree, then removes that worktree; any branch the user created remains under Git's control. Symlink hubs keep their existing membership behavior.
- **Worktree cleanup is explicit and conservative.** Disband is available only for worktree hubs. It checks every generated worktree for staged, unstaged, and untracked changes. A detached `HEAD` must be reachable from a local or remote-tracking branch ref. It refuses to proceed when either condition fails, removes valid worktrees through Git, and then removes the hub. It never auto-commits, merges, or deletes branches, and it never fetches.
- **The pi worktree extension is reference context, not a dependency.** Its branch, session, stash, merge, and shared-directory mechanisms are not part of this feature. Only the basic Git worktree lifecycle applies.

## Direction

Extend the existing hub creation flow with a symlink/worktree representation choice. Worktree hubs are detached feature workspaces: code checkouts live under the hub and can be removed after their changes are committed. Branch creation and remote PR preparation remain user or agent work. Symlink hubs remain the ordinary persistent grouping shape. The dashboard and manager creation surfaces should expose the same behavior, while later architecture work defines their exact parameter and wire shapes.

## Open questions

### Sharp questions

- How will the folder model recognize nested worktree members and report both their checkout paths and their canonical source repositories?
- How should the folder model distinguish a worktree hub from a hub containing ordinary nested directories or independently created repositories?
- What preflight and result shape gives the non-interactive manager surface the same current-HEAD versus default-tip choice as the dashboard?
- How do add, remove, and disband recover from a failure partway through Git operations without orphaning worktrees or deleting the hub prematurely?
- How should disband handle active sessions or external processes rooted in a generated worktree?

### Fog

- Whether a worktree hub needs any marker beyond the detectable nested-worktree shape.
- Whether worktree members need a new wire field or can reuse the existing member and repo projections.
- How the client should label and visually distinguish a disposable worktree hub from a persistent symlink hub.
- Which manual smoke journeys best exercise detached worktree creation, user-managed branches, membership edits, and safe disband.
