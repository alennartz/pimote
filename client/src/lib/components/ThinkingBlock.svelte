<script lang="ts">
  import { onDestroy } from 'svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import BrainCircuit from '@lucide/svelte/icons/brain-circuit';
  import { observeFullyOffscreen } from '$lib/auto-collapse.js';
  import { countThinkingWords, createThinkingWordCounter, previewThinkingText, shouldRenderThinkingBlock } from '$lib/thinking-content.js';

  let { text, streaming = false }: { text: string; streaming?: boolean } = $props();

  // $state instead of $derived so manual toggle during streaming isn't snapped back
  let expanded = $state(false);
  let rootEl: HTMLDivElement | undefined = $state();
  let contentEl: HTMLPreElement | undefined = $state();
  let renderedTextNode: Text | null = null;
  let renderedTextLength = 0;
  let contentScrollFrame: number | null = null;
  const updateWordCount = createThinkingWordCounter();
  let wordCount = $derived(0);

  // Auto-expand while streaming.
  $effect(() => {
    if (streaming) {
      expanded = true;
    }
  });

  // Once streaming ends, keep the block expanded and collapse it the first time
  // it fully scrolls out of view, rather than snapping shut immediately.
  $effect(() => {
    if (streaming) return;
    if (!expanded) return;
    if (!rootEl) return;
    return observeFullyOffscreen(rootEl, () => {
      expanded = false;
    });
  });

  // Append streamed deltas to one text node instead of replacing the full
  // cumulative reasoning string on every update.
  $effect(() => {
    const el = contentEl;
    const nextText = text;
    if (!el) return;

    if (!renderedTextNode || renderedTextNode.parentNode !== el) {
      renderedTextNode = document.createTextNode(nextText);
      el.appendChild(renderedTextNode);
      renderedTextLength = nextText.length;
    } else if (nextText.length <= renderedTextLength) {
      renderedTextNode.data = nextText;
      renderedTextLength = nextText.length;
    } else {
      renderedTextNode.appendData(nextText.slice(renderedTextLength));
      renderedTextLength = nextText.length;
    }
  });

  function scheduleContentScroll(): void {
    if (!contentEl || contentScrollFrame !== null) return;
    const target = contentEl;
    contentScrollFrame = requestAnimationFrame(() => {
      contentScrollFrame = null;
      if (streaming && contentEl === target) target.scrollTop = target.scrollHeight;
    });
  }

  $effect(() => {
    if (streaming && text && contentEl) scheduleContentScroll();
  });

  onDestroy(() => {
    if (contentScrollFrame !== null) cancelAnimationFrame(contentScrollFrame);
    contentScrollFrame = null;
    renderedTextNode = null;
    renderedTextLength = 0;
  });

  let previewWords = $derived(previewThinkingText(text));

  // Count only the appended suffix during streaming, then reconcile once against
  // the finalized text in case the provider normalized its terminal message.
  $effect(() => {
    wordCount = streaming ? updateWordCount(text) : countThinkingWords(text);
  });

  let shouldRender = $derived(shouldRenderThinkingBlock(text, streaming));
</script>

{#if shouldRender}
  <div class="thinking-block" bind:this={rootEl}>
    <button class="thinking-header" onclick={() => (expanded = !expanded)}>
      <ChevronRight class="shrink-0 transition-transform duration-150 {expanded ? 'rotate-90' : ''}" size={14} />
      <BrainCircuit size={14} class="shrink-0" />
      <span class="thinking-label">
        {streaming ? 'Thinking…' : 'Thought process'}
      </span>
      {#if previewWords}
        <span class="thinking-preview">{previewWords}</span>
      {/if}
      {#if wordCount > 0}
        <span class="thinking-word-count">{wordCount.toLocaleString()} words</span>
      {/if}
      {#if streaming}
        <span class="streaming-dot"></span>
      {/if}
    </button>

    {#if expanded}
      <div class="thinking-content">
        <pre class="thinking-text" bind:this={contentEl}></pre>
      </div>
    {/if}
  </div>
{/if}

<style>
  .thinking-block {
    margin: 0.25em 0;
    border-radius: 6px;
    border: 1px solid var(--border);
    overflow: hidden;
  }

  .thinking-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    background: var(--surface-raised);
    color: var(--muted-foreground);
    font-size: 0.8rem;
    cursor: pointer;
    border: none;
    text-align: left;
    transition: background-color 0.15s;
  }

  .thinking-header:hover {
    background: var(--surface-hover);
  }

  .thinking-label {
    flex-shrink: 0;
    font-style: italic;
  }

  .thinking-preview {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75rem;
    color: var(--muted-foreground);
    opacity: 0.6;
  }

  .thinking-word-count {
    flex-shrink: 0;
    margin-left: auto;
    font-size: 0.75rem;
    opacity: 0.7;
  }

  .streaming-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--status-streaming);
    animation: blink 1s ease-in-out infinite;
  }

  @keyframes blink {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }

  .thinking-content {
    padding: 8px 12px;
    background: var(--surface-sunken);
    border-top: 1px solid var(--border);
    max-height: 300px;
    overflow-y: auto;
  }

  .thinking-text {
    margin: 0;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--muted-foreground);
    font-family: var(--font-mono);
    font-variant-ligatures: none;
  }
</style>
