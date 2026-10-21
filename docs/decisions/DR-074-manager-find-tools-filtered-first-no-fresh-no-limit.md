# DR-074: Manager find tools — filtered-first reads, no freshness flag, no limit

## Status

Accepted (the two-tier fold into `pimote_find_folders` is revised by DR-075; the rest stands)

## Context

DR-062 pinned the manager toolset: `pimote_list_folders` with a `fresh` freshness flag, and `pimote_list_sessions` with a default limit. Three forces drove a revision.

First, the descriptions listed filters as "optional", so broad unfiltered listings were the model's default stance. Targeted exploration should be the natural one, and the dashboard already proves the semantics: the homepage search (`folder-listing.ts` `matchRow`) matches folder text (persona name, name, path, tags) two-tier — a folder also matches when any of its sessions' names or first messages match — with an archived gate. The tool exposed none of this.

Second, `fresh` gave the model a discovery-cache bypass it needs only after manual `mv`/`ln` — a once-per-install need permanently costing a parameter, its description weight, and a documented mental model. Staleness is bounded (30s TTL, stale-while-revalidate) and self-heals; mutations invalidate and broadcast immediately.

Third, `limit` duplicated truncation the spill guard (DR-071) already handles: the inline budget bounds context, the JSONL spill file keeps every remaining row reachable with jq/grep, and reads cost the same regardless.

## Decision

Rename the reads `pimote_find_folders` and `pimote_find_sessions` — the verb states the stance: filter first. Fold the dashboard's search semantics into `pimote_find_folders` (`query` with two-tier matching, `nature`, `hub`, `includeArchived`) and add `includeArchived` to `pimote_find_sessions`. Drop `fresh` and `limit`. Encode the stance as `promptGuidelines`, so the system prompt's rules section carries "filter instead of scanning" whenever the tools are active.

Rejected: hub variants inside the `nature` union (`'code-hub' | 'persona-hub'`) — a single-select nature cannot ask for "all personas regardless of hub", and an array param overlaps the hub axis with combinations the model must reason about. Hub-ness is a row attribute (base nature plus `shortcutCount > 0`), so the orthogonal `hub` boolean composes: `nature: 'persona'` alone returns all personas including hubs; `hub: false` excludes them. Rejected: keeping `limit` as a cheap cap — two truncation mechanisms for one job.

## Consequences

The model has no cache bypass: after manual filesystem changes it waits out one TTL. Archived folders and sessions hide by default on both tools, matching the dashboard; archived history needs `includeArchived`. Tool names changed, so anything scripted against the old names breaks. DR-062's freshness-flag decision is revised here; its toolset-shape rationale — one read per space, tool twins for dashboard mutations — stands.
