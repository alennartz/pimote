/** How long a finger rests on a chip before the chip lifts for dragging. */
export const SESSION_CHIP_HOLD_MS = 220;
/** Movement past this distance cancels the hold and decides the gesture. */
export const SESSION_CHIP_SLOP = 8;
/** Gap between two chips, matching the rail's `gap-1.5`. */
export const SESSION_CHIP_GAP = 6;
/** Widest rail stretch a chip drag scrolls per animation frame. */
export const SESSION_CHIP_MAX_SCROLL_STEP = 5;
/** Finger distance from a rail edge that starts auto-scrolling a drag. */
export const SESSION_CHIP_SCROLL_EDGE = 34;

export function isUpwardSessionPillSwipe(deltaX: number, deltaY: number): boolean {
  return deltaY < 0 && Math.abs(deltaY) > Math.abs(deltaX);
}

export function shouldOpenSessionPillActions(deltaX: number, deltaY: number, threshold = 16): boolean {
  return deltaY < -threshold && Math.abs(deltaY) > Math.abs(deltaX);
}

/** The one thing a pointer gesture on the rail does (D9). */
export type ChipGesture =
  /** Nothing moved yet: the hold may lift this chip when the tray is closed. */
  | 'hold'
  /** Sideways movement with the tray open: chips flow past the pinned one. */
  | 'flow'
  /** Sideways movement with the tray closed: the rail scrolls. */
  | 'scroll'
  /** Vertical movement, or a hold with the tray open: not a reorder gesture. */
  | 'none';

/**
 * The tray is the mode switch. A hold lifts a chip only while the tray is
 * closed, a sideways swipe flows the row only while it is open, and sideways
 * movement on a closed tray scrolls the rail instead.
 */
export function resolveChipGesture(input: { trayOpen: boolean; moved: boolean; deltaX: number; deltaY: number }): ChipGesture {
  const sideways = Math.abs(input.deltaX) > Math.abs(input.deltaY);
  if (input.moved) {
    if (!sideways) return 'none';
    return input.trayOpen ? 'flow' : 'scroll';
  }
  return input.trayOpen ? 'none' : 'hold';
}

/** Chip geometry in the rail's content space, left edge and width. */
export interface ChipBox {
  left: number;
  width: number;
}

export interface FlowStep {
  /** Where the pinned chip sits after the passes this movement commits. */
  index: number;
  /** Movement left over after the committed passes, same sign as the input. */
  leftover: number;
  passes: number;
}

/**
 * Passes the pinned chip across its neighbours for one sideways movement.
 * Each pass costs half of the crossed chip's width, so a long swipe commits
 * several passes while a short one commits none. A pass with no neighbour on
 * the pulled side is refused — the ends never wrap (D9).
 */
export function flowPasses(input: { index: number; count: number; deltaX: number; widthAt: (index: number) => number; gap?: number; maxPasses?: number }): FlowStep {
  const gap = input.gap ?? SESSION_CHIP_GAP;
  const maxPasses = input.maxPasses ?? 8;
  let index = input.index;
  let leftover = input.deltaX;
  let passes = 0;
  while (passes < maxPasses) {
    // A swipe left pulls the chip on the right past the pinned one.
    const direction = leftover < 0 ? 1 : -1;
    const neighbour = index + direction;
    if (neighbour < 0 || neighbour >= input.count) break;
    const cost = (input.widthAt(neighbour) + gap) / 2;
    if (Math.abs(leftover) <= cost) break;
    leftover -= Math.sign(leftover) * cost;
    index = neighbour;
    passes += 1;
  }
  return { index, leftover, passes };
}

/** How far the row still follows a finger that has no chip left to cross.
 *  Damped, so a refused pass reads as the row springing back. */
export function flowResistance(leftover: number, factor = 0.22, limit = 22): number {
  return Math.sign(leftover) * Math.min(Math.abs(leftover) * factor, limit);
}

/**
 * The slot a lifted chip drops into: every other chip whose centre sits left
 * of the lifted chip's centre goes before it.
 */
export function dropSlot(boxes: readonly ChipBox[], fromIndex: number, offset: number): number {
  const from = boxes[fromIndex];
  if (!from) return fromIndex;
  const centre = from.left + from.width / 2 + offset;
  let slot = 0;
  boxes.forEach((box, index) => {
    if (index === fromIndex) return;
    if (box.left + box.width / 2 < centre) slot += 1;
  });
  return slot;
}

/** How far a chip shifts aside while the lifted chip hovers over a drop slot. */
export function chipShift(index: number, fromIndex: number, slot: number, step: number): number {
  if (index === fromIndex) return 0;
  if (fromIndex < slot && index > fromIndex && index <= slot) return -step;
  if (fromIndex > slot && index >= slot && index < fromIndex) return step;
  return 0;
}

/** Where the insert-line marker sits for a drop slot, in content space. */
export function insertLineX(boxes: readonly ChipBox[], fromIndex: number, slot: number, gap: number = SESSION_CHIP_GAP): number {
  const from = boxes[fromIndex];
  const target = boxes[slot];
  if (!from || !target) return 0;
  const x = slot <= fromIndex ? target.left - gap / 2 - 1.5 : target.left + target.width + gap / 2 - 1.5;
  return Math.max(0, x);
}

/** Rail scroll speed for a dragged chip held near either rail edge. */
export function autoScrollVelocity(
  pointerX: number,
  railLeft: number,
  railRight: number,
  edge: number = SESSION_CHIP_SCROLL_EDGE,
  maxStep: number = SESSION_CHIP_MAX_SCROLL_STEP,
): number {
  const innerRight = railRight - edge;
  const innerLeft = railLeft + edge;
  if (pointerX > innerRight) return maxStep * Math.min(1, (pointerX - innerRight) / edge);
  if (pointerX < innerLeft) return -maxStep * Math.min(1, (innerLeft - pointerX) / edge);
  return 0;
}
