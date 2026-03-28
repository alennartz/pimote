// ConnectionStore — Svelte 5 runes-based WebSocket connection manager
import type {
  PimoteCommand,
  PimoteResponse,
  PimoteEvent,
  PimoteServerMessage,
} from '@pimote/shared';

type EventListener = (event: PimoteEvent) => void;

let nextId = 1;

class ConnectionStore {
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = $state('disconnected');
  lastCursor: number = $state(0);
  subscribedSessions: Set<string> = $state(new Set());

  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (r: PimoteResponse) => void; reject: (e: Error) => void }>();
  private listeners = new Set<EventListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private intentionalClose = false;

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.status = this.status === 'disconnected' ? 'connecting' : 'reconnecting';
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/ws`);

    this.ws.onopen = () => {
      this.status = 'connected';
      this.reconnectDelay = 1000;

      // Reconnect all subscribed sessions
      for (const sessionId of this.subscribedSessions) {
        this.send({
          type: 'reconnect',
          sessionId,
          lastCursor: this.lastCursor,
        });
      }
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

      // Track cursor
      if ('cursor' in event && typeof event.cursor === 'number') {
        this.lastCursor = event.cursor;
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
