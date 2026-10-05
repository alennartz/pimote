# Review: Folder model foundation

**Plan:** `docs/plans/folder-model-foundation.md`
**Diff range:** `df02e7cca702b702fe3e4f5d14790fe1e8efae13..2ad0b32`
**Date:** 2026-10-05

**Method:** Plan adherence ran on the `medium` tier; code correctness was fanned out across seam-scoped passes. The `smart` tier (prescribed for correctness) failed ~50% of spawned sessions today with provider-side encrypted-content corruption, so the last two scopes (folder-model internals; session-records/repo-index) were re-run on `medium` with the orchestrator's approval — scanner internals and the extractions had already been covered by pre-implementation test stamping, so the coverage gap is small. Concurrent uncommitted work in `ws-handler*`, `session-manager.ts`, and `session-registry*` (another workstream) was excluded from review. Wire-mirrored `projectName`, generated hub `AGENTS.md` prose, and historical doc wording are plan-frozen retentions and were not flagged.

## Summary

The plan was implemented faithfully: all 14 steps are done, the 43 scanner tests are byte-identical across the range and green, and the full server (807) and client (746) suites, build, check, lint, and formatting pass at `2ad0b32`. No critical findings. The 16 warnings cluster in failure-path edges the test suites don't pin — GC completeness under transient per-file errors, symlink/canonical-identity mismatches, hub materialization partial failure, stale-response races, and unbounded expansion of shared shortcut structure — plus one agent-facing tool description that over-promises persona exclusion.

## Findings

### 1. Transient per-file summary failures silently drop sessions from the GC allow-list

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/session-summaries.ts:124-165, 213-225`; surfaces at `server/src/session-records.ts:30-41`, `server/src/index.ts:314-321`
- **Status:** open

`summarize()` conflates "not a session file" with "read/parse failed" via a whole-body `catch { return null }`, and the `null` is then cached under the file's current (mtime, size). `enumerateValidSessionIds` relies on `failOnError: true` precisely because the static-host/download sweep must never run on an incomplete allow-list — but strictness is enforced only at directory level. A transient mid-stream read error (or one malformed entry, e.g. `"message": null` making `isMessageWithContent` throw) removes that session's id from the allow-list, and the cache pins the omission until the file is modified. The sweep then permanently deletes that session's persisted hosting/download registrations. The same cause makes `renameSession`/`deleteSession` report "Session not found" for existing-but-unreadable files (`session-records.ts:61-68`).

### 2. Boot GC loses registrations for symlink-alias sessions

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/index.ts:315-319`
- **Status:** open

Discovery canonicalizes folder paths, but pi's session-directory encoding resolves paths lexically. If `/workspace/app` is a symlink to `/srv/app` and a session was opened via `/workspace/app`, boot now enumerates only `/srv/app`'s session directory (the canonical entry), omits the alias-path session id, and deletes its static-host/download registration JSON. The old `FolderIndex.scan()` retained `/workspace/app` and enumerated that directory. Session and source artifacts survive, but persisted hosting/download registrations are lost on every restart.

### 3. One unparseable session header timestamp crashes the folder's whole session listing

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/session-summaries.ts:155-159`
- **Status:** open

`summarize()` builds `modified` with a NaN fallback chain but `created: new Date(header.timestamp as string)` gets none. A session file with a missing or garbage `timestamp` yields `created = Invalid Date`, and every consumer then calls `created.toISOString()`, which throws `RangeError: Invalid time value` outside `listSessionRecords`'s try/catch. `list_sessions` and manager session search fail for the whole folder until the file is fixed by hand.

### 4. Scanner descends through an already-included folder on transient re-read failure

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-model/traversal.ts:55-78`
- **Status:** open

`discoverFolder` does `readdir` + `classifyListing` before the `ctx.entries` identity check, so reuse of a known entry depends on the filesystem cooperating again. If the marker read fails transiently on a persona folder with no `.git`, classification returns `null` and the scanner descends through an already-included folder, surfacing its subfolders as separate entries (violating "descent stops at an included folder") and poisoning `ctx.entries` for the rest of the scan. If `readdir` fails at the later reach, the encounter vanishes instead of referencing the shared entry (rule 7). Checking `ctx.entries` before re-reading also removes redundant I/O.

