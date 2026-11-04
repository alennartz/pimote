# DR-084: Fork and Tree Navigation as Distinct Branching Primitives

## Status

Accepted

## Context

> Supersedes DR-083 (Tree Navigation as the Sole Branching Primitive), deleted at commit `e30ede957cbb47b3c5b0ab8afc7a6b8b28480c17`.

DR-083 (Tree Navigation as the Sole Branching Primitive) retired the wire-level `fork` command because keeping both operations made one message action choose between two histories. But the two operations have genuinely different identities, and collapsing them removed a capability rather than a redundancy: tree navigation re-branches within the same session file, while pi's fork creates a new session file from a chosen point, leaving the original session untouched and live. A user who wants to explore a different direction while keeping the original session intact has no in-place substitute for fork — redo permanently re-roots the session's active branch. Pi's `runtime.fork` machinery, its lifecycle guard, and the `session_replaced` rekey survived the retirement, so the cost of restoring the operation was the wire command and client surface only.

## Decision

Restore both primitives as separate message actions. **Redo from here** routes through `navigate_tree` in the existing session. **Fork from this message** sends a Pimote `fork` wire command backed by `slot.runtime.fork(entryId)`, creating a new session; the replacement flows to all clients through the existing `session_replaced` rekey and the selected prompt text returns through the fork draft policy (Replace, Append, Prepend, Ignore on conflict). Fork stays user-message-only, matching pi's TUI semantics of forking at user prompts. Both actions live in the same user-message menu so the choice between in-place re-branching and a separate session file is explicit.

## Consequences

After a fork, two session files hold overlapping history; the new session's branch explorer shows its own lineage and the original session's tree no longer contains the forked continuation. Clients must handle both `navigate_tree`'s same-id resync and `fork`'s rekey, but both paths already existed. DR-083's concern about one message action choosing between two histories is resolved by labeling the actions distinctly rather than removing one operation.
