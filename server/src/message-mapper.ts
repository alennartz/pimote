import type { PimoteAgentMessage, PimoteMessageContent } from '@pimote/shared';

/**
 * Minimal structural type for SDK messages consumed by the mapper.
 * Uses an index signature so duck-typed property access works without
 * importing the full AgentMessage union from the SDK.
 */
export interface SdkMessage {
  role?: string;
  content?: unknown;
  customType?: string;
  display?: boolean;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/**
 * Convert raw pi SDK AgentMessage objects to PimoteAgentMessage format.
 * Used both for bulk message retrieval (get_messages) and for live
 * message_end events so the client always receives a consistent shape.
 */
export function mapAgentMessages(messages: SdkMessage[]): PimoteAgentMessage[] {
  return messages.map(mapAgentMessage);
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

  // Log empty content for debugging
  if (content.length === 0) {
    console.warn('[message-mapper] Empty content array for message:', { role, content: msg.content });
  }

  // Handle custom messages — preserve customType and display flag for the client
  if (role === 'custom') {
    return { role, content, customType: msg.customType, display: msg.display ?? true };
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
    };
  }

  return { role, content };
}
