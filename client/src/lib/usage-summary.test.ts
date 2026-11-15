import { describe, expect, it } from 'vitest';
import { formatCacheHitRate } from './usage-summary.js';

describe('formatCacheHitRate', () => {
  it('reports cached reads as a share of all prompt tokens', () => {
    expect(formatCacheHitRate({ input: 500, cacheRead: 50, cacheWrite: 100 })).toBe('7.7%');
  });

  it('keeps one decimal place when the rate is fractional', () => {
    expect(formatCacheHitRate({ input: 101, cacheRead: 303, cacheWrite: 404 })).toBe('37.5%');
  });

  it('reports zero hits when tokens were written but none were read', () => {
    expect(formatCacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 12 })).toBe('0%');
  });

  it('omits the rate when no cache tokens or prompt tokens exist', () => {
    expect(formatCacheHitRate({ input: 10, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(formatCacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });

  it('omits invalid token totals', () => {
    expect(formatCacheHitRate({ input: -1, cacheRead: 2, cacheWrite: 0 })).toBeNull();
    expect(formatCacheHitRate({ input: Number.NaN, cacheRead: 2, cacheWrite: 0 })).toBeNull();
  });
});
