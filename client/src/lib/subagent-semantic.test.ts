import { describe, expect, it } from 'vitest';
import {
  EMPTY_SEMANTIC_REDUCTION,
  copySubagentTranscript,
  projectSubagentTranscript,
  reduceSubagentSemanticEvent,
  type NativeTranscriptEntry,
  type PiEventRef,
  type SemanticBlock,
  type SubagentSemanticEvent,
} from './subagent-semantic.js';

const sessionId = 'child-session';
const toolCallRef: PiEventRef = { sessionId, entryId: 'tool-1', toolCallId: 'call-1', kind: 'tool_call' };
const toolResultRef: PiEventRef = { sessionId, entryId: 'tool-result-1', toolCallId: 'call-1', kind: 'custom_message' };

const nativeEntries: readonly NativeTranscriptEntry[] = [
  { id: 'user-1', kind: 'message', text: 'Review the callback.' },
  { id: 'tool-1', kind: 'tool_call', text: 'subagent' },
  { id: 'tool-result-1', kind: 'tool_result', text: 'worker started' },
  { id: 'assistant-1', kind: 'message', text: 'The review is in progress.' },
];

function semanticEvent(overrides: Partial<SubagentSemanticEvent> & Pick<SubagentSemanticEvent, 'eventId' | 'kind'>): SubagentSemanticEvent {
  return {
    eventId: overrides.eventId,
    kind: overrides.kind,
    placement: overrides.placement ?? { afterPiEvent: toolCallRef, sequence: 1 },
    relatedPiEvents: overrides.relatedPiEvents ?? [toolCallRef],
    data: overrides.data ?? { summary: 'Review callback ownership.' },
  };
}

describe('subagent semantic transcript projection', () => {
  it('places a delegation block beside its native provenance', () => {
    const event = semanticEvent({ eventId: 'delegation-1', kind: 'delegation' });
    const state = reduceSubagentSemanticEvent(EMPTY_SEMANTIC_REDUCTION, event);
    const items = projectSubagentTranscript(nativeEntries, state);

    const toolIndex = items.findIndex((item) => item.kind === 'native' && item.entry.id === 'tool-1');
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(items[toolIndex + 1]).toMatchObject({
      kind: 'semantic',
      block: {
        eventId: 'delegation-1',
        kind: 'delegation',
        placement: { afterPiEvent: { entryId: 'tool-1' } },
      },
    });
  });

  it('reduces later completion and lifecycle events forward without rewriting earlier blocks', () => {
    const delegation = semanticEvent({ eventId: 'delegation-1', kind: 'delegation' });
    const completion = semanticEvent({
      eventId: 'completion-1',
      kind: 'completion',
      placement: { afterPiEvent: toolResultRef, sequence: 2 },
      relatedPiEvents: [toolResultRef],
      data: { summary: 'Callback ownership belongs to the session store.' },
    });
    const lifecycle = semanticEvent({
      eventId: 'interrupt-1',
      kind: 'lifecycle',
      placement: { afterPiEvent: { sessionId, entryId: 'assistant-1', kind: 'lifecycle' }, sequence: 3 },
      relatedPiEvents: [],
      data: { summary: 'The worker stopped cleanly.' },
    });

    const afterDelegation = reduceSubagentSemanticEvent(EMPTY_SEMANTIC_REDUCTION, delegation);
    const afterCompletion = reduceSubagentSemanticEvent(afterDelegation, completion);
    const afterLifecycle = reduceSubagentSemanticEvent(afterCompletion, lifecycle);

    expect(afterLifecycle.blocks).toHaveLength(3);
    expect(afterLifecycle.blocks.map((block) => block.eventId)).toEqual(['delegation-1', 'completion-1', 'interrupt-1']);
    expect(afterLifecycle.blocks[0]).toEqual(afterDelegation.blocks[0]);
    expect(afterLifecycle.blocks[1]).toMatchObject({ kind: 'completion', placement: { afterPiEvent: { entryId: 'tool-result-1' } } });
  });

  it('copies semantic transcript text without exposing lease or attachment mechanics', () => {
    const block: SemanticBlock = {
      blockId: 'await-1',
      eventId: 'await-1',
      kind: 'await_progress',
      placement: { afterPiEvent: toolResultRef, sequence: 4 },
      relatedPiEvents: [toolResultRef],
      title: 'Await progress',
      transcriptText: 'The child completed. Its answer remains available while the child view is open.',
    };

    const copied = copySubagentTranscript([
      { kind: 'native', entry: nativeEntries[0] },
      { kind: 'semantic', block },
    ]);

    expect(copied).toContain('The child completed.');
    expect(copied).not.toMatch(/\blease\b|\battach(?:ed|ment)?\b|\bdetach(?:ed|ing)?\b|\brelease(?:d|s)?\b/i);
  });
});
