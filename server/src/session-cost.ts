import type { SessionEntry } from '@earendil-works/pi-coding-agent';

/**
 * Sum persisted billed work across a complete session history.
 *
 * The caller supplies getEntries(), not the current branch, so the fold covers
 * every persisted branch exactly once. Assistant messages, compactions, and
 * branch summaries each retain the usage from their respective LLM call. Every
 * other entry, and missing, non-finite, or negative costs, contributes zero.
 */
export function sumLifetimeCostUsd(entries: SessionEntry[]): number {
  let total = 0;

  for (const entry of entries) {
    const cost =
      entry.type === 'message'
        ? entry.message.role === 'assistant'
          ? entry.message.usage?.cost?.total
          : undefined
        : entry.type === 'compaction' || entry.type === 'branch_summary'
          ? entry.usage?.cost?.total
          : undefined;

    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
      total += cost;
    }
  }

  return total;
}
