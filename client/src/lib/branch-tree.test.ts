import { describe, expect, it } from 'vitest';
import type { PimoteTreeNode } from '@pimote/shared';
import { abandonedBranchCountAt, buildBranchMap, segmentsToExpose } from './branch-tree.js';

function node(id: string, role: 'user' | 'assistant', text: string, children: PimoteTreeNode[] = []): PimoteTreeNode {
  return {
    id,
    type: 'message',
    role,
    preview: text,
    conversationText: text,
    timestamp: '2026-04-11T10:00:00.000Z',
    children,
  };
}

function fixtureTree(): PimoteTreeNode[] {
  const activeLeaf = node('a5', 'assistant', 'The monotonic counter is in place.');
  const activeUser = node('u5', 'user', 'Run the server tests.', [activeLeaf]);
  const activeBranch = node('a2', 'assistant', 'The cursor collided.', [activeUser]);
  const branchPoint = node('u2', 'user', 'Why did the cursor go backwards?', [
    activeBranch,
    node('a2-alt', 'assistant', 'Use a test-only workaround.', [node('u-alt', 'user', 'Drop this idea.')]),
  ]);
  const mainSegment = node('a1', 'assistant', 'I found the stale cursor.', [branchPoint]);
  const abandonedSegment = node('u7', 'user', 'Rewrite the replay buffer.', [node('a7', 'assistant', 'A rewrite is risky.', [node('u8', 'user', 'Drop this idea.')])]);
  return [node('u1', 'user', 'Fix the retry test.', [mainSegment, abandonedSegment])];
}

describe('branch tree projection', () => {
  it('renders linear continuations as collapsed segments with first and last anchors', () => {
    const rows = buildBranchMap(fixtureTree(), 'a5', new Set());

    const segments = rows.filter((row) => row.kind === 'segment');
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((row) => row.hiddenCount > 0)).toBe(true);
    expect(segments.every((row) => row.firstId !== row.lastId)).toBe(true);
  });

  it('marks the active path and renders each shared message only once', () => {
    const rows = buildBranchMap(fixtureTree(), 'a5', new Set());

    const messageRows = rows.filter((row) => row.kind === 'message');
    const ids = messageRows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(messageRows.filter((row) => row.isActive).map((row) => row.id)).toEqual(expect.arrayContaining(['u1', 'a5']));
  });

  it('expands only the requested segment while leaving deeper linear runs folded', () => {
    const collapsedRows = buildBranchMap(fixtureTree(), 'a5', new Set());
    const firstSegment = collapsedRows.find((row) => row.kind === 'segment');
    expect(firstSegment).toBeDefined();

    const expandedRows = buildBranchMap(fixtureTree(), 'a5', new Set([firstSegment!.id]));
    expect(expandedRows.some((row) => row.kind === 'message' && row.id === firstSegment!.firstId)).toBe(true);
    expect(expandedRows.some((row) => row.kind === 'message' && row.id === firstSegment!.lastId)).toBe(true);
  });

  it('returns segments that expose a focused message', () => {
    const segmentIds = segmentsToExpose(fixtureTree(), 'a5');

    expect(segmentIds.size).toBeGreaterThan(0);
    const rows = buildBranchMap(fixtureTree(), 'a5', segmentIds);
    expect(rows.some((row) => row.kind === 'message' && row.id === 'a5')).toBe(true);
  });

  it('counts alternate continuations at branch points only', () => {
    expect(abandonedBranchCountAt(fixtureTree(), 'u1')).toBe(1);
    expect(abandonedBranchCountAt(fixtureTree(), 'u2')).toBe(1);
    expect(abandonedBranchCountAt(fixtureTree(), 'a5')).toBe(0);
    expect(abandonedBranchCountAt(fixtureTree(), 'missing')).toBe(0);
  });
});
