import { describe, expect, it } from 'vitest';
import { getSessionPillIconColor } from './session-pill-status.js';

describe('getSessionPillIconColor', () => {
  it('keeps a working session in its streaming theme role when a stale attention flag remains set', () => {
    expect(getSessionPillIconColor({ status: 'working', needsAttention: true }, false, false)).toBe('text-status-streaming');
  });

  it('uses the theme warning role for pending UI while the session is working', () => {
    expect(getSessionPillIconColor({ status: 'working', needsAttention: false }, true, false)).toBe('text-status-reconnecting');
  });

  it('uses the theme warning role for attention after a session settles', () => {
    expect(getSessionPillIconColor({ status: 'idle', needsAttention: true }, false, false)).toBe('text-status-reconnecting');
  });

  it('uses the on-primary role for a working selected session', () => {
    expect(getSessionPillIconColor({ status: 'working', needsAttention: false }, false, true)).toBe('text-status-streaming-on-primary');
  });

  it('uses the on-primary warning role for attention on a selected session', () => {
    expect(getSessionPillIconColor({ status: 'idle', needsAttention: true }, false, true)).toBe('text-status-reconnecting-on-primary');
  });

  it('uses the on-primary warning role for pending UI on a selected session', () => {
    expect(getSessionPillIconColor({ status: 'working', needsAttention: false }, true, true)).toBe('text-status-reconnecting-on-primary');
  });

  it('inherits the chip color for an idle session without attention', () => {
    expect(getSessionPillIconColor({ status: 'idle', needsAttention: false }, false, false)).toBe('');
  });
});
