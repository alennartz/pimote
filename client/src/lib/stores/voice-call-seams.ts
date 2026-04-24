// Browser-backed VoiceCallSeams — RTCPeerConnection, getUserMedia, and the
// speechmux /signal WebSocket wired through the pimote connection store.
// See docs/plans/voice-mode.md → Step 8.
//
// Kept in a separate module from `voice-call.svelte.ts` so the store stays
// testable with in-memory fakes and doesn't transitively import browser
// globals at test-load time.
//
// This module owns the browser-side of speechmux's `/signal` handshake (see
// `speechmux/src/webrtc_transport/signaling.rs`):
//
//   hello(token)      →
//                     ← session(iceServers)
//   offer(sdp)        →
//                     ← answer(sdp)
//   ice(candidate)   ←→ ice(candidate)   (trickle, both directions)
//   bye / error       close
//
// All wire messages are wrapped in a versioned envelope:
//
//     { "v": 1, "type": "...", "payload": { ... } }
//
// The scaffolding below is implemented against that contract but is not yet
// exercised end-to-end against a live speechmux — see
// `docs/manual-tests/voice-mode.md` for the blocked real-smoke checklist.

import type { PimoteCommand, PimoteResponse } from '@pimote/shared';
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

// ---------------------------------------------------------------------------
// Speechmux signalling envelope helpers.
// ---------------------------------------------------------------------------

/** Current wire-protocol version accepted by speechmux. */
const SIGNAL_PROTOCOL_VERSION = 1;

interface SignalEnvelope {
  v: number;
  type: string;
  payload?: Record<string, unknown>;
}

function encodeSignal(type: string, payload: Record<string, unknown> = {}): string {
  const envelope: SignalEnvelope = { v: SIGNAL_PROTOCOL_VERSION, type, payload };
  return JSON.stringify(envelope);
}

