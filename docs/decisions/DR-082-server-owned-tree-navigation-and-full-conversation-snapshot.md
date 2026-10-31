# DR-082: Server-Owned Tree Navigation and Full Conversation Snapshot

## Status

Accepted

## Context

The branch explorer and transcript navigation need one authoritative tree read. A preview-only tree is not enough for anchor-first search, hidden-message fallback search, or an exact resume target. Truncated previews also force a second content lookup for a focused message.

The earlier tree decision chose server-owned navigation and full tree snapshots because reconnects and global navigation are simpler without client orchestration or pagination. The implementation keeps those properties while enriching message nodes with the text needed by the client.

> Supersedes DR-007 (Server-Owned Tree Navigation Lifecycle and Full Snapshot Transfer), deleted at commit `255ee68c477950b6808762dc30fb7b8f50a685fc`.

## Decision

Keep tree navigation server-owned. `navigate_tree` owns the operation and emits its lifecycle events. Tree reads return the complete tree shape in one snapshot, and message nodes carry their complete user- or assistant-authored conversation text. Text blocks join with two newlines. Tool, thinking, bookkeeping, and other non-message entries do not carry conversation text. Previews remain available as lightweight display metadata, and labels remain explicit server mutations.

A client can therefore project branch topology, search collapsed conversation, and focus an exact message from one cached snapshot. Incremental or paginated tree reads remain rejected because they add request and reconnect state for the common global-navigation path.

## Consequences

Clients can search and resume any message without a second content request, and lifecycle events remain authoritative across reconnects. The optional text field increases snapshot size in proportion to user and assistant conversation text. Excluding tool results and thinking bounds that cost, but very large contexts can still produce multi-megabyte snapshots and require a future revisit if that limit becomes material. The additive field does not change Android's mirror because Android does not consume tree vocabulary.
