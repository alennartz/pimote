# Hub Member Representation

## The idea

Add a creation option that controls how hub members are represented. A hub can keep the current symlink layout or create disposable Git worktrees for code members. Persona members remain symlinks in either mode.

The worktree mode supports short-lived feature hubs that span several repositories. The symlink mode supports long-lived groupings that point at canonical member folders.

## Key decisions

- **Representation is chosen per hub.** The choice is not global. Symlink mode remains the default because it is the current layout and suits long-lived groupings. This is a product default, not an old-client compatibility requirement.
- **Worktrees are nested in the hub.** Each code member gets a real checkout at `hub/<member>`. The hub does not use the pi extension's shared `.git-worktrees` directory. A self-contained layout makes the ephemeral lifecycle clear.
- **Persona members always use symlinks.** Worktree mode applies only to code members because personas are persistent folders, not Git branch checkouts.
- **One branch name spans the hub.** Creation accepts an optional `branchName`; when omitted, it defaults to the hub name. Each code repository gets that branch name in its own Git repository. The canonical member folders remain untouched.
- **Branch source is chosen as one hub-wide policy.** Each worktree normally starts from its member repository's current `HEAD`. If any member is not on its detected default branch, the UI warns before creation and offers only two choices: use current `HEAD`s or use each repository's default-branch tip. If every member is already on its default branch, no question appears.
- **Creation fails closed.** A member that cannot create or attach the requested branch must not leave a partially created hub. Creation does not stash or move changes from canonical members.
- **Membership remains editable.** Adding a code member to a worktree hub creates its worktree on the hub branch. Adding a persona creates a symlink. Removing a code member requires a clean worktree, then removes that worktree while preserving its branch. Symlink hubs keep their existing membership behavior.
- **Worktree cleanup is explicit and conservative.** Disband is available only for worktree hubs. It checks every generated worktree for staged, unstaged, and untracked changes, refuses to proceed when any are present, removes clean worktrees through Git, and then removes the hub. It never auto-commits, merges, or deletes branches. This supports branches that will be pushed or merged through a remote pull request.
- **The pi worktree extension is reference context, not a dependency.** Its branch, session, stash, merge, and shared-directory mechanisms are not part of this feature. Only the basic Git worktree lifecycle applies.

## Direction

Extend the existing hub creation flow with a symlink/worktree representation choice. Worktree hubs are feature workspaces: code checkouts live under the hub, share one branch name, and can be removed safely after their work is committed. Symlink hubs remain the ordinary persistent grouping shape. The dashboard and manager creation surfaces should expose the same behavior, while later architecture work defines their exact parameter and wire shapes.

## Open questions

### Sharp questions

- What managed metadata records a worktree hub's representation, branch name, branch-source policy, and canonical code-member paths?
- How will the folder model recognize nested worktree members and report both their checkout paths and their canonical source folders?
- What is the exact policy when a requested branch already exists, is checked out elsewhere, or has a different history in one member repository?
- What preflight and result shape gives the non-interactive manager surface the same branch-source warning semantics as the dashboard?
- How do add, remove, and disband recover from a failure partway through Git operations without orphaning worktrees or deleting the hub prematurely?
- How should disband handle active sessions or external processes rooted in a generated worktree?

### Fog

- Whether the managed metadata belongs in a hidden hub file, the generated `AGENTS.md`, or another existing folder shape.
- Whether worktree members need a new wire field or can reuse the existing member and repo projections.
- How the client should label and visually distinguish a disposable worktree hub from a persistent symlink hub.
- Which manual smoke journeys best exercise multi-repository branch creation, membership edits, and safe disband.
