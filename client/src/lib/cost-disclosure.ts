import type { PimoteUsageBreakdown } from '@pimote/shared';

export interface CostDisclosure {
  label: string;
  unknownCostUsd: number | null;
  inconsistent: boolean;
}

/** Format a reported total and compare category costs without replacing that total. */
export function summarizeCostDisclosure(_totalCostUsd: number | null | undefined, _breakdown?: PimoteUsageBreakdown): CostDisclosure | null {
  throw new Error('not implemented');
}
