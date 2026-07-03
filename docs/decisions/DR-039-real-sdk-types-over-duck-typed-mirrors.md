# DR-039: Type SDK boundaries against real pi exports, not duck-typed mirrors

## Status

Accepted

## Context

pimote consumes the pi SDK at several boundaries: session-event mapping (`event-buffer.ts`), message mapping (`message-mapper.ts`), session-entry cost summation (`session-cost.ts`), and interactive OAuth login (`login-orchestrator.ts`), plus the voice extension's hooks. Historically these boundaries were expressed with hand-written structural interfaces that shadowed the SDK's shapes — `SdkEvent`, `SdkAssistantMessageEvent`, `SdkMessage`, `SdkSessionEntry`, `CostBranchEntry`, a re-declared `LoginOAuthCallbacks`, a local `MessageStartEvent` — reached through `as unknown as` casts at the call sites. The original rationale was decoupling and testability: avoid importing SDK types so modules stay pure and fakes stay light.

The `0.79.1 → 0.80.3` upgrade audit exposed the cost of that approach. Because TypeScript never checked pimote's assumed shapes against the SDK's real exports, upstream renames and field changes could not surface at compile time — they silently fell through to fallback branches at runtime. Migrating one file (`event-buffer.ts`) to the real union proved the point by uncovering live drift: the SDK emits `compaction_start` / `compaction_end`, but pimote mapped `auto_compaction_start` / `auto_compaction_end`, so those cases were dead and the client's "compacting" indicator never fired; `message_start` read a nonexistent top-level `role` (always defaulting to `assistant`); and `agent_end.error` was read from a field that does not exist on the event.

## Decision

Type pimote's SDK boundaries against the real exported types and derive rather than re-declare:

- Import the real unions — `AgentSessionEvent`, `SessionEntry`, `AgentMessage`, `AssistantMessageEvent` — and narrow on their discriminants instead of duck-typing.
- Derive callback/parameter types from the SDK method signatures (`type LoginOAuthCallbacks = Parameters<AuthStorage['login']>[1]`) instead of hand-mirroring them.
- Make the event mapper **exhaustive** (`const _exhaustive: never = event`) so a new or renamed `AgentSessionEvent` member fails to compile until it is handled.
- Keep structural interfaces **only where they serve dependency injection** — `LoginAuthStorage` / `LoginModelRegistry`, `AutoDrainSession`, and the voice FSM's intentionally loose event snapshots — never as shadow copies of SDK data shapes. Their correctness is enforced at the single construction site, where the real SDK class is checked against the seam.

Rejected alternatives:

- **Keep duck-typing (status quo).** Rejected: it hides version drift and had already produced a silently broken feature. The whole value of the type checker at this boundary was being discarded.
- **Add `@earendil-works/pi-ai` as a direct dependency** to import content-block types (`TextContent`, `ToolCall`, …). Rejected as unnecessary: those types are reachable by indexed-access derivation from `AgentMessage` (e.g. the content-item union) without a new direct dependency, keeping the dependency graph unchanged.
- **Eliminate the structural seams entirely** and import real classes everywhere including tests. Rejected: the DI seams earn their keep (light in-memory fakes), and drift is already caught where the real class is passed to the seam, so widening the seams to full SDK types would burden tests for no additional safety.

## Consequences

- Upstream SDK renames, removed fields, and new event/message variants now fail at **compile time** rather than degrading silently at runtime — the exhaustiveness guard is the tripwire.
- Fixing the drift this surfaced repaired the compaction-status indicator and removed two dead reads (`message_start` role, `agent_end.error`).
- Mappers must now handle **every** union member — all seven `AgentMessage` roles, all `AgentSessionEvent` cases. That is more code (e.g. explicit handling of `bashExecution` / `branchSummary` / `compactionSummary` messages), but it is honest and complete.
- SDK events with no pimote wire representation (`queue_update`, `session_info_changed`, `thinking_level_changed`) are now **explicitly dropped** in one obvious place instead of mis-emitted as `agent_start`; wiring them to the client later is a localized change.
- pimote's wire event names (`auto_compaction_*`) deliberately diverge from the SDK's (`compaction_*`); `event-buffer.ts` is the single, documented translation point.
- Tests that asserted fictional shapes (notably message `id` → `entryId`, which never happens — entry IDs come only from `applyEntryIds`) had to be rewritten against reality.
- Residual boundary to watch: the voice FSM keeps deliberately loose snapshot types (`PartialAssistantMessage`, `ToolCallEnded`) to stay SDK-decoupled. The real types _satisfy_ these rather than _being_ them, so that one seam still relies on structural compatibility — if the FSM ever needs a field the loose type doesn't name, it must be added there.
