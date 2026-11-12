import type { SubagentSemanticFact } from './protocol.js';

/** Identify a fact by its raw ID and semantic payload, not native enrichment. */
export function semanticEventIdentity(fact: Pick<SubagentSemanticFact, 'eventId' | 'kind' | 'path' | 'data'>): string {
  return JSON.stringify([fact.eventId, fact.kind, fact.path, fact.data], (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  });
}
