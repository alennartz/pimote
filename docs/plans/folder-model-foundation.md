# Plan: Folder model foundation

## Context

First shippable slice of the unified folder model: sparse-tree discovery from the configured scan roots that classifies every folder of interest as a **code folder** or a **persona folder**, links them via **shortcut** occurrences, and reports the tree through a read-only manager tool. In the same increment the model **subsumes the repo index** (discovery) and the **project** concept (curation attaches to folder entries), and hub folders become self-describing git repos. See [the brainstorm](../brainstorms/folder-model-foundation.md) for the explored alternatives. Behavioral constraint: the running pimote-in-pimote loop is never disrupted — same surfaces, new vocabulary, additive data. "Additive" is behavioral, not textual: the projects→folders rename and hub `git init` were chosen deliberately after the brainstorm froze its "additive only" note; no user-visible workflow changes or loses data.

## Architecture

### Impacted Modules

- **Protocol** — `ProjectInfo` → `FolderInfo` (gaining `nature`, `persona`, `shortcutCount`); commands renamed: `list_projects`→`list_folders`, `update_project`→`update_folder`, `create_multi_repo_project`→`create_hub`, `disband_project`→`disband_hub`, `projects_changed`→`folders_changed`. The Android mirror speaks `FolderInfo`/`list_folders` today (accepted stale debt) and becomes correct again by this reversal.
- **Server** — both existing discovery walks are subsumed: `folder-index.ts` is deleted; `repo-index.ts` becomes a thin adapter over `folder-model` (stable `list(): Promise<RepoInfo[]>` interface, TTL cache and git-status enrichment retained, registered `ProjectSource` merge retained). The curated registry (`project-registry.ts`) merges its overrides over all included entries (code **and** persona) and is renamed accordingly. Hub materialization gains `git init` + `.gitignore`. Manager toolset renamed plus one new tree tool.
- **Web Client** — project vocabulary becomes folder vocabulary (`project-store`→`folder-store`, `ProjectList`→`FolderList`, "Projects" label → "Folders"), and each folder row gets a nature × hub icon. Hub create/disband dialogs relabeled only.
- **Android Client / SDK / Agent Extensions** — untouched.

### New Modules

**`server/src/folder-model/`** — the deep module that owns folder discovery. Responsibilities: marker-aware nature classification, sparse-tree scanning (descent through skipped folders, stop at included ones, shortcut recursion), canonical-path identity with visit-once semantics. Dependencies: node `fs`/`path` only — no protocol types, no server internals. Everything below sits behind one function.

### Interfaces

**folder-model — the entire external interface:**

```ts
export type FolderNature = 'code' | 'persona';

export interface PersonaInfo {
  name: string;
  description?: string;
}

export interface FolderEntry {
  /** Canonical (real) path — the entry's identity. */
  path: string;
  /** Always the folder's basename. Never the persona name. */
  name: string;
  nature: FolderNature;
  /** Present iff nature === 'persona'. */
  persona?: PersonaInfo;
}

export interface FolderOccurrence {
  /** Where it appears: real directory path (via 'scan') or symlink path (via 'shortcut'). */
  path: string;
  via: 'scan' | 'shortcut';
  entry: FolderEntry;
  /** Shortcut occurrences at this folder's top level. */
  children: FolderOccurrence[];
}

export interface SparseTree {
  occurrences: FolderOccurrence[];
}

/** The only fs operations the scanner performs; injectable for tests. */
export interface FolderFs {
  readdir(path: string): Promise<Dirent[]>;
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
}

export function scanFolderModel(options: { roots: string[]; fs?: FolderFs }): Promise<SparseTree>;
```

**Discovery contract** (what the tests pin down):

1. From each scan root, walk directories; prune `node_modules`, `.git`, `dist`, `build`, `target`, `.venv` anywhere below a root.
2. Classification, in order: `AGENTS.md` beginning with a YAML front-matter block (`---` … `---`) containing a string `name:` key → **persona** (marker; `name`/`description` captured into `persona`); else a `.git` entry (directory _or_ file) → **code**; else **skipped** → descend into it.
3. Marker wins over git when both are present. A marker-less, git-less `AGENTS.md` includes nothing.
4. Once a folder is **included**, descent stops. Its top-level entries that are symlinks to directories whose real path lies outside the folder become **shortcut occurrences**.
5. Entering a shortcut restarts discovery at the target: classify the target; if skipped, descend through it; its own shortcuts recur the same way.
6. Symlinks found while descending through **skipped** folders are followed like ordinary folders — no out-of-tree condition there.
7. Identity is the canonical real path; each entry is discovered once. Later encounters emit occurrences referencing the same entry (children come from the first discovery). Cycles terminate by this rule.
8. Skipped path structure is collapsed into occurrence `path` strings — skipped folders never appear as nodes.

