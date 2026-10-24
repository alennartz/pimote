import { describe, expect, it } from 'vitest';
import { isSessionOpenCancelledResponse } from './session-open-response.js';

describe('isSessionOpenCancelledResponse', () => {
  it('matches only the failed client cancellation response', () => {
    expect(isSessionOpenCancelledResponse({ success: false, error: 'session_open_cancelled' })).toBe(true);
    expect(isSessionOpenCancelledResponse({ success: false, error: 'session_open_failed' })).toBe(false);
    expect(isSessionOpenCancelledResponse({ success: false })).toBe(false);
    expect(isSessionOpenCancelledResponse({ success: true, error: 'session_open_cancelled' })).toBe(false);
  });
});
