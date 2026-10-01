// Pure gesture math for horizontal swipe-to-action cards (mobile).
//
// A card can be dragged sideways to reveal one action behind each edge:
// dragging left reveals the trailing action (Close), dragging right reveals
// the leading action (Archive). A drag ends in one of three ways:
//
//   - fire     → the action triggers immediately (drag far enough, or flick
//                fast enough while past the reveal width)
//   - open     → the card snaps open at the reveal width and the action is
//                fired by tapping its tray button
//   - snap-shut→ the drag was too small; the card returns to rest
//
// Vertical movement is never ours: the card surface uses `touch-action: pan-y`
// so the browser owns vertical scrolling, and `swipeAxis` tells the component
// to stand down when the finger leans vertical before the axis lock engages.
//
// Haptics are edge-triggered: `swipeTickLevel` walks a per-gesture level and
// ticks exactly once per threshold crossing, never while dwelling near one.
//
// Follows the same recognizer-as-pure-function pattern as call-gesture.ts.

export interface SwipeSample {
  /** Pointer X in pixels (any consistent coordinate space — screen / page / client). */
  x: number;
  /** Pointer Y in pixels. */
  y: number;
  /** Monotonic-ish timestamp in ms (e.g. `event.timeStamp`). */
  t: number;
}

export interface SwipeThresholds {
  /** Distance (px) before the gesture commits to a horizontal or vertical axis. Default: 6. */
  axisLockPx: number;
  /** Drag distance (px) beyond which the card's click is suppressed. Default: 6. */
  tapSuppressPx: number;
  /** Snap-open distance (px); one action tray wide. Default: 80. */
  revealWidthPx: number;
  /** Minimum |dx| (px) for the card to snap open on release. Default: 40. */
  openThresholdPx: number;
  /** |dx| (px, raw finger distance) that fires the action on release. Default: 104. */
  fireThresholdPx: number;
  /** Flick speed (px/ms) that fires the action while past the reveal width. Default: 0.45. */
  fireVelocityPxMs: number;
  /** Span (ms) of trailing samples used to measure the release velocity. Default: 100. */
  velocityWindowMs: number;
  /** Dead band (px) below a haptic threshold before it may re-tick on the way back up. Default: 12. */
  tickHysteresisPx: number;
  /** Rubber-banding starts at this multiple of the reveal width. Default: 1.5. */
  rubberStartFactor: number;
  /** How much of the drag beyond the rubber-band start still moves the card. Default: 0.3. */
  rubberResistance: number;
  /** Hard stop for the raw drag at this multiple of the reveal width. Default: 2. */
  rubberMaxFactor: number;
}

export const SWIPE_DEFAULTS: SwipeThresholds = {
  axisLockPx: 6,
  tapSuppressPx: 6,
  revealWidthPx: 80,
  openThresholdPx: 40,
  fireThresholdPx: 104,
  fireVelocityPxMs: 0.45,
  velocityWindowMs: 100,
  tickHysteresisPx: 12,
  rubberStartFactor: 1.5,
  rubberResistance: 0.3,
  rubberMaxFactor: 2,
};

/** Which edge's action a swipe direction targets. */
export type SwipeSide = 'left' | 'right';

export type SwipeRelease = { kind: 'fire'; side: SwipeSide } | { kind: 'open'; side: SwipeSide } | { kind: 'snap-shut' };

/**
 * Decide whether a drag is horizontal, vertical, or still undecided.
 * A tie leans horizontal (dx ≥ dy) so straight sideways drags commit cleanly.
 */
export function swipeAxis(start: SwipeSample, current: SwipeSample, thresholds: SwipeThresholds = SWIPE_DEFAULTS): 'horizontal' | 'vertical' | 'undecided' {
  const dx = Math.abs(current.x - start.x);
  const dy = Math.abs(current.y - start.y);
  if (dx < thresholds.axisLockPx && dy < thresholds.axisLockPx) return 'undecided';
  return dx >= dy ? 'horizontal' : 'vertical';
}

/**
 * Translate a raw horizontal drag offset into a rendered offset, applying
 * rubber-band resistance past the rubber-band start and clamping at the
 * rubber-band max. Negative = dragged left, positive = right.
 */
