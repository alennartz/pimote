// Voice owns interruption and submission. User utterances are retained here
// until the session's abort/idle promise settles, not sent into the SDK queue
// while an aborted run is still tearing down.

export interface VoiceSessionControl {
  readonly isIdle: boolean;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  /** Resolves when the submitted run ends (or a steering message is accepted). */
  sendUserMessage(text: string, options?: { deliverAs?: 'steer' | 'followUp' }): Promise<void>;
}

/** Wait for a session operation without retaining voice work after cancellation. */
export function waitUnlessCancelled(operation: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    // The session operation still owns its cleanup; observe any later rejection.
    void operation.catch(() => {});
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      resolve(false);
    };
    signal.addEventListener('abort', cancel, { once: true });
    operation.then(
      () => {
        signal.removeEventListener('abort', cancel);
        resolve(!signal.aborted);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      },
    );
  });
}

/**
 * Abort a busy session and wait for authoritative session settlement. There is
 * no teardown deadline: a slow tool must not cause a spoken request to vanish.
 * Only the owner ending/cancelling the call may discard its pending utterance.
 */
export async function ensureIdleWithImplicitAbort(session: VoiceSessionControl, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (!session.isIdle && !(await waitUnlessCancelled(session.abort(), signal))) return false;
  return waitUnlessCancelled(session.waitForIdle(), signal);
}
