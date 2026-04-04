import { markdownToSpeech } from '$lib/markdown-to-speech.js';

/** Reactive speech playback state. Uses an object with $state() so property
 *  mutations go through Svelte 5's reactive proxy — exported let bindings
 *  that are reassigned can't use $state() directly (state_invalid_export). */
export const speechState = $state({ playingKey: null as string | null });

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
  speechState.playingKey = null;

  // Split into paragraph chunks, trim, discard empty
  const chunks = text
    .split('\n\n')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  if (chunks.length === 0) return;

  speechState.playingKey = messageKey;

  const currentGen = generation;
  const totalChunks = chunks.length;

  for (let i = 0; i < totalChunks; i++) {
    const utterance = new SpeechSynthesisUtterance(chunks[i]);

    utterance.onend = () => {
      // Ignore stale callbacks from replaced/cancelled utterances
      if (currentGen !== generation) return;
      // Only reset when the last chunk finishes
      if (i === totalChunks - 1) {
        speechState.playingKey = null;
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
  speechState.playingKey = null;
}

/** Toggle TTS for a message — stop if already playing, otherwise convert and speak. */
export function toggleTts(messageKey: string, markdownText: string): void {
  if (speechState.playingKey === messageKey) {
    stop();
  } else {
    const speakable = markdownToSpeech(markdownText);
    if (speakable) {
      speak(speakable, messageKey);
    }
  }
}
