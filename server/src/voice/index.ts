// @pimote/voice — voice extension for pimote.
//
// This is the imperative shell around the pure FSM in `./fsm/`. It does
// three things:
//
//   1. Translates external stimuli (pi-coding-agent SDK hooks, EventBus
//      messages, speechmux WS frames) into typed `Event` values.
//   2. Calls `reduce(state, event)` and writes back the new state.
//   3. Interprets the emitted `Action` values into actual side effects:
//      pi.sendUserMessage, ctx.abort, WS open/close/send, EventBus emit.
//
// **Why the redesign.** The previous monolithic implementation conflated
// lifecycle, streaming, and walkback into a single record of orthogonal
// flags whose invariants drifted out of sync. The most visible symptom
// was per-content-block streaming state leaking across assistant
// messages because it was reset on the wrong event (a substring of
// `assistantMessageEvent` that never fires inside `message_update`). The
// FSM split + correct reset-on-message_start eliminates that bug class.

import type { ExtensionAPI, ExtensionContext, ExtensionFactory, BeforeAgentStartEvent, ContextEvent } from '@mariozechner/pi-coding-agent';

/** Local mirror of pi-coding-agent's `MessageStartEvent` (not re-exported
 *  at the package root in this version). Kept narrow to what we use. */
interface MessageStartEvent {
  type: 'message_start';
  message: AgentMessage;
}
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

import { renderInterpreterPrompt } from './interpreter-prompt.js';
import { createDefaultSpeechmuxClientFactory, type SpeechmuxClient, type SpeechmuxClientFactory } from './speechmux-client.js';
import { ensureIdleWithImplicitAbort } from './wait-for-idle.js';
import type { VoiceActivateMessage, VoiceDeactivateMessage } from './state-machine.js';

import { initialState, type BlockState, type MessageStreamState, type RuntimeState } from './fsm/state.js';
import type { Event as FsmEvent } from './fsm/events.js';
import type { Action as FsmAction } from './fsm/actions.js';
import { reduce } from './fsm/reducer.js';

// ---- Diagnostic helpers ---------------------------------------------------

/** Render a compact event description for tracing. Returns null when the
 *  event type is enough on its own (the dispatcher logs the bare type). */
function traceEvent(event: FsmEvent): string | null {
  switch (event.type) {
    case 'sdk:toolcall_start':
      return `sdk:toolcall_start(idx=${event.contentIndex}, partial.name=${partialName(event.partial, event.contentIndex)})`;
    case 'sdk:toolcall_delta':
      return `sdk:toolcall_delta(idx=${event.contentIndex}, deltaLen=${event.delta.length}, deltaPreview=${JSON.stringify(event.delta.slice(0, 40))})`;
    case 'sdk:toolcall_end':
      return `sdk:toolcall_end(idx=${event.contentIndex}, name=${(event.toolCall as { name?: string }).name ?? null}, finalTextLen=${typeof (event.toolCall.arguments as { text?: unknown } | undefined)?.text === 'string' ? (event.toolCall.arguments as { text: string }).text.length : 0})`;
    case 'ws:incoming':
      return `ws:incoming(${event.frame.type}${event.frame.type === 'user' ? `, textLen=${event.frame.text.length}` : ''})`;
    case 'sdk:message_start':
      return `sdk:message_start(role=${(event.message as { role?: string }).role})`;
    case 'sdk:context':
      return `sdk:context(messages=${event.messages.length})`;
    case 'eb:activate':
      return `eb:activate(${event.msg.sessionId})`;
    default:
      return null;
  }
}

function partialName(partial: { content?: unknown }, idx: number): string | null {
  const c = partial.content;
  if (!Array.isArray(c)) return null;
  const b = c[idx];
  if (!b || typeof b !== 'object') return null;
  const name = (b as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

function blockSummary(blocks: MessageStreamState['blocks']): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [k, v] of blocks.entries()) {
    out[k] = blockKind(v);
  }
  return out;
}

