import { describe, it, expect } from 'vitest';
import { SWIPE_DEFAULTS, swipeAxis, swipeMoved, swipeRelease, swipeTickLevel, swipeTranslate, swipeVelocity } from './swipe-action.js';

const at = (x: number, y: number, t: number) => ({ x, y, t });

describe('swipeAxis', () => {
  it('is undecided within the axis lock distance', () => {
    expect(swipeAxis(at(100, 500, 0), at(105, 503, 40))).toBe('undecided');
  });

  it('commits horizontal as soon as the finger clears the axis lock', () => {
    expect(swipeAxis(at(100, 500, 0), at(106, 500, 40))).toBe('horizontal');
  });

  it('commits horizontal on a tie (dx === dy)', () => {
    expect(swipeAxis(at(100, 500, 0), at(115, 515, 60))).toBe('horizontal');
  });

  it('stands down for vertical drags so the page can scroll', () => {
    expect(swipeAxis(at(100, 500, 0), at(103, 530, 60))).toBe('vertical');
  });
});

describe('swipeMoved', () => {
  it('ignores a tap-sized wiggle', () => {
    expect(swipeMoved(at(100, 500, 0), at(105, 503, 50))).toBe(false);
  });

  it('suppresses past the tap window, including diagonal travel', () => {
    expect(swipeMoved(at(100, 500, 0), at(108, 500, 50))).toBe(true);
    expect(swipeMoved(at(100, 500, 0), at(105, 509, 50))).toBe(true);
  });
});

describe('swipeTranslate', () => {
  it('tracks the finger linearly within the rubber-band start', () => {
    expect(swipeTranslate(-80)).toBe(-80);
    expect(swipeTranslate(-120)).toBe(-120);
  });

  it('applies resistance past 1.5× the reveal width', () => {
    // 40 raw px past the 120 start, at 0.3 resistance → 12 rendered
    expect(swipeTranslate(-160)).toBeCloseTo(-132, 5);
  });

  it('hard-clamps the raw drag at 2× the reveal width', () => {
    expect(swipeTranslate(-300)).toBe(swipeTranslate(-160));
  });

  it('is symmetric for rightward drags', () => {
    expect(swipeTranslate(80)).toBe(80);
    expect(swipeTranslate(160)).toBeCloseTo(132, 5);
  });
});

describe('swipeRelease', () => {
  it('fires the trailing action when dragged far enough left', () => {
    expect(swipeRelease(-104, 0)).toEqual({ kind: 'fire', side: 'left' });
  });

  it('fires the leading action when dragged far enough right', () => {
    expect(swipeRelease(104, 0)).toEqual({ kind: 'fire', side: 'right' });
  });

  it('fires a fast flick past the reveal width even on a short drag', () => {
    expect(swipeRelease(-90, 0.6)).toEqual({ kind: 'fire', side: 'left' });
  });

  it('does not fire a short slow drag past the reveal width', () => {
    expect(swipeRelease(-90, 0.2)).toEqual({ kind: 'open', side: 'left' });
  });

  it('does not fire a fast flick below the reveal width — it opens instead', () => {
    expect(swipeRelease(-60, 2)).toEqual({ kind: 'open', side: 'left' });
  });

  it('snaps open past the open threshold and shut below it', () => {
    expect(swipeRelease(-40, 0)).toEqual({ kind: 'open', side: 'left' });
    expect(swipeRelease(50, 0)).toEqual({ kind: 'open', side: 'right' });
    expect(swipeRelease(-39, 0)).toEqual({ kind: 'snap-shut' });
  });
});

