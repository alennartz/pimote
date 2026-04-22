// Voice extension activation state machine.
//
// Defined in docs/plans/voice-mode.md — "Voice extension" section under
// "Interfaces". The state machine is driven by EventBus messages from the
// server-side VoiceOrchestrator.

/**
 * Runtime state of the voice extension instance.
 *
 * Deactivation is synchronous (close WS, clear watermark) so no transient
 * `'deactivating'` state is needed; `reduceDeactivate` moves `active` or
 * `activating` straight to `dormant`.
 */
export type VoiceExtensionState = 'dormant' | 'activating' | 'active';

/** Session-scoped EventBus message that activates the voice extension. */
export interface VoiceActivateMessage {
  type: 'pimote:voice:activate';
  sessionId: string;
  speechmuxWsUrl: string;
}

/** Session-scoped EventBus message that deactivates the voice extension. */
export interface VoiceDeactivateMessage {
  type: 'pimote:voice:deactivate';
  sessionId: string;
}

/** Sentinel user message appended on entry to the `active` state. */
export const VOICE_CALL_STARTED_SENTINEL = '<voice_call_started/>';
