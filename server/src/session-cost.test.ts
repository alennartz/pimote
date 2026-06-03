import { describe, it, expect } from 'vitest';
import { sumAssistantCostUsd, type CostBranchEntry } from './session-cost.js';

// Helpers to build branch entries without repeating the nested shape.
function assistant(total: number | undefined): CostBranchEntry {
  return { type: 'message', message: { role: 'assistant', usage: { cost: { total } } } };
}

function user(total: number): CostBranchEntry {
  return { type: 'message', message: { role: 'user', usage: { cost: { total } } } };
}

describe('sumAssistantCostUsd', () => {
  describe('empty / trivial inputs', () => {
    it('returns 0 for an empty branch', () => {
      expect(sumAssistantCostUsd([])).toBe(0);
    });

    it('returns 0 when the branch has only non-assistant entries', () => {
      const branch: CostBranchEntry[] = [user(0.5), { type: 'message', message: { role: 'toolResult', usage: { cost: { total: 0.25 } } } }, { type: 'compaction' }];
      expect(sumAssistantCostUsd(branch)).toBe(0);
    });
  });

  describe('summation over assistant entries', () => {
    it('sums usage.cost.total across assistant message entries', () => {
      const branch = [assistant(0.01), assistant(0.02)];
      expect(sumAssistantCostUsd(branch)).toBeCloseTo(0.03, 10);
    });

    it('returns a single assistant entry cost unchanged', () => {
      expect(sumAssistantCostUsd([assistant(1.23)])).toBeCloseTo(1.23, 10);
    });

    it('counts only assistant entries, ignoring user and toolResult messages', () => {
      const branch: CostBranchEntry[] = [user(0.5), assistant(0.1), { type: 'message', message: { role: 'toolResult', usage: { cost: { total: 0.9 } } } }, assistant(0.2)];
      expect(sumAssistantCostUsd(branch)).toBeCloseTo(0.3, 10);
    });

    it('ignores non-message entries (compaction, model-change, labels)', () => {
      const branch: CostBranchEntry[] = [
        { type: 'compaction', message: { role: 'assistant', usage: { cost: { total: 5 } } } },
        { type: 'model-change' },
        { type: 'label' },
        assistant(0.05),
      ];
      expect(sumAssistantCostUsd(branch)).toBeCloseTo(0.05, 10);
    });
  });

  describe('missing / malformed cost data', () => {
    it('treats an assistant entry with no usage as contributing 0', () => {
      const branch: CostBranchEntry[] = [{ type: 'message', message: { role: 'assistant' } }, assistant(0.07)];
      expect(sumAssistantCostUsd(branch)).toBeCloseTo(0.07, 10);
    });

    it('treats an assistant entry with usage but no cost as contributing 0', () => {
      const branch: CostBranchEntry[] = [{ type: 'message', message: { role: 'assistant', usage: {} } }, assistant(0.07)];
      expect(sumAssistantCostUsd(branch)).toBeCloseTo(0.07, 10);
    });

    it('treats an assistant entry with cost but no total as contributing 0', () => {
      expect(sumAssistantCostUsd([assistant(undefined)])).toBe(0);
    });

    it('does not throw on a message entry with no message field', () => {
      const branch: CostBranchEntry[] = [{ type: 'message' }, assistant(0.02)];
      expect(sumAssistantCostUsd(branch)).toBeCloseTo(0.02, 10);
    });
  });

  describe('contract guarantees', () => {
    it('returns a finite number >= 0', () => {
      const result = sumAssistantCostUsd([assistant(0.01), assistant(0.02), user(99)]);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    });

    it('counts pre-compaction assistant entries that remain on the branch (monotonic across compaction)', () => {
      const branch: CostBranchEntry[] = [
        assistant(0.1), // pre-compaction
        assistant(0.2), // pre-compaction
        { type: 'compaction' },
        assistant(0.05), // post-compaction
      ];
      expect(sumAssistantCostUsd(branch)).toBeCloseTo(0.35, 10);
    });
  });
});
