# DR-045: Repo index orthogonal to curated projects

## Status

Accepted

## Context

Pimote's original project management was a `FolderIndex`: a one-level scan for git directories that doubled as the project list. The two concepts were fused — a folder discovered by the scan _was_ a project — which worked while every project was exactly one repo sitting directly under a configured root. Real workflows broke the model: repositories nested deeper than one level were invisible, multi-repo projects were unrepresentable, and any reorganization of scan roots silently reshaped the user's project list.

## Decision

Split discovery and curation into two layers with different lifetimes:

- **RepoIndex** is derived state: a bounded recursive walk over configured roots plus registered sources, TTL-cached, enriched with per-repo git status. It owns no persistence and can be rebuilt at any time.
- **ProjectRegistry** is the persistent, user-owned layer: projects referencing 1..N repos, with curation state (favorite, manual order, archived) stored separately from discovery. A single-repo project is the degenerate case pointing directly at the repo directory; a multi-repo project is a hub folder (DR-046).

Membership is explicit state, not a heuristic derived from the filesystem. The registry merges its persisted entities over the current index at list time; a repo that vanished from disk keeps the project editable via `missing` marking rather than dropping it.

Rejected alternatives:

- **Keep projects folded into the scan** (the FolderIndex model). Rejected: no multi-repo support, no curation state, and the project list churns with filesystem/discovery changes.
- **Config-only grouping without index validation.** Rejected: projects would reference arbitrary paths with no discovery backing, and hub creation could not validate members against known repos — the index-members-only rule is what keeps the symlink API from becoming arbitrary-link creation.

## Consequences

- Projects survive reorganizing scan roots, deepening discovery, or swapping discovery sources, because the registry only records which repos a project references.
- Two layers must be reconciled: `ProjectRegistry.list()` merges overrides with the index on every read, and enrichment that depends on live server state (session counts) happens at the WS layer, not in the registry.
- Discovery changes propagate through TTL expiry or explicit invalidation — mutations that create repos must invalidate the index or the cache hides them.
- Curation overrides for single-repo projects are keyed by repo path, so moving a repo on disk orphans its curation state (accepted: recorded, ignored on merge).
