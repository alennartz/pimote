/*!---------------------------------------------------------------------------------------------
 * Adapted from use-stick-to-bottom, Copyright (c) StackBlitz, MIT License
 * (https://github.com/samdenty/use-stick-to-bottom), via its Svelte 5 port
 * stick-to-bottom-svelte, Copyright (c) Pol, MIT License
 * (https://github.com/polvallverdu/stick-to-bottom-svelte).
 *---------------------------------------------------------------------------------------------
 * Escape detection follows the React original: programmatic writes leave an
 * `ignoreScrollToTop` sentinel, and an upward wheel resolved to this scroller
 * escapes immediately unless a nested scroller consumes it. Animation ticks
 * write synchronously inside the frame callback. Scroll traffic that never
 * leaves the bottom (a viewport clamp, a content shrink) never escapes.
 *----------------------------------------------------------------------------------------------*/

/** Distance from the bottom (px) that still counts as following the tail. */
export const STICK_TO_BOTTOM_OFFSET_PX = 70;
const SIXTY_FPS_INTERVAL_MS = 1000 / 60;
const RETAIN_ANIMATION_DURATION_MS = 350;

const DEFAULT_SPRING_ANIMATION = {
  /** A value from 0 to 1, on how much to damp the animation. */
  damping: 0.7,
  /** The stiffness of how fast/slow the animation gets up to speed. */
  stiffness: 0.05,
  /** The inertial mass associated with the animation. Higher numbers make the animation slower. */
  mass: 1.25,
};

export type SpringAnimation = Partial<typeof DEFAULT_SPRING_ANIMATION>;
export type Animation = ScrollBehavior | SpringAnimation;

export interface StickToBottomOptions extends SpringAnimation {
  scrollElement: () => HTMLElement | null | undefined;
  contentElement: () => HTMLElement | null | undefined;
  /** Called after a programmatic scroll write changes the scroll position. */
  onScrollPositionChange?: () => void;
  /** Animation used for the first follow after mount. */
  initial?: Animation;
  /** Animation used when already-pinned content grows or shrinks. */
  resize?: Animation;
}

export type ScrollToBottomOptions =
  | ScrollBehavior
  | {
      animation?: Animation;

      /**
       * Whether to wait for any existing scroll to finish before performing
       * this one, merging into it instead of restarting.
       */
      wait?: boolean | number;

      /**
       * Whether to prevent the user from escaping the scroll by scrolling up.
       */
      ignoreEscapes?: boolean;

      /**
       * Only scroll to the bottom when already pinned to it.
       */
      preserveScrollPosition?: boolean;

      /**
       * Extra duration in ms this scroll should persist for after reaching
       * the bottom, so content that grows mid-scroll keeps being followed.
       */
      duration?: number | Promise<void>;
    };

interface AnimationState {
  behavior: 'instant' | Readonly<Required<SpringAnimation>>;
  ignoreEscapes: boolean;
  promise: Promise<boolean>;
}

const browser = typeof window !== 'undefined';

let mouseDown = false;

if (browser) {
  document.addEventListener('mousedown', () => {
    mouseDown = true;
  });
  document.addEventListener('mouseup', () => {
    mouseDown = false;
  });
  document.addEventListener('click', () => {
    mouseDown = false;
  });
}

export class StickToBottom {
  private escapedFromLockState = $state(false);
  private isAtBottomState = $state(false);
  private isNearBottomState = $state(false);

  private ignoreScrollToTop: number | undefined = undefined;
  private animation: AnimationState | undefined = undefined;
  private lastTick: number | undefined = undefined;
  private velocity = 0;
  private accumulated = 0;
  private lastScrollTop: number | undefined = undefined;
  private resizeDifference = 0;

