// @pimote/voice — voice extension for pimote.
//
// See docs/plans/voice-mode.md for the architectural contract. This file
// wires the pure reducers in `extension-runtime.ts` to the pi SDK's
// `ExtensionAPI`, producing an `ExtensionFactory` that can be loaded into
// every pimote session (dormant by default, activated by the server-side
// VoiceOrchestrator via EventBus messages).

import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ContextEvent, BeforeAgentStartEvent, ToolCallEvent, TurnEndEvent } from '@mariozechner/pi-coding-agent';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import {
  initialRuntimeState,
  reduceActivate,
  reduceDeactivate,
  reduceSpeakToolCall,
  reduceSpeechmuxFailed,
  reduceSpeechmuxFrame,
  reduceSpeechmuxOpened,
  reduceTurnEnd,
  type VoiceAction,
  type VoiceRuntimeState,
} from './extension-runtime.js';
import { renderInterpreterPrompt } from './interpreter-prompt.js';
import { createDefaultSpeechmuxClientFactory, type SpeechmuxClient, type SpeechmuxClientFactory } from './speechmux-client.js';
import type { VoiceActivateMessage, VoiceDeactivateMessage } from './state-machine.js';
import type { ContentBlock } from './walk-back.js';
import { walkBack } from './walk-back.js';

export { walkBack, isAbortedEmptyAssistant } from './walk-back.js';
export type { WalkBackInput, ContentBlock, SpeakToolUseBlock, OtherBlock } from './walk-back.js';
export type { VoiceExtensionState, VoiceActivateMessage, VoiceDeactivateMessage } from './state-machine.js';
export { VOICE_CALL_STARTED_SENTINEL } from './state-machine.js';
export { renderInterpreterPrompt, RAW_INTERPRETER_PROMPT } from './interpreter-prompt.js';
export type { InterpreterPromptSubstitutions } from './interpreter-prompt.js';
export type { SpeechmuxClient, SpeechmuxClientFactory, IncomingFrame, OutgoingFrame, SpeechmuxClientFactoryOptions } from './speechmux-client.js';
export { createDefaultSpeechmuxClientFactory } from './speechmux-client.js';
export * from './extension-runtime.js';

/** Model reference used for interpreter / worker defaults. */
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

/**
 * Factory for the pimote voice extension. The returned ExtensionFactory
 * registers the `speak` tool, the before_agent_start + context hooks, the
 * message_update capture subscriber, and listens for
 * `pimote:voice:activate` / `pimote:voice:deactivate` EventBus messages.
 */
