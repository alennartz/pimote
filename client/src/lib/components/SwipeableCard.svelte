<script module lang="ts">
  // Coordinator so only one swipe card is open at a time, and so page scroll
  // can dismiss whichever card is open. Bookkeeping only — no reactivity needed.
  let openCloser: (() => void) | null = null;

  /** Close whichever swipeable card is currently open (no-op if none). */
  export function closeOpenSwipeCard(): void {
    openCloser?.();
  }

  function claimOpen(close: () => void): void {
    if (openCloser !== close) openCloser?.();
    openCloser = close;
  }

  function releaseOpen(close: () => void): void {
    if (openCloser === close) openCloser = null;
  }
</script>

<script lang="ts">
  import { type Snippet, onDestroy } from 'svelte';
  import { slide } from 'svelte/transition';
  import { ContextMenu } from 'bits-ui';
  import {
    SWIPE_DEFAULTS,
    swipeAxis,
    swipeMoved,
    swipeRelease,
    swipeTickLevel,
    swipeTranslate,
    swipeVelocity,
    type SwipeActionDef,
    type SwipeSample,
    type SwipeSide,
    type SwipeTickLevel,
  } from './swipe-action.js';

  interface Props {
    /** Revealed by dragging the card left (tray on the right edge). */
    actionLeft?: SwipeActionDef;
    /** Revealed by dragging the card right (tray on the left edge). */
    actionRight?: SwipeActionDef;
    children: Snippet;
  }

  // NOTE: children are rendered on top of the trays, so they must paint an
  // opaque, full-width surface (e.g. `bg-card w-full`) or the trays will show
  // through when the card is at rest.

  let { actionLeft, actionRight, children }: Props = $props();

  type Phase = 'idle' | 'dragging' | 'exiting' | 'done';

  let cellEl: HTMLDivElement | null = $state(null);
  let surfaceEl: HTMLDivElement | null = $state(null);

  let dx = $state(0);
  let phase = $state<Phase>('idle');
  let activeSide = $state<SwipeSide | null>(null);
  let armedSide = $state<SwipeSide | null>(null);
  let suppressClick = $state(false);

  let mq: MediaQueryList | null = null;
  let start: SwipeSample | null = null;
  let baseDx = 0;
  // Per-gesture recognizer state (plain vars — the template never reads them):
  // the axis decision latches so a mid-drag vertical lean cannot freeze the
  // card, trailing samples feed a steady release velocity, and tickLevel +
  // hapticSpent track haptic progress so at most one subtle tick fires per
  // gesture, on its first threshold crossing.
  let axisLocked = false;
  let samples: SwipeSample[] = [];
  let tickLevel: SwipeTickLevel = 0;
  let hapticSpent = false;

  function pushSample(sample: SwipeSample) {
    samples.push(sample);
    if (samples.length > 16) samples = samples.slice(-16);
  }

  function isMobile(): boolean {
    return (mq ??= window.matchMedia('(max-width: 767px)')).matches;
  }

  const isOpen = $derived(phase === 'idle' && dx !== 0);
  const transition = $derived(phase === 'dragging' ? 'none' : 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)');

  function actionFor(side: SwipeSide): SwipeActionDef | undefined {
    return side === 'left' ? actionLeft : actionRight;
  }

  function rawDxAt(x: number): number {
    return baseDx + (x - (start?.x ?? x));
  }

  function onPointerDown(e: PointerEvent) {
    if (phase === 'exiting' || phase === 'done' || suppressClick) return;
    if (!isMobile() || e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    baseDx = dx;
    axisLocked = false;
    samples = [start];
    hapticSpent = false;
    // Seed the haptic level from where the drag starts, so wiggling an
    // already-open tray does not re-tick the reveal it is already showing.
    const baseMag = Math.abs(baseDx);
    tickLevel = baseMag >= SWIPE_DEFAULTS.fireThresholdPx ? 2 : baseMag >= SWIPE_DEFAULTS.revealWidthPx ? 1 : 0;
    phase = 'dragging';
  }

  function onPointerMove(e: PointerEvent) {
    if (phase !== 'dragging' || !start) return;
    const current: SwipeSample = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    if (!axisLocked) {
      if (swipeAxis(start, current) !== 'horizontal') return; // undecided or vertical — let the browser scroll
      axisLocked = true; // latched: a later vertical lean must not freeze the card mid-glide
    }

    const raw = rawDxAt(current.x);
    const side: SwipeSide = raw < 0 ? 'left' : 'right';
    if (activeSide === null) {
      activeSide = side;
      try {
        surfaceEl?.setPointerCapture(e.pointerId);
      } catch {
        // Capture is best-effort; touch pointers are implicitly captured anyway.
      }
    }

    // One subtle tick per gesture, on the first threshold crossing: the
    // reveal crossing from rest, or the armed crossing when continuing an
    // already-open tray out toward fire. Later crossings (including armed)
    // only advance state and highlight — never a second buzz.
    const { level, tick } = swipeTickLevel(tickLevel, Math.abs(raw));
    tickLevel = level;
    armedSide = level >= 2 ? side : null;
    if (tick && !hapticSpent && navigator.vibrate) {
      hapticSpent = true;
      navigator.vibrate(8);
    }

    pushSample(current);
    dx = swipeTranslate(raw);
  }

  function onPointerUp(e: PointerEvent) {
    if (phase !== 'dragging' || !start) return;
    const end: SwipeSample = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    const raw = rawDxAt(end.x);
    pushSample(end);
    const velocity = swipeVelocity(samples);
    const moved = swipeMoved(start, end);
    start = null;
    samples = [];
    phase = 'idle';

    if (!moved) {
      if (dx !== 0) closeTray(); // tap on an open card closes it instead of navigating
      return;
    }

    const release = swipeRelease(raw, Math.abs(velocity));
    if (release.kind === 'fire' && actionFor(release.side)) {
      void fire(release.side);
    } else if (release.kind === 'open' && actionFor(release.side)) {
      snapTo(release.side === 'left' ? -SWIPE_DEFAULTS.revealWidthPx : SWIPE_DEFAULTS.revealWidthPx);
    } else {
      snapTo(0);
    }
  }

  function onPointerCancel() {
    if (phase !== 'dragging') return;
    start = null;
    samples = [];
    phase = 'idle';
    if (Math.abs(dx) >= SWIPE_DEFAULTS.openThresholdPx) snapTo(dx < 0 ? -SWIPE_DEFAULTS.revealWidthPx : SWIPE_DEFAULTS.revealWidthPx);
    else snapTo(0);
  }

  /** Animate the surface to a resting offset and update the open-card claim. */
  function snapTo(target: number) {
    dx = target;
    activeSide = armedSide = null;
    if (target !== 0) claimOpen(closeTray);
    else releaseOpen(closeTray);
  }

  function closeTray() {
    if (phase === 'exiting' || phase === 'done') return;
    phase = 'idle';
    snapTo(0);
  }

  /** Play the exit animation, run the action, and collapse the card — or spring back on failure. */
  async function fire(side: SwipeSide) {
    const action = actionFor(side);
    if (!action || phase === 'exiting' || phase === 'done') return;
    releaseOpen(closeTray);
    phase = 'exiting';
    suppressClick = true;

    const width = cellEl?.offsetWidth ?? 320;
    dx = (side === 'left' ? -1 : 1) * (width + 24);

    const ok = await action
      .onAction()
      .catch(() => false)
      .then((result) => result === true);

    if (!ok) {
      dx = 0;
      phase = 'idle';
      suppressClick = false;
      return;
    }

    const cell = cellEl;
    if (cell && typeof cell.animate === 'function') {
      cell.style.overflow = 'hidden';
      const collapse = cell.animate([{ height: `${cell.offsetHeight}px` }, { height: '0px' }], {
        duration: 180,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        fill: 'forwards',
      });
      await collapse.finished.catch(() => {});
    }
    phase = 'done';
    suppressClick = false;
  }

  // Click interception: drags must not navigate, an open card's body tap must
  // only close the tray, and an exiting card must not react at all.
  function onClickCapture(e: MouseEvent) {
    if (phase !== 'idle' || suppressClick) {
      e.stopPropagation();
      e.preventDefault();
      suppressClick = false;
      return;
    }
    if (dx !== 0) {
      closeTray();
      e.stopPropagation();
      e.preventDefault();
    }
  }

  onDestroy(() => releaseOpen(closeTray));
</script>

{#snippet cell()}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div bind:this={cellEl} class="relative" out:slide={{ duration: 150 }}>
    {#if actionLeft}
      <div
        class="absolute inset-y-0 right-0 flex w-[80px] items-stretch justify-center rounded-r-xl {armedSide === 'left'
          ? 'bg-red-700 dark:bg-red-600'
          : 'bg-red-600 dark:bg-red-500'}"
        aria-hidden={!isOpen}
      >
        <button class="flex flex-col items-center justify-center gap-1 text-white" tabindex={isOpen ? 0 : -1} onclick={() => void fire('left')}>
          {#if actionLeft.icon}
            {@const LeftIcon = actionLeft.icon}
            <LeftIcon class="size-5" />
          {/if}
          <span class="text-[11px] font-medium">{actionLeft.label}</span>
        </button>
      </div>
    {/if}
    {#if actionRight}
      <div
        class="absolute inset-y-0 left-0 flex w-[80px] items-stretch justify-center rounded-l-xl {armedSide === 'right'
          ? 'bg-emerald-700 dark:bg-emerald-600'
          : 'bg-emerald-600 dark:bg-emerald-500'}"
        aria-hidden={!isOpen}
      >
        <button class="flex flex-col items-center justify-center gap-1 text-white" tabindex={isOpen ? 0 : -1} onclick={() => void fire('right')}>
          {#if actionRight.icon}
            {@const RightIcon = actionRight.icon}
            <RightIcon class="size-5" />
          {/if}
          <span class="text-[11px] font-medium">{actionRight.label}</span>
        </button>
      </div>
    {/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={surfaceEl}
      class="relative touch-pan-y {phase === 'dragging' ? 'select-none' : ''}"
      style:transform={`translateX(${dx}px)`}
      style:transition
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerCancel}
      onclickcapture={onClickCapture}
    >
      {@render children()}
    </div>
  </div>
{/snippet}

{#if actionLeft || actionRight}
  <ContextMenu.Root>
    <ContextMenu.Trigger class="block">
      {@render cell()}
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content class="bg-popover text-popover-foreground ring-foreground/10 z-50 min-w-36 overflow-hidden rounded-lg p-1 shadow-md ring-1">
        {#if actionLeft}
          <ContextMenu.Item
            class="focus:bg-destructive/10 dark:focus:bg-destructive/20 text-destructive flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none max-md:min-h-11 max-md:px-3"
            onSelect={() => void fire('left')}
          >
            {#if actionLeft.icon}
              {@const LeftIcon = actionLeft.icon}
              <LeftIcon class="size-4" />
            {/if}
            {actionLeft.label}
          </ContextMenu.Item>
        {/if}
        {#if actionRight}
          <ContextMenu.Item
            class="focus:bg-accent focus:text-accent-foreground flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none max-md:min-h-11 max-md:px-3"
            onSelect={() => void fire('right')}
          >
            {#if actionRight.icon}
              {@const RightIcon = actionRight.icon}
              <RightIcon class="size-4" />
            {/if}
            {actionRight.label}
          </ContextMenu.Item>
        {/if}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>
{:else}
  {@render cell()}
{/if}
