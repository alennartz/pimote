import { describe, expect, it } from 'vitest';
import type { SubagentNodeSnapshot, SubagentSemanticEvent as WireSubagentSemanticEvent } from '../../../shared/src/protocol.js';
import {
  EMPTY_SEMANTIC_REDUCTION,
  copySubagentTranscript,
  projectSubagentTranscript,
  projectSubagentWireTranscript,
  reduceSubagentSemanticEvent,
  type NativeTranscriptEntry,
  type PiEventRef,
  type SemanticReductionState,
  type SubagentSemanticEvent,
} from './subagent-semantic.js';

const sessionId = 'parent-session';
const workerPath = ['worker'];
const scoutPath = ['worker', 'scout'];
const workerNode: SubagentNodeSnapshot = {
  path: workerPath,
  incarnation: 'worker-incarnation',
  sessionId: 'worker-session',
  task: 'Review callback ownership.',
  persona: 'reviewer',
  state: 'running',
  usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.04, turns: 1 },
  contextFill: 31,
  channels: ['parent'],
  waitingFor: [],
  pendingCorrelations: [],
  hasSubgroup: true,
};
const toolCallRef: PiEventRef = { sessionId, entryId: 'tool-1', toolCallId: 'call-1', kind: 'tool_call' };
const notificationRef: PiEventRef = { sessionId, entryId: 'notice-1', kind: 'custom_message' };
const nativeEntries: readonly NativeTranscriptEntry[] = [
  { sessionId, id: 'user-1', kind: 'message', text: 'Review the callback.' },
  { sessionId, id: 'tool-1', toolCallId: 'call-1', kind: 'tool_call', text: 'generic subagent call' },
  { sessionId, id: 'result-1', toolCallId: 'call-1', kind: 'tool_result', text: 'generic subagent result' },
  { sessionId, id: 'notice-1', kind: 'custom_message', text: 'generic subagent notice' },
  { sessionId, id: 'other-1', kind: 'custom_message', text: 'Unrelated notification.' },
  { sessionId, id: 'assistant-1', kind: 'message', text: 'The review is in progress.' },
];

function delegation(awaitsResult: boolean): SubagentSemanticEvent {
  return {
    eventId: 'delegation-1',
    kind: 'delegation',
    placement: { afterPiEvent: toolCallRef, sequence: 1 },
    relatedPiEvents: [toolCallRef],
    data: {
      invocationId: 'invocation-1',
      awaitsResult,
      children: [{ path: workerPath, prompt: 'Review callback ownership.', personaIcon: '◆', state: 'running', contextPercent: 31, costUsd: 0.04 }],
    },
  };
}

function reduce(...events: readonly SubagentSemanticEvent[]): SemanticReductionState {
  return events.reduce(reduceSubagentSemanticEvent, EMPTY_SEMANTIC_REDUCTION);
}

function copy(state: SemanticReductionState): string {
  return copySubagentTranscript(projectSubagentTranscript(nativeEntries, state));
}

function completion(delivery: 'awaited' | 'asynchronous'): Extract<SubagentSemanticEvent, { kind: 'completion' }> {
  return {
    eventId: 'completion-1',
    kind: 'completion',
    placement: { afterPiEvent: notificationRef, sequence: 2 },
    relatedPiEvents: [notificationRef],
    data: {
      delivery,
      invocationId: 'invocation-1',
      result: { path: workerPath, state: 'idle', output: 'Callback ownership belongs to the session store.', costUsd: 0.04 },
    },
  };
}