function blockKind(b: BlockState): string {
  if (b.kind === 'speak_streaming') return `speak_streaming(emitted=${b.emittedLength})`;
  return b.kind;
}

// ---- Re-exports kept for back-compat with callers/tests -------------------

export { walkBack, isAbortedEmptyAssistant } from './walk-back.js';
export type { WalkBackInput, ContentBlock, SpeakToolUseBlock, OtherBlock } from './walk-back.js';
export type { VoiceExtensionState, VoiceActivateMessage, VoiceDeactivateMessage } from './state-machine.js';
export { VOICE_CALL_STARTED_SENTINEL } from './state-machine.js';
export { renderInterpreterPrompt, RAW_INTERPRETER_PROMPT } from './interpreter-prompt.js';
export type { InterpreterPromptSubstitutions } from './interpreter-prompt.js';
export type { SpeechmuxClient, SpeechmuxClientFactory, IncomingFrame, OutgoingFrame, SpeechmuxClientFactoryOptions } from './speechmux-client.js';
export { createDefaultSpeechmuxClientFactory } from './speechmux-client.js';

// ---- Public factory -------------------------------------------------------

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface CreateVoiceExtensionOptions {
  defaultInterpreterModel: ModelRef;
  defaultWorkerModel: ModelRef;
  /** Optional client factory override — tests inject a fake. */
  speechmuxClientFactory?: SpeechmuxClientFactory;
}

