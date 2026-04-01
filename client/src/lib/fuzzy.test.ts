import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzyFilter } from './fuzzy.js';

describe('fuzzyMatch', () => {
  it('matches exact text', () => {
    const result = fuzzyMatch('deploy', 'deploy');
    expect(result.matches).toBe(true);
  });

  it('matches prefix', () => {
    const result = fuzzyMatch('dep', 'deploy');
    expect(result.matches).toBe(true);
  });

  it('matches scattered characters in order', () => {
    const result = fuzzyMatch('dly', 'deploy');
    expect(result.matches).toBe(true);
  });

  it('does not match when characters are out of order', () => {
    const result = fuzzyMatch('ped', 'deploy');
    expect(result.matches).toBe(false);
  });

  it('does not match when query has characters not in text', () => {
    const result = fuzzyMatch('xyz', 'deploy');
    expect(result.matches).toBe(false);
  });

  it('matches case-insensitively', () => {
    const result = fuzzyMatch('DEP', 'deploy');
    expect(result.matches).toBe(true);
  });

  it('returns score 0 for empty query', () => {
    const result = fuzzyMatch('', 'deploy');
    expect(result.matches).toBe(true);
    expect(result.score).toBe(0);
  });

  it('does not match when query is longer than text', () => {
    const result = fuzzyMatch('deployment', 'deploy');
    expect(result.matches).toBe(false);
  });

  it('gives word boundary matches a better score than mid-word matches', () => {
    // "br" matches at word boundary in "skill:brainstorm" (the "b" is right after ":")
    const boundaryResult = fuzzyMatch('br', 'skill:brainstorm');
    // "ra" matches mid-word in "skill:brainstorm"
    const midWordResult = fuzzyMatch('ra', 'skill:brainstorm');
    expect(boundaryResult.matches).toBe(true);
    expect(midWordResult.matches).toBe(true);
    // Lower score = better match; boundary match should score lower
    expect(boundaryResult.score).toBeLessThan(midWordResult.score);
  });

  it('penalizes gaps between matched characters', () => {
    // "de" is consecutive in "deploy"
    const consecutiveResult = fuzzyMatch('de', 'deploy');
    // "dy" has a gap in "deploy"
    const gappyResult = fuzzyMatch('dy', 'deploy');
    expect(consecutiveResult.matches).toBe(true);
    expect(gappyResult.matches).toBe(true);
    // Consecutive should score better (lower) than gappy
    expect(consecutiveResult.score).toBeLessThan(gappyResult.score);
  });

  it('rewards consecutive matches', () => {
    // "depl" — four consecutive characters
    const longConsecutive = fuzzyMatch('depl', 'deploy');
    expect(longConsecutive.matches).toBe(true);
    // Score should be negative (consecutive bonus exceeds position penalty)
    expect(longConsecutive.score).toBeLessThan(0);
  });

  it('handles word boundaries on common separators', () => {
    // Separators: space, dash, underscore, dot, slash, colon
    for (const sep of [' ', '-', '_', '.', '/', ':']) {
      const text = `foo${sep}bar`;
      const result = fuzzyMatch('b', text);
      expect(result.matches).toBe(true);
      // "b" at position after separator should get word boundary bonus
      const midResult = fuzzyMatch('o', text);
      expect(midResult.matches).toBe(true);
      // "b" is at a word boundary so should score better than "o" at similar position
      expect(result.score).toBeLessThan(midResult.score);
    }
  });

  it('handles alphanumeric swap for queries like "abc123" / "123abc"', () => {
    // If "abc3" doesn't match directly, it tries swapping alpha/numeric groups
    const result = fuzzyMatch('test2', '2test');
    expect(result.matches).toBe(true);
  });
});

describe('fuzzyFilter', () => {
  const items = ['skill:brainstorm', 'skill:code-review', 'skill:implementing', 'deploy', 'deploy-staging', 'test-runner'];

  it('returns all items for empty query', () => {
    const result = fuzzyFilter(items, '', (x) => x);
    expect(result).toEqual(items);
  });

  it('returns all items for whitespace-only query', () => {
    const result = fuzzyFilter(items, '   ', (x) => x);
    expect(result).toEqual(items);
  });

  it('filters to matching items only', () => {
    const result = fuzzyFilter(items, 'deploy', (x) => x);
    expect(result).toContain('deploy');
    expect(result).toContain('deploy-staging');
    expect(result).not.toContain('skill:brainstorm');
  });

  it('returns empty array when nothing matches', () => {
    const result = fuzzyFilter(items, 'zzzzz', (x) => x);
    expect(result).toEqual([]);
  });

  it('sorts results by match quality (best first)', () => {
    const result = fuzzyFilter(items, 'dep', (x) => x);
    // "deploy" should rank higher than "deploy-staging" (shorter, tighter match)
    expect(result.indexOf('deploy')).toBeLessThan(result.indexOf('deploy-staging'));
  });

  it('supports space-separated tokens (all must match)', () => {
    const result = fuzzyFilter(items, 'skill brain', (x) => x);
    expect(result).toEqual(['skill:brainstorm']);
  });

  it('requires all tokens to match for space-separated queries', () => {
    // "skill zzz" — first token matches some, second matches none
    const result = fuzzyFilter(items, 'skill zzz', (x) => x);
    expect(result).toEqual([]);
  });

  it('works with a custom getText accessor', () => {
    const objects = [
      { name: 'deploy', desc: 'Ship to production' },
      { name: 'test', desc: 'Run tests' },
    ];
    const result = fuzzyFilter(objects, 'dep', (item) => item.name);
    expect(result).toEqual([{ name: 'deploy', desc: 'Ship to production' }]);
  });

  it('handles single-item list', () => {
    const result = fuzzyFilter(['deploy'], 'dep', (x) => x);
    expect(result).toEqual(['deploy']);
  });

  it('handles empty item list', () => {
    const result = fuzzyFilter([], 'dep', (x) => x);
    expect(result).toEqual([]);
  });
});