describe('subagent semantic transcript projection', () => {
  it('replaces referenced generic native rendering while retaining the source and unrelated entries', () => {
    const original = nativeEntries.map((entry) => ({ ...entry }));
    const semantic = { ...delegation(false), relatedPiEvents: [toolCallRef, notificationRef] };
    const items = projectSubagentTranscript(nativeEntries, reduce(semantic));
    const visibleNativeIds = items.flatMap((item) => (item.kind === 'native' ? [item.entry.id] : []));

    expect(visibleNativeIds).not.toContain('tool-1');
    expect(visibleNativeIds).not.toContain('result-1');
    expect(visibleNativeIds).not.toContain('notice-1');
    expect(visibleNativeIds).toEqual(expect.arrayContaining(['user-1', 'other-1', 'assistant-1']));
    const semanticIndex = items.findIndex((item) => item.kind === 'semantic' && item.block.kind === 'delegation');
    expect(semanticIndex).toBeGreaterThan(items.findIndex((item) => item.kind === 'native' && item.entry.id === 'user-1'));
    expect(semanticIndex).toBeLessThan(items.findIndex((item) => item.kind === 'native' && item.entry.id === 'assistant-1'));
    expect(nativeEntries).toEqual(original);
  });

  it('renders entry-free notification facts after the native transcript', () => {
    const entryFreeRef: PiEventRef = { sessionId, kind: 'custom_message' };
    const event: SubagentSemanticEvent = {
      eventId: 'entry-free-notification',
      kind: 'message_thread',
      placement: { sequence: 10 },
      relatedPiEvents: [entryFreeRef],
      data: { sourcePath: scoutPath, targetPath: workerPath, request: 'The callback route does not own the mutation.' },
    };
    const items = projectSubagentTranscript(nativeEntries, reduce(event));
    const semanticIndex = items.findIndex((item) => item.kind === 'semantic' && item.block.eventId === event.eventId);

    expect(semanticIndex).toBeGreaterThan(-1);
    expect(semanticIndex).toBe(items.length - 1);
    expect(items.filter((item) => item.kind === 'native')).toHaveLength(nativeEntries.length);
    expect(copySubagentTranscript(items)).toContain('The callback route does not own the mutation.');
  });

  it('falls back to native rendering without matching provenance and respects session identity', () => {
    const sameIdOtherSession: NativeTranscriptEntry = {
      sessionId: 'other-session',
      id: 'tool-1',
      toolCallId: 'call-1',
      kind: 'tool_call',
      text: 'Other session tool.',
    };
    const noOverlay = projectSubagentTranscript(nativeEntries, EMPTY_SEMANTIC_REDUCTION);
    expect(noOverlay.filter((item) => item.kind === 'native').map((item) => item.entry.id)).toEqual(nativeEntries.map((entry) => entry.id));

    const withOverlay = projectSubagentTranscript([...nativeEntries, sameIdOtherSession], reduce(delegation(false)));
    expect(withOverlay.some((item) => item.kind === 'native' && item.entry.sessionId === 'other-session' && item.entry.id === 'tool-1')).toBe(true);
    expect(withOverlay.some((item) => item.kind === 'native' && item.entry.id === 'notice-1')).toBe(true);

    const missingRef: PiEventRef = { sessionId, entryId: 'missing', kind: 'tool_call' };
    const unmatched = projectSubagentTranscript(nativeEntries, reduce({ ...delegation(false), relatedPiEvents: [missingRef] }));
    expect(unmatched.filter((item) => item.kind === 'native').map((item) => item.entry.id)).toEqual(nativeEntries.map((entry) => entry.id));
  });

  it('merges an awaited delegation result into its invocation block', () => {
    const intervening: SubagentSemanticEvent = {
      eventId: 'intervening',
      kind: 'lifecycle',
      placement: { sequence: 2 },
      relatedPiEvents: [],
      data: { operation: 'interrupt', path: scoutPath, outcome: 'succeeded', output: 'Scout stopped.' },
    };
    const awaitedCompletion = completion('awaited');
    const state = reduce(delegation(true), intervening, { ...awaitedCompletion, placement: { ...awaitedCompletion.placement, sequence: 3 } });
    const block = state.blocks.find((item) => item.kind === 'delegation');
    expect(block?.transcriptText).toContain('Review callback ownership.');
    expect(block?.transcriptText).toContain('Callback ownership belongs to the session store.');
    expect(block?.actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'open_view', path: workerPath })]));
    expect(state.blocks.find((item) => item.eventId === 'intervening')?.transcriptText).toContain('Scout stopped.');
    expect(state.blocks.some((item) => item.kind === 'completion')).toBe(false);
  });

  it('does not merge an awaited result into a different invocation', () => {
    const awaitedCompletion = completion('awaited');
    const state = reduce(delegation(true), { ...awaitedCompletion, data: { ...awaitedCompletion.data, invocationId: 'another-invocation' } });
    expect(state.blocks.find((item) => item.kind === 'delegation')?.transcriptText).not.toContain('Callback ownership belongs to the session store.');
    expect(state.blocks.find((item) => item.kind === 'completion')?.transcriptText).toContain('Callback ownership belongs to the session store.');
  });

  it('keeps an asynchronous completion standalone at its natural position', () => {
    const before = reduce(delegation(false));
    const state = reduce(delegation(false), completion('asynchronous'));
    const originalText = before.blocks.find((block) => block.kind === 'delegation')?.transcriptText;
    expect(state.blocks.find((block) => block.kind === 'delegation')?.transcriptText).toBe(originalText);
    const items = projectSubagentTranscript(nativeEntries, state);
    const delegationIndex = items.findIndex((item) => item.kind === 'semantic' && item.block.kind === 'delegation');
    const completionIndex = items.findIndex((item) => item.kind === 'semantic' && item.block.kind === 'completion');
    expect(completionIndex).toBeGreaterThan(delegationIndex);
    expect(completionIndex).toBeLessThan(items.findIndex((item) => item.kind === 'native' && item.entry.id === 'other-1'));
    const block = state.blocks.find((item) => item.kind === 'completion');
    expect(block?.transcriptText).toContain('Callback ownership belongs to the session store.');
    expect(block?.actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'open_view', path: workerPath })]));
  });

  it('presents an asynchronous error with recovery and usage data', () => {
    const event: SubagentSemanticEvent = {
      eventId: 'completion-error',
      kind: 'completion',
      placement: { afterPiEvent: notificationRef, sequence: 1 },
      relatedPiEvents: [notificationRef],
      data: {
        delivery: 'asynchronous',
        result: {
          path: scoutPath,
          state: 'errored',
          error: 'Provider timeout.',
          contextPercent: 24,
          usage: { inputTokens: 1800, outputTokens: 420 },
          costUsd: 0.02,
        },
      },
    };
    const block = reduce(event).blocks.find((item) => item.kind === 'completion');
    expect(block?.transcriptText).toContain('Provider timeout.');
    expect(block?.data.result).toMatchObject({ state: 'errored', usage: { inputTokens: 1800, outputTokens: 420 }, costUsd: 0.02, contextPercent: 24 });
    expect(block?.actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'open_view', path: scoutPath })]));
  });

  it('presents a correlated request and reply together with both routes and full text', () => {
    const event: SubagentSemanticEvent = {
      eventId: 'thread-1',
      kind: 'message_thread',
      placement: { afterPiEvent: toolCallRef, sequence: 1 },
      relatedPiEvents: [toolCallRef],
      data: {
        correlationId: 'corr-17',
        sourcePath: workerPath,
        targetPath: scoutPath,
        request: 'Can you confirm whether the callback route owns the session mutation?',
        reply: 'Callback ownership belongs to the session store.',
      },
    };
    const state = reduce(event);
    const block = state.blocks.find((item) => item.kind === 'message_thread');
    expect(block?.transcriptText).toContain('worker');
    expect(block?.transcriptText).toContain('scout');
    expect(block?.transcriptText).toContain(event.data.request);
    expect(block?.transcriptText).toContain(event.data.reply);
  });

  it('shows an incoming message even without a correlation', () => {
    const event: SubagentSemanticEvent = {
      eventId: 'incoming',
      kind: 'message_thread',
      placement: { afterPiEvent: notificationRef, sequence: 1 },
      relatedPiEvents: [notificationRef],
      data: { sourcePath: scoutPath, targetPath: workerPath, request: 'The callback route does not own the mutation.' },
    };
    const block = reduce(event).blocks.find((item) => item.kind === 'message_thread');
    expect(block?.transcriptText).toContain('scout');
    expect(block?.transcriptText).toContain('worker');
    expect(block?.transcriptText).toContain('The callback route does not own the mutation.');
  });

  it('shows a failed request with its full content and failure', () => {
    const event: SubagentSemanticEvent = {
      eventId: 'thread-failed',
      kind: 'message_thread',
      placement: { afterPiEvent: toolCallRef, sequence: 1 },
      relatedPiEvents: [toolCallRef],
      data: { correlationId: 'corr-18', sourcePath: workerPath, targetPath: scoutPath, request: 'Check the redirect.', failure: 'The recipient is unavailable.' },
    };
    const text = copy(reduce(event));
    expect(text).toContain('Check the redirect.');
    expect(text).toContain('The recipient is unavailable.');
  });

  it('shows a pending request without inventing a reply', () => {
    const event: SubagentSemanticEvent = {
      eventId: 'thread-pending',
      kind: 'message_thread',
      placement: { afterPiEvent: toolCallRef, sequence: 1 },
      relatedPiEvents: [toolCallRef],
      data: { correlationId: 'corr-pending', sourcePath: workerPath, targetPath: scoutPath, request: 'Check the redirect.' },
    };
    const block = reduce(event).blocks.find((item) => item.kind === 'message_thread');
    expect(block?.transcriptText).toContain('Check the redirect.');
    expect(block?.data.reply).toBeUndefined();
    expect(block?.data.failure).toBeUndefined();
  });

  it('shows requested children and their current states while waiting', () => {
    const event: SubagentSemanticEvent = {
      eventId: 'await-waiting',
      kind: 'await_progress',
      placement: { afterPiEvent: toolCallRef, sequence: 1 },
      relatedPiEvents: [toolCallRef],
      data: {
        phase: 'waiting',
        children: [
          { path: workerPath, state: 'running', output: 'Checking the redirect.' },
          { path: scoutPath, state: 'idle', output: 'Callback review complete.' },
        ],
      },
    };
    const block = reduce(event).blocks.find((item) => item.kind === 'await_progress');
    expect(block?.data.children).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: workerPath, state: 'running' }), expect.objectContaining({ path: scoutPath, state: 'idle' })]),
    );
    expect(block?.transcriptText).toContain('Checking the redirect.');
    expect(block?.transcriptText).toContain('Callback review complete.');
  });

  it('shows a message interruption of an await without exposing attachment mechanics', () => {
    const event: SubagentSemanticEvent = {
      eventId: 'await-interrupted',
      kind: 'await_progress',
      placement: { afterPiEvent: notificationRef, sequence: 1 },
      relatedPiEvents: [notificationRef],
      data: {
        phase: 'interrupted',
        children: [{ path: workerPath, state: 'running' }],
        interruption: { sourcePath: scoutPath, text: 'The callback route does not own the mutation.' },
      },
    };
    const text = copy(reduce(event));
    expect(text).toContain('The callback route does not own the mutation.');
    expect(text).toMatch(/interrupt/i);
    expect(text).not.toMatch(/\blease\b|\battach(?:ed|ment)?\b|\bdetach(?:ed|ing)?\b/i);
  });

  it('shows each requested child and result when an await completes', () => {
    const event: SubagentSemanticEvent = {
      eventId: 'await-completed',
      kind: 'await_progress',
      placement: { afterPiEvent: toolCallRef, sequence: 1 },
      relatedPiEvents: [toolCallRef],
      data: {
        phase: 'completed',
        children: [
          { path: workerPath, state: 'idle', output: 'Redirect ownership is split.' },
          { path: scoutPath, state: 'errored', error: 'Provider timeout.' },
        ],
      },
    };
    const text = copy(reduce(event));
    expect(text).toContain('worker');
    expect(text).toContain('scout');
    expect(text).toContain('Redirect ownership is split.');
    expect(text).toContain('Provider timeout.');
    expect(text).not.toMatch(/\blease\b|\battach(?:ed|ment)?\b|\bdetach(?:ed|ing)?\b/i);
  });

  it.each([
    { operation: 'interrupt', output: 'Stopped after checking ownership.', action: 'open_view' },
    { operation: 'teardown', output: 'Last output: ownership is split.', action: 'resurrect' },
    { operation: 'resurrect', output: 'Restored prompt: check ownership.', action: 'open_view' },
  ] as const)('presents $operation output and its recovery action', ({ operation, output, action }) => {
    const event: SubagentSemanticEvent = {
      eventId: operation,
      kind: 'lifecycle',
      placement: { afterPiEvent: toolCallRef, sequence: 1 },
      relatedPiEvents: [toolCallRef],
      data: { operation, path: workerPath, outcome: 'succeeded', output },
    };
    const block = reduce(event).blocks.find((item) => item.kind === 'lifecycle');
    expect(block?.transcriptText).toContain(output);
    expect(block?.actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: action, path: workerPath })]));
  });

  it('shows lifecycle failure rather than claiming a successful resurrection', () => {
    const event: SubagentSemanticEvent = {
      eventId: 'resurrect-failed',
      kind: 'lifecycle',
      placement: { afterPiEvent: toolCallRef, sequence: 1 },
      relatedPiEvents: [toolCallRef],
      data: { operation: 'resurrect', path: scoutPath, outcome: 'failed', error: 'Saved session not found.' },
    };
    const block = reduce(event).blocks.find((item) => item.kind === 'lifecycle');
    expect(block?.transcriptText).toContain('Saved session not found.');
    expect(block?.actions).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'open_view', path: scoutPath })]));
  });
});

