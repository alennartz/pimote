<script lang="ts">
  /**
   * Bounds a block of text and offers a "Show more" affordance. Owns the
   * collapse state machine and its heights; the caller supplies the content as
   * a snippet and decides what counts as too tall.
   *
   * A collapsed block keeps its height and hides overflow. An expanded block
   * grows to `expandedHeight` (viewport-relative by default), so clicking
   * always buys visible space instead of swapping one scrollbar for another.
   *
   * Callers tune appearance through inherited custom properties:
   *   --collapsible-fade         gradient color for the collapsed fade
   *   --collapsible-fade-height  height of that fade
   *   --collapsible-toggle-color toggle text color
   *   --collapsible-toggle-hover toggle hover color
   */
  import type { Snippet } from 'svelte';
  import { observeFullyOffscreen } from '$lib/auto-collapse.js';

  let {
    body,
    collapsedHeight,
    expandedHeight = 'min(70dvh, 40rem)',
    needsCollapse = false,
    detectOverflow = false,
    alwaysCapped = false,
    expanded = $bindable(false),
    bodyEl = $bindable(),
    autoExpand = false,
    autoCollapseOffscreen = false,
    fade = false,
    lineCount,
  }: {
    /** Content to bound. */
    body: Snippet;
    /** CSS height of the collapsed block. A plain px value is also the
     *  measurement threshold for `detectOverflow`. */
    collapsedHeight: string;
    /** CSS height of the expanded block. */
    expandedHeight?: string;
    /** The caller already knows the content is too tall. */
    needsCollapse?: boolean;
    /** Measure the body against `collapsedHeight` to find content that wraps
     *  past it without extra lines. Ignored for non-px heights. */
    detectOverflow?: boolean;
    /** Hold the collapsed height even with nothing to expand into, e.g. live
     *  output a caller never wants to grow unbounded. */
    alwaysCapped?: boolean;
    expanded?: boolean;
    /** The scroll container, for callers that pin or observe its scroll. */
    bodyEl?: HTMLElement | undefined;
    /** Keep expanded while true (e.g. while content streams in). */
    autoExpand?: boolean;
    /** Collapse the first time the block fully scrolls out of view. */
    autoCollapseOffscreen?: boolean;
    /** Fade the bottom edge of the collapsed block. */
    fade?: boolean;
    /** Shown in the toggle label when given. */
    lineCount?: number;
  } = $props();

  let rootEl: HTMLElement | undefined = $state();
  let overflowing = $state(false);

  let collapses = $derived(needsCollapse || overflowing);

  let collapseState: 'open' | 'clamped' | 'capped' | 'expanded' = $derived.by(() => {
    if (collapses) return expanded ? 'expanded' : 'clamped';
    return alwaysCapped ? 'capped' : 'open';
  });

  $effect(() => {
    if (autoExpand) expanded = true;
  });

  $effect(() => {
    if (!autoCollapseOffscreen || !expanded || !rootEl) return;
    return observeFullyOffscreen(rootEl, () => (expanded = false));
  });

  // Measure against the collapsed height without applying it, so content that
  // wraps past the bound earns a toggle even when its line count looks short.
  $effect(() => {
    const el = bodyEl;
    const limit = detectOverflow && el ? Number.parseFloat(collapsedHeight) : Number.NaN;
    if (!el || !Number.isFinite(limit)) {
      overflowing = false;
      return;
    }

    const update = () => (overflowing = el.scrollHeight > limit);
    update();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  });
</script>

<div class="collapsible" bind:this={rootEl} style:--collapsible-collapsed={collapsedHeight} style:--collapsible-expanded={expandedHeight}>
  <div class="collapsible-body" data-state={collapseState} bind:this={bodyEl}>
    {@render body()}
    {#if fade && collapseState === 'clamped'}
      <div class="collapsible-fade" aria-hidden="true"></div>
    {/if}
  </div>
  {#if collapses}
    <button type="button" class="collapsible-toggle" aria-expanded={collapseState === 'expanded'} onclick={() => (expanded = !expanded)}>
      {#if collapseState === 'expanded'}
        Show less
      {:else if lineCount === undefined}
        Show more…
      {:else}
        Show more… ({lineCount} lines)
      {/if}
    </button>
  {/if}
</div>

<style>
  .collapsible {
    min-width: 0;
  }

  .collapsible-body {
    position: relative;
    min-width: 0;
  }

  .collapsible-body[data-state='clamped'] {
    max-height: var(--collapsible-collapsed);
    overflow: hidden;
  }

  .collapsible-body[data-state='capped'] {
    max-height: var(--collapsible-collapsed);
    overflow-y: auto;
  }

  .collapsible-body[data-state='expanded'] {
    max-height: var(--collapsible-expanded);
    overflow-y: auto;
  }

  .collapsible-fade {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: var(--collapsible-fade-height, 32px);
    pointer-events: none;
    background: linear-gradient(to bottom, transparent, var(--collapsible-fade));
  }

  .collapsible-toggle {
    display: inline-block;
    margin-top: 4px;
    padding: 0;
    background: none;
    border: none;
    color: var(--collapsible-toggle-color, var(--muted-foreground));
    font-size: 0.75rem;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
    opacity: 0.8;
  }

  .collapsible-toggle:hover {
    opacity: 1;
    color: var(--collapsible-toggle-hover, var(--foreground));
  }
</style>
