import { describe, expect, it } from 'vitest';
import { autoScrollVelocity, chipShift, dropSlot, flowPasses, flowResistance, insertLineX, resolveChipGesture, type ChipBox } from './session-pill-gesture.js';

const widths = (values: number[]) => (index: number) => values[index] ?? 80;

describe('resolveChipGesture', () => {
  it('a hold can lift a chip only while the tray is closed', () => {
    expect(resolveChipGesture({ trayOpen: false, moved: false, deltaX: 0, deltaY: 0 })).toBe('hold');
    expect(resolveChipGesture({ trayOpen: true, moved: false, deltaX: 0, deltaY: 0 })).toBe('none');
  });

  it('a sideways swipe flows the row with the tray open and scrolls the rail with it closed', () => {
    expect(resolveChipGesture({ trayOpen: true, moved: true, deltaX: 40, deltaY: 6 })).toBe('flow');
    expect(resolveChipGesture({ trayOpen: false, moved: true, deltaX: -40, deltaY: 6 })).toBe('scroll');
  });

  it('vertical movement is not a reorder gesture in either mode', () => {
    expect(resolveChipGesture({ trayOpen: false, moved: true, deltaX: 4, deltaY: -40 })).toBe('none');
    expect(resolveChipGesture({ trayOpen: true, moved: true, deltaX: 4, deltaY: -40 })).toBe('none');
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

describe('dropSlot', () => {
  const boxes: ChipBox[] = [
    { left: 0, width: 80 },
    { left: 86, width: 80 },
    { left: 172, width: 80 },
  ];

  it('stays at the lifted chip slot while the centre has not passed a neighbour', () => {
    expect(dropSlot(boxes, 0, 20)).toBe(0);
  });

  it('passes a neighbour once the lifted centre crosses its centre', () => {
    expect(dropSlot(boxes, 0, 90)).toBe(1);
    expect(dropSlot(boxes, 0, 200)).toBe(2);
  });

  it('passes neighbours in the other direction too', () => {
    expect(dropSlot(boxes, 2, -180)).toBe(0);
  });
});

describe('chipShift', () => {
  it('shifts the chips between the old and the new slot towards it', () => {
    expect(chipShift(1, 0, 2, 86)).toBe(-86);
    expect(chipShift(2, 0, 2, 86)).toBe(-86);
    expect(chipShift(3, 0, 2, 86)).toBe(0);
    expect(chipShift(0, 2, 0, 86)).toBe(86);
    expect(chipShift(1, 2, 0, 86)).toBe(86);
  });

  it('leaves the lifted chip and the untouched chips alone', () => {
    expect(chipShift(1, 1, 2, 86)).toBe(0);
    expect(chipShift(0, 1, 2, 86)).toBe(0);
  });
});

describe('insertLineX', () => {
  const boxes: ChipBox[] = [
    { left: 0, width: 80 },
    { left: 86, width: 80 },
    { left: 172, width: 80 },
  ];

  it('sits before the target slot when the chip moves left', () => {
    expect(insertLineX(boxes, 2, 0, 6)).toBe(0);
  });

  it('sits after the target slot when the chip moves right', () => {
    expect(insertLineX(boxes, 0, 1, 6)).toBeCloseTo(167.5);
  });

  it('never lands left of the rail origin', () => {
    expect(insertLineX(boxes, 1, 0, 6)).toBe(0);
  });
});

describe('autoScrollVelocity', () => {
  const rail = { left: 0, right: 300 };
  const edge = 34;

  it('does not scroll while the pointer is inside the rail', () => {
    expect(autoScrollVelocity(150, rail.left, rail.right, edge)).toBe(0);
  });

  it('scrolls forward near the right edge and backward near the left edge', () => {
    expect(autoScrollVelocity(300, rail.left, rail.right, edge)).toBeCloseTo(5);
    expect(autoScrollVelocity(0, rail.left, rail.right, edge)).toBeCloseTo(-5);
  });

  it('scrolls proportionally to the edge depth', () => {
    expect(autoScrollVelocity(283, rail.left, rail.right, edge)).toBeCloseTo(2.5);
  });
});
