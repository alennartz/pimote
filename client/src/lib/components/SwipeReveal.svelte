<script lang="ts">
  import type { Snippet } from 'svelte';

  const MAX_DISTANCE = 72;
  const SNAP_THRESHOLD = 0.4; // fraction of max distance
  const VELOCITY_THRESHOLD = 0.3; // px/ms

  let {
    action,
    children,
    onopen,
    onclose,
  }: {
    action: Snippet;
    children: Snippet;
    onopen?: () => void;
    onclose?: () => void;
  } = $props();

  let open = $state(false);
  let translateX = $state(0);
  let animating = $state(false);

  // Touch tracking
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let directionLocked: 'horizontal' | 'vertical' | null = null;
  export function close() {
    if (!open && translateX === 0) return;
    snapTo(0);
    open = false;
    onclose?.();
  }

  function snapTo(target: number) {
    animating = true;
    translateX = target;
    const wasOpen = open;
    open = target !== 0;
    if (open && !wasOpen) onopen?.();
  }

  function handleTouchStart(e: TouchEvent) {
    const touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    startTime = Date.now();
    directionLocked = null;
    animating = false;
  }

  function handleTouchMove(e: TouchEvent) {
    const touch = e.touches[0];
    const dx = startX - touch.clientX;
    const dy = touch.clientY - startY;

    if (!directionLocked) {
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const threshold = 15;
      if (absDx > threshold || absDy > threshold) {
        directionLocked = absDx > absDy * 1.5 ? 'horizontal' : 'vertical';
      } else {
        return;
      }
    }

    if (directionLocked !== 'horizontal') return;

    e.preventDefault();

    // If currently open, offset from the open position
    const base = open ? MAX_DISTANCE : 0;
    const raw = base + dx;
    translateX = Math.max(0, Math.min(MAX_DISTANCE, raw));
  }

  function handleTouchEnd(e: TouchEvent) {
    if (directionLocked !== 'horizontal') return;

    const touch = e.changedTouches[0];
    const dx = startX - touch.clientX;
    const elapsed = Date.now() - startTime;
    const velocity = Math.abs(dx) / elapsed;

    const wasOpen = open;

    if (wasOpen) {
      // Currently open — swipe right (dx < 0) to close
      if (dx < 0 && (velocity > VELOCITY_THRESHOLD || translateX < MAX_DISTANCE * (1 - SNAP_THRESHOLD))) {
        snapTo(0);
        onclose?.();
      } else {
        snapTo(MAX_DISTANCE);
      }
    } else {
      // Currently closed — swipe left (dx > 0) to open
      if (velocity > VELOCITY_THRESHOLD || translateX > MAX_DISTANCE * SNAP_THRESHOLD) {
        snapTo(MAX_DISTANCE);
      } else {
        snapTo(0);
      }
    }
  }

  function handleTransitionEnd() {
    animating = false;
  }
</script>

<div class="swipe-container">
  <div class="swipe-actions">
    {@render action()}
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="swipe-content"
    ontouchstart={handleTouchStart}
    ontouchmove={handleTouchMove}
    ontouchend={handleTouchEnd}
    ontouchcancel={handleTouchEnd}
    ontransitionend={handleTransitionEnd}
    style="transform: translateX(-{translateX}px);{animating ? ' transition: transform 200ms ease-out;' : ''}"
  >
    {@render children()}
  </div>
</div>

<style>
  .swipe-container {
    display: grid;
    overflow-x: clip;
  }

  .swipe-actions {
    grid-row: 1;
    grid-column: 1;
    justify-self: end;
    width: 72px;
    background: var(--secondary);
  }

  .swipe-content {
    grid-row: 1;
    grid-column: 1;
    z-index: 1;
    min-width: 0;
    overflow: hidden;
    background: var(--background);
    will-change: transform;
  }
</style>
