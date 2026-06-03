import { describe, it, expect } from 'vitest';
import { formatSessionCost } from './session-summary.js';

describe('formatSessionCost', () => {
  describe('no-spend sentinel', () => {
    it('returns null for exactly 0', () => {
      expect(formatSessionCost(0)).toBeNull();
    });

    it('returns null for a negative value (should not occur)', () => {
      expect(formatSessionCost(-1.5)).toBeNull();
    });
  });

  describe('sub-cent spend', () => {
    it('renders "<$0.01" for a value between 0 and one cent', () => {
      expect(formatSessionCost(0.004)).toBe('<$0.01');
    });

    it('renders "<$0.01" for a very small positive value', () => {
      expect(formatSessionCost(0.0001)).toBe('<$0.01');
    });
  });

  describe('cent-and-above spend', () => {
    it('renders exactly one cent as "$0.01"', () => {
      expect(formatSessionCost(0.01)).toBe('$0.01');
    });

    it('renders a few cents with two decimal places', () => {
      expect(formatSessionCost(0.04)).toBe('$0.04');
    });

    it('renders dollars-and-cents with two decimal places', () => {
      expect(formatSessionCost(1.23)).toBe('$1.23');
    });

    it('rounds to two decimal places', () => {
      // Rounding mode is the implementer's call; toFixed(2) rounds half up here.
      expect(formatSessionCost(1.235)).toBe('$1.24');
    });

    it('pads whole-dollar amounts to two decimal places', () => {
      expect(formatSessionCost(12)).toBe('$12.00');
    });
  });
});
