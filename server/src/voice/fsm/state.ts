// Voice extension runtime state.
//
// Three orthogonal concerns are modelled as parallel sub-machines that
// share a single top-level state record. Sub-reducers in
// `reducers/{lifecycle,streaming,walkback}.ts` operate only on their own
// slice; the top-level dispatcher in `reducer.ts` folds them together.
//
// The `JSONParser` instance held by `speak_streaming` blocks is the one
// piece of impurity inside this state — necessary because streaming JSON
// argument parsing can't be replayed lazily. It's owned by the block and
// disposed when the block transitions to `speak_ended` or the message
// resets.

import type { OutgoingFrame } from '../speechmux-client.js';
import type { TextExtractor } from './text-extractor.js';

// ---- Concern A: Lifecycle -------------------------------------------------

/**
 * Lifecycle of a single voice call from this extension's perspective.
 *
 * `dormant` — no call is bound. EventBus activate is the only meaningful
 *             input. WS resource owned by the shell is null.
 * `activating` — the shell has been told to open the speechmux WS. Outgoing
 *                speak frames produced by the streaming machine while we're
 *                in this state queue up in `pendingFrames` and get flushed
 *                once `ws:opened` fires.
 * `active` — WS open, frames flow directly. Incoming frames from speechmux
 *            are dispatched to the walkback / sendUserMessage machinery.
 */
export type LifecycleState =
  | { kind: 'dormant' }
  | {
      kind: 'activating';
      sessionId: string;
      wsUrl: string;
      pendingFrames: OutgoingFrame[];
    }
  | { kind: 'active'; sessionId: string };

// ---- Concern B: Outbound speak streaming ----------------------------------

/**
 * Per-content-block streaming state inside an in-flight assistant message.
 *
 * - `unknown`: a `toolcall_start` arrived but the tool's name wasn't yet
 *   carried on the partial. Subsequent deltas are dropped (they're JSON
 *   arg fragments we'd misparse without the prefix). The block promotes
 *   on the first delta whose partial carries `name`.
 * - `not_speak`: confirmed the tool is something other than `speak`. We
 *   stop processing it.
 * - `speak_streaming`: actively forwarding token fragments. `extractor`
 *   is the streaming text decoder; we feed it deltas and read its
 *   accumulated text via `extractor.currentText()`. `emittedLength` is
 *   the count of characters already pushed to speechmux as `token`
 *   frames. The block object is replaced (immutably) on every state
 *   change; only the `extractor`'s internals are mutable, and that
 *   mutation is invisible to the FSM.
 * - `speak_ended`: `toolcall_end` fired and the speak's `end` frame has
 *   been emitted. Further events for this block are no-ops.
 */
export type BlockState =
  | { kind: 'unknown' }
  | { kind: 'not_speak' }
  | {
      kind: 'speak_streaming';
      toolCallId: string | null;
      extractor: TextExtractor;
      emittedLength: number;
    }
  | { kind: 'speak_ended'; toolCallId: string | null };

/**
 * Per-message streaming state. Reset on every assistant `message_start`
 * via the SDK hook (NOT via the never-fired `assistantMessageEvent.start`
 * sub-event we used to listen for — that mistake is what produced the
 * stale-`latestText` leak that broke the entire call).
 */
export interface MessageStreamState {
  blocks: Map<number, BlockState>;
  /**
   * Set when a barge-in (speechmux `abort`/`rollback`) is received mid-turn.
   * While set, the streaming reducer suppresses further outbound `token`/`end`
   * frames — speechmux has stopped playback for this utterance and isn't
   * expecting more tokens. Reset on the next `message_start` (new turn).
   */
  interrupted: boolean;
}

// ---- Concern C: Walkback --------------------------------------------------

/**
 * Walkback state machine.
 *
 * `idle` — no rewrite pending. The walkback reducer still strips
 * trailing aborted-empty assistants on every `sdk:context` event.
 *
 * `pending` — a rollback or abort has been received; the next
 * `sdk:context` will rewrite the messages array. `targetSpeakToolCallId`
 * identifies which `speak()` block (by its toolCallId) the heardText
 * applies to. Speechmux supplies it on the wire frame; if the wire
 * frame omits speak_id we fall back to the runtime-tracked
 * `lastEmittedSpeakId`.
 *
 * The previous design captured a snapshot of the in-flight assistant
 * message on every `message_update` and used string-prefix matching on
 * its content to identify which speak() the heard_text belonged to.
 * That captured snapshot drifted out of sync with the actual
 * conversation history (textLen=0 even when text had been streamed),
 * and the prefix-matching logic broke as soon as a message had multiple
 * speak() calls. Rewriting by toolCallId against the real messages
 * array eliminates both failure modes.
 */
export type WalkbackState = { kind: 'idle' } | { kind: 'pending'; heardText: string; targetSpeakToolCallId: string };

// ---- Combined runtime state -----------------------------------------------

export interface RuntimeState {
  lifecycle: LifecycleState;
  message: MessageStreamState;
  walkback: WalkbackState;
  /** True once the interpreter model has been applied for this session. */
  interpreterApplied: boolean;
  /**
   * Toolcall id of the most recent `speak()` for which we emitted an
   * `end` frame to speechmux. Used as the walkback fallback target
   * when speechmux's rollback/abort frame doesn't carry a `speak_id`
   * (back-compat with older speechmux builds). Cleared on deactivate.
   */
  lastEmittedSpeakId: string | null;
}

export function initialState(): RuntimeState {
  return {
    lifecycle: { kind: 'dormant' },
    message: { blocks: new Map(), interrupted: false },
    walkback: { kind: 'idle' },
    interpreterApplied: false,
    lastEmittedSpeakId: null,
  };
}
