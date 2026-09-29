# DR-048: Two-surface UX — dashboard and conversation, no per-project screens

## Status

Accepted

## Context

The project-management redesign had to replace the sidebar, which had become load-bearing: project search, new-session picking, project creation, archive controls. The natural next step most redesigns take — per-project detail screens, pushed navigation, hybrids of list-and-detail — was proposed and rejected by the user twice: "there is no other screen, there's the dashboard and then there's the sessions and that's it for now."

## Decision

The product has exactly two surfaces:

1. **Dashboard** — the global home, replacing the sidebar entirely. Desktop shows the projects column and manager chat side-by-side; mobile shows a fullscreen projects list with the manager chat behind an affordance (sheet). Project rows expand inline for depth: sessions (doubling as the activity feed), repo chips with branch/dirty state, and manage actions behind row menus. All former sidebar features (search, create-project, archive-all, show-archived) are preserved here, plus favorites, ordering, and hub management.
2. **Conversation** — unchanged in role: opening a session replaces the view; back returns to the dashboard.

No per-project screens, no pushed navigation beyond these two. Fast session switching is covered by the existing ActiveSessionBar — which is what allowed the sidebar to die without losing quick access to running sessions.

Rejected alternatives:

- **Per-project detail screens.** Rejected by the user twice; expandable rows carry the same depth without a navigation layer.
- **Sidebar evolution (keep list + add a dashboard).** Rejected: two homes compete; the dashboard subsumes the sidebar's duties.

## Consequences

- Future proposals that add a third surface or per-project screens contradict a settled product decision and need explicit user reversal, not incremental drift.
- All project-level depth must fit in expandable rows and dialogs; a feature that genuinely needs a full screen (e.g. a commit feed) would force reopening this decision.
- The dashboard is now the landing surface — its load path, empty states, and mobile layout are first-class product concerns.
- ActiveSessionBar remains the fast-switch surface between conversations; it inherits the navigation weight the sidebar used to carry.
