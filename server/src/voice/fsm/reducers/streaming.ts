// Concern B: Outbound speak streaming reducer.
//
// Translates the SDK's `message_update.assistantMessageEvent.toolcall_*`
// stream into speechmux WS frames (`token` + `end`) per `speak()` call.
//
// **Single emission path.** The reducer is the *only* code that ever
// produces speak `token` / `end` frames. The SDK's `tool_call` hook
// (which historically returned the full bulk text) does NOT emit
// anything; it only returns the tool-result. This eliminates the
// "double-emit" class of bugs by construction.
//
// Per-block FSM:
//   no entry  + ToolCallStart  → unknown | speak_streaming | not_speak
//                                (depending on partial.content[idx].name)
//   unknown   + ToolCallDelta  → promote (if name now resolved) and
//                                replay delta
//   speak_str + ToolCallDelta  → extractor.write(delta) → emit any
//                                newly-revealed token suffix
//   speak_str + ToolCallEnd    → diff against finalText → emit tail + end
//   no entry  + ToolCallEnd    → emit (token + end) using the
//                                authoritative final args (covers
//                                providers that don't stream tool args)
//   not_speak | speak_ended    → no-op
//
// **Reset trigger:** the SDK `message_start` event for `role==='assistant'`
// clears the entire blocks map. This is the bug fix for the leak that
// stranded the previous implementation: it watched the wrong event
// (`assistantMessageEvent.start`, which never fires inside
// `message_update`).
//
// **No closures.** Block fields are fully immutable — every transition
// produces a fresh block. The `TextExtractor` referenced by a
// `speak_streaming` block is the one piece of mutable state, and that
// mutation is encapsulated; the reducer only ever reads it via
// `extractor.currentText()`. The block reference is preserved across
// `toolcall_delta` events that don't change the block's `kind`, so the
// extractor's accumulated text persists correctly.

import type { Event, PartialAssistantMessage, PartialContentBlock, ToolCallEnded } from '../events.js';
import type { BlockState, MessageStreamState } from '../state.js';
import type { OutgoingFrame } from '../../speechmux-client.js';
import { TextExtractor } from '../text-extractor.js';

export interface StreamingResult {
  next: MessageStreamState;
  /** Frames produced by this step, in emission order. The lifecycle
   *  layer decides whether to forward to the wire or buffer. */
  frames: OutgoingFrame[];
  /**
   * Speak toolCallIds whose `end` frame was emitted in this step (in
   * order). The dispatcher folds the *latest* into
   * `RuntimeState.lastEmittedSpeakId` so the walkback reducer has a
   * fallback target if speechmux's rollback / abort doesn't echo a
   * `speak_id` (older speechmux build).
   */
  endedSpeakIds: string[];
}

const noFrames = (next: MessageStreamState): StreamingResult => ({
  next,
  frames: [],
  endedSpeakIds: [],
});

export function reduceStreaming(prev: MessageStreamState, event: Event): StreamingResult {
  switch (event.type) {
    case 'sdk:message_start':
      // Assistant message starts → wipe per-block state and clear the
      // interrupt latch (a new turn can emit again). (Filtering on
      // role==='assistant' happens at the dispatcher.)
      return noFrames({ blocks: new Map(), interrupted: false });

    case 'ws:incoming':
      // A barge-in latches `interrupted` so we stop feeding speechmux tokens
      // for an utterance it already aborted. Reset on the next message_start.
      if (event.frame.type === 'abort' || event.frame.type === 'rollback') {
        return noFrames({ ...prev, interrupted: true });
      }
      return noFrames(prev);

    case 'sdk:toolcall_start':
      if (prev.interrupted) return noFrames(prev);
      return noFrames(setBlock(prev, event.contentIndex, blockFromPartial(event.contentIndex, event.partial)));

    case 'sdk:toolcall_delta':
      if (prev.interrupted) return noFrames(prev);
      return reduceDelta(prev, event.contentIndex, event.delta, event.partial);

    case 'sdk:toolcall_end':
      if (prev.interrupted) return noFrames(prev);
      return reduceEnd(prev, event.contentIndex, event.toolCall);

    case 'sdk:turn_end':
      // Release the floor for the turn's last spoken utterance. Routed as a
      // frame so the lifecycle layer buffers it during `activating` and passes
      // it during `active` — the same discipline as token/end frames. (M2)
      return {
        next: prev,
        frames: [event.lastSpeakToolCallId ? { type: 'floor_released', speak_id: event.lastSpeakToolCallId } : { type: 'floor_released' }],
        endedSpeakIds: [],
      };

    case 'sdk:agent_end':
      // Surface a harness-side error to speechmux. (M2)
      return event.error ? { next: prev, frames: [{ type: 'error', message: event.error }], endedSpeakIds: [] } : noFrames(prev);

    default:
      return noFrames(prev);
  }
}

