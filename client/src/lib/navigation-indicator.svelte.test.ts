import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_INDICATOR_DELAY_MS, createDelayedIndicator } from './navigation-indicator.svelte.js';

describe('createDelayedIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays hidden while activity is shorter than the delay', () => {
    let active = false;
    const indicator = createDelayedIndicator(() => active);

    active = true;
    indicator.update();
    vi.advanceTimersByTime(ACTIVITY_INDICATOR_DELAY_MS - 1);
    expect(indicator.visible).toBe(false);

    active = false;
    indicator.update();
    vi.advanceTimersByTime(500);
    expect(indicator.visible).toBe(false);
  });

  it('shows after the delay and hides immediately when activity ends', () => {
    let active = false;
    const indicator = createDelayedIndicator(() => active);

    active = true;
    indicator.update();
    expect(indicator.visible).toBe(false);

    vi.advanceTimersByTime(ACTIVITY_INDICATOR_DELAY_MS);
    expect(indicator.visible).toBe(true);

    active = false;
    indicator.update();
    expect(indicator.visible).toBe(false);
  });

  it('requires the full delay again after a cancelled show', () => {
    let active = false;
    const indicator = createDelayedIndicator(() => active);

    active = true;
    indicator.update();
    vi.advanceTimersByTime(ACTIVITY_INDICATOR_DELAY_MS - 50);
    active = false;
    indicator.update();

    active = true;
    indicator.update();
    vi.advanceTimersByTime(ACTIVITY_INDICATOR_DELAY_MS - 1);
    expect(indicator.visible).toBe(false);

    vi.advanceTimersByTime(1);
    expect(indicator.visible).toBe(true);
  });

  it('stop() cancels a pending show without hiding an already visible chip', () => {
    let active = false;
    const indicator = createDelayedIndicator(() => active);

    active = true;
    indicator.update();
    vi.advanceTimersByTime(ACTIVITY_INDICATOR_DELAY_MS);
    expect(indicator.visible).toBe(true);

    indicator.stop();
    expect(indicator.visible).toBe(true);
  });
});
