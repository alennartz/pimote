// Tests for the voice extension runtime reducers.
// These assert the contract from docs/plans/voice-mode.md
// ("Voice extension" / "Speechmux frame handling") without running a real pi
// session, speechmux WS, or WebRTC peer.

import { describe, it, expect } from 'vitest';
import { VOICE_INTERRUPT_CUSTOM_TYPE } from '../../../shared/dist/index.js';
import {
  initialRuntimeState,
  reduceActivate,
  reduceDeactivate,
  reduceSpeakToolCall,
  reduceSpeakToolDelta,
  reduceSpeechmuxFailed,
  reduceSpeechmuxFrame,
  reduceSpeechmuxOpened,
  reduceTurnEnd,
  type VoiceAction,
  type RuntimeConfig,
} from './extension-runtime.js';
import { VOICE_CALL_STARTED_SENTINEL, type VoiceActivateMessage, type VoiceDeactivateMessage } from './state-machine.js';
import type { IncomingFrame } from './speechmux-client.js';

const config: RuntimeConfig = {
  defaultInterpreterModel: { provider: 'anthropic', modelId: 'claude-x-interpreter' },
};

const activate: VoiceActivateMessage = {
  type: 'pimote:voice:activate',
  sessionId: 'sess-1',
  speechmuxWsUrl: 'ws://speechmux.internal/llm',
};

const deactivate: VoiceDeactivateMessage = { type: 'pimote:voice:deactivate', sessionId: 'sess-1' };

function actionKinds(actions: VoiceAction[]): string[] {
  return actions.map((a) => a.kind);
}

// =============================================================================

describe('reduceActivate', () => {
  it('transitions dormant → active in one step (pre-warm) and emits set_model, sentinel, and open_speechmux', () => {
    const { next, actions } = reduceActivate(initialRuntimeState(), activate, config);
    expect(next.state).toBe('active');
    expect(next.sessionId).toBe('sess-1');
    expect(next.interpreterModelApplied).toBe(true);
    expect(actionKinds(actions)).toEqual(['set_model', 'send_user_message', 'open_speechmux']);
    const setModel = actions[0] as { kind: 'set_model'; provider: string; modelId: string };
    expect(setModel.provider).toBe('anthropic');
    expect(setModel.modelId).toBe('claude-x-interpreter');
    const sendMsg = actions[1] as { kind: 'send_user_message'; text: string };
    expect(sendMsg.text).toBe(VOICE_CALL_STARTED_SENTINEL);
    const open = actions[2] as { kind: 'open_speechmux'; wsUrl: string };
    expect(open.wsUrl).toBe(activate.speechmuxWsUrl);
  });

  it('skips setting the interpreter model on re-activation of the same session', () => {
    let s = initialRuntimeState();
    s = reduceActivate(s, activate, config).next;
    s = reduceDeactivate(s, deactivate).next;
    const { next, actions } = reduceActivate(s, activate, config);
    expect(next.state).toBe('active');
    expect(actionKinds(actions)).toEqual(['send_user_message', 'open_speechmux']);
  });

  it('ignores duplicate activate while already active', () => {
    const s1 = reduceActivate(initialRuntimeState(), activate, config).next;
    const { next, actions } = reduceActivate(s1, activate, config);
    expect(next).toEqual(s1);
    expect(actions).toEqual([]);
  });
});

describe('reduceSpeechmuxOpened', () => {
  it('is an inert hook now that activation is single-step — no state change, no actions', () => {
    const s1 = reduceActivate(initialRuntimeState(), activate, config).next;
    const { next, actions } = reduceSpeechmuxOpened(s1, config);
    expect(next).toEqual(s1);
    expect(actions).toEqual([]);
  });

  it('is a no-op when called from dormant too', () => {
    const { next, actions } = reduceSpeechmuxOpened(initialRuntimeState(), config);
    expect(next.state).toBe('dormant');
    expect(actions).toEqual([]);
  });
});

describe('reduceSpeechmuxFailed', () => {
  it('returns to dormant and requests deactivate when active', () => {
    const s1 = reduceActivate(initialRuntimeState(), activate, config).next;
    const { next, actions } = reduceSpeechmuxFailed(s1);
    expect(next.state).toBe('dormant');
    expect(actions).toEqual([{ kind: 'emit_deactivate_request' }]);
  });

  it('is a no-op while dormant', () => {
    const res = reduceSpeechmuxFailed(initialRuntimeState());
    expect(res.actions).toEqual([]);
  });
});

