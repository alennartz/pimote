import { describe, expect, it } from 'vitest';
import { MANDATORY_TOKENS, resolveTokens, type DesignToken } from '../../shared/dist/index.js';
import { auditedStateGroups, auditedTokenPairs } from './theme-audit.js';

const resolution = resolveTokens(Object.fromEntries(MANDATORY_TOKENS.map((token) => [token, `value-of-${token}`])));

function anchorOf(token: DesignToken): DesignToken {
  const provenance = resolution.provenance[token];
  return provenance.kind === 'explicit' ? token : provenance.via[provenance.via.length - 1]!;
}

describe('audit contracts under the token graph', () => {
  it('never compares a role against the anchor it falls back to', () => {
    const collapsed = auditedTokenPairs()
      .filter(({ foreground, background }) => anchorOf(foreground) === anchorOf(background))
      .map(({ rule }) => rule);

    expect(collapsed).toEqual([]);
  });

  it('keeps mutually exclusive state roles distinguishable in an anchor-only theme', () => {
    const collapsed = auditedStateGroups()
      .filter((group) => new Set(group.states.map(anchorOf)).size !== group.states.length)
      .map((group) => group.rule);

    expect(collapsed).toEqual([]);
  });
});
