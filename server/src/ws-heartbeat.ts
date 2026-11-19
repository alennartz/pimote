import type { WebSocket } from 'ws';

/** Minimal WebSocketServer surface the heartbeat needs. */
export interface HeartbeatServer {
  clients: Iterable<WebSocket>;
}

export interface HeartbeatTimeoutDetails {
  consecutiveMisses: number;
  lastInboundType: 'pong' | 'message' | 'ping' | null;
  lastInboundAgeMs: number | null;
}

type HeartbeatTimeoutListener = (details: HeartbeatTimeoutDetails) => void;

export interface WebSocketHeartbeat {
  /** Attach liveness tracking and optional diagnostics to a new socket. */
  track(ws: WebSocket, onTimeout?: HeartbeatTimeoutListener): void;
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
interface ClientLiveness {
  missedPings: number;
  lastInboundType: HeartbeatTimeoutDetails['lastInboundType'];
  lastInboundAt: number | null;
  onTimeout?: HeartbeatTimeoutListener;
}

export function startWebSocketHeartbeat(server: HeartbeatServer, intervalMs: number): WebSocketHeartbeat {
  const pendingPongTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  const clientLiveness = new Map<WebSocket, ClientLiveness>();

  const clearPendingPongTimer = (ws: WebSocket): void => {
    const timer = pendingPongTimers.get(ws);
    if (timer === undefined) return;
    clearTimeout(timer);
    pendingPongTimers.delete(ws);
  };

  const forget = (ws: WebSocket): void => {
    clearPendingPongTimer(ws);
    clientLiveness.delete(ws);
  };

  const sawLife = (ws: WebSocket, type: NonNullable<HeartbeatTimeoutDetails['lastInboundType']>): void => {
    const liveness = clientLiveness.get(ws);
    if (liveness) {
      liveness.missedPings = 0;
      liveness.lastInboundType = type;
      liveness.lastInboundAt = Date.now();
    }
    clearPendingPongTimer(ws);
  };

  const timer = setInterval(() => {
    for (const client of server.clients) {
      const pongTimer = setTimeout(() => {
        if (pendingPongTimers.get(client) !== pongTimer) return;
        pendingPongTimers.delete(client);
        const liveness = clientLiveness.get(client);
        const missed = (liveness?.missedPings ?? 0) + 1;
        if (liveness) liveness.missedPings = missed;
        if (missed >= MAX_MISSED_PINGS) {
          const details: HeartbeatTimeoutDetails = {
            consecutiveMisses: missed,
            lastInboundType: liveness?.lastInboundType ?? null,
            lastInboundAgeMs: liveness?.lastInboundAt == null ? null : Math.max(0, Date.now() - liveness.lastInboundAt),
          };
          try {
            liveness?.onTimeout?.(details);
          } finally {
            client.terminate();
          }
        }
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
    track(ws, onTimeout) {
      clientLiveness.set(ws, {
        missedPings: 0,
        lastInboundType: null,
        lastInboundAt: null,
        onTimeout,
      });
      ws.on('pong', () => sawLife(ws, 'pong'));
      ws.on('message', () => sawLife(ws, 'message'));
      ws.on('ping', () => sawLife(ws, 'ping'));
      ws.on('close', () => forget(ws));
    },
    stop() {
      clearInterval(timer);
      for (const timer of pendingPongTimers.values()) clearTimeout(timer);
      pendingPongTimers.clear();
      clientLiveness.clear();
    },
  };
}
