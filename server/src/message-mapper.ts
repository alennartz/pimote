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

/**
 * Decides whether a persisted custom entry (pi.appendEntry) is surfaced to
 * clients. Pimote mirrors the TUI's visibility rule: an entry renders only
 * when its extension registered an entry renderer for its customType —
 * entries without one (e.g. session-resume's idle markers) are state, not
 * transcript content, and stay invisible in both UIs.
 */
export type CustomEntryVisibility = (customType: string) => boolean;

/**
 * Build the TUI-parity visibility predicate for a session. Reads
 * `session.extensionRunner` at call time so extension reloads (which swap the
 * runner) are picked up without rebuilding the predicate.
 */
export function rendererRegisteredVisibility(session: { extensionRunner?: { getEntryRenderer?: (customType: string) => unknown } }): CustomEntryVisibility {
  return (customType) => !!session.extensionRunner?.getEntryRenderer?.(customType);
}

/**
 * Derive display text for a custom entry's data payload. Extensions appendEntry()
 * arbitrary JSON; pimote has no web renderer for it, so render generically:
 * a string payload or a string text/markdown/content field becomes the body,
 * anything else falls back to pretty-printed JSON.
 */
export function customEntryDisplayText(data: unknown): string | undefined {
  if (typeof data === 'string') return data || undefined;
  if (data && typeof data === 'object') {
    for (const key of ['text', 'markdown', 'content'] as const) {
      const value = (data as Record<string, unknown>)[key];
      if (typeof value === 'string' && value) return value;
    }
    const json = JSON.stringify(data, null, 2);
    // An empty object has nothing to show — render a label-only card.
    return json === '{}' ? undefined : json;
  }
  return undefined;
}

/** Map a persisted custom entry to a display-only wire message. */
export function mapCustomEntry(entry: Extract<SessionEntry, { type: 'custom' }>): PimoteAgentMessage {
  const text = customEntryDisplayText(entry.data);
  return {
    role: 'custom',
    content: text ? [{ type: 'text', text }] : [],
    customType: entry.customType,
    display: true,
    fromEntry: true,
    entryId: entry.id,
  };
}

/** Convert raw pi SDK AgentMessage objects to PimoteAgentMessage format. */
/**
 * Map a message array, omitting the session's leading system message (the full
 * base prompt — pure noise in a chat UI). Later system messages are pi 0.87+
 * prompt-section deltas and map to compact wire entries.
 */
export function mapAgentMessages(messages: AgentMessage[]): PimoteAgentMessage[] {
  let seenSystem = false;
  return messages.flatMap((message) => {
    if (message.role === 'system' && !seenSystem) {
      seenSystem = true;
      return [];
    }
    return [mapAgentMessage(message)];
  });
}

/**
 * Map the SDK's compaction-aware context entries to durable wire messages.
 *
 * `sessionEntryToContextMessages` owns entry-to-message semantics; this
 * mapper only adapts its output and keeps each message paired with its source
 * entry ID. Entries that produce no context message are omitted — except
 * custom entries passing `customEntryVisible`, which are surfaced as
 * display-only messages (never sent to the LLM; see mapCustomEntry).
 */
export function mapContextEntries(entries: readonly SessionEntry[], customEntryVisible?: CustomEntryVisibility): PimoteAgentMessage[] {
  let seenSystem = false;
  return entries.flatMap((entry) => {
    if (entry.type === 'custom' && customEntryVisible?.(entry.customType)) return [mapCustomEntry(entry)];
    // Skip the leading system message (the base prompt) — same rule as
    // mapAgentMessages; extractMessageEntryIds mirrors it to keep the ID zip aligned.
    const messages = sessionEntryToContextMessages(entry).filter((message) => {
      if (message.role !== 'system' || seenSystem) return true;
      seenSystem = true;
      return false;
    });
    return messages.map((message) => ({ ...mapAgentMessage(message), entryId: entry.id }));
  });
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
export function extractMessageEntryIds(branch: SessionEntry[], customEntryVisible?: CustomEntryVisibility): string[] {
  // Find the last compaction entry on the path
  let compaction: Extract<SessionEntry, { type: 'compaction' }> | null = null;
  for (const entry of branch) {
    if (entry.type === 'compaction') compaction = entry;
  }

  const ids: string[] = [];
  // Mirrors mapContextEntries: the leading system message entry contributes no message.
  let seenSystemEntry = false;

  const appendId = (entry: SessionEntry) => {
    if (entry.type === 'message') {
      if (entry.message?.role === 'system' && !seenSystemEntry) {
        seenSystemEntry = true;
        return;
      }
      ids.push(entry.id);
    } else if (entry.type === 'custom_message') {
      ids.push(entry.id);
    } else if (entry.type === 'branch_summary' && entry.summary) {
      ids.push(entry.id);
    }
    // Custom entries contribute an id ONLY when mapContextEntries surfaces
    // them — pass the same predicate to both or the id/message zip desyncs.
    else if (entry.type === 'custom' && customEntryVisible?.(entry.customType)) {
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

    case 'bashExecution': {
      // Keep the display text for clients that only know the generic message
      // shape, while carrying Pi's native result metadata for status-aware
      // rendering after a context resync.
      return {
        role: 'bashExecution',
        content: [{ type: 'text', text: `$ ${msg.command}\n${msg.output}` }],
        command: msg.command,
        output: msg.output,
        cancelled: msg.cancelled,
        truncated: msg.truncated,
        ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
        ...(msg.fullOutputPath !== undefined ? { fullOutputPath: msg.fullOutputPath } : {}),
        ...(msg.excludeFromContext !== undefined ? { excludeFromContext: msg.excludeFromContext } : {}),
      };
    }

    case 'branchSummary':
    case 'compactionSummary':
      return { role: msg.role, content: msg.summary ? [{ type: 'text', text: msg.summary }] : [] };

    case 'system':
      // Harness→model prompt bookkeeping (pi 0.87+): named prompt-section deltas.
      // The leading base-prompt message is omitted by the list mappers above; live
      // single-message paths (event buffer) surface later deltas as compact entries.
      return {
        role: 'system',
        content: mapContentBlocks(msg.content),
        ...(msg.sections && Object.keys(msg.sections).length > 0 ? { sections: msg.sections } : {}),
      };

    default: {
      // Exhaustiveness guard: a new AgentMessage role fails to compile here.
      const _exhaustive: never = msg;
      void _exhaustive;
      return { role: 'unknown', content: [] };
    }
  }
}
