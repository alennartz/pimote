<script lang="ts">
  import type { PimoteImageContent } from '@pimote/shared';
  import { SvelteMap } from 'svelte/reactivity';
  import { imageToDataUrl } from '$lib/image-content.js';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import X from '@lucide/svelte/icons/x';
  import ZoomIn from '@lucide/svelte/icons/zoom-in';
  import ZoomOut from '@lucide/svelte/icons/zoom-out';

  type PointerPoint = { x: number; y: number };
  type Gesture =
    | { kind: 'pan'; pointerId: number; startX: number; startY: number; startOffsetX: number; startOffsetY: number }
    | {
        kind: 'pinch';
        pointerIds: [number, number];
        startDistance: number;
        startScale: number;
        startOffsetX: number;
        startOffsetY: number;
        startMidpointX: number;
        startMidpointY: number;
      };

  const MAX_ZOOM = 8;
  const ZOOM_STEP = 1.25;

  let { image, alt = 'Image' }: { image: PimoteImageContent; alt?: string } = $props();
  let viewerOpen = $state(false);
  let viewerScale = $state(1);
  let offsetX = $state(0);
  let offsetY = $state(0);
  let previewButtonEl: HTMLButtonElement | undefined = $state();
  let dialogEl: HTMLDivElement | undefined = $state();
  let canvasEl: HTMLDivElement | undefined = $state();
  let viewerImageEl: HTMLImageElement | undefined = $state();
  let previousFocus: HTMLElement | null = null;
  let src = $derived(imageToDataUrl(image));
  let zoomLabel = $derived(`${Math.round(viewerScale * 100)}%`);
  let imageTransform = $derived(`translate3d(${offsetX}px, ${offsetY}px, 0) scale(${viewerScale})`);
  const pointers = new SvelteMap<number, PointerPoint>();
  let gesture: Gesture | undefined;

  $effect(() => {
    if (!viewerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    queueMicrotask(() => dialogEl?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
      previousFocus = null;
    };
  });

  function resetView(): void {
    viewerScale = 1;
    offsetX = 0;
    offsetY = 0;
    pointers.clear();
    gesture = undefined;
  }

  function openViewer(): void {
    const activeElement = document.activeElement;
    previousFocus = activeElement instanceof HTMLElement && activeElement !== document.body ? activeElement : (previewButtonEl ?? null);
    resetView();
    viewerOpen = true;
  }

  function closeViewer(): void {
    viewerOpen = false;
    resetView();
    queueMicrotask(() => previewButtonEl?.focus());
  }

  function handleViewerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeViewer();
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomIn();
      return;
    }
    if (event.key === '-') {
      event.preventDefault();
      zoomOut();
      return;
    }
    if (event.key === '0') {
      event.preventDefault();
      resetView();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const deltaX = event.key === 'ArrowLeft' ? -36 : event.key === 'ArrowRight' ? 36 : 0;
      const deltaY = event.key === 'ArrowUp' ? -36 : event.key === 'ArrowDown' ? 36 : 0;
      setView(viewerScale, offsetX + deltaX, offsetY + deltaY);
      return;
    }
    if (event.key !== 'Tab' || !dialogEl) return;

    const focusable = Array.from(dialogEl.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialogEl.focus();
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogEl)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function clampScale(scale: number): number {
    return Math.min(MAX_ZOOM, Math.max(1, scale));
  }

  function constrainOffset(x: number, y: number, scale: number): PointerPoint {
    const canvasWidth = canvasEl?.clientWidth ?? 0;
    const canvasHeight = canvasEl?.clientHeight ?? 0;
    const imageWidth = viewerImageEl?.clientWidth ?? 0;
    const imageHeight = viewerImageEl?.clientHeight ?? 0;
    const maxX = Math.max(0, (imageWidth * scale - canvasWidth) / 2);
    const maxY = Math.max(0, (imageHeight * scale - canvasHeight) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  }

  function setView(scale: number, x: number, y: number): void {
    viewerScale = clampScale(scale);
    const offset = constrainOffset(x, y, viewerScale);
    offsetX = offset.x;
    offsetY = offset.y;
  }

  function zoomIn(): void {
    setView(viewerScale * ZOOM_STEP, offsetX, offsetY);
  }

  function zoomOut(): void {
    setView(viewerScale / ZOOM_STEP, offsetX, offsetY);
  }

  function handlePointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    startGesture();
  }

  function startGesture(): void {
    const active = [...pointers.entries()];
    if (active.length >= 2) {
      const [first, second] = active;
      gesture = {
        kind: 'pinch',
        pointerIds: [first[0], second[0]],
        startDistance: Math.max(1, distance(first[1], second[1])),
        startScale: viewerScale,
        startOffsetX: offsetX,
        startOffsetY: offsetY,
        startMidpointX: (first[1].x + second[1].x) / 2,
        startMidpointY: (first[1].y + second[1].y) / 2,
      };
    } else if (active.length === 1) {
      const [pointerId, point] = active[0];
      gesture = { kind: 'pan', pointerId, startX: point.x, startY: point.y, startOffsetX: offsetX, startOffsetY: offsetY };
    } else {
      gesture = undefined;
    }
  }

  function distance(first: PointerPoint, second: PointerPoint): number {
    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!gesture) return;

    if (gesture.kind === 'pan') {
      if (viewerScale <= 1) return;
      setView(viewerScale, gesture.startOffsetX + event.clientX - gesture.startX, gesture.startOffsetY + event.clientY - gesture.startY);
      return;
    }

    const first = pointers.get(gesture.pointerIds[0]);
    const second = pointers.get(gesture.pointerIds[1]);
    if (!first || !second) return;

    const nextScale = clampScale(gesture.startScale * (distance(first, second) / gesture.startDistance));
    const currentMidpointX = (first.x + second.x) / 2;
    const currentMidpointY = (first.y + second.y) / 2;
    const rect = canvasEl?.getBoundingClientRect();
    if (!rect) return;
    const startFocalX = gesture.startMidpointX - rect.left - rect.width / 2;
    const startFocalY = gesture.startMidpointY - rect.top - rect.height / 2;
    const currentFocalX = currentMidpointX - rect.left - rect.width / 2;
    const currentFocalY = currentMidpointY - rect.top - rect.height / 2;
    const ratio = nextScale / gesture.startScale;
    setView(nextScale, currentFocalX + (gesture.startOffsetX - startFocalX) * ratio, currentFocalY + (gesture.startOffsetY - startFocalY) * ratio);
  }

  function handlePointerEnd(event: PointerEvent): void {
    if (!pointers.delete(event.pointerId)) return;
    startGesture();
  }
