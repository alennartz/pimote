import { describe, it, expect } from 'vitest';
import { needsDraftPrompt, applyDraftChoice } from './draft-policy.js';

describe('needsDraftPrompt', () => {
  it('returns false when current draft is empty', () => {
    expect(needsDraftPrompt('', 'selected text')).toBe(false);
  });

  it('returns false when selectedText is undefined', () => {
    expect(needsDraftPrompt('existing draft', undefined)).toBe(false);
  });

  it('returns false when selectedText is empty string', () => {
    expect(needsDraftPrompt('existing draft', '')).toBe(false);
  });

  it('returns true when both currentDraft and selectedText are non-empty', () => {
    expect(needsDraftPrompt('existing draft', 'forked message text')).toBe(true);
  });

  it('returns false when both are empty', () => {
    expect(needsDraftPrompt('', '')).toBe(false);
  });

  it('returns false when draft is whitespace-only', () => {
    expect(needsDraftPrompt('   ', 'selected text')).toBe(false);
  });
});

describe('applyDraftChoice', () => {
  const currentDraft = 'existing draft content';
  const selectedText = 'forked message text';

  it('returns selectedText for replace choice', () => {
    expect(applyDraftChoice(currentDraft, selectedText, 'replace')).toBe('forked message text');
  });

  it('appends selectedText after current draft with newline separator', () => {
    expect(applyDraftChoice(currentDraft, selectedText, 'append')).toBe('existing draft content\nforked message text');
  });

  it('prepends selectedText before current draft with newline separator', () => {
    expect(applyDraftChoice(currentDraft, selectedText, 'prepend')).toBe('forked message text\nexisting draft content');
  });

  it('returns null for ignore choice', () => {
    expect(applyDraftChoice(currentDraft, selectedText, 'ignore')).toBeNull();
  });
});
