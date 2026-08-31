# Test Review: Native `!` Bash Commands

**Plan:** `docs/plans/bang-bash-command.md`
**Brainstorm:** `docs/brainstorms/bang-bash-command.md`
**Date:** 2026-08-31

## Summary

The test contract now covers the brainstorm’s native Pi execution path, `!`/`!!` parsing, concurrent model streaming, extension interception, result preservation, cancellation, resync, and presentation behavior. Tests exercise handler, reducer, and mounted component boundaries rather than source text; the feature tests remain intentionally red against the implementation stubs. Type checking passes, and all non-feature client and server tests pass.

## Findings

### 1. UI tests inspected source text instead of rendering behavior

- **Category:** wrong abstraction
- **Severity:** critical
- **Location:** `client/src/lib/components/InputBar.bash.test.ts:1-130`, `client/src/lib/components/MessageList.bash.test.ts:1-103`, `client/src/lib/components/BashExecution.test.ts:1-106`
- **Status:** resolved

The original tests searched `.svelte` source for imports, variable names, and CSS-class strings. They could pass while the component failed to parse a bang command, render an execution, or invoke cancellation. Replaced them with mounted Svelte boundary tests, added the browser-resolution condition required by the test runtime, and assert observable composer commands, rendered entries, status/error output, cancellation, expansion, and sanitized output.

### 2. Native execution test required duplicate history recording

- **Category:** over-specified
- **Severity:** critical
- **Location:** `server/src/ws-handler.test.ts:3500-3587`
- **Status:** resolved

The previous `!!` test required the handler to call `recordBashResult()` after `executeBash()`. Pi’s typed API documents that `executeBash()` records its own result, so that expectation would duplicate a native history entry. The corrected suite asserts no extra record on the native path and separately verifies that an extension-provided complete result is recorded exactly once with its exclusion flag.

### 3. Extension interception and session scope lacked boundary coverage

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/ws-handler.test.ts:3491-3619`
- **Status:** resolved

The brainstorm and architecture require the server to preserve Pi’s user-bash interception rather than bypass it. Added handler-boundary coverage for required session scope, extension event delivery with the session cwd, extension-supplied operations, extension-handled results, model-stream concurrency, native nonzero result success, conflict rejection, and bash-only cancellation.

### 4. Completion ordering and dispatch failures had no resolved client contract

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `docs/plans/bang-bash-command.md:63-83`, `client/src/lib/stores/session-registry.test.ts:1264-1335`, `client/src/lib/components/InputBar.bash.test.ts:99-130`
- **Status:** resolved

The plan said output updates might arrive after completion but did not state whether they should mutate a promoted result; it also exposed an `error` state without defining transport-failure behavior. Approved resolution: the successful response is canonical because the server emits updates before its awaited response on the same WebSocket; completion promotes and removes transient state, and later updates are dropped. Failed or rejected dispatches remain visible as non-context `error` entries with their error text. Tests now cover both server-error and rejected-dispatch paths.

### 5. Context-resync mapping did not prove retained bash metadata

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/message-mapper.test.ts:115-174`, `client/src/lib/stores/session-registry.test.ts:632-687`
- **Status:** resolved

Direct message mapping was tested, but the context-entry path used by full resync did not prove that a normal bash result retained its command, exit status, truncation path, and exclusion metadata. Expanded the context-entry assertion and full-resync test so server-supplied messages are retained while all transient executions are cleared.

## No Issues

All brainstorm intent is now covered at handler, reducer, and presentation boundaries. No non-deterministic tests remain, and no tests depend on private implementation details or unplanned behavior.
