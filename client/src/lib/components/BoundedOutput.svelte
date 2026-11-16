<script lang="ts">
  import { ansiToHtml } from '$lib/ansi-to-html.js';

  let {
    text,
    streaming = false,
    maxCollapsedLines = 10,
    accent = 'default',
    bounded = false,
    renderAnsi = false,
  }: {
    text: string;
    streaming?: boolean;
    maxCollapsedLines?: number;
    accent?: 'default' | 'purple';
    /** Keep the view bounded, including below the line cutoff. */
    bounded?: boolean;
    /** Render ANSI color codes and escape the input text. */
    renderAnsi?: boolean;
  } = $props();

  // Auto-expand while streaming so users can follow live output. Bounded
  // callers keep the same height limit after streaming ends.
  let expanded = $derived(streaming);
  let contentEl: HTMLPreElement | undefined = $state();

  let lines = $derived(text.split('\n'));
  // Counted without materializing the line array: output deltas arrive many
  // times per second and the buffer can reach the live-output cap.
  let lineCount = $derived.by(() => {
    // The content auto-expands while streaming, so its collapse count is not
    // observable until it settles. Avoid rescanning the growing buffer per
    // delta; count once on the settled value.
    if (streaming) return 0;
    let count = 1;
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count += 1;
    return count;
  });
  let visualOverflow = $state(false);
  let needsCollapse = $derived(!streaming && (lineCount > maxCollapsedLines || visualOverflow));
  let clamped = $derived(needsCollapse && !expanded);
  let scrollable = $derived(!clamped && (bounded || (expanded && needsCollapse)));
  let displayText = $derived(needsCollapse && !expanded ? lines.slice(0, maxCollapsedLines).join('\n') : text);

  // Live deltas must not re-convert and re-replace the whole output per
  // arrival — conversion cost over the full buffer is quadratic across a
  // stream and every innerHTML write discards the rendered text nodes.
  // While streaming, the view renders the latest value on a trailing timer;
  // once streaming ends it renders the final value exactly. `null` falls
  // through to `displayText`, which keeps the first paint synchronous.
  const RENDER_INTERVAL_MS = 100;
  let rendered: string | null = $state(null);
  let pendingRender: string | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const next = displayText;
    if (!streaming) {
      if (renderTimer !== null) {
        clearTimeout(renderTimer);
        renderTimer = null;
        pendingRender = null;
      }
      rendered = next;
      return;
    }
    if (next === rendered && pendingRender === null) return;
    pendingRender = next;
    if (renderTimer === null) {
      renderTimer = setTimeout(() => {
        renderTimer = null;
        if (pendingRender !== null) {
          rendered = pendingRender;
          pendingRender = null;
        }
      }, RENDER_INTERVAL_MS);
    }
  });

  $effect(() => () => {
    if (renderTimer !== null) clearTimeout(renderTimer);
  });

  // A long unbroken line can exceed the visual height without increasing the
  // logical line count. Measure bounded results so they get the same collapse
  // affordance as multiline output.
  $effect(() => {
    const el = contentEl;
    if (!bounded || !el) {
      visualOverflow = false;
      return;
    }

    // Re-measure when rendered content or expansion changes. Svelte runs
    // effects after the DOM update, so scrollHeight reflects what is shown.
    void rendered;
    void expanded;
    void clamped;
    const updateOverflow = () => {
      visualOverflow = el.scrollHeight > el.clientHeight;
    };
    updateOverflow();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  });

  // Auto-scroll to bottom while streaming and expanded
  $effect(() => {
    if (streaming && expanded && contentEl) {
      // Track rendered content so the scroll follows the throttle cadence.
      void rendered;
      contentEl.scrollTop = contentEl.scrollHeight;
    }
  });
</script>

<div class="bounded-output" class:accent-purple={accent === 'purple'}>
  <!-- ansiToHtml escapes input text before creating fixed style spans. -->
  <!-- eslint-disable svelte/no-at-html-tags -->
  <pre class="bounded-output-text" class:clamped class:scrollable bind:this={contentEl}>{#if renderAnsi}{@html ansiToHtml(rendered ?? displayText)}{:else}{rendered ??
        displayText}{/if}</pre>
  <!-- eslint-enable svelte/no-at-html-tags -->
  {#if needsCollapse}
    <button class="bounded-output-toggle" onclick={() => (expanded = !expanded)}>
      {expanded ? 'Show less' : `Show more… (${lineCount} lines)`}
    </button>
  {/if}
</div>

<style>
  .bounded-output {
    /* default accent color */
    --_accent: var(--muted-foreground);
  }

  .bounded-output.accent-purple {
    --_accent: var(--custom-accent);
  }

  .bounded-output-text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--foreground);
    font-family: var(--font-mono);
    font-variant-ligatures: none;
  }

  .bounded-output-text.clamped {
    max-height: 160px;
    overflow: hidden;
  }

  .bounded-output-text.scrollable {
    max-height: 160px;
    overflow-y: auto;
  }

  .bounded-output-toggle {
    display: inline-block;
    margin-top: 4px;
    padding: 0;
    background: none;
    border: none;
    color: var(--_accent);
    font-size: 0.75rem;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
    opacity: 0.8;
  }

  .bounded-output-toggle:hover {
    opacity: 1;
    color: var(--foreground);
  }
</style>
