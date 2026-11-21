import { describe, expect, it } from 'vitest';
import {
  DESIGN_TOKENS,
  MANDATORY_TOKENS,
  TOKEN_FALLBACKS,
  createTokenGraph,
  resolveTokens,
  themeProfile,
  tokenDepth,
  tokenNamespace,
  type DesignToken,
} from '../../shared/dist/index.js';

function anchorValues(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...Object.fromEntries(MANDATORY_TOKENS.map((token) => [token, `value-of-${token}`])), ...overrides };
}

function namespaceOf(token: DesignToken): string {
  return tokenNamespace(token);
}

const resolution = resolveTokens(anchorValues({ 'ui.background': '#101010' }));

describe('design token graph', () => {
  it('declares every token as exactly one of mandatory or alias', () => {
    const aliased = Object.keys(TOKEN_FALLBACKS) as DesignToken[];

    expect([...MANDATORY_TOKENS, ...aliased].sort()).toEqual([...DESIGN_TOKENS].sort());
    expect(MANDATORY_TOKENS.filter((token) => token in TOKEN_FALLBACKS)).toEqual([]);
    expect(new Set(MANDATORY_TOKENS).size).toBe(MANDATORY_TOKENS.length);
  });

  it('never falls back to a token outside the vocabulary', () => {
    for (const target of Object.values(TOKEN_FALLBACKS)) expect(DESIGN_TOKENS).toContain(target);
  });

  it('reaches a mandatory token from every alias without revisiting one', () => {
    for (const token of DESIGN_TOKENS) {
      const visited = new Set<DesignToken>();
      let current: DesignToken | undefined = token;
      while (current) {
        expect(visited.has(current)).toBe(false);
        visited.add(current);
        current = TOKEN_FALLBACKS[current];
      }
      expect(tokenDepth(token)).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps dashboard tokens inside the dashboard namespace', () => {
    for (const token of DESIGN_TOKENS.filter((candidate) => namespaceOf(candidate) === 'ui')) {
      let current: DesignToken | undefined = token;
      while (current) {
        expect(namespaceOf(current)).toBe('ui');
        current = TOKEN_FALLBACKS[current];
      }
    }
  });

  it('resolves every token from the mandatory anchors', () => {
    expect(Object.keys(resolution.values).sort()).toEqual([...DESIGN_TOKENS].sort());
    expect(Object.values(resolution.values).every((value) => value.length > 0)).toBe(true);
  });

  it('requires a statement or an inherited value for every mandatory token', () => {
    expect(() => resolveTokens({})).toThrow(/ui\.background/);
  });

  it('walks a chain of fallbacks to its anchor', () => {
    expect(resolution.values['ui.card']).toBe('#101010');
    expect(resolution.values['ui.sidebar-accent']).toBe('#101010');
    expect(resolution.values['editor.syntax.comment.documentation']).toBe('value-of-editor.syntax.comment');
    expect(resolution.values['editor.terminal.bright-red']).toBe('value-of-editor.terminal.red');
  });

  it('reports which anchor supplied a fallback value', () => {
    expect(resolution.provenance['ui.background']).toEqual({ kind: 'explicit' });
    expect(resolution.provenance['ui.card']).toEqual({ kind: 'fallback', via: ['ui.background'] });
    expect(resolution.provenance['ui.accent']).toEqual({ kind: 'fallback', via: ['ui.surface-hover', 'ui.surface-subtle', 'ui.card', 'ui.background'] });
  });

  it('resolves the same tokens whatever the statement order', () => {
    const entries = Object.entries(anchorValues({ 'ui.card': '#202020' }));

    expect(resolveTokens(Object.fromEntries([...entries].reverse()))).toEqual(resolveTokens(Object.fromEntries(entries)));
  });

  it('rejects a graph with a cycle and names the tokens on it', () => {
    expect(() => createTokenGraph({ tokens: ['a.a', 'a.b', 'a.c'], mandatory: ['a.c'], fallbacks: { 'a.a': 'a.b', 'a.b': 'a.a' } })).toThrow(/a\.a -> a\.b -> a\.a/);
  });

  it('rejects an edge to an unknown token', () => {
    expect(() => createTokenGraph({ tokens: ['a.a'], mandatory: [], fallbacks: { 'a.a': 'a.absent' } })).toThrow(/a\.absent/);
  });

  it('rejects a token that is neither mandatory nor aliased', () => {
    expect(() => createTokenGraph({ tokens: ['a.a', 'a.b'], mandatory: ['a.a'], fallbacks: {} })).toThrow(/a\.b/);
  });

  it('accepts an injected graph that reaches its anchors', () => {
    const graph = createTokenGraph({ tokens: ['a.a', 'a.b', 'a.c'], mandatory: ['a.c'], fallbacks: { 'a.a': 'a.b', 'a.b': 'a.c' } });

    expect(graph.depth('a.a')).toBe(2);
    expect(graph.resolve({ 'a.c': '#abcdef' }).values).toEqual({ 'a.a': '#abcdef', 'a.b': '#abcdef', 'a.c': '#abcdef' });
  });
});

describe('theme profile', () => {
  const uiAnchors = MANDATORY_TOKENS.filter((token) => namespaceOf(token) === 'ui').length;

  it('reports an anchor-only theme as level zero in every namespace', () => {
    const profile = themeProfile(anchorValues());

    expect(profile.depth).toEqual({ ui: 0, 'editor.surface': 0, 'editor.syntax': 0, 'editor.terminal': 0 });
    expect(profile.histogram.ui[0]).toBe(uiAnchors);
    expect(profile.reach).toEqual([]);
  });

  it('measures depth from the nearest mandatory token per namespace', () => {
    const profile = themeProfile(anchorValues({ 'ui.accent': '#303030', 'editor.surface.active-line': '#404040' }));

    expect(profile.depth.ui).toBe(4);
    expect(profile.depth['editor.surface']).toBe(4);
    expect(profile.depth['editor.syntax']).toBe(0);
    expect(profile.histogram.ui[4]).toBe(1);
    expect(profile.histogram.ui[0]).toBe(uiAnchors);
  });

  it('lists the stated tokens whose fallback parent is unstated', () => {
    const profile = themeProfile(anchorValues({ 'ui.accent': '#303030', 'ui.card': '#202020' }));

    expect(profile.reach).toEqual(['ui.accent']);
  });
});
