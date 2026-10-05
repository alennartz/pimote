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

**`server/src/folder-model/`** — the deep module that owns folder discovery. Responsibilities: marker-aware nature classification, sparse-tree scanning (descent through skipped folders, stop at included ones, shortcut recursion), canonical-path identity with visit-once semantics. Dependencies: node `fs`/`path` + `yaml` for marker front matter — no protocol types, no server internals. Discovery sits behind `scanFolderModel`; the shared `classifyFolder` helper serves session-event fallback without adding discovery entries.

### Interfaces

**folder-model — the external interface:**

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
  /** Reach path: walked scan path or symlink-based shortcut path, skipped segments inline.
   * Reused children retain first-discovery reach paths; entry.path alone is canonical. */
  path: string;
  via: 'scan' | 'shortcut';
  entry: FolderEntry;
  /** First-discovery shortcuts; in-progress cycle back-references are leaves. */
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
  readFile(path: string): Promise<string>; // UTF-8 AGENTS.md contents
}

export interface FolderScanWarning {
  path: string;
  operation: 'readdir' | 'lstat' | 'realpath' | 'readFile';
  error: unknown;
}

export interface ScanFolderModelOptions {
  roots: string[];
  fs?: FolderFs;
  onWarning?: (warning: FolderScanWarning) => void; // defaults to console.warn
}

export function scanFolderModel(options: ScanFolderModelOptions): Promise<SparseTree>;

/** Session-event fallback only: apply marker/git classification to one cwd,
 * returning code when neither marker exists; does not make it a discovered entry. */
export function classifyFolder(
  fs: FolderFs,
  path: string,
): Promise<{
  nature: FolderNature;
  persona?: PersonaInfo;
}>;
```

**Discovery contract** (what the tests pin down):

1. Classify each scan root normally (no root exception), then walk directories when skipped; prune `node_modules`, `.git`, `dist`, `build`, `target`, `.venv` anywhere below a root. `.git` descent pruning is effectively unreachable: its presence includes its parent before descent. The configured root itself is not pruned by basename.
2. Classification, in order: `AGENTS.md` beginning with a YAML front-matter block (`---` … `---`) containing a string `name:` key → **persona** (marker; `name`/`description` captured into `persona`); else a `.git` entry (directory _or_ file) → **code**; else **skipped** → descend into it.
3. Marker wins over git when both are present. A marker-less, git-less `AGENTS.md` includes nothing.
4. Once a folder is **included**, descent stops. Its top-level entries that are symlinks to directories whose real path lies outside the folder become **shortcut occurrences**.
5. Entering a shortcut restarts discovery at the target: classify the target; if skipped, descend through it; its own shortcuts recur the same way.
6. Symlinks found while descending through **skipped** folders are followed like ordinary folders — no out-of-tree condition there.
7. Identity is the canonical real path; each entry is discovered once. Later encounters reference the same entry object. Completed entries reuse first-discovery children (including their reach paths); encounters with an in-progress entry emit leaf occurrences (`children: []`). Cycles terminate and the result remains finite and JSON-safe. Track skipped directories canonically too to terminate skipped-directory cycles, without losing later non-cyclic reach occurrences.
8. Skipped path structure is collapsed into occurrence `path` strings — skipped folders never appear as nodes. Occurrence paths record reach, not identity: followed-symlink segments survive in scan paths; shortcut descendants extend the symlink reach path.
9. Filesystem failures are local: missing/non-directory roots, dangling/looping symlinks, unreadable directories and unreadable `AGENTS.md` warn via `onWarning` (default `console.warn`) and do not hide healthy siblings. An unreadable marker behaves as absent, allowing git fallback or skipped descent. Malformed YAML, an unclosed front-matter block, or a non-string YAML `name` is no marker and falls back to git; quoted YAML strings are accepted.

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
  missing: boolean; // source-listed repo/hub or registry hub absent on disk
  repos?: RepoInfo[]; // registry/source hubs only; these rows are disband-eligible
  userTags?: string[]; // own-path user-removable subset of tags
  // plus the session/git chip fields ProjectInfo carries today, unchanged
}
```

**Registry seam** (renamed from `ProjectRegistryPort`):