export function swipeTranslate(rawDx: number, thresholds: SwipeThresholds = SWIPE_DEFAULTS): number {
  const rubberStart = thresholds.revealWidthPx * thresholds.rubberStartFactor;
  const raw = Math.min(Math.abs(rawDx), thresholds.revealWidthPx * thresholds.rubberMaxFactor);
  if (raw <= rubberStart) return rawDx < 0 ? -raw : raw;
  const eased = rubberStart + (raw - rubberStart) * thresholds.rubberResistance;
  return rawDx < 0 ? -eased : eased;
}

/**
 * True once the drag has travelled far enough that a following click should
 * be suppressed (the finger meant to drag, not tap).
 */
export function swipeMoved(start: SwipeSample, current: SwipeSample, thresholds: SwipeThresholds = SWIPE_DEFAULTS): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > thresholds.tapSuppressPx;
}

/**
 * Resolve a release into fire / open / snap-shut from the raw drag offset
 * (px, relative to the card's rest position) and the release velocity (px/ms).
 *
 * Fires when the raw offset passes the fire threshold, or when it is past the
 * reveal width and the flick is fast enough. Otherwise opens when past the
 * open threshold, else snaps shut.
 */
export function swipeRelease(rawDx: number, velocityPxMs: number, thresholds: SwipeThresholds = SWIPE_DEFAULTS): SwipeRelease {
  const mag = Math.abs(rawDx);
  const side: SwipeSide = rawDx < 0 ? 'left' : 'right';
  if (mag >= thresholds.fireThresholdPx) return { kind: 'fire', side };
  if (mag >= thresholds.revealWidthPx && Math.abs(velocityPxMs) >= thresholds.fireVelocityPxMs) return { kind: 'fire', side };
  if (mag >= thresholds.openThresholdPx) return { kind: 'open', side };
  return { kind: 'snap-shut' };
}

/** Per-gesture haptic state: 0 = below the reveal, 1 = tray revealed, 2 = armed to fire. */
export type SwipeTickLevel = 0 | 1 | 2;

/** Edge-triggered haptic step the gesture just crossed, if any. */
export type SwipeTick = 'reveal' | 'armed' | null;

/**
 * Advance the per-gesture haptic level from the raw drag magnitude.
 *
 * Ascending crossings tick exactly once each: `'reveal'` when the tray is
 * first fully revealed, `'armed'` when the fire threshold is reached (a jump
 * from 0 straight past the fire threshold ticks `'armed'` only). Descending
 * crossings are silent and gated by hysteresis, so jitter at — or dwelling
 * near — a threshold never re-ticks. Scrubbing back below a threshold and out
 * again ticks once per outward crossing.
 */
export function swipeTickLevel(level: SwipeTickLevel, mag: number, thresholds: SwipeThresholds = SWIPE_DEFAULTS): { level: SwipeTickLevel; tick: SwipeTick } {
  if (level >= 2 && mag < thresholds.fireThresholdPx - thresholds.tickHysteresisPx) level = 1;
  if (level >= 1 && mag < thresholds.revealWidthPx - thresholds.tickHysteresisPx) level = 0;
  if (level === 0 && mag >= thresholds.fireThresholdPx) return { level: 2, tick: 'armed' };
  if (level === 0 && mag >= thresholds.revealWidthPx) return { level: 1, tick: 'reveal' };
  if (level === 1 && mag >= thresholds.fireThresholdPx) return { level: 2, tick: 'armed' };
  return { level, tick: null };
}

/**
 * Release velocity (px/ms, signed) from a trailing window of samples ending
 * at the release. Measured over the span from the oldest sample within the
 * velocity window to the newest — steadier than a single inter-event delta,
 * and correctly ~0 when the finger paused before lifting.
 */
export function swipeVelocity(samples: SwipeSample[], thresholds: SwipeThresholds = SWIPE_DEFAULTS): number {
  if (samples.length < 2) return 0;
  const end = samples[samples.length - 1];
  let begin = samples[0];
  for (const sample of samples) {
    if (end.t - sample.t <= thresholds.velocityWindowMs) {
      begin = sample;
      break;
    }
  }
  const dt = end.t - begin.t;
  return dt > 0 ? (end.x - begin.x) / dt : 0;
}

/** Definition of one swipe action (tray button + long-press menu entry). */
export interface SwipeActionDef {
  label: string;
  icon?: import('svelte').Component<{ class?: string }>;
  /**
   * Perform the action. Return true when it succeeded (the card animates
   * out and collapses) or false / reject when it failed (the card springs
   * back to rest).
   */
  onAction: () => Promise<boolean>;
}
