import { describe, expect, it } from 'vitest';
import { countThinkingWords, createThinkingWordCounter, previewThinkingText, shouldRenderThinkingBlock } from './thinking-content.js';

describe('previewThinkingText', () => {
  it('returns at most the requested number of words with normalized spacing', () => {
    expect(previewThinkingText('  first   second third fourth fifth sixth seventh eighth ninth  ')).toBe('first second third fourth fifth sixth seventh eighth');
    expect(previewThinkingText('one two three', 2)).toBe('one two');
  });

  it('returns an empty preview for empty or whitespace-only text', () => {
    expect(previewThinkingText('')).toBe('');
    expect(previewThinkingText(' \n\t ')).toBe('');
  });
});

describe('createThinkingWordCounter', () => {
  it('counts words across appended chunks without losing split word boundaries', () => {
    const count = createThinkingWordCounter();
    expect(count('First wor')).toBe(2);
    expect(count('First word continues')).toBe(3);
    expect(count('First word continues\nnext')).toBe(4);
  });

  it('recounts when the stream text is replaced with a shorter value', () => {
    const count = createThinkingWordCounter();
    expect(count('one two three four')).toBe(4);
    expect(count('one two')).toBe(2);
  });
});

describe('countThinkingWords', () => {
  it('counts whitespace-separated words without counting empty segments', () => {
    expect(countThinkingWords('  one   two\nthree\t')).toBe(3);
    expect(countThinkingWords('')).toBe(0);
    expect(countThinkingWords(' \n\t ')).toBe(0);
  });
});

describe('shouldRenderThinkingBlock', () => {
  it('hides empty or whitespace-only reasoning after its stream closes', () => {
    expect(shouldRenderThinkingBlock('', false)).toBe(false);
    expect(shouldRenderThinkingBlock(' \n\t ', false)).toBe(false);
  });

  it('keeps an empty reasoning block visible while it may still receive text', () => {
    expect(shouldRenderThinkingBlock('', true)).toBe(true);
  });

  it('shows completed reasoning that contains text', () => {
    expect(shouldRenderThinkingBlock('Working through the options.', false)).toBe(true);
  });
});
