// Voice system-prompt section management (pi 0.87+ structured prompt).
//
// Voice's interpreter instructions are carried as a named prompt section
// ('voice') that pi diffs against the transcript-replayed sections and
// persists as SystemMessage deltas. This replaces the pre-0.87 forced-prompt
// approach (returning `{ systemPrompt }` from before_agent_start), which
// rewrote the whole prompt every run and diverged from the recorded transcript
// across resume and branch navigation.

import type { LifecycleState } from './fsm/state.js';

/** Prompt section name carrying the interpreter instructions while a call is bound. */
export const VOICE_PROMPT_SECTION = 'voice';

/** Replacement state for the voice section after a call ends. */
export const VOICE_CALL_ENDED_PROMPT = 'The voice call has ended. Resume normal text interaction. Disregard all earlier voice-mode instructions and do not attempt to speak aloud.';

/**
 * Mirror the call lifecycle into the desired prompt sections. Keep the named
 * section after deactivation and replace its contents with an explicit end
 * state. Pi records section changes as append-only system deltas, so replacing
 * the section tells the model to stop following the earlier voice state
 * without relying on a removal marker.
 */
export function applyVoicePromptSection(sections: Record<string, string>, lifecycle: LifecycleState['kind'], interpreterPrompt: string): void {
  sections[VOICE_PROMPT_SECTION] = lifecycle === 'dormant' ? VOICE_CALL_ENDED_PROMPT : interpreterPrompt;
}
