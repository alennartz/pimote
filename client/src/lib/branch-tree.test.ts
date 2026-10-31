import { describe, expect, it } from 'vitest';
import type { PimoteTreeNode } from '@pimote/shared';
import { abandonedBranchCountAt, buildBranchMap, segmentsToExpose } from './branch-tree.js';

function node(id: string, children: PimoteTreeNode[] = []): PimoteTreeNode {
  return { id, type: 'message', role: 'user', preview: id, conversationText: id, timestamp: '2026-04-11T10:00:00.000Z', children };
}
function tree(): PimoteTreeNode[] {
  return [node('root', [node('first', [node('hidden', [node('fork', [node('deep-first', [node('deep-hidden', [node('leaf')])]), node('alternate')])])]), node('other')])];
}
const messages = (rows: ReturnType<typeof buildBranchMap>) => rows.filter((row) => row.kind === 'message');

describe('branch tree projection', () => {
  it('keeps first and last anchors and counts only hidden messages', () => {
    const rows = buildBranchMap(tree(), 'leaf', new Set());
    expect(messages(rows).map((row) => row.id)).toEqual(expect.arrayContaining(['root', 'first', 'fork', 'other']));
    expect(messages(rows).some((row) => row.id === 'hidden')).toBe(false);
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'segment', firstId: 'first', lastId: 'fork', hiddenCount: 1 }));
  });
  it('reveals the requested run without exposing deeper hidden messages', () => {
    const rows = buildBranchMap(tree(), 'leaf', new Set());
    const segment = rows.find((row) => row.kind === 'segment' && row.firstId === 'first');
    expect(segment).toBeDefined();
    const expanded = buildBranchMap(tree(), 'leaf', new Set([segment!.id]));
    expect(messages(expanded).map((row) => row.id)).toContain('hidden');
    expect(messages(expanded).map((row) => row.id)).not.toContain('deep-hidden');
    expect(expanded.some((row) => row.kind === 'segment' && row.firstId === 'first')).toBe(false);
  });
  it('exposes a hidden target and needs no expansion for an already visible anchor', () => {
    const expanded = segmentsToExpose(tree(), 'hidden');
    expect(messages(buildBranchMap(tree(), 'leaf', expanded)).map((row) => row.id)).toContain('hidden');
    expect(segmentsToExpose(tree(), 'root').size).toBe(0);
    expect(segmentsToExpose(tree(), 'missing').size).toBe(0);
  });
  it('marks active ancestry, inactive alternatives, branch points, and relative depth', () => {
    const rows = messages(buildBranchMap(tree(), 'leaf', segmentsToExpose(tree(), 'deep-hidden')));
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    for (const row of rows) expect(row.isActive).toBe(!['other', 'alternate'].includes(row.id));
    expect(rows.find((row) => row.id === 'root')?.isBranchPoint).toBe(true);
    expect(rows.find((row) => row.id === 'leaf')?.isBranchPoint).toBe(false);
    expect(rows.find((row) => row.id === 'root')?.depth).toBe(0);
    expect(rows.find((row) => row.id === 'leaf')!.depth).toBeGreaterThan(rows.find((row) => row.id === 'root')!.depth);
  });
  it('omits internal and tool messages without losing their conversation descendants', () => {
    const input = [{ ...node('bookkeeping', [{ ...node('tool', [node('visible')]), role: 'toolResult' }]), type: 'custom' }];
    expect(messages(buildBranchMap(input, 'visible', new Set())).map((row) => row.id)).toEqual(['visible']);
  });
  it('handles empty trees and absent active leaves', () => {
    expect(buildBranchMap([], null, new Set())).toEqual([]);
    expect(segmentsToExpose([], 'missing').size).toBe(0);
    expect(messages(buildBranchMap([node('only')], null, new Set()))[0].isActive).toBe(false);
  });
  it('counts alternate meaningful continuations at branch points only', () => {
    expect(abandonedBranchCountAt(tree(), 'root')).toBe(1);
    expect(abandonedBranchCountAt(tree(), 'fork')).toBe(1);
    expect(abandonedBranchCountAt(tree(), 'first')).toBe(0);
    expect(abandonedBranchCountAt(tree(), 'missing')).toBe(0);
    expect(abandonedBranchCountAt([], 'missing')).toBe(0);
  });
});
