# DR-075: find folders queries folder text only; the dashboard search gates its session tier

## Status

Accepted (revises DR-074's two-tier fold; DR-074's other decisions stand)

## Context

DR-074 folded the dashboard search's two-tier semantics into `pimote_find_folders`: a folder matched when its text matched, or when any member session's name or first message matched. In practice the manager never needs that second tier — `pimote_find_sessions` answers session-content questions directly, with its own filters — so the tier only made results surprising: a query for a topic returned folders whose sessions merely mentioned it. Owner ruling (2026-10-20): folder search stays folder-scoped; session content belongs to the session tool.

The same review exposed an archive-gate leak both surfaces shared. The session tier ignored archived state: the tool's `filterByQuery` never checked `DiskSessionRecord.archived`, and the dashboard's metadata projection (`folder-listing.ts` `projectMetadata`) carried no archived flag at all, so an archived session could make a folder match — with matched-session highlights — while the UI's show-archive toggle was off.

## Decision

`pimote_find_folders.query` matches folder text only (persona display name, name, path, tags) and never reads sessions. The dashboard search keeps its two-tier shape — it exists to find sessions, presented grouped by their folders — but its session tier now honors the same gate as the folder tier: archived sessions match only when the request sets `includeArchived` (the UI's show-archive toggle). Sorting is deliberately untouched: archived sessions still fold into `lastActivity`, so the pinned order and the client mirror are identical with the gate on or off. The folder listing gains an `archivedLookup` dep (the session metadata store) to project the flag.

Rejected: gating the tool's session tier on `includeArchived` instead of removing it — the manager already owns `pimote_find_sessions`; a gated duplicate invites the same surprising hits. Rejected: excluding archived sessions from `lastActivity` — ordering is not matching; gating it would reorder the default dashboard list as a side effect of a search-semantics fix.

## Consequences

`pimote_find_folders` can miss a folder whose only connection to a term is session text; its description now points the manager at `pimote_find_sessions` for that. The dashboard's matched-session highlights exclude archived sessions unless the archive toggle is on, while folder ranks can still be set by archived activity — an accepted asymmetry. Manager tool tests can now assert find_folders never touches the session port.
