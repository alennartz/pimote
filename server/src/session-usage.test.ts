import { describe, expect, it } from 'vitest';
import type { SessionEntry, SessionStats } from '@earendil-works/pi-coding-agent';
import { projectSessionUsage } from './session-usage.js';

const makeUsage = (
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number },
  tokens = {
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    totalTokens: 100,
  },
) => ({
  ...tokens,
  cost,
});

const makeEntry = (id: string, value: Record<string, unknown>): SessionEntry =>
  ({ id, parentId: null, timestamp: '2026-01-01T00:00:00.000Z', ...value }) as unknown as SessionEntry;

const stats = (tokens: SessionStats['tokens']): Pick<SessionStats, 'tokens'> => ({ tokens });

describe('projectSessionUsage', () => {
  it('keeps Pi token totals and folds category costs from every usage-bearing entry', () => {
    const entries = [
      makeEntry('assistant', {
        type: 'message',
        message: { role: 'assistant', usage: makeUsage({ input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 }) },
      }),
      makeEntry('tool-result', {
        type: 'message',
        message: { role: 'toolResult', usage: makeUsage({ input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 }) },
      }),
      makeEntry('compaction', {
        type: 'compaction',
        usage: makeUsage({ input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 }),
      }),
      makeEntry('branch-summary', {
        type: 'branch_summary',
        summary: 'summary',
        fromId: 'assistant',
        usage: makeUsage({ input: 0.0001, output: 0.0002, cacheRead: 0.0003, cacheWrite: 0.0004, total: 0.001 }),
      }),
      makeEntry('usage-entry', {
        type: 'usage',
        kind: 'cache_warm',
        provider: 'provider',
        model: 'model',
        usage: makeUsage({ input: 0.00001, output: 0.00002, cacheRead: 0.00003, cacheWrite: 0.00004, total: 0.0001 }),
      }),
      makeEntry('user', {
        type: 'message',
        message: { role: 'user', usage: makeUsage({ input: 99, output: 99, cacheRead: 99, cacheWrite: 99, total: 99 }) },
      }),
      makeEntry('model-change', { type: 'model_change', provider: 'provider', modelId: 'model' }),
    ];
    const tokenTotals = { input: 101, output: 202, cacheRead: 303, cacheWrite: 404, total: 1010 };

    const result = projectSessionUsage(entries, stats(tokenTotals));

    expect(result.tokens).toEqual(tokenTotals);
    expect(result.cost.input).toBeCloseTo(0.11111, 12);
    expect(result.cost.output).toBeCloseTo(0.22222, 12);
    expect(result.cost.cacheRead).toBeCloseTo(0.33333, 12);
    expect(result.cost.cacheWrite).toBeCloseTo(0.44444, 12);
    expect(result.cost).not.toHaveProperty('total');
  });

  it('returns zero category costs for an empty persisted history', () => {
    const tokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

    expect(projectSessionUsage([], stats(tokenTotals))).toEqual({
      tokens: tokenTotals,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });
});
