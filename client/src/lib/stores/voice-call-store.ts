// Global `VoiceCallStore` instance + event routing.
//
// Instantiates a single VoiceCallStore backed by real browser seams and
// subscribes it to pimote WS voice events (call_ready / call_ended /
// call_status).

import type { PimoteCommand, PimoteEvent } from '@pimote/shared';
import type { VoiceCallSeams } from './voice-call.svelte.js';
import { VoiceCallStore } from './voice-call.svelte.js';
import { connection } from './connection.svelte.js';
import { abortSession } from './session-registry.svelte.js';

// Forward-declared so the seams factory can nudge the store to `connected`
// on WebRTC ICE-connected (Step 7 plan shortcut).
let storeRef: VoiceCallStore | null = null;

// The browser seams pull in WebRTC, audio, and signalling code most sessions
// never use. Load them behind a dynamic import; the forwarding seams keep the
// store instance, its reactive state, and every consumer unchanged.
let realSeams: VoiceCallSeams | null = null;
let seamsLoading: Promise<VoiceCallSeams> | null = null;

function ensureSeams(): Promise<VoiceCallSeams> {
  if (realSeams) return Promise.resolve(realSeams);
  seamsLoading ??= import('./voice-call-seams.js').then((module) => {
    const seams = module.createBrowserVoiceCallSeams({
      connection,
      getSessionId: () => storeRef?.state.sessionId ?? null,
      onPeerReady: (sessionId: string) => {
        storeRef?.handleServerEvent({ type: 'call_ready', sessionId });
      },
    });
    realSeams = seams;
    return seams;
  });
  return seamsLoading;
}

// Warm the seams once the page settles so a call start never waits on the load.
if (typeof window !== 'undefined') {
  const warm: (callback: () => void) => void =
    typeof requestIdleCallback === 'function' ? (callback) => requestIdleCallback(() => callback()) : (callback) => setTimeout(callback, 2000);
  warm(() => void ensureSeams());
}

const voiceSeams: VoiceCallSeams = {
  async sendCommand<T = unknown>(cmd: PimoteCommand) {
    return (await ensureSeams()).sendCommand<T>(cmd);
  },
  // createPeerConnection and openSignaling only run inside a call flow whose
  // sendCommand already resolved, so the module is loaded by then.
  createPeerConnection: () => {
    if (!realSeams) throw new Error('voice_seams_not_loaded');
    return realSeams.createPeerConnection();
  },
  getUserMedia: () => ensureSeams().then((seams) => seams.getUserMedia()),
  openSignaling: (url) => {
    if (!realSeams) throw new Error('voice_seams_not_loaded');
    return realSeams.openSignaling(url);
  },
  getRemoteAudioLevel: () => realSeams?.getRemoteAudioLevel?.() ?? null,
  now: () => realSeams?.now?.() ?? Date.now(),
};

export const voiceCallStore: VoiceCallStore = (storeRef = new VoiceCallStore({ ...voiceSeams, abortSession }));

/** Inbound peer audio level (0..1) for the calling-mode pulse animation.
 *  Returns 0 when no analyser is attached. */
export function getRemoteAudioLevel(): number {
  return voiceSeams.getRemoteAudioLevel?.() ?? 0;
}

// Subscribe as soon as this module is imported. The listener is retained
// for the lifetime of the app.
connection.onEvent((event: PimoteEvent) => {
  if (event.type === 'call_ready' || event.type === 'call_ended' || event.type === 'call_status') {
    voiceCallStore.handleServerEvent(event);
    return;
  }
});
