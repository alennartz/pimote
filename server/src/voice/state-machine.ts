// Voice extension activation state machine.
//
// Defined in docs/plans/voice-mode.md — "Voice extension" section under
// "Interfaces". The state machine is driven by EventBus messages from the
// server-side VoiceOrchestrator.

/**
 * Runtime state of the voice extension instance.
 *
 * Two states only: `dormant` (no call) and `active` (a call is bound). The
 * extension transitions to `active` the moment a `voice:activate` message
 * arrives, before the speechmux WS has finished opening, so the interpreter
 * LLM turn that produces the greeting can run in parallel with the WS
 * handshake ("pre-warm"). Speak tokens emitted while the WS is still
 * connecting are buffered in the wiring layer and flushed on open.
 *
 * Deactivation is synchronous (close WS, clear watermark and pending
 * buffer) so no transient `'deactivating'` state is needed.
 */
export type VoiceExtensionState = 'dormant' | 'active';

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
