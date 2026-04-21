// VoiceCallStore — client-side call-control state machine.
//
// See docs/plans/voice-mode.md → "Client voice-call controller". Owns the
// RTCPeerConnection, getUserMedia stream, speechmux /signal WS client, and
// the reactive call state. Uses constructor-injected seams so tests can
// substitute in-memory fakes for WebRTC / getUserMedia / the signalling WS.

import type { CallBindResponse, CallReadyEvent, CallEndedEvent, CallStatusEvent, PimoteCommand, PimoteResponse } from '@pimote/shared';

// --- Public state shape -------------------------------------------------------

export type VoiceCallPhase = 'idle' | 'binding' | 'connecting' | 'connected' | 'ending';

export interface VoiceCallState {
  phase: VoiceCallPhase;
  sessionId: string | null;
  micMuted: boolean;
  lastError: string | null;
}

// --- Injectable seams (tests replace these) ----------------------------------

/** Abstraction over `RTCPeerConnection` — only the methods the store uses. */
export interface VoicePeerConnection {
  close(): void;
  addTrack(track: unknown, stream: unknown): void;
}

/** Abstraction over the speechmux /signal WebSocket. */
export interface VoiceSignalingSocket {
  send(message: unknown): void;
  close(): void;
  /** Attach a listener for incoming signalling messages. Returns an unsubscribe fn. */
  onMessage(listener: (msg: unknown) => void): () => void;
  /** Resolves once the underlying socket has opened. */
  opened: Promise<void>;
}

export interface VoiceCallSeams {
  /** Sends a command over the pimote WS. Returns the server response. */
  sendCommand: <T = unknown>(cmd: PimoteCommand) => Promise<PimoteResponse<T>>;
  /** Opens a WebRTC peer configured with the given TURN credentials. */
  createPeerConnection: (turn: CallBindResponse['turn']) => VoicePeerConnection;
  /** Obtains a local microphone stream. */
  getUserMedia: () => Promise<{ stream: unknown; tracks: unknown[] }>;
  /** Opens a signalling WS to speechmux. */
  openSignaling: (url: string, callToken: string) => VoiceSignalingSocket;
}

// --- Store --------------------------------------------------------------------

export class VoiceCallStore {
  // In production this is a $state() rune; tests can read the same field.
  state: VoiceCallState = {
    phase: 'idle',
    sessionId: null,
    micMuted: false,
    lastError: null,
  };

  private peer: VoicePeerConnection | null = null;
  private signaling: VoiceSignalingSocket | null = null;

  constructor(private readonly seams: VoiceCallSeams) {}

  /**
   * Send call_bind, open WebRTC peer, start signalling. Moves the store
   * through `binding` → `connecting`. The `connected` phase is entered when
   * the server emits CallReadyEvent (handed to `handleServerEvent`).
   */
  async startCall(sessionId: string): Promise<void> {
    if (this.state.phase !== 'idle') {
      throw new Error('voice_call_already_in_progress');
    }

    this.state = { phase: 'binding', sessionId, micMuted: false, lastError: null };

    let response: PimoteResponse<Omit<CallBindResponse, 'type' | 'id'>>;
    try {
      response = await this.seams.sendCommand<Omit<CallBindResponse, 'type' | 'id'>>({
        type: 'call_bind',
        id: crypto.randomUUID(),
        sessionId,
      });
    } catch (err) {
      this.state = { phase: 'idle', sessionId: null, micMuted: false, lastError: (err as Error).message };
      throw err;
    }

    if (!response.success || !response.data) {
      this.state = { phase: 'idle', sessionId: null, micMuted: false, lastError: response.error ?? 'call_bind_failed' };
      throw new Error(response.error ?? 'call_bind_failed');
    }

    const { turn, webrtcSignalUrl, callToken } = response.data;

    // Peer and signalling setup — all testable via injected seams.
    try {
      this.peer = this.seams.createPeerConnection(turn);
      const { stream, tracks } = await this.seams.getUserMedia();
      for (const track of tracks) this.peer.addTrack(track, stream);
      this.signaling = this.seams.openSignaling(webrtcSignalUrl, callToken);
    } catch (err) {
      this.teardown();
      this.state = { phase: 'idle', sessionId: null, micMuted: false, lastError: (err as Error).message };
      throw err;
    }

    this.state = { phase: 'connecting', sessionId, micMuted: false, lastError: null };
  }

  /** Send call_end and tear down. */
  async endCall(): Promise<void> {
    const sessionId = this.state.sessionId;
    if (!sessionId || this.state.phase === 'idle') return;
    this.state = { ...this.state, phase: 'ending' };

    try {
      await this.seams.sendCommand({ type: 'call_end', id: crypto.randomUUID(), sessionId });
    } catch {
      // Fall through to local teardown even if the end command fails.
    }
    this.teardown();
    this.state = { phase: 'idle', sessionId: null, micMuted: false, lastError: null };
  }

  toggleMute(): void {
    if (this.state.phase === 'idle') return;
    this.state = { ...this.state, micMuted: !this.state.micMuted };
  }

  /** Handles call_ready / call_ended / call_status events from the pimote WS. */
  handleServerEvent(event: CallReadyEvent | CallEndedEvent | CallStatusEvent): void {
    if (event.type === 'call_ready') {
      if (event.sessionId !== this.state.sessionId) return;
      this.state = { ...this.state, phase: 'connected' };
      return;
    }
    if (event.type === 'call_ended') {
      if (event.sessionId !== this.state.sessionId) return;
      this.teardown();
      this.state = {
        phase: 'idle',
        sessionId: null,
        micMuted: false,
        lastError: event.reason === 'error' ? 'call_ended_error' : null,
      };
      return;
    }
    if (event.type === 'call_status') {
      if (event.sessionId !== this.state.sessionId) return;
      // Advisory only — do not override `connected` / `idle` phases.
      if (event.status === 'ringing' && this.state.phase === 'binding') {
        this.state = { ...this.state, phase: 'connecting' };
      }
      return;
    }
  }

  private teardown(): void {
    this.peer?.close();
    this.signaling?.close();
    this.peer = null;
    this.signaling = null;
  }
}
