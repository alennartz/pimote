// Voice extension activation state machine.
//
// Defined in docs/plans/voice-mode.md — "Voice extension" section under
// "Interfaces". The state machine is driven by EventBus messages from the
// server-side VoiceOrchestrator.

export type VoiceExtensionState = 'dormant' | 'activating' | 'active' | 'deactivating';

/** Session-scoped EventBus message that activates the voice extension. */
export interface VoiceActivateMessage {
  type: 'pimote:voice:activate';
  sessionId: string;
  speechmuxWsUrl: string;
  callToken: string;
}

/** Session-scoped EventBus message that deactivates the voice extension. */
export interface VoiceDeactivateMessage {
  type: 'pimote:voice:deactivate';
  sessionId: string;
}

/** Sentinel user message appended on entry to the `active` state. */
export const VOICE_CALL_STARTED_SENTINEL = '<voice_call_started/>';
