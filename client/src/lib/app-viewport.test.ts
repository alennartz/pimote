import { describe, expect, it } from 'vitest';
import { resolveAppViewportHeight } from './app-viewport.js';

describe('resolveAppViewportHeight', () => {
  it('prefers visualViewport height when available', () => {
    expect(
      resolveAppViewportHeight({
        innerHeight: 844,
        visualViewport: { height: 612.4 },
      }),
    ).toBe('612px');
  });

  it('falls back to innerHeight when visualViewport is missing', () => {
    expect(resolveAppViewportHeight({ innerHeight: 844, visualViewport: null })).toBe('844px');
  });

  it('falls back to innerHeight when visualViewport height is invalid', () => {
    expect(
      resolveAppViewportHeight({
        innerHeight: 844,
        visualViewport: { height: 0 },
      }),
    ).toBe('844px');
  });
});
