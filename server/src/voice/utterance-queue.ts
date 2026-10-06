import { ensureIdleWithImplicitAbort, waitUnlessCancelled, type VoiceSessionControl } from './wait-for-idle.js';

interface PendingMessage {
  text: string;
  deliverAs?: 'steer' | 'followUp';
}

interface SubmissionGeneration {
  controller: AbortController;
  pending: PendingMessage[];
  draining: boolean;
}

interface Submission {
  generation: SubmissionGeneration;
  started: boolean;
  cancelBeforeStart: boolean;
  operation: Promise<void>;
}

function newGeneration(): SubmissionGeneration {
  return { controller: new AbortController(), pending: [], draining: false };
}

/**
 * Per-voice-instance owner of pending user utterances. Only one submission may
 * cross the session interface at a time, including the SDK's async preflight
 * where isIdle is still true. New utterances interrupt the previous reply but
 * their text remains FIFO until that reply has fully settled.
 */
export class VoiceUtteranceQueue {
  private generation = newGeneration();
  private submission: Submission | null = null;

  constructor(
    private readonly getSession: () => VoiceSessionControl,
    private readonly reportError: (error: unknown) => void,
  ) {}

  submit(text: string, deliverAs?: 'steer' | 'followUp'): void {
    const generation = this.generation;
    generation.pending.push({ text, deliverAs });
    // A pending voice submission may still be in async preflight. Its
    // agent_start hook will perform the abort when it becomes interruptible.
    if (deliverAs !== 'steer' && this.submission?.started && !this.getSession().isIdle) this.abort();
    if (!generation.draining) {
      generation.draining = true;
      void this.drain(generation);
    }
  }

  cancelPending(): void {
    const generation = this.generation;
    generation.pending.length = 0;
    generation.controller.abort();
    // An already-started reply survives call end, matching voice's existing
    // teardown semantics. A not-yet-started stale preflight is aborted as
    // soon as it reaches agent_start; the SDK has no preflight cancel signal.
    if (this.submission && !this.submission.started) this.submission.cancelBeforeStart = true;
    this.generation = newGeneration();
  }

  agentStarted(): void {
    const submission = this.submission;
    if (!submission) return;
    submission.started = true;
    if (submission.cancelBeforeStart || submission.generation.pending.length > 0) this.abort();
  }

  private abort(): void {
    void this.getSession().abort().catch(this.reportError);
  }

  private async drain(generation: SubmissionGeneration): Promise<void> {
    const signal = generation.controller.signal;
    const session = this.getSession();
    try {
      while (generation.pending.length > 0 && !signal.aborted) {
        // Cancellation releases the voice executor immediately, but an
        // already-submitted session operation still owns its async cleanup.
        // A replacement generation must not overlap that operation.
        const prior = this.submission;
        const message = generation.pending[0];
        if (prior && message.deliverAs === 'steer' && prior.started && !prior.cancelBeforeStart && !session.isIdle) {
          // Rebinding voice while the prior call's reply survives teardown
          // must still steer, not abort or wait for that reply to finish.
          // Keep the old run in the submission barrier for ordinary utterances.
          generation.pending.shift();
          const steering = session.sendUserMessage(message.text, { deliverAs: 'steer' });
          const combined = Promise.all([prior.operation, steering])
            .then(() => {})
            .finally(() => {
              if (this.submission === prior && prior.operation === combined) this.submission = null;
            });
          prior.operation = combined;
          // Both operations already have owner-specific error observers.
          void combined.catch(() => {});
          if (!(await waitUnlessCancelled(steering, signal))) return;
          continue;
        }
        if (prior && !(await waitUnlessCancelled(prior.operation, signal))) return;
        if (signal.aborted) return;
        if (message.deliverAs !== 'steer' && !(await ensureIdleWithImplicitAbort(session, signal))) return;
        if (signal.aborted) return;
        generation.pending.shift();

        const submission: Submission = {
          generation,
          started: false,
          cancelBeforeStart: false,
          operation: Promise.resolve(),
        };
        this.submission = submission;
        const options = message.deliverAs ? { deliverAs: message.deliverAs } : undefined;
        const operation = session.sendUserMessage(message.text, options).finally(() => {
          if (this.submission === submission && submission.operation === operation) this.submission = null;
        });
        submission.operation = operation;
        if (!(await waitUnlessCancelled(submission.operation, signal))) return;
      }
    } catch (error) {
      // A rejected full-run promise may mean preflight failed or an admitted
      // run failed later. Retrying its shifted head could duplicate history.
      // Report it; the remaining FIFO backlog resumes on the next submit.
      this.reportError(error);
    } finally {
      generation.draining = false;
    }
  }
}
