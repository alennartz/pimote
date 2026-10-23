import type { AssistantRowUsage, PimoteAgentMessage, StreamingMessage } from '@pimote/shared';

/**
 * Summarize one assistant row from its current message snapshot and matching
 * nested tool-result usage in the transcript.
 */
export function summarizeAssistantRowUsage(_assistant: PimoteAgentMessage | StreamingMessage, _messages: readonly PimoteAgentMessage[]): AssistantRowUsage | null {
  throw new Error('not implemented');
}