  constructor(private options: StickToBottomOptions) {
    this.isAtBottomState = true;

    $effect(() => {
      const scrollElement = this.options.scrollElement();
      if (!scrollElement) return;

      scrollElement.addEventListener('scroll', this.handleScroll, { passive: true });
      scrollElement.addEventListener('wheel', this.handleWheel, { passive: true });
      return () => {
        scrollElement.removeEventListener('scroll', this.handleScroll);
        scrollElement.removeEventListener('wheel', this.handleWheel);
      };
    });

    $effect(() => {
      const contentElement = this.options.contentElement();
      if (!contentElement || typeof ResizeObserver === 'undefined') return;

      let previousHeight: number | undefined;

      const resizeObserver = new ResizeObserver((entries) => {
        const height = entries[0]?.contentRect.height ?? 0;
        const difference = height - (previousHeight ?? height);

        this.resizeDifference = difference;

        // The browser can overscroll past the target; pull it back.
        if (this.scrollTop > this.targetScrollTop) {
          this.setScrollTop(this.targetScrollTop);
        }

        this.isNearBottomState = this.isNearBottom();

        if (difference >= 0) {
          // Positive resize: follow the new bottom when still pinned.
          const animation = mergeAnimations(this.options, previousHeight ? this.options.resize : this.options.initial);
          this.scrollToBottom({
            animation,
            wait: true,
            preserveScrollPosition: true,
            duration: animation === 'instant' ? undefined : RETAIN_ANIMATION_DURATION_MS,
          });
        } else if (this.isNearBottom()) {
          // Negative resize can bring the bottom back into reach; re-pin.
          this.escapedFromLockState = false;
          this.isAtBottomState = true;
        }

        previousHeight = height;

        // Reset after the resize-caused scroll event has fired. The frame
        // waits for the scroll event, the timeout for the handler's own delay.
        requestAnimationFrame(() => {
          setTimeout(() => {
            if (this.resizeDifference === difference) this.resizeDifference = 0;
          }, 1);
        });
      });

      resizeObserver.observe(contentElement);
      return () => resizeObserver.disconnect();
    });

    // A viewport change moves the bottom without changing content height, so
    // the content observer stays silent. A pinned follow lands on the new
    // bottom inside this callback, before the frame paints.
    $effect(() => {
      const scrollElement = this.options.scrollElement();
      if (!scrollElement || typeof ResizeObserver === 'undefined') return;

      let previousWidth = scrollElement.clientWidth;
      let previousHeight = scrollElement.clientHeight;

      const resizeObserver = new ResizeObserver(() => {
        const width = scrollElement.clientWidth;
        const height = scrollElement.clientHeight;
        const changed = width !== previousWidth || height !== previousHeight;
        previousWidth = width;
        previousHeight = height;
        if (!changed) return;

        this.isNearBottomState = this.isNearBottom();
        // A reader inside the transcript stays where they are reading, and
        // content shorter than the viewport has no bottom to reach.
        if (this.escapedFromLockState || this.maxScrollTop <= 0) return;

        this.isAtBottomState = true;
        this.setScrollTop(this.targetScrollTop);
      });

      resizeObserver.observe(scrollElement);
      return () => resizeObserver.disconnect();
    });
  }

  get escapedFromLock(): boolean {
    return this.escapedFromLockState;
  }

  /** True while following the bottom, or within the stick offset of it. */
  get isAtBottom(): boolean {
    return this.isAtBottomState || this.isNearBottomState;
  }

  get scrollTop(): number {
    return this.options.scrollElement()?.scrollTop ?? 0;
  }

  /** Bottom-most reachable scroll position. */
  get maxScrollTop(): number {
    const scrollElement = this.options.scrollElement();
    if (!scrollElement) return 0;
    return scrollElement.scrollHeight - scrollElement.clientHeight;
  }

  /** Bottom-most scroll position minus one, so fractional scroll heights terminate the animation. */
  get targetScrollTop(): number {
    return this.maxScrollTop - 1;
  }

  get scrollDifference(): number {
    return this.targetScrollTop - this.scrollTop;
  }

  private isNearBottom(): boolean {
    return this.scrollDifference <= STICK_TO_BOTTOM_OFFSET_PX;
  }

