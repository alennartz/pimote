import type { AssistantRowUsage, PimoteAgentMessage, PimoteUsage, StreamingMessage } from '@pimote/shared';

/** One usage-bearing tool-result message in a transcript snapshot. */
export interface ToolResultUsageIndexEntry {
  messageIndex: number;
  usage: PimoteUsage;
}

/**
 * The tool-result usage index for one transcript snapshot. Each tool-call ID
 * points to every matching result message, including repeated results.
 */
export type ToolResultUsageIndex = ReadonlyMap<string, readonly ToolResultUsageIndexEntry[]>;

/**
 * Index tool-result usage once for a transcript snapshot. A result message can
 * contain multiple tool-result blocks, but contributes once per message.
 */
export function indexToolResultUsage(messages: readonly PimoteAgentMessage[]): ToolResultUsageIndex {
  const index = new Map<string, ToolResultUsageIndexEntry[]>();
  messages.forEach((message, messageIndex) => {
    if (message.role !== 'toolResult' || !message.usage) return;
    const toolCallIds = new Set(message.content.filter((block) => block.type === 'tool_result' && typeof block.toolCallId === 'string').map((block) => block.toolCallId as string));
    for (const toolCallId of toolCallIds) {
      const entries = index.get(toolCallId);
      const entry = { messageIndex, usage: message.usage };
      if (entries) entries.push(entry);
      else index.set(toolCallId, [entry]);
    }
  });
  return index;
}

/**
 * Summarize one assistant row from its current message snapshot and matching
 * nested tool-result usage in the transcript.
 */
export function summarizeAssistantRowUsage(
  assistant: PimoteAgentMessage | StreamingMessage,
  messages: readonly PimoteAgentMessage[],
  toolResultUsageIndex: ToolResultUsageIndex = indexToolResultUsage(messages),
): AssistantRowUsage | null {
  if (assistant.role !== 'assistant') return null;

  const toolCallIds = new Set(assistant.content.filter((block) => block.type === 'tool_call' && typeof block.toolCallId === 'string').map((block) => block.toolCallId as string));
  const contributors = assistant.usage ? [assistant.usage] : [];

  // Usage belongs to the tool-result message, not to each content block. The
  // index keeps repeated results and avoids rescanning the transcript per row.
  const includedResults = new Set<number>();
  for (const toolCallId of toolCallIds) {
    for (const entry of toolResultUsageIndex.get(toolCallId) ?? []) {
      if (includedResults.has(entry.messageIndex)) continue;
      includedResults.add(entry.messageIndex);
      contributors.push(entry.usage);
    }
  }

  if (contributors.length === 0) return null;

  const tokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  const cost = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let totalCostUsd = 0;

  for (const usage of contributors) {
    tokens.input += usage.input;
    tokens.output += usage.output;
    tokens.cacheRead += usage.cacheRead;
    tokens.cacheWrite += usage.cacheWrite;
    tokens.total += usage.totalTokens;
    cost.input += usage.cost.input;
    cost.output += usage.cost.output;
    cost.cacheRead += usage.cost.cacheRead;
    cost.cacheWrite += usage.cost.cacheWrite;
    totalCostUsd += usage.cost.total;
  }

  return {
    totalCostUsd,
    breakdown: { tokens, cost },
  };
}
