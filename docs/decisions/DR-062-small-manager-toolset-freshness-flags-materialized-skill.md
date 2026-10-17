# DR-062: Small-but-powerful manager toolset with freshness flags and a materialized skill

## Status

Accepted

## Context

The manager toolset (nine tools before the redesign, DR-059) had drifted from the dashboard's folder surface: the UI could curate folders, create code folders and both hub variants, manage membership, and disband hubs, while the manager could only create a plain persona. A retrospective of a persona-hub build (`docs/notes/pimote-hill-climb-retrospective.html`) showed the cost: the manager hand-rolled symlinks through three attempts because the persona-hub recipe is one dashboard wizard flow but no tool. The retrospective also asked for a rescan tool and for agent-facing docs (folder-model concepts, topology recipes, tool notes), delivered where an agent reads them.

Owner rulings (2026-01-14): redesign the surface to be small but powerful, then ship complementary docs as a skill, then correct the local manager memory against both. Same day, three refinements: scrap the tree tool (rows carry identity and membership; the walk-structure report has no manager job), remove hub disband from every surface (DR-063), and make hub shape—not creator history—the membership truth (DR-064).

## Decision

**Capability symmetry with the dashboard, on one small surface.** Every dashboard folder mutation gains a tool twin; reads consolidate instead of multiply. Seven tools: one folder-space read (`pimote_list_folders` with a `nature` filter — rows carry git facts through `repo`/`repos` and hub membership through `members`), one unified sessions view (`pimote_list_sessions`) plus start and archive, and three mutations (`pimote_create_folder`, `pimote_update_folder`, `pimote_update_hub_members`). Six tools retire: `pimote_create_persona` (subsumed by kind-parameterized creation), `pimote_list_personas` (the `nature` filter serves the team view; the hidden hub-exclusion rule of the old rows was a surprise, not a feature), `pimote_search_sessions` (merged into the unified sessions view), `pimote_list_repos` (a projection, not a capability), `pimote_folder_tree` (structure without a job: identity and membership live on the rows), and `pimote_disband_hub` (removed with the whole disband feature, DR-063). We rejected mirroring the wire command set one-to-one: the wire carries client-sync concerns (windows, pins, epochs) an agent never needs, and fifteen near-synonymous tools cost prompt surface for no capability.

**Freshness is a flag, not a tool.** The folder read takes `fresh: true`: drop the discovery cache and block on the next walk. This absorbs the retrospective's rescan request — plain reads stay stale-while-revalidate (up to one ~30s TTL) and the flag is the explicit "reflect the filesystem now" switch. We rejected a separate `pimote_rescan` tool: it would be a fourth read that differs from its siblings only in cache behavior.

**One creation tool, four kinds.** `pimote_create_folder` takes `kind: code | persona | code-hub | persona-hub` — the exact shapes the dashboard wizard creates — with per-kind validation (persona kinds require `description`, hub kinds require `memberPaths`). `parentPath` means one thing for every kind: an existing folder inside a scan root (canonical containment, symlink escapes rejected). The tool is deliberately more general than the wire twins, which restrict to configured roots. Code folders route through the creators seam via the same shared routing the ws-handler uses (`folder-create.ts`); persona folders through the seeding seam; hubs through the registry.

**Membership batches, the wire stays split.** `pimote_update_hub_members` applies `remove` before `add` in one call and reports one outcome per member path. DR-061 keeps the wire at two single-purpose commands because the dialog mutates one member at a time; the manager surface serves a different consumer — an agent restructures a whole hub in one step. We rejected two single-member tools: they re-create the round-trip cost DR-061 accepted for the dialog, with no dialog behind them.

**Docs ship as a server-materialized skill.** The `pimote-folders` skill follows the static-report provision pattern: markdown embedded in the server package, materialized into the state skills directory, rewritten on drift (upgrades propagate), and provided to manager sessions through `resources_discover`. SKILL.md is the map (tool table, freshness, the leaf rule); `references/model.md` and `references/recipes.md` carry the concepts and the four recipes with anti-patterns. We rejected seeding docs into `managerRoot` (write-if-absent never upgrades, so installed managers would read stale rules forever) and rejected AGENTS.md pointers into the repo (the manager root is not a checkout). Structural hints also live at the error site: creation collisions carry the leaf rule and the symlink alternative in the error itself.

> **Amendment (2026-10-16, DR-065):** the docs no longer ship as a skill. Documentation lives in `docs/shipped/` and the package ships it. A `pimote-docs` system-prompt section lists each file for every session. The `pimote-folders` skill retires. The tool surface and freshness flag decisions above stand.

**No move tool.** DR-053 keys curation on canonical paths and records the move revisit point; a move tool would need curation migration to be worth its surface. Deferred until moves recur.

## Consequences

- A conversation with the manager can now do everything the dashboard does to folders; the dashboard keeps its exclusive rendering concerns only. The wire keeps its `list_repos` command; only the manager projection is gone.
- Tool-name breaking change is contained: tools attach only to manager sessions (DR-059). The manager persona's memory and any user prompts referencing retired names need the rename — the local memory was corrected in the same change; the skill documents the new names.
- The skill's content is code: it compiles into `server/dist`, reviews like code, and upgrades like code. Drift between skill and implementation shows up as a review diff, not as a stale wiki page.
- `pimote_list_sessions` serves disk records with live state patched on; a live slot whose record falls outside the limit window is not listed. Documented in the tool description.
- The unified sessions view and the merged reads make the old split contracts (live view vs history search, all-personas vs hub exclusion) disappear from the surface; their semantics live in the skill instead.
- The tree's retirement means no manager surface observes the walk's structure; the skill documents the walk rules instead. If diagnosing discovery from the manager becomes a recurring need, reintroduce a read rather than inferring from rows.
- The manual driver `manager-tools-smoke` was already broken at HEAD (its duck-typed repo stub predates the registry's `listLazy`); this change repairs the stub and repoints the driver at the new toolset.
