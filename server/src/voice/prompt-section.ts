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

/**
 * Mirror the call lifecycle into the desired prompt sections. `dormant`
 * removes the section (pi emits a `{ voice: null }` delta); `activating` and
 * `active` (re)assert it. Pure — mutates only the passed sections record.
 */
export function applyVoicePromptSection(sections: Record<string, string>, lifecycle: LifecycleState['kind'], interpreterPrompt: string): void {
  if (lifecycle === 'dormant') {
    delete sections[VOICE_PROMPT_SECTION];
  } else {
    sections[VOICE_PROMPT_SECTION] = interpreterPrompt;
  }
}
