import { describe, it, expect } from 'vitest';
import { applyVoicePromptSection, VOICE_CALL_ENDED_PROMPT, VOICE_PROMPT_SECTION } from './prompt-section.js';

const PROMPT = 'You are a voice interpreter…';

describe('applyVoicePromptSection', () => {
  it('asserts the voice section while activating', () => {
    const sections: Record<string, string> = {};
    applyVoicePromptSection(sections, 'activating', PROMPT);
    expect(sections[VOICE_PROMPT_SECTION]).toBe(PROMPT);
  });

  it('asserts the voice section while active', () => {
    const sections: Record<string, string> = {};
    applyVoicePromptSection(sections, 'active', PROMPT);
    expect(sections[VOICE_PROMPT_SECTION]).toBe(PROMPT);
  });

  it('replaces voice instructions with the ended-call state when dormant', () => {
    const sections: Record<string, string> = { [VOICE_PROMPT_SECTION]: PROMPT };
    applyVoicePromptSection(sections, 'dormant', PROMPT);
    expect(sections).toEqual({ [VOICE_PROMPT_SECTION]: VOICE_CALL_ENDED_PROMPT });
  });

  it('asserts the ended-call state when dormant with no prior section', () => {
    const sections: Record<string, string> = {};
    applyVoicePromptSection(sections, 'dormant', PROMPT);
    expect(sections).toEqual({ [VOICE_PROMPT_SECTION]: VOICE_CALL_ENDED_PROMPT });
  });

  it('leaves unrelated sections untouched', () => {
    const sections: Record<string, string> = { preamble: 'base' };
    applyVoicePromptSection(sections, 'active', PROMPT);
    expect(sections.preamble).toBe('base');
    applyVoicePromptSection(sections, 'dormant', PROMPT);
    expect(sections.preamble).toBe('base');
    expect(sections[VOICE_PROMPT_SECTION]).toBe(VOICE_CALL_ENDED_PROMPT);
  });
});
