import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { PimoteSessionEvent } from '../../shared/dist/index.js';
import { mapAgentMessage, mapCustomEntry, type CustomEntryVisibility } from './message-mapper.js';

/**
 * Tree-navigation lifecycle events are synthesized by the ws-handler (they are
 * NOT part of the SDK's AgentSessionEvent union) and fed through the same
 * buffer so reconnect replay sees the navigation boundary.
 */
export interface TreeNavigationStartEvent {
  type: 'tree_navigation_start';
  targetId: string;
  summarizing: boolean;
}
export interface TreeNavigationEndEvent {
  type: 'tree_navigation_end';
}

/**
 * Everything EventBuffer.onEvent accepts: the real SDK session-event union plus
 * synthetic events Pimote injects at the boundary. The native SDK event union
 * already owns `bash_execution_update`; do not maintain a shadow copy here.
 * Typing against the real union means the mapper's per-event field access is
 * compiler-checked, so any upstream event rename/field change surfaces here
 * instead of silently falling through to a mismapped event.
 */
export type IncomingSdkEvent = AgentSessionEvent | TreeNavigationStartEvent | TreeNavigationEndEvent;

interface BufferEntry {
  cursor: number;
  event: PimoteSessionEvent;
}

/**
 * Event buffer for reconnect replay with coalescing.
 *
 * All events are forwarded live via sendLive(). For the replay buffer,
 * streaming deltas (message_update, tool_execution_update) are coalesced
 * into their corresponding start events rather than stored individually.
 */
export class EventBuffer {
  private readonly buffer: (BufferEntry | undefined)[];
  private head = 0; // index of oldest entry
  private tail = 0; // index of next write position
  private count = 0;
  /** Whether any replayable event has ever been inserted. A cursor can advance
   * solely through live-only deltas; that history is caught up rather than
   * considered stale. */
  private hasBufferedEvent = false;
  private _cursor: number;
  /** Sender id for the next user message: the echo of a prompt that just started a run. */
  private pendingPromptEcho: string | undefined;

  constructor(
    private readonly capacity: number,
    /** TUI-parity filter for persisted custom entries; omit to keep them invisible. */
    private readonly isCustomEntryVisible?: CustomEntryVisibility,
    /** First cursor minus one. A session id can outlive its buffer (idle
     *  reap, server restart, voice reopen), so production buffers start above
     *  any cursor an earlier buffer for the same session handed out. */
    private readonly baseCursor = 0,
    /** Entry ids of the session's context messages, attached to each final
     *  agent_end so clients can fork from messages that arrived by streaming. */
    private readonly getMessageEntryIds?: () => string[],
  ) {
    this.buffer = new Array(capacity);
    this._cursor = baseCursor;
  }

  get currentCursor(): number {
    return this._cursor;
  }

  /**
   * Stamp the next user message_start/message_end with `clientMessageId`.
   * Call it from pi's `started` preflight: pi prepares the run's messages
   * before it fires the callback and emits them right after, so the next user
   * message is the prompt's own. agent_settled drops an unused stamp.
   */
  expectPromptEcho(clientMessageId: string): void {
    this.pendingPromptEcho = clientMessageId;
  }

  /**
   * Process an SDK event: assign cursor, map to PimoteSessionEvent, forward live, and buffer (coalesced).
   */
  onEvent(sdkEvent: IncomingSdkEvent, sessionId: string, sendLive: (event: PimoteSessionEvent) => void, getLastMessage?: () => AgentMessage | undefined): void {
    // Native bash output is live-only. Keep it outside the replay cursor
    // stream so high-volume deltas cannot create gaps for reconnecting
    // observers.
    const cursor = sdkEvent.type === 'bash_execution_update' ? this._cursor : ++this._cursor;

    const pimoteEvent = this.mapEvent(sdkEvent, sessionId, cursor, getLastMessage);
    // Some SDK events have no Pimote wire representation. mapEvent returns null
    // for them, so we drop them rather than emitting a bogus client event.
    if (!pimoteEvent) return;
    sendLive(pimoteEvent);
    this.coalesceAndBuffer(pimoteEvent);
  }

  /**
   * Replay buffered events from a given cursor position.
   * Returns null if fromCursor is too old (full resync needed).
   * Returns empty array if client is caught up.
   */
  replay(fromCursor: number): PimoteSessionEvent[] | null {
    // A cursor outside this buffer's range came from an earlier buffer for the
    // same session id. Its position means nothing here.
    if (fromCursor < this.baseCursor || fromCursor > this._cursor) {
      return null;
    }
    if (fromCursor === this._cursor) {
      return [];
    }

    if (this.count === 0) {
      // A history made solely of live-only events is still caught up: there is
      // no replayable boundary the client could have missed. Once a replayable
      // event has been inserted, count cannot return to zero, so an empty
      // buffer here remains a genuine stale-cursor condition.
      return this.hasBufferedEvent ? null : [];
    }

    const oldestEntry = this.buffer[this.head];
    if (!oldestEntry) {
      return null;
    }

    // If fromCursor is older than the oldest buffered cursor - 1,
    // we can't guarantee complete replay
    if (fromCursor < oldestEntry.cursor - 1) {
      return null;
    }

    const events: PimoteSessionEvent[] = [];
    let idx = this.head;
    for (let i = 0; i < this.count; i++) {
      const entry = this.buffer[idx];
      if (entry && entry.cursor > fromCursor) {
        events.push(entry.event);
      }
      idx = (idx + 1) % this.capacity;
    }

    return events;
  }

