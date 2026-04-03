import type { PimoteSessionEvent } from '@pimote/shared';
import { mapAgentMessage, type SdkMessage } from './message-mapper.js';

/**
 * Structural type for SDK events consumed by the event mapper.
 * All properties except `type` are optional to accommodate the full
 * AgentSessionEvent union without importing it.
 */
/**
 * Structural type for the pi-ai AssistantMessageEvent carried
 * on message_update events. Only the fields we need are listed.
 */
interface SdkAssistantMessageEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  /** The partial AssistantMessage — used to extract tool call metadata on toolcall_start */
  partial?: { content?: Array<{ type?: string; id?: string; name?: string }> };
}

interface SdkEvent {
  type: string;
  error?: string;
  role?: string;
  message?: SdkMessage;
  /** pi-ai AssistantMessageEvent carried on message_update events */
  assistantMessageEvent?: SdkAssistantMessageEvent;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  /** Partial result from tool execution updates */
  partialResult?: unknown;
  reason?: string;
  aborted?: boolean;
  willRetry?: boolean;
  errorMessage?: string;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  success?: boolean;
  finalError?: string;
  extensionName?: string;
}

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
  onEvent(sdkEvent: SdkEvent, sessionId: string, sendLive: (event: PimoteSessionEvent) => void, getLastMessage?: () => SdkMessage | undefined): void {
    this._cursor++;
    const cursor = this._cursor;

    const pimoteEvent = this.mapEvent(sdkEvent, sessionId, cursor, getLastMessage);
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

  private mapEvent(sdkEvent: SdkEvent, sessionId: string, cursor: number, getLastMessage?: () => SdkMessage | undefined): PimoteSessionEvent {
    const base = { sessionId, cursor, timestamp: new Date().toISOString() };

    switch (sdkEvent.type) {
      case 'agent_start':
        return { ...base, type: 'agent_start' };

      case 'agent_end':
        return { ...base, type: 'agent_end', ...(sdkEvent.error ? { error: sdkEvent.error } : {}) };

      case 'turn_start':
        return { ...base, type: 'turn_start' };

      case 'turn_end':
        return { ...base, type: 'turn_end' };

      case 'message_start':
        return { ...base, type: 'message_start', role: sdkEvent.role ?? 'assistant' };

      case 'message_update': {
        const ame = sdkEvent.assistantMessageEvent;
        const contentIndex = ame?.contentIndex ?? 0;

        // Determine content type from the sub-event
        let contentType: 'text' | 'thinking' | 'tool_call' = 'text';
        if (ame?.type?.startsWith('thinking_')) {
          contentType = 'thinking';
        } else if (ame?.type?.startsWith('toolcall_')) {
          contentType = 'tool_call';
        }

        // Determine subtype from the sub-event suffix
        let subtype: 'start' | 'delta' | 'end' = 'delta';
        if (ame?.type?.endsWith('_start')) {
          subtype = 'start';
        } else if (ame?.type?.endsWith('_end')) {
          subtype = 'end';
        }

        const delta = ame?.delta ?? '';

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

        // Extract tool call metadata on toolcall_start from the partial message
        if (contentType === 'tool_call' && subtype === 'start' && ame?.partial?.content) {
          const block = ame.partial.content[contentIndex];
          if (block && block.type === 'toolCall') {
            result.toolCallId = block.id;
            result.toolName = block.name;
          }
        }

        return result;
      }

      case 'message_end': {
        // Some providers (e.g. OpenAI) send message_end with empty content — the actual
        // message is only available in session.messages. Use getLastMessage() fallback.
        let message = sdkEvent.message;
        if ((!message || !message.content || (Array.isArray(message.content) && message.content.length === 0)) && getLastMessage) {
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
          toolName: sdkEvent.toolName ?? '',
          toolCallId: sdkEvent.toolCallId ?? '',
          args: sdkEvent.args,
        };

      case 'tool_execution_update':
        return {
          ...base,
          type: 'tool_execution_update',
          toolCallId: sdkEvent.toolCallId ?? '',
          content: typeof sdkEvent.partialResult === 'string' ? sdkEvent.partialResult : '',
        };

      case 'tool_execution_end':
        return {
          ...base,
          type: 'tool_execution_end',
          toolCallId: sdkEvent.toolCallId ?? '',
          result: sdkEvent.result,
        };

      case 'auto_compaction_start':
        return {
          ...base,
          type: 'auto_compaction_start',
          reason: (sdkEvent.reason ?? 'threshold') as 'threshold' | 'overflow',
        };

      case 'auto_compaction_end':
        return {
          ...base,
          type: 'auto_compaction_end',
          result: sdkEvent.result,
          aborted: sdkEvent.aborted ?? false,
          willRetry: sdkEvent.willRetry ?? false,
          ...(sdkEvent.errorMessage ? { errorMessage: sdkEvent.errorMessage } : {}),
        };

      case 'auto_retry_start':
        return {
          ...base,
          type: 'auto_retry_start',
          attempt: sdkEvent.attempt ?? 0,
          maxAttempts: sdkEvent.maxAttempts ?? 0,
          delayMs: sdkEvent.delayMs ?? 0,
          errorMessage: sdkEvent.errorMessage ?? '',
        };

      case 'auto_retry_end':
        return {
          ...base,
          type: 'auto_retry_end',
          success: sdkEvent.success ?? false,
          attempt: sdkEvent.attempt ?? 0,
          ...(sdkEvent.finalError ? { finalError: sdkEvent.finalError } : {}),
        };

      case 'extension_error':
        return {
          ...base,
          type: 'extension_error',
          error: sdkEvent.error ?? '',
          ...(sdkEvent.extensionName ? { extensionName: sdkEvent.extensionName } : {}),
        };

      default:
        // Unknown event type — pass through as agent_start (shouldn't happen)
        return { ...base, type: 'agent_start' };
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
