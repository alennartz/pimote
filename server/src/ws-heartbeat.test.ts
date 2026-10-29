import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { startWebSocketHeartbeat } from './ws-heartbeat.js';

/** Wire-level fake: records pings/terminations, delivers pongs on demand. */
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

  it('terminates a socket five seconds after a ping misses its pong', () => {
    const socket = createFakeSocket();
    const heartbeat = startWebSocketHeartbeat({ clients: clientSet(socket) }, 20_000);
    heartbeat.track(socket);

    vi.advanceTimersByTime(20_000); // pinged
    vi.advanceTimersByTime(4_999);
    expect(socket.terminated).toBe(false);
    vi.advanceTimersByTime(1); // no pong arrived within the five-second window

    expect(socket.terminated).toBe(true);
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
