import { describe, it, expect } from 'vitest';
import { applyVoicePromptSection, VOICE_PROMPT_SECTION } from './prompt-section.js';

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

  it('removes the voice section when dormant', () => {
    const sections: Record<string, string> = { [VOICE_PROMPT_SECTION]: PROMPT };
    applyVoicePromptSection(sections, 'dormant', PROMPT);
    expect(VOICE_PROMPT_SECTION in sections).toBe(false);
  });

  it('is a no-op when dormant with no section present', () => {
    const sections: Record<string, string> = {};
    applyVoicePromptSection(sections, 'dormant', PROMPT);
    expect(sections).toEqual({});
  });

  it('leaves unrelated sections untouched', () => {
    const sections: Record<string, string> = { preamble: 'base' };
    applyVoicePromptSection(sections, 'active', PROMPT);
    expect(sections.preamble).toBe('base');
    applyVoicePromptSection(sections, 'dormant', PROMPT);
    expect(sections.preamble).toBe('base');
  });
});
