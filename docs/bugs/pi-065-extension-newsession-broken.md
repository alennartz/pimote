# Bug: `pi.*` calls target the disposed session after `ctx.newSession()`

**pi version**: 0.65.0 (unchanged through 0.66.1)  
**Severity**: Breaking — silent data loss and invisible side effects

## Verification against SDK ^1.1.0 (2026-07, manager-lifecycle test-write)

Verified with the regression test `server/src/pi-065-newsession.test.ts`:

- **The dangerous half is fixed upstream.** After `runtime.newSession()`, a `pi.*` call on the ctx captured at load time no longer silently targets the disposed session. It **throws synchronously**: `This extension ctx is stale after session replacement or reload ... move post-replacement work into withSession and use the ctx passed to withSession.` No ghost execution, no silent data loss.
- **No rebinding.** The stale ctx does not act on the replacement session; callers must move post-replacement work into `withSession`.
- **Ruling:** fail-fast is the accepted contract. Pimote does not extend the patch-package patch (DR-006 precedent): pimote's own code never captures extension ctx across a replacement — resets go through `slot.runtime.newSession` + `applySessionReset` in `ws-handler.ts` — so a rebind patch would add upgrade-maintenance surface for a pattern we do not use. The manager-lifecycle plan's conditional ("if the stale binding persists, extend patch") does not fire.
- The regression test pins the fail-fast contract: stale calls throw, the disposed session runs zero tools and emits zero events, and the replacement session prompts normally.

## Summary

After a command handler calls `ctx.newSession()`, all `pi.*` actions still target the old, disposed session. The old agent processes prompts, executes tools, and writes to the filesystem—but emits no events. The new session sits empty.

## Reproduction

```typescript
pi.registerCommand('next-phase', {
  description: 'Start next phase in a new session',
  handler: async (args, ctx) => {
    await ctx.newSession();

    // Goes to the disposed old session, not the new one.
    pi.sendUserMessage('Begin the next phase...');
  },
});
```

What the user sees:

- The new session appears empty—it never receives the prompt.
- The old agent runs invisibly: calls the LLM, executes tools, writes to the filesystem. No events are emitted.
- Extension UI dialogs still appear. The old agent's tool calls trigger tools whose UI hooks are bound to the new context, so pop-ups work even though the messages they belong to are invisible.
- Nothing is persisted. `dispose()` disconnected the old session's event handler; the new session was never prompted. The ghost agent's work exists only in memory.

## Analysis (AI-generated — may be inaccurate)

Each `AgentSession` creates its own `ExtensionRunner` with its own `runtime` object. Extensions close over that `runtime` at load time:

```
loadExtension → createExtensionAPI(extension, runtime, ...) → factory(api)
// api.sendMessage delegates to runtime.sendMessage
```

`_bindExtensionCore` binds `runtime.sendMessage` and friends to closures over `this` — the owning `AgentSession`:

```javascript
runner.bindCore({
  sendMessage: (msg, opts) => {
    this.sendCustomMessage(msg, opts);
  },
  sendUserMessage: (content, opts) => {
    this.sendUserMessage(content, opts);
  },
  // ... same pattern for every pi.* action
});
```

`AgentSessionRuntime.newSession()` disposes the old session, creates a new `AgentSession` with a **new** runner and a **new** `runtime`. The old runner — still held by the running command handler — keeps its stale bindings.

| Call after `ctx.newSession()` | Bound to             | Result         |
| ----------------------------- | -------------------- | -------------- |
| `pi.sendMessage()`            | Old disposed session | ❌ Silent void |
| `pi.sendUserMessage()`        | Old disposed session | ❌ Silent void |
| Every other `pi.*` action     | Old disposed session | ❌ Silent void |

### Why the old agent keeps running

`dispose()` unsubscribes from agent events and clears listeners. It does not prevent `prompt()` from executing. The old agent processes the prompt, calls the LLM, and executes tools — real filesystem writes — with no event subscriber to capture or forward any of it.

### The TUI has the same problem

`handleRuntimeSessionChange()` rebinds extensions on the new session. The old runner held by the command handler is never updated.

## Suggested Fix (AI-generated — may be inaccurate)

The `runtime` object that extensions close over must survive session replacement:

1. **Reuse it** — pass the existing `runtime` to the new `ExtensionRunner` instead of creating a fresh one. `bindCore()` on the new session then updates the same object.
2. **Proxy it** — make `runtime` a thin proxy whose target is swapped on rebind.
3. **Patch it** — after `apply()`, copy the new bindings onto the old `runtime` so existing closures see the update.
