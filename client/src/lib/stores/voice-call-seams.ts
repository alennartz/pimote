// Browser-backed VoiceCallSeams — RTCPeerConnection, getUserMedia, and the
// speechmux /signal WebSocket wired through the pimote connection store.
// See docs/plans/voice-mode.md → Step 8.
//
// Kept in a separate module from `voice-call.svelte.ts` so the store stays
// testable with in-memory fakes and doesn't transitively import browser
// globals at test-load time.

import type { CallBindResponse, PimoteCommand, PimoteResponse } from '@pimote/shared';
import type { VoiceCallSeams, VoicePeerConnection, VoiceSignalingSocket } from './voice-call.svelte.js';

/** Minimal shape of the pimote connection store used by the voice seams. */
export interface VoiceCallConnectionLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches ConnectionStore.send's non-generic signature; callers narrow via `as`.
  send(cmd: PimoteCommand): Promise<PimoteResponse<any>>;
}

export interface BrowserVoiceCallSeamsOptions {
  /** Pimote WS connection store (usually the singleton `connection`). */
  connection: VoiceCallConnectionLike;
  /** Return the session id the store currently has a call on (or null). */
  getSessionId: () => string | null;
  /** Fired when the WebRTC peer is locally ready (iceConnectionState 'connected' or 'completed'). */
  onPeerReady: (sessionId: string) => void;
}

export interface BrowserVoicePeerConnection extends VoicePeerConnection {
  /** Mute/unmute the outgoing microphone track. */
  setMicrophoneEnabled(enabled: boolean): void;
  /** Expose the underlying RTCPeerConnection for the signalling handshake. */
  readonly raw: RTCPeerConnection;
}

/**
 * Build the browser seams object consumed by `VoiceCallStore`.
 *
 * Wires `RTCPeerConnection.iceConnectionState === 'connected'` into a
 * synthetic `call_ready` via `onPeerReady` so the store can transition
 * `connecting → connected` without waiting for a server round-trip (Step 7
 * plan shortcut).
 */
export function createBrowserVoiceCallSeams(opts: BrowserVoiceCallSeamsOptions): VoiceCallSeams {
  return {
    async sendCommand<T = unknown>(cmd: PimoteCommand): Promise<PimoteResponse<T>> {
      return (await opts.connection.send(cmd)) as PimoteResponse<T>;
    },

    createPeerConnection(turn: CallBindResponse['turn']): BrowserVoicePeerConnection {
      const pc = new RTCPeerConnection({
        iceServers: turn.urls.length > 0 ? [{ urls: turn.urls, username: turn.username, credential: turn.credential }] : [],
      });
      const audioTracks: MediaStreamTrack[] = [];

      pc.addEventListener('iceconnectionstatechange', () => {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          const sid = opts.getSessionId();
          if (sid) opts.onPeerReady(sid);
        }
      });

      return {
        get raw() {
          return pc;
        },
        close(): void {
          try {
            pc.close();
          } catch {
            /* ignore */
          }
        },
        addTrack(track: unknown, stream: unknown): void {
          const t = track as MediaStreamTrack;
          const s = stream as MediaStream;
          if (t.kind === 'audio') audioTracks.push(t);
          pc.addTrack(t, s);
        },
        setMicrophoneEnabled(enabled: boolean): void {
          for (const t of audioTracks) t.enabled = enabled;
        },
      };
    },

    async getUserMedia(): Promise<{ stream: unknown; tracks: unknown[] }> {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return { stream, tracks: stream.getAudioTracks() };
    },

    openSignaling(url: string, callToken: string): VoiceSignalingSocket {
      const ws = new WebSocket(url);
      const listeners = new Set<(msg: unknown) => void>();

      const opened = new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          ws.removeEventListener('error', onError);
          try {
            ws.send(JSON.stringify({ type: 'hello', token: callToken }));
          } catch (err) {
            reject(err);
            return;
          }
          resolve();
        };
        const onError = (ev: Event) => {
          ws.removeEventListener('open', onOpen);
          reject(new Error((ev as ErrorEvent).message ?? 'signaling_open_failed'));
        };
        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('error', onError, { once: true });
      });

      ws.addEventListener('message', (ev) => {
        let data: unknown;
        try {
          data = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        } catch {
          return;
        }
        for (const l of listeners) l(data);
      });

      return {
        send(message: unknown): void {
          ws.send(JSON.stringify(message));
        },
        close(): void {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
        onMessage(listener: (msg: unknown) => void): () => void {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        opened,
      };
    },
  };
}
