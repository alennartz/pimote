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
import { JSONParser } from '@streamparser/json';
import {
  initialRuntimeState,
  reduceActivate,
  reduceDeactivate,
  reduceSpeakEnd,
  reduceSpeakToolCall,
  reduceSpeakToolDelta,
  reduceSpeechmuxFailed,
  reduceSpeechmuxFrame,
  reduceSpeechmuxOpened,
  reduceTurnEnd,
  type VoiceAction,
  type VoiceRuntimeState,
} from './extension-runtime.js';
import { renderInterpreterPrompt } from './interpreter-prompt.js';
import { createDefaultSpeechmuxClientFactory, type OutgoingFrame, type SpeechmuxClient, type SpeechmuxClientFactory } from './speechmux-client.js';
import { waitForAgentIdle } from './wait-for-idle.js';
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

    // Pre-warm buffer: speak token / end frames emitted during the brief
    // window between `voice:activate` and speechmux WS open are stashed
    // here and flushed when the WS opens. See `reduceActivate` doc-comment.
    const pendingFrames: OutgoingFrame[] = [];
    const sendOrBuffer = (frame: OutgoingFrame): void => {
      if (speechmuxClient) {
        try {
          speechmuxClient.send(frame);
        } catch (err) {
          console.warn('[voice] speechmux send failed', frame.type, err);
        }
        return;
      }
      pendingFrames.push(frame);
    };

    // Utterance-boundary tracking: true between the first token of an
    // utterance and the corresponding `{type:'end'}`. Used to suppress
    // spurious `emit_speechmux_end` actions on assistant messages that
    // didn't speak at all, and to dedupe message_end vs turn_end ends.
    let hasStreamedSinceLastEnd = false;

    // Wait-for-idle helper extracted to `wait-for-idle.ts` so the polling
    // logic is unit-testable without a real ExtensionContext. See that
    // module's doc-comment for rationale (barge-in race vs auto-drain).
    //
    // Known limitation: concurrent `executeActions` invocations (from
    // back-to-back speechmux frames) aren't serialized, so two user
    // frames in rapid succession may both poll idle and both attempt to
    // send. Speechmux orders frames such that this is rare in practice;
    // a per-extension async queue is the proper fix when we see it bite.

    // ---- speak() argument streaming state -------------------------------
    // Per-content-index parser state for an in-flight assistant message.
    // Reset on every `start` event from the provider stream.
    interface SpeakStreamEntry {
      /** Tool name once known from `partial.content[i].name`. */
      toolName: string | null;
      /** Resolved tool_use id once known. */
      toolCallId: string | null;
      /** Streaming JSON parser scoped to `$.text`, lazily created when name === 'speak'. */
      parser: JSONParser | null;
      /** Length of the speak text already forwarded to speechmux. */
      emittedLength: number;
      /** Latest known partial value of the `text` arg as seen by the streamparser. */
      latestText: string;
    }
    const speakStreams = new Map<number, SpeakStreamEntry>();
    const streamedToolCallIds = new Set<string>();

    const ensureSpeakStream = (contentIndex: number): SpeakStreamEntry => {
      let entry = speakStreams.get(contentIndex);
      if (!entry) {
        entry = { toolName: null, toolCallId: null, parser: null, emittedLength: 0, latestText: '' };
        speakStreams.set(contentIndex, entry);
      }
      return entry;
    };

    const initSpeakParser = (entry: SpeakStreamEntry): void => {
      if (entry.parser) return;
      try {
        const parser = new JSONParser({
          emitPartialTokens: true,
          emitPartialValues: true,
          paths: ['$.text'],
          keepStack: false,
        });
        parser.onValue = (info) => {
          if (info.key !== 'text' && info.key !== undefined) return;
          const value = typeof info.value === 'string' ? info.value : '';
          // streamparser may emit a longer prefix than last time; never shrink.
          if (value.length > entry.latestText.length) entry.latestText = value;
        };
        parser.onError = () => {
          // Disable further parsing on errors; the toolcall_end fallback
          // will flush any unsent tail using the SDK-provided full args.
          entry.parser = null;
        };
        entry.parser = parser;
      } catch {
        entry.parser = null;
      }
    };

    /** Forward any newly-revealed suffix of `entry.latestText` to speechmux. */
    const flushSpeakSuffix = (entry: SpeakStreamEntry): void => {
      if (entry.latestText.length <= entry.emittedLength) return;
      const fragment = entry.latestText.slice(entry.emittedLength);
      entry.emittedLength = entry.latestText.length;
      const result = reduceSpeakToolDelta(runtime, { fragment });
      runtime = result.next;
      void executeActions(result.actions);
    };

    const resetSpeakStreams = (): void => {
      for (const entry of speakStreams.values()) {
        try {
          entry.parser?.end();
        } catch {
          /* ignore */
        }
      }
      speakStreams.clear();
    };

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
            const client = await clientFactory({ wsUrl: action.wsUrl });
            speechmuxClient = client;
            // Flush any speak tokens / end frames that the interpreter
            // produced while the WS was still connecting (pre-warm path).
            // Done before attaching `onFrame` so the flush can't be
            // reordered with respect to incoming user / abort frames.
            if (pendingFrames.length > 0) {
              const drained = pendingFrames.splice(0, pendingFrames.length);
              for (const frame of drained) {
                try {
                  client.send(frame);
                } catch (err) {
                  console.warn('[voice] pre-warm flush failed', frame.type, err);
                }
              }
            }
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
          // Drop any frames still queued for a WS that will never open
          // (e.g. a deactivate that races a pre-warm activate).
          pendingFrames.length = 0;
          // Reset utterance-boundary tracking so a subsequent activate
          // starts cleanly (no inherited "streaming in progress" state).
          hasStreamedSinceLastEnd = false;
          return;
        }
        case 'send_user_message': {
          // Race fix: ensure the agent is actually idle before injecting a
          // user message. Otherwise the SDK throws and our utterance is
          // dropped on the floor. See `waitForAgentIdle` doc-comment.
          if (lastCtx && !lastCtx.isIdle()) {
            const idle = await waitForAgentIdle(lastCtx);
            if (!idle) {
              console.warn(`[voice] send_user_message: agent did not become idle within 2000ms, dropping message: ${action.text.slice(0, 60)}`);
              return;
            }
          }
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
          sendOrBuffer({ type: 'token', text: action.text });
          hasStreamedSinceLastEnd = true;
          return;
        }
        case 'emit_speechmux_end': {
          // Suppress when no tokens have been streamed since the last end
          // — avoids emitting end on an assistant message that only ran
          // tool calls (subagent, bash) without speaking, and dedupes the
          // message_end / turn_end safety-net path.
          if (!hasStreamedSinceLastEnd) return;
          sendOrBuffer({ type: 'end' });
          hasStreamedSinceLastEnd = false;
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
        // The `tool_call` hook streams `speak(...)` invocations to speechmux
        // via the captured runtime closure, but the pi-SDK `tool_call` hook
        // can only *block* the call — it can't synthesize a result — so this
        // `execute` still runs. When a call is active, return a trivial
        // success so the interpreter loop advances cleanly. Only surface an
        // error when the tool is (mis-)used outside of an active voice call.
        if (runtime.state === 'active') {
          return {
            content: [{ type: 'text', text: 'ok' }],
            details: {},
          };
        }
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
      // If we already streamed this tool call's text incrementally during
      // `message_update` (low-latency path), skip the bulk token frame here.
      // We still call the reducer so the trivial result + state advance
      // happen exactly as before.
      const alreadyStreamed = streamedToolCallIds.has(event.toolCallId);
      streamedToolCallIds.delete(event.toolCallId);
      const result = reduceSpeakToolCall(runtime, { text, alreadyStreamed });
      runtime = result.next;
      await executeActions(result.actions);
      // The pi-SDK `tool_call` hook can only `block` the call — it can't
      // synthesize a result — so we let the registered `speak` tool's own
      // `execute` run; it returns a trivial success when `state === 'active'`
      // (see the `registerTool` above). Audible streaming has already been
      // emitted by `executeActions` above (or piecemeal during streaming).
      return;
    });

    pi.on('turn_end', async (_event: TurnEndEvent, ctx: ExtensionContext): Promise<void> => {
      lastCtx = ctx;
      // Safety net. The primary finalization path is `reduceSpeakEnd`,
      // fired from the streaming `toolcall_end` handler above. The wiring's
      // `hasStreamedSinceLastEnd` flag makes this a no-op whenever that
      // path already emitted end. It covers edge cases such as a provider
      // that doesn't stream tool args (no `toolcall_end` fires, but the
      // legacy `tool_call` bulk path streamed the text).
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

      // ---- Low-latency speak() streaming -------------------------------
      // Forward `speak(text)` argument fragments to speechmux as the LLM
      // emits them, instead of waiting for the full tool_use block to
      // finalize at the `tool_call` hook. Only providers that stream tool
      // arguments (Anthropic native, OpenAI with tool_stream, etc.) will
      // produce `toolcall_*` events; everything else falls back to the
      // `tool_call` hook's bulk-text path with no behavior change.
      const ame = (event as { assistantMessageEvent?: unknown }).assistantMessageEvent as
        | { type: string; contentIndex?: number; delta?: string; partial?: { content?: unknown[] }; toolCall?: { id?: string; name?: string; arguments?: { text?: unknown } } }
        | undefined;
      if (!ame) return;
      try {
        switch (ame.type) {
          case 'start': {
            // New assistant message — drop any leftover per-stream state.
            resetSpeakStreams();
            return;
          }
          case 'toolcall_start': {
            if (typeof ame.contentIndex !== 'number') return;
            ensureSpeakStream(ame.contentIndex);
            return;
          }
          case 'toolcall_delta': {
            if (typeof ame.contentIndex !== 'number') return;
            const entry = ensureSpeakStream(ame.contentIndex);
            // Lazily resolve tool name from the running partial. Bail once
            // we know it isn't `speak` so we don't waste cycles parsing.
            if (entry.toolName === null) {
              const partialBlock = ame.partial?.content?.[ame.contentIndex] as { name?: unknown; id?: unknown } | undefined;
              if (partialBlock && typeof partialBlock.name === 'string') {
                entry.toolName = partialBlock.name;
                if (typeof partialBlock.id === 'string') entry.toolCallId = partialBlock.id;
              }
            }
            if (entry.toolName !== null && entry.toolName !== 'speak') return;
            if (entry.toolName === 'speak') initSpeakParser(entry);
            const delta = typeof ame.delta === 'string' ? ame.delta : '';
            if (delta.length > 0 && entry.parser) {
              try {
                entry.parser.write(delta);
              } catch {
                entry.parser = null;
              }
            }
            flushSpeakSuffix(entry);
            return;
          }
          case 'toolcall_end': {
            if (typeof ame.contentIndex !== 'number') return;
            const entry = ensureSpeakStream(ame.contentIndex);
            const tc = ame.toolCall;
            if (entry.toolName === null && typeof tc?.name === 'string') entry.toolName = tc.name;
            if (entry.toolCallId === null && typeof tc?.id === 'string') entry.toolCallId = tc.id;
            if (entry.toolName === 'speak') {
              // Flush parser one last time, then guarantee full coverage by
              // diffing against the SDK-provided fully-parsed argument.
              flushSpeakSuffix(entry);
              const finalText = typeof tc?.arguments?.text === 'string' ? tc.arguments.text : '';
              if (finalText.length > entry.emittedLength) {
                const tail = finalText.slice(entry.emittedLength);
                entry.emittedLength = finalText.length;
                const result = reduceSpeakToolDelta(runtime, { fragment: tail });
                runtime = result.next;
                void executeActions(result.actions);
              }
              // Finalize this speak as its own utterance: emit {type:'end'}
              // now that the tool_use block is complete. The wiring's
              // `hasStreamedSinceLastEnd` flag gates this so empty speaks
              // (nothing streamed) don't emit spurious ends.
              const endResult = reduceSpeakEnd(runtime);
              runtime = endResult.next;
              void executeActions(endResult.actions);
              // Mark the upcoming `tool_call` hook to skip its bulk send only
              // if we actually delivered something; otherwise fall through
              // to the legacy path so non-streaming providers still work.
              if (entry.toolCallId && entry.emittedLength > 0) {
                streamedToolCallIds.add(entry.toolCallId);
              }
            }
            try {
              entry.parser?.end();
            } catch {
              /* ignore */
            }
            entry.parser = null;
            return;
          }
          case 'done':
          case 'error': {
            resetSpeakStreams();
            return;
          }
        }
      } catch (err) {
        console.warn('[voice] speak-stream handler failed', err);
      }
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
