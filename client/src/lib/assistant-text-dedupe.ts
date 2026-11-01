import type { PimoteMessageContent } from '@pimote/shared';

/**
 * Collapse consecutive duplicate text blocks into one. Some models (notably
 * GPT Luna on the Responses API) occasionally emit the answer twice — an
 * extra message item repeating the final answer — and every message item
 * maps to its own text block, so the string renders twice.
 *
 * A text block is dropped when its trimmed text equals the trimmed text of
 * the last kept text block. Interleaved non-text blocks (thinking, tool
 * calls) do not reset the match; a different text block does. Whitespace-only
 * blocks pass through untouched.
 */
export function collapseDuplicateTextBlocks(content: PimoteMessageContent[]): PimoteMessageContent[] {
  let lastKeptText: string | undefined;
  const out: PimoteMessageContent[] = [];
  for (const block of content) {
    if (block.type !== 'text') {
      out.push(block);
      continue;
    }
    const text = (block.text ?? '').trim();
    if (text.length > 0 && text === lastKeptText) continue;
    if (text.length > 0) lastKeptText = text;
    out.push(block);
  }
  return out;
}