type WireThreadData = Extract<WireSubagentSemanticEvent, { kind: 'message_thread' }>['data'];

function wireDelegation(awaitsResult: boolean): WireSubagentSemanticEvent {
  return {
    type: 'subagent_event',
    sessionId,
    cursor: 101,
    providerCursor: { epoch: 'provider-1', sequence: 1 },
    eventId: 'wire-delegation',
    path: workerPath,
    kind: 'delegation',
    relatedPiEvents: [toolCallRef],
    data: { invocationId: 'wire-invocation', awaitsResult, children: [{ path: workerPath, task: 'Review callback ownership.', persona: 'reviewer' }] },
  };
}

function wireCompletion(delivery: 'awaited' | 'asynchronous', ref: PiEventRef): WireSubagentSemanticEvent {
  return {
    type: 'subagent_event',
    sessionId,
    cursor: 103,
    providerCursor: { epoch: 'provider-1', sequence: 3 },
    eventId: 'wire-completion',
    path: workerPath,
    kind: 'completion',
    relatedPiEvents: [ref],
    data: {
      delivery,
      invocationId: 'wire-invocation',
      status: 'idle',
      output: 'Callback ownership belongs to the session store.',
      usage: { input: 1800, output: 420, cacheRead: 0, cacheWrite: 0, cost: 0.02, turns: 2 },
    },
  };
}

