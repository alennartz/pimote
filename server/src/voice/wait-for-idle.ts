// Wait-for-idle helper for the voice extension.
//
// The speechmux abort/user frame pair on barge-in arrives as two
// independent reducer calls. The `abort` action calls `ctx.abort()`
// (fire-and-forget — the actual teardown completes asynchronously). If
// the user frame arrives before the teardown is done, `sendUserMessage`
// throws ("Agent is already processing…") and the user's utterance is
// silently dropped.
//
// Steering doesn't help: pi-agent-core doesn't drain the steer queue on
// the abort exit path of `runLoop`. Pimote has a separate
// `autoDrainOnAbort` listener (see `auto-drain-on-abort.ts`) that
// rescues queued messages after an aborted run, but that only catches
// messages that *were* queued — it doesn't help an unqueued
// `sendUserMessage` that throws.
//
// So the voice extension polls `ctx.isIdle()` before calling
// `sendUserMessage` (without `deliverAs`), guaranteeing the SDK won't
// throw. Auto-drain remains a belt-and-braces safety net for any
// queued path that races an abort.

/** Minimal shape of `ExtensionContext` we depend on. Lets tests pass a fake. */
export interface IdleProbe {
  isIdle(): boolean;
}

/** Idle probe that can also abort an in-flight turn. */
export interface AbortableIdleProbe extends IdleProbe {
  abort(): void;
}

/**
 * Resolve once the agent is idle, polling with exponential backoff
 * (start 5 ms, doubling, capped at 50 ms). Returns false if the agent
 * never becomes idle within `timeoutMs`. Returns true immediately
 * when already idle.
 *
 * Timeout default of 2 s is well above any normal abort-teardown
 * latency (tens to a few hundred ms). If a real agent doesn't reach
 * idle within 2 s, something is genuinely stuck and dropping the
 * message is preferable to hanging the executor.
 */
export async function waitForAgentIdle(ctx: IdleProbe, timeoutMs = 2000): Promise<boolean> {
  if (ctx.isIdle()) return true;
  const start = Date.now();
  let delay = 5;
  while (!ctx.isIdle()) {
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    delay = Math.min(50, delay * 2);
  }
  return true;
}

/**
 * Ensure the agent is idle, synthesising a barge-in when it isn't.
 *
 * Speechmux only emits `abort` while it is actively playing TTS — i.e.
 * during the harness's `token`/`end` stream. While the worker is
 * silently reasoning between a `user` frame and its first `speak()`
 * call, speechmux has no signal that the agent is busy and won't
 * pre-empt. If the user starts a new utterance during that window, the
 * `user` frame arrives at the harness with no preceding `abort`, so the
 * agent is still mid-turn and `sendUserMessage` would race / be
 * dropped.
 *
 * This helper closes that gap: when the agent isn't idle on entry, we
 * fire `ctx.abort()` ourselves (idempotent if a real barge-in already
 * issued one) and then poll for idle the same way the abort/user pair
 * already does. Returns true once idle, false on timeout.
 */
export async function ensureIdleWithImplicitAbort(ctx: AbortableIdleProbe, timeoutMs = 2000): Promise<boolean> {
  if (ctx.isIdle()) return true;
  ctx.abort();
  return waitForAgentIdle(ctx, timeoutMs);
}
