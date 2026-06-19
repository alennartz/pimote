// Top-level voice FSM reducer.
//
// Folds the three sub-reducers (lifecycle, streaming, walkback) into a
// single transition. Every event is fanned out to the sub-reducers
// that care about it; results are merged.
//
// The sub-reducers don't know about each other. Two cross-cutting bits
// are handled here:
//
// 1. Frame buffering. The streaming reducer emits raw `OutgoingFrame`
//    values; we route each through `bufferOrPassFrame` against the
//    current lifecycle state to either forward (Active) or buffer
//    (Activating). The buffered case mutates the lifecycle slice; the
//    forwarded case becomes a `send_frame` action.
//
// 2. The `ws:incoming` `user` frame turns into a `send_user_message`
//    action — and only when lifecycle is `active`. (The walkback
//    reducer intentionally ignores user frames; this is the right
//    place to handle them because it lives at the boundary between
//    "do we even have a connection" and "what should the agent do".)

import { reduceLifecycle, applyLifecycleResult, bufferOrPassFrame } from './reducers/lifecycle.js';
import type { LifecycleConfig } from './reducers/lifecycle.js';
import { reduceStreaming, currentStreamingSpeakId } from './reducers/streaming.js';
import { reduceWalkback, applyWalkbackResult } from './reducers/walkback.js';
import type { Action } from './actions.js';
import type { Event } from './events.js';
import type { RuntimeState } from './state.js';

export interface Reducers {
  config: LifecycleConfig;
}

export interface ReduceResult {
  next: RuntimeState;
  actions: Action[];
}

export function reduce(prev: RuntimeState, event: Event, reducers: Reducers): ReduceResult {
  let state = prev;
  const actions: Action[] = [];

  // ---- Lifecycle ---------------------------------------------------------
  const life = reduceLifecycle(state.lifecycle, event, {
    interpreterApplied: state.interpreterApplied,
    config: reducers.config,
  });
  state = applyLifecycleResult(state, life);
  actions.push(...life.actions);

  // ---- Streaming ---------------------------------------------------------
  // Only meaningful when activating or active. Dormant means we can't
  // emit frames anywhere, so skip the work and any accidental frames.
  if (state.lifecycle.kind !== 'dormant') {
    const stream = reduceStreaming(state.message, event);
    state = { ...state, message: stream.next };
    for (const frame of stream.frames) {
      const routed = bufferOrPassFrame(state.lifecycle, frame);
      state = { ...state, lifecycle: routed.next };
      actions.push(...routed.actions);
    }
    // Fold the latest ended speak id into runtime so walkback has a
    // fallback target if speechmux's rollback/abort doesn't echo a
    // speak_id (e.g. older speechmux build).
    if (stream.endedSpeakIds.length > 0) {
      state = {
        ...state,
        lastEmittedSpeakId: stream.endedSpeakIds[stream.endedSpeakIds.length - 1] ?? state.lastEmittedSpeakId,
      };
    }
  }

  // ---- Walkback ----------------------------------------------------------
  // Pass:
  //  - lifecycle kind, so abort/rollback frames arriving when no call is active
  //    are dropped (e.g. in flight during teardown) — a stray abort would
  //    otherwise abort a text-mode turn. (H3)
  //  - the in-flight speak id, so an interrupt targeting a still-streaming
  //    speak resolves correctly when the frame omits a speak_id. (gap 2)
  // `state.message` is post-streaming here, so its blocks still hold the
  // in-flight speak (ws:incoming doesn't clear them).
  const wb = reduceWalkback(state.walkback, event, {
    lastEmittedSpeakId: state.lastEmittedSpeakId,
    currentStreamingSpeakId: currentStreamingSpeakId(state.message),
    lifecycleKind: state.lifecycle.kind,
  });
  state = applyWalkbackResult(state, wb);
  actions.push(...wb.actions);

  // Clear lastEmittedSpeakId on full deactivation so a subsequent call
  // doesn't carry it over.
  if (event.type === 'eb:deactivate') {
    state = { ...state, lastEmittedSpeakId: null };
  }

  // ---- Cross-cutting: incoming `user` frame → sendUserMessage ------------
  if (event.type === 'ws:incoming' && event.frame.type === 'user') {
    if (state.lifecycle.kind === 'active') {
      actions.push({ kind: 'send_user_message', text: event.frame.text });
    }
    // If lifecycle isn't active, drop. The shell will log this — it
    // means a user frame arrived after we tore down (or before we
    // wired the WS), both of which are bugs upstream.
  }

  return { next: state, actions };
}
