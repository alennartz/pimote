import { describe, expect, it } from 'vitest';
import { shouldRenderThinkingBlock } from './thinking-content.js';

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
