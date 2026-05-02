import { describe, expect, it } from 'vitest';
import { ensureIdleWithImplicitAbort, waitForAgentIdle, type AbortableIdleProbe, type IdleProbe } from './wait-for-idle.js';

function makeProbe(initiallyIdle: boolean, becomeIdleAfterCalls?: number): IdleProbe & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    isIdle() {
      calls += 1;
      if (initiallyIdle) return true;
      if (becomeIdleAfterCalls !== undefined && calls > becomeIdleAfterCalls) return true;
      return false;
    },
  };
}

function makeAbortableProbe(initiallyIdle: boolean, becomeIdleAfterAbortCalls?: number): AbortableIdleProbe & { isIdleCalls: number; abortCalls: number } {
  let isIdleCalls = 0;
  let abortCalls = 0;
  let aborted = false;
  return {
    get isIdleCalls() {
      return isIdleCalls;
    },
    get abortCalls() {
      return abortCalls;
    },
    isIdle() {
      isIdleCalls += 1;
      if (initiallyIdle) return true;
      if (aborted && becomeIdleAfterAbortCalls !== undefined && isIdleCalls > becomeIdleAfterAbortCalls) {
        return true;
      }
      return false;
    },
    abort() {
      abortCalls += 1;
      aborted = true;
    },
  };
}

describe('waitForAgentIdle', () => {
  it('returns true immediately when already idle', async () => {
    const probe = makeProbe(true);
    const result = await waitForAgentIdle(probe);
    expect(result).toBe(true);
    expect(probe.calls).toBe(1);
  });

  it('polls until the agent becomes idle and then resolves true', async () => {
    // Become idle on the 4th poll (i.e. after 3 sleep-and-retry cycles).
    const probe = makeProbe(false, 3);
    const result = await waitForAgentIdle(probe, 2000);
    expect(result).toBe(true);
    expect(probe.calls).toBeGreaterThanOrEqual(4);
  });

  it('returns false when the agent never becomes idle within the timeout', async () => {
    const probe = makeProbe(false);
    const start = Date.now();
    const result = await waitForAgentIdle(probe, 60);
    const elapsed = Date.now() - start;
    expect(result).toBe(false);
    // Should have honored the timeout, not run forever, but also waited long
    // enough that we know it actually polled rather than returning instantly.
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(500);
    expect(probe.calls).toBeGreaterThan(1);
  });
});

describe('ensureIdleWithImplicitAbort', () => {
  it('does not abort when the agent is already idle', async () => {
    const probe = makeAbortableProbe(true);
    const result = await ensureIdleWithImplicitAbort(probe);
    expect(result).toBe(true);
    expect(probe.abortCalls).toBe(0);
    expect(probe.isIdleCalls).toBe(1);
  });

  it('aborts and waits when the agent is busy, then resolves true', async () => {
    // Agent is busy on entry, then becomes idle two polls after abort.
    const probe = makeAbortableProbe(false, 2);
    const result = await ensureIdleWithImplicitAbort(probe, 2000);
    expect(result).toBe(true);
    expect(probe.abortCalls).toBe(1);
  });

  it('returns false on timeout (and still issued exactly one abort)', async () => {
    const probe = makeAbortableProbe(false);
    const result = await ensureIdleWithImplicitAbort(probe, 60);
    expect(result).toBe(false);
    expect(probe.abortCalls).toBe(1);
  });
});
