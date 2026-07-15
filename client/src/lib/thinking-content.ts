/**
 * A reasoning block remains visible while its stream is open, because a later
 * delta may still add text. Once closed, whitespace-only blocks have no UI.
 */
export function shouldRenderThinkingBlock(text: string, streaming: boolean): boolean {
  return streaming || text.trim().length > 0;
}
