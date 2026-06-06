# Review: @file path autocomplete in web input

**Plan:** `docs/plans/at-file-syntax-web.md`
**Diff range:** `58f8b4973c14bb245015401d265bf26983422e68..HEAD` (pre-test-write..HEAD; pre-implementation `3188efa`)
**Date:** 2026-06-05

## Summary

The implementation faithfully follows the plan across all five steps: a dedicated `complete_file_refs` command (no slash-menu pollution), an `fd`-backed `completeFileRefs` server module with deterministic last-slash scoping and a clean test seam, a pure `extractFileRefPrefix` client helper, a third `fileRefs` mode reusing the generic dropdown, and `@`-trigger wiring in `InputBar` that stays mutually exclusive with the slash gate. Test files are unmodified since `pre-implementation-commit` (immutability holds), and both unit suites are green (server 21/21, client 12/12). The `fd` invocation is safe from shell injection (arg vector via `execFile`, no shell), and `@/abs`/`@../` base-dir resolution is intentional per the plan and consistent with the threat model (an authenticated user already has full filesystem reach through the agent's `read` tool). Two real correctness gaps surfaced — `fd`'s positional query is not separated by `--` (leading-`-` queries get parsed as `fd` flags), and quoted-directory drill-in silently breaks — plus two nits.

## Findings

### 1. `fd` positional query is not separated by `--`, so `-`-leading queries are parsed as flags

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/file-references.ts:90-93` (`if (query !== '') { args.push(query); }`)
- **Status:** open

The query pattern is appended as a bare positional argument with no `--` end-of-options separator. `execFile` builds an argv vector (so this is **not** a shell-injection vector — there is no shell, and the query is always a single argv element, which also rules out splitting an injected `-x`/`--exec` into a separate command argument), but `fd`'s own clap parser still treats any argument beginning with `-` as an option. Verified against real `fd`: `fd --base-directory . '-dash'` fails with `invalid value 'ash' for '--max-depth'`, while `fd --base-directory . -- '-dash'` returns the file correctly. Consequences: (a) any legitimate file/dir whose name starts with `-` cannot be completed — `fd` errors, the runner swallows it as `available:true, lines:[]`, and the user sees an empty menu; (b) defense-in-depth — user-controlled text is fed directly into `fd`'s flag parser. Fix: emit `--` immediately before the positional query (e.g. `args.push('--', query)`), matching the standard hardening the TUI's `walkDirectoryWithFd` applies. Note the tests assert flag _absence_ (`--full-path`) but none cover a `-`-leading query, so this passed CI.

### 2. Quoted-directory drill-in silently breaks (menu closes, prefix gets a stray closing quote)

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/InputBar.svelte:359-366`; interacts with `server/src/file-references.ts:146-150` (`mapLineToItem`)
- **Status:** open

The plan specifies that "selecting a directory keeps the menu open so the user can drill in," and the implementation detects directories via `value.endsWith('/')`. But `mapLineToItem` wraps quoted tokens as `@"<scope><line>"` with the closing quote _after_ the trailing slash, so a quoted directory item's `value` is `@"my dir/"` — it ends with `"`, not `/`. Quoting fires whenever the path contains a space **or** the prefix was already a quoted `@"…` token, so this hits every directory reached through a spaced/quoted scope. Result: `value.endsWith('/')` is `false`, the menu closes instead of drilling in, and the user must re-type to continue. Worse, if the check ever did pass, `fileRefPrefix = value` would carry the embedded closing quote (`@"my dir/"`), which `parsePrefix` would then mis-split (query becomes `"`). The drill-in directory check needs to recognize quoted directory tokens (e.g. test the path portion, or strip a trailing quote before the `endsWith('/')` test) and the re-armed `fileRefPrefix` must be the open-quoted form without the closing quote.

### 3. `fileRefs` fetch effect duplicates the `args` fetch effect verbatim

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/CommandAutocomplete.svelte:65-103` (vs `args` effect at 27-61)
- **Status:** open

The debounced-fetch-with-stale-discard operation now exists twice, differing only in the command `type` and the presence of `commandName`. Per AGENTS.md principle #6 ("each business operation lives in one function"), this is the same operation reachable two ways and will drift — a fix to one debounce/seq path won't reach the other. The plan explicitly directed "mirror the existing `args` effect," so this is plan-conformant, but the structural smell stands: a single parameterized fetch effect (command type + optional `commandName` as inputs, writing into a mode-selected `$state` array) would collapse both. Noting per the AGENTS.md directive to flag such duplication rather than propagate it.

### 4. Redundant `scope === '~/'` disjunct in `resolveBaseDir`

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/file-references.ts:135` (`if (scope === '~/' || scope.startsWith('~/'))`)
- **Status:** open

`'~/'.startsWith('~/')` is already `true`, so the first comparison is dead. Harmless, but the `||` reads as if `'~/'` were a distinct case the `startsWith` misses. Drop the redundant disjunct.

## No Issues

- **Plan adherence:** No significant deviations. All five steps are implemented as described; the protocol addition, server dispatch (with the per-connection `fdWarningEmitted` flag and `emitFdMissingWarning`), `extractFileRefPrefix`, the `fileRefs` dropdown mode, and the `@`-trigger wiring all match the plan. The `@` check runs before the slash gate and is cursor-relative, so `@` and `/` stay mutually exclusive per token as required. Test files listed in the `## Tests` section are byte-identical between `pre-implementation-commit` and HEAD — test immutability holds.
- **Security (fd subprocess):** `execFile` with an argv vector, no shell — no command injection. `@/abs` and `@../` base-dir resolution intentionally escape the session cwd, matching the plan's stated `~/`/`/abs`/`../` support and the TUI behavior being mirrored; this is not a privilege escalation given the authenticated user already has full filesystem access via the agent's `read` tool. (Argument-level hardening is Finding 1.)
- **State/purity (AGENTS.md):** `completeFileRefs` and `extractFileRefPrefix` are pure aside from the injected/real `runFd` seam; no module-level mutable business state. `fdWarningEmitted` is a per-connection instance flag (legitimate state holder, honest `emitFdMissingWarning` name). The seq counters are the established explicit stale-response-discard pattern; the `setTimeout` closures capture `const` snapshots of `query`/`sessionId`, satisfying principle #4.
- **Out-of-scope diffs:** `client/src/lib/components/StreamingCollapsible.svelte` and `.pi/prompts/android-publish.md` also appear in the range but are unrelated to this topic (concurrent work) — not reviewed here.
