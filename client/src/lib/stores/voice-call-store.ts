// Global `VoiceCallStore` instance + event routing.
//
// Instantiates a single VoiceCallStore backed by real browser seams and
// subscribes it to pimote WS voice events (call_ready / call_ended /
// call_status). Also synthesises a `call_ended { reason: 'displaced' }`
// when the server sends `session_closed { reason: 'displaced' }` for the
// session currently under a call, so the local store tears down.

import type { PimoteEvent } from '@pimote/shared';
import { VoiceCallStore } from './voice-call.svelte.js';
import { createBrowserVoiceCallSeams } from './voice-call-seams.js';
import { connection } from './connection.svelte.js';

// Forward-declared so the seams factory can nudge the store to `connected`
// on WebRTC ICE-connected (Step 7 plan shortcut).
let storeRef: VoiceCallStore | null = null;

export const voiceCallStore: VoiceCallStore = (storeRef = new VoiceCallStore(
  createBrowserVoiceCallSeams({
    connection,
    getSessionId: () => storeRef?.state.sessionId ?? null,
    onPeerReady: (sessionId: string) => {
      storeRef?.handleServerEvent({ type: 'call_ready', sessionId });
    },
  }),
));

// Subscribe as soon as this module is imported. The listener is retained
// for the lifetime of the app.
connection.onEvent((event: PimoteEvent) => {
  if (event.type === 'call_ready' || event.type === 'call_ended' || event.type === 'call_status') {
    voiceCallStore.handleServerEvent(event);
    return;
  }
  if (event.type === 'session_closed' && event.reason === 'displaced') {
    if (voiceCallStore.state.sessionId === event.sessionId) {
      voiceCallStore.handleServerEvent({ type: 'call_ended', sessionId: event.sessionId, reason: 'displaced' });
    }
  }
});
