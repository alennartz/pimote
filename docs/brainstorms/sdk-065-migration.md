# Pi SDK 0.65.0 Migration

## The Idea

Update pimote's pi SDK dependency from 0.64.0 to 0.65.0 and adopt the new `AgentSessionRuntime` / service-layer patterns for session creation and lifecycle management.

## Key Decisions

### Use `AgentSessionRuntime` with a patch to remove `process.chdir()`

The runtime is the new canonical way to manage session lifecycle — `newSession()`, `fork()`, `switchSession()` were removed from `AgentSession` and moved to the runtime. However, `AgentSessionRuntime` calls `process.chdir()` on every session creation and replacement, which breaks pimote's multi-session server model (one process, many sessions, many cwds — the server's cwd is always different from any session's cwd).

Investigation confirmed the chdir is belt-and-suspenders for the CLI's single-session model. All SDK infrastructure (tools, resource loader, settings, session manager) uses explicit `cwd` parameters passed through the service/session creation chain. No code in the core or extensions reads `process.cwd()` at execution time — it's only used as a fallback default when no explicit cwd is provided, which never happens through the runtime path.

**Decision:** Patch out the two `process.chdir()` calls via `patch-package` (6-line patch). This unblocks full runtime adoption. A discussion has been posted on pi-mono requesting the chdir be made opt-out or removed from the runtime entirely.

**Why not reimplement session replacement ourselves:** The runtime's replacement logic (teardown → factory → apply) is ~100 lines, but maintaining a parallel implementation that drifts from the SDK's canonical path is worse than a clean patch on a single method.

**Why not use `pi-agent-core` directly:** Would require reimplementing the entire framework — tools, session persistence, compaction, model management, extensions, settings, system prompt assembly. Thousands of lines of code to avoid a 6-line patch.

### Store `AgentSessionRuntime` per managed session

Each `ManagedSession` gets its own `AgentSessionRuntime` instance. Access the session as `managed.runtime.session`. The runtime owns session creation and replacement; pimote's wrapper layer (event subscription, WebSocket routing, panel state, extension UI bridge) reacts to replacements the same way it does today.

**Why:** The runtime is designed as a per-session singleton (one per CLI process). Pimote just has many of them. The patch makes this work.

### Adopt `createAgentSessionServices` + `createAgentSessionFromServices` via a runtime factory

Session creation uses the new two-phase pattern: create cwd-bound services first, then create a session from those services. This is wired through a `CreateAgentSessionRuntimeFactory` closure that the runtime stores and reuses for all session replacements.

**Why:** Replaces pimote's manual wiring of `AuthStorage`, `ModelRegistry`, `DefaultResourceLoader` in `openSession`. Also replaces the `ensureProviders` pattern — provider registration now happens automatically inside `createAgentSessionServices`.

### Session replacement flow stays structurally the same

After `runtime.newSession()` / `runtime.fork()` / `runtime.switchSession()` returns, `runtime.session` is the new `AgentSession` (old one is disposed). Pimote's existing detach/adopt pattern rewires the wrapper:

- `detachSession`: unsubscribes old events, removes from map, clears panel listeners
- `adoptSession`: wraps the new session, subscribes events, sets up panel listeners
- `claimSession`: sets ownership, binds extension UI bridge, notifies clients

**Why:** The runtime handles the inner lifecycle (teardown, factory, apply). Pimote still needs the outer wrapper management. This is the same split of responsibility as today, just with the runtime owning the inner part instead of raw `session.newSession()`.

### `navigateTree` stays on `AgentSession`

The runtime doesn't expose `navigateTree` — it stays in the same session file with the same session ID. Pimote's existing handling (full resync, no detach/adopt) is unchanged.

### Remove `ensureProviders` and `providerInitByFolder`

`createAgentSessionServices` registers extension-provided model providers as part of service creation. Duplicate `registerProvider` calls on the shared `ModelRegistry` are idempotent (verified). No need for pimote's per-folder lazy-init pattern.

**Why:** Eliminates a workaround that used a throwaway `ResourceLoader` just to discover and register providers before creating the real session.

## Direction

1. **Patch:** `patch-package` removes `process.chdir()` from `AgentSessionRuntime.apply()` and `createAgentSessionRuntime()`.

2. **`ManagedSession` changes:** Replace `session: AgentSession` with `runtime: AgentSessionRuntime`. Add a convenience getter for `runtime.session`. Store the shared `AuthStorage` and `ModelRegistry` on `PimoteSessionManager` and pass them into the runtime factory.

3. **`openSession` rewrite:** Create a `CreateAgentSessionRuntimeFactory` that closes over shared auth/model registry and passes `eventBus` via `resourceLoaderOptions`. Use `createAgentSessionRuntime` to create the initial runtime. Remove `ensureProviders` and `providerInitByFolder`.

4. **`createCommandContextActions` update:** Call `runtime.newSession()`, `runtime.fork()`, `runtime.switchSession()` instead of the removed `session.*` methods. `navigateTree` stays on `session`.

5. **`handleSessionReset` update:** After runtime replacement, `runtime.session` is the new session. Detach old managed session, adopt new session from runtime, re-claim. Same flow, different trigger.

6. **`ws-handler` session commands:** `/new` and `new_session` command use `runtime.newSession()`.

7. **`adoptSession` update:** Needs to handle the case where the runtime already exists (session replacement) vs. wrapping a fresh runtime.

## Open Questions

- **Default model/thinking level:** Currently applied manually after session creation in `openSession`. Should this move into the factory, or stay as post-creation configuration?
- **Upstream resolution:** If the pi-mono discussion results in a chdir opt-out, the patch can be dropped. Monitor the discussion.
