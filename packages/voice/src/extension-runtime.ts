// Voice extension runtime — pure reducers that turn incoming stimuli
// (EventBus messages, speechmux frames, captured streaming snapshots) into
// `VoiceAction[]` the outer wiring layer executes against the pi SDK.
//
// Keeping this as a pure function makes the extension's behavioural contract
// testable without a running pi session, without a speechmux WS, and without
// real timers. The impl phase will wire it to the real ExtensionAPI.

import type { VoiceInterruptEntryData } from '@pimote/shared';
import { VOICE_INTERRUPT_CUSTOM_TYPE } from '@pimote/shared';
import type { VoiceExtensionState, VoiceActivateMessage, VoiceDeactivateMessage } from './state-machine.js';
import { VOICE_CALL_STARTED_SENTINEL } from './state-machine.js';
import type { IncomingFrame } from './speechmux-client.js';

// --- Action DSL the outer wiring layer executes. ---

export type VoiceAction =
  | { kind: 'open_speechmux'; wsUrl: string }
  | { kind: 'close_speechmux' }
  | { kind: 'send_user_message'; text: string; deliverAs?: 'steer' | 'followUp' }
  | { kind: 'abort' }
  | { kind: 'set_walkback_watermark'; heardText: string }
  | { kind: 'clear_walkback_watermark' }
  | { kind: 'append_custom_entry'; customType: string; data: VoiceInterruptEntryData }
  | { kind: 'set_model'; provider: string; modelId: string }
  | { kind: 'emit_deactivate_request' }
  | { kind: 'stream_speechmux_token'; text: string }
  | { kind: 'emit_speechmux_end' }
  | { kind: 'return_speak_tool_result' };

// --- Runtime state. Small and fully inspectable by tests. ---

export interface VoiceRuntimeState {
  state: VoiceExtensionState;
  sessionId: string | null;
  /** True once the first activation on this session has set the interpreter model. */
  interpreterModelApplied: boolean;
}

export function initialRuntimeState(): VoiceRuntimeState {
  return { state: 'dormant', sessionId: null, interpreterModelApplied: false };
}

export interface RuntimeConfig {
  defaultInterpreterModel: { provider: string; modelId: string };
}

// --- Reducers. Each takes (state, stimulus) and returns (nextState, actions). ---

/** Reducer for a `pimote:voice:activate` EventBus message. */
export function reduceActivate(prev: VoiceRuntimeState, msg: VoiceActivateMessage, _config: RuntimeConfig): { next: VoiceRuntimeState; actions: VoiceAction[] } {
  if (prev.state !== 'dormant') {
    // Ignore duplicate / out-of-order activates.
    return { next: prev, actions: [] };
  }
  const actions: VoiceAction[] = [{ kind: 'open_speechmux', wsUrl: msg.speechmuxWsUrl }];
  return {
    next: { ...prev, state: 'activating', sessionId: msg.sessionId },
    actions,
  };
}

/** Reducer for speechmux WS successfully opened — runtime transitions to `active`. */
export function reduceSpeechmuxOpened(prev: VoiceRuntimeState, config: RuntimeConfig): { next: VoiceRuntimeState; actions: VoiceAction[] } {
  if (prev.state !== 'activating') {
    return { next: prev, actions: [] };
  }
  const actions: VoiceAction[] = [];
  if (!prev.interpreterModelApplied) {
    actions.push({ kind: 'set_model', provider: config.defaultInterpreterModel.provider, modelId: config.defaultInterpreterModel.modelId });
  }
  actions.push({ kind: 'send_user_message', text: VOICE_CALL_STARTED_SENTINEL });
  return {
    next: { ...prev, state: 'active', interpreterModelApplied: true },
    actions,
  };
}

/** Reducer for speechmux WS failure during activation. */
export function reduceSpeechmuxFailed(prev: VoiceRuntimeState): { next: VoiceRuntimeState; actions: VoiceAction[] } {
  if (prev.state !== 'activating') {
    return { next: prev, actions: [] };
  }
  return {
    next: { ...prev, state: 'dormant' },
    actions: [{ kind: 'emit_deactivate_request' }],
  };
}

/** Reducer for `pimote:voice:deactivate`. */
export function reduceDeactivate(prev: VoiceRuntimeState, _msg: VoiceDeactivateMessage): { next: VoiceRuntimeState; actions: VoiceAction[] } {
  if (prev.state === 'dormant') {
    return { next: prev, actions: [] };
  }
  return {
    next: { state: 'dormant', sessionId: null, interpreterModelApplied: prev.interpreterModelApplied },
    actions: [{ kind: 'close_speechmux' }, { kind: 'clear_walkback_watermark' }],
  };
}

/** Reducer for an incoming speechmux frame. No-op unless `state === 'active'`. */
export function reduceSpeechmuxFrame(prev: VoiceRuntimeState, frame: IncomingFrame): { next: VoiceRuntimeState; actions: VoiceAction[] } {
  if (prev.state !== 'active') {
    return { next: prev, actions: [] };
  }
  switch (frame.type) {
    case 'user':
      return { next: prev, actions: [{ kind: 'send_user_message', text: frame.text }] };
    case 'abort': {
      const data: VoiceInterruptEntryData = { heard_text: '', kind: 'abort' };
      return {
        next: prev,
        actions: [{ kind: 'abort' }, { kind: 'set_walkback_watermark', heardText: '' }, { kind: 'append_custom_entry', customType: VOICE_INTERRUPT_CUSTOM_TYPE, data }],
      };
    }
    case 'rollback': {
      const data: VoiceInterruptEntryData = { heard_text: frame.heard_text, kind: 'rollback' };
      return {
        next: prev,
        actions: [
          { kind: 'abort' },
          { kind: 'set_walkback_watermark', heardText: frame.heard_text },
          { kind: 'append_custom_entry', customType: VOICE_INTERRUPT_CUSTOM_TYPE, data },
        ],
      };
    }
  }
}

/**
 * Reducer for the `tool_call` hook firing on a `speak(...)` invocation.
 * While active, streams the text to speechmux as a token frame and returns a
 * trivial success result so the agent loop advances. No-op while not active.
 */
export function reduceSpeakToolCall(prev: VoiceRuntimeState, args: { text: string }): { next: VoiceRuntimeState; actions: VoiceAction[] } {
  if (prev.state !== 'active') {
    return { next: prev, actions: [] };
  }
  return {
    next: prev,
    actions: [{ kind: 'stream_speechmux_token', text: args.text }, { kind: 'return_speak_tool_result' }],
  };
}

/**
 * Reducer for the assistant turn's tool-call batch completing (turn_end).
 * While active, flushes an `{type:"end"}` frame to speechmux. No-op while
 * not active.
 */
export function reduceTurnEnd(prev: VoiceRuntimeState): { next: VoiceRuntimeState; actions: VoiceAction[] } {
  if (prev.state !== 'active') {
    return { next: prev, actions: [] };
  }
  return { next: prev, actions: [{ kind: 'emit_speechmux_end' }] };
}
