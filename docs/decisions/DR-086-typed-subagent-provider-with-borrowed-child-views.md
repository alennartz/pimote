# DR-086: Typed provider with borrowed child views

## Status

Accepted

## Context

Pimote must expose my-pi subagents as interactive conversations without turning each child into a root session. A child already has one live `AgentSession`, a parent-local lifecycle owner, and a persisted transcript. Opening that transcript through another runtime would create a second writer and split lifecycle, notification, and extension state. Registering children as root slots would also pollute profiles, archives, folder counts, idle reaping, and root navigation.

The web client also needs a replayable hierarchy and semantic activity feed. A single root event cursor cannot represent child transcript observers safely: hierarchy facts belong to the parent stream, while a selected child's native Pi events need an independent snapshot and replay position. Generic panel cards flatten paths and state, so they cannot provide identity-preserving child commands or reliable teardown guards.

## Decision

Expose one typed, per-root subagent provider through the Pimote SDK EventBus. The provider publishes root-relative hierarchy snapshots and semantic events, owns an opaque replay epoch with ordered provider sequences, and lends the existing native child session through a capability-filtered lease. Pimote never owns or disposes the child runtime. The provider delegates Stop, teardown, and resurrection to my-pi's ordinary owner-control seam.

A lease is identified by the public path, a runtime incarnation, and a private attachment generation. The path remains stable across runtime replacement; the incarnation changes on removal, resurrection, or path reuse. The provider explicitly rebinds an existing lease when the native session is replaced and closes it when the path becomes unavailable. A stale path, incarnation, session, or attachment generation cannot target a later child.

Parent semantic events use the root session's replay cursor and carry provider cursors for diagnostics. Each child view uses a separate `SessionSurface`, transcript snapshot, event buffer, and observer cursor. Native Pi entries remain the source of transcript history. Typed delegation, communication, await, completion, and lifecycle events are semantic overlays with optional native provenance. Pimote replaces only referenced native blocks and falls back to native rendering when provenance or metadata is absent. Generic SDK panel cards remain available beside the first-party hierarchy rather than representing subagents.

This builds on my-pi's in-process child ownership (DR-044) and view-aware await holding (DR-066), and Pimote's real SDK boundary types (DR-039) and independent session observers (DR-067). It supersedes none of them.

Rejected alternatives:

- **Promote children to root `ManagedSlot`s or open a second runtime.** Rejected because it creates duplicate writers and transfers lifecycle authority, while contaminating root profiles, archive state, folder counts, and idle lifecycle.
- **Read child JSONL directly or create a second subagent journal.** Rejected because Pimote would race the native writer and would have to reconstruct runtime events that my-pi already owns.
- **Use one parent cursor for hierarchy and child transcripts.** Rejected because a child snapshot and stream would advance or replay unrelated root observers. Separate surfaces and cursors preserve independent recovery.
- **Render semantic events as replacement transcript history.** Rejected because it would lose native search, replay, fallback rendering, and debugging. Provenance-backed overlays preserve the native source.
- **Keep subagents as generic panel cards.** Rejected because cards cannot express stable hierarchy identity, borrowed-session commands, path/incarnation guards, or multiple child views.

## Consequences

- Pimote can render and interact with live descendants without a second runtime or root-session slot.
- Provider and view cursors, attachment generations, and incarnation checks add replay and lifecycle state that every reconnect and teardown path must validate.
- my-pi remains the authority for child ownership, lifecycle persistence, await gating, and notification delivery. Pimote owns leases, client attachments, child surfaces, and wire routing only.
- Semantic overlays require provenance-aware reduction and must retain native fallback behavior for old entries or events without metadata.
- Generic extension panels continue to work, but first-party hierarchy behavior is a separate SDK surface and does not inherit panel-card semantics.

## References

- Design artifact: `Ide hub/docs/plans/pimote-subagent-views.md`
- `my-pi/docs/decisions/DR-044-in-process-child-sessions-parent-local-routing.md`
- `my-pi/docs/decisions/DR-066-await-results-held-by-child-views.md`
- `docs/decisions/DR-039-real-sdk-types-over-duck-typed-mirrors.md`
- `docs/decisions/DR-067-shared-session-observers-with-independent-cursors.md`
