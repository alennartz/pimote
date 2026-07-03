/**
 * Delayed auto-collapse for streaming visuals (thinking block, edit/write
 * tool calls). While a block streams it renders expanded; instead of snapping
 * shut the instant streaming finishes, callers keep it expanded and use this
 * helper to collapse it the first time the element fully scrolls out of view.
 */

/**
 * Decide, from an IntersectionObserver callback's entries, whether the observed
 * element is now fully out of view (no part intersecting the root). Pure.
 */
export function isFullyOffscreen(entries: readonly IntersectionObserverEntry[]): boolean {
  return entries.some((entry) => !entry.isIntersecting);
}

/** Minimal observer surface used by {@link observeFullyOffscreen}. */
export type OffscreenObserverFactory = (onIntersect: (entries: readonly IntersectionObserverEntry[]) => void) => Pick<IntersectionObserver, 'observe' | 'disconnect'>;

function defaultObserverFactory(): OffscreenObserverFactory | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  return (onIntersect) => new IntersectionObserver((entries) => onIntersect(entries), { threshold: 0 });
}

/**
 * Invoke `onOffscreen` exactly once — the first time `el` is fully scrolled out
 * of view — then stop observing. Returns a disposer to stop observing early
 * (e.g. when the element unmounts or the caller re-expands).
 *
 * Note: IntersectionObserver reports the element's current visibility on its
 * first callback. If `el` is already offscreen when observation starts, the
 * collapse fires immediately, which is the desired behavior.
 *
 * Degrades to a no-op when no observer is available (e.g. SSR/tests without a
 * factory injected).
 */
export function observeFullyOffscreen(el: Element, onOffscreen: () => void, makeObserver: OffscreenObserverFactory | null = defaultObserverFactory()): () => void {
  if (!makeObserver) return () => {};
  const observer = makeObserver((entries) => {
    if (isFullyOffscreen(entries)) {
      onOffscreen();
      observer.disconnect();
    }
  });
  observer.observe(el);
  return () => observer.disconnect();
}
