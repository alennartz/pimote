<script lang="ts">
  import { untrack } from 'svelte';
  import { renderMarkdown } from '$lib/markdown.js';
  import '$lib/highlight-theme.css';

  let { text, streaming = false }: { text: string; streaming?: boolean } = $props();

  let renderedHtml = $derived(streaming ? '' : renderMarkdown(text));

  // Debounced streaming markdown state
  let streamingHtml = $state('');
  let renderedUpTo = $state(0);

  $effect(() => {
    if (!streaming) {
      // Reset streaming state when not streaming
      streamingHtml = '';
      renderedUpTo = 0;
      return;
    }

    // Immediate first render without tracking `text` (avoid re-running effect on every text change)
    untrack(() => {
      streamingHtml = renderMarkdown(text);
      renderedUpTo = text.length;
    });

    const interval = setInterval(() => {
      streamingHtml = renderMarkdown(text);
      renderedUpTo = text.length;
    }, 400);

    return () => {
      clearInterval(interval);
    };
  });
</script>

{#if streaming}
  <div class="text-block markdown-content">
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html streamingHtml}
  </div>
  {#if text.length > renderedUpTo}
    <pre class="text-block streaming-tail">{text.slice(renderedUpTo)}</pre>
  {/if}
{:else}
  <div class="text-block markdown-content">
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html renderedHtml}
  </div>
{/if}

<style>
  .text-block {
    line-height: 1.6;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .streaming-tail {
    white-space: pre-wrap;
    font-family: inherit;
    margin: 0;
    padding: 0;
  }

  /* Markdown content styles */
  .markdown-content :global(p) {
    margin: 0.5em 0;
  }

  .markdown-content :global(p:first-child) {
    margin-top: 0;
  }

  .markdown-content :global(p:last-child) {
    margin-bottom: 0;
  }

  .markdown-content :global(ul),
  .markdown-content :global(ol) {
    margin: 0.5em 0;
    padding-left: 1.5em;
  }

  .markdown-content :global(li) {
    margin: 0.25em 0;
  }

  .markdown-content :global(h1),
  .markdown-content :global(h2),
  .markdown-content :global(h3),
  .markdown-content :global(h4) {
    margin: 1em 0 0.5em;
    font-weight: 600;
  }

  .markdown-content :global(h1) {
    font-size: 1.25em;
  }

  .markdown-content :global(h2) {
    font-size: 1.15em;
  }

  .markdown-content :global(h3) {
    font-size: 1.05em;
  }

  .markdown-content :global(blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 1em;
    margin: 0.5em 0;
    color: var(--muted-foreground);
  }

  .markdown-content :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 1em 0;
  }

  .markdown-content :global(a) {
    color: oklch(0.7 0.15 250);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .markdown-content :global(a:hover) {
    color: oklch(0.8 0.15 250);
  }

  .markdown-content :global(.inline-code) {
    background: oklch(0.2 0.02 258);
    padding: 0.15em 0.4em;
    border-radius: 4px;
    font-size: 0.9em;
    font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  }

  /* Code blocks */
  .markdown-content :global(.code-block) {
    position: relative;
    margin: 0.75em 0;
    border-radius: 8px;
    overflow: hidden;
    background: oklch(0.16 0.03 258);
    border: 1px solid var(--border);
  }

  .markdown-content :global(.code-block .code-lang) {
    display: block;
    padding: 4px 12px;
    font-size: 0.75em;
    color: var(--muted-foreground);
    background: oklch(0.14 0.03 258);
    border-bottom: 1px solid var(--border);
    text-transform: lowercase;
  }

  .markdown-content :global(.code-block pre) {
    margin: 0;
    padding: 12px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .markdown-content :global(.code-block code) {
    font-size: 0.875em;
    font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
    line-height: 1.5;
  }

  /* Tables */
  .markdown-content :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 0.75em 0;
    font-size: 0.9em;
  }

  .markdown-content :global(th),
  .markdown-content :global(td) {
    padding: 6px 12px;
    border: 1px solid var(--border);
    text-align: left;
  }

  .markdown-content :global(th) {
    background: oklch(0.2 0.02 258);
    font-weight: 600;
  }

  .markdown-content :global(strong) {
    font-weight: 600;
  }

  .markdown-content :global(em) {
    font-style: italic;
  }
</style>
