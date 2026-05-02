// Concern A: Lifecycle reducer.
//
// Responsible for:
// - Activate / deactivate of voice mode.
// - WS connection lifecycle (opened / failed / disconnected).
// - Buffering of outgoing speak frames during the `activating` window
//   and flushing them on `ws:opened`.
//
// Holds NO knowledge of the streaming / walkback machines. Those plug in
// through the top-level dispatcher.

import { VOICE_CALL_STARTED_SENTINEL } from '../../state-machine.js';
import type { Action } from '../actions.js';
import type { Event } from '../events.js';
import type { LifecycleState, RuntimeState } from '../state.js';

export interface LifecycleConfig {
  defaultInterpreterModel: { provider: string; modelId: string };
}

export interface LifecycleResult {
  next: LifecycleState;
  /** Set to true if the activate path applied the interpreter model. */
  interpreterAppliedNow: boolean;
  actions: Action[];
}

/**
 * Pure transition function for the lifecycle slice.
 *
 * Emits the bulk of the side-effect actions: model setup, sentinel user
 * message, WS open/close, deactivate-request.
 *
 * Frame emission policy: whenever the streaming machine produces a
 * `send_frame` action, it goes via the top-level dispatcher into
 * `bufferOrPassFrame()` below — which either forwards it (Active) or
 * appends to `pendingFrames` (Activating). On `ws:opened` we flush in
 * order.
 */
export function reduceLifecycle(prev: LifecycleState, event: Event, ctx: { interpreterApplied: boolean; config: LifecycleConfig }): LifecycleResult {
  switch (event.type) {
    case 'eb:activate': {
      if (prev.kind !== 'dormant') {
        // Re-activation while already active or activating is a no-op
        // — the orchestrator's bind path is supposed to be the single
        // owner. We log loudly in the shell; here we just stay put.
        return { next: prev, interpreterAppliedNow: false, actions: [] };
      }
      const actions: Action[] = [];
      if (!ctx.interpreterApplied) {
        actions.push({
          kind: 'set_interpreter_model',
          provider: ctx.config.defaultInterpreterModel.provider,
          modelId: ctx.config.defaultInterpreterModel.modelId,
        });
      }
      actions.push({ kind: 'send_user_message', text: VOICE_CALL_STARTED_SENTINEL });
      actions.push({ kind: 'open_ws', url: event.msg.speechmuxWsUrl });
      return {
        next: {
          kind: 'activating',
          sessionId: event.msg.sessionId,
          wsUrl: event.msg.speechmuxWsUrl,
          pendingFrames: [],
        },
        interpreterAppliedNow: !ctx.interpreterApplied,
        actions,
      };
    }

    case 'eb:deactivate': {
      if (prev.kind === 'dormant') {
        return { next: prev, interpreterAppliedNow: false, actions: [] };
      }
      // Idempotent: close_ws is a no-op if no client is open.
      return {
        next: { kind: 'dormant' },
        interpreterAppliedNow: false,
        actions: [{ kind: 'close_ws' }],
      };
    }

    case 'ws:opened': {
      if (prev.kind !== 'activating') {
        // Stray opened event (e.g. after a deactivate-then-open race).
        // Close the new connection if we somehow have one.
        return { next: prev, interpreterAppliedNow: false, actions: [] };
      }
      const actions: Action[] = [];
      // Flush buffered speak frames in arrival order. Done here, not
      // in the streaming reducer, so frame ordering is preserved across
      // the activating→active boundary.
      for (const frame of prev.pendingFrames) {
        actions.push({ kind: 'send_frame', frame });
      }
      return {
        next: { kind: 'active', sessionId: prev.sessionId },
        interpreterAppliedNow: false,
        actions,
      };
    }

    case 'ws:open_failed': {
      if (prev.kind !== 'activating') {
        return { next: prev, interpreterAppliedNow: false, actions: [] };
      }
      // Drop any buffered frames; the shell will rebuild from scratch
      // on the next activate.
      return {
        next: { kind: 'dormant' },
        interpreterAppliedNow: false,
        actions: [{ kind: 'emit_deactivate_request' }],
      };
    }

    case 'ws:disconnected': {
      if (prev.kind === 'dormant') {
        return { next: prev, interpreterAppliedNow: false, actions: [] };
      }
      return {
        next: { kind: 'dormant' },
        interpreterAppliedNow: false,
        actions: [{ kind: 'emit_deactivate_request' }],
      };
    }

    default:
      return { next: prev, interpreterAppliedNow: false, actions: [] };
  }
}

/**
 * Apply a `send_frame` action against the lifecycle state. Returns
 * either the same action (to be executed by the shell) or a state
 * mutation that buffers the frame for later flush.
 *
 * Splitting this out keeps the streaming reducer agnostic of the
 * lifecycle phase — it always emits `send_frame`; this function decides
 * whether to forward or buffer.
 */
export function bufferOrPassFrame(prev: LifecycleState, frame: import('../../speechmux-client.js').OutgoingFrame): { next: LifecycleState; actions: Action[] } {
  switch (prev.kind) {
    case 'dormant':
      // Frame produced while no call is bound — drop. Streaming reducer
      // is supposed to no-op while dormant; if we land here it's a
      // diagnostic the shell will log.
      return { next: prev, actions: [] };
    case 'activating':
      return {
        next: { ...prev, pendingFrames: [...prev.pendingFrames, frame] },
        actions: [],
      };
    case 'active':
      return { next: prev, actions: [{ kind: 'send_frame', frame } as Action] };
  }
}

/**
 * Top-level merge helper used by the dispatcher to splice the lifecycle
 * sub-state back into the runtime record. Kept here so the dispatcher
 * stays mechanical.
 */
export function applyLifecycleResult(prev: RuntimeState, r: LifecycleResult): RuntimeState {
  return {
    ...prev,
    lifecycle: r.next,
    interpreterApplied: prev.interpreterApplied || r.interpreterAppliedNow,
  };
}
