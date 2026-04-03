<script lang="ts">
  import type { Snippet } from 'svelte';

  const MAX_DISTANCE = 72;
  const SNAP_THRESHOLD = 0.4; // fraction of max distance
  const VELOCITY_THRESHOLD = 0.3; // px/ms

  let {
    action,
    children,
    onclose,
  }: {
    action: Snippet;
    children: Snippet;
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
  let contentEl: HTMLDivElement | undefined = $state();

  export function close() {
    if (!open && translateX === 0) return;
    snapTo(0);
    open = false;
    onclose?.();
  }

  function snapTo(target: number) {
    animating = true;
    translateX = target;
    open = target !== 0;
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
      if (Math.abs(dx) > 10) {
        directionLocked = 'horizontal';
      } else if (Math.abs(dy) > 10) {
        directionLocked = 'vertical';
        return;
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
    bind:this={contentEl}
    ontouchstart={handleTouchStart}
    ontouchmove={handleTouchMove}
    ontouchend={handleTouchEnd}
    ontransitionend={handleTransitionEnd}
    style="transform: translateX(-{translateX}px);{animating ? ' transition: transform 200ms ease-out;' : ''}"
  >
    {@render children()}
  </div>
</div>

<style>
  .swipe-container {
    position: relative;
    overflow: hidden;
  }

  .swipe-actions {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 72px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .swipe-content {
    position: relative;
    will-change: transform;
  }
</style>