export function createVoiceExtension(opts: CreateVoiceExtensionOptions): ExtensionFactory {
  const interpreterPrompt = renderInterpreterPrompt({
    workerProvider: opts.defaultWorkerModel.provider,
    workerModel: opts.defaultWorkerModel.modelId,
  });
  const clientFactory = opts.speechmuxClientFactory ?? createDefaultSpeechmuxClientFactory();

  return (pi: ExtensionAPI) => {
    // ---- Per-extension-instance state (per pimote session) ---------------
    let state: RuntimeState = initialState();
    let lastCtx: ExtensionContext | null = null;
    let speechmuxClient: SpeechmuxClient | null = null;
    /** Slot read by the `context` hook to return rewritten messages. */
    let pendingContextRewrite: AgentMessage[] | null = null;

    // ---- Reducer driver --------------------------------------------------
    const dispatch = async (event: FsmEvent): Promise<void> => {
      const evtTrace = traceEvent(event);
      const lifecycleBefore = state.lifecycle.kind;
      const { next, actions } = reduce(state, event, {
        config: { defaultInterpreterModel: opts.defaultInterpreterModel },
      });
      state = next;
      if (evtTrace || lifecycleBefore !== state.lifecycle.kind || actions.length > 0) {
        console.log(
          '[voice_trace] dispatch',
          JSON.stringify({
            event: evtTrace ?? event.type,
            lifecycle: `${lifecycleBefore}→${state.lifecycle.kind}`,
            actions: actions.map((a) => a.kind),
            blocks: blockSummary(state.message.blocks),
          }),
        );
      }
      for (const action of actions) {
        try {
          await execute(action);
        } catch (err) {
          console.warn('[voice] action failed', action.kind, err);
        }
      }
    };

    const execute = async (action: FsmAction): Promise<void> => {
      switch (action.kind) {
        case 'set_interpreter_model': {
          if (!lastCtx) {
            console.warn('[voice] set_interpreter_model: no ExtensionContext yet');
            return;
          }
          const model = lastCtx.modelRegistry.find(action.provider, action.modelId);
          if (!model) {
            console.warn(`[voice] set_interpreter_model: no model ${action.provider}/${action.modelId}`);
            return;
          }
          await pi.setModel(model);
          return;
        }

        case 'send_user_message': {
          // Ensure the agent is idle before sending. If it isn't, fire
          // a synthesized barge-in (ctx.abort()) and wait for teardown
          // — covers the case where the user spoke while the worker
          // was silently reasoning, so speechmux didn't issue an abort
          // (no TTS in flight to abort). See wait-for-idle.ts.
          if (lastCtx) {
            const ready = await ensureIdleWithImplicitAbort(lastCtx);
            if (!ready) {
              console.warn(`[voice] send_user_message: agent did not become idle within 2000ms after implicit abort, dropping: ${action.text.slice(0, 60)}`);
              return;
            }
          }
          pi.sendUserMessage(action.text, action.deliverAs ? { deliverAs: action.deliverAs } : undefined);
          return;
        }

        case 'inject_silent_user_message': {
          // sendMessage() with a `custom` role + triggerTurn:false appends
          // an entry that converts to a `role:"user"` message for the LLM
          // (see core/messages.ts convertToLlm) but does not start a turn
          // now. Exactly what we want for the end-of-call sentinel.
          pi.sendMessage(
            {
              customType: action.customType,
              content: action.text,
              display: true,
            },
            { triggerTurn: false },
          );
          return;
        }

        case 'open_ws': {
          // Reentrancy guard: close any prior client first.
          try {
            speechmuxClient?.close();
          } catch {
            /* ignore */
          }
          speechmuxClient = null;
          try {
            const client = await clientFactory({ wsUrl: action.url });
            speechmuxClient = client;
            client.onFrame((frame) => {
              void dispatch({ type: 'ws:incoming', frame });
            });
            await dispatch({ type: 'ws:opened' });
          } catch (err) {
            console.warn('[voice] speechmux open failed', err);
            await dispatch({ type: 'ws:open_failed', error: err });
          }
          return;
        }

        case 'close_ws': {
          try {
            speechmuxClient?.close();
          } catch {
            /* idempotent */
          }
          speechmuxClient = null;
          return;
        }

        case 'send_frame': {
          if (!speechmuxClient) {
            console.warn('[voice] send_frame with no client — dropping', action.frame.type);
            return;
          }
          const preview = action.frame.type === 'token' ? action.frame.text.slice(0, 60) : null;
          console.log('[voice_trace] send_frame', JSON.stringify({ type: action.frame.type, preview }));
          try {
            speechmuxClient.send(action.frame);
          } catch (err) {
            console.warn('[voice] speechmux send failed', action.frame.type, err);
          }
          return;
        }

        case 'abort_agent': {
          lastCtx?.abort();
          return;
        }

        case 'append_custom_entry': {
          pi.appendEntry(action.customType, action.data);
          return;
        }

        case 'emit_deactivate_request': {
          const sessionId = state.lifecycle.kind === 'active' || state.lifecycle.kind === 'activating' ? state.lifecycle.sessionId : '';
          const msg: VoiceDeactivateMessage = {
            type: 'pimote:voice:deactivate',
            sessionId,
          };
          pi.events.emit('pimote:voice:deactivate', msg);
          return;
        }

        case 'rewrite_context': {
          // Stash; the `context` hook below reads this on its return.
          pendingContextRewrite = action.messages;
          return;
        }
      }
    };

    // ---- EventBus listeners ---------------------------------------------
    pi.events.on('pimote:voice:activate', (data) => {
      void dispatch({ type: 'eb:activate', msg: data as VoiceActivateMessage });
    });
    pi.events.on('pimote:voice:deactivate', (data) => {
      void dispatch({ type: 'eb:deactivate', msg: data as VoiceDeactivateMessage });
    });

    // ---- speak() tool ---------------------------------------------------
    //
    // The streaming reducer is the sole emitter of speak `token`/`end`
    // frames. The `execute` here only returns the synthetic success
    // result so the agent loop progresses.
    pi.registerTool({
      name: 'speak',
      label: 'Speak',
      description: 'Speak text to the user via text-to-speech. This is the only way to produce audible output during a voice call. Keep messages short and TTS-friendly.',
      promptSnippet: 'speak(text) — speak text to the user (voice-mode only).',
      parameters: Type.Object({
        text: Type.String({ description: 'The text to speak to the user.' }),
      }),
      execute: async () => {
        if (state.lifecycle.kind === 'active' || state.lifecycle.kind === 'activating') {
          return { content: [{ type: 'text', text: 'ok' }], details: {} };
        }
        return {
          content: [
            {
              type: 'text',
              text: 'Voice call has ended. The user is now in text mode — do NOT call speak() again. Reply with normal assistant text. Any further speak() calls in this session will be rejected.',
            },
          ],
          details: {},
          isError: true,
        };
      },
    });

    // ---- SDK hooks ------------------------------------------------------

    pi.on('before_agent_start', (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
      lastCtx = ctx;
      if (state.lifecycle.kind === 'dormant') return;
      return { systemPrompt: `${interpreterPrompt}\n\n${event.systemPrompt ?? ''}`.trim() };
    });

    // The `tool_call` hook is intentionally NOT registered. The streaming
    // reducer is the sole emitter of speak frames; bulk-emission via
    // tool_call was the source of the double-emit class of bugs.
    //
    // The `turn_end` safety net is also intentionally NOT registered.
    // With per-speak `end` framing driven by `toolcall_end`, it was
    // redundant and contributed to double-end emissions.

    pi.on('message_start', (event: MessageStartEvent) => {
      // Only assistant messages reset the streaming state. User and
      // tool-result messages don't have content blocks we care about.
      if ((event.message as { role?: string }).role !== 'assistant') return;
      void dispatch({ type: 'sdk:message_start', message: event.message });
    });

    pi.on('message_update', (event, ctx: ExtensionContext) => {
      lastCtx = ctx;
      // Walkback no longer needs a captured snapshot — it operates on
      // the messages array passed to `sdk:context` directly.
      if (state.lifecycle.kind === 'dormant') return;

      const ame = (event as { assistantMessageEvent?: unknown }).assistantMessageEvent as
        | {
            type: string;
            contentIndex?: number;
            delta?: string;
            partial?: { content?: unknown[] };
            toolCall?: { id?: string; name?: string; arguments?: { text?: unknown } };
          }
        | undefined;
      if (!ame || typeof ame.contentIndex !== 'number') return;

      switch (ame.type) {
        case 'toolcall_start':
          void dispatch({
            type: 'sdk:toolcall_start',
            contentIndex: ame.contentIndex,
            partial: (ame.partial ?? {}) as Parameters<typeof dispatch>[0] extends { partial: infer P } ? P : never,
          });
          return;
        case 'toolcall_delta':
          void dispatch({
            type: 'sdk:toolcall_delta',
            contentIndex: ame.contentIndex,
            delta: typeof ame.delta === 'string' ? ame.delta : '',
            partial: (ame.partial ?? {}) as Parameters<typeof dispatch>[0] extends { partial: infer P } ? P : never,
          });
          return;
        case 'toolcall_end':
          void dispatch({
            type: 'sdk:toolcall_end',
            contentIndex: ame.contentIndex,
            toolCall: (ame.toolCall ?? {}) as Parameters<typeof dispatch>[0] extends { toolCall: infer T } ? T : never,
          });
          return;
        default:
          // text_*, thinking_* — not relevant to outbound streaming.
          return;
      }
    });

    pi.on('context', (event: ContextEvent, ctx: ExtensionContext) => {
      lastCtx = ctx;
      // The walkback reducer always runs walkBack (even when no rewrite
      // is pending — to strip aborted-empty-assistants). It writes the
      // result into `pendingContextRewrite` via the `rewrite_context`
      // action, which we read below.
      void dispatch({ type: 'sdk:context', messages: event.messages });
      const result = pendingContextRewrite;
      pendingContextRewrite = null;
      if (result) return { messages: result };
      return undefined;
    });
  };
}
