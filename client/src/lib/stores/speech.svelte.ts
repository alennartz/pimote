/** The message key currently being read, or null. */
// eslint-disable-next-line prefer-const
export let playingKey: string | null = null;

/** Monotonic generation counter — incremented on each speak()/stop() call.
 *  Callbacks from stale generations are ignored. */
let generation = 0;

/** Start reading text aloud. Stops any current playback first.
 *  Chunks text at paragraph boundaries and queues sequentially.
 *  Must be called from a user gesture handler (click/touch). */
export function speak(text: string, messageKey: string): void {
  // Always cancel previous playback
  speechSynthesis.cancel();
  generation++;
  playingKey = null;

  // Split into paragraph chunks, trim, discard empty
  const chunks = text
    .split('\n\n')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  if (chunks.length === 0) return;

  playingKey = messageKey;

  const currentGen = generation;
  const totalChunks = chunks.length;

  for (let i = 0; i < totalChunks; i++) {
    const utterance = new SpeechSynthesisUtterance(chunks[i]);

    utterance.onend = () => {
      // Ignore stale callbacks from replaced/cancelled utterances
      if (currentGen !== generation) return;
      // Only reset when the last chunk finishes
      if (i === totalChunks - 1) {
        playingKey = null;
      }
    };

    utterance.onerror = () => {
      if (currentGen !== generation) return;
      stop();
    };

    speechSynthesis.speak(utterance);
  }
}

/** Stop current playback and clear queued chunks. */
export function stop(): void {
  speechSynthesis.cancel();
  generation++;
  playingKey = null;
}
