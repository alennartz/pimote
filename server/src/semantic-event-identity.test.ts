import { describe, expect, it } from 'vitest';
import type { SubagentSemanticFact } from '../../shared/src/protocol.js';
import { semanticEventIdentity } from '../../shared/src/subagent-semantic-identity.js';

const fact: SubagentSemanticFact = {
  eventId: 'legacy-id',
  kind: 'delegation',
  path: ['worker'],
  relatedPiEvents: [],
  data: {
    invocationId: 'invocation',
    awaitsResult: false,
    children: [
      { path: ['worker', 'first'], task: 'Review code', persona: 'reviewer' },
      { path: ['worker', 'second'], task: 'Read tests' },
    ],
  },
};

describe('semanticEventIdentity', () => {
  it('ignores object key order and native placement/reference enrichment', () => {
    const enriched = {
      ...fact,
      relatedPiEvents: [{ sessionId: 'root', kind: 'custom_message' as const, entryId: 'delivery' }],
      transcriptPosition: { sessionId: 'root', afterEntryId: 'delivery', messageIndex: 4 },
      cursor: 99,
      data: {
        children: [
          { persona: 'reviewer', task: 'Review code', path: ['worker', 'first'] },
          { task: 'Read tests', path: ['worker', 'second'] },
        ],
        awaitsResult: false,
        invocationId: 'invocation',
      },
    };

    expect(semanticEventIdentity(enriched)).toBe(semanticEventIdentity(fact));
    expect(fact.relatedPiEvents).toEqual([]);
  });

  it('distinguishes raw IDs, semantic kinds, paths, payload values, and array order', () => {
    const variants = [
      fact,
      { ...fact, eventId: 'another-id' },
      { ...fact, kind: 'interrupt' as const, data: { operation: 'interrupt' as const, outcome: 'succeeded' } },
      { ...fact, path: ['another-worker'] },
      { ...fact, data: { ...fact.data, invocationId: 'another-invocation' } },
      { ...fact, data: { ...fact.data, children: [...fact.data.children].reverse() } },
    ];

    expect(new Set(variants.map(semanticEventIdentity)).size).toBe(variants.length);
  });
});