// ---------------------------------------------------------------------------
// Per-event helpers
// ---------------------------------------------------------------------------

function reduceDelta(prev: MessageStreamState, idx: number, delta: string, partial: PartialAssistantMessage): StreamingResult {
  // Step 1: locate / synthesize / promote the block.
  let entry = prev.blocks.get(idx) ?? blockFromPartial(idx, partial);
  if (entry.kind === 'unknown') entry = promoteUnknown(entry, idx, partial);

  // Step 2: feed the extractor (only meaningful for speak_streaming).
  if (entry.kind !== 'speak_streaming') {
    return noFrames(setBlock(prev, idx, entry));
  }
  // Mutating the extractor here is internal to the extractor object;
  // the reducer treats the extractor reference as opaque.
  entry.extractor.write(delta);

  // Step 3: harvest any newly-revealed prefix and emit one fragment.
  const text = entry.extractor.currentText();
  if (text.length <= entry.emittedLength) {
    // No growth — keep the existing block reference (the extractor
    // identity is preserved). We still must rewrite the map if the
    // block was synthesized/promoted above; setBlock handles that.
    return noFrames(setBlock(prev, idx, entry));
  }
  const fragment = text.slice(entry.emittedLength);
  const advanced: BlockState = {
    kind: 'speak_streaming',
    toolCallId: entry.toolCallId,
    extractor: entry.extractor,
    emittedLength: text.length,
  };
  return {
    next: setBlock(prev, idx, advanced),
    frames: [tokenFrame(fragment, entry.toolCallId)],
    endedSpeakIds: [],
  };
}