function decodeSignal(raw: unknown): SignalEnvelope | null {
  const text = typeof raw === 'string' ? raw : null;
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== 'string') return null;
  if (typeof obj.v !== 'number' || obj.v !== SIGNAL_PROTOCOL_VERSION) return null;
  const payload = obj.payload && typeof obj.payload === 'object' ? (obj.payload as Record<string, unknown>) : {};
  return { v: obj.v, type: obj.type, payload };
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
  // The store invokes `createPeerConnection` before `openSignaling`; we
  // stash the most-recent peer here so the signalling seam can bridge
  // offer/answer/ice directly into it.
  let currentPeer: BrowserVoicePeerConnection | null = null;

  return {
    async sendCommand<T = unknown>(cmd: PimoteCommand): Promise<PimoteResponse<T>> {
      return (await opts.connection.send(cmd)) as PimoteResponse<T>;
    },

    createPeerConnection(): BrowserVoicePeerConnection {
      // TURN credentials are delivered by speechmux in its `/signal`
      // `session` response. We construct the peer with no iceServers here;
      // host / srflx candidates are sufficient for the common case, and
      // wiring speechmux's iceServers into `pc.setConfiguration` is a
      // future enhancement (see DR-012).
      const pc = new RTCPeerConnection();
      const audioTracks: MediaStreamTrack[] = [];

      pc.addEventListener('iceconnectionstatechange', () => {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          const sid = opts.getSessionId();
          if (sid) opts.onPeerReady(sid);
        }
      });

      const wrapped: BrowserVoicePeerConnection = {
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
      currentPeer = wrapped;
      return wrapped;
    },

    async getUserMedia(): Promise<{ stream: unknown; tracks: unknown[] }> {
      // Explicit constraints for voice-call use:
      // - `echoCancellation` is usually default-true, but Android Chrome has
      //   historically been inconsistent. Without AEC, speaker-to-mic loopback
      //   triggers speechmux's VAD and spirals into self-barge-in.
      // - `noiseSuppression` + `autoGainControl` are standard defaults but
      //   made explicit for the same reason.
      // - `channelCount: 1` forces a mono track; matches speechmux's mono
      //   decoder (avoiding the stereo-downmix warning) and halves upstream
      //   bandwidth.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      return { stream, tracks: stream.getAudioTracks() };
    },

    openSignaling(url: string): VoiceSignalingSocket {
      const peer = currentPeer;
      if (!peer) {
        // The store should have called createPeerConnection first; if not,
        // the WS still opens but no WebRTC bridging happens. Surface this as
        // a console warning so the mis-ordering is visible during smoke.
        console.warn('[voice] openSignaling called before createPeerConnection; no WebRTC bridging');
      }
      const pc = peer?.raw ?? null;

      const ws = new WebSocket(url);
      const listeners = new Set<(msg: unknown) => void>();
      let sessionReceived = false;
      let remoteDescriptionSet = false;
      // Outbound ICE candidates queued until `session` arrives (so the
      // server has a session actor ready to receive them).
      const pendingOutboundIce: RTCIceCandidate[] = [];
      // Inbound ICE candidates queued until setRemoteDescription completes.
      const pendingInboundIce: RTCIceCandidateInit[] = [];

      const sendEnvelope = (type: string, payload: Record<string, unknown> = {}): void => {
        try {
          ws.send(encodeSignal(type, payload));
        } catch (err) {
          console.warn('[voice] signaling send failed', type, err);
        }
      };

      const flushOutboundIce = (): void => {
        const drained = pendingOutboundIce.splice(0, pendingOutboundIce.length);
        for (const c of drained) {
          sendEnvelope('ice', {
            candidate: c.candidate ?? null,
            sdpMid: c.sdpMid ?? '',
            sdpMLineIndex: c.sdpMLineIndex ?? 0,
          });
        }
      };

      const flushInboundIce = async (): Promise<void> => {
        if (!pc) return;
        const drained = pendingInboundIce.splice(0, pendingInboundIce.length);
        for (const init of drained) {
          try {
            await pc.addIceCandidate(init);
          } catch (err) {
            console.warn('[voice] addIceCandidate (flush) failed', err);
          }
        }
      };

      // Outbound: local ICE candidates. Queue until session received, then
      // trickle to the server. End-of-candidates is signalled via
      // `candidate: null` per the speechmux wire protocol.
      if (pc) {
        pc.addEventListener('icecandidate', (ev) => {
          const c = ev.candidate;
          if (!c) {
            const endOfCandidates = { candidate: null, sdpMid: '', sdpMLineIndex: 0 };
            if (!sessionReceived) {
              // Synthesize a sentinel — we still need the server to learn
              // end-of-candidates once it's ready.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pushing a sentinel object shaped like an ICE candidate for later flushing
              pendingOutboundIce.push(endOfCandidates as any);
              return;
            }
            sendEnvelope('ice', endOfCandidates);
            return;
          }
          if (!sessionReceived) {
            pendingOutboundIce.push(c);
            return;
          }
          sendEnvelope('ice', {
            candidate: c.candidate,
            sdpMid: c.sdpMid ?? '',
            sdpMLineIndex: c.sdpMLineIndex ?? 0,
          });
        });
      }

      const opened = new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          ws.removeEventListener('error', onError);
          // LLM-WS and `/signal` are different protocols. `/signal` DOES
          // require a hello frame, but with Cloudflare Access as the auth
          // boundary speechmux runs in fail-open mode and accepts a hello
          // with no token field (see speechmux signaling.rs
          // `validate_hello`).
          try {
            ws.send(encodeSignal('hello', {}));
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
        const env = decodeSignal(ev.data);
        if (!env) return;
        // Fan out the decoded envelope to external listeners (tests /
        // observers). The peer-connection bridge below runs regardless of
        // subscribers so the handshake progresses even when no one is
        // listening.
        for (const l of listeners) l(env);

        if (!pc) return;

        void (async () => {
          try {
            switch (env.type) {
              case 'session': {
                // Speechmux returns per-session TURN creds in this frame.
                // Apply them via `pc.setConfiguration` so the browser uses
                // them during ICE negotiation — without this, peer-to-peer
                // only works on permissive NATs / open networks. The wire
                // shape matches speechmux/src/webrtc_transport/turn.rs
                // (urls/username/credential, camelCase over JSON).
                const ice = Array.isArray(env.payload?.iceServers) ? env.payload.iceServers : [];
                const iceServers: RTCIceServer[] = ice
                  .filter((s: unknown): s is { urls: unknown; username?: unknown; credential?: unknown } => typeof s === 'object' && s !== null)
                  .map((s) => {
                    const urls = Array.isArray(s.urls) ? s.urls.filter((u): u is string => typeof u === 'string') : typeof s.urls === 'string' ? [s.urls] : [];
                    const username = typeof s.username === 'string' ? s.username : undefined;
                    const credential = typeof s.credential === 'string' ? s.credential : undefined;
                    return { urls, ...(username !== undefined ? { username } : {}), ...(credential !== undefined ? { credential } : {}) };
                  })
                  .filter((s) => s.urls.length > 0);
                if (iceServers.length > 0) {
                  pc.setConfiguration({ iceServers });
                }
                sessionReceived = true;
                // Create offer if one hasn't been created yet (addTrack
                // ordinarily fires `negotiationneeded` which we piggyback
                // on; but to avoid races we create one explicitly here).
                if (!pc.localDescription) {
                  const offer = await pc.createOffer();
                  await pc.setLocalDescription(offer);
                }
                const local = pc.localDescription;
                if (local?.sdp) {
                  sendEnvelope('offer', { sdp: local.sdp });
                }
                flushOutboundIce();
                return;
              }
              case 'answer': {
                const sdp = env.payload?.sdp;
                if (typeof sdp !== 'string') return;
                await pc.setRemoteDescription({ type: 'answer', sdp });
                remoteDescriptionSet = true;
                await flushInboundIce();
                return;
              }
              case 'ice': {
                const p = env.payload ?? {};
                const candidate = typeof p.candidate === 'string' ? p.candidate : null;
                const sdpMid = typeof p.sdpMid === 'string' ? p.sdpMid : undefined;
                const sdpMLineIndex = typeof p.sdpMLineIndex === 'number' ? p.sdpMLineIndex : undefined;
                const init: RTCIceCandidateInit = { candidate: candidate ?? '', sdpMid, sdpMLineIndex };
                if (!remoteDescriptionSet) {
                  pendingInboundIce.push(init);
                  return;
                }
                try {
                  await pc.addIceCandidate(init);
                } catch (err) {
                  console.warn('[voice] addIceCandidate failed', err);
                }
                return;
              }
              case 'error': {
                console.warn('[voice] signaling error', env.payload);
                try {
                  ws.close();
                } catch {
                  /* ignore */
                }
                return;
              }
              case 'bye': {
                try {
                  ws.close();
                } catch {
                  /* ignore */
                }
                return;
              }
            }
          } catch (err) {
            console.warn('[voice] signaling handler failed', env.type, err);
          }
        })();
      });

      return {
        send(message: unknown): void {
          // Raw pass-through for tests / advanced callers. Production code
          // paths go through the bridging handlers above.
          ws.send(typeof message === 'string' ? message : JSON.stringify(message));
        },
        close(): void {
          try {
            // Send a best-effort `bye` before closing so speechmux can tear
            // down cleanly. Ignore errors if the socket is already closed.
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(encodeSignal('bye', {}));
            }
          } catch {
            /* ignore */
          }
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
