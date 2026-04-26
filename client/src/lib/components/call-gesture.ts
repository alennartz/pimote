// Pure gesture recognizer for the calling-mode bottom region.
//
// The full-screen calling UI gives the bottom band three gestures:
//
//   - Tap         → toggle mute
//   - Swipe up    → hang up
//   - Swipe down  → abort agent
//
// `recognizeCallGesture` takes the start/end pointer events (as plain
// `{x, y, t}` samples) and returns the recognised gesture (or `null` for
// "no action" — too small / ambiguous / multi-touch cancel).

export interface PointerSample {
  /** Pointer X in pixels (any consistent coordinate space — screen / page / client). */
  x: number;
  /** Pointer Y in pixels. */
  y: number;
  /** Monotonic-ish timestamp in ms (e.g. `event.timeStamp`). */
  t: number;
}

export type CallGesture = 'tap' | 'swipe-up' | 'swipe-down';

export interface CallGestureThresholds {
  /** Maximum |Δx|+|Δy| (px) for a movement to count as a tap. Default: 10. */
  tapMaxMovementPx?: number;
  /** Maximum duration (ms) for a tap. Default: 300. */
  tapMaxDurationMs?: number;
  /** Minimum |Δy| (px) for a swipe. Default: 80. */
  swipeMinDeltaPx?: number;
}

/**
 * Recognise a gesture from a pointer-down → pointer-up pair.
 *
 * - Returns `'tap'` when the movement is tiny and fast.
 * - Returns `'swipe-up'` when Δy ≤ -threshold (finger moved up the screen).
 * - Returns `'swipe-down'` when Δy ≥ +threshold.
 * - Returns `null` when the gesture is ambiguous (e.g. a slow drift, or a
 *   movement that falls between the tap and swipe thresholds).
 *
 * Multi-touch cancellation is handled by the caller (release pointer
 * capture and skip calling this function).
 */
export function recognizeCallGesture(start: PointerSample, end: PointerSample, thresholds: CallGestureThresholds = {}): CallGesture | null {
  const tapMaxMovementPx = thresholds.tapMaxMovementPx ?? 10;
  const tapMaxDurationMs = thresholds.tapMaxDurationMs ?? 300;
  const swipeMinDeltaPx = thresholds.swipeMinDeltaPx ?? 80;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dt = end.t - start.t;
  const movement = Math.abs(dx) + Math.abs(dy);

  if (movement <= tapMaxMovementPx && dt <= tapMaxDurationMs) return 'tap';
  if (dy <= -swipeMinDeltaPx) return 'swipe-up';
  if (dy >= swipeMinDeltaPx) return 'swipe-down';
  return null;
}
