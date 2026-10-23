import { describe, expect, it } from 'vitest';
import { summarizeCostDisclosure } from './cost-disclosure.js';

const breakdown = (known: number) => ({
  tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  cost: { input: known, output: 0, cacheRead: 0, cacheWrite: 0 },
});

describe('summarizeCostDisclosure', () => {
  it.each([undefined, null, 0, -1, NaN, Infinity, -Infinity])('hides invalid or nonpositive total %s', (total) => {
    expect(summarizeCostDisclosure(total)).toBeNull();
  });
  it.each([
    [0.0001, '<$0.01'],
    [0.0099, '<$0.01'],
    [0.01, '$0.01'],
    [1.234, '$1.23'],
  ])('formats reported total %s', (total, label) => {
    expect(summarizeCostDisclosure(total as number)?.label).toBe(label);
  });
  it.each([0.99, 1, 1.01])('ignores category differences of one cent or less: %s', (known) => {
    expect(summarizeCostDisclosure(1, breakdown(known))).toEqual({ label: '$1.00', unknownCostUsd: null, inconsistent: false });
  });
  it('shows only a positive remainder greater than one cent', () => {
    expect(summarizeCostDisclosure(1, breakdown(0.98))).toEqual({ label: '$1.00', unknownCostUsd: expect.closeTo(0.02, 12), inconsistent: false });
  });
  it('marks an overage inconsistent without creating negative Unknown or changing the total', () => {
    expect(summarizeCostDisclosure(1, breakdown(1.02))).toEqual({ label: '$1.00', unknownCostUsd: null, inconsistent: true });
  });
  it('keeps older-server totals visible without inventing a category breakdown', () => {
    expect(summarizeCostDisclosure(2)).toEqual({ label: '$2.00', unknownCostUsd: null, inconsistent: false });
  });
});
