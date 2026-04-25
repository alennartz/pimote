import { describe, expect, it } from 'vitest';
import { waitForAgentIdle, type IdleProbe } from './wait-for-idle.js';

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
