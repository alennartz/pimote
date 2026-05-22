# Review: static-resources

**Plan:** `docs/plans/static-resources.md`
**Diff range:** `c2492401cd57ac2a95b12c073eb979b1a5c70749..HEAD`
**Date:** 2026-05-21

## Summary

The plan was implemented faithfully across all 14 steps; tests are green (server vitest 327/327, panels 9/9) and the test files are bit-identical to their pre-implementation state. The deviations from the plan are minor and defensible adaptations. The code-correctness pass turned up one critical risk in the boot-time GC error path, one concurrency hazard in the register tool, and a handful of smaller robustness issues — none of them block the feature, but the GC one is genuinely dangerous on real boots.

## Findings

### 1. GC wipes all persistence on transient enumeration failure

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/index.ts:41-52`
- **Status:** resolved

The `try { ... } catch (err) { console.warn(...); }` around `folderIndex.scan()` / `listSessionRecords()` swallows errors and then proceeds to call `gcStaticHostStore({ ..., validSessionIds: new Set() })`. With an empty allow-list, GC deletes every `<sessionId>.json` for static-host. Any transient I/O hiccup (locked directory, EIO, partial filesystem readiness on slow disks) at boot will silently nuke all persisted bundles. The handler should bail out of `gcStaticHostStore` entirely on enumeration failure, not run it with an empty set.

### 2. Concurrent register-tool calls can corrupt persistence and desync the registry

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/static-host/tools.ts:96-149` (`executeRegisterTool`)
- **Status:** dismissed — pi serializes tool calls per session in practice, so the abstract race isn't reachable. A code comment now documents that per-session serialization is the assumption, so a future reader doesn't introduce concurrency without revisiting this.

`executeRegisterTool` performs `store.read` → mutate → `await store.write` → `registry.register`, with `await`s between the read and the register call. Two concurrent invocations in the same session can both observe the same `existing` snapshot, both resolve their slug against the (synchronous) registry, then both write — the second write loses the first entry from disk while the registry still holds it. If they resolve to the same slug, `registry.register` throws on the second invocation. The remove tool has the same structural shape. The pi tool runtime may serialize tool calls per session in practice, but the function itself doesn't guarantee it. Either add a per-session lock or derive the entry list from `registry.listForSession(sessionId)` rather than re-reading the store.

### 3. `/s/<slug>` (no trailing slash) silently serves `index.html` and breaks relative links

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/static-host/http-handler.ts:29,60-62`
- **Status:** resolved

`PREFIX_RE = /^\/s\/([a-z0-9-]+)(?:\/(.*))?$/` — the trailing-slash group is optional. `/s/foo` matches with an empty remainder, resolves to the folder, gets `index.html` appended, and serves the bundle. But the browser then resolves relative asset URLs against `/s/` instead of `/s/foo/`, so every asset 404s. The architecture and the in-file comment both claim the trailing slash is required; the regex disagrees. Verified empirically: `node -e "/^\/s\/([a-z0-9-]+)(?:\/(.*))?$/.exec('/s/foo')"` returns a match. Fix is either to tighten the regex to require the slash and 301-redirect `/s/foo` → `/s/foo/`, or to detect the no-remainder case and redirect.

### 4. Streaming errors after `writeHead(200)` propagate as unhandled rejections

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/static-host/http-handler.ts:118-130`
- **Status:** resolved

After headers are written, `createReadStream(resolved)` is piped into `res`. If the read stream errors mid-pipe (file deleted between `stat` and stream open, EIO, client abort), the promise wrapping the pipe rejects and bubbles out of the async request handler — `server.ts`'s outer handler has no `.catch` around `serveStaticHostRoute`. Best case it's an `unhandledRejection`; worst case Node crashes on `--unhandled-rejections=strict`. Wrap the stream in a promise that resolves on `end` and `destroy`s the response (without re-throwing) on `error`.

### 5. `session_start` replay throws on duplicate slug across sessions

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/static-host/index.ts` (session_start handler)
- **Status:** resolved

Replay does `registry.register(...)` per persisted entry. `register` throws if the slug is already taken (e.g. two sessions persisted the same slug before GC, or another session reloaded earlier in the same boot). One conflict aborts the loop mid-replay, leaving the session partially loaded and skipping the `emitPanelCards` call. Should either skip-on-conflict with a `console.warn` or auto-suffix; either way the replay loop should be defensive.

### 6. `Card.id` differs from plan literal

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `server/src/static-host/index.ts:42`
- **Status:** dismissed — intentional. Namespacing the card id (`static-host:<slug>`) is defence-in-depth against future panel-source collisions and consistent with how other panel emitters scope their IDs. Plan can be considered approximate; the implementation choice stands.

Plan Step 8 specifies `id: entry.slug`; the implementation uses `id: \`static-host:${entry.slug}\``. Defensible — it namespaces the card id away from other panel sources — and tests are green, but it's a literal deviation worth noting.

### 7. `folder` input absoluteness is not validated

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `server/src/static-host/tools.ts:96-117`
- **Status:** resolved

Architecture specifies `folder` as an absolute path. `executeRegisterTool` checks existence/directory/index.html but not absoluteness. A relative path would resolve against `process.cwd()`, which is surprising and depends on where the agent process happens to be running. Cheap to add `if (!path.isAbsolute(input.folder)) throw ...`.

### 8. `color` tool input is unconstrained `Type.String`

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/static-host/index.ts:79`
- **Status:** resolved

The tool schema declares `color` as a free string; the architecture specifies `CardColor` (a literal union). Arbitrary strings end up in `cardMetadata.color` and reach `Panel.svelte`'s `colorMap[card.color]` lookup, returning `undefined` and producing a broken Tailwind class. Constrain to the union in the schema or validate in `executeRegisterTool`.

### 9. `staticHostFactory` is optional in `PimoteSessionManager`

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `server/src/session-manager.ts:172,313`
- **Status:** dismissed — the plan's "always enabled" describes production wiring, not a type-level requirement. Optional-in-type for test-fixture ergonomics is the right trade-off; no factory rewrite needed.

Architecture says the factory is "always enabled (no config gate)". In practice `server/src/index.ts` always passes it; the optionality exists to keep pre-existing session-manager tests green without rewriting their fixtures. Behavior matches intent; flagging only as a literal-wording drift.

## No Issues

- **Test immutability:** verified — `git diff b217d877..HEAD -- 'server/src/static-host/*.test.ts'` returns empty. All test files are bit-identical to their pre-implementation state.
- **Path traversal defence (http-handler):** the layered check (reject `\`, NUL, and literal `..` segments; then `path.resolve` + `startsWith(folderPath + path.sep)` boundary with `===` exact-folder fallback) correctly handles `..`, URL-encoded `..`, absolute remainders, and NUL-bypass attempts. Reviewed and sound.
- **Plan adherence overall:** all 14 steps done; deviations limited to the items above. No unplanned cross-cutting changes in the diff.
