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

interface ProjectedNode {
  source: PimoteTreeNode;
  children: ProjectedNode[];
  parent: ProjectedNode | null;
}

interface Projection {
  roots: ProjectedNode[];
  byId: Map<string, ProjectedNode>;
  parentByRawId: Map<string, string | null>;
}

function isConversationMessage(node: PimoteTreeNode): boolean {
  return node.type === 'message' && (node.role === 'user' || node.role === 'assistant');
}

/**
 * Remove non-conversation entries while attaching each message to its next
 * meaningful ancestor. The iterative walk preserves wire order and handles
 * very deep session trees without consuming the call stack.
 */
function projectTree(tree: PimoteTreeNode[]): Projection {
  const roots: ProjectedNode[] = [];
  const byId = new Map<string, ProjectedNode>();
  const parentByRawId = new Map<string, string | null>();
  const pending: Array<{ node: PimoteTreeNode; parent: ProjectedNode | null; rawParentId: string | null }> = [];

  for (let index = tree.length - 1; index >= 0; index -= 1) {
    pending.push({ node: tree[index], parent: null, rawParentId: null });
  }

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (parentByRawId.has(current.node.id)) continue;
    parentByRawId.set(current.node.id, current.rawParentId);

    let parent = current.parent;
    if (isConversationMessage(current.node)) {
      const projected: ProjectedNode = { source: current.node, children: [], parent };
      byId.set(current.node.id, projected);
      if (parent) parent.children.push(projected);
      else roots.push(projected);
      parent = projected;
    }

    for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
      pending.push({ node: current.node.children[index], parent, rawParentId: current.node.id });
    }
  }

  return { roots, byId, parentByRawId };
}

function segmentId(first: ProjectedNode, last: ProjectedNode): string {
  return `segment:${first.source.id}:${last.source.id}`;
}

function messageRow(node: ProjectedNode, depth: number, activeIds: ReadonlySet<string>): BranchMapRow {
  const source = node.source;
  return {
    kind: 'message',
    id: source.id,
    role: source.role ?? '',
    text: source.conversationText ?? source.preview,
    ...(source.label === undefined ? {} : { label: source.label }),
    isActive: activeIds.has(source.id),
    isBranchPoint: node.children.length >= 2,
    depth,
  };
}

function activeMessageIds(projection: Projection, currentLeafId: string | null): Set<string> {
  const active = new Set<string>();
  if (currentLeafId === null || !projection.parentByRawId.has(currentLeafId)) return active;

  let rawId: string | null = currentLeafId;
  while (rawId !== null) {
    if (projection.byId.has(rawId)) active.add(rawId);
    rawId = projection.parentByRawId.get(rawId) ?? null;
  }
  return active;
}

/** Project a session tree into the branch explorer's visible rows. */
export function buildBranchMap(tree: PimoteTreeNode[], currentLeafId: string | null, expandedSegmentIds: ReadonlySet<string>): BranchMapRow[] {
  const projection = projectTree(tree);
  const activeIds = activeMessageIds(projection, currentLeafId);
  const rows: BranchMapRow[] = [];
  const pending: Array<{ start: ProjectedNode; depth: number }> = [];

  for (let index = projection.roots.length - 1; index >= 0; index -= 1) {
    pending.push({ start: projection.roots[index], depth: 0 });
  }

  while (pending.length > 0) {
    const frame = pending.pop()!;
    const path: ProjectedNode[] = [frame.start];
    let endpoint = frame.start;
    while (endpoint.children.length === 1) {
      endpoint = endpoint.children[0];
      path.push(endpoint);
    }

    const first = path[0];
    const last = path[path.length - 1];
    rows.push(messageRow(first, frame.depth, activeIds));

    if (path.length > 2) {
      const id = segmentId(first, last);
      if (expandedSegmentIds.has(id)) {
        for (let index = 1; index < path.length - 1; index += 1) {
          rows.push(messageRow(path[index], frame.depth, activeIds));
        }
      } else {
        rows.push({
          kind: 'segment',
          id,
          firstId: first.source.id,
          lastId: last.source.id,
          hiddenCount: path.length - 2,
          depth: frame.depth,
        });
      }
    }

    if (last !== first) rows.push(messageRow(last, frame.depth, activeIds));

    // A path ends only at a leaf or a meaningful branch point. Push children
    // in reverse so the wire order remains preorder when they are visited.
    for (let index = last.children.length - 1; index >= 0; index -= 1) {
      pending.push({ start: last.children[index], depth: frame.depth + 1 });
    }
  }

  return rows;
}

/** Return the collapsed segments that must be expanded to expose a target. */
export function segmentsToExpose(tree: PimoteTreeNode[], targetId: string): Set<string> {
  const projection = projectTree(tree);
  if (!projection.byId.has(targetId)) return new Set();

  const exposed = new Set<string>();
  const pending = projection.roots.slice().reverse();
  while (pending.length > 0) {
    const start = pending.pop()!;
    const path: ProjectedNode[] = [start];
    let endpoint = start;
    while (endpoint.children.length === 1) {
      endpoint = endpoint.children[0];
      path.push(endpoint);
    }

    if (path.length > 2 && path.slice(1, -1).some((node) => node.source.id === targetId)) {
      exposed.add(segmentId(path[0], endpoint));
    }

    for (let index = endpoint.children.length - 1; index >= 0; index -= 1) {
      pending.push(endpoint.children[index]);
    }
  }

  return exposed;
}

/** Count alternate continuations at a message, or zero for a non-branch point. */
export function abandonedBranchCountAt(tree: PimoteTreeNode[], entryId: string): number {
  const node = projectTree(tree).byId.get(entryId);
  if (!node || node.children.length < 2) return 0;
  return node.children.length - 1;
}
