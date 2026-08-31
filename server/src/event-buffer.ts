import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { PimoteSessionEvent } from '../../shared/dist/index.js';
import { mapAgentMessage } from './message-mapper.js';

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
  private _cursor = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Array(capacity);
  }

  get currentCursor(): number {
    return this._cursor;
  }

  /**
   * Process an SDK event: assign cursor, map to PimoteSessionEvent, forward live, and buffer (coalesced).
   */
  onEvent(sdkEvent: IncomingSdkEvent, sessionId: string, sendLive: (event: PimoteSessionEvent) => void, getLastMessage?: () => AgentMessage | undefined): void {
    this._cursor++;
    const cursor = this._cursor;

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
    if (fromCursor >= this._cursor) {
      return [];
    }

    if (this.count === 0) {
      // Buffer is empty but cursor has advanced — can't replay
      return fromCursor < this._cursor ? null : [];
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
        return { ...base, type: 'agent_end', ...(sdkEvent.willRetry ? { willRetry: true } : {}) };

      case 'turn_start':
        return { ...base, type: 'turn_start' };

      case 'turn_end':
        return { ...base, type: 'turn_end' };

      case 'message_start':
        // The role lives on the event's message, not a top-level `role` field.
        return { ...base, type: 'message_start', role: sdkEvent.message.role };

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
        return {
          ...base,
          type: 'message_end',
          message: message ? mapAgentMessage(message) : { role: 'assistant', content: [] },
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
        return { ...base, type: 'agent_settled' };

      // Real SDK events with no Pimote wire representation. Dropped rather than
      // mis-emitted; wire them up here if the client grows a use for them.
      // `entry_appended` is the authoritative persisted-entry stream; adopting
      // it is deferred design work (see docs/brainstorms/entry-appended-refactor.md)
      // — dropped at the wire for now. Pi 0.81's summarization retry lifecycle
      // remains server-local until the client protocol gains retry variants.
      case 'queue_update':
      case 'session_info_changed':
      case 'thinking_level_changed':
      case 'entry_appended':
      case 'summarization_retry_scheduled':
      case 'summarization_retry_attempt_start':
      case 'summarization_retry_finished':
      case 'bash_execution_update':
        return null;

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
        // Streaming deltas are forwarded live but not stored in the replay buffer.
        // Only start/end bookends are buffered — reconnect replays the finalized state.
        break;

      default:
        this.pushToBuffer(event);
        break;
    }
  }

  private pushToBuffer(event: PimoteSessionEvent): void {
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
