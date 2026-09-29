# DR-046: Multi-repo projects as hub folders with symlinks and a generated AGENTS.md

## Status

Accepted

## Context

A project must be able to span multiple repositories, but pi sessions have a single working directory and the pi SDK has no multi-root support. Waiting for upstream multi-root was not acceptable, and a purely virtual grouping (a project as metadata only) would leave nothing to open a session in.

## Decision

A multi-repo project is a server-created **hub folder**: a real directory under a configured root containing one absolute symlink per member repo plus a generated `AGENTS.md`. The generated document names each member and states the convention: every symlinked subdirectory is an independent git repo (sub-project) whose own `AGENTS.md` takes precedence when working inside it, and each repo's work stays inside its own directory.

Sessions open with cwd = the hub, so one session spans all member repos today, within the single-cwd model. Hub creation accepts only member paths present in the repo index — no arbitrary symlinks can be created through the API. Disbanding removes the registry entry and deletes the hub folder (symlinks are unlinked, never followed — members survive); only registry-recorded hub paths can be disbanded.

Rejected alternatives:

- **Wait for / patch upstream pi multi-root support.** Rejected: blocks the primary use case on an upstream redesign; the hub gives cross-repo reach now.
- **One session per repo within a project.** Rejected: loses cross-repo context — a single conversation spanning all repos was the point.
- **Config-only grouping without a directory.** Rejected: there is no cwd to hand a pi session, so nothing can actually be opened.
- **Copying or nesting repos into the hub.** Rejected: duplicates state; symlinks keep members as the single source of truth.

## Consequences

- The mechanism rides on symlink semantics, which is fine for the self-hosted Linux deployment but is a known portability constraint elsewhere.
- Member repos must have unique basenames within a hub (symlink collision); duplicates are rejected at validation time.
- The repo-index walker never follows symlinks, so hubs are not walker-discovered repos — they exist only as registry entities. A hub with no registry entry is invisible to the project list.
- The generated `AGENTS.md` is a contract with pi's instruction-following, not an enforcement mechanism: nothing structurally prevents work leaking across member boundaries beyond the convention the document states.
- Deleting the hub folder on disband is destructive by design; members are never touched, and single-repo projects refuse disband.
