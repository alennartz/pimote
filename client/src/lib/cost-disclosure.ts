import type { PimoteUsageBreakdown } from '@pimote/shared';

export interface CostDisclosure {
  label: string;
  unknownCostUsd: number | null;
  inconsistent: boolean;
}

const CENT = 0.01;

function exceedsCentTolerance(value: number, scale: number): boolean {
  // Floating-point subtraction can turn an exact one-cent difference into a
  // value a few ulps above 0.01. Keep the product tolerance at one cent while
  // allowing that representation noise at the threshold.
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(scale)) * 8;
  return value > CENT + epsilon;
}

/** Format a reported total and compare category costs without replacing that total. */
export function summarizeCostDisclosure(totalCostUsd: number | null | undefined, breakdown?: PimoteUsageBreakdown): CostDisclosure | null {
  if (totalCostUsd == null || !Number.isFinite(totalCostUsd) || totalCostUsd <= 0) return null;

  const label = totalCostUsd < CENT ? '<$0.01' : `$${totalCostUsd.toFixed(2)}`;
  if (!breakdown) return { label, unknownCostUsd: null, inconsistent: false };

  const categoryCosts = [breakdown.cost.input, breakdown.cost.output, breakdown.cost.cacheRead, breakdown.cost.cacheWrite];
  // The wire projection supplies finite category values. If an older or
  // malformed server does not, keep its authoritative scalar visible without
  // fabricating a remainder from invalid data.
  if (categoryCosts.some((cost) => !Number.isFinite(cost))) return { label, unknownCostUsd: null, inconsistent: false };

  const knownCostUsd = categoryCosts.reduce((sum, cost) => sum + cost, 0);
  const difference = totalCostUsd - knownCostUsd;
  if (!exceedsCentTolerance(Math.abs(difference), Math.max(totalCostUsd, knownCostUsd))) {
    return { label, unknownCostUsd: null, inconsistent: false };
  }
  if (difference > 0) return { label, unknownCostUsd: difference, inconsistent: false };
  return { label, unknownCostUsd: null, inconsistent: true };
}
