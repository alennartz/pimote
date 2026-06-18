# Pimote Codebase Audit

Date: 2026-06-12
Method: four parallel read-only reviewers (server core, in-server extensions, client PWA, Android). All findings were verified against the actual code by the reviewers; none are speculative. File:line references are as reported and may drift as the code changes.

## Cross-cutting themes

- **Stop writing production fallbacks for test doubles.** Server findings #1 (tree-nav events) and #2 (push 410 pruning) both exist because the test fakes diverge from real dependency behavior, and production code grew paths that only exist to satisfy the mocks.
- **Generation/identity tokens for replaceable connections.** The client WS store, the voice speechmux client, and Android's `WsClientImpl.pending` all share the same stale-closure-over-replaced-resource race.

---

# Cost tracking (`lifetimeCostUsd`) — follow-up audit (not covered by the four reviewers)

Added after the fact. `lifetimeCostUsd` is computed by `sumAssistantCostUsd` (`server/src/session-cost.ts`), a pure fold over session entries, called fresh on every `get_session_meta` (`ws-handler.ts`). There is no stateful accumulator, so the figure is recomputed from disk-rehydrated entries on every call — correct across live switches and reload-from-disk by construction.

**Change made:** the call site now folds over `getEntries()` (full append-only log, all branches) instead of `getBranch()` (current leaf branch only). Branching is append-only, so prior assistant turns are never duplicated; summing all entries counts each turn exactly once and no longer drops cost when the user walks back to a different branch.

**Captured correctly:**

- Every assistant turn across every branch, counted once.
- Tool-call token cost — a tool result is billed as input on the _following_ assistant turn, so it is already inside that turn's `usage.cost.total`; the `toolResult`/user entries carry no usage and are correctly skipped (no double-count, no miss).
- Cache-aware pricing — `usage.cost.total` is pi's pre-computed dollar amount that already prices `input`/`output`/`cacheRead`/`cacheWrite` at their own model rates. We sum `total`, so cache pricing is inherited, not re-derived.

**Excluded (cannot be recovered from the session file):**

- **Compaction / branch-summary LLM calls.** Real billed calls, but `CompactionEntry` / `BranchSummaryEntry` carry no usage/cost field, so their spend is invisible. Capturing it would require hooking `compaction_end` live and persisting cost — which breaks the stateless recompute-from-disk property and still can't be reconstructed for sessions already on disk.
- **Turns where the provider didn't populate `usage.cost.total`** (model with no pricing metadata, faux/self-hosted providers): that turn contributes 0 — silent undercount.

