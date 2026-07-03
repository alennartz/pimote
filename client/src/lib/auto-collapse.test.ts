import { describe, expect, it, vi } from 'vitest';
import { isFullyOffscreen, observeFullyOffscreen, type OffscreenObserverFactory } from './auto-collapse.js';

function entry(isIntersecting: boolean): IntersectionObserverEntry {
  return { isIntersecting } as IntersectionObserverEntry;
}

describe('isFullyOffscreen', () => {
  it('is true when an entry is not intersecting', () => {
    expect(isFullyOffscreen([entry(false)])).toBe(true);
  });

  it('is false when the entry is intersecting', () => {
    expect(isFullyOffscreen([entry(true)])).toBe(false);
  });

  it('is false with no entries', () => {
    expect(isFullyOffscreen([])).toBe(false);
  });
});

/** Fake observer factory that captures the callback so tests can drive it. */
function fakeFactory() {
  let emit: ((entries: readonly IntersectionObserverEntry[]) => void) | undefined;
  const observe = vi.fn();
  // A real observer stops delivering entries once disconnected.
  const disconnect = vi.fn(() => {
    emit = undefined;
  });
  const make: OffscreenObserverFactory = (onIntersect) => {
    emit = onIntersect;
    return { observe, disconnect };
  };
  return {
    make,
    observe,
    disconnect,
    emit: (entries: readonly IntersectionObserverEntry[]) => emit?.(entries),
  };
}

describe('observeFullyOffscreen', () => {
  const el = {} as Element;

  it('observes the element', () => {
    const f = fakeFactory();
    observeFullyOffscreen(el, () => {}, f.make);
    expect(f.observe).toHaveBeenCalledWith(el);
  });

  it('does not fire while the element stays visible', () => {
    const f = fakeFactory();
    const onOffscreen = vi.fn();
    observeFullyOffscreen(el, onOffscreen, f.make);
    f.emit([entry(true)]);
    expect(onOffscreen).not.toHaveBeenCalled();
    expect(f.disconnect).not.toHaveBeenCalled();
  });

  it('fires once and disconnects when the element scrolls offscreen', () => {
    const f = fakeFactory();
    const onOffscreen = vi.fn();
    observeFullyOffscreen(el, onOffscreen, f.make);
    f.emit([entry(false)]);
    f.emit([entry(false)]);
    expect(onOffscreen).toHaveBeenCalledTimes(1);
    expect(f.disconnect).toHaveBeenCalledTimes(1);
  });

  it('disposer disconnects the observer', () => {
    const f = fakeFactory();
    const dispose = observeFullyOffscreen(el, () => {}, f.make);
    dispose();
    expect(f.disconnect).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no observer is available', () => {
    const onOffscreen = vi.fn();
    const dispose = observeFullyOffscreen(el, onOffscreen, null);
    expect(() => dispose()).not.toThrow();
    expect(onOffscreen).not.toHaveBeenCalled();
  });
});
