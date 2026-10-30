<script lang="ts">
  let {
    text,
    streaming = false,
    maxCollapsedLines = 10,
    accent = 'default',
    bounded = false,
  }: {
    text: string;
    streaming?: boolean;
    maxCollapsedLines?: number;
    accent?: 'default' | 'purple';
    /** Keep the view bounded, including below the line cutoff. */
    bounded?: boolean;
  } = $props();

  // Auto-expand while streaming so users can follow live output. Bounded
  // callers keep the same height limit after streaming ends.
  let expanded = $derived(streaming);
  let contentEl: HTMLPreElement | undefined = $state();

  let lines = $derived(text.split('\n'));
  let lineCount = $derived(lines.length);
  let visualOverflow = $state(false);
  let needsCollapse = $derived(lineCount > maxCollapsedLines || visualOverflow);
  let clamped = $derived(needsCollapse && !expanded);
  let scrollable = $derived(!clamped && (bounded || (expanded && needsCollapse)));
  let displayText = $derived(needsCollapse && !expanded ? lines.slice(0, maxCollapsedLines).join('\n') : text);

  // A long unbroken line can exceed the visual height without increasing the
  // logical line count. Measure bounded results so they get the same collapse
  // affordance as multiline output.
  $effect(() => {
    const el = contentEl;
    if (!bounded || !el) {
      visualOverflow = false;
      return;
    }

    // Re-measure when text or expansion changes. Svelte runs effects after the
    // DOM update, so scrollHeight reflects the current rendered content.
    void text;
    void expanded;
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
      // Track text to re-run on changes
      void text;
      contentEl.scrollTop = contentEl.scrollHeight;
    }
  });
</script>

<div class="bounded-output" class:accent-purple={accent === 'purple'}>
  <pre class="bounded-output-text" class:clamped class:scrollable bind:this={contentEl}>{displayText}</pre>
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