  // ---- Private helpers ----

  private mapEvent(sdkEvent: IncomingSdkEvent, sessionId: string, cursor: number, getLastMessage?: () => AgentMessage | undefined): PimoteSessionEvent | null {
    const base = { sessionId, cursor, timestamp: new Date().toISOString() };

    switch (sdkEvent.type) {
      case 'agent_start':
        return { ...base, type: 'agent_start' };

      case 'agent_end':
        // The real agent_end carries { messages, willRetry } — there is no `error`
        // field on it. Error text reaches the client via the failed assistant
        // message (message_end), not here.
        if (sdkEvent.willRetry) return { ...base, type: 'agent_end', willRetry: true };
        return { ...base, type: 'agent_end', ...(this.getMessageEntryIds ? { messageEntryIds: this.getMessageEntryIds() } : {}) };

      case 'turn_start':
        return { ...base, type: 'turn_start' };

      case 'turn_end':
        return { ...base, type: 'turn_end' };

      case 'message_start':
        // The role lives on the event's message, not a top-level `role` field.
        return {
          ...base,
          type: 'message_start',
          role: sdkEvent.message.role,
          ...(sdkEvent.message.role === 'user' && this.pendingPromptEcho !== undefined ? { clientMessageId: this.pendingPromptEcho } : {}),
        };

      case 'message_update': {
        const ame = sdkEvent.assistantMessageEvent;
        const contentIndex = 'contentIndex' in ame ? ame.contentIndex : 0;

        // Determine content type from the sub-event
        let contentType: 'text' | 'thinking' | 'tool_call' = 'text';
        if (ame.type.startsWith('thinking_')) {
          contentType = 'thinking';
        } else if (ame.type.startsWith('toolcall_')) {
          contentType = 'tool_call';
        }

        // Determine subtype from the sub-event suffix
        let subtype: 'start' | 'delta' | 'end' = 'delta';
        if (ame.type.endsWith('_start')) {
          subtype = 'start';
        } else if (ame.type.endsWith('_end')) {
          subtype = 'end';
        }

        const delta = 'delta' in ame ? ame.delta : '';

        const result: PimoteSessionEvent & { type: 'message_update' } = {
          ...base,
          type: 'message_update',
          contentIndex,
          subtype,
          content: {
            type: contentType,
            text: delta,
          },
        };

        // Extract tool call metadata on toolcall_start from the partial message.
        // Include initial arguments as the text value so the client can render
        // the path / language / body incrementally instead of waiting for the
        // first delta (which may arrive much later).
        if (contentType === 'tool_call' && subtype === 'start' && 'partial' in ame) {
          const block = ame.partial.content[contentIndex];
          if (block && block.type === 'toolCall') {
            result.toolCallId = block.id;
            result.toolName = block.name;
            // Serialize initial arguments so the client's streaming parser
            // and path-extraction regex have something to work with immediately.
            if (typeof block.arguments === 'object' && block.arguments !== null) {
              result.content.text = JSON.stringify(block.arguments);
            }
          }
        }

        return result;
      }

      case 'message_end': {
        // Some providers (e.g. OpenAI) send message_end with empty content — the actual
        // message is only available in session.messages. Use getLastMessage() fallback.
        let message: AgentMessage | undefined = sdkEvent.message;
        const isEmpty = (m: AgentMessage | undefined): boolean => !m || !('content' in m) || !m.content || (Array.isArray(m.content) && m.content.length === 0);
        if (isEmpty(message) && getLastMessage) {
          message = getLastMessage();
        }
        let clientMessageId: string | undefined;
        if (sdkEvent.message.role === 'user' && this.pendingPromptEcho !== undefined) {
          clientMessageId = this.pendingPromptEcho;
          this.pendingPromptEcho = undefined;
        }
        return {
          ...base,
          type: 'message_end',
          message: message ? mapAgentMessage(message) : { role: 'assistant', content: [] },
          ...(clientMessageId !== undefined ? { clientMessageId } : {}),
        };
      }

      case 'tool_execution_start':
        return {
          ...base,
          type: 'tool_execution_start',
          toolName: sdkEvent.toolName,
          toolCallId: sdkEvent.toolCallId,
          args: sdkEvent.args,
        };

      case 'tool_execution_update':
        return {
          ...base,
          type: 'tool_execution_update',
          toolCallId: sdkEvent.toolCallId,
          content: typeof sdkEvent.partialResult === 'string' ? sdkEvent.partialResult : '',
        };

      case 'tool_execution_end':
        return {
          ...base,
          type: 'tool_execution_end',
          toolCallId: sdkEvent.toolCallId,
          result: sdkEvent.result,
          isError: sdkEvent.isError || undefined,
          ...(sdkEvent.durationMs !== undefined ? { durationMs: sdkEvent.durationMs } : {}),
        };

      // The SDK emits `compaction_start` / `compaction_end`; pimote's wire
      // contract with the client names these `auto_compaction_*`.
      case 'compaction_start':
        return {
          ...base,
          type: 'auto_compaction_start',
          reason: sdkEvent.reason,
        };

      case 'compaction_end':
        return {
          ...base,
          type: 'auto_compaction_end',
          result: sdkEvent.result,
          aborted: sdkEvent.aborted,
          willRetry: sdkEvent.willRetry,
          ...(sdkEvent.errorMessage ? { errorMessage: sdkEvent.errorMessage } : {}),
        };

      case 'auto_retry_start':
        return {
          ...base,
          type: 'auto_retry_start',
          attempt: sdkEvent.attempt,
          maxAttempts: sdkEvent.maxAttempts,
          delayMs: sdkEvent.delayMs,
          errorMessage: sdkEvent.errorMessage,
        };

      case 'auto_retry_end':
        return {
          ...base,
          type: 'auto_retry_end',
          success: sdkEvent.success,
          attempt: sdkEvent.attempt,
          ...(sdkEvent.finalError ? { finalError: sdkEvent.finalError } : {}),
        };

      case 'tree_navigation_start':
        return {
          ...base,
          type: 'tree_navigation_start',
          targetId: sdkEvent.targetId,
          summarizing: sdkEvent.summarizing,
        };

      case 'tree_navigation_end':
        return { ...base, type: 'tree_navigation_end' };

      // `agent_settled` is the authoritative idle boundary (fired after the
      // terminal `agent_end` and after awaited `agent_end` listeners settle,
      // and only when no retry/compaction/queued-continuation is pending). It
      // drives the idle UI transition + completion notification.
      case 'agent_settled':
        this.pendingPromptEcho = undefined;
        return { ...base, type: 'agent_settled', ...(sdkEvent.aborted ? { aborted: true } : {}) };

      // Custom entries with a registered renderer become display-only
      // custom messages (same visibility rule as mapContextEntries, so live
      // events and resyncs agree). Everything else on this list is a real SDK
      // event with no Pimote wire representation — dropped rather than
      // mis-emitted. Pi 0.81's summarization retry lifecycle remains
      // server-local until the client protocol gains retry variants.
      case 'entry_appended':
        if (sdkEvent.entry.type !== 'custom' || !this.isCustomEntryVisible?.(sdkEvent.entry.customType)) {
          return null;
        }
        return { ...base, type: 'custom_entry', message: mapCustomEntry(sdkEvent.entry) };

      case 'queue_update':
        return { ...base, type: 'queue_update', steering: [...sdkEvent.steering], followUp: [...sdkEvent.followUp] };

      case 'session_info_changed':
      case 'thinking_level_changed':
      case 'summarization_retry_scheduled':
      case 'summarization_retry_attempt_start':
      case 'summarization_retry_finished':
        return null;

      case 'bash_execution_update':
        return {
          sessionId,
          timestamp: base.timestamp,
          type: 'bash_execution_update',
          ...(sdkEvent.id !== undefined ? { id: sdkEvent.id } : {}),
          delta: sdkEvent.delta,
        };

      default: {
        // Exhaustiveness guard: if the SDK adds a new AgentSessionEvent member,
        // this line fails to compile until it's handled above.
        const _exhaustive: never = sdkEvent;
        void _exhaustive;
        return null;
      }
    }
  }

  private coalesceAndBuffer(event: PimoteSessionEvent): void {
    switch (event.type) {
      case 'message_update':
      case 'tool_execution_update':
      case 'bash_execution_update':
        // Streaming deltas are forwarded live but not stored in the replay buffer.
        // Only start/end bookends are buffered — reconnect replays the finalized state.
        break;

      default:
        this.pushToBuffer(event);
        break;
    }
  }

  private pushToBuffer(event: PimoteSessionEvent): void {
    if (!('cursor' in event)) return;
    this.hasBufferedEvent = true;
    this.buffer[this.tail] = { cursor: event.cursor, event };
    this.tail = (this.tail + 1) % this.capacity;

    if (this.count < this.capacity) {
      this.count++;
    } else {
      // Overflow: oldest entry dropped, advance head
      this.head = (this.head + 1) % this.capacity;
    }
  }
}
