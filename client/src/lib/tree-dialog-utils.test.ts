import { describe, expect, it } from 'vitest';
import type { PimoteTreeNode } from '@pimote/shared';
import { buildTreeRows, filterTree, findTreePath, updateTreeNodeLabel } from './tree-dialog-utils.js';

function makeChain(length: number): PimoteTreeNode[] {
  const roots: PimoteTreeNode[] = [];
  let parent: PimoteTreeNode[] = roots;
  for (let i = 0; i < length; i += 1) {
    const next: PimoteTreeNode = {
      id: `node-${i}`,
      type: 'message',
      role: i % 2 === 0 ? 'user' : 'assistant',
      preview: i === length - 1 ? 'target leaf' : `node ${i}`,
      timestamp: '2026-04-11T12:00:00.000Z',
      children: [],
    };
    parent.push(next);
    parent = next.children;
  }
  return roots;
}

function deepestNode(nodes: PimoteTreeNode[]): PimoteTreeNode {
  let node = nodes[0];
  while (node.children.length > 0) node = node.children[0];
  return node;
}

describe('tree dialog traversal helpers', () => {
  it('finds a leaf in a deeply nested tree without overflowing the stack', () => {
    const tree = makeChain(5_000);

    const path = findTreePath(tree, 'node-4999');

    expect(path).toHaveLength(5_000);
    expect(path[0]).toBe('node-0');
    expect(path.at(-1)).toBe('node-4999');
    expect(findTreePath(tree, 'missing')).toEqual([]);
  });

  it('builds rows for a deeply nested active path without overflowing the stack', () => {
    const tree = makeChain(5_000);
    const activePath = new Set(findTreePath(tree, 'node-4999'));

    const rows = buildTreeRows(tree, new Set(), activePath);

    expect(rows).toHaveLength(5_000);
    expect(rows[0].node.id).toBe('node-0');
    expect(rows.at(-1)?.node.id).toBe('node-4999');
    expect(rows.slice(0, -1).every((row) => row.expanded && row.depth === 0)).toBe(true);
    expect(rows.at(-1)?.hasChildren).toBe(false);
  });

  it('filters a deeply nested tree while preserving matching ancestors', () => {
    const tree = makeChain(5_000);

    const filtered = filterTree(tree, (node) => node.preview === 'target leaf');

    expect(filtered).toHaveLength(1);
    let node = filtered[0];
    for (let i = 0; i < 5_000; i += 1) {
      expect(node.id).toBe(`node-${i}`);
      if (i < 4_999) node = node.children[0];
    }
    expect(node.children).toEqual([]);
  });

  it('updates a deeply nested label without overflowing the stack', () => {
    const tree = makeChain(5_000);

    const updated = updateTreeNodeLabel(tree, 'node-4999', 'Important', '2026-04-11T12:01:00.000Z');

    const leaf = deepestNode(updated);
    expect(leaf.label).toBe('Important');
    expect(leaf.labelTimestamp).toBe('2026-04-11T12:01:00.000Z');
    expect(updated[0] === tree[0]).toBe(false);
  });
});
