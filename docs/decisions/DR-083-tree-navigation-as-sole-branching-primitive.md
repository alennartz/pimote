# DR-083: Tree Navigation as the Sole Branching Primitive

## Status

Accepted

## Context

Transcript redo and branch-explorer resume must preserve one session tree. Pimote previously exposed a wire-level `fork` command alongside tree navigation. Those operations have different identities: `fork` creates a separate session file, so the new branch is invisible to the original explorer, and it does not offer tree-navigation compaction options. Keeping both would make the same message action choose between two histories and two resync paths.

## Decision

Route every Pimote redo and resume flow through `navigate_tree` in the existing session. One-click actions omit compaction. The explicit compaction dialog uses Pi's default summarization for an empty prompt or custom instructions for a non-empty prompt. Remove `ForkCommand` and the server's wire-level `fork` case. Leave Pi's own `commandContextActions.fork` extension surface unchanged because it is not Pimote's branching protocol.

The tree is the sole Pimote branching primitive. Abandoned continuations stay in the same session tree, so the branch explorer can recover them and all clients can converge through the existing tree-navigation lifecycle and resync.

## Consequences

Branch discovery, navigation, compaction, and observer resync share one session identity and one protocol path. The client no longer creates a separate Pimote session when a user redoes from a transcript message, so the old separate-file fork behavior is intentionally unavailable over the Pimote wire. Clients and tests must use `navigate_tree`; Pi extensions that call Pi's own fork action retain their existing semantics.
