import { describe, expect, it } from 'vitest';
import { decideSessionRoute } from './session-route.js';

// The regression this pins: a session URL must not bounce straight back to the
// dashboard while the session can still be loaded. Navigation waits for the
// session to appear in the registry; only a failed load (or an id nothing can
// resolve) falls back to the first active session or home.

describe('decideSessionRoute', () => {
  it('adopts immediately when the registry already knows the session', () => {
    const decision = decideSessionRoute({
      inRegistry: true,
      folderPath: '/repos/proj',
      loadAttempted: false,
      activeSessionIds: ['s-other'],
    });

    expect(decision).toEqual({ action: 'adopt' });
  });

  it('triggers a load instead of bouncing home when the folder is known', () => {
    const decision = decideSessionRoute({
      inRegistry: false,
      folderPath: '/repos/proj',
      loadAttempted: false,
      activeSessionIds: ['s-other'],
    });

    expect(decision).toEqual({ action: 'load', folderPath: '/repos/proj' });
  });

  it('falls back to the first active session after a failed load — no retry loop, no eager home', () => {
    const decision = decideSessionRoute({
      inRegistry: false,
      folderPath: '/repos/proj',
      loadAttempted: true,
      activeSessionIds: ['s-other'],
    });

    expect(decision).toEqual({ action: 'fallback', sessionId: 's-other' });
  });

  it('falls back home when nothing can resolve the session id', () => {
    const decision = decideSessionRoute({
      inRegistry: false,
      folderPath: undefined,
      loadAttempted: false,
      activeSessionIds: ['s-other'],
    });

    expect(decision).toEqual({ action: 'fallback', sessionId: 's-other' });
  });

  it('falls home when there is no session to fall back to', () => {
    const decision = decideSessionRoute({
      inRegistry: false,
      folderPath: '/repos/proj',
      loadAttempted: true,
      activeSessionIds: [],
    });

    expect(decision).toEqual({ action: 'fallback', sessionId: null });
  });

  it('skips optimistic placeholder sessions when picking the fallback', () => {
    const decision = decideSessionRoute({
      inRegistry: false,
      folderPath: undefined,
      loadAttempted: false,
      activeSessionIds: ['pending-uuid', 's-real'],
    });

    expect(decision).toEqual({ action: 'fallback', sessionId: 's-real' });
  });
});
