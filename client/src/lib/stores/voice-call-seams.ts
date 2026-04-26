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
import { voiceTrace } from './voice-trace.js';

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

  // Inbound audio level analysis state. Lazily created when the first
  // inbound audio track arrives; torn down when the peer closes. Sampled
  // at ~10Hz; the latest RMS is cached and returned by `getRemoteAudioLevel`.
  let levelAudioContext: AudioContext | null = null;
  let levelAnalyser: AnalyserNode | null = null;
  let levelInterval: ReturnType<typeof setInterval> | null = null;
  let latestLevel: number | null = null;
  // Track of the currently-attached track and its 'ended' listener so we can
  // remove the listener when the analyser is replaced/torn down. Without this,
  // a stale listener registered on an old track will fire after renegotiation
  // and tear down the *new* analyser. (review finding #1)
  let levelTrack: MediaStreamTrack | null = null;
  let levelTrackEndedListener: (() => void) | null = null;

  const teardownLevelAnalyser = (): void => {
    if (levelTrack && levelTrackEndedListener) {
      try {
        levelTrack.removeEventListener('ended', levelTrackEndedListener);
      } catch {
        /* ignore */
      }
    }
    levelTrack = null;
    levelTrackEndedListener = null;
    if (levelInterval) {
      clearInterval(levelInterval);
      levelInterval = null;
    }
    if (levelAnalyser) {
      try {
        levelAnalyser.disconnect();
      } catch {
        /* ignore */
      }
      levelAnalyser = null;
    }
    if (levelAudioContext) {
      try {
        void levelAudioContext.close();
      } catch {
        /* ignore */
      }
      levelAudioContext = null;
    }
    latestLevel = null;
  };

  const attachLevelAnalyser = (track: MediaStreamTrack): void => {
    // Replace any existing analyser (e.g. renegotiation delivers a new track).
    teardownLevelAnalyser();
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      const buffer = new Uint8Array(analyser.fftSize);
      levelAudioContext = ctx;
      levelAnalyser = analyser;
      latestLevel = 0;
      levelInterval = setInterval(() => {
        if (!levelAnalyser) return;
        levelAnalyser.getByteTimeDomainData(buffer);
        // Time-domain bytes are centred on 128 (silence). Compute RMS in
        // [-1, 1] and clamp to [0, 1].
        let sumSq = 0;
        for (let i = 0; i < buffer.length; i++) {
          const v = (buffer[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / buffer.length);
        latestLevel = Math.max(0, Math.min(1, rms));
      }, 100);
      // Drop the analyser if the track ends. Stash the track + listener so a
      // subsequent `attachLevelAnalyser` (renegotiation) or peer close can
      // remove the listener — otherwise an old track ending later would tear
      // down the *current* analyser.
      const endedListener = (): void => {
        teardownLevelAnalyser();
      };
      levelTrack = track;
      levelTrackEndedListener = endedListener;
      track.addEventListener('ended', endedListener, { once: true });
    } catch (err) {
      voiceTrace('webrtc', 'level_analyser_failed', { level: 'warn', data: { err: String(err) } });
      teardownLevelAnalyser();
    }
  };

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

      // Sink for speechmux's outbound audio (TTS). We create a dedicated
      // hidden <audio> element per peer and route the remote track into it
      // via srcObject. Without this, the browser decodes SRTP and hands the
      // PCM to nothing — the user hears silence even though audio is flowing.
      let remoteAudioEl: HTMLAudioElement | null = null;
      let remoteStream: MediaStream | null = null;
      const ensureRemoteAudio = (): { el: HTMLAudioElement; stream: MediaStream } => {
        if (remoteAudioEl && remoteStream) return { el: remoteAudioEl, stream: remoteStream };
        const el = document.createElement('audio');
        el.autoplay = true;
        el.setAttribute('playsinline', ''); // iOS Safari: allow inline playback
        el.style.display = 'none';
        document.body.appendChild(el);
        const stream = new MediaStream();
        el.srcObject = stream;
        remoteAudioEl = el;
        remoteStream = stream;
        return { el, stream };
      };

      // Snapshot peer connection state changes for diagnostics.
      pc.addEventListener('connectionstatechange', () => {
        voiceTrace('webrtc', 'connectionstatechange', { data: { state: pc.connectionState } });
      });
      pc.addEventListener('signalingstatechange', () => {
        voiceTrace('webrtc', 'signalingstatechange', { data: { state: pc.signalingState } });
      });
      pc.addEventListener('icegatheringstatechange', () => {
        voiceTrace('webrtc', 'icegatheringstatechange', { data: { state: pc.iceGatheringState } });
      });

      pc.addEventListener('track', (ev: RTCTrackEvent) => {
        voiceTrace('webrtc', 'on_track', { data: { kind: ev.track.kind, id: ev.track.id, readyState: ev.track.readyState, streamCount: ev.streams.length } });
        if (ev.track.kind !== 'audio') return;
        attachLevelAnalyser(ev.track);
        const { el, stream } = ensureRemoteAudio();
        // Chromium delivers the track via ev.streams[0]; Safari sometimes
        // ships an empty streams array and expects us to build our own.
        const arriving = ev.streams[0];
        if (arriving) {
          for (const t of arriving.getAudioTracks()) {
            if (!stream.getAudioTracks().includes(t)) stream.addTrack(t);
          }
        } else if (!stream.getAudioTracks().includes(ev.track)) {
          stream.addTrack(ev.track);
        }
        // Kick playback — autoplay should cover it, but some browsers need
        // an explicit .play() (which may reject if user gesture is required).
        void el.play().catch(() => {
          /* user-gesture policies can block this; the call button is the gesture */
        });
      });

      // Bind the session id at peer-creation time so a delayed
      // `connected`/`completed` transition after a session swap can't
      // synthesize a `call_ready` for the wrong session. (review finding #4)
      const boundSessionId = opts.getSessionId();
      pc.addEventListener('iceconnectionstatechange', () => {
        voiceTrace('webrtc', 'iceconnectionstatechange', { data: { state: pc.iceConnectionState } });
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          if (boundSessionId) opts.onPeerReady(boundSessionId);
        }
      });

      // Periodic RTCStatsReport snapshot for diagnostic dumps. Stops when the
      // peer connection is closed.
      const statsInterval = setInterval(async () => {
        if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
          clearInterval(statsInterval);
          return;
        }
        try {
          const report = await pc.getStats();
          const summary: Record<string, unknown> = {};
          report.forEach((stat) => {
            if (stat.type === 'inbound-rtp' && (stat as { kind?: string }).kind === 'audio') {
              summary.inbound = {
                packetsReceived: (stat as { packetsReceived?: number }).packetsReceived,
                packetsLost: (stat as { packetsLost?: number }).packetsLost,
                jitter: (stat as { jitter?: number }).jitter,
                bytesReceived: (stat as { bytesReceived?: number }).bytesReceived,
                audioLevel: (stat as { audioLevel?: number }).audioLevel,
                totalAudioEnergy: (stat as { totalAudioEnergy?: number }).totalAudioEnergy,
              };
            } else if (stat.type === 'outbound-rtp' && (stat as { kind?: string }).kind === 'audio') {
              summary.outbound = {
                packetsSent: (stat as { packetsSent?: number }).packetsSent,
                bytesSent: (stat as { bytesSent?: number }).bytesSent,
                retransmittedPacketsSent: (stat as { retransmittedPacketsSent?: number }).retransmittedPacketsSent,
              };
            } else if (stat.type === 'media-source' && (stat as { kind?: string }).kind === 'audio') {
              summary.mediaSource = {
                audioLevel: (stat as { audioLevel?: number }).audioLevel,
                totalAudioEnergy: (stat as { totalAudioEnergy?: number }).totalAudioEnergy,
                echoReturnLoss: (stat as { echoReturnLoss?: number }).echoReturnLoss,
                echoReturnLossEnhancement: (stat as { echoReturnLossEnhancement?: number }).echoReturnLossEnhancement,
              };
            }
          });
          voiceTrace('webrtc', 'stats', { data: summary });
        } catch (err) {
          voiceTrace('webrtc', 'stats_error', { level: 'warn', data: { err: String(err) } });
        }
      }, 1000);

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
          // Stop the periodic stats poll deterministically; it otherwise only
          // self-cancels by polling pc.connectionState. (review finding #2)
          clearInterval(statsInterval);
          teardownLevelAnalyser();
          // Avoid leaking a closed peer into a future openSignaling. (review finding #5)
          if (currentPeer === wrapped) currentPeer = null;
          // Tear down the remote-audio sink so it doesn't linger in the DOM.
          if (remoteAudioEl) {
            try {
              remoteAudioEl.pause();
              remoteAudioEl.srcObject = null;
              remoteAudioEl.remove();
            } catch {
              /* ignore */
            }
            remoteAudioEl = null;
          }
          remoteStream = null;
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

    getRemoteAudioLevel(): number | null {
      return latestLevel;
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
      const tracks = stream.getAudioTracks();
      // Log the actual constraints/settings the browser applied so we can
      // tell whether AEC/NS/AGC are really on (Chrome on Linux occasionally
      // silently drops them).
      for (const t of tracks) {
        const settings = (t.getSettings ? t.getSettings() : {}) as Record<string, unknown>;
        const constraints = (t.getConstraints ? t.getConstraints() : {}) as Record<string, unknown>;
        const capabilities = (t.getCapabilities ? t.getCapabilities() : {}) as Record<string, unknown>;
        voiceTrace('mic', 'getUserMedia.track', {
          data: {
            label: t.label,
            id: t.id,
            readyState: t.readyState,
            muted: t.muted,
            enabled: t.enabled,
            settings,
            constraints,
            capabilities,
          },
        });
      }
      return { stream, tracks };
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
          voiceTrace('signaling', `send:${type}`, { data: { payloadKeys: Object.keys(payload) } });
          ws.send(encodeSignal(type, payload));
        } catch (err) {
          console.warn('[voice] signaling send failed', type, err);
          voiceTrace('signaling', `send_failed:${type}`, { level: 'warn', data: { err: String(err) } });
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

      ws.addEventListener('open', () => voiceTrace('signaling', 'ws_open', { data: { url } }));
      ws.addEventListener('close', (ev) => voiceTrace('signaling', 'ws_close', { data: { code: ev.code, reason: ev.reason, wasClean: ev.wasClean } }));
      ws.addEventListener('error', () => voiceTrace('signaling', 'ws_error', { level: 'warn' }));

      ws.addEventListener('message', (ev) => {
        const env = decodeSignal(ev.data);
        if (env) voiceTrace('signaling', `recv:${env.type}`, { data: { payloadKeys: Object.keys(env.payload ?? {}) } });
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
