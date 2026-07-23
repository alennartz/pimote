/**
 * Pure cost summation helper for the per-session lifetime dollar cost surfaced
 * in the pimote StatusBar. No I/O, no SDK session coupling beyond a structural
 * (duck-typed) view of the session entries.
 *
 * Callers pass the session manager's full entry log (getEntries()), so the
 * figure spans ALL branches in the session file — not just the current leaf's
 * branch. Because it is a pure fold recomputed on every get_session_meta call,
 * it is correct across live session switches and reload-from-disk without any
 * stateful accumulator: the session manager rehydrates every entry from the
 * JSONL on load, and the sum is derived fresh from those entries.
 *
 * What this figure CAPTURES:
 * - Every assistant turn across every branch, counted exactly once (branching
 *   is append-only, so prior turns are never duplicated).
 * - Tool-call token cost: a tool result is billed as input on the FOLLOWING
 *   assistant turn, so it is already inside that turn's usage.cost.total. The
 *   toolResult/user entries themselves carry no usage and are correctly skipped.
 * - Cache-aware pricing: usage.cost.total is pi's pre-computed dollar amount
 *   that already prices input/output/cacheRead/cacheWrite at their own model
 *   rates. We sum total, so we inherit cache pricing rather than re-deriving it.
 *
 * What this figure EXCLUDES (cannot be recovered from the session file):
 * - Compaction and branch-summary LLM calls. Those are billed API calls, but
 *   CompactionEntry / BranchSummaryEntry carry no usage/cost field, so their
 *   spend is invisible here.
 * - Any assistant turn whose provider did not populate usage.cost.total (e.g. a
 *   model with no pricing metadata): that turn contributes 0 (silent undercount).
 *
 * See docs/plans/cost-accumulation.md and docs/reviews/codebase-audit.md.
 */

import type { SessionEntry } from '@earendil-works/pi-coding-agent';

/**
 * The real session-entry union this helper consumes (from getEntries()).
 * Retained as a named alias for callers/tests that referenced the old
 * duck-typed name.
 */
export type CostBranchEntry = SessionEntry;

/**
 * Sum persisted cost-bearing usage across a session's complete entry history.
 *
 * This interface stub deliberately remains unimplemented until the Pi 0.81
 * migration materializes the new compaction and branch-summary usage fields.
 */
export function sumLifetimeCostUsd(_entries: SessionEntry[]): number {
  throw new Error('not implemented');
}

/**
 * Sum usage.cost.total over assistant message entries in the branch.
 * - Skips non-'message' entries (compaction, model-change, labels, etc.).
 * - Skips non-assistant messages (user, toolResult).
 * - Missing/undefined usage or cost contributes 0.
 * - Returns a finite number >= 0. Empty branch => 0.
 *
 * The optional chaining below is deliberate despite AssistantMessage typing
 * usage/cost as required: some providers ship assistant turns with no pricing
 * metadata, so the fields are absent at runtime (see the excludes note above).
 */
export function sumAssistantCostUsd(entries: SessionEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message?.role !== 'assistant') continue;
    total += message.usage?.cost?.total ?? 0;
  }
  return total;
}