### 5. `invalidate()` during an in-flight walk serves pre-invalidation entries

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/repo-index.ts:162-179, 272-276`
- **Status:** open

If `invalidate()` lands while walk W is in flight (e.g. `create_folder` invalidates and broadcasts, then `list()` is called), the second `list()` sees `listing === null` but joins the still-running `listingPromise` W and serves pre-create entries to every client; only a later `list()` re-walks. The documented contract ("next `list()` re-walks", pinned by `repo-index.test.ts:364`, which has no concurrent walk) holds only when no walk is in flight; walk duration is ~0.5s per the class docstring, so the window is real.

### 6. Source merge silently drops source-contributed `tags`/`lastActivity` for scanned paths

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/repo-index.ts:321` (merge) with scan-built entries at `repo-index.ts:290-292`
- **Status:** open

`collectCodeEntries` seeds `byPath` with bare entries (no `tags`/`lastActivity`); the source merge keeps the scan row and discards the source row whenever the scan discovered the path. A source listing `{kind:'repo', path:'/root/myrepo', tags:['work']}` under a scan root therefore never surfaces its tags in `list_repos` or the registry's tag union (`folder-registry.ts:198`), while the same source's out-of-tree paths keep theirs — data loss that half-works. Only the external-path case is tested (`repo-index.test.ts:219-228`).

### 7. `pimote_list_repos` description promises persona exclusion the source merge does not enforce

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/manager/extension.ts:200-204` (description) vs `server/src/repo-index.ts:314-322` (behavior)
- **Status:** open

The tool description (and `repo-index.ts:89-93`'s docstring) states "Persona folders are excluded even when git-initialized", but persona filtering exists only for scan entries (`repo-index.ts:63`). Source merge adds every repo-kind source entry unconditionally, and source paths outside the scan roots are never classified at all. A registered source listing a persona-natured folder gets it back as a git-repository row — the agent-facing output misrepresents persona homes as repos. The folder list's `nature: 'persona'` handling is unaffected; the defect is confined to the repo view and its description.

### 8. `createHub` persists a non-canonical identity

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:339-345`
- **Status:** open

`createHub()` persists `join(root, name)` without resolving its real path. With a configured symlink root (`/alias → /real`), creation persists `/alias/hub` while discovery identifies `/real/hub`: `list()` returns two rows for the same directory, the canonical scanned row lacks hub membership, and favorite/tag updates on one row don't reach the other. This contradicts the plan's canonical-path curation contract (Step 6). Confirmed by repro.

### 9. Failed source-hub materialization leaves a permanently incomplete hub

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-sources/materialize.ts:16-25`
- **Status:** open

The shared materializer creates the directory and layout before `git init` with no rollback. Registry `createHub` compensates externally, but source-open materialization does not: if `git` is unavailable on the first open of a missing source hub, the directory is left behind; the retry succeeds without initializing `.git` because open-time materialization skips existing directories. The hub is then permanently git-less and undiscoverable as code. Cleanup and exclusive directory ownership belong in the shared operation so both entry paths get the same guarantees. Confirmed by repro.

### 10. Hub member names are written as raw gitignore patterns

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-sources/materialize.ts:28-30`
- **Status:** open

Member basenames go into `.gitignore` verbatim, although valid filesystem names contain gitignore syntax. A member named `#member` produces a comment instead of an ignore rule and stays visible in `git status`; names containing `*`, `?`, or brackets can hide unrelated hub files. Rules should be escaped and root-anchored. Confirmed by repro.

### 11. `renameSession` reports success without persisting when the file vanishes mid-operation

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/session-records.ts:71-80`
- **Status:** open

If the session file is deleted between `resolveSessionPath` and `SessionManager.open` (concurrent `delete_session`, manual `rm`), pi's `open()` runs `newSession()` with `flushed=false` and `appendSessionInfo`'s `_persist` early-returns — nothing is written, yet `renameSession` returns `true`. The WS layer broadcasts `session_renamed` and the client shows the new name; the next listing shows the old name or nothing. The same race makes `deleteSession`'s bare `unlink` (`session-records.ts:86`) throw ENOENT surfaced as a generic error.

### 12. `pimote_folder_tree` output grows exponentially with shared shortcut descendants

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/manager/extension.ts:181-194`
- **Status:** open

The tool passes the whole `SparseTree` to `jsonToolResult`, whose `JSON.stringify` unfolds the shared-entry DAG once per reach. Verified with 17 real git folders each having two symlinks to the next: discovery ~11 ms, serialization **24.7 MB**, doubling per level — ~25 folders can exceed the string limit or OOM, blocking the shared server event loop. Cycles are finite but shared descendants are not bounded. The tool needs a bounded representation or explicit truncation.