describe('swipeTickLevel', () => {
  it('is silent below the reveal width', () => {
    expect(swipeTickLevel(0, 40)).toEqual({ level: 0, tick: null });
  });

  it('ticks once when the tray reveals, then stays silent while dwelling', () => {
    expect(swipeTickLevel(0, 80)).toEqual({ level: 1, tick: 'reveal' });
    expect(swipeTickLevel(1, 85)).toEqual({ level: 1, tick: null });
    expect(swipeTickLevel(1, 80)).toEqual({ level: 1, tick: null });
  });

  it('ticks distinctly when the gesture arms for fire', () => {
    expect(swipeTickLevel(1, 104)).toEqual({ level: 2, tick: 'armed' });
    expect(swipeTickLevel(2, 110)).toEqual({ level: 2, tick: null });
  });

  it('ticks armed only when a first move jumps straight past the fire threshold', () => {
    expect(swipeTickLevel(0, 130)).toEqual({ level: 2, tick: 'armed' });
  });

  it('ignores jitter inside the hysteresis band — no re-tick, no re-arm', () => {
    // Fire threshold 104, hysteresis 12: dipping to 93 stays armed and silent.
    expect(swipeTickLevel(2, 93)).toEqual({ level: 2, tick: null });
    // Reveal threshold 80: dipping to 70 stays revealed and silent.
    expect(swipeTickLevel(1, 70)).toEqual({ level: 1, tick: null });
  });

  it('descends silently and re-ticks once per deliberate outward crossing', () => {
    expect(swipeTickLevel(2, 91)).toEqual({ level: 1, tick: null }); // below fire − hysteresis
    expect(swipeTickLevel(1, 67)).toEqual({ level: 0, tick: null }); // below reveal − hysteresis
    expect(swipeTickLevel(0, 80)).toEqual({ level: 1, tick: 'reveal' });
    expect(swipeTickLevel(1, 104)).toEqual({ level: 2, tick: 'armed' });
  });

  it('falls from armed straight past the reveal band in one silent step', () => {
    expect(swipeTickLevel(2, 40)).toEqual({ level: 0, tick: null });
  });
});

describe('swipeVelocity', () => {
  it('is zero without a usable pair of samples', () => {
    expect(swipeVelocity([])).toBe(0);
    expect(swipeVelocity([at(100, 500, 0)])).toBe(0);
  });

  it('measures over the trailing window, ignoring stale samples', () => {
    // An old fast sample must not skew the 40px/100ms the finger just made.
    const samples = [at(0, 0, 0), at(100, 0, 100), at(140, 0, 200)];
    expect(swipeVelocity(samples)).toBeCloseTo(0.4, 5);
  });

  it('uses the full span when the window covers everything', () => {
    const samples = [at(0, 0, 0), at(50, 0, 50)];
    expect(swipeVelocity(samples)).toBeCloseTo(1, 5);
  });

  it('keeps the direction as a sign', () => {
    const samples = [at(100, 0, 0), at(40, 0, 100)];
    expect(swipeVelocity(samples)).toBeCloseTo(-0.6, 5);
  });

  it('is zero when time does not advance', () => {
    expect(swipeVelocity([at(0, 0, 10), at(20, 0, 10)])).toBe(0);
  });
});

describe('SWIPE_DEFAULTS', () => {
  it('keeps the fire threshold reachable within the rubber-band clamp', () => {
    expect(SWIPE_DEFAULTS.fireThresholdPx).toBeLessThanOrEqual(SWIPE_DEFAULTS.revealWidthPx * SWIPE_DEFAULTS.rubberMaxFactor);
  });

  it('arms before rubber-banding starts, so the armed tick lands on 1:1 motion', () => {
    expect(SWIPE_DEFAULTS.fireThresholdPx).toBeLessThanOrEqual(SWIPE_DEFAULTS.revealWidthPx * SWIPE_DEFAULTS.rubberStartFactor);
  });

  it('orders the thresholds: open < reveal < fire', () => {
    expect(SWIPE_DEFAULTS.openThresholdPx).toBeLessThan(SWIPE_DEFAULTS.revealWidthPx);
    expect(SWIPE_DEFAULTS.revealWidthPx).toBeLessThan(SWIPE_DEFAULTS.fireThresholdPx);
  });

  it('gates hysteresis strictly inside the reveal→armed span', () => {
    expect(SWIPE_DEFAULTS.tickHysteresisPx).toBeLessThan(SWIPE_DEFAULTS.revealWidthPx);
    expect(SWIPE_DEFAULTS.revealWidthPx - SWIPE_DEFAULTS.tickHysteresisPx).toBeGreaterThan(0);
  });
});
