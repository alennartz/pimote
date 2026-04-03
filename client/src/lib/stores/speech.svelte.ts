/** Start reading text aloud. Stops any current playback first.
 *  Chunks text at paragraph boundaries and queues sequentially.
 *  Must be called from a user gesture handler (click/touch). */
export function speak(_text: string, _messageKey: string): void {
  throw new Error('not implemented');
}

/** Stop current playback and clear queued chunks. */
export function stop(): void {
  throw new Error('not implemented');
}

/** The message key currently being read, or null. Reactive ($state). */
// eslint-disable-next-line prefer-const
export let playingKey: string | null = $state(null);