```ts
interface FolderUpdatePatch {
  folderPath: string;
  favorite?: boolean;
  archived?: boolean;
  addTags?: string[];
  removeTags?: string[];
}

interface FolderRegistryPort {
  list(): Promise<FolderInfo[]>; // overrides merged over all included entries
  update(patch: FolderUpdatePatch): Promise<void>; // keyed by canonical path
  createHub(input: { name: string; root: string; memberPaths: string[] }): Promise<FolderInfo>;
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

- **DR-045** (Repo index orthogonal to curated projects) — superseded, absorbed: the discovery/curation split survives verbatim, but discovery is now the folder model's sparse scan instead of the RepoIndex walk, and curation keys on canonical folder paths. New decision captured in DR-053 with provenance.
- **DR-046** (Multi-repo projects as hub folders with symlinks and a generated AGENTS.md) — superseded because "hubs are never walker-discovered repos, invisible to the repo index" no longer holds: hubs gain `git init` + a `.gitignore` for the member symlinks and are discovered as code folders whose members appear as shortcut occurrences. Symlink mechanics and the generated `AGENTS.md` contract are unchanged.
- **DR-047** (The manager agent is global and ephemeral) — not superseded; re-derived: conversation ephemerality stands _because_ persona memory is folder-resident artifacts (e.g. a `memory.md` linked from the persona's `AGENTS.md`). The manager inherits this with no special case. A proper revisit belongs to the next pull (manager lifecycle).
- **New DR-053** (Unified folder model) — the replacement record: taxonomy (code/persona via marker), sparse discovery, shortcut recursion, identity-by-canonical-path, hubs as code folders, persistence-by-artifacts. Carries provenance lines for DR-045 and DR-046 (deleted at their last recorded commits).

## Tests

**Pre-test-write commit:** `d9cac01064653cb9ece35e79338883e4c1bb6c51`

### Interface Files

- `server/src/folder-model/index.ts` — the folder-model module's entire external interface: `FolderNature`, `PersonaInfo`, `FolderEntry`, `FolderOccurrence`, `SparseTree`, `FolderFs`, `ScanFolderModelOptions`, and the `scanFolderModel` stub (throws `"not implemented"`). Note: `FolderFs` gained a fourth operation, `readFile(path): Promise<string>`, beyond the plan's `readdir`/`lstat`/`realpath` — the discovery contract must read `AGENTS.md` content to detect the front-matter marker, and the seam is documented as "the only fs operations the scanner performs; injectable for tests", so content reads must pass through it.
- `shared/src/protocol.ts` — `FolderInfo` wire type added (the `ProjectInfo` successor: `nature`, `persona`, `shortcutCount`, `missing`, required `favorite`/`archived`/`tags`, plus ProjectInfo's session/git chip fields `activeSessionCount`/`externalProcessCount`). Added alongside `ProjectInfo`; the rename/reshaping of live call sites belongs to the implementation pull.
- `server/src/manager/types.ts` — `FolderModelPort` (`{ tree(): Promise<SparseTree> }`), `FolderUpdatePatch` (curation patch keyed by `folderPath`), and `FolderRegistryPort` (`list`/`update`/`createHub`/`disbandHub`) as the folder-model successors of `ProjectRegistryPort`. `ManagerToolContext`'s `projects`→`folders` rename plus its `tree` field is deferred to the implementation pull: it forces renames through live manager/registry behavior, which is not structural work.

### Test Files

- `server/src/folder-model/folder-model.test.ts` — 43 behavioral cases of `scanFolderModel` against an in-memory `FolderFs` fake (deterministic, no real filesystem): classification taxonomy, YAML boundaries, pruning, sparse descent, shortcut occurrences and recursion, visit-once identity, included roots, multi-root and empty boundaries, and local filesystem failure warnings. All 43 remain red after review (the stub throws `"not implemented"`); this is the expected Red Gate, not a review defect.

**Approved scope:** this phase pins the scanner seam. Registry merge (including personas), hub materialization, config, manager tool wiring, and UI icon boundary tests will be written red-green during implementation against the Interfaces above. Persona artifact memory and manager lifecycle remain outside this increment. The approved implementation additions retain `root` on hub creation, `repos`/`userTags` on FolderInfo, strict session-record GC safety, and a shared single-cwd classifier for unlisted session events; Step 8 records the one pending SDK rename carve-out.

### Behaviors Covered

#### Classification (discovery contract rules 2–3)

- A folder whose `AGENTS.md` begins with a YAML front-matter block containing a string `name:` key is a persona: the entry carries `persona` with the front-matter name and description (description omitted when absent); `name` is the folder's basename, never the persona name; extra front-matter keys are ignored.
- A folder with a `.git` directory or a `.git` file is code; code entries carry no `persona`.
- Marker wins over git when both are present.
- Front matter without a `name:` key, an `AGENTS.md` without front matter, and a front-matter block that does not begin the file are not markers: the folder stays skipped and descent continues through it.
- `package.json` alone is not an inclusion marker.

#### Pruning (rule 1)

- `node_modules`, `dist`, `build`, `target`, `.venv` below a root are never entered — folders hidden inside them are undiscovered — while sibling folders are found normally. `.git` is a classification marker before descent, so no contradictory fixture treats its parent as skipped.
- Pruning applies at any depth below a root.

#### Sparse descent (rules 3, 8)

- Discovery descends through skipped folders to included ones; skipped folders never appear as nodes and their segments survive only inside the occurrence's `path` string.
- Descent stops at an included folder: nested git repos and nested persona markers are never separately included.

#### Shortcuts (rules 4–6)

- A top-level symlink of an included folder whose real path lies outside the folder becomes a shortcut occurrence (via `'shortcut'`) wrapping the target's entry.
- Entering a shortcut restarts discovery at the target: the target is classified and its own shortcuts recur as nested shortcut occurrences.
- If the shortcut target is skipped, discovery descends through it: each included folder found below becomes a shortcut occurrence whose `path` extends the symlink path with the collapsed skipped structure; the skipped target itself is never an entry.
- Top-level symlinks that resolve inside the folder, and symlinks to files, are not shortcuts.
- Symlinks met during skipped descent are followed like ordinary folders — no out-of-tree condition; the target-side folder surfaces as a scan occurrence.

#### Identity (rule 7)

- Identity is the canonical real path: one entry per folder no matter how many shortcuts reach it; later occurrences reference the same entry.
- Children come from the first discovery: a later shortcut occurrence carries the same target shortcuts as the first-discovery occurrence (the paths of shared children are deliberately unpinned).
- Shortcut cycles terminate; the back-reference occurrence points at the already-discovered entry.

#### Roots

- Every configured root is scanned; scan occurrences from all roots land in one flat `occurrences` list.
- Empty roots list yields `{ occurrences: [] }`; an all-skipped tree yields `{ occurrences: [] }`.

### Contract interpretations pinned by these tests

Approved during test review — the architecture above now incorporates these interpretations:

1. **`FolderFs.readFile`** added (see Interface Files) — the marker contract cannot be expressed through `readdir`/`lstat`/`realpath` alone.
2. **Occurrence `path` is the reach path.** Scanned occurrences use the walked path from the root (skipped and followed-symlink segments inline); shortcut occurrences extend their parent occurrence's path. This is what makes rule 8 ("skipped path structure is collapsed into occurrence `path` strings") hold in the two edge cases — descent through a skipped-context symlink, and a shortcut whose target has skipped structure — where the type comment's "real directory path / symlink path" is too terse.
3. **Rule 7's "(children come from the first discovery)"**: completed entries carry first-discovery children with original reach paths; in-progress back-references are leaves. Same-entry references use object identity; skipped-directory cycles also terminate.
4. **`FolderUpdatePatch`** shape was not given in the plan; approved as the `ProjectUpdatePatch` rename keyed by `folderPath` (`favorite`/`archived`/`addTags`/`removeTags`).
5. **Roots, failures, and scope:** roots classify normally; local filesystem failures warn through the new optional warning callback; this gate covers the scanner only, with other planned boundary tests deferred to implementation.

### Review-added coverage

- Quoted YAML strings, full agent-definition extra keys, non-string YAML names, malformed/unclosed blocks, and marker-less git fallback.
- Included code/persona roots, shared-prefix sibling containment, in-tree skipped-context symlinks, pruning under skipped shortcut targets.
- Shared entry object identity, finite/JSON-safe included cycles, and skipped-directory cycle termination.
- Missing/non-directory roots; dangling/looping shortcuts; local `readdir`/`lstat`/`realpath` failures; unreadable markers with git fallback or continued descent. Warning assertions use the public callback, not global console spies.

**Review status:** approved

## Steps

**Pre-implementation commit:** `df02e7cca702b702fe3e4f5d14790fe1e8efae13`

Execution notes: keep the 43 scanner cases in `server/src/folder-model/folder-model.test.ts` immutable. The other seams follow the approved red-green implementation scope: exercise each changed contract before implementing it, using the existing registry, adapter, manager, boot, and client test suites. Do not create separate test-writing phases. Existing tests for superseded walkers must be retired or revised to the new discovery contract, not used to preserve depth bounds or package.json inclusion. Preserve existing cache/queue/subscription state holders; introduce no process-global mutable discovery state. Compute classification and merged views from explicit inputs, with filesystem, persistence, and notification effects at the edges.

### Step 1: Implement folder discovery

Implement `scanFolderModel` behind `server/src/folder-model/index.ts`; private files within that directory may hold marker parsing and traversal. Install `yaml` with `npm install yaml --workspace=@pimote/server` rather than editing manifests. Update the module comment to describe node fs/path plus YAML parsing, without importing protocol or server internals. Supply the default Node adapter for all four `FolderFs` operations; reads are UTF-8 and failures use `onWarning`, defaulting to `console.warn`.

Implement the nine Discovery rules without the old repo walk's depth limit: roots classify normally, skipped structure collapses into reach paths, included entries stop ordinary descent, shortcuts restart discovery, and all identities use canonical paths. Preserve first-discovery children, shared entry objects, leaf back-references, finite JSON serialization, and skipped-cycle termination without dropping later non-cyclic reaches. Marker parsing must handle real YAML strings, malformed blocks, and git fallback. Keep visited/in-progress state local to each scan, not shared across scans.

Expose the approved `classifyFolder(fs, path)` helper alongside the scanner for session-event fallback. Share marker/git classification with discovery; only this fallback returns `nature: 'code'` when neither marker exists. It does not add a skipped cwd to discovery. Keep scanner warning behavior independent of this fallback policy.

**Verify:** `npm test --workspace server -- --run src/folder-model/folder-model.test.ts` passes all 43 unchanged cases; `npx tsc -b server --pretty false` passes. Repeated scans have independent identity state.
**Status:** done

### Step 2: Extract session records

Create `server/src/session-records.ts` with a `SessionRecords` state holder accepting `SessionSummaryIndex` (defaulting to today's instance). Move `listSessionRecords`, `resolveSessionPath`, `deleteSession`, and `renameSession` from `folder-index.ts`, preserving result types, missing-session behavior, summary caching, append-session-info renaming, and strict `failOnError` enumeration. Retain `listSessions`' existing ISO-date mapping if used by the migrated session tests; it is a session-record convenience, not discovery. Rename the strict options type to session-record vocabulary.

Replace `FolderIndex` injection with `SessionRecords` in `server/src/index.ts`, `server.ts`, `ws-handler.ts`, and their tests. Pass roots from config/RepoIndex to the creation-root checks rather than putting discovery back into SessionRecords. Move the session-record assertions from `folder-index.test.ts` into `session-records.test.ts`; retire its obsolete roots/one-level marker-discovery assertions. Delete `server/src/folder-index.ts` and its obsolete test file after all imports are removed. Do not change `session-summaries.ts`' cache or session directory encoding.

**Verify:** session-record, session-summary, WS session listing/open/resume/delete/rename/archive, and manager archive-port tests pass. `rg 'folder-index|FolderIndex' server/src` finds no live references; SessionRecords performs no folder discovery.
**Status:** done

### Step 3: Replace boot discovery safely

In `server/src/index.ts`, derive the static-host/download boot allow-list from `scanFolderModel({ roots: config.roots, onWarning })`, deduplicating canonical entry paths across the entire occurrence tree, including shortcut descendants. Enumerate those folders through `SessionRecords.listSessionRecords(path, { failOnError: true })`.

A scanner warning at a configured root for missing/non-directory/unreadable root access suppresses the sweep; warnings below a root, including unreadable markers, dangling symlinks, and unreadable subdirectories, do not. Distinguish root-access operations from an `AGENTS.md` content warning; do not abort on every warning. Session-record enumeration failures still suppress the sweep, preserving the complete-allow-list safety rule. Continue passing `validSessionIds: null` to `bootstrapFileDownloads` on suppressed enumeration; never substitute an empty allow-list on failure. The removal of package.json-only folders from the valid-folder set is intentional.

**Verify:** `server/src/index.test.ts` preserves strict session-enumeration failure coverage and exercises root-warning suppression versus below-root warnings permitting GC. Static-host and file-download suites pass; duplicate occurrences do not trigger duplicate session enumeration.
**Status:** done

### Step 4: Adapt the repo index

Replace `walkRoot`/`scanDir` and their bounded-depth constants in `server/src/repo-index.ts` with `scanFolderModel` consumption. Collect unique canonical code entries from all occurrences, including shortcut targets outside roots and discovered hubs; exclude persona entries even when they contain git. Retain the public `list(): Promise<RepoInfo[]>`, roots getter, listing/status TTLs, stale-while-revalidate behavior, single-flight protection, invalidation generation, neutral failed git probes, and change-only refresh notifications.

Keep registered source contribution merging and open hooks, including ergonomic bare repo shapes, source failure isolation, tags, missing source repo placeholders, and separate source hub metadata. Discovery no longer crawls through an included repo looking for nested repos. Update `repo-index.test.ts`' obsolete depth/symlink expectations to the scanner-backed behavior while retaining its cache, git-status, and source tests. Do not filter `list_repos` to configured roots or exclude hubs: the adapter's complete code-folder view is intentional.

**Verify:** repo-index tests pass for sparse stopping, personas excluded, shortcuts included, source merging/missing flags, TTL/status refresh, and unchanged hook ordering. No second recursive folder walker remains in `repo-index.ts`.
**Status:** done

### Step 5: Make hubs self-describing

Extend `server/src/project-sources/materialize.ts`' shared materializer with `git init` and a `.gitignore` listing member symlink basenames. Keep absolute symlinks and generated `AGENTS.md` content unchanged, including the member instructions precedence contract. Guard git environment variables as the built-in creator already does. Both explicit hub creation and missing-source-hub open-time materialization must use this function, not duplicate the layout.

Preserve validation before effects (name, known code-member paths, basename collisions, existing target) and the registry's all-or-nothing cleanup on materialization or persistence failure. Leave existing source hub directories untouched on open, including pre-existing git-less hubs; do not backfill `git init` during listing or startup.

**Verify:** materialization/registry/source-open tests confirm `.git`, ignored member links, unchanged AGENTS.md, source hooks after layout creation, member repos surviving deletion, and cleanup after failure. A newly materialized hub scans as code with member shortcut occurrences; a pre-existing hub is not modified.
**Status:** done

### Step 6: Build the folder registry

Rename `server/src/project-registry.ts` and its suite to `folder-registry.ts`/`folder-registry.test.ts`, exporting `FolderRegistry` and folder update vocabulary. Inject the folder-tree port alongside RepoIndex and storeDir; merge the scan's unique canonical entries with source-listed repos/hubs and registry hubs rather than deriving the entire list from repos. Keep classification/merge logic behind this module, with pure view construction and explicit persistence effects.

Use `FolderInfo` from `shared/src/protocol.ts`, retaining `repos?: RepoInfo[]` only on registry/source hubs and `userTags?: string[]` for removable own-path tags. Default `favorite`, `archived`, and `missing` to false and `tags` to an empty array. Merge persona metadata and basename entry names; set `shortcutCount` from first-discovery immediate shortcut children. Preserve member git chips and tag unions (source + own user tags + member tags), favorites ordering, canonical-path curation, mutation serialization, atomic writes, reload-on-failure, and subscriptions. On path collisions enrich an existing scanned row with registry/source hub metadata instead of losing membership because discovery saw it first; persisted hub metadata wins over source metadata as today.

Source-listed repos/hubs and registry hubs absent on disk get `missing: true`; orphaned curation overrides alone produce no row. Pre-existing registry hubs without git remain listed as `nature: 'code'`, `shortcutCount: memberPaths.length`, without disk changes. Preserve path-keyed override orphaning on moves. `update` accepts all listed code/persona/source/registry paths, rejecting unknown paths.

Persist `hubs` instead of `multiRepo` in the unchanged `registry.json` store location, reading old `multiRepo` documents compatibly. Prefer `hubs` when the new key exists; preserve valid entries, override flags, and user tags, and retain malformed-entry isolation/legacy-order stripping. No store-directory move or bulk migration. Implement `createHub({ name, root, memberPaths }): Promise<FolderInfo>` and `disbandHub(folderPath)` with existing safety/ownership behavior. Source hubs retain the current refusal to disband when there is no persisted registry entry; their UI eligibility does not grant deletion ownership. Keep the active-session enrichment helper typed for FolderInfo and shared by all serve paths.

**Verify:** folder-registry tests exercise code/persona curation, discovered hub collisions, legacy/new persistence, orphan overrides omitted, absent source/registry rows, git-less legacy hubs, required defaults, tags/member chips, createHub's full FolderInfo result, disband safety, notifications, and recovery after failed writes. Existing registry data round-trips without loss.
**Status:** done

### Step 7: Rename the wire and WS routes

In `shared/src/protocol.ts`, promote FolderInfo to the live type, add its approved optional `repos`/`userTags`, correct the `missing` comment, and remove ProjectInfo. Rename command/response/event types and union members for `list_folders`, `update_folder`, `create_hub`, `disband_hub`, and `folders_changed`. Use `folders` list/event payloads, `folderPath` for curation/disband paths, and `memberPaths` plus unchanged `root` for create_hub. Its path-only response becomes `{ folderPath: string }`; the registry operation itself returns FolderInfo. Change session-opened/replaced and open-session response folder fields to FolderInfo. Update mirror commentary to acknowledge Android's existing FolderInfo/list_folders vocabulary without editing Kotlin.

Update `server/src/ws-handler.ts`, `server.ts`, `index.ts`, and their test fixtures as one server-side rename unit: inject FolderRegistry, route the new commands, validate create_hub root against configured roots, broadcast `folders_changed` after curation/hub/create-folder changes and changed repo refreshes, and preserve live session count enrichment. Invalidate RepoIndex after hub disk changes so a subsequent member-picker/list_repos request sees the new filesystem state. Keep server response admission/error behavior and two-client sync.

Replace `buildProjectInfo` with an asynchronous folder resolver used by open, takeover, and session replacement. Listed paths use registry FolderInfo so persona metadata and curation are preserved. Unlisted arbitrary-cwd workflows remain supported: call `classifyFolder` with the Node FolderFs adapter, then return basename, that nature/persona, `shortcutCount: 0`, `favorite/archived: false`, `tags: []`, `missing: false`, and the existing session counts. Do not list or curate the fallback cwd merely because a session was opened there.

**Verify:** build shared types with `npm run build:shared`; WS/server/boot tests pass for renamed payloads, counts, root validation, broadcasts, hub errors, and listed/unlisted persona session events. No live ProjectInfo or old curated command/event tokens remain in server/shared. Client migration follows next; intermediate cross-workspace type errors are confined to that pending unit.
**Status:** done

### Step 8: Settle the SDK rename carve-out

**Selected variant (scope ruling): FULL-RENAME.** The published `@pimote/sdk` seam renames to folder vocabulary with a documented 0.x breaking bump and no compatibility type aliases — "project" survives nowhere in product vocabulary. Public successors/compatibility seams:

- `ProjectSource`→`FolderSource`, `ProjectCreator`→`FolderCreator`, `ProjectCreatorDescriptor`→`FolderCreatorDescriptor`, `ProjectCreatorParamType`→`FolderCreatorParamType`
- `MultiRepoSourceEntry`→`HubSourceEntry`; entry discriminator `kind: 'project'`→`kind: 'hub'`
- source hook `onProjectOpen`→`onFolderOpen` (parameter `projectPath`→`folderPath`)
- package subpath and source directory `@pimote/sdk/projects`→`@pimote/sdk/folders`
- config key `projectSourcesDir`→`folderSourcesDir` with legacy-key read compat (compatibility seam, documented)
- physical default sources dir `~/.pimote/project-sources`→`~/.pimote/folder-sources` with legacy-dir fallback so existing installed sources keep loading (compatibility seam, documented)
- server directory `server/src/project-sources`→`server/src/folder-sources` with folder-vocabulary internals (`loadFolderSources`, `LoadedFolderSources`, …)
- wire command `create_project`→`create_folder`; manager tool parameter/output keys `projectPath`→`folderPath` (tool names: only `pimote_list_projects`→`pimote_list_folders` plus new `pimote_folder_tree`)
- SDK version 0.14.0→0.15.0 with a breaking-change note in the SDK README
- Android and unrelated agent extensions untouched; historical DRs, brainstorms, and superseded plans keep their wording

**Either/or — resolved by scope ruling; the FULL-RENAME variant below is selected (see the successor table above).** This is the sole unresolved rename-scope point, not permission to invent a new source contract.

- **Stable SDK variant (architecture's current carve-out):** leave `packages/sdk`, Android, and agent extensions untouched. Keep SDK `ProjectSource`/`ProjectCreator`, `MultiRepoSourceEntry`, `kind: 'project'`, source hook `onProjectOpen`, `projectSourcesDir`, and the published `@pimote/sdk/projects` entrypoint stable. Server adapters may use folder/hub local vocabulary while translating through those stable types. Keep the `create_project` command and remaining manager tools' `projectPath` parameter/output keys as currently specified; only their descriptions change. Update `server/src/project-sources/builtin.ts`' registry import after the file rename without renaming the published seam. Keep persistence/config physical paths stable.
- **Full source/creator rename variant (only if explicitly approved):** perform a separate coherent source/creator rename through `packages/sdk/src/projects/**` and its exports, `server/src/project-sources/**`, `repo-index.ts`, `index.ts`, `config.ts`, `paths.ts`, `ws-handler.ts`, NewSessionDialog, their suites, and source documentation/smoke fixtures. The user decision must specify the public successors/compatibility aliases for source types, entry discriminators, hook names, package subpath, config key, and `create_project`/manager parameter keys before changing them. Preserve source entry behavior, hook order, lazy materialization, creator behavior, registry storage, and existing installed source loading. Do not turn a mechanical rename into discovery or lifecycle redesign. This variant explicitly replaces the current SDK-untouched carve-out; Android and unrelated agent extensions remain untouched.

**Verify:** the chosen variant is recorded here, public export/type checks pass, and source loader/built-in creator/index hook suites pass. Search distinguishes intentional compatibility names from missed live-call-site renames; do not blindly replace every occurrence of “project.”
**Status:** done

### Step 9: Add managerRoot configuration

Add required loaded `managerRoot: string` to `PimoteConfig` in `server/src/config.ts`: default `~`, expand leading `~`/`~/` to the home directory at load, validate an explicitly supplied value as a string, and report config errors consistently with roots. Today's roots validation is string-based, not filesystem-existence validation; do not add existence checks for managerRoot or silently alter roots semantics. Update typed config fixtures across affected server tests and document the option in README's config table/example. Preserve concurrent `tagSnippets` and file-editor config fields.

Pass the loaded value through ManagerToolContext.config. Do not append managerRoot to scan roots or move the manager's actual cwd from its current temporary resource directory; that lifecycle change belongs to the next pull.

**Verify:** config tests cover default home expansion, explicit absolute/tilde paths, invalid values, and unchanged roots; manager factory/boot tests still use today's lifecycle and tree scans use config.roots only.
**Status:** done

### Step 10: Wire manager folder tools

Update `server/src/manager/types.ts`/`index.ts` to export FolderRegistryPort, FolderUpdatePatch, and FolderModelPort, remove ProjectRegistryPort, include `root` in createHub input, and replace ManagerToolContext.projects with `.folders` plus `.tree`. Construct the tree port in `server/src/index.ts` as an on-demand `scanFolderModel({ roots: config.roots })` closure and inject it into both registry and manager; do not add a shared scanner cache. Migrate search/archive known-folder enumeration to FolderRegistry and session-record calls to SessionRecords.

In `server/src/manager/extension.ts`, rename `pimote_list_projects` to `pimote_list_folders`, update its structured output schema to all FolderInfo fields (including optional hub repos/userTags), and preserve enriched live counts. Register read-only, zero-argument `pimote_folder_tree` returning the injected SparseTree as structured JSON, with a recursive occurrence schema matching entry/path/via/children. Keep tree types in folder-model/manager, not the wire protocol, since there is no tree WS command. Describe code/persona, canonical identity versus reach paths, and unfiltered repo discovery accurately. Preserve the other tools' behavior; apply parameter naming only according to Step 8's selected variant.

**Verify:** manager extension and boot-port wiring tests pass for exact tool registration, FolderInfo schema/defaults, persona search/start paths, live counts, and finite recursive tree output. Tools use only injected ports and never raw filesystem access.
**Status:** done

### Step 11: Rename the client data flow

Rename `client/src/lib/stores/project-store.svelte.ts` and its suite to `folder-store.svelte.ts`/`folder-store.svelte.test.ts`, exporting FolderStore/folderStore with `folders`, `visibleFolders`, `loadFolders`, and `applyFoldersChanged`. Consume the new list/event payloads and FolderInfo; preserve per-connection loading, first-paint behavior, stale event routing, single-flight repo/session loads, archived filters, session recency ordering, and session-event reducers.

Rename ProjectList files to FolderList and update imports/references in `Dashboard.svelte`, `NewSessionDialog.svelte`, and client tests. Rename client-owned list variables/actions and presentation copy coherently, sending `update_folder`, `create_hub` (root/memberPaths), and `disband_hub` (folderPath). Retain the NewSessionDialog creation wire seam chosen in Step 8. Preserve Agent instructions/file-editor integration and tag snippet behavior. Do not rename unrelated wire/push metadata merely because it contains a project word.

**Verify:** folder-store tests, connection tests, manager-store fixtures, Dashboard/NewSessionDialog suites, and `npm run check --workspace=client` pass. Reconnect loads list_folders once; folders_changed replaces the list without wiping live session indicators.
**Status:** done

### Step 12: Render folder nature and hub state

In `client/src/lib/components/FolderList.svelte`, render four distinct inline SVG row icons selected only by `nature` × `shortcutCount > 0`: code, code-hub, persona, persona-hub. Persona rows show `persona.name` with optional description as subtitle; code rows retain basename. Keep row keys, curation patches, and session lookup keyed by canonical path. Make persona display names discoverable in the existing client-side folder search/picker without changing session-search semantics.

Replace `kind === 'multi'` membership-chip/disband eligibility with `repos !== undefined`; a shortcut-bearing folder gets a hub icon without automatically gaining registry deletion rights. Use FolderInfo.missing for row missing behavior instead of inferring it from whether all members are missing. Keep the flat list, member/git/tag chips, removable userTags, favorites/archive behavior, session expanders, live badges, and create/disband dialog workflows; relabel dialogs to hub vocabulary without adding editing/lifecycle features. Preserve the existing unavailable-source disband error path.

**Verify:** FolderList UI tests cover all four icon selections, persona name/subtitle, code basename, generic shortcut hubs versus registry/source hub menu eligibility, missing rows, chips, tags, and create/disband command payloads. Existing file-editor, session-expander, archive, and favorites regressions pass; no tree UI is introduced.
**Status:** done

### Step 13: Update smoke fixtures and documentation

Update `tools/manual-test/project-management-smoke/project-management-smoke.mjs` in its existing location, plus `tools/manual-test/PLAN.md`/`README.md`, for folder/hub wire vocabulary, FolderInfo defaults, manager tool names, and scanner semantics. Remove the obsolete depth-bound/nested-repo expectations: fixtures must place discoverable nested entries beneath skipped wrappers, not inside included git repos. Keep two-client sync, warm-cache/reconnect, session/history, source hooks, hub disband, and manager workflows. Add persona and shortcut-linked external repo fixture coverage to the existing journey, including the four icon variants where applicable.

Refresh stale `codemap.md` ownership/responsibilities for folder-model/, session-records.ts, folder-registry.ts, FolderList/folder-store, sparse scanning, and the restored Android naming alignment. Update README's dashboard/discovery/config/hub description (no depth-three claim, no reordering feature claim); keep SDK compatibility documentation aligned with Step 8. Maintain glossary's existing code/persona/shortcut terms. Do not edit external `product-manager/AGENTS.md` or root its lifecycle here: the brainstorm's bootstrap note is not a repository implementation interface.

**Verify:** the documented sandboxed smoke driver passes with the new wire surface; source fixtures match the selected SDK variant. `rg` checks find no stale live curated-project commands/types/imports, except deliberately retained compatibility seams, historical DRs, and historical artifacts. Codemap points to existing renamed files.
**Status:** done

### Step 14: Record the decision and validate the slice

Following the decision-records skill, create `docs/decisions/DR-053-unified-folder-model.md` with the approved taxonomy/marker choice, sparse discovery and shortcut identity, hubs as git repos, canonical-path curation trade-off, and artifact-resident persona persistence. Capture DR-045/046's last commit hashes with `git log -1 --format=%H -- <file>`, include their provenance in DR-053, then delete those superseded records. Leave DR-047 accepted and DR-051/052 untouched. Explain rejected alternatives and accepted costs rather than writing a feature inventory. Do not implement persona memory or manager lifecycle.

Run the complete server/client regression suites and production checks after the coherent rename units converge. Inspect diffs for accidental physical registry/config directory moves, SDK/Android/extension edits outside the selected scope, scanner test changes, lifecycle changes, and unrelated concurrent edits. Exercise the running pimote-in-pimote workflow against the built slice without interrupting its current session; deployment/restart is not an implicit part of this step.

**Verify:** `npm test --workspace server -- --run`, `npm test --workspace client -- --run`, `npm run build`, `npm run check`, `npm run lint`, and formatting checks pass; the folder-management smoke passes. All 43 scanner cases remain unchanged and green, DR-053 has both provenance lines, and existing registry/session artifacts survive the renamed surfaces.
**Status:** not started
