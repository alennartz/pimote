import { describe, expect, it } from 'vitest';
import { statusRowSpacerClass } from './status-bar-layout.js';

describe('statusRowSpacerClass', () => {
  it('keeps a mobile-only spacer when the session title moves to row 2', () => {
    expect(statusRowSpacerClass(true)).toBe('flex-1 md:hidden');
  });

  it('uses the full spacer when there is no session title yet', () => {
    expect(statusRowSpacerClass(false)).toBe('flex-1');
  });
});
