# DR-006: Patch process.chdir() Out of AgentSessionRuntime for Multi-Session Server

## Status

Accepted

## Context

Pi SDK 0.65.0 introduced `AgentSessionRuntime` as the canonical way to manage session lifecycle — `newSession()`, `fork()`, and `switchSession()` moved from `AgentSession` to the runtime. However, `AgentSessionRuntime` calls `process.chdir()` on every session creation and replacement, targeting the session's working directory.

This breaks pimote's multi-session server model: one Node.js process hosts many concurrent sessions, each with a different cwd. A `process.chdir()` from one session would silently corrupt the working directory for all others.

Investigation of the SDK internals confirmed the chdir is belt-and-suspenders for the CLI's single-session model. All SDK infrastructure — tools, resource loader, settings resolution, session manager — uses explicit `cwd` parameters threaded through the service/session creation chain. No code reads `process.cwd()` at execution time; it's only used as a fallback default when no explicit cwd is provided, which never happens through the runtime path.

## Decision

Patch out the two `process.chdir()` calls (in `AgentSessionRuntime.apply()` and `createAgentSessionRuntime()`) via `patch-package`. This is a 6-line patch that unblocks full runtime adoption while preserving pimote's multi-session correctness.

Two alternatives were rejected:

- **Reimplementing session replacement ourselves:** The runtime's replacement logic (teardown → factory → apply) is ~100 lines, but maintaining a parallel implementation that drifts from the SDK's canonical path on every upgrade is worse than a clean, targeted patch.
- **Dropping to `pi-agent-core`:** Would require reimplementing the entire framework — tools, session persistence, compaction, model management, extensions, settings, system prompt assembly. Thousands of lines of code to avoid a 6-line patch.

An upstream discussion has been posted on pi-mono requesting the chdir be made opt-out or removed from the runtime.

## Consequences

- Pimote depends on `patch-package` to apply this patch on install. The patch must be re-evaluated on each SDK version upgrade.
- If upstream makes chdir opt-out or removes it, the patch can be dropped.
- The patch is safe as long as the SDK continues threading explicit `cwd` through its internals — a regression there would affect the CLI too, so it's unlikely to go unnoticed.
