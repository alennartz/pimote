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
  toolCallId?: string;
  toolName?: string;
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
  }

  // Handle custom messages — preserve customType for the client
  if (role === 'custom') {
    return { role, content, customType: msg.customType };
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
        },
      ],
    };
  }

  return { role, content };
}