</script>

<div class="image-preview-wrapper">
  <button bind:this={previewButtonEl} type="button" class="image-preview" aria-label="Open image full screen" aria-haspopup="dialog" onclick={openViewer}>
    <img {src} {alt} loading="lazy" decoding="async" />
  </button>
  {#if viewerOpen}
    <div
      bind:this={dialogEl}
      class="image-viewer-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      aria-describedby="image-viewer-help"
      tabindex="-1"
      onkeydown={handleViewerKeydown}
    >
      <p id="image-viewer-help" class="sr-only">Pinch or use the controls to zoom. Drag to move the image.</p>
      <div class="image-viewer">
        <div class="image-viewer-toolbar">
          <button type="button" class="image-viewer-action" aria-label="Zoom out" title="Zoom out" disabled={viewerScale <= 1} onclick={zoomOut}>
            <ZoomOut size={20} />
          </button>
          <span class="image-viewer-zoom" aria-live="polite">{zoomLabel}</span>
          <button type="button" class="image-viewer-action" aria-label="Reset zoom" title="Reset zoom" onclick={resetView}>
            <RotateCcw size={19} />
          </button>
          <button type="button" class="image-viewer-action" aria-label="Zoom in" title="Zoom in" disabled={viewerScale >= MAX_ZOOM} onclick={zoomIn}>
            <ZoomIn size={20} />
          </button>
          <button type="button" class="image-viewer-action image-viewer-close" aria-label="Close image viewer" title="Close image viewer" onclick={closeViewer}>
            <X size={22} />
          </button>
        </div>
        <div
          bind:this={canvasEl}
          class="image-viewer-canvas"
          role="group"
          aria-label="Image viewing area"
          onpointerdown={handlePointerDown}
          onpointermove={handlePointerMove}
          onpointerup={handlePointerEnd}
          onpointercancel={handlePointerEnd}
        >
          <img bind:this={viewerImageEl} class="image-viewer-image" style:transform={imageTransform} {src} {alt} draggable="false" />
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .image-preview-wrapper {
    max-width: 100%;
  }

  .image-preview {
    display: block;
    max-width: 100%;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-sunken);
    cursor: zoom-in;
  }

  .image-preview img {
    display: block;
    max-width: 100%;
    max-height: 300px;
    width: auto;
    object-fit: contain;
  }

  .image-viewer-overlay {
    position: fixed;
    z-index: 1000;
    inset: 0;
    width: 100vw;
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
    background: var(--surface-sunken, var(--background));
    color: var(--foreground);
    outline: none;
  }

  .image-viewer {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--surface-sunken, var(--background));
  }

  .image-viewer-toolbar {
    position: absolute;
    z-index: 1;
    top: 0;
    right: 0;
    left: 0;
    display: flex;
    min-height: 56px;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: max(8px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left));
    background: linear-gradient(to bottom, color-mix(in oklch, var(--background) 92%, transparent), transparent);
  }

  .image-viewer-action {
    display: inline-flex;
    width: 44px;
    height: 44px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-raised, var(--secondary));
    color: var(--foreground);
    cursor: pointer;
    touch-action: manipulation;
  }

  .image-viewer-action:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .image-viewer-close {
    margin-left: 4px;
  }

  .image-viewer-zoom {
    min-width: 3.5rem;
    color: var(--foreground);
    font-family: var(--font-mono, monospace);
    font-size: 0.8rem;
    text-align: center;
  }

  .image-viewer-canvas {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    padding: max(16px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
    cursor: grab;
    touch-action: none;
    user-select: none;
  }

  .image-viewer-canvas:active {
    cursor: grabbing;
  }

  .image-viewer-image {
    display: block;
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
    object-position: center;
    transform-origin: center;
    user-select: none;
    -webkit-user-drag: none;
  }
</style>
