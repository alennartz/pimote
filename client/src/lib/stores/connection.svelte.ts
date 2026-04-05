// ConnectionStore — Svelte 5 runes-based WebSocket connection manager
import type { OpenSessionResponseData, PimoteCommand, PimoteResponse, PimoteEvent, PimoteServerMessage, RestoreMode } from '@pimote/shared';
import { SvelteMap } from 'svelte/reactivity';
import { version } from '$app/environment';
import { getClientId, setClientId } from './persistence.js';

type EventListener = (event: PimoteEvent) => void;

let nextId = 1;
const clientId =
  getClientId() ??
  (() => {
    const id = crypto.randomUUID();
    setClientId(id);
    return id;
  })();

class ConnectionStore {
  readonly clientId: string = clientId;
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = $state('disconnected');
  /** True only after WebSocket is open AND all session reconnects have completed. */
  ready: boolean = $state(false);
  /** Detailed reconnection phase for status display. */
  phase: 'idle' | 'backoff' | 'connecting' | 'syncing' | 'ready' = $state('idle');
  /** Seconds until next reconnect attempt (ticks down during backoff). */
  reconnectCountdown: number = $state(0);
  /** Progress of per-session restore/open commands during syncing phase. */
  syncProgress: { done: number; total: number } | null = $state(null);
  /** Human-readable restore detail for reconnect sync. */
  syncDetail: string | null = $state(null);
  private sessionCursors: Map<string, number> = new Map();
  subscribedSessions: Map<string, string> = $state(new SvelteMap());

  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (r: PimoteResponse) => void; reject: (e: Error) => void }>();
  private listeners = new Set<EventListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;
  private intentionalClose = false;

  /** Called after all session restore/open commands complete. Set by session-registry to restore viewed session. */
  onReconnected: (() => void) | null = null;

  /** Called when restoring/opening a session is rejected with session_owned (another client owns it). */
  onSessionOwned: ((sessionId: string) => void) | null = null;

  /** Called after connection restore when a notification-driven adopt should begin. */
  onPendingAdopt: ((sessionId: string, folderPath: string) => void) | null = null;

  /** Session to adopt after next successful connection (set from notification URL param or click). */
  pendingAdopt: { sessionId: string; folderPath: string } | null = null;

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.ready = false;
    this.clearCountdownInterval();
    this.phase = 'connecting';
    this.status = this.status === 'disconnected' ? 'connecting' : 'reconnecting';
    this.syncDetail = null;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/ws?clientId=${clientId}&version=${encodeURIComponent(version)}`);

    this.ws.onopen = () => {
      this.status = 'connected';
      this.reconnectDelay = 1000;

      // Restore all subscribed sessions. When we still have an in-page cursor,
      // ask the server for incremental replay; otherwise let it fall back to a
      // full resync (live in-memory or disk-backed).
      const sessionCount = this.subscribedSessions.size;
      if (sessionCount > 0) {
        this.phase = 'syncing';
        this.syncProgress = { done: 0, total: sessionCount };
        this.syncDetail = 'Restoring sessions';
      }

      const restorePromises: Promise<void>[] = [];
      for (const [sessionId, folderPath] of this.subscribedSessions) {
        const lastCursor = this.sessionCursors.get(sessionId);
        const p = this.send({
          type: 'open_session',
          folderPath,
          sessionId,
          ...(lastCursor !== undefined ? { lastCursor } : {}),
        })
          .then((response) => {
            if (!response.success) {
              if (response.error === 'session_owned') {
                this.onSessionOwned?.(sessionId);
              } else {
                // Don't fabricate session_closed — a failed restore is not a
                // server-initiated close.  The session stays in the registry
                // with its last-known state and will be retried on the next
                // reconnect cycle.
                console.warn(`[ConnectionStore] Failed to restore session ${sessionId}: ${response.error ?? 'unknown error'}`);
              }
              return;
            }

            const data = response.data as OpenSessionResponseData | undefined;
            if (this.phase === 'syncing') {
              this.syncDetail = this.labelForRestoreMode(data?.restoreMode, sessionCount);
            }
          })
          .catch(() => {
            // WebSocket dropped before response — will retry on next reconnect
          })
          .finally(() => {
            if (this.syncProgress) {
              this.syncProgress = { done: this.syncProgress.done + 1, total: this.syncProgress.total };
            }
          });
        restorePromises.push(p);
      }

      // After all restores, restore correct viewed session on the server.
      // Import is circular so we use the onReconnected callback instead.
      Promise.all(restorePromises).then(() => {
        this.ready = true;
        this.phase = 'ready';
        this.syncProgress = null;
        this.syncDetail = null;
        this.onReconnected?.();

        if (this.pendingAdopt) {
          const { sessionId: sid, folderPath } = this.pendingAdopt;
          this.pendingAdopt = null;
          this.onPendingAdopt?.(sid, folderPath);
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

      // Version mismatch — server is serving newer assets than what we're running.
      // Reload the page to pick up the new client code.
      if ('type' in msg && msg.type === 'version_mismatch') {
        console.log(`[ConnectionStore] Version mismatch — reloading (server=${(msg as { serverVersion: string }).serverVersion}, client=${version})`);
        location.reload();
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

      // Track per-session cursor.
      // For buffered_events envelopes (which have no cursor of their own),
      // advance to the highest cursor among the sub-events so that a
      // subsequent reconnect doesn't replay the same events again.
      if (event.type === 'buffered_events' && 'events' in event && 'sessionId' in event) {
        const buffered = event as { sessionId: string; events: Array<{ cursor?: number }> };
        let max = this.sessionCursors.get(buffered.sessionId) ?? 0;
        for (const sub of buffered.events) {
          if (typeof sub.cursor === 'number' && sub.cursor > max) {
            max = sub.cursor;
          }
        }
        this.sessionCursors.set(buffered.sessionId, max);
      } else if ('cursor' in event && typeof event.cursor === 'number' && 'sessionId' in event && typeof event.sessionId === 'string') {
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
      this.ready = false;
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
        this.phase = 'idle';
        this.syncDetail = null;
        this.intentionalClose = false;
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearCountdownInterval();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }

  addSubscribedSession(id: string, folderPath: string): void {
    this.subscribedSessions.set(id, folderPath);
  }

  removeSubscribedSession(id: string): void {
    this.subscribedSessions.delete(id);
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

  private clearCountdownInterval(): void {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.phase = 'backoff';
    this.syncDetail = null;
    this.reconnectCountdown = Math.ceil(this.reconnectDelay / 1000);
    this.clearCountdownInterval();
    this.countdownInterval = setInterval(() => {
      this.reconnectCountdown = Math.max(0, this.reconnectCountdown - 1);
    }, 1000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
  }

  get phaseLabel(): string {
    if (this.phase === 'ready') return 'Connected';
    if (this.phase === 'syncing') {
      return this.syncProgress ? `Syncing ${this.syncProgress.done}/${this.syncProgress.total}…` : 'Syncing…';
    }
    if (this.phase === 'connecting') {
      return this.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
    }
    if (this.phase === 'backoff') {
      return `Reconnecting in ${this.reconnectCountdown}s`;
    }
    return 'Disconnected';
  }

  private labelForRestoreMode(mode: RestoreMode | undefined, sessionCount: number): string {
    if (sessionCount > 1) {
      switch (mode) {
        case 'incremental_replay':
          return 'Replaying sessions from offset';
        case 'full_resync_cursor_stale':
          return 'Full resync (offset too old)';
        case 'disk_full_resync':
          return 'Reopening sessions from disk';
        case 'full_resync_no_cursor':
        default:
          return 'Full resync';
      }
    }

    switch (mode) {
      case 'incremental_replay':
        return 'Replaying from offset';
      case 'full_resync_cursor_stale':
        return 'Full resync (offset too old)';
      case 'disk_full_resync':
        return 'Reopening from disk';
      case 'full_resync_no_cursor':
      default:
        return 'Full resync';
    }
  }
}

export const connection = new ConnectionStore();
