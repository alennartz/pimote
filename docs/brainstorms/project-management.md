# Brainstorm: Project Management Redesign

## The Idea

Replace pimote's minimal project management (one-level scan for git dirs, dumb folder list) with a richer model: projects as first-class curated entities, deeper and extensible discovery, and a global manager agent embedded in a new dashboard home.

## Key Decisions

### Repo index ⊥ Projects (separate concepts)

Discovery builds an **index of repos**; **projects** are persistent, user-owned entities referencing 1..N repos. _Why:_ the user's multi-repo use case broke the implicit `1 folder = 1 project` model; separating them means projects survive reorganizing scan roots, and membership is explicit state rather than a fragile heuristic.

- **Single-repo project** (degenerate): points directly at the repo folder. No extra directory on disk.
- **Multi-repo project**: a server-created **hub folder** containing symlinks to member repos, plus a generated `AGENTS.md` stating that each symlinked subdir is a sub-project whose own `AGENTS.md` must be consulted. Sessions open with cwd = hub, so **one session spans all repos today** — no upstream pi multi-root support needed. (This was the user's own insight; it keeps the single-cwd pi SDK model intact.)

### Discovery: recursive + pluggable

Bounded-depth recursive walk (skipping vendored dirs like `node_modules`) replaces the one-level `readdir`. _Why:_ the primary pain — repos nested deeper than one level were invisible.

### Extensibility: sources and creation, symmetric

**Discovery sources** and **creation flows** are both pluggable, implemented as TypeScript extension files registered in-process — the same pattern as pi extensions and `@pimote/panels`. _Why:_ the user named custom discovery sources as the extensibility use case, then extended it: "discovery equal to creation". Examples: workspaces-file source, zoxide/ghq source; template-scaffold or `gh repo clone` creators.

### Project creation from the repo index

"New project" = pick member repos from the known index, name it, choose location; server creates the hub folder + symlinks + `AGENTS.md`. _Why:_ the user explicitly wanted to compose projects from the list of known repos. Hub creation only accepts repos from the index — no arbitrary symlinks via the API (security).

### Organization: favorites + archive

Favorites/pins with manual ordering; project-level archive (soft-hide finished projects). _Why:_ lightest mechanism that solves the "flat alphabetized dump" pain; named groups were considered and rejected as premature structure.

### UX: exactly two surfaces

1. **Dashboard** — the global home, replacing the sidebar entirely.
   - Desktop: projects list and manager chat **side-by-side**.
   - Mobile: fullscreen dashboard; manager chat behind an affordance.
   - Project rows **expand inline** (evolution of today's sidebar pattern): sessions (this list doubles as the activity feed), repo chips with branch/dirty status, and manage actions (rename, archive, add/remove repos) behind row menus.
   - Picking a project → new session or resume existing.
   - Must preserve current sidebar features at minimum: project search, new-session picker, create project (root + name → mkdir + git init), archive-all inactive, show-archived toggle.
2. **Conversation** — unchanged role; opening a session replaces the view; back returns to the dashboard.

_Why no per-project screen:_ the user rejected pushed screens and hybrids twice — "there is no other screen, there's the dashboard and then there's the sessions and that's it for now." ActiveSessionBar already covers fast session switching, which is what made the old sidebar load-bearing.

### Manager: global, ephemeral

One **global manager agent** — not scoped to any project — embedded in the dashboard. Powers span all projects and the whole session space through a **custom pimote toolset** (list/search over repos and sessions, create and manage sessions, project ops). Working directory is an empty temp location each visit. **Ephemeral, always fresh**: no session file, never persisted. _Why:_ the user first wanted non-persistent, briefly reconsidered, then settled ephemeral — the manager is a command surface, not a colleague with memory; simpler plumbing wins. Tools act only through pimote's server APIs, never raw fs.

### Out of scope

- **Android**: untouched for now (explicitly). Protocol evolution must merely not break the Android client's mirrored subset.
- Per-project screens, persistent manager sessions, git-commit feeds.

## Direction

Build the project registry + repo index on the server, the dashboard home in the PWA (replacing the sidebar), multi-repo hubs via symlink folders, favorites/archive, and the global ephemeral manager with custom tools. Extension seam for discovery/creation from day one, even if the only built-in source is the filesystem scanner.

## Handoffs to Architecting

Sharp technical questions:

- Can the pi SDK run a truly ephemeral `AgentSession` (no session file)? If not: scratch-directory fallback hidden from the index.
- Recursive scan cost and caching strategy; change detection (rescan triggers, fs watchers?).
- Protocol migration: `FolderInfo` → project/repo types without breaking the Android mirror; deprecation path for `activeStatus`.
- Extension registration/discovery mechanics for project sources/creators (TS files, in-process, panels pattern).
- Where manager tools hook into server internals (session-manager, registry) and how they're exposed to the agent.

## Open Questions

**Sharp (deferred intent):**

- Git-commit feed in the session list — deferred; session list already conveys recency. Revisit post-v1.

**Fog:**

- Whether the manager also gets a standalone surface outside the dashboard.
- Android parity for the richer project UI (some future release).
