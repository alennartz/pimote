/**
 * A reasoning block remains visible while its stream is open, because a later
 * delta may still add text. Once closed, whitespace-only blocks have no UI.
 */
const whitespace = /\s/;

export function shouldRenderThinkingBlock(text: string, streaming: boolean): boolean {
  return streaming || text.trim().length > 0;
}

/** Return a bounded preview without splitting or scanning the full stream. */
export function previewThinkingText(text: string, wordLimit = 8): string {
  const words: string[] = [];
  let index = 0;

  while (index < text.length && words.length < wordLimit) {
    while (index < text.length && whitespace.test(text[index])) index++;
    if (index >= text.length) break;

    const start = index;
    while (index < text.length && !whitespace.test(text[index])) index++;
    words.push(text.slice(start, index));
  }

  return words.join(' ');
}

/** Count appended text without rescanning the stream's existing prefix. */
export function createThinkingWordCounter(): (text: string) => number {
  let processedLength = 0;
  let count = 0;
  let inWord = false;

  return (text) => {
    if (text.length < processedLength) {
      processedLength = 0;
      count = 0;
      inWord = false;
    }

    for (let index = processedLength; index < text.length; index++) {
      if (whitespace.test(text[index])) {
        inWord = false;
      } else if (!inWord) {
        count++;
        inWord = true;
      }
    }

    processedLength = text.length;
    return count;
  };
}

export function countThinkingWords(text: string): number {
  return createThinkingWordCounter()(text);
}
