import type { WebSocket } from 'ws';

/** Minimal WebSocketServer surface the heartbeat needs. */
export interface HeartbeatServer {
  clients: Iterable<WebSocket>;
}

export interface WebSocketHeartbeat {
  /** Attach liveness tracking to a newly connected socket. */
  track(ws: WebSocket): void;
  /** Stop the timer — server shutdown. */
  stop(): void;
}

/** How long one ping may wait for its pong before it counts as missed. */
const PONG_TIMEOUT_MS = 5_000;

/** Consecutive missed windows before the socket is considered dead. */
const MAX_MISSED_PINGS = 2;

/**
 * WebSocket liveness heartbeat.
 *
 * Some reverse-proxy paths silently drop idle WebSocket connections, and a
 * socket whose peer vanished without a close frame would otherwise linger
 * indefinitely, holding session observers open and blocking idle reaping.
 * Each ping owns an independent five-second response window. Browsers answer
 * pings at the protocol level (no app code involved), so hidden or throttled
 * tabs still stay alive when the network path is healthy.
 *
 * A single missed window never kills. Mobile links routinely stall for
 * seconds while remaining perfectly usable, so one unanswered ping costs a
 * strike, and only two consecutive unanswered windows — with no inbound
 * frame of any kind between them — terminate the socket. Any inbound frame
 * (pong, message, ping) proves the peer is alive and clears the strikes:
 * during a resync or a streaming burst, application data is the honest
 * liveness evidence, and on paths where a proxy answers pings itself, it is
 * the only one.
 */
export function startWebSocketHeartbeat(server: HeartbeatServer, intervalMs: number): WebSocketHeartbeat {
  const pendingPongTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  const missedPings = new Map<WebSocket, number>();

  const clearPendingPongTimer = (ws: WebSocket): void => {
    const timer = pendingPongTimers.get(ws);
    if (timer === undefined) return;
    clearTimeout(timer);
    pendingPongTimers.delete(ws);
  };

  const forget = (ws: WebSocket): void => {
    clearPendingPongTimer(ws);
    missedPings.delete(ws);
  };

  const sawLife = (ws: WebSocket): void => {
    missedPings.set(ws, 0);
    clearPendingPongTimer(ws);
  };

  const timer = setInterval(() => {
    for (const client of server.clients) {
      const pongTimer = setTimeout(() => {
        if (pendingPongTimers.get(client) !== pongTimer) return;
        pendingPongTimers.delete(client);
        const missed = (missedPings.get(client) ?? 0) + 1;
        missedPings.set(client, missed);
        if (missed >= MAX_MISSED_PINGS) client.terminate();
      }, PONG_TIMEOUT_MS);
      pongTimer.unref?.();
      clearPendingPongTimer(client);
      pendingPongTimers.set(client, pongTimer);
      client.ping();
    }
  }, intervalMs);
  // Never holds the process open by itself; absent under some timer mocks.
  timer.unref?.();
  return {
    track(ws) {
      missedPings.set(ws, 0);
      ws.on('pong', () => sawLife(ws));
      ws.on('message', () => sawLife(ws));
      ws.on('ping', () => sawLife(ws));
      ws.on('close', () => forget(ws));
    },
    stop() {
      clearInterval(timer);
      for (const timer of pendingPongTimers.values()) clearTimeout(timer);
      pendingPongTimers.clear();
      missedPings.clear();
    },
  };
}
