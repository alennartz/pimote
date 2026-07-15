import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { sessionEntryToContextMessages, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { PimoteAgentMessage, PimoteMessageContent } from '../../shared/dist/index.js';

/**
 * The element type of any array-shaped AgentMessage content, derived from the
 * real union rather than hand-mirrored. Resolves to the pi-ai
 * TextContent | ThinkingContent | ToolCall | ImageContent union.
 */
type AgentContentItem = Extract<Extract<AgentMessage, { role: 'assistant' | 'user' | 'toolResult' | 'custom' }>['content'], readonly unknown[]>[number];

/** Session entries whose relative order must match buildSessionContext's message list. */
export type SdkSessionEntry = SessionEntry;

/** Convert raw pi SDK AgentMessage objects to PimoteAgentMessage format. */
export function mapAgentMessages(messages: AgentMessage[]): PimoteAgentMessage[] {
  return messages.map(mapAgentMessage);
}

/**
 * Map the SDK's compaction-aware context entries to durable wire messages.
 *
 * `sessionEntryToContextMessages` owns entry-to-message semantics; this
 * mapper only adapts its output and keeps each message paired with its source
 * entry ID. Entries that produce no context message are omitted.
 */
export function mapContextEntries(entries: readonly SessionEntry[]): PimoteAgentMessage[] {
  return entries.flatMap((entry) => sessionEntryToContextMessages(entry).map((message) => ({ ...mapAgentMessage(message), entryId: entry.id })));
}

/**
 * Extract entry IDs from branch entries in the same order that
 * buildSessionContext produces messages. This mirrors the SDK's
 * compaction/branch-summary ordering so IDs can be zipped 1:1 with
 * the mapped PimoteAgentMessage array.
 *
 * (buildSessionContext() itself returns only messages, not their entry IDs,
 * so this ordering must be reproduced here — see the SDK's session-manager.)
 */
export function extractMessageEntryIds(branch: SessionEntry[]): string[] {
  // Find the last compaction entry on the path
  let compaction: Extract<SessionEntry, { type: 'compaction' }> | null = null;
  for (const entry of branch) {
    if (entry.type === 'compaction') compaction = entry;
  }

  const ids: string[] = [];

  const appendId = (entry: SessionEntry) => {
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

/** Map an AgentMessage content array (or bare string) to wire content blocks. */
function mapContentBlocks(content: string | readonly AgentContentItem[]): PimoteMessageContent[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  const out: PimoteMessageContent[] = [];
  for (const item of content) {
    switch (item.type) {
      case 'text':
        out.push({ type: 'text', text: item.text });
        break;
      case 'thinking':
        out.push({ type: 'thinking', text: item.thinking });
        break;
      case 'toolCall':
        out.push({ type: 'tool_call', toolCallId: item.id, toolName: item.name, args: item.arguments });
        break;
      case 'image':
        // Images map to a text placeholder (the client renders no inline images here).
        out.push({ type: 'text', text: '[image]' });
        break;
    }
  }
  return out;
}

export function mapAgentMessage(msg: AgentMessage): PimoteAgentMessage {
  switch (msg.role) {
    case 'toolResult': {
      let text: string | undefined;
      for (const c of msg.content) {
        if (c.type === 'text') {
          text = c.text;
          break;
        }
      }
      return {
        role: 'toolResult',
        content: [
          {
            type: 'tool_result',
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            result: text,
            isError: msg.isError || undefined,
          },
        ],
      };
    }

    case 'custom':
      return { role: 'custom', content: mapContentBlocks(msg.content), customType: msg.customType, display: msg.display };

    case 'assistant': {
      const content = mapContentBlocks(msg.content);
      // Aborted assistant turns are a real signal in voice mode (every barge-in
      // produces one via pi-agent-core's handleRunFailure) and shouldn't be
      // confused with malformed messages. Log the empty-content warning only
      // when it's NOT an expected aborted turn.
      const aborted = msg.stopReason === 'aborted';
      if (content.length === 0 && !aborted) {
        console.warn('[message-mapper] Empty content array for assistant message');
      }
      return {
        role: 'assistant',
        content,
        ...(aborted ? { aborted: true } : {}),
        ...(typeof msg.errorMessage === 'string' ? { errorMessage: msg.errorMessage } : {}),
      };
    }

    case 'user':
      return { role: 'user', content: mapContentBlocks(msg.content) };

    case 'bashExecution':
      return { role: 'bashExecution', content: [{ type: 'text', text: `$ ${msg.command}\n${msg.output}` }] };

    case 'branchSummary':
    case 'compactionSummary':
      return { role: msg.role, content: msg.summary ? [{ type: 'text', text: msg.summary }] : [] };

    default: {
      // Exhaustiveness guard: a new AgentMessage role fails to compile here.
      const _exhaustive: never = msg;
      void _exhaustive;
      return { role: 'unknown', content: [] };
    }
  }
}
