// Auto-drain queued steering / follow-up messages after an aborted run.
//
// pi-agent-core's `runLoop` exits without polling the steering queue when
// an abort signal fires mid-stream (see `agent-loop.js` — the
// `stopReason === 'aborted'` branch returns immediately, before the
// trailing `getSteeringMessages` poll). Any messages queued before / during
// the abort would otherwise sit in the queue until something else calls
// `agent.prompt()` or `agent.continue()`.
//
// In pimote this surfaces as silently-dropped user messages whenever a
// queued steer races with an abort — most visibly during voice-mode
// barge-in, but also for typed-mode users who queue a follow-up while the
// agent is streaming and then hit the abort button.
//
// The fix is to call `agent.continue()` after the run settles: from the
// pi-agent-core source, `continue()` explicitly drains the steering queue
// (and falls back to follow-up if steering is empty) and replays the
// drained messages as a fresh prompt.

import type { AgentMessage } from '@mariozechner/pi-agent-core';

/**
 * Minimal shape of the parts of pi's `AgentSession` we touch. Letting
 * tests substitute a fake without spinning up a real session.
 */
export interface AutoDrainSession {
  /** Count of pending steering + follow-up messages (mirrored on AgentSession). */
  pendingMessageCount: number;
  agent: {
    /** Resolve when the current run (if any) has fully settled. */
    waitForIdle(): Promise<void>;
    /** Drain the steering / follow-up queue and run them as a fresh prompt. */
    continue(): Promise<void>;
  };
}

/**
 * If `lastMessage` is the aborted-assistant synthetic that pi appends on
 * abort and the session has queued messages, wait for the current run to
 * settle and then drain the queue via `agent.continue()`.
 *
 * Idempotent: after `continue()` runs, the queue is empty so a re-entry
 * (e.g. another agent_end) becomes a no-op. Errors from `continue()`
 * (notably "Agent is already processing" when something else races us to
 * a new prompt) are swallowed via `onError` — losing the auto-drain in
 * that case is acceptable because the racing prompt itself will drain
 * the queue inside `runLoop`'s initial `getSteeringMessages` poll.
 */
export async function autoDrainOnAbort(
  session: AutoDrainSession,
  lastMessage: AgentMessage | undefined,
  onError: (err: unknown) => void = (err) => console.warn('[pimote] auto-drain after abort failed', err),
): Promise<void> {
  if (!lastMessage || (lastMessage as { stopReason?: string }).stopReason !== 'aborted') {
    return;
  }
  try {
    // The `agent_end` listener fires before `finishRun()` clears the
    // run's `activeRun` reference. `waitForIdle()` resolves on the same
    // promise that `finishRun` resolves, so awaiting it parks us until
    // `agent.continue()` is safe to call without throwing
    // "Agent is already processing".
    await session.agent.waitForIdle();
    if (session.pendingMessageCount === 0) return;
    await session.agent.continue();
  } catch (err) {
    onError(err);
  }
}
