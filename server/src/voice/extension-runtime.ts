// Voice extension runtime — pure reducers that turn incoming stimuli
// (EventBus messages, speechmux frames, captured streaming snapshots) into
// `VoiceAction[]` the outer wiring layer executes against the pi SDK.
//
// Keeping this as a pure function makes the extension's behavioural contract
// testable without a running pi session, without a speechmux WS, and without
// real timers. The impl phase will wire it to the real ExtensionAPI.

import type { VoiceInterruptEntryData } from '../../../shared/dist/index.js';
import { VOICE_INTERRUPT_CUSTOM_TYPE } from '../../../shared/dist/index.js';
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

/**
 * Reducer for a `pimote:voice:activate` EventBus message.
 *
 * Pre-warm path: transitions straight from dormant to active and emits the
 * action sequence that
 *  1. switches to the interpreter model (first activation only),
 *  2. injects the `<voice_call_started/>` sentinel — sendUserMessage returns
 *     immediately and kicks off the interpreter LLM turn in the background,
 *  3. opens the speechmux WS — the executor awaits this, but the LLM is
 *     already running by the time we get here, so the WS handshake and the
 *     greeting LLM turn overlap. Speak tokens that arrive before the WS is
 *     open are buffered by the wiring layer and flushed on open.
 */
export function reduceActivate(prev: VoiceRuntimeState, msg: VoiceActivateMessage, config: RuntimeConfig): { next: VoiceRuntimeState; actions: VoiceAction[] } {
  if (prev.state !== 'dormant') {
    // Ignore duplicate / out-of-order activates.
    return { next: prev, actions: [] };
  }
  const actions: VoiceAction[] = [];
  if (!prev.interpreterModelApplied) {
    actions.push({ kind: 'set_model', provider: config.defaultInterpreterModel.provider, modelId: config.defaultInterpreterModel.modelId });
  }
  actions.push({ kind: 'send_user_message', text: VOICE_CALL_STARTED_SENTINEL });
  actions.push({ kind: 'open_speechmux', wsUrl: msg.speechmuxWsUrl });
  return {
    next: { ...prev, state: 'active', sessionId: msg.sessionId, interpreterModelApplied: true },
    actions,
  };
}

/**
 * Reducer for speechmux WS successfully opened.
 *
 * With the pre-warm activation path, the runtime is already `active` by
 * the time the WS finishes opening; this reducer is now an inert hook kept
 * for back-compat with the wiring layer and existing tests. The wiring
 * layer is responsible for flushing any speak tokens that were buffered
 * during the WS handshake.
 */
export function reduceSpeechmuxOpened(prev: VoiceRuntimeState, _config: RuntimeConfig): { next: VoiceRuntimeState; actions: VoiceAction[] } {
  return { next: prev, actions: [] };
}

/**
 * Reducer for speechmux WS failure.
 *
 * Triggered from the wiring layer when the WS handshake rejects. Drops the
 * runtime back to dormant and asks the orchestrator to deactivate; the
 * deactivate path then closes (a possibly-already-closed) client and clears
 * the pending speak-frame buffer. Any in-flight greeting LLM turn keeps
 * running but its speak tokens hit the dormant guard and no-op.
 */
export function reduceSpeechmuxFailed(prev: VoiceRuntimeState): { next: VoiceRuntimeState; actions: VoiceAction[] } {
  if (prev.state !== 'active') {
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
 *
 * If `alreadyStreamed` is true, the wiring layer has already forwarded this
 * tool's text to speechmux incrementally via `reduceSpeakToolDelta` while
 * the LLM was emitting it (low-latency path). In that case we skip the
 * token frame to avoid double-speaking and only emit the trivial result.
 */
export function reduceSpeakToolCall(prev: VoiceRuntimeState, args: { text: string; alreadyStreamed?: boolean }): { next: VoiceRuntimeState; actions: VoiceAction[] } {
  if (prev.state !== 'active') {
    return { next: prev, actions: [] };
  }
  const actions: VoiceAction[] = [];
  if (!args.alreadyStreamed) {
    actions.push({ kind: 'stream_speechmux_token', text: args.text });
  }
  actions.push({ kind: 'return_speak_tool_result' });
  return { next: prev, actions };
}

/**
 * Reducer for an incremental fragment of a `speak(...)` tool argument as it
 * streams from the LLM. The wiring layer is responsible for parsing the
 * provider's JSON-delta stream (via `@streamparser/json`) and feeding only
 * the freshly-revealed suffix of `text` into this reducer.
 *
 * No-op while not active or when the fragment is empty.
 */
export function reduceSpeakToolDelta(prev: VoiceRuntimeState, args: { fragment: string }): { next: VoiceRuntimeState; actions: VoiceAction[] } {
  if (prev.state !== 'active') {
    return { next: prev, actions: [] };
  }
  if (args.fragment.length === 0) {
    return { next: prev, actions: [] };
  }
  return {
    next: prev,
    actions: [{ kind: 'stream_speechmux_token', text: args.fragment }],
  };
}

/**
 * Reducer for a single `speak(...)` tool call finishing — the LLM has
 * emitted the closing `}` of the tool_use block for this speak.
 *
 * While active, flushes an `{type:"end"}` frame to speechmux so each
 * `speak()` call becomes its own finalized utterance. This is called from
 * the wiring layer's `toolcall_end` handler, after any tail tokens have
 * been forwarded.
 *
 * Per-speak granularity (vs per-message) gives speechmux clean idle gaps
 * between utterances — which simplifies barge-in semantics and matches
 * the interpreter prompt's framing of each `speak(text)` call as a
 * complete short utterance.
 *
 * The wiring layer suppresses this action when no tokens have been
 * streamed since the previous end frame, so empty-text speak calls (and
 * the `turn_end` safety-net path) don't emit spurious ends.
 */
export function reduceSpeakEnd(prev: VoiceRuntimeState): { next: VoiceRuntimeState; actions: VoiceAction[] } {
  if (prev.state !== 'active') {
    return { next: prev, actions: [] };
  }
  return { next: prev, actions: [{ kind: 'emit_speechmux_end' }] };
}

/**
 * Reducer for the assistant turn completing (turn_end).
 *
 * Retained as a safety net: if for any reason a speak ends without the
 * streaming `toolcall_end` handler firing `reduceSpeakEnd` (edge paths in
 * the SDK or non-streaming providers where the stream event never
 * materializes), turn_end gives us a final chance to finalize. The
 * wiring layer gates on the "streamed since last end" flag so this is a
 * no-op whenever the primary path has already emitted the end.
 */
export function reduceTurnEnd(prev: VoiceRuntimeState): { next: VoiceRuntimeState; actions: VoiceAction[] } {
  if (prev.state !== 'active') {
    return { next: prev, actions: [] };
  }
  return { next: prev, actions: [{ kind: 'emit_speechmux_end' }] };
}
