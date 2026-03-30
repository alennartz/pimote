// ConnectionStore — Svelte 5 runes-based WebSocket connection manager
import type {
  PimoteCommand,
  PimoteResponse,
  PimoteEvent,
  PimoteServerMessage,
} from '@pimote/shared';

type EventListener = (event: PimoteEvent) => void;

let nextId = 1;
const clientId = crypto.randomUUID();

class ConnectionStore {
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = $state('disconnected');
  private sessionCursors: Map<string, number> = new Map();
  subscribedSessions: Set<string> = $state(new Set());

  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (r: PimoteResponse) => void; reject: (e: Error) => void }>();
  private listeners = new Set<EventListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private intentionalClose = false;

  /** Called after all session reconnects complete. Set by session-registry to restore viewed session. */
  onReconnected: (() => void) | null = null;

  /** Called when a reconnect is rejected with session_owned (another client owns it). */
  onSessionOwned: ((sessionId: string) => void) | null = null;

  /** Called when a session is adopted via notification click (includes folderPath from server). */
  onSessionAdopted: ((sessionId: string, folderPath: string) => void) | null = null;

  /** Session to adopt after next successful connection (set from notification URL param or click). */
  pendingAdopt: { sessionId: string; folderPath: string } | null = null;

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.status = this.status === 'disconnected' ? 'connecting' : 'reconnecting';
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/ws?clientId=${clientId}`);

    this.ws.onopen = () => {
      this.status = 'connected';
      this.reconnectDelay = 1000;

      // Reconnect all subscribed sessions with per-session cursors
      const reconnectPromises: Promise<void>[] = [];
      for (const sessionId of this.subscribedSessions) {
        const p = this.send({
          type: 'reconnect',
          sessionId,
          lastCursor: this.sessionCursors.get(sessionId) ?? 0,
        }).then((response) => {
          if (!response.success) {
            if (response.error === 'session_owned') {
              // Another client owns this session — let the registry prompt the user
              this.onSessionOwned?.(sessionId);
            } else {
              // Session expired (server restarted, idle-reaped, etc.) — fire
              // a synthetic session_closed so the registry cleans up the tab
              const closedEvent = { type: 'session_closed', sessionId } as PimoteEvent;
              for (const listener of this.listeners) {
                try { listener(closedEvent); } catch (e) { console.error('[ConnectionStore] listener error:', e); }
              }
            }
          }
        }).catch(() => {
          // WebSocket dropped before response — will retry on next reconnect
        });
        reconnectPromises.push(p);
      }

      // After all reconnects, restore correct viewed session on the server.
      // Import is circular so we use the onReconnected callback instead.
      Promise.all(reconnectPromises).then(() => {
        this.onReconnected?.();

        // Adopt session from notification click if pending
        if (this.pendingAdopt) {
          const { sessionId: sid, folderPath } = this.pendingAdopt;
          this.pendingAdopt = null;
          this.send({
            type: 'open_session',
            folderPath,
            sessionId: sid,
            force: true,
          }).then((response) => {
            if (response.success) {
              this.onSessionAdopted?.(sid, folderPath);
            }
          }).catch(() => {});
        }
      });

      // Re-register push subscription on every connect
      this.reregisterPushSubscription();
    };

    this.ws.onmessage = (ev) => {
      let msg: PimoteServerMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }

      // Response (has `id` and `success` fields)
      if ('id' in msg && 'success' in msg) {
        const response = msg as PimoteResponse;
        const pending = this.pending.get(response.id);
        if (pending) {
          this.pending.delete(response.id);
          pending.resolve(response);
        }
        return;
      }

      // Event
      const event = msg as PimoteEvent;

      // Track per-session cursor
      if ('cursor' in event && typeof event.cursor === 'number' && 'sessionId' in event && typeof event.sessionId === 'string') {
        this.sessionCursors.set(event.sessionId, event.cursor);
      }

      // Notify listeners
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (e) {
          console.error('[ConnectionStore] Event listener error:', e);
        }
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      // Reject all pending requests
      for (const [, pending] of this.pending) {
        pending.reject(new Error('WebSocket closed'));
      }
      this.pending.clear();

      if (!this.intentionalClose) {
        this.status = 'reconnecting';
        this.scheduleReconnect();
      } else {
        this.status = 'disconnected';
        this.intentionalClose = false;
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }

  addSubscribedSession(id: string): void {
    this.subscribedSessions = new Set([...this.subscribedSessions, id]);
  }

  removeSubscribedSession(id: string): void {
    const next = new Set(this.subscribedSessions);
    next.delete(id);
    this.subscribedSessions = next;
    this.sessionCursors.delete(id);
  }

  send(command: PimoteCommand): Promise<PimoteResponse> {
    const id = command.id ?? `cmd-${nextId++}`;
    const withId = { ...command, id };

    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(withId));
    });
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async reregisterPushSubscription(): Promise<void> {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
      if (Notification.permission !== 'granted') return;
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();
      if (!subscription) return;
      const sub = subscription.toJSON();
      if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return;
      await this.send({
        type: 'register_push',
        subscription: {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys.p256dh,
            auth: sub.keys.auth,
          },
        },
      });
    } catch {
      // Best-effort — don't break connection flow
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
  }
}

export const connection = new ConnectionStore();
