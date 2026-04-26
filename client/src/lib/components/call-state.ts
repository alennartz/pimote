// Pure helpers for the calling-mode UI. Extracted from the Svelte components
// so they can be unit-tested without mounting Svelte. See
// docs/plans/voice-call-fullscreen-ui.md → Architecture → Interfaces.

/** Discrete agent state surfaced in the call header pulse. */
export type AgentState = 'listening' | 'thinking' | 'speaking';

export interface DeriveAgentStateArgs {
  /** Whether the worker LLM is mid-stream (e.g. `sessionRegistry.viewed.isStreaming`). */
  isStreaming: boolean;
  /** Inbound audio level from the WebRTC peer, 0..1. */
  remoteAudioLevel: number;
  /** Threshold above which `remoteAudioLevel` is considered audible. */
  speakingThreshold: number;
}

/**
 * Derive the discrete `AgentState` from observable signals.
 *
 *   remoteAudioLevel > threshold → 'speaking'
 *   else if isStreaming          → 'thinking'
 *   else                         → 'listening'
 *
 * `speaking` wins over `thinking` because the user is actually hearing
 * audio — that's the strongest signal we can show.
 */
export function deriveAgentState(args: DeriveAgentStateArgs): AgentState {
  if (args.remoteAudioLevel > args.speakingThreshold) return 'speaking';
  if (args.isStreaming) return 'thinking';
  return 'listening';
}

/**
 * Format an elapsed-call duration as `MM:SS` (or `H:MM:SS` past one hour).
 *
 * - Negative values clamp to 0 (defensive against clock skew).
 * - Sub-second remainders are truncated, not rounded — feels less jumpy.
 */
export function formatCallDuration(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const ss = String(seconds).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  if (hours > 0) return `${hours}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}
