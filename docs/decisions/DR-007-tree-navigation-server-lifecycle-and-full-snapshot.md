# DR-007: Server-Owned Tree Navigation Lifecycle and Full Snapshot Transfer

## Status

Accepted

## Context

Adding `/tree` to pimote required parity with the TUI flow: users can jump to any branch point and optionally summarize abandoned context before continuing. In a web client/server architecture, this raised two non-obvious design choices:

1. Should navigation/summarization be client-orchestrated, or a server-owned session operation?
2. Should tree data be loaded incrementally/paginated, or transferred as a full snapshot?

Client-orchestrated navigation was rejected because it complicates reconnect semantics and makes long-running summarization fragile (tab close/reload interrupts local state). Paginated/on-demand tree loading was rejected because it adds protocol complexity and request churn for the common case where tree nodes are lightweight metadata and users need fast global navigation.

## Decision

`/tree` uses a **server-owned lifecycle** and **full lightweight tree snapshots**:

- Navigation is executed via `navigate_tree` on the server, with lifecycle events (`tree_navigation_start`, `tree_navigation_end`) so clients can render progress and recover correctly after reconnect.
- `/tree` returns the full tree as lightweight node metadata (`PimoteTreeNode` previews, labels, timestamps, children), not full message bodies.
- Label edits are explicit server commands (`set_tree_label`) rather than local-only mutations.

This keeps branch-switch behavior authoritative on the session host and keeps client UX consistent across disconnect/reconnect.

## Consequences

- Reconnect behavior is simpler and more reliable: lifecycle state is event-buffered server-side, so clients can resume loading state correctly after connection loss.
- Protocol surface grows (new commands/events/types), but avoids additional pagination APIs and client-side orchestration logic.
- Full snapshot transfer is efficient for current tree sizes; if sessions grow significantly, we may need to revisit with incremental loading or server-side filtering.
- Server session state must explicitly protect in-progress navigation/summarization from idle reaping.
