import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { startWebSocketHeartbeat } from './ws-heartbeat.js';

/** Wire-level fake: records pings/terminations, delivers pongs and messages on demand. */
function createFakeSocket() {
  const listeners = new Map<string, () => void>();
  return {
    pings: 0,
    terminated: false,
    ping() {
      this.pings += 1;
    },
    terminate() {
      this.terminated = true;
    },
    on(event: string, handler: () => void) {
      listeners.set(event, handler);
    },
    pong() {
      listeners.get('pong')?.();
    },
    message() {
      listeners.get('message')?.();
    },
  };
}

function clientSet(...sockets: ReturnType<typeof createFakeSocket>[]) {
  return new Set(sockets) as unknown as Set<WebSocket>;
}

describe('startWebSocketHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pings every connected socket once per interval', () => {
    const a = createFakeSocket();
    const b = createFakeSocket();
    const heartbeat = startWebSocketHeartbeat({ clients: clientSet(a, b) }, 20_000);
    heartbeat.track(a);
    heartbeat.track(b);

    vi.advanceTimersByTime(20_000);
    expect(a.pings).toBe(1);
    expect(b.pings).toBe(1);

    // Both answer, so both stay alive and get pinged again.
    a.pong();
    b.pong();
    vi.advanceTimersByTime(20_000);
    expect(a.pings).toBe(2);
    expect(b.pings).toBe(2);
    expect(a.terminated).toBe(false);
    expect(b.terminated).toBe(false);

    heartbeat.stop();
  });

  it('keeps a socket that answers its ping', () => {
    const socket = createFakeSocket();
    const heartbeat = startWebSocketHeartbeat({ clients: clientSet(socket) }, 20_000);
    heartbeat.track(socket);

    vi.advanceTimersByTime(20_000);
    socket.pong();
    vi.advanceTimersByTime(20_000);

    expect(socket.terminated).toBe(false);
    expect(socket.pings).toBe(2);
    heartbeat.stop();
  });

  it('keeps a socket that misses one pong window', () => {
    const socket = createFakeSocket();
    const heartbeat = startWebSocketHeartbeat({ clients: clientSet(socket) }, 20_000);
    heartbeat.track(socket);

    vi.advanceTimersByTime(20_000); // ping sent, no pong
    vi.advanceTimersByTime(5_000); // first window missed
    expect(socket.terminated).toBe(false);

    // Next ping answered — strikes reset, socket lives on.
    vi.advanceTimersByTime(15_000);
    socket.pong();
    vi.advanceTimersByTime(5_000);

    expect(socket.terminated).toBe(false);
    heartbeat.stop();
  });

  it('terminates a socket after two consecutive unanswered pings', () => {
    const socket = createFakeSocket();
    const heartbeat = startWebSocketHeartbeat({ clients: clientSet(socket) }, 20_000);
    heartbeat.track(socket);

    vi.advanceTimersByTime(20_000); // ping 1
    vi.advanceTimersByTime(4_999);
    expect(socket.terminated).toBe(false);
    vi.advanceTimersByTime(1); // first window missed, no kill
    expect(socket.terminated).toBe(false);

    vi.advanceTimersByTime(20_000); // ping 2
    vi.advanceTimersByTime(5_000); // second consecutive window missed
    expect(socket.terminated).toBe(true);
    heartbeat.stop();
  });

  it('counts any inbound message as liveness and resets the strike count', () => {
    const socket = createFakeSocket();
    const heartbeat = startWebSocketHeartbeat({ clients: clientSet(socket) }, 20_000);
    heartbeat.track(socket);

    vi.advanceTimersByTime(20_000); // ping 1
    vi.advanceTimersByTime(5_000); // missed — one strike
    socket.message(); // client proved life: a resync request, any command

    vi.advanceTimersByTime(15_000); // ping 2
    vi.advanceTimersByTime(5_000); // missed — only one strike since the reset
    expect(socket.terminated).toBe(false);

    vi.advanceTimersByTime(20_000); // ping 3
    vi.advanceTimersByTime(5_000); // consecutive miss with no inbound since
    expect(socket.terminated).toBe(true);
    heartbeat.stop();
  });

  it('keeps a message-only client that never pongs', () => {
    const socket = createFakeSocket();
    const heartbeat = startWebSocketHeartbeat({ clients: clientSet(socket) }, 20_000);
    heartbeat.track(socket);

    // A proxy on the path may answer pings itself, or swallow them; inbound
    // application data is the honest liveness evidence.
    vi.advanceTimersByTime(20_000);
    vi.advanceTimersByTime(5_000); // missed
    socket.message();
    vi.advanceTimersByTime(20_000);
    vi.advanceTimersByTime(5_000); // missed
    socket.message();
    vi.advanceTimersByTime(20_000);

    expect(socket.terminated).toBe(false);
    expect(socket.pings).toBe(3);
    heartbeat.stop();
  });

  it('stops ticking and clears pending pong timeouts after stop()', () => {
    const socket = createFakeSocket();
    const heartbeat = startWebSocketHeartbeat({ clients: clientSet(socket) }, 20_000);
    heartbeat.track(socket);

    vi.advanceTimersByTime(20_000);
    heartbeat.stop();
    vi.advanceTimersByTime(60_000);

    expect(socket.pings).toBe(1);
    expect(socket.terminated).toBe(false);
  });
});
