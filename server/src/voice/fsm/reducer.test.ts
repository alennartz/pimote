import { describe, it, expect } from 'vitest';
import { reduce } from './reducer.js';
import { initialState, type RuntimeState } from './state.js';
import type { Action } from './actions.js';

const config = { defaultInterpreterModel: { provider: 'p', modelId: 'm' } };

function step(state: RuntimeState, event: Parameters<typeof reduce>[1]): { next: RuntimeState; actions: Action[] } {
  return reduce(state, event, { config });
}

/** Drive dormant → activating → active for sessionId. */
function activate(sessionId: string): RuntimeState {
  let state = initialState();
  state = step(state, { type: 'eb:activate', msg: { type: 'pimote:voice:activate', sessionId, speechmuxWsUrl: 'ws://x' } }).next;
  state = step(state, { type: 'ws:opened' }).next;
  expect(state.lifecycle.kind).toBe('active');
  return state;
}

describe('voice FSM — emit_deactivate_request carries sessionId (M1)', () => {
  it('ws:disconnected from active emits deactivate with the live sessionId', () => {
    const state = activate('sess-42');
    const { next, actions } = step(state, { type: 'ws:disconnected' });
    expect(next.lifecycle.kind).toBe('dormant');
    const deactivate = actions.find((a) => a.kind === 'emit_deactivate_request');
    expect(deactivate).toEqual({ kind: 'emit_deactivate_request', sessionId: 'sess-42' });
  });

  it('ws:open_failed from activating emits deactivate with the sessionId', () => {
    let state = initialState();
    state = step(state, { type: 'eb:activate', msg: { type: 'pimote:voice:activate', sessionId: 'sess-7', speechmuxWsUrl: 'ws://x' } }).next;
    expect(state.lifecycle.kind).toBe('activating');
    const { actions } = step(state, { type: 'ws:open_failed', error: new Error('boom') });
    expect(actions.find((a) => a.kind === 'emit_deactivate_request')).toEqual({ kind: 'emit_deactivate_request', sessionId: 'sess-7' });
  });
});

describe('voice FSM — activation steers rather than aborts (M7)', () => {
  it('eb:activate emits the start sentinel with deliverAs:steer', () => {
    const { actions } = step(initialState(), {
      type: 'eb:activate',
      msg: { type: 'pimote:voice:activate', sessionId: 'sess-1', speechmuxWsUrl: 'ws://x' },
    });
    const sentinel = actions.find((a) => a.kind === 'send_user_message');
    expect(sentinel).toMatchObject({ kind: 'send_user_message', deliverAs: 'steer' });
  });
});

describe('voice FSM — turn_end/agent_end routed through the buffer (M2)', () => {
  it('sdk:turn_end while active passes a floor_released send_frame', () => {
    const state = activate('s');
    const { actions } = step(state, { type: 'sdk:turn_end', lastSpeakToolCallId: 'spk1' });
    expect(actions).toContainEqual({ kind: 'send_frame', frame: { type: 'floor_released', speak_id: 'spk1' } });
  });

  it('sdk:turn_end while activating is buffered, then flushed on ws:opened', () => {
    let state = initialState();
    state = step(state, { type: 'eb:activate', msg: { type: 'pimote:voice:activate', sessionId: 's', speechmuxWsUrl: 'ws://x' } }).next;
    expect(state.lifecycle.kind).toBe('activating');

    const turnEnd = step(state, { type: 'sdk:turn_end', lastSpeakToolCallId: 'spk1' });
    // Buffered, not sent: no send_frame action yet.
    expect(turnEnd.actions.some((a) => a.kind === 'send_frame')).toBe(false);
    state = turnEnd.next;

    const opened = step(state, { type: 'ws:opened' });
    expect(opened.actions).toContainEqual({ kind: 'send_frame', frame: { type: 'floor_released', speak_id: 'spk1' } });
  });

  it('sdk:agent_end with no error produces no frame', () => {
    const state = activate('s');
    const { actions } = step(state, { type: 'sdk:agent_end', error: null });
    expect(actions.some((a) => a.kind === 'send_frame')).toBe(false);
  });
});

describe('voice FSM — in-flight speak targeting (gap 2)', () => {
  it('an abort with no speak_id targets the still-streaming speak, not the last completed one', () => {
    let state = activate('s');
    // A completed speak sets lastEmittedSpeakId='old'.
    state = step(state, { type: 'sdk:toolcall_end', contentIndex: 0, toolCall: { id: 'old', name: 'speak', arguments: { text: 'done' } } }).next;
    expect(state.lastEmittedSpeakId).toBe('old');
    // A second speak starts streaming (index 1) and stays mid-flight.
    state = step(state, { type: 'sdk:toolcall_start', contentIndex: 1, partial: { content: [{}, { name: 'speak', id: 'inflight' }] } }).next;

    // Abort with no echoed speak_id should target the in-flight speak.
    const { next } = step(state, { type: 'ws:incoming', frame: { type: 'abort', reason: 'barge_in' } });
    expect(next.walkback).toMatchObject({ kind: 'pending', targetSpeakToolCallId: 'inflight' });
  });
});

describe('voice FSM — walkback gated on lifecycle (H3)', () => {
  it('an abort frame while dormant does NOT abort the agent', () => {
    const state = initialState();
    expect(state.lifecycle.kind).toBe('dormant');
    const { actions } = step(state, { type: 'ws:incoming', frame: { type: 'abort', reason: 'barge_in' } });
    expect(actions.some((a) => a.kind === 'abort_agent')).toBe(false);
    expect(actions.some((a) => a.kind === 'append_custom_entry')).toBe(false);
  });

  it('an abort frame while active DOES abort the agent', () => {
    const state = activate('sess-1');
    const { actions } = step(state, { type: 'ws:incoming', frame: { type: 'abort', reason: 'barge_in' } });
    expect(actions.some((a) => a.kind === 'abort_agent')).toBe(true);
  });
});
