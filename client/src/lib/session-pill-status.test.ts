import { describe, expect, it } from 'vitest';
import { getSessionPillIconColor } from './session-pill-status.js';

describe('getSessionPillIconColor', () => {
  it('keeps a working session green when a stale attention flag remains set', () => {
    expect(getSessionPillIconColor({ status: 'working', needsAttention: true }, false)).toBe('text-emerald-500');
  });

  it('keeps pending UI orange while the session is working', () => {
    expect(getSessionPillIconColor({ status: 'working', needsAttention: false }, true)).toBe('text-orange-500');
  });

  it('shows attention orange after a session settles', () => {
    expect(getSessionPillIconColor({ status: 'idle', needsAttention: true }, false)).toBe('text-orange-500');
  });

  it('inherits the chip color for an idle session without attention', () => {
    expect(getSessionPillIconColor({ status: 'idle', needsAttention: false }, false)).toBe('');
  });
});
