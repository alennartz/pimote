// Speechmux LlmBackend WS protocol — minimal interface the voice extension
// consumes.  Full protocol: speechmux/docs/llm-ws-protocol.md.
//
// The voice extension uses this as the seam between itself and speechmux so
// tests can substitute an in-memory fake without running a real WebSocket.

/** Frames sent FROM the extension TO speechmux. */
export type OutgoingFrame = { type: 'token'; text: string } | { type: 'end' };

/** Frames sent FROM speechmux TO the extension. */
export type IncomingFrame = { type: 'user'; text: string } | { type: 'abort' } | { type: 'rollback'; heard_text: string };

export interface SpeechmuxClient {
  /** Sends a frame to speechmux. Throws if the socket is not open. */
  send(frame: OutgoingFrame): void;

  /** Register a listener for incoming frames. Returns an unsubscribe fn. */
  onFrame(listener: (frame: IncomingFrame) => void): () => void;

  /** Closes the socket. Idempotent. */
  close(): void;
}

export interface SpeechmuxClientFactoryOptions {
  wsUrl: string;
  callToken: string;
}

/** Factory the extension uses to open a new speechmux WS session. Tests
 *  inject a fake factory that returns an in-memory SpeechmuxClient. */
export type SpeechmuxClientFactory = (opts: SpeechmuxClientFactoryOptions) => Promise<SpeechmuxClient>;

// ---------------------------------------------------------------------------
// Default `ws`-backed implementation.
// ---------------------------------------------------------------------------

/**
 * Default `SpeechmuxClient` factory backed by the `ws` package. Opens a
 * WebSocket to `wsUrl`, sends a `hello` frame carrying the per-call auth
 * token, and routes incoming JSON text frames to registered listeners.
 *
 * Resolves once the socket is open AND the hello frame has been written.
 * Rejects if the socket errors or closes before opening.
 */
export function createDefaultSpeechmuxClientFactory(): SpeechmuxClientFactory {
  // Dynamic import so consumers that never call the factory (e.g. tests)
  // don't pay the `ws` resolution cost. Cached after first load.
  let WsCtor: typeof import('ws').WebSocket | null = null;
  return async ({ wsUrl, callToken }) => {
    if (!WsCtor) {
      const mod = await import('ws');
      WsCtor = mod.WebSocket;
    }
    const ws = new WsCtor(wsUrl);
    const listeners = new Set<(frame: IncomingFrame) => void>();
    let closed = false;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off('error', onError);
        try {
          ws.send(JSON.stringify({ type: 'hello', token: callToken }));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve();
      };
      const onError = (err: Error) => {
        ws.off('open', onOpen);
        reject(err);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });

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
      for (const listener of listeners) listener(frame);
    });

    ws.on('close', () => {
      closed = true;
    });

    return {
      send(frame) {
        if (closed || ws.readyState !== ws.OPEN) {
          throw new Error('SpeechmuxClient: socket is not open');
        }
        ws.send(JSON.stringify(frame));
      },
      onFrame(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
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
      return true;
    case 'rollback':
      return typeof v.heard_text === 'string';
    default:
      return false;
  }
}
