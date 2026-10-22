import type { PimoteTreeNode } from '@pimote/shared';

export interface TreeRow {
  node: PimoteTreeNode;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
}

/** Find a node's root-to-node path without recursion. */
export function findTreePath(nodes: PimoteTreeNode[], targetId: string): string[] {
  const parentById = new Map<string, string | null>();
  const pending: Array<{ node: PimoteTreeNode; parentId: string | null }> = [];

  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    pending.push({ node: nodes[i], parentId: null });
  }

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (parentById.has(current.node.id)) continue;
    parentById.set(current.node.id, current.parentId);

    if (current.node.id === targetId) {
      const path: string[] = [];
      let id: string | null = targetId;
      while (id !== null) {
        path.push(id);
        id = parentById.get(id) ?? null;
      }
      path.reverse();
      return path;
    }

    for (let i = current.node.children.length - 1; i >= 0; i -= 1) {
      pending.push({ node: current.node.children[i], parentId: current.node.id });
    }
  }

  return [];
}

/** Flatten expanded tree nodes in preorder without recursive array spreading. */
export function buildTreeRows(nodes: PimoteTreeNode[], expandedNodeIds: Set<string>, activePathNodes: Set<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const pending: Array<{ nodes: PimoteTreeNode[]; index: number; depth: number; hasSiblings: boolean }> = [{ nodes, index: 0, depth: 0, hasSiblings: nodes.length > 1 }];

  while (pending.length > 0) {
    const frame = pending[pending.length - 1];
    if (frame.index >= frame.nodes.length) {
      pending.pop();
      continue;
    }

    const node = frame.nodes[frame.index];
    frame.index += 1;

    const hasChildren = node.children.length > 0;
    const expanded = hasChildren && (expandedNodeIds.has(node.id) || activePathNodes.has(node.id));
    rows.push({ node, depth: frame.depth, expanded, hasChildren });

    if (expanded) {
      const childDepth = node.children.length > 1 || frame.hasSiblings ? frame.depth + 1 : frame.depth;
      pending.push({
        nodes: node.children,
        index: 0,
        depth: childDepth,
        hasSiblings: node.children.length > 1,
      });
    }
  }

  return rows;
}

/** Keep matching nodes and their ancestors while preserving tree identity where possible. */
export function filterTree(nodes: PimoteTreeNode[], matches: (node: PimoteTreeNode) => boolean): PimoteTreeNode[] {
  interface Frame {
    node: PimoteTreeNode | null;
    nodes: PimoteTreeNode[];
    index: number;
    result: PimoteTreeNode[];
    parentResult?: PimoteTreeNode[];
  }

  const rootResult: PimoteTreeNode[] = [];
  const pending: Frame[] = [{ node: null, nodes, index: 0, result: rootResult }];

  while (pending.length > 0) {
    const frame = pending[pending.length - 1];
    if (frame.index < frame.nodes.length) {
      const node = frame.nodes[frame.index];
      frame.index += 1;
      pending.push({ node, nodes: node.children, index: 0, result: [], parentResult: frame.result });
      continue;
    }

    pending.pop();
    if (frame.node === null) continue;

    const filteredChildren = frame.result;
    if (!matches(frame.node) && filteredChildren.length === 0) continue;

    const childrenUnchanged = filteredChildren.length === frame.node.children.length && filteredChildren.every((child, index) => child === frame.node!.children[index]);
    frame.parentResult!.push(childrenUnchanged ? frame.node : { ...frame.node, children: filteredChildren });
  }

  return rootResult;
}

/** Update one label by rebuilding only its ancestor path, without recursion. */
export function updateTreeNodeLabel(tree: PimoteTreeNode[], entryId: string, label: string | undefined, labelTimestamp: string): PimoteTreeNode[] {
  interface ParentLink {
    parent: PimoteTreeNode | null;
    index: number;
  }

  const parentById = new Map<string, ParentLink>();
  const pending: Array<{ node: PimoteTreeNode; parent: PimoteTreeNode | null; index: number }> = [];
  for (let i = tree.length - 1; i >= 0; i -= 1) {
    pending.push({ node: tree[i], parent: null, index: i });
  }

  let target: PimoteTreeNode | undefined;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (parentById.has(current.node.id)) continue;
    parentById.set(current.node.id, { parent: current.parent, index: current.index });

    if (current.node.id === entryId) {
      target = current.node;
      break;
    }

    for (let i = current.node.children.length - 1; i >= 0; i -= 1) {
      pending.push({ node: current.node.children[i], parent: current.node, index: i });
    }
  }

  if (!target) return tree;

  let replacement: PimoteTreeNode = { ...target, label, labelTimestamp };
  let currentId = entryId;
  while (true) {
    const link = parentById.get(currentId);
    if (!link) return tree;

    if (link.parent === null) {
      const nextTree = tree.slice();
      nextTree[link.index] = replacement;
      return nextTree;
    }

    const children = link.parent.children.slice();
    children[link.index] = replacement;
    replacement = { ...link.parent, children };
    currentId = link.parent.id;
  }
}
