// Actions emitted by the voice FSM reducer.
//
// The reducer is pure: every side effect is encoded as one of these
// values. The shell in `index.ts` interprets each into an actual call
// against the pi SDK / speechmux WS / EventBus.

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { OutgoingFrame } from '../speechmux-client.js';
import type { VoiceInterruptEntryData } from '../../../../shared/dist/index.js';

export type Action =
  // ---- Lifecycle side effects ----
  | { kind: 'set_interpreter_model'; provider: string; modelId: string }
  | { kind: 'send_user_message'; text: string; deliverAs?: 'steer' | 'followUp' }
  /**
   * Inject a user-visible message into the conversation history without
   * triggering an agent turn. Used for end-of-call sentinels and similar
   * passive lifecycle markers — the LLM sees it on the next user-initiated
   * turn but the agent doesn't respond to it now.
   */
  | { kind: 'inject_silent_user_message'; customType: string; text: string }
  | { kind: 'open_ws'; url: string }
  | { kind: 'close_ws' }
  | { kind: 'emit_deactivate_request' }

  // ---- Outbound to speechmux ----
  // Only emitted when the lifecycle is `active` (or as a flush-on-open
  // action emitted during the `activating → active` transition). The
  // shell unconditionally forwards these to the WS client and crashes
  // loudly if the client is missing — by construction it should never be.
  | { kind: 'send_frame'; frame: OutgoingFrame }

  // ---- Agent control ----
  | { kind: 'abort_agent' }
  | { kind: 'append_custom_entry'; customType: string; data: VoiceInterruptEntryData }

  // ---- Context rewrite ----
  // Returned via the `context` hook's `{ messages }` return value. The
  // shell stashes the rewritten messages in a slot the hook reads.
  | { kind: 'rewrite_context'; messages: AgentMessage[] };
