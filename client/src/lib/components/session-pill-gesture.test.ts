import { describe, expect, it } from 'vitest';
import { flowPasses, flowResistance, resolveChipGesture } from './session-pill-gesture.js';

const widths = (values: number[]) => (index: number) => values[index] ?? 80;

describe('resolveChipGesture', () => {
  it('flows the row only on a sideways swipe with the tray open', () => {
    expect(resolveChipGesture({ trayOpen: true, moved: true, deltaX: -40, deltaY: 4 })).toBe('flow');
  });

  it('leaves a sideways swipe with the tray closed to the rail', () => {
    expect(resolveChipGesture({ trayOpen: false, moved: true, deltaX: -40, deltaY: 4 })).toBe('none');
  });

  it('leaves vertical movement to the browser in both modes', () => {
    expect(resolveChipGesture({ trayOpen: true, moved: true, deltaX: 3, deltaY: -40 })).toBe('none');
    expect(resolveChipGesture({ trayOpen: false, moved: true, deltaX: 3, deltaY: -40 })).toBe('none');
  });

  it('keeps a press that has not travelled out of the gesture decision', () => {
    expect(resolveChipGesture({ trayOpen: true, moved: false, deltaX: 0, deltaY: 0 })).toBe('none');
    expect(resolveChipGesture({ trayOpen: false, moved: false, deltaX: 0, deltaY: 0 })).toBe('none');
  });
});

describe('flowPasses', () => {
  const gap = 6;

  it('commits no pass below half of the crossed chip width', () => {
    const step = flowPasses({ index: 1, count: 3, deltaX: -40, widthAt: widths([80, 80, 80]), gap });

    expect(step).toEqual({ index: 1, leftover: -40, passes: 0 });
  });

  it('commits one pass past half of the crossed chip width', () => {
    const step = flowPasses({ index: 1, count: 3, deltaX: -44, widthAt: widths([80, 80, 80]), gap });

    expect(step.passes).toBe(1);
    expect(step.index).toBe(2);
    expect(step.leftover).toBeCloseTo(-1);
  });

  it('commits several passes in one long swipe', () => {
    const step = flowPasses({ index: 0, count: 4, deltaX: -100, widthAt: widths([80, 80, 80, 80]), gap });

    expect(step.passes).toBe(2);
    expect(step.index).toBe(2);
  });

  it('measures each pass against the chip it crosses', () => {
    // The wide chip costs more, so the same swipe passes one chip, not two.
    const step = flowPasses({ index: 1, count: 3, deltaX: -120, widthAt: widths([80, 200, 80]), gap });

    expect(step.passes).toBe(1);
    expect(step.index).toBe(2);
  });

  it('refuses the pass at the last position — the ends do not wrap', () => {
    const step = flowPasses({ index: 2, count: 3, deltaX: -200, widthAt: widths([80, 80, 80]), gap });

    expect(step).toEqual({ index: 2, leftover: -200, passes: 0 });
  });

  it('refuses the pass at the first position', () => {
    const step = flowPasses({ index: 0, count: 3, deltaX: 200, widthAt: widths([80, 80, 80]), gap });

    expect(step).toEqual({ index: 0, leftover: 200, passes: 0 });
  });

  it('moves the pinned chip the other way for a swipe to the right', () => {
    const step = flowPasses({ index: 2, count: 3, deltaX: 50, widthAt: widths([80, 80, 80]), gap });

    expect(step.index).toBe(1);
    expect(step.passes).toBe(1);
  });
});

describe('flowResistance', () => {
  it('damps a refused pass instead of following the finger', () => {
    expect(flowResistance(200)).toBeCloseTo(22);
    expect(flowResistance(40)).toBeCloseTo(8.8);
    expect(flowResistance(-40)).toBeCloseTo(-8.8);
  });
});
