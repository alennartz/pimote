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

/**
 * WebSocket liveness heartbeat.
 *
 * Some reverse-proxy paths silently drop idle WebSocket connections, and a
 * socket whose peer vanished without a close frame would otherwise linger
 * indefinitely, holding session observers open and blocking idle reaping.
 * Each interval every socket must prove reachability with one pong; a socket
 * that misses the window is terminated. Browsers answer pings at the protocol
 * level (no app code involved), so hidden or throttled tabs still stay alive.
 */
export function startWebSocketHeartbeat(server: HeartbeatServer, intervalMs: number): WebSocketHeartbeat {
  const awaitingPong = new WeakSet<WebSocket>();
  const timer = setInterval(() => {
    for (const client of server.clients) {
      if (awaitingPong.has(client)) {
        client.terminate();
        continue;
      }
      awaitingPong.add(client);
      client.ping();
    }
  }, intervalMs);
  // Never holds the process open by itself; absent under some timer mocks.
  timer.unref?.();
  return {
    track(ws) {
      ws.on('pong', () => awaitingPong.delete(ws));
    },
    stop() {
      clearInterval(timer);
    },
  };
}
