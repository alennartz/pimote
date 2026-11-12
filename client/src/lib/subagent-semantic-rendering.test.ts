import { describe, expect, it } from 'vitest';
import type { PimoteAgentMessage } from '@pimote/shared';
import { EMPTY_SEMANTIC_REDUCTION, reduceSubagentSemanticEvent, type PiEventRef } from './subagent-semantic.js';
import { indexSemanticAnchors, projectSemanticContent, projectSemanticMessage } from './subagent-semantic-rendering.js';

const sessionId = 'root';

function semanticBlock(eventId: string, relatedPiEvents: readonly PiEventRef[]) {
  return reduceSubagentSemanticEvent(EMPTY_SEMANTIC_REDUCTION, {
    eventId,
    kind: 'message_thread',
    placement: { sequence: 1 },
    relatedPiEvents,
    data: { sourcePath: [], targetPath: ['worker'], request: eventId },
  }).blocks[0];
}

const toolRef: PiEventRef = { sessionId, kind: 'tool_call', toolCallId: 'call' };
const call: PimoteAgentMessage = { role: 'assistant', entryId: 'call-entry', content: [{ type: 'tool_call', toolCallId: 'call', toolName: 'subagent' }] };
const result: PimoteAgentMessage = { role: 'toolResult', entryId: 'result-entry', content: [{ type: 'tool_result', toolCallId: 'call', text: 'native result' }] };

describe('semantic anchor index', () => {
  it('assigns each block to its first visible native anchor in transcript order', () => {
    const hidden = { ...call, display: false };
    const text: PimoteAgentMessage = { role: 'assistant', content: [{ type: 'text', text: 'unrelated' }] };
    const first = semanticBlock('first', [toolRef]);
    const second = semanticBlock('second', [toolRef]);
    const index = indexSemanticAnchors([hidden, text, result, call], [first, second], sessionId);

    expect(index.byMessage.get(result)).toEqual([first, second]);
    expect(index.byMessage.has(hidden)).toBe(false);
    expect(index.byMessage.has(text)).toBe(false);
    expect(index.byMessage.has(call)).toBe(false);
    expect(index.remaining).toEqual([]);
    expect(projectSemanticContent(result, result.content, index.byMessage.get(result)!, sessionId).map((item) => item.kind)).toEqual(['semantic', 'semantic']);
  });

  it('retains each referenced assistant message instead of folding its replacement into an earlier row', () => {
    const later = { ...call, entryId: 'later-entry', content: [{ type: 'tool_call' as const, toolCallId: 'later-call', toolName: 'send' }] };
    const block = semanticBlock('shared', [toolRef, { sessionId, kind: 'tool_call', toolCallId: 'later-call' }]);
    const index = indexSemanticAnchors([call, result, later], [block], sessionId);
    expect(index.byMessage.get(call)).toHaveLength(1);
    expect(index.byMessage.get(later)).toHaveLength(1);
    expect(index.byMessage.has(result)).toBe(false);
    expect(projectSemanticContent(later, later.content, index.byMessage.get(later)!, sessionId).map((item) => item.kind)).toEqual(['semantic']);
  });

  it('keeps unmatched facts available for a later streaming anchor', () => {
    const block = semanticBlock('pending', [toolRef]);
    const saved: PimoteAgentMessage = { role: 'assistant', content: [{ type: 'text', text: 'saved answer' }] };
    const index = indexSemanticAnchors([saved], [block], sessionId);
    const streaming = indexSemanticAnchors([call], index.remaining, sessionId);

    expect(index.byMessage.has(saved)).toBe(false);
    expect(streaming.byMessage.get(call)).toEqual([block]);
    expect(streaming.remaining).toEqual([]);
  });

  it('matches custom entries and legacy tool entry references without replacing ordinary text', () => {
    const text: PimoteAgentMessage = { role: 'assistant', entryId: 'notice', content: [{ type: 'text', text: 'ordinary answer' }] };
    const notice: PimoteAgentMessage = { role: 'custom', entryId: 'notice', content: [{ type: 'text', text: 'native notice' }] };
    const custom = semanticBlock('custom', [{ sessionId, entryId: 'notice', kind: 'lifecycle' }]);
    const legacy = semanticBlock('legacy', [{ sessionId, entryId: 'call-entry', kind: 'tool_call' }]);
    const index = indexSemanticAnchors([text, notice, call], [custom, legacy], sessionId);

    expect(index.byMessage.has(text)).toBe(false);
    expect(index.byMessage.get(notice)).toEqual([custom]);
    expect(index.byMessage.get(call)).toEqual([legacy]);
  });

  it('anchors entry-free custom messages through persisted semantic details', () => {
    const block = semanticBlock('entry-free-details', [{ sessionId, kind: 'custom_message' }]);
    const message: PimoteAgentMessage = {
      role: 'custom',
      customType: 'subagents',
      details: { semanticEvents: [{ eventId: 'entry-free-details', kind: 'message_thread' }] },
      content: [{ type: 'text', text: 'native notification' }],
    };

    const index = indexSemanticAnchors([message], [block], sessionId);
    expect(index.byMessage.get(message)).toEqual([block]);
    expect(index.remaining).toEqual([]);
    expect(projectSemanticMessage(message, index.byMessage.get(message)!, sessionId)).toEqual([block]);
  });

  it('respects session identity and does not fall back from an unmatched tool ID to an entry ID', () => {
    const otherSession = semanticBlock('other', [{ ...toolRef, sessionId: 'other' }]);
    const missingTool = semanticBlock('missing', [{ ...toolRef, toolCallId: 'missing', entryId: 'call-entry' }]);
    const entryFree = semanticBlock('entry-free', []);
    const index = indexSemanticAnchors([call], [otherSession, missingTool, entryFree], sessionId);

    expect(index.byMessage.size).toBe(0);
    expect(index.remaining).toEqual([otherSession, missingTool, entryFree]);
  });
});
