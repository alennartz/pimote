// Speechmux LlmBackend WS protocol — minimal interface the voice extension
// consumes.  Full protocol: speechmux/docs/llm-ws-protocol.md.
//
// The voice extension uses this as the seam between itself and speechmux so
// tests can substitute an in-memory fake without running a real WebSocket.

/**
 * Frames sent FROM the extension TO speechmux.
 *
 * `speak_id` (when present) identifies the harness-side `speak()` tool
 * call this frame belongs to. Speechmux stamps every synthesized chunk
 * with the speak_id of the current utterance and round-trips it back to
 * the harness on `abort` / `rollback` so the harness can target the
 * correct speak block in its conversation history. Optional for
 * back-compat with non-speak_id-aware speechmux builds.
 */
export type OutgoingFrame =
  | { type: 'token'; text: string; speak_id?: string }
  | { type: 'end'; speak_id?: string }
  | { type: 'floor_released'; speak_id?: string }
  | { type: 'error'; message: string; speak_id?: string };

/**
 * Frames sent FROM speechmux TO the extension.
 *
 * `speak_id` on `abort` / `rollback` (when present) is the speak_id of
 * the utterance that was actively playing at the moment of the
 * interrupt. The harness uses it as the walkback target.
 */
export type IncomingFrame =
  | { type: 'user'; text: string }
  | { type: 'abort'; reason?: 'user_speaking' | 'barge_in' | 'session_closed'; speak_id?: string }
  | { type: 'rollback'; heard_text: string; speak_id?: string };

export interface SpeechmuxClient {
  /** Sends a frame to speechmux. Throws if the socket is not open. */
  send(frame: OutgoingFrame): void;

  /** Register a listener for incoming frames. Returns an unsubscribe fn. */
  onFrame(listener: (frame: IncomingFrame) => void): () => void;

  /** Register a listener for post-open socket disconnects. Returns an unsubscribe fn. */
  onDisconnect(listener: () => void): () => void;

  /** Closes the socket. Idempotent. */
  close(): void;
}

export interface SpeechmuxClientFactoryOptions {
  wsUrl: string;
  /** Optional connect timeout in milliseconds. Defaults to 5000. If the
   *  WebSocket `open` event hasn't fired by then we tear the socket
   *  down and reject — keeps a wedged speechmux from hanging the call
   *  in `activating` forever. */
  connectTimeoutMs?: number;
}

/** Factory the extension uses to open a new speechmux WS session. Tests
 *  inject a fake factory that returns an in-memory SpeechmuxClient. */
export type SpeechmuxClientFactory = (opts: SpeechmuxClientFactoryOptions) => Promise<SpeechmuxClient>;

// ---------------------------------------------------------------------------
// Default `ws`-backed implementation.
// ---------------------------------------------------------------------------

/**
 * Default `SpeechmuxClient` factory backed by the `ws` package. Opens a
 * WebSocket to `wsUrl` and routes incoming JSON text frames to registered
 * listeners. The LLM-WS protocol has no hello frame — the harness simply
 * connects and exchanges `user` / `token` / `end` / `floor_released` /
 * `error` / `abort` / `rollback` frames (see
 * speechmux/docs/llm-ws-protocol.md).
 *
 * Resolves once the socket is open. Rejects if the socket errors or closes
 * before opening.
 */
export function createDefaultSpeechmuxClientFactory(): SpeechmuxClientFactory {
  // Dynamic import so consumers that never call the factory (e.g. tests)
  // don't pay the `ws` resolution cost. Cached after first load.
  let WsCtor: typeof import('ws').WebSocket | null = null;
  return async (opts) => {
    const { wsUrl } = opts;
    if (!WsCtor) {
      const mod = await import('ws');
      WsCtor = mod.WebSocket;
    }
    const ws = new WsCtor(wsUrl);
    const listeners = new Set<(frame: IncomingFrame) => void>();
    const disconnectListeners = new Set<() => void>();
    // Buffer frames that arrive after `hello` but before the caller has had a
    // chance to attach an `onFrame` listener. Drained on the first attach.
    const pending: IncomingFrame[] = [];
    let closed = false;
    let opened = false;
    let disconnectNotified = false;

    // Install the message handler before resolving so frames sent between
    // open and the caller's onFrame attach are buffered instead of dropped.
    // See review finding 5 (speechmux-client race).
    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) return;
      let text: string;
      if (typeof raw === 'string') text = raw;
      else if (raw instanceof Buffer) text = raw.toString('utf8');
      else if (Array.isArray(raw)) text = Buffer.concat(raw).toString('utf8');
      else text = Buffer.from(raw as ArrayBuffer).toString('utf8');
      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch {
        return; // ignore non-JSON
      }
      if (!isIncomingFrame(frame)) return;
      if (listeners.size === 0) {
        pending.push(frame);
        return;
      }
      for (const listener of listeners) listener(frame);
    });

    const connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        ws.off('open', onOpen);
        ws.off('error', onError);
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        opened = true;
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        reject(new Error(`SpeechmuxClient: connect timeout after ${connectTimeoutMs}ms (${wsUrl})`));
      }, connectTimeoutMs);
      ws.once('open', onOpen);
      ws.once('error', onError);
    });

    const notifyDisconnect = () => {
      if (!opened || disconnectNotified) return;
      disconnectNotified = true;
      for (const listener of disconnectListeners) listener();
    };

    ws.on('close', () => {
      closed = true;
      notifyDisconnect();
    });

    return {
      send(frame) {
        if (closed || ws.readyState !== ws.OPEN) {
          throw new Error('SpeechmuxClient: socket is not open');
        }
        ws.send(JSON.stringify(frame));
      },
      onFrame(listener) {
        const firstListener = listeners.size === 0;
        listeners.add(listener);
        if (firstListener && pending.length > 0) {
          // Drain any frames that arrived before the listener attached.
          const drained = pending.splice(0, pending.length);
          for (const frame of drained) listener(frame);
        }
        return () => listeners.delete(listener);
      },
      onDisconnect(listener) {
        disconnectListeners.add(listener);
        return () => disconnectListeners.delete(listener);
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
      },
    };
  };
}

function isIncomingFrame(value: unknown): value is IncomingFrame {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'user':
      return typeof v.text === 'string';
    case 'abort':
      return v.reason === undefined || v.reason === 'user_speaking' || v.reason === 'barge_in' || v.reason === 'session_closed';
    case 'rollback':
      return typeof v.heard_text === 'string';
    default:
      return false;
  }
}
