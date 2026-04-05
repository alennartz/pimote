import { describe, it, expect } from 'vitest';
import { shouldOpenSessionPillActions } from './session-pill-gesture.js';

describe('shouldOpenSessionPillActions', () => {
  it('returns true for a clear upward swipe', () => {
    expect(shouldOpenSessionPillActions(4, -24)).toBe(true);
  });

  it('returns false when upward movement is below threshold', () => {
    expect(shouldOpenSessionPillActions(0, -10)).toBe(false);
  });

  it('returns false when horizontal movement dominates', () => {
    expect(shouldOpenSessionPillActions(30, -18)).toBe(false);
  });

  it('returns false for downward movement', () => {
    expect(shouldOpenSessionPillActions(0, 24)).toBe(false);
  });
});