export function createVoiceExtension(opts: CreateVoiceExtensionOptions): ExtensionFactory {
  const interpreterPrompt = renderInterpreterPrompt({
    workerProvider: opts.defaultWorkerModel.provider,
    workerModel: opts.defaultWorkerModel.modelId,
  });
  const clientFactory = opts.speechmuxClientFactory ?? createDefaultSpeechmuxClientFactory();

  return (pi: ExtensionAPI) => {
    // Per-extension-instance state. Each pimote session gets its own factory
    // invocation, so these are per-session.
    let runtime: VoiceRuntimeState = initialRuntimeState();
    let speechmuxClient: SpeechmuxClient | null = null;
    let capturedStreamingMessage: AgentMessage | null = null;
    let walkBackInput: { heardText: string } | null = null;
    let lastCtx: ExtensionContext | null = null;

    // ---- Action executor -------------------------------------------------
    const executeActions = async (actions: VoiceAction[]): Promise<void> => {
      for (const action of actions) {
        try {
          await executeAction(action);
        } catch (err) {
          console.warn('[voice] action failed', action.kind, err);
        }
      }
    };

    const executeAction = async (action: VoiceAction): Promise<void> => {
      switch (action.kind) {
        case 'open_speechmux': {
          try {
            const client = await clientFactory({ wsUrl: action.wsUrl, callToken: action.callToken });
            speechmuxClient = client;
            client.onFrame((frame) => {
              const result = reduceSpeechmuxFrame(runtime, frame);
              runtime = result.next;
              void executeActions(result.actions);
            });
            const opened = reduceSpeechmuxOpened(runtime, { defaultInterpreterModel: opts.defaultInterpreterModel });
            runtime = opened.next;
            await executeActions(opened.actions);
          } catch (err) {
            console.warn('[voice] speechmux open failed', err);
            const failed = reduceSpeechmuxFailed(runtime);
            runtime = failed.next;
            await executeActions(failed.actions);
          }
          return;
        }
        case 'close_speechmux': {
          try {
            speechmuxClient?.close();
          } catch {
            /* idempotent */
          }
          speechmuxClient = null;
          return;
        }
        case 'send_user_message': {
          pi.sendUserMessage(action.text, action.deliverAs ? { deliverAs: action.deliverAs } : undefined);
          return;
        }
        case 'abort': {
          lastCtx?.abort();
          return;
        }
        case 'set_walkback_watermark': {
          walkBackInput = { heardText: action.heardText };
          return;
        }
        case 'clear_walkback_watermark': {
          walkBackInput = null;
          capturedStreamingMessage = null;
          return;
        }
        case 'append_custom_entry': {
          pi.appendEntry(action.customType, action.data);
          return;
        }
        case 'set_model': {
          if (!lastCtx) {
            console.warn('[voice] set_model: no ExtensionContext available yet');
            return;
          }
          const model = lastCtx.modelRegistry.find(action.provider, action.modelId);
          if (!model) {
            console.warn(`[voice] set_model: no model found for ${action.provider}/${action.modelId}`);
            return;
          }
          await pi.setModel(model);
          return;
        }
        case 'emit_deactivate_request': {
          const sessionId = runtime.sessionId;
          const msg: VoiceDeactivateMessage = {
            type: 'pimote:voice:deactivate',
            sessionId: sessionId ?? '',
          };
          pi.events.emit('pimote:voice:deactivate', msg);
          return;
        }
        case 'stream_speechmux_token': {
          try {
            speechmuxClient?.send({ type: 'token', text: action.text });
          } catch (err) {
            console.warn('[voice] stream_speechmux_token failed', err);
          }
          return;
        }
        case 'emit_speechmux_end': {
          try {
            speechmuxClient?.send({ type: 'end' });
          } catch (err) {
            console.warn('[voice] emit_speechmux_end failed', err);
          }
          return;
        }
        case 'return_speak_tool_result': {
          // Handled inline by the tool_call hook's return value.
          return;
        }
      }
    };

    // ---- EventBus listeners ---------------------------------------------
    pi.events.on('pimote:voice:activate', (data) => {
      const msg = data as VoiceActivateMessage;
      const result = reduceActivate(runtime, msg, { defaultInterpreterModel: opts.defaultInterpreterModel });
      runtime = result.next;
      void executeActions(result.actions);
    });
    pi.events.on('pimote:voice:deactivate', (data) => {
      const msg = data as VoiceDeactivateMessage;
      const result = reduceDeactivate(runtime, msg);
      runtime = result.next;
      void executeActions(result.actions);
    });

    // ---- speak() tool ---------------------------------------------------
    pi.registerTool({
      name: 'speak',
      label: 'Speak',
      description: 'Speak text to the user via text-to-speech. This is the only way to produce audible output during a voice call. Keep messages short and TTS-friendly.',
      promptSnippet: 'speak(text) — speak text to the user (voice-mode only).',
      parameters: Type.Object({
        text: Type.String({ description: 'The text to speak to the user.' }),
      }),
      execute: async (_toolCallId, _params, _signal, _onUpdate, _ctx) => {
        // Unreachable while `state === active` because the tool_call hook
        // intercepts with { action: 'handled' } and streams to speechmux.
        // When dormant, surface a clear error so the model knows to stop
        // calling it.
        return {
          content: [{ type: 'text', text: 'speak() is only available during an active voice call.' }],
          details: {},
          isError: true,
        };
      },
    });

    // ---- Hooks ----------------------------------------------------------
    pi.on('before_agent_start', (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
      lastCtx = ctx;
      if (runtime.state !== 'active') return;
      return { systemPrompt: `${interpreterPrompt}\n\n${event.systemPrompt ?? ''}`.trim() };
    });

    pi.on('tool_call', async (event: ToolCallEvent, ctx: ExtensionContext) => {
      lastCtx = ctx;
      if (event.toolName !== 'speak') return;
      if (runtime.state !== 'active') return;
      const input = event.input as { text?: unknown };
      const text = typeof input.text === 'string' ? input.text : '';
      const result = reduceSpeakToolCall(runtime, { text });
      runtime = result.next;
      await executeActions(result.actions);
      // We don't have a way to short-circuit tool execution with a synthesized
      // success result via the current tool_call hook contract (it can only
      // `block` the call). Returning undefined lets the registered `speak`
      // tool's own `execute` run and return a trivial success — it's a no-op
      // apart from emitting a tool_result that the model will see.
      return;
    });

    pi.on('turn_end', async (_event: TurnEndEvent, ctx: ExtensionContext): Promise<void> => {
      lastCtx = ctx;
      const result = reduceTurnEnd(runtime);
      runtime = result.next;
      await executeActions(result.actions);
    });

    pi.on('message_update', (event, ctx: ExtensionContext) => {
      lastCtx = ctx;
      if (runtime.state !== 'active') return;
      // Shallow-copy the content array so later abort-triggered access is
      // unaffected by pi mutating the in-flight message.
      const msg = event.message as AgentMessage & { content?: unknown };
      const content = Array.isArray(msg.content) ? [...(msg.content as ContentBlock[])] : [];
      capturedStreamingMessage = { ...msg, content } as unknown as AgentMessage;
    });

    pi.on('context', (event: ContextEvent, ctx: ExtensionContext) => {
      lastCtx = ctx;
      if (runtime.state !== 'active' && walkBackInput === null) return;
      const rewritten = walkBack({
        messages: event.messages,
        heardText: walkBackInput?.heardText ?? null,
        captured: capturedStreamingMessage as WalkBackCaptured,
      });
      walkBackInput = null;
      capturedStreamingMessage = null;
      return { messages: rewritten };
    });
  };
}

// Local alias — avoids re-importing the WalkBack input captured-shape just to
// narrow a field type on the public API.
type WalkBackCaptured = Parameters<typeof walkBack>[0]['captured'];
