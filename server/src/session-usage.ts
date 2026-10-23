import type { SessionStats, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { PimoteUsageBreakdown } from '../../shared/dist/index.js';

/**
 * Project persisted usage into the category breakdown shown by Pimote.
 *
 * Pi's SessionStats.tokens remain authoritative for token totals. This seam
 * only folds category dollars from every usage-bearing persisted entry.
 */
export function projectSessionUsage(_entries: readonly SessionEntry[], _stats: Pick<SessionStats, 'tokens'>): PimoteUsageBreakdown {
  throw new Error('not implemented');
}