function reduceEnd(prev: MessageStreamState, idx: number, tc: ToolCallEnded): StreamingResult {
  const finalText = readFinalText(tc);
  const toolName = typeof tc.name === 'string' ? tc.name : null;
  const toolCallId = typeof tc.id === 'string' ? tc.id : null;
  const entry = prev.blocks.get(idx);

  // Case 1: no prior block — provider skipped both toolcall_start AND
  // toolcall_delta. Emit the full text in one go.
  if (!entry) {
    if (toolName === 'speak' && finalText.length > 0) {
      return {
        next: setBlock(prev, idx, { kind: 'speak_ended', toolCallId }),
        frames: [tokenFrame(finalText, toolCallId), endFrame(toolCallId)],
        endedSpeakIds: toolCallId ? [toolCallId] : [],
      };
    }
    return noFrames(setBlock(prev, idx, { kind: 'not_speak' }));
  }

  // Case 2: block was unknown — last chance to learn the name.
  if (entry.kind === 'unknown') {
    if (toolName === 'speak' && finalText.length > 0) {
      return {
        next: setBlock(prev, idx, { kind: 'speak_ended', toolCallId }),
        frames: [tokenFrame(finalText, toolCallId), endFrame(toolCallId)],
        endedSpeakIds: toolCallId ? [toolCallId] : [],
      };
    }
    return noFrames(setBlock(prev, idx, { kind: 'not_speak' }));
  }

  // Case 3: not_speak / speak_ended — nothing to do.
  if (entry.kind !== 'speak_streaming') return noFrames(prev);

  // Case 4: speak_streaming → finalize.
  //
  // We don't trust the extractor as authoritative at end-of-stream
  // (escapes mid-chunk could have errored, etc.). Instead diff against
  // the SDK-provided `finalText` and flush whatever's missing. This
  // single fallback covers all parser-failure modes by construction.
  const resolvedId = entry.toolCallId ?? toolCallId;
  const frames: OutgoingFrame[] = [];
  let emitted = entry.emittedLength;
  if (finalText.length > emitted) {
    frames.push(tokenFrame(finalText.slice(emitted), resolvedId));
    emitted = finalText.length;
  }
  if (emitted > 0) {
    frames.push(endFrame(resolvedId));
  }
  return {
    next: setBlock(prev, idx, { kind: 'speak_ended', toolCallId: resolvedId }),
    frames,
    endedSpeakIds: resolvedId !== null && emitted > 0 ? [resolvedId] : [],
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Construct an outgoing `token` frame, attaching speak_id when known. */
function tokenFrame(text: string, toolCallId: string | null): OutgoingFrame {
  return toolCallId === null ? { type: 'token', text } : { type: 'token', text, speak_id: toolCallId };
}

/** Construct an outgoing `end` frame, attaching speak_id when known. */
function endFrame(toolCallId: string | null): OutgoingFrame {
  return toolCallId === null ? { type: 'end' } : { type: 'end', speak_id: toolCallId };
}

function setBlock(state: MessageStreamState, idx: number, block: BlockState): MessageStreamState {
  // Cheap aliasing check: if the block reference is identical and
  // already present at this index, skip the Map allocation. Lets
  // toolcall_delta steps that don't change anything stay zero-alloc.
  if (state.blocks.get(idx) === block) return state;
  const blocks = new Map(state.blocks);
  blocks.set(idx, block);
  return { ...state, blocks };
}

/** Toolcall id of the speak() block currently mid-stream (if any). The most
 *  likely walkback target when speechmux's frame omits a speak_id: an in-flight
 *  speak hasn't emitted its `end`, so it isn't in `lastEmittedSpeakId` yet. */
export function currentStreamingSpeakId(message: MessageStreamState): string | null {
  for (const block of message.blocks.values()) {
    if (block.kind === 'speak_streaming' && block.toolCallId) return block.toolCallId;
  }
  return null;
}

function partialBlock(partial: PartialAssistantMessage, idx: number): PartialContentBlock | undefined {
  const c = partial?.content;
  if (!Array.isArray(c)) return undefined;
  const b = c[idx];
  if (b && typeof b === 'object') return b as PartialContentBlock;
  return undefined;
}

function readFinalText(tc: ToolCallEnded): string {
  const a = tc.arguments;
  if (a && typeof a === 'object') {
    const t = (a as { text?: unknown }).text;
    if (typeof t === 'string') return t;
  }
  return '';
}

/** Build the initial block state from the partial carried on
 *  toolcall_start (or the first delta, when start is missing). */
function blockFromPartial(idx: number, partial: PartialAssistantMessage): BlockState {
  const pb = partialBlock(partial, idx);
  const name = pb?.name;
  const id = typeof pb?.id === 'string' ? pb.id : null;
  if (typeof name !== 'string') return { kind: 'unknown' };
  if (name === 'speak') return makeSpeakStreaming(id);
  return { kind: 'not_speak' };
}

/** Late name resolution for an `unknown` block. */
function promoteUnknown(block: BlockState, idx: number, partial: PartialAssistantMessage): BlockState {
  if (block.kind !== 'unknown') return block;
  const pb = partialBlock(partial, idx);
  const name = pb?.name;
  const id = typeof pb?.id === 'string' ? pb.id : null;
  if (typeof name !== 'string') return block;
  if (name === 'speak') return makeSpeakStreaming(id);
  return { kind: 'not_speak' };
}

function makeSpeakStreaming(toolCallId: string | null): BlockState {
  return {
    kind: 'speak_streaming',
    toolCallId,
    extractor: new TextExtractor(),
    emittedLength: 0,
  };
}
