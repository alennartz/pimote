# DR-065: Pimote documentation ships as package files and enters sessions through a code-injected section

## Status

Accepted

## Context

DR-062 ships the manager's documentation as a server-materialized skill, `pimote-folders`, which sits beside a README and a seeded manager `AGENTS.md`. The docs split across three artifacts. The seeded `AGENTS.md` freezes an absolute README path into a release directory, and write-if-absent seeding never rewrites it, so upgrades leave the manager pointing at stale locations. Ordinary sessions received no pimote documentation at all.

Pi and my-pi already show the pattern this needs. Pi ships its docs in the package, and code renders their absolute paths into a `docs` section at runtime. my-pi's `my-pi-docs` extension does the same through a `before_agent_start` hook that sets one named section. Pi wraps any named section in its tag.

## Decision

Pimote documentation lives in `docs/shipped/`, one file per topic, and the package ships that folder. A `pimote-docs` section, injected by a `before_agent_start` hook, lists each shipped file with its absolute path and a one-line purpose. The section resolves paths from the running install at runtime and enters every session. The manager's seeded `AGENTS.md` holds identity and vision only, with no documentation pointers. The `pimote-folders` and `static-report` skills retire, and their materialization code goes with them.

We rejected keeping the skills. Skills split the documentation across artifacts, need materialization to disk, and load only when a description matches the task. We rejected pointers inside the manager root, because write-if-absent seeding freezes them across upgrades, as DR-062 already noted. We rejected injecting the full text into every prompt, because that costs the whole documentation on every turn.

## Consequences

- Every session pays for the path list. The cost grows by one line per shipped file.
- The model no longer loads a guide by description match. It reads the file the list names, so each file's purpose line must state when to read it.
- Documentation changes ship with the package version. Nothing on disk goes stale across upgrades.
- The manager template becomes identity only. Its memory-maintenance instruction stays.
- The SDK README is one of the shipped files. It ships from `packages/sdk/README.md` in both the root package and the SDK package, with no copy.
- The section name is `pimote-docs`. A custom section survives the manager's persona preamble, which pi's own `docs` section does not.