  private setScrollTop(scrollTop: number): void {
    const scrollElement = this.options.scrollElement();
    if (!scrollElement) return;
    // Override CSS scroll-behavior so the write lands immediately instead
    // of being intercepted by browser smooth scrolling. The stylesheet
    // value is cached per element: it only changes with CSS, never per
    // frame, and getComputedStyle would force a style recalc on every
    // animation tick.
    let scrollBehavior = StickToBottom.cachedScrollBehavior.get(scrollElement);
    if (scrollBehavior === undefined) {
      scrollBehavior = getComputedStyle(scrollElement).scrollBehavior;
      StickToBottom.cachedScrollBehavior.set(scrollElement, scrollBehavior);
    }
    const changed = scrollBehavior !== 'auto';
    const previousScrollTop = scrollElement.scrollTop;
    if (changed) scrollElement.style.scrollBehavior = 'auto';
    scrollElement.scrollTop = scrollTop;
    if (changed) scrollElement.style.scrollBehavior = scrollBehavior;
    this.ignoreScrollToTop = scrollElement.scrollTop;
    if (scrollElement.scrollTop !== previousScrollTop) this.options.onScrollPositionChange?.();
  }

  private static cachedScrollBehavior = new WeakMap<HTMLElement, string>();

  scrollToBottom = (scrollOptions: ScrollToBottomOptions = {}): Promise<boolean> => {
    if (typeof scrollOptions === 'string') scrollOptions = { animation: scrollOptions };

    if (!scrollOptions.preserveScrollPosition) this.isAtBottomState = true;

    // The wait grace period applies only while merging into a running
    // animation; a fresh scroll starts on the next frame.
    const waitElapsed = this.animation ? Date.now() + (Number(scrollOptions.wait) || 0) : 0;
    const behavior = mergeAnimations(this.options, scrollOptions.animation);
    const { ignoreEscapes = false } = scrollOptions;

    let durationElapsed: number;
    let startTarget = this.targetScrollTop;

    if (scrollOptions.duration instanceof Promise) {
      scrollOptions.duration.finally(() => {
        durationElapsed = Date.now();
      });
    } else {
      durationElapsed = waitElapsed + (scrollOptions.duration ?? 0);
    }

    let resolveResult: (value: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolveResult = resolve;
    });

    const resetVelocitySoon = () => {
      requestAnimationFrame(() => {
        if (!this.animation) {
          this.lastTick = undefined;
          this.velocity = 0;
        }
      });
    };

    const tick = (): void => {
      if (!this.isAtBottomState) {
        this.animation = undefined;
        resolveResult!(false);
        resetVelocitySoon();
        return;
      }

      const startScrollTop = this.scrollTop;
      const now = performance.now();
      const tickDelta = (now - (this.lastTick ?? now)) / SIXTY_FPS_INTERVAL_MS;
      this.animation ||= { behavior, promise, ignoreEscapes };
      if (this.animation.behavior === behavior) this.lastTick = now;

      if (this.isSelecting()) return queueTick(tick);
      if (waitElapsed > Date.now()) return queueTick(tick);

      if (startScrollTop < Math.min(startTarget, this.targetScrollTop)) {
        if (this.animation.behavior === behavior) {
          if (behavior === 'instant') {
            this.setScrollTop(this.targetScrollTop);
            return queueTick(tick);
          }

          this.velocity = (behavior.damping * this.velocity + behavior.stiffness * this.scrollDifference) / behavior.mass;
          this.accumulated += this.velocity * tickDelta;
          this.setScrollTop(this.scrollTop + this.accumulated);
          if (this.scrollTop !== startScrollTop) this.accumulated = 0;
        }
        return queueTick(tick);
      }

      if (durationElapsed > Date.now()) {
        startTarget = this.targetScrollTop;
        return queueTick(tick);
      }

      this.animation = undefined;

      // Still below the target: queue another scroll with the resize
      // animation so late layout changes keep being followed.
      if (this.scrollTop < this.targetScrollTop) {
        this.scrollToBottom({
          animation: mergeAnimations(this.options, this.options.resize),
          ignoreEscapes,
          duration: Math.max(0, durationElapsed - Date.now()) || undefined,
        }).then(resolveResult!);
        resetVelocitySoon();
        return;
      }

      resolveResult!(this.isAtBottomState);
      resetVelocitySoon();
    };

    const queueTick = (tick: () => void): void => {
      requestAnimationFrame(() => tick());
    };

    if (scrollOptions.wait !== true) this.animation = undefined;
    if (this.animation?.behavior === behavior) return this.animation.promise;

