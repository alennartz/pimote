import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionStore, isSessionNotFoundError } from './connection.svelte.js';

// --- Fake WebSocket ---------------------------------------------------------
// connect() does `new WebSocket(...)` against the global and reads the
// CONNECTING/OPEN/CLOSING statics, so we stub the global with a controllable
// fake the test drives by hand (fire onopen/onclose, flip readyState).

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

/** Flush microtasks (and any setTimeout(0)) so promise chains settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  instances.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost', href: 'http://localhost/' });
  vi.stubGlobal('navigator', {});
  // window/document intentionally left unstubbed → installLifecycleListeners() bails.
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConnectionStore — definitive restore rejections', () => {
  /** Deliver the response to the first open_session the socket received. */
  const respondTo = (ws: FakeWebSocket, error: string) => {
    const openMsg = ws.sent.map((raw) => JSON.parse(raw) as { id: string; type: string }).find((m) => m.type === 'open_session')!;
    ws.onmessage!({ data: JSON.stringify({ id: openMsg.id, success: false, error }) });
  };

  it('session_not_found drops the subscription, notifies, and labels the sync', async () => {
    const c = new ConnectionStore();
    const onSessionNotFound = vi.fn(function captureDetail(this: void, _sid: string) {
      // Capture the label as the rejection lands, before the sync completes
      // and clears it.
      detailAtCallback = c.syncDetail;
    });
    let detailAtCallback: string | null | undefined;
    const onSessionOwned = vi.fn();
    c.onSessionNotFound = onSessionNotFound;
    c.onSessionOwned = onSessionOwned;
    c.addSubscribedSession('s-ghost', '/proj');

    c.connect();
    const ws = instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    await flush();

    respondTo(ws, 'session_not_found');
    await flush();

    expect(onSessionNotFound).toHaveBeenCalledWith('s-ghost');
    expect(onSessionOwned).not.toHaveBeenCalled();
    expect(detailAtCallback).toBe('Session not found');
    expect(c.subscribedSessions.has('s-ghost')).toBe(false);
    // The dropped session must not block the connection from becoming ready.
    expect(c.phase).toBe('ready');
    expect(c.ready).toBe(true);

    c.disconnect();
  });

  it('other restore failures keep the session for the next reconnect cycle', async () => {
    const c = new ConnectionStore();
    const onSessionNotFound = vi.fn();
    c.onSessionNotFound = onSessionNotFound;
    c.addSubscribedSession('s-flaky', '/proj');

    c.connect();
    const ws = instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    await flush();

    respondTo(ws, 'internal_error');
    await flush();

    expect(onSessionNotFound).not.toHaveBeenCalled();
    expect(c.subscribedSessions.has('s-flaky')).toBe(true);

    c.disconnect();
  });

  it('isSessionNotFoundError accepts both the current and legacy error strings', () => {
    expect(isSessionNotFoundError('session_not_found')).toBe(true);
    expect(isSessionNotFoundError('session_expired')).toBe(true);
    expect(isSessionNotFoundError('session_owned')).toBe(false);
    expect(isSessionNotFoundError(undefined)).toBe(false);
  });
});

describe('ConnectionStore — socket identity guards', () => {
  it('symptom 1: a drop mid-restore does not mark the dead connection ready', async () => {
    const c = new ConnectionStore();
    const onReconnected = vi.fn();
    c.onReconnected = onReconnected;
    c.addSubscribedSession('s1', '/proj');

    c.connect();
    const ws = instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!(); // fires restore (open_session) + schedules the Promise.all continuation

    // Socket drops while the restore is still in flight.
    ws.readyState = FakeWebSocket.CLOSED;
    ws.onclose!(); // rejects pending → restore promise settles → backoff

    await flush(); // let the (now-stale) Promise.all continuation run

    expect(c.ready).toBe(false);
    expect(c.phase).toBe('backoff');
    expect(onReconnected).not.toHaveBeenCalled();

    c.disconnect(); // clear backoff timer/interval
  });

  it('symptom 2: a stale socket close does not clobber its replacement', async () => {
    const c = new ConnectionStore();

    c.connect();
    const ws1 = instances.at(-1)!;
    ws1.readyState = FakeWebSocket.OPEN;
    ws1.onopen!();
    const staleOnClose = ws1.onclose!; // capture before it's detached

    // Socket goes into CLOSING, then a reconnect builds a replacement.
    ws1.readyState = FakeWebSocket.CLOSING;
    c.connect();
    const ws2 = instances.at(-1)!;
    expect(ws2).not.toBe(ws1);
    ws2.readyState = FakeWebSocket.OPEN;
    ws2.onopen!();

    // The old socket's queued close event finally fires. It must NOT null the
    // live socket or reject the new connection's requests.
    staleOnClose();

    // Proof the live socket wasn't clobbered: a send is accepted (would reject
    // synchronously with "WebSocket not connected" if this.ws had been nulled).
    let rejected = false;
    c.send({ type: 'list_folders' } as never).catch(() => {
      rejected = true;
    });
    await flush();
    expect(rejected).toBe(false);
    expect(ws2.sent.length).toBe(1);

    c.disconnect();
  });
});