describe('reduceDeactivate', () => {
  it('closes speechmux and clears walk-back watermark from active state', () => {
    let s = initialRuntimeState();
    s = reduceActivate(s, activate, config).next;
    const { next, actions } = reduceDeactivate(s, deactivate);
    expect(next.state).toBe('dormant');
    expect(next.sessionId).toBeNull();
    expect(actionKinds(actions)).toEqual(['close_speechmux', 'clear_walkback_watermark']);
  });

  it('is a no-op when already dormant', () => {
    const { next, actions } = reduceDeactivate(initialRuntimeState(), deactivate);
    expect(next.state).toBe('dormant');
    expect(actions).toEqual([]);
  });
});

describe('reduceSpeechmuxFrame (active state)', () => {
  function activeState() {
    return reduceActivate(initialRuntimeState(), activate, config).next;
  }

  it('user frame → send_user_message with the raw text', () => {
    const s = activeState();
    const frame: IncomingFrame = { type: 'user', text: 'hello there' };
    const { actions } = reduceSpeechmuxFrame(s, frame);
    expect(actions).toEqual([{ kind: 'send_user_message', text: 'hello there' }]);
  });

  it('abort frame → abort, watermark := "", persisted interrupt marker', () => {
    const s = activeState();
    const { actions } = reduceSpeechmuxFrame(s, { type: 'abort' });
    expect(actionKinds(actions)).toEqual(['abort', 'set_walkback_watermark', 'append_custom_entry']);
    expect(actions[1]).toMatchObject({ heardText: '' });
    expect(actions[2]).toMatchObject({
      customType: VOICE_INTERRUPT_CUSTOM_TYPE,
      data: { heard_text: '', kind: 'abort' },
    });
  });

  it('rollback frame → abort, watermark := heard_text, persisted marker carries heard_text', () => {
    const s = activeState();
    const { actions } = reduceSpeechmuxFrame(s, { type: 'rollback', heard_text: 'hello wor' });
    expect(actionKinds(actions)).toEqual(['abort', 'set_walkback_watermark', 'append_custom_entry']);
    expect(actions[1]).toMatchObject({ heardText: 'hello wor' });
    expect(actions[2]).toMatchObject({
      customType: VOICE_INTERRUPT_CUSTOM_TYPE,
      data: { heard_text: 'hello wor', kind: 'rollback' },
    });
  });
});

describe('reduceSpeechmuxFrame (non-active state)', () => {
  it('ignores frames when dormant', () => {
    const { actions } = reduceSpeechmuxFrame(initialRuntimeState(), { type: 'user', text: 'hi' });
    expect(actions).toEqual([]);
  });
});

describe('reduceSpeakToolCall', () => {
  function activeState() {
    return reduceActivate(initialRuntimeState(), activate, config).next;
  }

  it('while active, streams the speak text as a token frame and returns a trivial tool_result', () => {
    const { actions } = reduceSpeakToolCall(activeState(), { text: 'hello there' });
    expect(actionKinds(actions)).toEqual(['stream_speechmux_token', 'return_speak_tool_result']);
    expect(actions[0]).toMatchObject({ text: 'hello there' });
  });

  it('no-op while dormant', () => {
    const { actions } = reduceSpeakToolCall(initialRuntimeState(), { text: 'hello' });
    expect(actions).toEqual([]);
  });

  it('skips the bulk token frame when alreadyStreamed is true', () => {
    const { actions } = reduceSpeakToolCall(activeState(), { text: 'hello there', alreadyStreamed: true });
    expect(actionKinds(actions)).toEqual(['return_speak_tool_result']);
  });
});

describe('reduceSpeakToolDelta', () => {
  function activeState() {
    return reduceActivate(initialRuntimeState(), activate, config).next;
  }

  it('emits a stream_speechmux_token action carrying the fragment while active', () => {
    const { actions } = reduceSpeakToolDelta(activeState(), { fragment: 'Okay' });
    expect(actions).toEqual([{ kind: 'stream_speechmux_token', text: 'Okay' }]);
  });

  it('is a no-op for an empty fragment', () => {
    const { actions } = reduceSpeakToolDelta(activeState(), { fragment: '' });
    expect(actions).toEqual([]);
  });

  it('is a no-op while dormant', () => {
    expect(reduceSpeakToolDelta(initialRuntimeState(), { fragment: 'x' }).actions).toEqual([]);
  });
});

describe('reduceTurnEnd', () => {
  function activeState() {
    return reduceActivate(initialRuntimeState(), activate, config).next;
  }

  it('while active, emits an end frame to speechmux', () => {
    const { actions } = reduceTurnEnd(activeState());
    expect(actions).toEqual([{ kind: 'emit_speechmux_end' }]);
  });

  it('no-op while dormant', () => {
    expect(reduceTurnEnd(initialRuntimeState()).actions).toEqual([]);
  });
});
