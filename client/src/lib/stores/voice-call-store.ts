// Global `VoiceCallStore` instance + event routing.
//
// Instantiates a single VoiceCallStore backed by real browser seams and
// subscribes it to pimote WS voice events (call_ready / call_ended /
// call_status).

import type { PimoteEvent } from '@pimote/shared';
import { VoiceCallStore } from './voice-call.svelte.js';
import { createBrowserVoiceCallSeams } from './voice-call-seams.js';
import { connection } from './connection.svelte.js';
import { abortSession } from './session-registry.svelte.js';

// Forward-declared so the seams factory can nudge the store to `connected`
// on WebRTC ICE-connected (Step 7 plan shortcut).
let storeRef: VoiceCallStore | null = null;

const voiceSeams = createBrowserVoiceCallSeams({
  connection,
  getSessionId: () => storeRef?.state.sessionId ?? null,
  onPeerReady: (sessionId: string) => {
    storeRef?.handleServerEvent({ type: 'call_ready', sessionId });
  },
});

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
