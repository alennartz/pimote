import { describe, it, expect } from 'vitest';
import { recognizeCallGesture } from './call-gesture.js';

const at = (x: number, y: number, t: number) => ({ x, y, t });

describe('recognizeCallGesture', () => {
  it('classifies a tiny, fast pointerdown→pointerup as a tap', () => {
    expect(recognizeCallGesture(at(100, 500, 0), at(102, 503, 120))).toBe('tap');
  });

  it('refuses to call a slow stationary press a tap (over duration limit)', () => {
    expect(recognizeCallGesture(at(100, 500, 0), at(101, 501, 600))).toBe(null);
  });

  it('refuses to call a 20px drift a tap (over movement limit) but it is also not a swipe', () => {
    expect(recognizeCallGesture(at(100, 500, 0), at(115, 505, 100))).toBe(null);
  });

  it('classifies a clear upward drag as swipe-up (hang up)', () => {
    expect(recognizeCallGesture(at(100, 500, 0), at(105, 400, 250))).toBe('swipe-up');
  });

  it('classifies a clear downward drag as swipe-down (abort)', () => {
    expect(recognizeCallGesture(at(100, 500, 0), at(105, 600, 250))).toBe('swipe-down');
  });

  it('a 70px upward drag is below the swipe threshold and returns null', () => {
    expect(recognizeCallGesture(at(100, 500, 0), at(100, 430, 400))).toBe(null);
  });

  it('exactly meets the swipe threshold (80px) and counts as a swipe', () => {
    expect(recognizeCallGesture(at(100, 500, 0), at(100, 420, 400))).toBe('swipe-up');
    expect(recognizeCallGesture(at(100, 500, 0), at(100, 580, 400))).toBe('swipe-down');
  });

  it('honours custom thresholds', () => {
    expect(recognizeCallGesture(at(0, 0, 0), at(0, -40, 200), { swipeMinDeltaPx: 30 })).toBe('swipe-up');
    expect(recognizeCallGesture(at(0, 0, 0), at(20, 0, 200), { tapMaxMovementPx: 30 })).toBe('tap');
  });
});