### 13. Skipped-tree traversal is exponential on symlink-dense DAGs

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-model/traversal.ts:116-137`
- **Status:** open

Cycle termination is guaranteed, but work is proportional to distinct _reach paths_, not folders: a layered DAG of skipped folders with a real child and a symlink to it, repeated n deep, yields 2ⁿ fully re-read descent paths and exponentially many occurrences. The plan deliberately dropped the depth limit and forbids global visited-once for skipped dirs (to preserve later non-cyclic reaches), so this is contract-permitted but unbounded CPU/memory — a backup/overlay symlink farm under a scanned `~` can hang the traversal and balloon the tree object. A per-scan work budget that warns on excess would bound it.

### 14. `folders_changed` leaves newly introduced folders unhydrated

- **Category:** code correctness
- **Severity:** warning (pre-existing, retained by the rename)
- **Location:** `client/src/lib/stores/folder-store.svelte.ts:133-136`
- **Status:** open

`applyFoldersChanged()` replaces rows but never loads their sessions or refreshes repos. Once the dashboard cache warms, a server refresh can introduce a folder with existing history: expanding it shows "No sessions yet", search misses its sessions, and git chips stay absent; remounts don't repair it because `ensureLoaded()` serves the warm cache. Hydration belongs inside the store's broadcast operation, not as a caller ordering requirement.

### 15. In-flight listings can overwrite newer event state

- **Category:** code correctness
- **Severity:** warning (pre-existing, retained by the rename)
- **Location:** `client/src/lib/stores/folder-store.svelte.ts:88-93, 220-223, 232-248`
- **Status:** open

Folder responses are assigned without checking intervening broadcasts: an older `list_folders` response can overwrite a newer `folders_changed` event, restoring obsolete rows or curation. Session request IDs guard against another load, not intervening events — a pending listing can replace sessions seeded or updated by `session_state_changed`. An archive event also reuses an existing same-filter request, so its pre-archive result can restore an archived session with no fresh request.

### 16. Rejected source-hub disband commands disappear silently

- **Category:** code correctness
- **Severity:** warning (pre-existing, retained by the rename)
- **Location:** `client/src/lib/components/FolderList.svelte:280-288`
- **Status:** open

Disband closes the confirmation before sending and ignores the response's `success` flag. Source hubs expose the action (`repos !== undefined`) but the server refuses deletion without persisted registry ownership; a rejection resolves normally, so the catch block never runs and the dialog closes with no explanation. Current and predecessor tests pin menu eligibility and successful dispatch, **not** the unavailable-source error path the plan says to preserve — that path is effectively undisplayed.

### 17. Malformed doc comment on `uniqueEntryPaths`

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `server/src/index.ts:340`
- **Status:** open

A multi-line block comment collapsed into one line leaves stray `*` markers mid-sentence and mangles the "first-discovery order" guarantee it documents (Step 3's dedupe helper). Cosmetic, no behavioral risk.

### 18. Step 7's "open-session response folder fields to FolderInfo" clause needed an interpretation

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `shared/src/protocol.ts:551-555`
- **Status:** open

`OpenSessionResponseData` carries `folderPath?: string` (a path, not a row) before and after the range — there was no ProjectInfo-typed field to convert. The implementation changed every ProjectInfo-typed payload (`session_opened`, `session_replaced`, takeover) to `FolderInfo` via `resolveFolderInfo` and left `folderPath` as a path. This is the correct reading (the response is in the Android-mirrored subset where renames are unsafe). Recorded so the record shows the clause was checked, not skipped.

### 19. Client-owned session vocabulary missed by the rename

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/components/ActiveSessionBar.svelte:11, 295-297`; `client/src/lib/components/CallHeader.svelte:36-49`
- **Status:** open

The active-session action still imports/calls `newSessionInProject`, and the call header still computes/renders `projectLabel`. These are client-owned identifiers, not compatibility wire fields (wire-mirrored `projectName` is plan-frozen and excluded), so Step 8's "'project' survives nowhere in product vocabulary" and Step 11's coherent client rename are not fully achieved. Internal identifiers only; no runtime failure results. All wire commands, curated types, SDK exports, source hooks, and file/imports renames are complete — swept with `rg` for old commands, types, hooks, keys, files, and a broad case-insensitive `project` pass.

