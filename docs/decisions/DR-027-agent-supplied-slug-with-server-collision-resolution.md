# DR-027: Agent-supplied slug with server-side collision resolution

## Status

Accepted

## Context

Bundles hosted under `/s/<slug>/` need a slug. The slug appears in URLs, in server logs, in the panel card's link target, and (in dev) anywhere the agent or user copy-pastes the URL around. Three shapes were on the table:

1. **Random short ID** — server generates an opaque token (e.g. nanoid).
2. **Derived from the source folder name** — server slugifies the folder basename.
3. **Hybrid** — derived base + random suffix.

The brainstorm flagged this as open; the architect picked the shape.

## Decision

The agent supplies the slug as a tool argument. The server validates shape (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, max 64 chars) and only mutates it on collision, by appending `-2`, `-3`, … until free. The resolved slug is returned to the agent.

Random IDs were rejected because they produce opaque URLs — useless for human inspection in logs or for the agent reasoning about what it just hosted. The agent ends up wrapping the URL in a panel card title anyway; making the URL itself meaningful avoids a parallel naming exercise.

Folder-name derivation was rejected because it pushes naming logic server-side: slugify rules, escape handling for non-ASCII / spaces / dots / mixed case, disambiguation when two folders share a basename. The agent already knows what the bundle is for in human terms (it generated it for a specific reason); asking it to pick a short descriptive slug uses information the server doesn't have and gets better names for free.

A hybrid (derived + random suffix) would have given uniqueness without conflict-handling code, but it carries the worst of both: still opaque enough to read poorly, while losing the property that uncontested slugs are exactly what the agent asked for.

## Consequences

- The collision-resolution path is a real code path with tests, not a fallback that never fires — agents will reuse slugs across sessions and across reboots. The `-2`, `-3`, … shape is fine for now; if pressure rises (e.g. tens of collisions per slug), revisit.
- The agent is responsible for picking reasonable slugs. The tool description nudges toward short descriptive names, but there's no enforcement beyond shape validation. A consistently-bad-naming agent will produce ugly URLs; that's an agent-prompt problem, not a server problem.
- Slugs are globally unique across sessions within a process. Cross-session collisions get suffixed too. The plan's persistence layer stores the resolved slug, so replay-after-restart preserves the assignment.
- If we later want stable slugs across reboots without collision-suffixing (e.g. a session reloads and wants its old slug back), the current ordering (GC → replay → fresh registrations) already handles it: orphan files are deleted before live sessions register, so live sessions reclaim their old slugs without contention.
