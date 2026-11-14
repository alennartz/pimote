/**
 * Presentation gate for transient activity chips (tree navigation).
 * Navigation without branch summarization finishes in milliseconds, so the
 * chip must not flash for it: show only after `delayMs` of continuous
 * activity, hide immediately.
 *
 * Call `update()` from a component effect that reads the activity source;
 * `stop()` cancels a pending show.
 */
export const ACTIVITY_INDICATOR_DELAY_MS = 250;

export function createDelayedIndicator(active: () => boolean, delayMs: number = ACTIVITY_INDICATOR_DELAY_MS) {
  let visible = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    get visible() {
      return visible;
    },

    update() {
      if (active()) {
        timer ??= setTimeout(() => {
          timer = undefined;
          visible = true;
        }, delayMs);
      } else {
        this.stop();
        visible = false;
      }
    },

    stop() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
