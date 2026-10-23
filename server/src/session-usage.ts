import type { SessionStats, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { PimoteUsageBreakdown } from '../../shared/dist/index.js';

interface CostTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const COST_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function usageForEntry(entry: SessionEntry): unknown {
  switch (entry.type) {
    case 'message':
      return entry.message.role === 'assistant' || entry.message.role === 'toolResult' ? entry.message.usage : undefined;
    case 'compaction':
    case 'branch_summary':
    case 'usage':
      return entry.usage;
    default:
      return undefined;
  }
}

function addUsageCost(totals: CostTotals, usage: unknown): void {
  if (!usage || typeof usage !== 'object' || !('cost' in usage)) return;
  const cost = usage.cost;
  if (!cost || typeof cost !== 'object') return;

  for (const key of COST_KEYS) {
    const value = (cost as Record<string, unknown>)[key];
    if (isFiniteNonNegative(value)) totals[key] += value;
  }
}

/**
 * Project persisted usage into the category breakdown shown by Pimote.
 *
 * Pi's SessionStats.tokens remain authoritative for token totals. This seam
 * only folds category dollars from every usage-bearing persisted entry.
 */
export function projectSessionUsage(entries: readonly SessionEntry[], stats: Pick<SessionStats, 'tokens'>): PimoteUsageBreakdown {
  const cost: CostTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const entry of entries) addUsageCost(cost, usageForEntry(entry));

  return {
    tokens: { ...stats.tokens },
    cost,
  };
}
