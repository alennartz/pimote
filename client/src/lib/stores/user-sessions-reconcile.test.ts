import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { reconcileUserSessions, ConnectionStore } from './connection.svelte.js';

// --- Fixtures ----------------------------------------------------------------

const local = {
  held: { sessionId: 'held', folderPath: '/repos/held' },
  stale: { sessionId: 'stale', folderPath: '/repos/stale' },
};
const server = {
  held: { sessionId: 'held', folderPath: '/repos/held' },
  fresh: { sessionId: 'fresh', folderPath: '/repos/fresh' },
};

describe('reconcileUserSessions', () => {
  it('a fresh profile adopts the whole local seed and drops nothing', () => {
    const plan = reconcileUserSessions([local.held, local.stale], [], true);

    expect(plan.toOpen).toEqual([local.held, local.stale]);
    expect(plan.toDrop).toEqual([]);
  });

  it('a stale local seed against an existing profile drops local-only entries without opening them', () => {
    const plan = reconcileUserSessions([local.stale], [server.held], false);

    expect(plan.toOpen).toEqual([server.held]);
    expect(plan.toDrop).toEqual(['stale']);
  });

  it('server-only entries are opened against an existing profile', () => {
    const plan = reconcileUserSessions([local.held], [server.held, server.fresh], false);

    expect(plan.toOpen).toEqual([server.fresh]);
    expect(plan.toDrop).toEqual([]);
  });

  it('mixed overlap partitions exactly under a fresh profile', () => {
    const current = [local.held, local.stale];
    const truth = [server.held, server.fresh];

    const plan = reconcileUserSessions(current, truth, true);

    // The union of both sets, each session exactly once.
    expect(plan.toOpen.map((s) => s.sessionId).sort()).toEqual(['fresh', 'held', 'stale']);
    expect(plan.toDrop).toEqual([]);
  });

  it('mixed overlap partitions exactly against an existing profile', () => {
    const current = [local.held, local.stale];
    const truth = [server.held, server.fresh];

    const plan = reconcileUserSessions(current, truth, false);

    expect(plan.toOpen).toEqual([server.fresh]);
    expect(plan.toDrop).toEqual(['stale']);
  });
});

// --- One-time local mirror clear ---------------------------------------------
// Node v25 ships a localStorage that is non-functional without
// --localstorage-file, so provide a Map-backed stub like persistence.test.ts.

function createMockStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
  };
}

// --- Fake WebSocket (same shape as connection.svelte.test.ts) ----------------

const instances: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSING;
  }
}

beforeEach(() => {
  instances.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost', href: 'http://localhost/' });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('localStorage', createMockStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('user_sessions_changed — one-time local mirror clear', () => {
  // Runs alone in this file: the module-level clear flag is one-shot per page.
  it('clears pimote:activeSessions on the first event and never touches it again', () => {
    localStorage.setItem('pimote:activeSessions', JSON.stringify([local.held]));

    const c = new ConnectionStore();
    c.connect();
    const ws = instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();

    ws.onmessage!({ data: JSON.stringify({ type: 'user_sessions_changed', sessions: [server.held], fresh: true }) });
    expect(localStorage.getItem('pimote:activeSessions')).toBeNull();

    // A value written after the clear survives the next event: no re-read,
    // no re-write.
    localStorage.setItem('pimote:activeSessions', 'kept');
    ws.onmessage!({ data: JSON.stringify({ type: 'user_sessions_changed', sessions: [], fresh: false }) });
    expect(localStorage.getItem('pimote:activeSessions')).toBe('kept');

    c.disconnect();
  });
});
