// Events the voice FSM consumes.
//
// Every external stimulus (EventBus, WS lifecycle, WS frames, SDK hooks)
// is normalized into one of these typed events before reaching the
// reducer. The shell in `index.ts` is the only place where ad-hoc input
// translation lives.

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { IncomingFrame } from '../speechmux-client.js';
import type { VoiceActivateMessage, VoiceDeactivateMessage } from '../state-machine.js';

/**
 * Snapshot of the partial assistant message at the moment of a
 * toolcall_* event. We only need the `content[i].name` / `id` for
 * disambiguation, but typing it open-ended keeps the shell simple.
 */
export interface PartialContentBlock {
  name?: unknown;
  id?: unknown;
  [k: string]: unknown;
}
export interface PartialAssistantMessage {
  content?: PartialContentBlock[] | unknown;
  [k: string]: unknown;
}

export interface ToolCallEnded {
  id?: unknown;
  name?: unknown;
  arguments?: { text?: unknown; [k: string]: unknown } | unknown;
  [k: string]: unknown;
}

export type Event =
  // ---- EventBus ----
  | { type: 'eb:activate'; msg: VoiceActivateMessage }
  | { type: 'eb:deactivate'; msg: VoiceDeactivateMessage }

  // ---- WS lifecycle ----
  | { type: 'ws:opened' }
  | { type: 'ws:open_failed'; error: unknown }
  | { type: 'ws:disconnected' }

  // ---- WS frames from speechmux ----
  | { type: 'ws:incoming'; frame: IncomingFrame }

  // ---- SDK message lifecycle ----
  // We only need `message_start` to reset per-message streaming state.
  // The previous design also captured every `message_update` for use as
  // a walkback substrate — that's gone; walkback now operates directly
  // on the messages array passed to `sdk:context`.
  | { type: 'sdk:message_start'; message: AgentMessage }

  // ---- SDK assistantMessageEvent (only the toolcall_* subset matters) ----
  | { type: 'sdk:toolcall_start'; contentIndex: number; partial: PartialAssistantMessage }
  | { type: 'sdk:toolcall_delta'; contentIndex: number; delta: string; partial: PartialAssistantMessage }
  | { type: 'sdk:toolcall_end'; contentIndex: number; toolCall: ToolCallEnded }

  // ---- SDK context rewrite hook ----
  | { type: 'sdk:context'; messages: AgentMessage[] };
