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
