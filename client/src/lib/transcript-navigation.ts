export interface UserMessagePosition {
  entryId: string;
  role: string;
  bottom: number;
}
/** Last user message completely above the viewport threshold, or null. */
export function previousUserAbove(messages: readonly UserMessagePosition[], viewportTop: number, threshold: number = 0): string | null {
  const cutoff = viewportTop + threshold;
  let previousEntryId: string | null = null;

  for (const message of messages) {
    if (message.role === 'user' && message.bottom < cutoff) {
      previousEntryId = message.entryId;
    }
  }

  return previousEntryId;
}
