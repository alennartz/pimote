export interface UserMessagePosition {
  entryId: string;
  role: string;
  bottom: number;
}
/** Last user message completely above the viewport threshold, or null. */
export function previousUserAbove(_messages: readonly UserMessagePosition[], _viewportTop: number, _threshold: number = 0): string | null {
  throw new Error('not implemented');
}
