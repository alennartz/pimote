// Concern C: Walkback / context rewrite reducer.
//
// When speechmux signals barge-in (abort or rollback), we mark walkback
// `pending` with the speak's `targetSpeakToolCallId`. The toolCallId
// comes from the wire frame's `speak_id` (echoed by speechmux from the
// chunk that was actively playing) when present; otherwise we fall back
// to the runtime-tracked `lastEmittedSpeakId`.
//
// On every `sdk:context` event we run `walkBack(...)`:
//   - idle → just strip trailing aborted-empty assistants.
//   - pending → strip + rewrite the targeted speak block to `heardText`,
//               drop any blocks/messages that came after.
//
// The previous design captured the in-flight assistant message snapshot
// and used string-prefix accumulation across content blocks to identify
// what was heard. That broke whenever a turn had multiple speak()
// calls or whenever the snapshot was stale. The id-based design has no
// such ambiguity.

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Action } from '../actions.js';
import type { Event } from '../events.js';
import type { RuntimeState, WalkbackState } from '../state.js';
import { VOICE_INTERRUPT_CUSTOM_TYPE } from '../../../../../shared/dist/index.js';
import type { VoiceInterruptEntryData } from '../../../../../shared/dist/index.js';
import { walkBack } from '../../walk-back.js';

export interface WalkbackResult {
  next: WalkbackState;
  actions: Action[];
}

/** Resolve which speak() id to walk back to. Prefers what speechmux
 *  echoes; falls back to runtime-tracked latest. Returns null if neither
 *  is available (we'll degrade gracefully — abort the agent but skip
 *  the rewrite). */
function resolveTarget(frameSpeakId: string | undefined, lastEmittedSpeakId: string | null): string | null {
  if (frameSpeakId) return frameSpeakId;
  return lastEmittedSpeakId;
}

export function reduceWalkback(prev: WalkbackState, lastEmittedSpeakId: string | null, event: Event): WalkbackResult {
  switch (event.type) {
    case 'ws:incoming': {
      const f = event.frame;
      if (f.type === 'user') return { next: prev, actions: [] };

      const heardText = f.type === 'rollback' ? f.heard_text : '';
      const data: VoiceInterruptEntryData = {
        heard_text: heardText,
        kind: f.type === 'rollback' ? 'rollback' : 'abort',
      };
      const target = resolveTarget((f as { speak_id?: string }).speak_id, lastEmittedSpeakId);

      const actions: Action[] = [{ kind: 'abort_agent' }, { kind: 'append_custom_entry', customType: VOICE_INTERRUPT_CUSTOM_TYPE, data }];

      if (target === null) {
        // No target available → can't rewrite. Just abort + record the
        // interrupt entry; the next sdk:context will only strip
        // aborted-empty assistants.
        return { next: { kind: 'idle' }, actions };
      }

      return {
        next: { kind: 'pending', heardText, targetSpeakToolCallId: target },
        actions,
      };
    }

    case 'sdk:context': {
      const rollback = prev.kind === 'pending' ? { heardText: prev.heardText, targetSpeakToolCallId: prev.targetSpeakToolCallId } : null;
      const rewritten: AgentMessage[] = walkBack({
        messages: event.messages,
        rollback,
      });
      return {
        next: { kind: 'idle' },
        actions: [{ kind: 'rewrite_context', messages: rewritten }],
      };
    }

    case 'eb:deactivate':
      return { next: { kind: 'idle' }, actions: [] };

    default:
      return { next: prev, actions: [] };
  }
}

export function applyWalkbackResult(prev: RuntimeState, r: WalkbackResult): RuntimeState {
  return { ...prev, walkback: r.next };
}