function wireThread(eventId: string, cursor: number, data: WireThreadData, ref: PiEventRef): WireSubagentSemanticEvent {
  return {
    type: 'subagent_event',
    sessionId,
    cursor,
    providerCursor: { epoch: 'provider-1', sequence: cursor - 100 },
    eventId,
    path: workerPath,
    kind: 'message_thread',
    relatedPiEvents: [ref],
    data,
  };
}

const sendRef: PiEventRef = { sessionId, entryId: 'send-tool', toolCallId: 'send-call', kind: 'tool_call' };
const receivedRef: PiEventRef = { sessionId, entryId: 'received-message', kind: 'custom_message' };
const responseRef: PiEventRef = { sessionId, entryId: 'response-message', kind: 'custom_message' };
const failureRef: PiEventRef = { sessionId, entryId: 'failure-message', kind: 'custom_message' };
const communicationEntries: readonly NativeTranscriptEntry[] = [
  { sessionId, id: 'before', kind: 'message', text: 'Before communication.' },
  { sessionId, id: 'send-tool', toolCallId: 'send-call', kind: 'tool_call', text: 'generic send' },
  { sessionId, id: 'send-result', toolCallId: 'send-call', kind: 'tool_result', text: 'generic send result' },
  { sessionId, id: 'received-message', kind: 'custom_message', text: 'generic received message' },
  { sessionId, id: 'between', kind: 'message', text: 'Work continued.' },
  { sessionId, id: 'response-message', kind: 'custom_message', text: 'generic reply' },
  { sessionId, id: 'failure-message', kind: 'custom_message', text: 'generic failure' },
  { sessionId, id: 'after', kind: 'message', text: 'After communication.' },
];

