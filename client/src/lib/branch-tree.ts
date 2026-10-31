import type { PimoteTreeNode } from '@pimote/shared';

/** One row in the branch explorer's projected map. */
export type BranchMapRow =
  | {
      kind: 'message';
      id: string;
      role: string;
      text: string;
      label?: string;
      isActive: boolean;
      isBranchPoint: boolean;
      depth: number;
    }
  | {
      kind: 'segment';
      id: string;
      firstId: string;
      lastId: string;
      hiddenCount: number;
      depth: number;
    };

/** Project a session tree into the branch explorer's visible rows. */
export function buildBranchMap(_tree: PimoteTreeNode[], _currentLeafId: string | null, _expandedSegmentIds: ReadonlySet<string>): BranchMapRow[] {
  throw new Error('not implemented');
}

/** Return the collapsed segments that must be expanded to expose a target. */
export function segmentsToExpose(_tree: PimoteTreeNode[], _targetId: string): Set<string> {
  throw new Error('not implemented');
}

/** Count alternate continuations at a message, or zero for a non-branch point. */
export function abandonedBranchCountAt(_tree: PimoteTreeNode[], _entryId: string): number {
  throw new Error('not implemented');
}