    queueTick(tick);
    return promise;
  };

  stopScroll = (): void => {
    this.escapedFromLockState = true;
    this.isAtBottomState = false;
  };

  private isSelecting(): boolean {
    if (!mouseDown) return false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    const scrollElement = this.options.scrollElement();
    return Boolean(scrollElement && (range.commonAncestorContainer.contains(scrollElement) || scrollElement.contains(range.commonAncestorContainer)));
  }

  private handleScroll = ({ target }: Event): void => {
    const scrollElement = this.options.scrollElement();
    if (!scrollElement || target !== scrollElement) return;

    const scrollTop = this.scrollTop;
    const ignoreScrollToTop = this.ignoreScrollToTop;
    let previousScrollTop = this.lastScrollTop ?? scrollTop;

    this.lastScrollTop = scrollTop;
    this.ignoreScrollToTop = undefined;

    // A user scroll while the animation plays may land below the last
    // programmatic write in one coalesced event; measuring from the
    // sentinel keeps the upward motion visible.
    if (ignoreScrollToTop && ignoreScrollToTop > scrollTop) previousScrollTop = ignoreScrollToTop;

    this.isNearBottomState = this.isNearBottom();

    // Scroll events can precede the ResizeObserver event; the delay orders
    // resize-caused scrolls behind the resizeDifference guard.
    // @see https://github.com/WICG/resize-observer/issues/25#issuecomment-248757228
    setTimeout(() => {
      if (this.resizeDifference || scrollTop === ignoreScrollToTop) return;

      if (this.isSelecting()) {
        this.stopScroll();
        return;
      }

      if (this.animation?.ignoreEscapes) {
        this.setScrollTop(previousScrollTop);
        return;
      }

      const isScrollingDown = scrollTop > previousScrollTop;
      // A shrink of the viewport or of the content clamps the position down to
      // the new maximum. Landing on the bottom is not a scroll away from it.
      const isScrollingUp = scrollTop < previousScrollTop && scrollTop < this.maxScrollTop;

      if (isScrollingUp) this.stopScroll();
      if (isScrollingDown) this.escapedFromLockState = false;

      if (!this.escapedFromLockState && this.isNearBottom()) this.isAtBottomState = true;
    }, 1);
  };

  private handleWheel = (event: WheelEvent): void => {
    const scrollElement = this.options.scrollElement();
    if (!scrollElement || event.deltaY >= 0) return;
    if (scrollElement.scrollHeight <= scrollElement.clientHeight) return;
    if (this.animation?.ignoreEscapes) return;

    // An inner scroller that can still move in this direction consumes the
    // wheel, so it must not unpin this container.
    let element: Element | null = event.target instanceof Element ? event.target : null;
    while (element && element !== scrollElement) {
      if (innerScrollerConsumesWheel(element, event.deltaY)) return;
      element = element.parentElement;
    }
    if (element === scrollElement) this.stopScroll();
  };
}

function innerScrollerConsumesWheel(element: Element, deltaY: number): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const overflowY = getComputedStyle(element).overflowY;
  if (overflowY !== 'auto' && overflowY !== 'scroll') return false;
  if (element.scrollHeight <= element.clientHeight) return false;
  return deltaY < 0 ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight;
}

// Reference-equal merged animations are load-bearing: scrollToBottom dedupes
// and merges running loops by behavior identity, so this cache must not be
// reactive.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- memo cache for animation identity, not UI state
const animationCache = new Map<string, Readonly<Required<SpringAnimation>>>();

function mergeAnimations(...animations: (Animation | undefined)[]): 'instant' | Readonly<Required<SpringAnimation>> {
  const result = { ...DEFAULT_SPRING_ANIMATION };
  let instant = false;

  for (const animation of animations) {
    if (animation === 'instant') {
      instant = true;
      continue;
    }
    if (typeof animation !== 'object') continue;

    instant = false;
    result.damping = animation.damping ?? result.damping;
    result.stiffness = animation.stiffness ?? result.stiffness;
    result.mass = animation.mass ?? result.mass;
  }

  if (instant) return 'instant';

  const key = JSON.stringify(result);
  let cached = animationCache.get(key);
  if (!cached) {
    cached = Object.freeze(result);
    animationCache.set(key, cached);
  }
  return cached;
}
