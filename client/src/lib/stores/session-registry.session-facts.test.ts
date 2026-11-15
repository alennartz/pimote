import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PimoteResponse } from '@pimote/shared';
import { SessionRegistry } from './session-registry.svelte.js';
import { connection } from './connection.svelte.js';

function accepted(orderVersion: number): PimoteResponse {
  return { id: 'reorder', success: true, data: { accepted: true, orderVersion } };
}

describe('SessionRegistry user session facts', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
    registry.addSession('a', '/w/alpha', 'alpha');
    registry.addSession('b', '/w/beta', 'beta');
    registry.addSession('c', '/w/gamma', 'gamma');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ids = (target: SessionRegistry) => target.activeSessions.map((session) => session.sessionId);

  describe('order projection', () => {
    it('lists the chips in the server order', () => {
      registry.applyUserSessionFacts({ order: ['c', 'a', 'b'], selectedSessionId: null, orderVersion: 3 });

      expect(ids(registry)).toEqual(['c', 'a', 'b']);
    });

    it('drops ids it does not hold and appends sessions the order omits', () => {
      registry.addSession('fresh', '/w/fresh', 'fresh');

      registry.applyUserSessionFacts({ order: ['closed-elsewhere', 'c', 'b', 'a'], selectedSessionId: null, orderVersion: 1 });

      expect(ids(registry)).toEqual(['c', 'b', 'a', 'fresh']);
    });

    it('falls back to registration order when the order is empty', () => {
      registry.applyUserSessionFacts({ order: [], selectedSessionId: null, orderVersion: 0 });

      expect(ids(registry)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('whole-order write', () => {
    it('moves the chip and pushes the full ordered id list with the last seen epoch', () => {
      const send = vi.spyOn(connection, 'send').mockResolvedValue(accepted(4));
      registry.applyUserSessionFacts({ order: ['a', 'b', 'c'], selectedSessionId: null, orderVersion: 3 });

      registry.reorderSessions(0, 2);

      expect(ids(registry)).toEqual(['b', 'c', 'a']);
      expect(send).toHaveBeenCalledWith({ type: 'reorder_sessions', order: ['b', 'c', 'a'], baseVersion: 3 });
    });

    it('sends nothing for a move that changes no slot', () => {
      const send = vi.spyOn(connection, 'send').mockResolvedValue(accepted(1));
      registry.applyUserSessionFacts({ order: ['a', 'b', 'c'], selectedSessionId: null, orderVersion: 1 });

      registry.reorderSessions(1, 1);

      expect(send).not.toHaveBeenCalled();
    });

    it('carries the epoch the accepted write returned into the next write', async () => {
      const send = vi.spyOn(connection, 'send').mockResolvedValue(accepted(5));
      registry.applyUserSessionFacts({ order: ['a', 'b', 'c'], selectedSessionId: null, orderVersion: 4 });

      registry.reorderSessions(0, 1);
      await Promise.resolve();
      registry.reorderSessions(1, 2);

      expect(send).toHaveBeenLastCalledWith({ type: 'reorder_sessions', order: ['b', 'c', 'a'], baseVersion: 5 });
    });

    it('keeps a flow gesture at one write for several passes', () => {
      const send = vi.spyOn(connection, 'send').mockResolvedValue(accepted(2));
      registry.applyUserSessionFacts({ order: ['a', 'b', 'c'], selectedSessionId: null, orderVersion: 1 });

      registry.moveSession(0, 1);
      registry.moveSession(1, 2);
      registry.pushSessionOrder();

      expect(ids(registry)).toEqual(['b', 'c', 'a']);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('lets the facts a refused write pushes back put the server order in charge', () => {
      vi.spyOn(connection, 'send').mockResolvedValue({ id: 'reorder', success: true, data: { accepted: false, orderVersion: 7 } });
      registry.applyUserSessionFacts({ order: ['a', 'b', 'c'], selectedSessionId: null, orderVersion: 7 });

      registry.reorderSessions(0, 2);
      registry.applyUserSessionFacts({ order: ['a', 'b', 'c'], selectedSessionId: null, orderVersion: 7 });

      expect(ids(registry)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('follow', () => {
    beforeEach(() => {
      registry.viewedSessionId = 'a';
    });

    it('moves the view to the selection another connection made', () => {
      registry.applyUserSessionFacts({ order: ['a', 'b', 'c'], selectedSessionId: 'b', orderVersion: 1 });

      expect(registry.viewedSessionId).toBe('b');
    });

    it('answers no follow with a view_session of its own', () => {
      const send = vi.spyOn(connection, 'send').mockResolvedValue(accepted(1));

      registry.applyUserSessionFacts({ order: ['a', 'b', 'c'], selectedSessionId: 'b', orderVersion: 1 });

      expect(send).not.toHaveBeenCalled();
    });

    it('stays when the view already matches the selection', () => {
      registry.applyUserSessionFacts({ order: ['a', 'b', 'c'], selectedSessionId: 'a', orderVersion: 1 });

      expect(registry.viewedSessionId).toBe('a');
    });

    it('stays when the selection is a session this connection cannot view', () => {
      registry.applyUserSessionFacts({ order: ['a', 'b', 'c'], selectedSessionId: 'elsewhere', orderVersion: 1 });

      expect(registry.viewedSessionId).toBe('a');
    });

    it('lands a reconnecting connection on the selection', () => {
      // The connect burst carries the facts once; the client applies them once.
      registry.viewedSessionId = null;

      registry.applyUserSessionFacts({ order: ['a', 'b', 'c'], selectedSessionId: 'c', orderVersion: 9 });

      expect(registry.viewedSessionId).toBe('c');
    });

    it('selecting records the selection and tells the server with the folder', () => {
      const send = vi.spyOn(connection, 'send').mockResolvedValue(accepted(1));

      registry.selectSession('b');

      expect(registry.selectedSessionId).toBe('b');
      expect(send).toHaveBeenCalledWith({ type: 'view_session', sessionId: 'b', folderPath: '/w/beta' });
    });
  });

  describe('attention', () => {
    it('raises none for the session the user selected on another connection', () => {
      registry.viewedSessionId = 'a';
      registry.applyUserSessionFacts({ order: ['a', 'b', 'c'], selectedSessionId: 'c', orderVersion: 1 });

      registry.handleEvent({ type: 'agent_settled', sessionId: 'c', cursor: 0 } as never);

      expect(registry.sessions['c'].needsAttention).toBe(false);
    });

    it('raises attention for a session the user is not looking at', () => {
      registry.viewedSessionId = 'a';
      registry.applyUserSessionFacts({ order: ['a', 'b', 'c'], selectedSessionId: 'c', orderVersion: 1 });

      registry.handleEvent({ type: 'agent_settled', sessionId: 'b', cursor: 0 } as never);

      expect(registry.sessions['b'].needsAttention).toBe(true);
    });
  });
});
