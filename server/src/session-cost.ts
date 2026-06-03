/**
 * Pure cost summation helper for the per-session lifetime dollar cost surfaced
 * in the pimote StatusBar. No I/O, no SDK session coupling beyond a structural
 * (duck-typed) view of the session branch entries.
 *
 * See docs/plans/cost-accumulation.md.
 */

/**
 * Structural view of the session entries this helper consumes. Mirrors the
 * duck-typed approach in message-mapper.ts (SdkSessionEntry) — only the fields
 * needed are declared.
 */
export interface CostBranchEntry {
  /** 'message' | 'compaction' | ... ; only 'message' contributes. */
  type: string;
  message?: {
    /** only 'assistant' contributes */
    role?: string;
    usage?: { cost?: { total?: number } };
  };
}

/**
 * Sum usage.cost.total over assistant message entries in the branch.
 * - Skips non-'message' entries (compaction, model-change, labels, etc.).
 * - Skips non-assistant messages (user, toolResult).
 * - Missing/undefined usage or cost contributes 0.
 * - Returns a finite number >= 0. Empty branch => 0.
 */
export function sumAssistantCostUsd(entries: CostBranchEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    if (entry.message?.role !== 'assistant') continue;
    total += entry.message.usage?.cost?.total ?? 0;
  }
  return total;
}
