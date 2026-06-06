# DR-036: Dedicated `complete_file_refs` command with deterministic last-slash path scoping

## Status

Accepted

## Context

With the web `@` feature scoped to autocomplete-only (see DR-035), the remaining design question was how the client should fetch `@` suggestions. The codebase had recently grown a **generic** slash-arg autocomplete pipeline: `get_commands` returns `CommandInfo[]` with a `hasArgCompletions` flag, `complete_args` returns `AutocompleteResponseItem[]` per `(commandName, prefix)`, and `CommandAutocomplete.svelte` already handles debounced fetching, stale-response discard, and rendering. The obvious-looking move was to fold `@` into `complete_args`.

Separately, the server-side path resolution had to decide how to turn a typed `@`-prefix into an `fd` query. The real pi-tui (`getFuzzyFileSuggestions` → `resolveScopedFuzzyQuery` → `walkDirectoryWithFd`) splits the prefix at the last `/`, `statSync`s the resolved directory, and — only when that directory does **not** exist — falls back to a `--full-path` fuzzy search from the cwd using the whole prefix as the query. A test-write-phase invariant (`--full-path present ⇔ query contains '/'`) had tried to pin this but was near-tautological and left mid-segment scoping (`@src/comp`) unspecified.

## Decision

Two coupled choices:

1. **A dedicated `complete_file_refs` command**, not a fold into `complete_args`. `@` is not a slash command: it must not appear in `get_commands`, and its trigger is a mid-line `@`-token (cursor-relative), whereas `complete_args` keys off `/command <args>`. A dedicated command keeps that boundary clean while still reusing the shared `AutocompleteResponseItem` type and the existing `CommandAutocomplete` render/debounce machinery (added as a third `fileRefs` mode).

2. **Deterministic, purely textual last-slash scoping** on the server, with **no `statSync` fallback**. Split the prefix at the last `/`: the part up to and including it is the typed scope (resolved against cwd, `~/`, or absolute), and the trailing segment is the `fd` query. Because the query is always the post-scope segment, it never contains a separator, so `--full-path` is never used for scoped queries. The TUI's dir-doesn't-exist `--full-path`-fuzzy fallback is intentionally dropped.

## Consequences

- **Clean separation from slash autocomplete.** `@` never pollutes the slash-command list, and the two triggers (`/` at line start vs `@`-token anywhere, cursor-relative) stay mutually exclusive per token. The cost is one more command type and a near-duplicate debounced-fetch effect in `CommandAutocomplete.svelte` (flagged in review as a principle-#6 smell — the `args` and `fileRefs` fetch effects differ only by command `type`/`commandName` and will drift; left as plan-conformant but noted for future consolidation).
- **Scoping is testable with a pure `runFd` seam.** Dropping `statSync` removed the only filesystem-coupled branch, so `completeFileRefs` is a pure function of `(prefix, cwd, homedir)` over an injected fd runner. This is what let the server tests pin concrete `baseDir`/`query`/`--full-path` expectations deterministically.
- **A multi-segment prefix whose directory doesn't exist yields no suggestions** instead of the TUI's full-path fuzzy fallback. This is a deliberate behavior gap versus the TUI, judged acceptable because the fallback is obscure and filesystem-coupled; revisit if users hit dead-end completions in practice.
- **`fd`-absent degradation is deterministic:** empty items + an `fdAvailable: false` signal that drives a one-time per-connection warning toast, rather than reproducing the TUI's `readdirSync` non-`fd` listing path (deferred as degraded-mode-only complexity).
