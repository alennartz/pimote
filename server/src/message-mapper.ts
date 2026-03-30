import type { PimoteAgentMessage, PimoteMessageContent } from '@pimote/shared';

/**
 * Convert raw pi SDK AgentMessage objects to PimoteAgentMessage format.
 * Used both for bulk message retrieval (get_messages) and for live
 * message_end events so the client always receives a consistent shape.
 */
export function mapAgentMessages(messages: any[]): PimoteAgentMessage[] {
  return messages.map(mapAgentMessage);
}

export function mapAgentMessage(msg: any): PimoteAgentMessage {
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
    return { role, content, customType: (msg as any).customType };
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
