<script lang="ts">
  let {
    text,
    streaming = false,
    maxCollapsedLines = 10,
    accent = 'default',
  }: {
    text: string;
    streaming?: boolean;
    maxCollapsedLines?: number;
    accent?: 'default' | 'purple';
  } = $props();

  let expanded = $state(false);
  let contentEl: HTMLPreElement | undefined = $state();

  let lines = $derived(text.split('\n'));
  let lineCount = $derived(lines.length);
  let needsCollapse = $derived(lineCount > maxCollapsedLines);
  let displayText = $derived(needsCollapse && !expanded ? lines.slice(0, maxCollapsedLines).join('\n') : text);

  // Auto-scroll to bottom while streaming and expanded
  $effect(() => {
    if (streaming && expanded && contentEl) {
      // Track text to re-run on changes
      void text;
      contentEl.scrollTop = contentEl.scrollHeight;
    }
  });
</script>

<div class="streaming-collapsible" class:accent-purple={accent === 'purple'}>
  <pre class="collapsible-text" class:scrollable={expanded && needsCollapse} bind:this={contentEl}>{displayText}</pre>
  {#if needsCollapse}
    <button class="collapsible-toggle" onclick={() => (expanded = !expanded)}>
      {expanded ? 'Show less' : `Show more… (${lineCount} lines)`}
    </button>
  {/if}
</div>

<style>
  .streaming-collapsible {
    /* default accent color */
    --_accent: var(--muted-foreground);
  }

  .streaming-collapsible.accent-purple {
    --_accent: oklch(0.55 0.1 280);
  }

  .collapsible-text {
    margin: 0;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--foreground);
    font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  }

  .collapsible-text.scrollable {
    max-height: 400px;
    overflow-y: auto;
  }

  .collapsible-toggle {
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

  .collapsible-toggle:hover {
    opacity: 1;
    color: var(--foreground);
  }
</style>
