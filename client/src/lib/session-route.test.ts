import { describe, expect, it } from 'vitest';
import { decideSessionRoute } from './session-route.js';

// The regression this pins: a session URL must not bounce straight back to the
// dashboard while the session can still be loaded. Navigation waits for the
// session to appear in the registry; only a failed load (or an id nothing can
// resolve) falls back to the first active session or home.
//
// Direction matters too: the registry leads when it switches views (it then
// navigates the URL one tick later), the URL leads on a real navigation (deep
// link, reload, back/forward). While the URL is still catching up to a
// registry-led switch it is stale — acting on it undoes the user's click
// mid-flight (the "New session" flicker-then-bounce regression).

describe('decideSessionRoute', () => {
  it('adopts immediately when the registry already knows the session', () => {
    const decision = decideSessionRoute({
      sessionId: 's-first',
      inRegistry: true,
      folderPath: '/repos/proj',
      loadAttempted: false,
      activeSessionIds: ['s-other'],
      urlChanged: true,
      viewNavigationPending: false,
    });

    expect(decision).toEqual({ action: 'adopt' });
  });

  it('triggers a load instead of bouncing home when the folder is known', () => {
    const decision = decideSessionRoute({
      sessionId: 's-first',
      inRegistry: false,
      folderPath: '/repos/proj',
      loadAttempted: false,
      activeSessionIds: ['s-other'],
      urlChanged: true,
      viewNavigationPending: false,
    });

    expect(decision).toEqual({ action: 'load', folderPath: '/repos/proj' });
  });

  it('triggers a load even when the folder is unknown — the server resolves it by id', () => {
    const decision = decideSessionRoute({
      sessionId: 's-deep',
      inRegistry: false,
      folderPath: undefined,
      loadAttempted: false,
      activeSessionIds: ['s-other'],
      urlChanged: true,
      viewNavigationPending: false,
    });

    expect(decision).toEqual({ action: 'load', folderPath: undefined });
  });

  it('never asks the server about an optimistic placeholder id — it falls straight back', () => {
    // pending-* ids are client-local fictions (the New chip); the server can
    // never resolve them, so no load is attempted.
    const decision = decideSessionRoute({
      sessionId: 'pending-uuid',
      inRegistry: false,
      folderPath: undefined,
      loadAttempted: false,
      activeSessionIds: ['s-first', 's-new'],
      urlChanged: true,
      viewNavigationPending: false,
    });

    expect(decision).toEqual({ action: 'fallback', sessionId: 's-first' });
  });

  it('falls back to the first active session after a failed load — no retry loop, no eager home', () => {
    const decision = decideSessionRoute({
      sessionId: 's-first',
      inRegistry: false,
      folderPath: '/repos/proj',
      loadAttempted: true,
      activeSessionIds: ['s-other'],
      urlChanged: true,
      viewNavigationPending: false,
    });

    expect(decision).toEqual({ action: 'fallback', sessionId: 's-other' });
  });

  it('falls back home when nothing can resolve the session id', () => {
    const decision = decideSessionRoute({
      sessionId: 's-first',
      inRegistry: false,
      folderPath: undefined,
      loadAttempted: true,
      activeSessionIds: ['s-other'],
      urlChanged: true,
      viewNavigationPending: false,
    });

    expect(decision).toEqual({ action: 'fallback', sessionId: 's-other' });
  });

  it('falls home when there is no session to fall back to', () => {
    const decision = decideSessionRoute({
      sessionId: 's-first',
      inRegistry: false,
      folderPath: '/repos/proj',
      loadAttempted: true,
      activeSessionIds: [],
      urlChanged: true,
      viewNavigationPending: false,
    });

    expect(decision).toEqual({ action: 'fallback', sessionId: null });
  });

  it('skips optimistic placeholder sessions when picking the fallback', () => {
    const decision = decideSessionRoute({
      sessionId: 's-first',
      inRegistry: false,
      folderPath: undefined,
      loadAttempted: true,
      activeSessionIds: ['pending-uuid', 's-real'],
      urlChanged: true,
      viewNavigationPending: false,
    });

    expect(decision).toEqual({ action: 'fallback', sessionId: 's-real' });
  });

  describe('registry-led navigation in flight (URL behind the view)', () => {
    it('waits instead of re-adopting the stale URL session', () => {
      // Session switch: viewed is already the target, the URL still shows the
      // previous session. Adopting the URL here flickers the old view back.
      const decision = decideSessionRoute({
        sessionId: 's-first',
        inRegistry: true,
        folderPath: '/repos/proj',
        loadAttempted: false,
        activeSessionIds: ['s-first', 's-target'],
        urlChanged: false,
        viewNavigationPending: true,
      });

      expect(decision).toEqual({ action: 'wait' });
    });

    it('waits instead of falling back off a dead placeholder URL (the New chip rekey)', () => {
      // The optimistic pending-* id was already rekeyed to its real id and the
      // registry is navigating there; the URL still says /sessions/pending-….
      // Falling back here bounces the user to the first session.
      const decision = decideSessionRoute({
        sessionId: 'pending-uuid',
        inRegistry: false,
        folderPath: undefined,
        loadAttempted: false,
        activeSessionIds: ['s-first', 's-new'],
        urlChanged: false,
        viewNavigationPending: true,
      });

      expect(decision).toEqual({ action: 'wait' });
    });

    it('a real navigation outranks a stale in-flight marker', () => {
      const decision = decideSessionRoute({
        sessionId: 's-first',
        inRegistry: false,
        folderPath: undefined,
        loadAttempted: true,
        activeSessionIds: ['s-first'],
        urlChanged: true,
        viewNavigationPending: true,
      });

      expect(decision).toEqual({ action: 'fallback', sessionId: 's-first' });
    });

    it('adopts the URL once the registry stops leading', () => {
      // "URL one step behind" without any registry navigation in flight: the
      // pending→real rekey landed before this effect ran. Adopt as usual.
      const decision = decideSessionRoute({
        sessionId: 's-new',
        inRegistry: true,
        folderPath: '/repos/proj',
        loadAttempted: false,
        activeSessionIds: ['s-new'],
        urlChanged: false,
        viewNavigationPending: false,
      });

      expect(decision).toEqual({ action: 'adopt' });
    });
  });
});