**Test gap:** the cost-accumulation smoke fabricates a _linear_ session, so it would not catch a branch-vs-no-branch regression. A branched-session fixture (walk back, re-prompt, assert both branches' costs sum) should be added to pin the `getEntries` behavior. Not yet done.

---

# Server core (server/src/\*\* excluding voice/ and static-host/, plus shared/src/protocol.ts)

## High

### 1. `tree_navigation_start/end` events are rewritten to `agent_start` by the real EventBuffer

**server/src/event-buffer.ts:283-286 (default case of `mapEvent`), exercised via ws-handler.ts `emitBufferedSessionEvent` (~line 1110)**
`emitBufferedSessionEvent` feeds `{type: 'tree_navigation_start'|'tree_navigation_end'}` into `EventBuffer.onEvent`, but `mapEvent` has no case for those types — the default branch returns `{...base, type: 'agent_start'}`. In production, clients receive spurious `agent_start` events (flipping the session into "working") and never receive the tree-navigation lifecycle events at all; the bogus `agent_start`s are also buffered for replay. The tests pass only because they use a mock EventBuffer whose `onEvent` no-ops, hitting the "test doubles" fallback in `emitBufferedSessionEvent` that preserves the raw type — i.e. the tests test the fallback, not production behavior. The codemap's claim that event-buffer maps "buffered `tree_navigation_*` lifecycle events" is false.
**Fix:** add explicit `tree_navigation_start`/`tree_navigation_end` cases to `mapEvent` (and make the default case a pass-through or a dropped/logged event, never `agent_start`). Delete the test-double fallback in `emitBufferedSessionEvent` and test against the real buffer.

### 2. Expired push subscriptions are never pruned — the 410 branch is dead code in production

**server/src/push-notification.ts:93-97 + server/src/push-infrastructure.ts:69-72**
`web-push`'s `sendNotification` _rejects_ with a `WebPushError` for any non-2xx status, including 410 Gone. So `WebPushSender.sendNotification` never returns `{statusCode: 410}` — the rejection lands in `notify()`'s `catch`, which only logs. `expiredEndpoints` is always empty; dead subscriptions accumulate forever, every notification fan-out re-sends to them and logs a warning. The unit tests pass because the fake sender returns `{statusCode: 410}` directly — a shape the real sender can't produce.
**Fix:** in `WebPushSender`, catch `WebPushError` and return its `statusCode` (or rethrow non-HTTP errors); alternatively have `notify()` inspect `err.statusCode` for 404/410 and prune.

### 3. Client disconnect mid-login permanently wedges the server-wide LoginOrchestrator

**server/src/ws-handler.ts:`cleanup()` (~line 1595) vs `pendingLoginInputs`/`loginAbort`**
`cleanup()` releases sessions but never aborts `loginAbort` or settles `pendingLoginInputs`. If the client disconnects while the flow is awaiting `requestInput`/`requestSelect` (e.g. the manual-code paste prompt), the promise dangles forever and `LoginOrchestrator.busy` stays `true` — login is single-flight and server-wide, so **all** future `login_begin`s from every client return `busy` until the server restarts. Reconnecting doesn't help: the new `WsHandler` has a fresh, empty `pendingLoginInputs` map, so `login_input` can't resolve the orphaned request.
**Fix:** in `cleanup()`, call `this.loginAbort?.abort()` and `this.settlePendingLoginInputs('connection closed')` (mirroring `login_cancel`).

### 4. Malformed `Host` header crashes the process via uncaught `new URL` throw

**server/src/server.ts:172 (`upgrade` handler) and :183 (`connection` handler)**
`new URL(req.url ?? '', \`http://${req.headers.host}\`)`throws`TypeError: Invalid URL`when the Host header contains characters illegal in a URL authority (spaces, etc.) — values Node's HTTP parser accepts. A synchronous throw inside an`'upgrade'`/`'connection'`listener is an uncaughtException → process exit. One crafted request kills the server (mitigated only if the edge proxy sanitizes Host).
**Fix:** wrap the URL construction in try/catch and`socket.destroy()`/`ws.close()`on failure, or parse`req.url` with a fixed dummy base (`new URL(req.url ?? '/', 'http://localhost')`) since only pathname/searchParams are used.

## Medium

### 5. Concurrent `open_session` for the same on-disk session leaks a live runtime

**server/src/ws-handler.ts `open_session` disk path (~line 380) + session-manager.ts `openSession`**
The `getSession(requestedSessionId)` existence check and the eventual `this.sessions.set(sessionId, slot)` are separated by long awaits (`resolveSessionPath`, full runtime construction). Two near-simultaneous opens of the same session file (two devices, or a reconnect double-fire) both pass the check, build two runtimes for the same session file, and the second `sessions.set` overwrites the first slot. The first runtime is never disposed: its event subscription, EventBus, and file handle live until process exit, and two pi runtimes append to the same session file.
**Fix:** keep a `Map<sessionId, Promise<string>>` of in-flight opens in `PimoteSessionManager` (single-flight per session file), or re-check the map after the awaits and dispose the loser.

### 6. The "session reset" business operation is reachable two ways and silently no-ops when unowned

**server/src/ws-handler.ts — `/new`+`new_session` use `slot.connection?.onSessionReset?.(slot)` (~lines 730, 980); `fork`+`navigate_tree` call `this.handleSessionReset(slot)` directly (~lines 1058, 1100)**
Principle-6 violation with concrete consequences: (a) when `slot.connection` is `null` (owner disconnected; resets triggered via extension `commandContextActions`), the optional-chained path **skips the reset entirely** — `rebuildSessionState`/`reKeySession` never run, so the session map stays keyed under the old session ID while `runtime.session.sessionId` has changed; subsequent commands and idle-reap address a phantom. (b) When the command issuer isn't the owner, the direct-call path sends `session_replaced` to the issuer and re-keys the issuer's bookkeeping, while the actual owner never learns the ID changed.
**Fix:** make `handleSessionReset`-equivalent logic live in one place (session manager level, not handler level) that always rebuilds/re-keys regardless of connection, then notifies whatever connection currently owns the slot.

### 7. Voice force-bind displacement never transfers ownership; stale `slot.connection` blocks idle reap

**server/src/voice-orchestrator.ts:86-88 + voice-orchestrator-boot.ts `displaceOwner` (param `_newOwner` ignored)**
`bindCall({force:true})` displaces via `sendDisplacedEvent` only — `slot.connection` is never set to the new caller's `ClientConnection` (the arg is discarded). The displaced handler also removed the session from its `subscribedSessions`, so its later `cleanup()` won't null `slot.connection` either. Result: session events stream into a dead/wrong socket, `connectedClientId` stays the displaced client's ID, and the idle reaper's `isClientConnected(staleClientId)` keeps returning true whenever that client is online — the session is never reaped despite having no real owner.
**Fix:** after displacement in `bindCall`, assign `slot.connection = args.clientConnection` (i.e., do what `claimSession` does), or route the voice bind through the same claim path as `open_session`.

### 8. `getGitBranch` shells out synchronously on hot paths, blocking the event loop

**server/src/git-branch.ts (execFileSync, 2s timeout × up to 2 invocations) — called from session-manager.ts gitBranchCheckHandle (every 3s per connected session), ws-handler.ts `broadcastSidebarUpdate` (every status change), and `get_session_meta`**
Each call can block the whole server for up to ~4s (two `execFileSync`s with 2s timeouts) — on a slow/NFS disk or a wedged git, all WebSocket traffic, voice signaling, and HTTP stalls. With N sessions the 3s poll multiplies this.
**Fix:** convert to async `execFile` (the call sites are either already async or can cache), or cache branch per folder with async refresh.

### 9. `call_end` has no ownership check and notifies only the requester

**server/src/ws-handler.ts:~520 (`call_end` case)**
Any connected client can end any session's voice call. Worse, the `call_ended` event is sent only to the requester — the actual call owner's client never receives it, so the server tears down the extension/bookkeeping while the owner's `VoiceCallStore` stays in `active` until WebRTC dies on its own.
**Fix:** route `call_ended` to the owning connection (lookup via `slot.connection.connectedClientId` → registry), and consider rejecting `call_end` from non-owners.

### 10. `void endCall()` in `sendDisplacedEvent` risks an unhandled rejection; displace-time call-teardown is duplicated

**server/src/ws-handler.ts:~1375 (`sendDisplacedEvent`) vs :~1180 (`displaceOwner` stale-handler branch)**
`void this.voiceOrchestrator.endCall(...)` discards the promise without a `.catch`; if `endCall` rejects (a bus listener throwing in `emit`), it's an unhandled rejection — process exit under default Node settings. The sibling path in `displaceOwner` does attach `.catch`, which also shows the same business operation ("tear down call on displacement") implemented in two places that have already drifted.
**Fix:** add `.catch` (or extract one `endCallOnDisplace(sessionId)` helper used by both sites).

### 11. `reKeySession` can silently overwrite another live slot

**server/src/session-manager.ts:~445**
If `switchSession`/fork lands on a session ID that is already open in another slot (client A has session X open; client B switches their slot to X's file), `reKeySession` does `sessions.set(newId, slot)` over the existing entry — slot A's runtime is orphaned (never disposed, still subscribed) and two runtimes share one file.
**Fix:** detect a pre-existing entry under `newId` and close it (or refuse the switch) before re-keying.

## Low

### 12. Timer/listener leaks in dialog and abort races

**server/src/extension-ui-bridge.ts:`dialogWithTimeout` (~line 70); ws-handler.ts `abort` case (~line 790)**
The timeout `setTimeout` is never cleared when the response wins (keeps the process alive / fires pointlessly), the abort listener stays registered on long-lived signals, and the 30s abort-watchdog timer in the `abort` handler isn't cleared when `session.abort()` wins. All benign individually but accumulate under load.
**Fix:** capture timer handles, clear them in a `finally`, and remove the abort listener after the race settles.

### 13. `notify()` iterates a reassignable subscriptions array across awaits

**server/src/push-notification.ts:36, 91**
`this.subscriptions` is reassigned by `removeSubscription` (filter → new array) while `notify()`'s `for...of` holds the old array across awaits, so a just-removed endpoint can still receive a send. Also a principle-4 adjacent smell: the loop closes over a reassignable slot. Sequential `await` per subscription additionally serializes fan-out behind the slowest endpoint.
**Fix:** snapshot `const subs = this.subscriptions` deliberately (or use `Promise.allSettled` over a snapshot) and filter against the current array when pruning.

### 14. `handleMessage` throws before the response-sending try block on `JSON.parse("null")`

**server/src/ws-handler.ts:~200**
`command.id` is dereferenced outside the second try/catch; a raw `null` payload throws `TypeError`, is caught only by the outer logger in server.ts, and the client gets no response (a hung request on their side). Trivial to fix by validating `command` is a non-null object right after parse.

### 15. `ensureVapidKeys` writes the config file non-atomically

**server/src/config.ts:~130**
Direct `writeFile` of the merged config (no tmp+rename, unlike the other stores). A crash mid-write corrupts the user's config. Boot-time only, hence low.

**Cross-cutting note:** the test-double fallback inside production code (`emitBufferedSessionEvent`'s `if (!forwarded)` branch, ws-handler.ts ~1120) is the root enabler of finding 1 — production code paths that exist only to satisfy mocks let the tests diverge from reality. Same pattern in the push tests (finding 2): the fake sender returns a shape the real sender cannot produce.

---

# In-server extensions (voice, static-host, voice-orchestrator, panels)

## High

### H1. Stale speechmux client's `close` event tears down the _next_ call

**server/src/voice/index.ts:205-236 + server/src/voice/speechmux-client.ts (close/notifyDisconnect) + server/src/voice/fsm/reducers/lifecycle.ts (`ws:disconnected`)**
The shell never unsubscribes `onFrame`/`onDisconnect` when it discards a client (`close_ws` just calls `close()` and nulls the slot). `client.close()` initiates a WS close handshake; the underlying `'close'` event fires milliseconds later and calls `notifyDisconnect()` (which is _not_ suppressed for locally-initiated closes), dispatching `ws:disconnected` into the FSM. If a new call has activated within that window, the lifecycle reducer sees `activating`/`active`, transitions to `dormant`, and emits `emit_deactivate_request` — killing the brand-new call. This window is reliably hit by the force-rebind flow (deactivate and re-activate are back-to-back), which is exactly the Android client's documented "single-retry on owned-displacement" path.
**Fix:** Capture the unsubscribe fns returned by `onFrame`/`onDisconnect` and call them in `close_ws`/`open_ws`'s discard path; or tag dispatched WS events with a client generation and drop events from non-current clients. Also consider suppressing `notifyDisconnect` after a local `close()`.

### H2. Deactivate during in-flight `open_ws` leaks a live speechmux socket

**server/src/voice/index.ts:205-228 (`open_ws`), server/src/voice/fsm/reducers/lifecycle.ts:99-104 (`ws:opened` in non-activating)**
`open_ws` awaits `clientFactory(...)`. If `eb:deactivate` (or `ws:open_failed`-driven teardown) arrives during that await, `close_ws` runs against a `null` slot — a no-op. When the factory resolves, the shell unconditionally assigns `speechmuxClient = client` and dispatches `ws:opened`; the reducer in `dormant` does nothing (the comment even says "Close the new connection if we somehow have one" but emits no close action). Result: an open, connected speechmux WS sits assigned with live frame listeners after the call has ended, until the next call's reentrancy guard happens to close it.
**Fix:** After the `await clientFactory(...)` resolves, check whether the lifecycle still expects this connection (e.g. compare against a per-activation token); if not, close the new client immediately. Alternatively make the `ws:opened`-while-not-activating reducer branch emit `close_ws`.

### H3. Walkback reducer is not gated on lifecycle — stale frames abort the agent in text mode

**server/src/voice/fsm/reducers/walkback.ts:46-75**
`reduceWalkback` handles `ws:incoming` `abort`/`rollback` frames unconditionally — unlike the cross-cutting `user`-frame handling in `reducer.ts:85-92`, which checks `lifecycle.kind === 'active'`. Combined with H1/H2 (leaked sockets with attached listeners), or simply frames in flight during teardown, an `abort` frame arriving while `dormant` fires `abort_agent` (killing whatever text-mode turn is running) and appends a `VOICE_INTERRUPT_CUSTOM_TYPE` entry into the conversation history of a session that's no longer in a call.
**Fix:** Gate the `ws:incoming` abort/rollback branch on lifecycle (pass it in like the top-level reducer does for user frames), dropping frames when not `active`/`activating`.

### H4. Server never learns when the extension self-deactivates — orchestrator state orphaned

**server/src/voice-orchestrator.ts (`activeCalls`), server/src/voice/index.ts:265-274 (`emit_deactivate_request`)**
On `ws:open_failed` or `ws:disconnected` the extension emits `pimote:voice:deactivate` on the session bus — but the only subscriber to that event is _the extension itself_ (grep confirms: nothing in `ws-handler.ts`, `session-manager.ts`, `server.ts`, or `index.ts` listens). So when the speechmux WS fails or drops mid-call: the extension goes dormant, but `VoiceOrchestrator.activeCalls` still contains the session. Consequences: `isCallActive` stays true → the extension UI bridge stays permanently gated (`UI_BRIDGE_DISABLED_IN_VOICE_MODE`), a subsequent `call_bind` without `force` fails with `call_bind_failed_owned`, and the client never receives `call_ended`/`call_status`.
**Fix:** Subscribe the server side (orchestrator or session manager) to `pimote:voice:deactivate` on each session bus and route it into `endCall(...)` + `sendCallEndedEvent(...)`. (See M1: the emitted message's `sessionId` must be fixed first.)

### H5. `@pimote/panels` `detect()`: module-level mutable map causes cross-session handle deactivation

**packages/panels/src/detect.ts:5**
`handles` is a module-scoped mutable `Map` keyed only by `key`. The pimote server hosts many `AgentSession`s in one process, all sharing this module. Two sessions whose extensions both call `detect(pi, 'mytool')` collide: the second `detect()` sets `prev.active = false` on the _first session's_ handle, silently stopping its panel updates forever. This is the package's primary multi-session use case, and it also violates the "no module-level mutable business state" principle (AGENTS.md §3).
**Fix:** Key the handle registry per extension instance — e.g. `WeakMap<ExtensionAPI, Map<string, {active}>>` — so re-detect deactivation is scoped to the same `pi` instance.

## Medium

### M1. `emit_deactivate_request` always emits `sessionId: ''`

**server/src/voice/index.ts:265-274**
Actions execute _after_ `state = next`. For `ws:disconnected`/`ws:open_failed` the reducer has already transitioned to `dormant`, so the executor's `state.lifecycle.kind === 'active' || 'activating'` check is always false and the emitted `VoiceDeactivateMessage.sessionId` is always `''`. Latent today only because nothing consumes the message (H4); it becomes a live bug the moment H4 is fixed.
**Fix:** Carry the sessionId on the action itself (`{ kind: 'emit_deactivate_request', sessionId }`), populated by the reducer from the pre-transition state.

### M2. `turn_end` / `agent_end` sends bypass the FSM's activating-phase buffer

**server/src/voice/index.ts:386-410**
These hooks call `speechmuxClient.send(...)` directly and bail when `state.lifecycle.kind !== 'active'`. Activation deliberately runs the greeting turn in parallel with the WS handshake; if the greeting turn ends before `ws:opened`, the `floor_released` frame is silently dropped (the buffered `token`/`end` frames flush on open, but not this). Speechmux is then never told the harness released the floor for the first utterance. Same gap for `agent_end` error frames. Structurally, this is a second emission path around the `bufferOrPassFrame` design the FSM exists to enforce.
**Fix:** Route these as FSM events (`sdk:turn_end`, `sdk:agent_end`) whose reducer emits `send_frame` actions, so they go through the standard buffer-or-pass routing.

### M3. Static-host: unnormalized `folderPath` breaks the containment check → everything 404s

**server/src/static-host/tools.ts:104-110 (no normalization), server/src/static-host/http-handler.ts:111-114**
`executeRegisterTool` accepts any absolute path verbatim — including a trailing slash (`/tmp/site/`) or internal `..` segments (`/tmp/a/../site`). The handler computes `resolved = path.resolve(folderPath, decoded)` (normalized) and compares against the _unnormalized_ `folderPath + path.sep`. With a trailing slash, `'/tmp/site/index.html'.startsWith('/tmp/site//')` is false → every request, including `/s/<slug>/`, returns 404, despite the register tool reporting success. Persisted and replayed, the breakage survives restarts.
**Fix:** `input.folder = path.resolve(input.folder)` in `executeRegisterTool` before stat/persist/register (one line; also makes the containment check's assumption explicit).

### M4. Static-host: agent-authored HTML served same-origin with the control PWA, no CSP/sandbox/nosniff; symlinks escape the root

**server/src/static-host/http-handler.ts:139-143**
Bundles are served from the pimote origin with no `Content-Security-Policy`, no `X-Content-Type-Options: nosniff`, and no sandboxing. Script in a hosted bundle runs with full access to the pimote origin: the WebSocket API (prompt/steer any session, takeover), `localStorage` (persistent clientId), and the service-worker scope. Since bundle content is agent-generated, a prompt-injected agent gains a persistent client-side foothold over the whole pimote deployment. Separately, `stat`/`createReadStream` follow symlinks, so a symlink inside a registered folder serves arbitrary readable files — the `..`-segment check doesn't cover this. Both are within the "trust the agent" model, but the same-origin exposure meaningfully widens the blast radius of one injected turn.
**Fix:** At minimum add `X-Content-Type-Options: nosniff` and a restrictive CSP (e.g. `Content-Security-Policy: sandbox allow-scripts` or `default-src 'self' /s/<slug>/`) on `/s/*` responses; check `lstat` (or `fs.realpath` containment) to refuse symlink escapes.

### M5. Context rewrite relies on a fragile "first action executes synchronously" invariant

**server/src/voice/index.ts:126, 277, 404-418**
The `context` hook calls `void dispatch({type:'sdk:context',...})` and then synchronously reads `pendingContextRewrite`. This works only because (a) `reduce` is synchronous, (b) `rewrite_context` happens to be the _first_ action with no `await` before it in `execute`, and (c) no other sub-reducer currently emits an earlier action for `sdk:context`. Any of those changing — an action emitted before `rewrite_context`, or an `await` added to that `execute` branch — silently disables walk-back surgery with no error. This is exactly the closure-over-reassignable-slot hazard AGENTS.md §4 warns about.
**Fix:** Don't route the rewrite through `dispatch`/actions at all: call `reduce` synchronously in the hook (or expose a synchronous `computeContextRewrite(state, messages)`), return `{ messages }` directly, and dispatch the state update separately.

### M6. `walkBack`: `droppedToolUseIds` is dead code; fully-heard speak's tool_result is still dropped

**server/src/voice/walk-back.ts:137-173**
`droppedToolUseIds` is populated in three places and never read — the function unconditionally returns `[...messages.slice(0, targetMsgIdx), rewrittenTarget]`, dropping _all_ subsequent messages. Consequences: (1) in the `heardText >= originalText` branch ("keep block intact"), the kept speak `toolCall`'s paired tool_result message is dropped anyway, leaving a dangling toolCall — the "keep intact" intent isn't actually honored; (2) earlier fully-heard speak blocks in the same message likewise lose their results. This is survivable only if pi tolerates `stopReason:'aborted'` assistants with dangling toolCalls on every provider — an assumption the dead set suggests was meant to be handled and wasn't.
**Fix:** Either delete the dead set and document the dangling-toolCall reliance explicitly, or finish the intended logic: retain subsequent tool_result messages whose ids are _not_ in `droppedToolUseIds`.

### M7. Binding a voice call aborts in-flight agent work

**server/src/voice/index.ts:172-189 + fsm/reducers/lifecycle.ts:60 (activate emits plain `send_user_message`)**
The activation sentinel is delivered via `send_user_message` without `deliverAs`, so the executor runs `ensureIdleWithImplicitAbort` — if the agent is mid-task (e.g. a long text-mode run) when the user starts a call, the task is silently `ctx.abort()`ed. Barge-in abort is right for mid-call user frames; it's questionable for call _start_, where steering (`deliverAs: 'steer'`) would preserve the running work. If the abort is deliberate, it deserves a comment; if not, it loses work.
**Fix:** Emit the start sentinel with `deliverAs: 'steer'` (the action already supports it), or document the intentional abort-on-bind.

## Low

### L1. Static-host replay-conflict entries become unremovable phantoms

**server/src/static-host/index.ts:118-133, tools.ts:169-172**
A persisted entry skipped at `session_start` due to slug conflict stays in the session's store file, but `executeRemoveTool` requires a registry entry owned by the session (`lookup` fails → `{removed:false}`), so the phantom can never be removed by the tool and is re-appended to every future write.
**Fix:** on replay conflict, either re-suffix the slug (reusing `resolveSlugCollision`) and rewrite the file, or drop the entry from the file.

### L2. Corrupted store file throws unguarded out of `session_start`

**server/src/static-host/store.ts:55, index.ts:117**
`store.read` does a bare `JSON.parse`; a truncated/corrupt `<sessionId>.json` rejects inside the async `session_start` handler, with behavior depending on how pi treats handler rejections (possibly breaking session load).
**Fix:** catch parse errors in `read`, warn, and return `undefined` (optionally quarantining the bad file).

### L3. Orphan `.tmp` files are never cleaned

**server/src/static-host/gc.ts:28, store.ts:62-66**
A crash between `writeFile(tmpPath)` and `rename` leaves `<sessionId>.json.tmp` forever; GC only considers `.json` names.
**Fix:** have `gcStaticHostStore` also unlink `*.json.tmp`.

### L4. GC treats sessions under temporarily-removed config roots as orphans

**server/src/index.ts:41-57, gc.ts**
`validSessionIds` is derived from currently-configured roots. Commenting a root out of config and rebooting permanently deletes static-host registrations for all that root's sessions, even though the sessions still exist on disk.
**Fix:** acceptable if "evicted" is defined that way, but worth a config-docs note or a grace policy.

### L5. `call_end` is not ownership-checked (duplicate of server #9)

**server/src/ws-handler.ts:600-604**
Any connected client can end any session's voice call (and receives a success + `call_ended`). Within pimote's single-user trust model this is mostly harmless, but it's free to gate on the call's owning client.

**Summary:** The static-host module is in good shape — traversal protection, atomic writes, and the GC empty-allowlist guard are all done carefully; M3 (path normalization) is the one functional bug there. The voice extension's pure-FSM core is well-designed, but the imperative shell around it has a cluster of lifecycle races rooted in two patterns: **listeners on discarded speechmux clients are never detached** (H1/H2/H3 chain), and **the deactivate back-channel to the server doesn't exist** (H4/M1). Fixing those two structurally — generation-tagged clients and a real server-side deactivate subscription — collapses most of the high-severity list.

---

# Client PWA (client/src/\*\*)

## High

### 1. `connection.svelte.ts` — socket callbacks have no connection-identity guard; stale closures corrupt singleton state

**client/src/lib/stores/connection.svelte.ts (onopen ~line 73–140, onclose ~line 200, connect guard ~line 57)**
Two concrete manifestations of the same structural flaw — every `ws.on*` handler and the restore `Promise.all` continuation mutate `this.*` without checking whether their socket is still the current one:

- **Stale sync completion marks a dead connection "ready."** If the socket drops while session restores are in flight, `onclose` rejects all pending requests, sets `ready = false`, and `scheduleReconnect()` sets `phase = 'backoff'`. The rejections settle the restore promises (each has `.catch(() => {})`), so on the next microtask the old `Promise.all(...).then` runs: it sets `ready = true`, `phase = 'ready'`, and fires `onReconnected?.()` — while the app is actually disconnected and in backoff. The UI shows "Connected" for the entire backoff window, anything gated on `connection.ready` is wrongly enabled, and `onReconnected` spuriously fires `view_session` / meta refreshes that all reject.
- **`connect()` doesn't guard against a CLOSING socket.** The re-entry guard only checks `CONNECTING || OPEN`. After `disconnect()` (or any close in flight), `reconnectNow()`/`connect()` creates a new socket while the old one is CLOSING; the old socket's queued `onclose` then runs and sets `this.ws = null` (clobbering the _new_ socket reference), rejects the shared `pending` map (which now contains the new connection's requests), and consumes/flips `intentionalClose` and `status` for the wrong connection.
  **Fix:** in `connect()`, capture `const ws = this.ws` (or a generation counter) and early-return from `onopen`/`onmessage`/`onclose` and the `Promise.all` continuation when `this.ws !== ws`. Also treat `CLOSING` in the re-entry guard (detach handlers from the old socket before replacing it).

## Medium

### 2. `voice-call.svelte.ts` — `startCall` has no phase re-check after its awaits; races with `call_ready`, `call_ended`, and `endCall`

**client/src/lib/stores/voice-call.svelte.ts (`startCall`, ~lines 95–140)**
`startCall` awaits `call_bind` and then `getUserMedia()` — the latter can block for **seconds** on the mic-permission prompt. During that window `handleServerEvent` can run:

- A server `call_ready` flips phase to `'connected'` and sets `startedAt`; `startCall` then unconditionally executes `this.state = { phase: 'connecting', …, startedAt: null }`, regressing the phase and wiping `startedAt`. (The synthetic ICE-connected `call_ready` usually rescues the phase later, but `startedAt` is re-stamped late, skewing the duration ticker.)
- A `call_ended` (displacement) or a user `endCall()` during the awaits tears everything down and sets `idle` — then `startCall` resumes, creates a peer + signaling socket, and sets phase `'connecting'`: a zombie call with a live mic that the store believes ended.
  **Fix:** introduce a per-call generation token (or re-check `this.state.phase`/`sessionId`) after each await; abandon and tear down locally-created resources when the call is no longer current. Don't overwrite the state object wholesale — merge phase transitions through a guard.

### 3. `session-registry.svelte.ts` — `openExistingSession` removes an already-tracked session on transient failure

**client/src/lib/stores/session-registry.svelte.ts (`openExistingSession`, ~lines 600–640)**
`alreadyTracked` is computed but never used in the cleanup paths: both the `!response.success` (non-`session_owned`) branch and the `catch` branch call `removeSession(sessionId)` unconditionally. `confirmTakeover` and the notification-adopt path route through this function for sessions the user already has open — a transient WS error (e.g. socket dropped mid-request, which `connection.send` turns into a rejection) deletes the user's tab, draft text, and pending steering messages, and unpersists the session.
**Fix:** only run the remove-cleanup when `!alreadyTracked`; for a previously tracked session, leave registry state intact (the reconnect cycle already retries restores).

### 4. `CallGestureZone.svelte` + `call-audio-cues.ts` — one leaked `AudioContext` per call

**client/src/lib/components/CallGestureZone.svelte:14-18, client/src/lib/call-audio-cues.ts**
`CallingMode` (and thus `CallGestureZone`) mounts per call. The first gesture creates an `AudioContext` via `createCallAudioCues()`, and nothing ever closes it — `CallAudioCues` has no dispose API and the component has no destroy cleanup. Browsers cap concurrent `AudioContext`s (mobile Safari ~4; Chrome warns and eventually refuses): after a handful of calls in one PWA session, cue beeps silently stop working and audio resources accumulate.
**Fix:** add a `dispose(): void` to `CallAudioCues` that closes the cached context, and call it from an `$effect` cleanup / `onDestroy` in `CallGestureZone`.

## Low

### 5. `extension-ui-queue.svelte.ts` — `sendResponse` drops the request on send failure and leaks an unhandled rejection

**client/src/lib/stores/extension-ui-queue.svelte.ts (`sendResponse`, ~line 60)**
`connection.send(...)` is fire-and-forget with no `.catch`. If the WS is down (exactly when stale dialogs are likely to be answered), the promise rejects unhandled _and_ the request is removed from the queue anyway — the extension's dialog stays unresolved server-side with no client-side affordance left to answer it. Separately, queue entries for sessions that get closed are never pruned, so `hasRequestForSession` can stay true forever for dead sessions.
**Fix:** `.catch` the send and keep (or re-queue) the entry on failure; prune queue entries in the `session_closed` handler.

### 6. `TextBlock.svelte` / `smd-renderer.ts` — renderer's `IncrementalHighlighter` never disposed

**client/src/lib/smd-renderer.ts:93 (created), client/src/lib/components/TextBlock.svelte:40-46 (cleanup)**
`createRenderer` creates a highlighter with a 100 ms trailing timer, but the renderer exposes no dispose surface and `TextBlock`'s effect cleanup only clears `container.innerHTML`. A component destroyed mid-stream leaves a pending timer that fires and writes `innerHTML` into a detached node. Harmless today, but `dispose()` exists and `WriteFileBlock` already does this correctly — the asymmetry will bite if the highlighter ever grows heavier state.
**Fix:** return the highlighter (or a `dispose`) alongside the renderer and call it in `TextBlock`'s effect cleanup.

### 7. `connection.svelte.ts` — `reconnectNow` resets backoff unconditionally

**client/src/lib/stores/connection.svelte.ts (`reconnectNow`, ~line 232)**
Every focus/visibility/online/pageshow event during backoff resets `reconnectDelay` to 1000 ms. On a flapping network with the tab focused (mobile foreground), the exponential backoff effectively never grows beyond ~1–2 s. Deliberate UX tradeoff perhaps, but worth capping resets (e.g. only reset if the last attempt was > N seconds ago).

**Notes (no action required, observed and judged acceptable):**

- **XSS paths are sound.** All markdown HTML goes through smd's DOM-building renderer (no raw `{@html}`); `set_attr` allowlists `https|http|mailto` for href/src; `code-highlight.ts` escapes plain text before `innerHTML`; the only `<a href>` from untrusted-ish data (`Panel.svelte` `card.href`) originates from server-side extensions, which are already in the trust boundary.
- **`voice-call-seams.ts`** carries inline fixes (analyser track listeners, stats interval, bound session id, inbound-ICE re-drain) — all verified present and correct.
- **`sw.ts`** is conservative and correct for its scope (push-only, no precache); the Windows focus workaround's restart fallback errs on showing notifications, which is the safe direction.
- **Module-level singletons with import side effects** (`session-registry` hydration + event wiring, `voice-call-store.ts`, `login-store.ts`) technically brush against the global-state principle, but they follow the init-time-wire-then-stable carve-out consistently and the seam-injected store classes underneath are properly testable.

---

# Android client (mobile/android/app/src/main/kotlin/com/pimote/android/)

## Critical

### C1. Unhandled `WsConnectionLost` / `WsRequestTimeout` in `runOutgoing` crashes the process and leaks the Telecom Connection

**call/CallController.kt:454–495 (`runOutgoing`, steps 1–2)**
`wsClient.request(...)` at lines 461, 482, and 487 throws `WsRequestTimeout` (10 s watchdog) or `WsConnectionLost` (socket drop mid-request — see `net/WsClient.kt:335` `failAllPending`). `runOutgoing` only catches `PeerConnectionFailed` around `peer.connect`. The coroutine is launched into `applicationScope` (`SupervisorJob`, no `CoroutineExceptionHandler` — `app/AppContainer.kt:57`), so any WS hiccup while dialing/binding propagates to the default handler and **kills the app**. Even ignoring the crash, `terminate(...)` is never called: the Telecom `Connection` is never destroyed (system keeps an in-call state), the `Live` slot persists, and state sticks in `Dialing`/`Binding`. This is trivially reachable: place a call while the server is briefly unreachable, or have the WS drop during `open_session`.
**Fix:** wrap the body of `runOutgoing` (or each `wsClient.request`) in a `try/catch (Throwable)` that routes to `terminate(BIND_FAILED, failureReason = ...)`, rethrowing `CancellationException`.

## High

### H1. `CallState` never returns from `Ended` to `Idle` — the in-call UI never launches for the second call

**call/CallController.kt:376 (`performTermination` sets `Ended`), app/AppContainer.kt:288**
Nothing transitions `Ended → Idle` except `onAppShutdown` (line 446/451). The interface doc ("state goes back to Idle after the held connection is released") and the codemap both promise the reset; it isn't implemented. Consequences:

- `AppContainer`'s `InCallActivity` launcher fires only on the `Idle → non-Idle` edge (`prev == true && !cur`, line 288). After the first call the mapped flow is `false` forever (`Ended → Dialing` is `false → false`), so **no subsequent call in the same process ever auto-opens the in-call screen**. The only ways back in are the notification tap or a still-open activity.
- `InCallActivity` auto-finishes only on `Idle` (`ui/call/InCallScreen.kt:306`), which now never happens.
  **Fix:** implement the documented reset — e.g. `_state.compareAndSet(Ended(...), Idle)` after the user dismisses, or have `startOutgoing` reset to `Idle` before installing the new `Live`; alternatively change the launch edge to "non-Idle/Ended → active" like the foreground-service edge at line 253 (which is why the FGS _does_ work for call #2).

### H2. `startOutgoing` overwrites a live call without terminating it — leaks the old peer (mic) and Telecom Connection

**call/CallController.kt:279–304**
`startOutgoing` does `live.value?.callJob?.cancel()` then `live.value = Live(...)`. Cancelling `callJob` does **not** run teardown: if the old call was `Active` (suspended in the outcome race), cancellation just kills the watcher coroutines — `terminate` never runs for the old call. The old `SpeechmuxPeer` is never `disconnect()`ed (AudioRecord/ADM stay allocated, mic indicator stays lit) and the old `PimoteConnection` is never `setDisconnected`/`destroy`ed (Telecom keeps the call). The new `Live` simply replaces the slot, dropping the only references. Telecom _usually_ prevents a second outgoing self-managed call, but `CallByNameActivity`/Assistant fulfillment makes a second `placeCall` while one is active entirely plausible.
**Fix:** call `terminate(CallEndReason.USER_HANGUP)` (or a dedicated reason) on the existing slot before installing the new one — the single-business-operation rule says this must go through `terminate`, not a bare `cancel()`.

### H3. Missing torn-down check after `peer.connect` — hangup racing ICE-connected leaves state stuck in `Active` on a destroyed Connection

**call/CallController.kt:508–527**
`runOutgoing` checks `live.value == null` after resolving the sessionId and after creating the peer, but **not** after `peer.connect(...)` returns. Sequence: user hangs up during `Negotiating` → `endCurrentCall` calls `terminate` directly (line ~315) → connection destroyed, peer disconnected, state = `Ended`. If ICE reached `CONNECTED` concurrently, `connectedDeferred` completes successfully and `peer.connect` returns normally — then line 526–527 call `connection.reportActive()` on a **destroyed** Connection and force `_state = Active(sessionId)`. Line 540 (`live.value?.userHangup ?: return`) then bails, so the state machine is stuck in `Active` forever: foreground service stays up, proximity lock can blank the screen, and no path can terminate (the `Live` slot is already null).
**Fix:** add `if (live.value == null) return` (or check `terminate`'s result) between `peer.connect` returning and `reportActive()`; better, fold the post-connect transition into a `live.update`-guarded step.

## Medium

### M1. `SpeechmuxPeerImpl` treats transient ICE `DISCONNECTED` as fatal, and has no negotiation timeout

**voice/SpeechmuxPeerImpl.kt:175–177, 343**

- `IceConnectionState.DISCONNECTED` → `PeerState.Failed("ice_disconnected")`. DISCONNECTED is frequently transient (Wi-Fi↔cellular handoff, brief RF loss) and libwebrtc routinely recovers to `CONNECTED`; the controller's watcher (`peer.state.first { it is PeerState.Failed }`) ends the call immediately. Every short network blip kills an active call that would have survived. Note `DISCONNECTED` also doesn't complete `connectedDeferred`, so a pre-connect DISCONNECTED that never progresses leaves `connect()` suspended.
- `connect()` has no overall deadline: signaling can open and then `connectedDeferred.await()` (line 343) suspends forever if `session`/`answer` never arrives or ICE never resolves. The call sits in `Negotiating` until the user manually hangs up.
  **Fix:** apply a grace timer (3–5 s) on DISCONNECTED before declaring `Failed` (mirror what the PWA does or document why not), and wrap the connect sequence in `withTimeout(...)` mapping to `PeerConnectionFailed("negotiation_timeout")`.

### M2. `SpeechmuxPeerImpl.disconnect()` is not actually idempotent under concurrency — double native dispose possible

**voice/SpeechmuxPeerImpl.kt:575–660**
The comment claims "a second disconnect() is a no-op," but the snapshot-then-null sequence is plain, unsynchronized field access on non-volatile `var`s. Two threads can race it: `terminate` → `snapshot.peer?.disconnect()` (caller thread) concurrently with `connect()`'s `catch` → `disconnect()` (IO thread). Both can snapshot the same non-null `peer`/`factory` and spawn two cleanup threads, each calling `peer.close()`, `factory.dispose()`, `adm.release()`. The `try/catch (Throwable)` wrappers don't help against a native use-after-free SIGSEGV from double-dispose.
**Fix:** gate disconnect with an `AtomicBoolean.compareAndSet` (or move the per-call fields into one `AtomicReference<Snapshot?>` swapped to null, matching the `CallControllerImpl.Live` pattern this codebase already uses).

### M3. `WsClientImpl.pending` is global across sessions — a dying connection loop can fail the new session's in-flight requests

**net/WsClient.kt:162, 283–287**
`pending` is client-wide, but `failAllPending()` runs in the old loop's non-suspending tail (after `conn.events.collect` exits, line 286). When `connect(newOrigin)` cancels the old session's scope, the old loop on another thread can still execute that tail (cancellation only takes effect at suspension points) and clear/fail requests issued against the _new_ session. Same window lets the old loop's `waitForRetry` stamp `_state = Reconnecting(...)` over the new session's `Connecting`. Narrow window, but it's exactly the closure-over-shared-slot hazard the rest of this file was refactored to remove.
**Fix:** move `pending` (and ideally `_state` writes) into the per-connect `Session` record, or have the tail check `session.value === target` before calling `failAllPending`/touching `_state`.

### M4. WsClient contract lies about backoff reset on network availability

**net/WsClient.kt:95, 296–318**
Interface doc: "Network-availability events reset `attempt` to 0 and trigger an immediate retry." The wake-watcher in `waitForRetry` only cuts the _current_ delay short; `attempt` keeps incrementing (the trailing comment "If a network wake reset us to attempt=0, callers handle it" is false — nothing resets it). After a long outage, the immediate post-wake attempt is fine, but if it fails (server still booting after the phone regained network) the next delay is the full 30 s cap instead of restarting the schedule.
**Fix:** have `waitForRetry` return 0 (or a sentinel) when the wake fired, or fix the docs if current behavior is intended — right now code and contract disagree.

## Low

### L1. `ContactSyncRunner.updateRawContactOps` never converges for partially-broken contacts

**contacts/ContactSyncRunner.kt:300–323**
Updates use `newUpdate` with a selection on `RAW_CONTACT_ID + MIMETYPE`. If the targeted data row is missing (user edited/deleted the name or callable row via the Contacts app — only the _both-rows-missing_ case is handled by the `orphan:` path in `readExistingContacts`), the update matches zero rows, silently no-ops, and `diff` re-emits the same `UpdatePair` on every reconcile forever. The contact stays wrong/uncallable.
**Fix:** detect half-orphans in `readExistingContacts` (one of the two values blank) and route them through delete+reinsert like full orphans, or use insert-or-update semantics.

### L2. `PimoteConnection` is left in `STATE_INITIALIZING` until `Active` — `setDialing()` is never called

**telephony/PimoteConnectionService.kt:52, call/CallController.kt**
`onCreateOutgoingConnection` calls `conn.setInitializing()` and nothing transitions the Connection until `reportActive()` (potentially 10+ s later, or never on the C1 bug). The self-managed contract expects the app to move an outgoing connection to `STATE_DIALING` promptly; Telecom and connected surfaces (Android Auto, BT HFP) display call state from the Connection, which here reads "initializing" through the whole dial/bind/negotiate phase. It evidently works on the tested device, but it's off-contract and gives wrong state to in-car UIs.
**Fix:** call `setDialing()` (e.g. from `startOutgoing` via a `reportDialing()` on the `CallConnection` seam) once dispatch begins.

### L3. `SpeechmuxPeerImpl.connect` swallows `CancellationException`

**voice/SpeechmuxPeerImpl.kt:347–350**
`catch (e: Throwable) { disconnect(); throw PeerConnectionFailed(...) }` converts cooperative cancellation into a `PeerConnectionFailed`, so a cancelled `callJob` takes the error path (`terminate(PEER_FAILED)`) instead of unwinding as cancelled. Mostly masked by `terminate`'s CAS today, but it's the standard catch-Throwable-without-rethrowing-cancellation bug and will bite any future caller.
**Fix:** add `catch (e: CancellationException) { disconnect(); throw e }` before the generic catch.

### L4. `OkHttpWsTransport` can silently drop inbound WS frames under backpressure

**net/OkHttpWsTransport.kt:33–58**
`callbackFlow` + `trySend` with the default 64-element channel: if the collector (`connectionLoop` → `handleMessage` → `_events.emit`, which suspends when the shared flow's 64-slot buffer is full with a slow subscriber) falls behind, `trySend` drops messages — including command **responses**, which then surface as spurious `WsRequestTimeout`s. Unlikely at current message rates, but it's silent data loss.
**Fix:** use `trySendBlocking`/`sendBlocking` (OkHttp listener threads tolerate it) or a `Channel.UNLIMITED` buffer on the callbackFlow.

### L5. Principle violations / dead code worth a pass

- **call/CallForegroundService.kt:180, 192–196** — `ACTION_STOP` + companion `stop()` are dead (no callers); the service self-stops. Also `stop()` uses `startService`, which throws from the background on O+ — delete or fix before someone uses it.
- **telephony/PimoteConnection.kt:103–108** — `mapEndReasonToDisconnectCause` maps `USER_HANGUP → DisconnectCause.REMOTE`; the branch is unreachable (local hangup goes through `disconnectAsLocalHangup`), but the mapping is wrong on its face and will mislead the next reader. Make the unreachable reasons `error("unreachable")` or fix the mapping.
- **net/WsClient.kt:55** — `WsState.Failed` is declared and documented but never emitted; either wire it up or remove it.

**What was checked and found sound (no findings):**

- **`terminate`/`compareAndSet` core**: the CAS loop itself is correct — concurrent terminations resolve to exactly one `performTermination`; the server-notify policy lives in one place per principle 6.
- **ContactsSync diff** (pure part): sourceId-keyed insert/delete/update logic is correct; the batch back-reference indexing fix (`rawRefIdx = batch.size`) is right.
- **ShortcutsSync / ShortcutsRunner**: diff caveat is documented and the runner correctly sidesteps it with full `setDynamicShortcuts`.
- **ProximityScreenLock**: idempotent, policy-driven, `RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY` on release — no leak path found.
- **SessionRepository**: reducer is pure, refresh-on-reconnect edge via `runningFold` is correct, no `var prev` captures.
- **SpeechmuxPeerImpl resource ordering**: track/source dispose before `peer.close()`, factory before ADM release — matches the documented Pixel mic-indicator constraints.
