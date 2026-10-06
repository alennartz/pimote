import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureIdleWithImplicitAbort, waitUnlessCancelled, type VoiceSessionControl } from './wait-for-idle.js';

function probe(initiallyIdle: boolean) {
  const state = { idle: initiallyIdle, resolveIdle: (): void => {} };
  const idle = new Promise<void>((resolve) => {
    state.resolveIdle = resolve;
  });
  const session: VoiceSessionControl = {
    get isIdle() {
      return state.idle;
    },
    abort: vi.fn(() => idle),
    waitForIdle: vi.fn(() => (state.idle ? Promise.resolve() : idle)),
    sendUserMessage: vi.fn(async () => {}),
  };
  return {
    session,
    settle: () => {
      state.idle = true;
      state.resolveIdle();
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('ensureIdleWithImplicitAbort', () => {
  it('waits through the session interface without aborting an already idle session', async () => {
    const { session } = probe(true);
    expect(await ensureIdleWithImplicitAbort(session, new AbortController().signal)).toBe(true);
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.waitForIdle).toHaveBeenCalledTimes(1);
  });

  it('retains pending work until abort settles, including slow teardown', async () => {
    vi.useFakeTimers();
    const { session, settle } = probe(false);
    const state = { completed: false };
    const pending = ensureIdleWithImplicitAbort(session, new AbortController().signal).then((result) => {
      state.completed = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(state.completed).toBe(false);
    expect(session.abort).toHaveBeenCalledTimes(1);
    settle();
    expect(await pending).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases cancelled voice work immediately even if abort has not settled', async () => {
    const { session } = probe(false);
    const controller = new AbortController();
    const pending = ensureIdleWithImplicitAbort(session, controller.signal);
    controller.abort();
    expect(await pending).toBe(false);
    expect(session.waitForIdle).not.toHaveBeenCalled();
  });

  it('does not start an operation for an already cancelled owner', async () => {
    const { session } = probe(false);
    const controller = new AbortController();
    controller.abort();
    expect(await ensureIdleWithImplicitAbort(session, controller.signal)).toBe(false);
    expect(session.abort).not.toHaveBeenCalled();
  });
});

describe('waitUnlessCancelled', () => {
  it('propagates an operation failure', async () => {
    const error = new Error('session failure');
    await expect(waitUnlessCancelled(Promise.reject(error), new AbortController().signal)).rejects.toBe(error);
  });

  it('observes a later rejection after cancellation', async () => {
    const state = { reject: (_error: unknown): void => {} };
    const operation = new Promise<void>((_resolve, reject) => {
      state.reject = reject;
    });
    const controller = new AbortController();
    const pending = waitUnlessCancelled(operation, controller.signal);
    controller.abort();
    expect(await pending).toBe(false);
    state.reject(new Error('late session failure'));
    await Promise.resolve();
  });
});
