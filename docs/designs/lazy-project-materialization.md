# Design: lazy project materialization via project sources

Status: implemented. Context: the project-management redesign's extensibility seam
(`server/src/project-sources/`) originally split discovery (`ProjectSource.list`,
read-only) from creation (`ProjectCreator.create`, explicit). This design adds lazy
materialization: sources may list entries whose folders don't exist on disk yet.

## Decisions

- **No "virtual" concept in the seam.** Sources always report concrete paths;
  existence-on-disk is server-derived state (`missing` in `RepoInfo`, warning chip
  in the UI). The extension decides paths ahead of time and does its own
  probe-and-scaffold.
- **One lifecycle hook, not an ensure/materialize method.** Optional
  `ProjectSource.onProjectOpen(path)` is awaited before any open of a listed
  entry proceeds — missing or existing, from every open path (missing-row click,
  new session, manager `pimote_start_session`). Sources self-filter by path;
  no provenance tracking. A thrown error aborts the open and surfaces the
  message; the server core never mutates anything itself.
- **Explicit trigger only.** No auto-materialization on scans or dashboard views;
  row expansion doesn't fire hooks. A missing single-repo project's row click is
  an open attempt (which fires hooks, then opens a session); a multi-repo project
  whose members are all missing behaves the same.
- **Sources list both repos and projects.** `list()` returns
  `{ kind: 'repo', ... }` (feeds the repo index → single-repo projects) or
  `{ kind: 'project', path, name, memberPaths }` (feeds the project layer as a
  derived multi-repo project). Bare repo shapes without `kind` are normalized.
- **Source-listed projects are derived, not persisted.** If the source stops
  listing one, it disappears. User curation (favorite/order/archive) applies by
  path as usual; on a path collision the persisted entry wins.
- **Members may be missing.** `memberPaths` resolve against the index; unknown
  members render with the missing warning chip exactly like disappeared repos.

## Server-owned standard layout

An open of a source-listed multi-repo project whose folder is missing on disk is
materialized by the **server** before hooks run: mkdir + one absolute symlink per
`memberPaths` entry + the generated AGENTS.md — the same layout
`createMultiRepoProject` builds, rendered by the shared
`materializeMultiRepoFolder` in `server/src/project-sources/materialize.ts`.
User sources never replicate the convention. Dangling member symlinks are
allowed and self-heal when a member materializes (links are by path). Hooks run
after materialization (they see the folder) and may still abort the open; the
materialized folder remains in that case, and the next open retries the hooks.
Consequence of the derived lifecycle: a materialized folder whose source stops
listing the project is not garbage-collected — it stays on disk.

## Failure model

Hook errors abort the open with the source's message (surface in the projects
toolbar error line). Scan-time source failures skip that source's entries with a
logged warning, as before.
