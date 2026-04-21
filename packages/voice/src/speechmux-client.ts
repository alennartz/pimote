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
