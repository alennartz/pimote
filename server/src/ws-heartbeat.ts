import type { WebSocket } from 'ws';

/** Minimal WebSocketServer surface the heartbeat needs. */
export interface HeartbeatServer {
  clients: Iterable<WebSocket>;
}

export interface WebSocketHeartbeat {
  /** Attach pong tracking to a newly connected socket. */
  track(ws: WebSocket): void;
  /** Stop the timer — server shutdown. */
  stop(): void;
}

/** How long one ping may wait for its pong before the socket is terminated. */
const PONG_TIMEOUT_MS = 5_000;

/**
 * WebSocket liveness heartbeat.
 *
 * Some reverse-proxy paths silently drop idle WebSocket connections, and a
 * socket whose peer vanished without a close frame would otherwise linger
 * indefinitely, holding session observers open and blocking idle reaping.
 * Each ping owns an independent five-second response window. Browsers answer
 * pings at the protocol level (no app code involved), so hidden or throttled
 * tabs still stay alive when the network path is healthy.
 */
export function startWebSocketHeartbeat(server: HeartbeatServer, intervalMs: number): WebSocketHeartbeat {
  const pongTimeouts = new Map<WebSocket, ReturnType<typeof setTimeout>>();

  const clearPongTimeout = (ws: WebSocket): void => {
    const timeout = pongTimeouts.get(ws);
    if (timeout === undefined) return;
    clearTimeout(timeout);
    pongTimeouts.delete(ws);
  };

  const timer = setInterval(() => {
    for (const client of server.clients) {
      const pongTimeout = setTimeout(() => {
        if (pongTimeouts.get(client) !== pongTimeout) return;
        pongTimeouts.delete(client);
        client.terminate();
      }, PONG_TIMEOUT_MS);
      pongTimeout.unref?.();
      pongTimeouts.set(client, pongTimeout);
      client.ping();
    }
  }, intervalMs);
  // Never holds the process open by itself; absent under some timer mocks.
  timer.unref?.();
  return {
    track(ws) {
      ws.on('pong', () => clearPongTimeout(ws));
      ws.on('close', () => clearPongTimeout(ws));
    },
    stop() {
      clearInterval(timer);
      for (const timeout of pongTimeouts.values()) clearTimeout(timeout);
      pongTimeouts.clear();
    },
  };
}