describe('subagent wire transcript boundary', () => {
  it('maps an awaited delegation and completion into its native invocation block', () => {
    const items = projectSubagentWireTranscript(nativeEntries, [wireDelegation(true), wireCompletion('awaited', toolCallRef)]);
    const delegation = items.find((item) => item.kind === 'semantic' && item.block.kind === 'delegation');
    expect(delegation?.kind).toBe('semantic');
    if (delegation?.kind !== 'semantic' || delegation.block.kind !== 'delegation') throw new Error('missing delegation');
    expect(delegation.block.transcriptText).toContain('Review callback ownership.');
    expect(delegation.block.transcriptText).toContain('Callback ownership belongs to the session store.');
    expect(delegation.block.data.children).toEqual(expect.arrayContaining([expect.objectContaining({ path: workerPath, prompt: 'Review callback ownership.' })]));
    expect(delegation.block.data.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: workerPath,
          state: 'idle',
          costUsd: 0.02,
          usage: expect.objectContaining({ inputTokens: 1800, outputTokens: 420 }),
        }),
      ]),
    );
    expect(items.some((item) => item.kind === 'semantic' && item.block.kind === 'completion')).toBe(false);
    expect(items.some((item) => item.kind === 'native' && (item.entry.id === 'tool-1' || item.entry.id === 'result-1'))).toBe(false);
  });

  it('maps an asynchronous completion at its native notification without rewriting delegation', () => {
    const before = projectSubagentWireTranscript(nativeEntries, [wireDelegation(false)]);
    const items = projectSubagentWireTranscript(nativeEntries, [wireDelegation(false), wireCompletion('asynchronous', notificationRef)]);
    const prior = before.find((item) => item.kind === 'semantic' && item.block.kind === 'delegation');
    const delegation = items.find((item) => item.kind === 'semantic' && item.block.kind === 'delegation');
    expect(delegation?.kind === 'semantic' && delegation.block.transcriptText).toBe(prior?.kind === 'semantic' && prior.block.transcriptText);
    const delegationIndex = items.findIndex((item) => item.kind === 'semantic' && item.block.kind === 'delegation');
    const completionIndex = items.findIndex((item) => item.kind === 'semantic' && item.block.kind === 'completion');
    expect(completionIndex).toBeGreaterThan(delegationIndex);
    expect(completionIndex).toBeLessThan(items.findIndex((item) => item.kind === 'native' && item.entry.id === 'other-1'));
    const completion = items[completionIndex];
    expect(completion?.kind === 'semantic' && completion.block.transcriptText).toContain('Callback ownership belongs to the session store.');
    expect(items.some((item) => item.kind === 'native' && item.entry.id === 'notice-1')).toBe(false);
  });

  it('groups sent, received and response phases at the reply position without rewriting the pending block', () => {
    const request = 'Can you confirm whether the callback route owns the session mutation?';
    const reply = 'Callback ownership belongs to the session store.';
    const sent = wireThread(
      'sent',
      101,
      {
        phase: 'sent',
        from: workerPath,
        to: scoutPath,
        text: request,
        correlationId: 'corr-17',
        responseExpected: true,
      },
      sendRef,
    );
    const received = wireThread(
      'received',
      102,
      {
        phase: 'received',
        from: workerPath,
        to: scoutPath,
        text: request,
        correlationId: 'corr-17',
        responseExpected: true,
      },
      receivedRef,
    );
    const response = wireThread(
      'response',
      103,
      {
        phase: 'response',
        from: scoutPath,
        to: workerPath,
        text: reply,
        correlationId: 'corr-17',
        responseExpected: false,
      },
      responseRef,
    );
    const pending = projectSubagentWireTranscript(communicationEntries, [sent, received]);
    const pendingBlock = pending.find((item) => item.kind === 'semantic' && item.block.kind === 'message_thread' && item.block.data.request === request && !item.block.data.reply);
    expect(pendingBlock?.kind).toBe('semantic');
    const items = projectSubagentWireTranscript(communicationEntries, [sent, received, response]);
    const pendingIndex = items.findIndex(
      (item) => item.kind === 'semantic' && item.block.kind === 'message_thread' && item.block.data.request === request && !item.block.data.reply,
    );
    const replyIndex = items.findIndex(
      (item) => item.kind === 'semantic' && item.block.kind === 'message_thread' && item.block.data.correlationId === 'corr-17' && item.block.data.reply === reply,
    );
    expect(pendingIndex).toBeGreaterThanOrEqual(0);
    expect(replyIndex).toBeGreaterThan(items.findIndex((item) => item.kind === 'native' && item.entry.id === 'between'));
    expect(replyIndex).toBeLessThan(items.findIndex((item) => item.kind === 'native' && item.entry.id === 'after'));
    const grouped = items[replyIndex];
    if (grouped?.kind !== 'semantic' || grouped.block.kind !== 'message_thread') throw new Error('missing response thread');
    expect(grouped.block.data).toMatchObject({ sourcePath: workerPath, targetPath: scoutPath, request, reply });
    expect(grouped.block.transcriptText).toContain(request);
    expect(grouped.block.transcriptText).toContain(reply);
    expect(items.some((item) => item.kind === 'native' && item.entry.id === 'response-message')).toBe(false);
    expect(communicationEntries.find((entry) => entry.id === 'response-message')?.text).toBe('generic reply');
  });

  it('groups a failed request with its failure at the failure position', () => {
    const sent = wireThread(
      'sent-fail',
      101,
      {
        phase: 'sent',
        from: workerPath,
        to: scoutPath,
        text: 'Check the redirect.',
        correlationId: 'corr-failed',
        responseExpected: true,
      },
      sendRef,
    );
    const failure = wireThread(
      'failure',
      102,
      {
        phase: 'failure',
        from: workerPath,
        to: scoutPath,
        text: 'Check the redirect.',
        correlationId: 'corr-failed',
        responseExpected: true,
        error: 'The recipient is unavailable.',
      },
      failureRef,
    );
    const items = projectSubagentWireTranscript(communicationEntries, [sent, failure]);
    const failureIndex = items.findIndex((item) => item.kind === 'semantic' && item.block.kind === 'message_thread' && item.block.data.failure === 'The recipient is unavailable.');
    expect(failureIndex).toBeGreaterThan(items.findIndex((item) => item.kind === 'native' && item.entry.id === 'between'));
    const grouped = items[failureIndex];
    if (grouped?.kind !== 'semantic' || grouped.block.kind !== 'message_thread') throw new Error('missing failed thread');
    expect(grouped.block.data).toMatchObject({ correlationId: 'corr-failed', sourcePath: workerPath, targetPath: scoutPath, request: 'Check the redirect.' });
    expect(grouped.block.transcriptText).toContain('Check the redirect.');
    expect(grouped.block.transcriptText).toContain('The recipient is unavailable.');
  });

  it('preserves incoming uncorrelated text and its source and target', () => {
    const received = wireThread(
      'incoming',
      101,
      {
        phase: 'received',
        from: scoutPath,
        to: workerPath,
        text: 'The callback route does not own the mutation.',
        responseExpected: false,
      },
      receivedRef,
    );
    const items = projectSubagentWireTranscript(communicationEntries, [received]);
    const incoming = items.find((item) => item.kind === 'semantic' && item.block.kind === 'message_thread');
    if (incoming?.kind !== 'semantic' || incoming.block.kind !== 'message_thread') throw new Error('missing incoming message');
    expect(incoming.block.data).toMatchObject({ sourcePath: scoutPath, targetPath: workerPath, request: 'The callback route does not own the mutation.' });
    expect(incoming.block.transcriptText).toContain('The callback route does not own the mutation.');
  });

  it('keeps native fallback for unmatched and non-renderable events, including another session with the same ids', () => {
    const otherSession: NativeTranscriptEntry = { sessionId: 'other-session', id: 'tool-1', toolCallId: 'call-1', kind: 'tool_call', text: 'Other session tool.' };
    const missingRef: PiEventRef = { sessionId, entryId: 'missing', toolCallId: 'missing-call', kind: 'tool_call' };
    const delegation = wireDelegation(false);
    const unmatched = { ...delegation, relatedPiEvents: [missingRef] };
    const topology: WireSubagentSemanticEvent = {
      type: 'subagent_event',
      sessionId,
      cursor: 102,
      eventId: 'node-updated',
      path: workerPath,
      kind: 'node_updated',
      relatedPiEvents: [notificationRef],
      data: { ...workerNode, sessionId: 'child-replaced', incarnation: 'worker-incarnation' },
    };
    const entries = [...nativeEntries, otherSession];
    const items = projectSubagentWireTranscript(entries, [unmatched, topology]);
    expect(items.filter((item) => item.kind === 'native').map((item) => item.entry)).toEqual(entries);

    const matched = projectSubagentWireTranscript(entries, [delegation]);
    expect(matched.some((item) => item.kind === 'native' && item.entry.sessionId === 'other-session' && item.entry.id === 'tool-1')).toBe(true);
    expect(matched.some((item) => item.kind === 'native' && item.entry.id === 'other-1')).toBe(true);
  });
});
