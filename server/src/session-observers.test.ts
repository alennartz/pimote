import { describe, expect, it, vi } from 'vitest';
import { PimoteSessionManager, sendSlotEvent, type EventSocket, type ManagedSlot, type SessionObserver } from './session-manager.js';
import type { PimoteEvent } from '../../shared/dist/index.js';

function observer(clientId: string, cursor = 0): SessionObserver & { sent: string[] } {
  const sent: string[] = [];
  const ws: EventSocket = {
    readyState: 1,
    send: vi.fn((data: string) => sent.push(data)),
  };
  return { clientId, ws, cursor, sent, onSessionReset: null };
}

function slotWith(...observers: SessionObserver[]): ManagedSlot {
  return { observers: new Map(observers.map((entry) => [entry.clientId, entry])) } as unknown as ManagedSlot;
}

vi.mock('./git-branch.js', () => ({ getGitBranch: async () => null }));
vi.mock('@earendil-works/pi-coding-agent', () => {
  const session = {
    sessionId: 'session-1',
    messages: [],
    isStreaming: false,
    subscribe: () => () => {},
    bindExtensions: vi.fn(async () => {}),
    setSteeringMode: vi.fn(),
    setFollowUpMode: vi.fn(),
    sessionManager: { getCwd: () => '/project' },
  };
  const eventBus = { on: () => () => {}, emit: vi.fn(), clear: vi.fn() };
  return {
    ModelRuntime: { create: async () => ({ getAvailable: async () => [] }) },
    getAgentDir: () => '/agent',
    SessionManager: { create: () => ({ getCwd: () => '/project' }) },
    createEventBus: () => eventBus,
    createCodemodeExtension: () => () => {},
    createToolSearchExtension: () => () => {},
    createMcpExtension: () => () => {},
    createAgentSessionServices: async () => ({ eventBus }),
    createAgentSessionFromServices: async () => ({ session }),
    createAgentSessionRuntime: async (factory: any, options: any) => {
      await factory({ cwd: options.cwd, agentDir: '/agent', sessionManager: options.sessionManager, sessionStartEvent: undefined });
      return { session, dispose: vi.fn(async () => {}), setRebindSession: vi.fn() };
    },
  };
});

async function managedSession() {
  const manager = await PimoteSessionManager.create({ bufferSize: 100 } as any, { notify: async () => {} } as any);
  const id = await manager.openSession('/project');
  return { manager, slot: manager.getSlot(id)! };
}

const event: PimoteEvent = {
  type: 'agent_start',
  sessionId: 'session-1',
  cursor: 4,
  timestamp: '2026-04-01T00:00:00.000Z',
};

describe('session observer fan-out', () => {
  it('delivers a buffered event to every open observer and advances each cursor', () => {
    const first = observer('client-a', 3);
    const second = observer('client-b', 1);
    const slot = slotWith(first, second);

    sendSlotEvent(slot, event);

    expect(first.sent).toEqual([JSON.stringify(event)]);
    expect(second.sent).toEqual([JSON.stringify(event)]);
    expect(first.cursor).toBe(4);
    expect(second.cursor).toBe(4);
  });

  it('leaves observer cursors unchanged for an ephemeral event without a cursor', () => {
    const first = observer('client-a', 3);
    const second = observer('client-b', 1);
    const slot = slotWith(first, second);
    const ephemeral: PimoteEvent = {
      type: 'call_status',
      sessionId: 'session-1',
      status: 'connected',
    };

    sendSlotEvent(slot, ephemeral);

    expect(first.sent).toEqual([JSON.stringify(ephemeral)]);
    expect(second.sent).toEqual([JSON.stringify(ephemeral)]);
    expect(first.cursor).toBe(3);
    expect(second.cursor).toBe(1);
  });

  it('skips observers whose socket is not open while retaining other observers', () => {
    const open = observer('client-open');
    const closed = observer('client-closed');
    closed.ws = { ...closed.ws, readyState: 3 };
    const slot = slotWith(open, closed);

    sendSlotEvent(slot, event);

    expect(open.sent).toHaveLength(1);
    expect(closed.sent).toHaveLength(0);
    expect(slot.observers.size).toBe(2);
  });
});

describe('session observer lifecycle', () => {
  it('protects a stale session while any observer remains, then reaps after final detach', async () => {
    vi.useFakeTimers();
    const { manager, slot } = await managedSession();
    try {
      slot.sessionState.idleSince = Date.now() - 400_000;
      await manager.attachObserver('session-1', observer('a'));
      await manager.attachObserver('session-1', observer('b'));
      manager.startIdleCheck(300_000);
      manager.detachObserver('session-1', 'a');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(manager.getSlot('session-1')).toBe(slot);
      manager.detachObserver('session-1', 'b');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(manager.getSlot('session-1')).toBeNull();
      expect(slot.runtime.dispose).toHaveBeenCalled();
    } finally {
      manager.stopIdleCheck();
      vi.useRealTimers();
    }
  });

  it('replaces an observer when a second socket presents the same client id', async () => {
    const existing = observer('client-a', 7);
    const { manager, slot } = await managedSession();
    await manager.attachObserver('session-1', existing);
    const replacement = observer('client-a');

    await manager.attachObserver('session-1', replacement);

    expect(slot.observers.get('client-a')).toBe(replacement);
    expect(slot.observers.size).toBe(1);
  });

  it('detaches only the requested client and leaves other observers attached', async () => {
    const first = observer('client-a');
    const second = observer('client-b');
    const { manager, slot } = await managedSession();
    await manager.attachObserver('session-1', first);
    await manager.attachObserver('session-1', second);

    manager.detachObserver('session-1', 'client-a');

    expect(slot.observers.has('client-a')).toBe(false);
    expect(slot.observers.get('client-b')).toBe(second);
  });

  it('does not detach a replacement observer when an old socket asks to detach', async () => {
    const first = observer('client-a');
    const replacement = observer('client-a');
    const { manager, slot } = await managedSession();
    await manager.attachObserver('session-1', first);
    await manager.attachObserver('session-1', replacement);

    manager.detachObserver('session-1', 'client-a', first.ws);

    expect(slot.observers.get('client-a')).toBe(replacement);
  });
});