### 20. `SessionRecords.listSessions` is production-dead and the record→row mapping is triplicated

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/session-records.ts:44-58`; duplicates at `server/src/index.ts:114-124`, `server/src/ws-handler.ts:372-396`
- **Status:** open

No production caller uses `listSessions` (only its test), while the same `created`/`modified`/`messageCount`/`firstMessage` mapping is re-implemented in two other places — a FUNCTIONS.md §6 violation (one business operation, one function). The copies have already drifted in shape, and all three carry finding 3's `toISOString()` crash. The extraction should have moved callers onto one mapper.

### 21. File symlinks in skipped descent produce an ENOTDIR warning on every scan

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/folder-model/traversal.ts:122-123` (with `55-62`)
- **Status:** open

`lstatKind` reports `'symlink'` without inspecting the target kind and the skipped-descent path `readdir`s it (the shortcut path guards with `isDirectory` at `traversal.ts:107`). A file symlink below a skipped root manufactures an ENOTDIR `onWarning` on every scan, indistinguishable from a genuinely unreadable directory. Rule 9 warns dangling/looping symlinks, not file symlinks — the scanner creates this failure itself.

### 22. Front-matter close delimiter matches indented `---`, truncating block scalars

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/folder-model/marker.ts:15-16`
- **Status:** open

The close scan accepts any whitespace-trimmed `---` line, including one inside an indented YAML block scalar. A `description: |` whose text contains `  ---` truncates the YAML there — the marker is accepted with a silently truncated description, or falls back to git on parse failure. Same line-based ambiguity Jekyll has; requiring column-0 `---` would remove it.

### 23. Out-of-tree shortcut condition breaks when the folder's canonical path is `/`

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/folder-model/traversal.ts:106` (and `82`)
- **Status:** open

`target.startsWith(`${walk.canonical}/`)` becomes `startsWith('//')` when `walk.canonical === '/'`, so every top-level symlink of an included root at `/` is misclassified as out-of-tree and recursed as a shortcut; `basename('/')` also yields `''` for the entry name. Realistic only for a root-anchored `.git`/marker.

### 24. Pruned basenames are not applied to shortcuts

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/folder-model/traversal.ts:98-113` (vs `119`)
- **Status:** open

A top-level symlink named `node_modules`/`dist`/`build`/`target`/`.venv`/`.git` of an included folder is entered as a shortcut occurrence, and recursion can enter a target that itself lives under a pruned name. Rule 1 says these names are "never entered … anywhere below a root"; rule 4 lists top-level symlinks unconditionally. The implementation takes the permissive reading — flagging in case rule 1 is meant to win (a hub member symlink named `dist` pointing at a build tree with its own `.git` would be discovered).

## No Issues

**Plan adherence** found no significant deviations beyond findings 17–19. All 14 steps are done and their verify criteria hold. Test immutability: `server/src/folder-model/folder-model.test.ts` is byte-identical across the range; all 43 cases pass at `2ad0b32` (plan-adherence independently re-ran the full server suite 807/807, client 746/746, `npm run build`, `npm run check`, `npm run lint`, `prettier --check`, `tsc -b server`, and the SDK build — all green in an isolated worktree). Interface files lost nothing pinned; their additions (`nodeFolderFs`, `root` on `createHub`, `ManagerToolContext.folders`/`.tree`) match the plan's prescribed deferrals. Unplanned-but-consistent work, noted not judged: a vocabulary sweep in `file-download` tool descriptions and `cli.ts` init copy, a glossary "Hub" entry, root `package.json` mirroring the `yaml` dependency, and the `nodeFolderFs` export.

**Correctness passes** confirmed clean: scanner identity/visit-once/cycle-termination/first-discovery children, marker parsing and warning locality, multi-root and reach-path semantics (all 43 pinned behaviors verified against the discovery contract); registry merge/persistence (collision enrichment, `multiRepo` compat, orphan overrides, favorites ordering, mutation serialization, atomic writes, reload-on-failure, create/disband safety on the happy path); hub materialization happy path (layout, AGENTS.md contract, git env guards); manager tool schemas/defaults/registration and `managerRoot` config; client icons, persona display, chips/userTags, missing rows, disband eligibility (`repos !== undefined`), and create/disband payload names; git invocation security (`execFile`, env stripping, timeouts, neutral failures) and session-id targeting (no path built from user input). Two seeded suspicions were investigated and **dropped**: below-root-warning GC permissiveness is pinned policy (Step 3), and the package.json/arbitrary-cwd exclusions are pinned intent with no new defect beyond finding 2. Two further low-risk items were reviewed and deliberately not reported: a `realpath`→`readdir` identity TOCTOU inherent to non-atomic traversal (no practical fix without `openat`-style traversal) and a dead private `options` field on `RepoIndex`.
