import type { PimoteAgentMessage, PimoteMessageContent } from '../../shared/dist/index.js';

/**
 * Minimal structural type for SDK messages consumed by the mapper.
 * Uses an index signature so duck-typed property access works without
 * importing the full AgentMessage union from the SDK.
 */
export interface SdkMessage {
  id?: string;
  role?: string;
  content?: unknown;
  customType?: string;
  display?: boolean;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** Pi-agent-core sets this to 'aborted' for turns interrupted by session.abort(). */
  stopReason?: string;
}

/**
 * Convert raw pi SDK AgentMessage objects to PimoteAgentMessage format.
 * Used both for bulk message retrieval (get_messages) and for live
 * message_end events so the client always receives a consistent shape.
 */
export function mapAgentMessages(messages: SdkMessage[]): PimoteAgentMessage[] {
  return messages.map(mapAgentMessage);
}

/**
 * Structural type for session entries consumed by entry-ID extraction.
 * Only the fields needed for matching buildSessionContext's message ordering.
 */
export interface SdkSessionEntry {
  id: string;
  type: string;
  parentId: string | null;
  summary?: string;
  firstKeptEntryId?: string;
}

/**
 * Extract entry IDs from branch entries in the same order that
 * buildSessionContext produces messages.  This mirrors the SDK's
 * compaction/branch-summary logic so IDs can be zipped 1:1 with
 * the mapped PimoteAgentMessage array.
 */
export function extractMessageEntryIds(branch: SdkSessionEntry[]): string[] {
  // Find the last compaction entry on the path
  let compaction: SdkSessionEntry | null = null;
  for (const entry of branch) {
    if (entry.type === 'compaction') compaction = entry;
  }

  const ids: string[] = [];

  const appendId = (entry: SdkSessionEntry) => {
    if (entry.type === 'message') {
      ids.push(entry.id);
    } else if (entry.type === 'custom_message') {
      ids.push(entry.id);
    } else if (entry.type === 'branch_summary' && entry.summary) {
      ids.push(entry.id);
    }
  };

  if (compaction) {
    // Compaction summary message maps to the compaction entry
    ids.push(compaction.id);

    const compactionIdx = branch.findIndex((e) => e.type === 'compaction' && e.id === compaction!.id);

    // Kept messages before the compaction entry
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      if (branch[i].id === compaction.firstKeptEntryId) foundFirstKept = true;
      if (foundFirstKept) appendId(branch[i]);
    }

    // Messages after the compaction entry
    for (let i = compactionIdx + 1; i < branch.length; i++) {
      appendId(branch[i]);
    }
  } else {
    for (const entry of branch) {
      appendId(entry);
    }
  }

  return ids;
}

/**
 * True when the message is pi-agent-core's synthetic aborted placeholder
 * (pushed into agent.state.messages on session.abort() but never persisted
 * via message_end). Identifying these lets entryId alignment skip over them.
 */
export function isAbortedPlaceholderMessage(msg: PimoteAgentMessage): boolean {
  if (msg.role !== 'assistant') return false;
  if (msg.aborted !== true) return false;
  return msg.content.every((c) => c.type === 'text' && !c.text);
}

/**
 * Apply entry IDs from the session manager onto mapped messages.
 *
 * Subtle alignment: `messages` comes from `agent.state.messages`, which
 * includes pi-agent-core's synthetic aborted placeholders (abort pushes an
 * empty assistant into state but never persists an entry for it).
 * `entryIds` comes from persisted session entries, which do NOT include
 * those placeholders. We walk the messages and skip aborted placeholders
 * so the persisted IDs land on the correct real messages.
 */
export function applyEntryIds(messages: PimoteAgentMessage[], entryIds: string[]): void {
  let idIdx = 0;
  for (let i = 0; i < messages.length; i++) {
    if (isAbortedPlaceholderMessage(messages[i])) continue;
    if (idIdx >= entryIds.length) break;
    messages[i].entryId = entryIds[idIdx++];
  }
}

export function mapAgentMessage(msg: SdkMessage): PimoteAgentMessage {
  const role = msg.role ?? 'unknown';
  const content: PimoteMessageContent[] = [];

  if (typeof msg.content === 'string') {
    content.push({ type: 'text', text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const item of msg.content) {
      switch (item.type) {
        case 'text':
          content.push({ type: 'text', text: item.text ?? '' });
          break;
        case 'thinking':
          content.push({ type: 'thinking', text: item.thinking ?? '' });
          break;
        case 'toolCall':
          content.push({
            type: 'tool_call',
            toolCallId: item.id,
            toolName: item.name,
            args: item.arguments,
          });
          break;
        case 'image':
          // Images in user messages — map as text placeholder
          content.push({ type: 'text', text: '[image]' });
          break;
        default:
          // Unknown content type — pass through as text
          content.push({ type: 'text', text: item.text ?? JSON.stringify(item) });
          break;
      }
    }
  } else if (msg.content !== undefined && msg.content !== null) {
    // Unexpected content type — log and convert to text
    console.warn('[message-mapper] Unexpected content type:', typeof msg.content, 'role:', role);
    console.warn('[message-mapper] Content value:', msg.content);
    content.push({ type: 'text', text: `[Unexpected content type: ${typeof msg.content}]` });
  }

  // Aborted assistant turns are a real signal in voice mode (every barge-in
  // produces one via pi-agent-core's handleRunFailure) and shouldn't be
  // confused with malformed messages. Log the empty-content warning only
  // when it's NOT an expected aborted turn.
  const aborted = role === 'assistant' && msg.stopReason === 'aborted';
  if (content.length === 0 && !aborted) {
    console.warn('[message-mapper] Empty content array for message:', { role, content: msg.content });
  }

  // Handle custom messages — preserve customType and display flag for the client
  if (role === 'custom') {
    return { role, content, entryId: msg.id, customType: msg.customType, display: msg.display ?? true };
  }

  // Handle tool result messages
  if (role === 'toolResult') {
    const resultContent: PimoteMessageContent[] = [];
    if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === 'text') {
          resultContent.push({ type: 'text', text: item.text ?? '' });
        }
      }
    }
    return {
      role,
      content: [
        {
          type: 'tool_result' as const,
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          result: resultContent.length > 0 ? resultContent[0].text : undefined,
          isError: msg.isError || undefined,
        },
      ],
      entryId: msg.id,
    };
  }

  // Note: msg.id is typically undefined for standard SDK messages (UserMessage,
  // AssistantMessage, ToolResultMessage).  Entry IDs are applied separately via
  // applyEntryIds() using the session manager's branch entries.
  return {
    role,
    content,
    ...(msg.id ? { entryId: msg.id } : {}),
    ...(aborted ? { aborted: true } : {}),
  };
}