**Wire — `FolderInfo`** (`shared/src/protocol.ts`, renamed from `ProjectInfo`):

```ts
interface FolderInfo {
  path: string; // canonical path — curation key
  name: string; // basename
  nature: 'code' | 'persona';
  persona?: { name: string; description?: string };
  shortcutCount: number; // > 0 → hub icon variant
  favorite: boolean;
  archived: boolean;
  tags: string[];
  missing: boolean; // curation entry with no discovered folder
  // plus the session/git chip fields ProjectInfo carries today, unchanged
}
```

**Registry seam** (renamed from `ProjectRegistryPort`):

```ts
interface FolderRegistryPort {
  list(): Promise<FolderInfo[]>; // overrides merged over all included entries
  update(patch: FolderUpdatePatch): Promise<void>; // keyed by canonical path
  createHub(input: { name: string; memberPaths: string[] }): Promise<FolderInfo>;
  disbandHub(folderPath: string): Promise<void>;
}
```

Curation (favorite/archive/order/tags) keys on the canonical entry path; a moved folder orphans its curation state (accepted trade-off from DR-045, carried forward). `list_repos` survives as the code-folders-with-git-status view (repo chips, hub-member picker — hub members remain code-only this increment).

**Hub materialization** (`project-sources/materialize.ts`): mkdir + one absolute symlink per member + generated `AGENTS.md` (unchanged) **plus** `git init` and a `.gitignore` listing the member symlink names. Result: the hub classifies as a code folder (git, no marker) and its member symlinks surface as shortcut occurrences — the hub model falls out of the folder model by construction. The repo-index "members must be in the index" validation rule is unchanged.

**Manager toolset** (`server/src/manager/`, narrow DI ports per DR-039):

```ts
interface ManagerToolContext {
  sessions: SessionManagerPort;
  folders: FolderRegistryPort; // was projects: ProjectRegistryPort
  repos: RepoIndexPort;
  tree: FolderModelPort; // { tree(): Promise<SparseTree> }
  config: PimoteConfig;
}
```

- `pimote_list_projects` → `pimote_list_folders` (→ `folders.list()`)
- new `pimote_folder_tree` (→ `tree.tree()`) — reports entries and shortcut occurrences ("what folders do I have and what are they?")
- remaining tools unchanged apart from vocabulary in their descriptions.

**Config** — `PimoteConfig` gains `managerRoot: string` (default `~`, expanded at load; validated like `roots`). It is the manager persona's working directory — deliberately distinct from the scan roots, and never scanned. Nothing consumes it in this pull (today's manager runs in a temp dir); the manager-lifecycle pull roots the manager there. It arrives now so the config surface is settled and the manager tools can already read it via `ManagerToolContext.config`.

**Persistence** — `<storeDir>/registry.json` survives with its shape: `overrides` is already path-keyed; `multiRepo` is renamed to `hubs` with read-compat for the old key. No data migration.

**Caching** — `scanFolderModel` is pure and on-demand. The RepoIndex adapter keeps its 30s TTL wrapper around it, so `list_repos` call rates are unaffected.

**Web Client** — flat curated folder list (no tree rendering this increment). Each row: one of four new inline SVGs on the left — **code**, **code-hub**, **persona**, **persona-hub** — chosen by `nature` × `shortcutCount > 0`. Persona rows display `persona.name` with `persona.description` as subtitle; code rows keep the basename. Favorite/archive/tags and hub dialogs behave as today.

### DR Supersessions

- **DR-045** (Repo index orthogonal to curated projects) — superseded, absorbed: the discovery/curation split survives verbatim, but discovery is now the folder model's sparse scan instead of the RepoIndex walk, and curation keys on canonical folder paths. New decision captured in DR-051 with provenance.
- **DR-046** (Multi-repo projects as hub folders with symlinks and a generated AGENTS.md) — superseded because "hubs are never walker-discovered repos, invisible to the repo index" no longer holds: hubs gain `git init` + a `.gitignore` for the member symlinks and are discovered as code folders whose members appear as shortcut occurrences. Symlink mechanics and the generated `AGENTS.md` contract are unchanged.
- **DR-047** (The manager agent is global and ephemeral) — not superseded; re-derived: conversation ephemerality stands _because_ persona memory is folder-resident artifacts (e.g. a `memory.md` linked from the persona's `AGENTS.md`). The manager inherits this with no special case. A proper revisit belongs to the next pull (manager lifecycle).
- **New DR-051** (Unified folder model) — the replacement record: taxonomy (code/persona via marker), sparse discovery, shortcut recursion, identity-by-canonical-path, hubs as code folders, persistence-by-artifacts. Carries provenance lines for DR-045 and DR-046 (deleted at their last recorded commits).
