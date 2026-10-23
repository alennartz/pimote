import type { AssistantRowUsage, PimoteAgentMessage, StreamingMessage } from '@pimote/shared';

/**
 * Summarize one assistant row from its current message snapshot and matching
 * nested tool-result usage in the transcript.
 */
export function summarizeAssistantRowUsage(assistant: PimoteAgentMessage | StreamingMessage, messages: readonly PimoteAgentMessage[]): AssistantRowUsage | null {
  if (assistant.role !== 'assistant') return null;

  const toolCallIds = new Set(assistant.content.filter((block) => block.type === 'tool_call' && typeof block.toolCallId === 'string').map((block) => block.toolCallId as string));
  const contributors = assistant.usage ? [assistant.usage] : [];

  // Usage belongs to the tool-result message, not to each content block. A
  // result can contain more than one block, so add each matching message once.
  for (const message of messages) {
    if (message.role !== 'toolResult' || !message.usage) continue;
    const matchesToolCall = message.content.some((block) => block.type === 'tool_result' && typeof block.toolCallId === 'string' && toolCallIds.has(block.toolCallId));
    if (matchesToolCall) contributors.push(message.usage);
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
