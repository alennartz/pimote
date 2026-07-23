import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { sumLifetimeCostUsd } from './session-cost.js';

describe('sumLifetimeCostUsd', () => {
  it('includes persisted assistant, compaction, and branch-summary cost exactly once', () => {
    const entries = [
      { type: 'message', message: { role: 'assistant', usage: { cost: { total: 0.1 } } } },
      { type: 'compaction', usage: { cost: { total: 0.2 } } },
      { type: 'branch_summary', usage: { cost: { total: 0.3 } } },
    ] as unknown as SessionEntry[];

    expect(sumLifetimeCostUsd(entries)).toBeCloseTo(0.6, 10);
  });

  it('skips absent, invalid, and non-cost-bearing entries without changing valid spend', () => {
    const entries = [
      { type: 'message', message: { role: 'assistant', usage: { cost: { total: 0.1 } } } },
      { type: 'compaction' },
      { type: 'branch_summary', usage: { cost: { total: Number.NaN } } },
      { type: 'branch_summary', usage: { cost: { total: -0.2 } } },
      { type: 'message', message: { role: 'user', usage: { cost: { total: 99 } } } },
      { type: 'model_change', usage: { cost: { total: 99 } } },
    ] as unknown as SessionEntry[];

    expect(sumLifetimeCostUsd(entries)).toBeCloseTo(0.1, 10);
  });
});
