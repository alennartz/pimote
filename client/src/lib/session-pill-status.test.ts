import { describe, expect, it } from 'vitest';
import { getSessionPillIconColor } from './session-pill-status.js';

describe('getSessionPillIconColor', () => {
  it('keeps a working session in its streaming theme role when a stale attention flag remains set', () => {
    expect(getSessionPillIconColor({ status: 'working', needsAttention: true }, false)).toBe('text-status-streaming');
  });

  it('uses the theme warning role for pending UI while the session is working', () => {
    expect(getSessionPillIconColor({ status: 'working', needsAttention: false }, true)).toBe('text-status-reconnecting');
  });

  it('uses the theme warning role for attention after a session settles', () => {
    expect(getSessionPillIconColor({ status: 'idle', needsAttention: true }, false)).toBe('text-status-reconnecting');
  });

  it('inherits the chip color for an idle session without attention', () => {
    expect(getSessionPillIconColor({ status: 'idle', needsAttention: false }, false)).toBe('');
  });
});
