import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { PimoteSessionEvent } from '../../shared/dist/index.js';
import { mapAgentMessage, mapAgentMessageUsage, mapCustomEntry, type CustomEntryVisibility } from './message-mapper.js';

export interface TreeNavigationStartEvent {
  type: 'tree_navigation_start';
  targetId: string;
  summarizing: boolean;
}
export interface TreeNavigationEndEvent {
  type: 'tree_navigation_end';
}

export type IncomingSdkEvent = AgentSessionEvent | TreeNavigationStartEvent | TreeNavigationEndEvent;

interface BufferEntry {
  cursor: number;
  event: PimoteSessionEvent;
}

/**
 * Forward mapped events live and buffer non-streaming events for reconnect replay.
 * Streaming updates are live-only and are not stored in the replay buffer.
 */
export class EventBuffer {
  private readonly buffer: (BufferEntry | undefined)[];
  private head = 0;
  private tail = 0;
  private count = 0;
  private hasBufferedEvent = false;
  private _cursor: number;
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
   * Map and forward an SDK or tree-navigation event. Buffer non-streaming events.
   */
  onEvent(sdkEvent: IncomingSdkEvent, sessionId: string, sendLive: (event: PimoteSessionEvent) => void, getLastMessage?: () => AgentMessage | undefined): void {
    const cursor = sdkEvent.type === 'bash_execution_update' ? this._cursor : ++this._cursor;

    const pimoteEvent = this.mapEvent(sdkEvent, sessionId, cursor, getLastMessage);
    if (!pimoteEvent) return;
    sendLive(pimoteEvent);
    this.bufferIfReplayable(pimoteEvent);
  }

  /**
   * Replay buffered events from a given cursor position.
   * Returns null if fromCursor is too old (full resync needed).
   * Returns empty array if client is caught up.
   */
  replay(fromCursor: number): PimoteSessionEvent[] | null {
    if (fromCursor < this.baseCursor || fromCursor > this._cursor) {
      return null;
    }
    if (fromCursor === this._cursor) {
      return [];
    }

    if (this.count === 0) {
      return this.hasBufferedEvent ? null : [];
    }

    const oldestEntry = this.buffer[this.head];
    if (!oldestEntry) {
      return null;
    }

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

  private mapEvent(sdkEvent: IncomingSdkEvent, sessionId: string, cursor: number, getLastMessage?: () => AgentMessage | undefined): PimoteSessionEvent | null {
    const base = { sessionId, cursor, timestamp: new Date().toISOString() };

    switch (sdkEvent.type) {
      case 'agent_start':
        return { ...base, type: 'agent_start' };

      case 'agent_end':
        if (sdkEvent.willRetry) return { ...base, type: 'agent_end', willRetry: true };
        return { ...base, type: 'agent_end', ...(this.getMessageEntryIds ? { messageEntryIds: this.getMessageEntryIds() } : {}) };

      case 'turn_start':
        return { ...base, type: 'turn_start' };

      case 'turn_end':
        return { ...base, type: 'turn_end' };

      case 'message_start': {
        const usage = sdkEvent.message.role === 'assistant' ? mapAgentMessageUsage(sdkEvent.message) : undefined;
        return {
          ...base,
          type: 'message_start',
          role: sdkEvent.message.role,
          ...(usage ? { usage } : {}),
          ...(sdkEvent.message.role === 'user' && this.pendingPromptEcho !== undefined ? { clientMessageId: this.pendingPromptEcho } : {}),
        };
      }

      case 'message_update': {
        const ame = sdkEvent.assistantMessageEvent;
        const contentIndex = 'contentIndex' in ame ? ame.contentIndex : 0;

        let contentType: 'text' | 'thinking' | 'tool_call' = 'text';
        if (ame.type.startsWith('thinking_')) {
          contentType = 'thinking';
        } else if (ame.type.startsWith('toolcall_')) {
          contentType = 'tool_call';
        }

        let subtype: 'start' | 'delta' | 'end' = 'delta';
        if (ame.type.endsWith('_start')) {
          subtype = 'start';
        } else if (ame.type.endsWith('_end')) {
          subtype = 'end';
        }

        const delta = 'delta' in ame ? ame.delta : '';
        const usage = mapAgentMessageUsage(sdkEvent.message) ?? ('partial' in ame ? mapAgentMessageUsage(ame.partial) : undefined);

        const result: PimoteSessionEvent & { type: 'message_update' } = {
          ...base,
          type: 'message_update',
          contentIndex,
          subtype,
          content: {
            type: contentType,
            text: delta,
          },
          ...(usage ? { usage } : {}),
        };

        if (contentType === 'tool_call' && subtype === 'start' && 'partial' in ame) {
          const block = ame.partial.content[contentIndex];
          if (block && block.type === 'toolCall') {
            result.toolCallId = block.id;
            result.toolName = block.name;
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
        const _exhaustive: never = sdkEvent;
        void _exhaustive;
        return null;
      }
    }
  }

  private bufferIfReplayable(event: PimoteSessionEvent): void {
    switch (event.type) {
      case 'message_update':
      case 'tool_execution_update':
      case 'bash_execution_update':
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
      this.head = (this.head + 1) % this.capacity;
    }
  }
}
