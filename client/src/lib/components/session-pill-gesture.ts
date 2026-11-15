/** Movement past this distance decides the rail gesture; below it the press
 *  stays the browser's, which turns it into a click. */
export const SESSION_CHIP_SLOP = 8;
/** Gap between two chips, matching the rail's `gap-1.5`. */
export const SESSION_CHIP_GAP = 6;

export function isUpwardSessionPillSwipe(deltaX: number, deltaY: number): boolean {
  return deltaY < 0 && Math.abs(deltaY) > Math.abs(deltaX);
}

export function shouldOpenSessionPillActions(deltaX: number, deltaY: number, threshold = 16): boolean {
  return deltaY < -threshold && Math.abs(deltaY) > Math.abs(deltaX);
}

/** What a moving pointer does on the rail. */
export type ChipGesture =
  /** Sideways movement with the tray open: chips flow past the pinned one. */
  | 'flow'
  /** Anything else: vertical movement, or sideways movement with the tray
   *  closed, which is the rail's own scrolling. */
  | 'none';

/**
 * The tray is the mode switch. Only a sideways swipe with the tray open
 * reorders; every other movement belongs to the rail or the browser.
 */
export function resolveChipGesture(input: { trayOpen: boolean; moved: boolean; deltaX: number; deltaY: number }): ChipGesture {
  if (!input.moved) return 'none';
  if (Math.abs(input.deltaX) <= Math.abs(input.deltaY)) return 'none';
  return input.trayOpen ? 'flow' : 'none';
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
