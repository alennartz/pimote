import { describe, expect, it } from 'vitest';
import { followDecision, moveChipOrder, projectChipOrder } from './user-session-facts.js';

const session = (sessionId: string) => ({ sessionId, folderPath: `/w/${sessionId}` });

describe('projectChipOrder', () => {
  it('returns sessions in the server order, not in registry insertion order', () => {
    const projected = projectChipOrder([session('a'), session('b'), session('c')], ['c', 'a', 'b']);

    expect(projected.map((entry) => entry.sessionId)).toEqual(['c', 'a', 'b']);
  });

  it('drops order ids the registry does not hold and appends the sessions the order omits', () => {
    // The order names a session this connection never opened, and omits one it
    // does hold: a newly opened session lands at the end without a re-sort.
    const projected = projectChipOrder([session('a'), session('b'), session('fresh')], ['gone', 'b', 'a']);

    expect(projected.map((entry) => entry.sessionId)).toEqual(['b', 'a', 'fresh']);
  });

  it('keeps every session exactly once when the order repeats an id', () => {
    const projected = projectChipOrder([session('a'), session('b')], ['b', 'b', 'a']);

    expect(projected.map((entry) => entry.sessionId)).toEqual(['b', 'a']);
  });

  it('falls back to registry order when the order is empty', () => {
    const projected = projectChipOrder([session('a'), session('b')], []);

    expect(projected.map((entry) => entry.sessionId)).toEqual(['a', 'b']);
  });
});

describe('moveChipOrder', () => {
  it('moves an id to another index', () => {
    expect(moveChipOrder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveChipOrder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('refuses an out-of-range move and a move to the same slot', () => {
    expect(moveChipOrder(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
    expect(moveChipOrder(['a', 'b'], -1, 1)).toEqual(['a', 'b']);
    expect(moveChipOrder(['a', 'b'], 0, 2)).toEqual(['a', 'b']);
  });
});

describe('followDecision', () => {
  const known = ['a', 'b', 'c'];

  it('navigates when another connection selected a session this one does not view', () => {
    expect(followDecision({ selectedSessionId: 'b', viewedSessionId: 'a', knownSessionIds: known })).toBe('navigate');
  });

  it('navigates from the dashboard to the selection', () => {
    expect(followDecision({ selectedSessionId: 'c', viewedSessionId: null, knownSessionIds: known })).toBe('navigate');
  });

  it('stays when this connection already views the selection — the loop breaker', () => {
    expect(followDecision({ selectedSessionId: 'b', viewedSessionId: 'b', knownSessionIds: known })).toBe('stay');
  });

  it('stays when nothing is selected', () => {
    expect(followDecision({ selectedSessionId: null, viewedSessionId: 'a', knownSessionIds: known })).toBe('stay');
  });

  it('stays when the selection names a session this connection cannot view', () => {
    expect(followDecision({ selectedSessionId: 'elsewhere', viewedSessionId: 'a', knownSessionIds: known })).toBe('stay');
  });
});
