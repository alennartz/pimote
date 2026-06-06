# Test Review: @file path autocomplete in web input

**Plan:** `docs/plans/at-file-syntax-web.md`
**Brainstorm:** `docs/brainstorms/at-file-syntax-web.md`
**Date:** 2026-06-05

## Summary

The tests cover the rewritten, autocomplete-only scope well: `completeFileRefs` is exercised at its `runFd` seam (fd-arg construction, base-dir resolution, item mapping/quoting, fd-availability degradation), and the client `extractFileRefPrefix` cases are a faithful port of the real pi-tui `extractAtPrefix`. The one substantive issue was the flagged `--full-path` consistency invariant, which left the mid-segment scoping behavior (`@src/comp`) completely unspecified. That was resolved by committing pimote to deterministic last-slash scoping (no `statSync` fallback) and replacing the invariant with concrete pins, with matching plan prose. No outstanding gaps against brainstorm intent.

## Findings

### 1. `--full-path` invariant left mid-segment scoping unspecified

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/file-references.test.ts:55-66` (original)
- **Status:** resolved

The original test asserted `inv.args.includes('--full-path') === inv.query.includes('/')` as a consistency invariant across `@foo`, `@src/comp`, `@a/b/c`. Tracing the real pi-tui (`getFuzzyFileSuggestions` → `resolveScopedFuzzyQuery` → `walkDirectoryWithFd`) showed `--full-path` is **not** a "prefix contains a slash" rule: the TUI splits the prefix at the last `/`, resolves a base dir, and `statSync`s it. For `@src/comp` it scopes (`baseDir=cwd/src`, `query='comp'`, no `--full-path`) when `src` exists, and only falls back to `query='src/comp'` + `--full-path` when `src` does **not** exist. That branch is filesystem-dependent, which is why test-write avoided pinning it with a pure `runFd` seam.

The invariant is deterministic but near-tautological — it restates `walkDirectoryWithFd`'s own rule, so any faithful port passes regardless of how it scopes. It left the observable contract for a mid-segment prefix (`baseDir`/`query`/`--full-path`) undefined, which conflicts with brainstorm decisions 4 (keep TUI path flexibility) and 13 (reuse pi-tui autocomplete for parity).

Escalated to the parent. Decision: **commit pimote to deterministic last-slash scoping with no `statSync` fallback** — split at the last `/`, resolve the directory portion against cwd/`~/`/absolute, use the trailing segment as the fd query (which therefore never contains a separator, so `--full-path` is not used for scoped multi-segment queries), and reconstruct values as `@<base>/<entry>`. The TUI's dir-doesn't-exist full-path-fuzzy fallback is intentionally dropped as filesystem-coupled and out of scope.

Fixed inline:

- Replaced the invariant with three concrete tests (`server/src/file-references.test.ts:55-89`): no `--full-path` for a bare single-segment prefix; `@src/comp` → `query: 'comp'`, `baseDir: <cwd>/src`, no `--full-path`; `@a/b/c` → `query: 'c'`, `baseDir: <cwd>/a/b`, no `--full-path`. These still catch the bug the invariant guarded (a naive impl deriving `--full-path` from the raw prefix while scoping the query).
- Updated the plan (`docs/plans/at-file-syntax-web.md`) `file-references.ts` responsibilities and the Behaviors Covered bullet to state the last-slash scoping rule and the deliberate omission of the `statSync` fallback, keeping plan and tests in agreement for the impl phase.

### 2. `@/tmp/` base directory pinned without trailing slash

- **Category:** over-specified
- **Severity:** nit
- **Location:** `server/src/file-references.test.ts:97-101`
- **Status:** dismissed

The test pins `baseDir` to `/tmp` (no trailing slash) for prefix `@/tmp/`, whereas the raw TUI would hand `--base-directory /tmp/`. Both are equivalent for `fd`, and normalizing the trailing slash is a reasonable implementation choice. Kept as-is — the expectation is satisfiable by any sensible implementation and the normalization is harmless. No change.

### 3. Single-quote (`'`) delimiter not exercised in `extractFileRefPrefix`

- **Category:** missing coverage
- **Severity:** nit
- **Location:** `client/src/lib/file-ref-prefix.test.ts:38-48`
- **Status:** dismissed

The real TUI treats `'` as a path delimiter alongside ` \t"=`. The client tests cover whitespace and `=` token-start cases but not `'`. Given pimote inserts `@"…"` (double) quotes and the brainstorm doesn't call out single-quote handling, this is an edge of an edge. Left uncovered intentionally; can be added if single-quote input proves relevant. No change.

## No Issues

Beyond the findings above, validation was clean:

- **Brainstorm intent coverage.** The rewritten plan narrows scope to TUI-autocomplete-only (no expansion/attachments), and the tests cover that surface: fd invocation flags, path-scope resolution (`~/`, `/abs`, `./`, `../`, trailing-slash, bare relative), item mapping + quoting, directory trailing-slash tokens, and fd-missing degradation with the availability signal. Client `@`-token extraction covers boundary detection, mid-line tokens, multiple tokens, mid-word non-trigger, delimiter-triggered start, trailing-space termination, and unclosed quoted tokens.
- **Abstraction level.** Tests exercise public boundaries only — `completeFileRefs` via the injected `runFd` seam and `extractFileRefPrefix` as a pure function. No reaching into internals.
- **Interface-only testing.** Tests reference only the materialized interfaces (`completeFileRefs`, `FdInvocation`/`FdRunResult`/`FdRunner`, `extractFileRefPrefix`).
- **Path coverage.** Happy paths, boundary conditions (lone `@`, empty query, trailing slash, quoting), and error/degradation (fd missing) are all present.
- **Determinism.** With the invariant replaced, all server tests run against canned `runFd` output and fixed `cwd`/`homedir()`; no timing, randomness, network, or real-filesystem dependence. The client tests are pure.
- **Reasonable expectations.** Assertions are satisfiable by any correct implementation; the previously implementation-coupled invariant has been replaced with observable-contract pins.

All 21 server tests + 12 client tests collect cleanly and fail only on the `not implemented` skeleton, as expected pre-implementation.
