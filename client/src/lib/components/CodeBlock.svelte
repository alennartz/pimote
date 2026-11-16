<script lang="ts">
  /**
   * Renders source content inside collapsible, copyable chrome, in one of
   * two modes. ToolCall uses it for write files, codemode scripts, and bash
   * commands.
   *
   *   - `code`     — syntax-highlighted `<pre><code>` via `code-highlight.ts`
   *                  (throttled while `streaming`, flushed when it ends).
   *   - `markdown` — rendered through `TextBlock` (which inherits incremental
   *                  fenced-code highlighting for free).
   *
   * Owns the copy chrome and the auto-expand-while-streaming behavior for both
   * modes. Instead of re-clamping the moment streaming ends, a settled block
   * stays expanded until it first fully scrolls out of view. In both modes, the
   * copy button copies `content` verbatim (raw source, never rendered text),
   * and `CollapsibleText` bounds long content.
   */
  import { createIncrementalHighlighter } from '$lib/code-highlight.js';
  import CollapsibleText from './CollapsibleText.svelte';
  import TextBlock from './TextBlock.svelte';
  import Copy from '@lucide/svelte/icons/copy';
  import Check from '@lucide/svelte/icons/check';
  import '$lib/highlight-theme.css';

  let {
    content,
    mode,
    language,
    streaming = false,
    copyLabel = 'Copy contents',
  }: {
    /** Source content (streaming or finalized). */
    content: string;
    /** Render strategy. */
    mode: 'code' | 'markdown';
    /** hljs language id used in 'code' mode. */
    language: string | null;
    /** Drives throttled highlight + auto-scroll while true. */
    streaming?: boolean;
    /** Accessible name and tooltip for the copy button. */
    copyLabel?: string;
  } = $props();

  const MAX_COLLAPSED_LINES = 20;

  let codeEl: HTMLElement | undefined = $state();
  let bodyEl: HTMLElement | undefined = $state();

  let lineCount = $derived(content.split('\n').length);
  let needsCollapse = $derived(lineCount > MAX_COLLAPSED_LINES);

  // Code mode: drive the <code> element via the throttled highlighter.
  const highlighter = createIncrementalHighlighter();
  $effect(() => () => highlighter.dispose());

  $effect(() => {
    if (mode !== 'code') return;
    const el = codeEl;
    if (!el) return;
    el.classList.add('hljs');
    // Track reactive deps explicitly.
    const text = content;
    const lang = language;
    if (streaming) {
      highlighter.schedule(el, text, lang);
    } else {
      // Final synchronous render.
      highlighter.schedule(el, text, lang);
      highlighter.flush();
    }
  });

  // Auto-scroll the body to the bottom while streaming. Reacting to `content`
  // is not enough: in code mode the DOM update is deferred by the throttled
  // highlighter, so we'd scroll against a stale height. Observe the rendered
  // content's actual size instead and pin to the bottom whenever it grows.
  $effect(() => {
    if (!streaming || !bodyEl) return;
    if (typeof ResizeObserver === 'undefined') return;
    const body = bodyEl;
    const target = body.firstElementChild ?? body;
    const observer = new ResizeObserver(() => {
      body.scrollTop = body.scrollHeight;
    });
    observer.observe(target);
    body.scrollTop = body.scrollHeight;
    return () => observer.disconnect();
  });

  let copied = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => {
    if (resetTimer) clearTimeout(resetTimer);
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      copied = true;
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => (copied = false), 1200);
    } catch {
      // Clipboard unavailable — leave button as-is.
    }
  }
</script>

<div class="code-block" data-mode={mode}>
  <button type="button" class="copy-button code-copy-btn" class:copied aria-label={copied ? 'Copied' : copyLabel} title={copyLabel} onclick={copy}>
    {#if copied}
      <Check size={14} />
    {:else}
      <Copy size={14} />
    {/if}
  </button>

  <CollapsibleText bind:bodyEl {needsCollapse} {lineCount} collapsedHeight="calc(20 * 1.5 * 0.875em + 24px)" autoExpand={streaming} autoCollapseOffscreen>
    {#snippet body()}
      {#if mode === 'code'}
        <pre class="code-block-body code-block-code"><code class="hljs" bind:this={codeEl}></code></pre>
      {:else}
        <div class="code-block-body code-block-markdown">
          <TextBlock text={content} {streaming} />
        </div>
      {/if}
    {/snippet}
  </CollapsibleText>
</div>

<style>
  .code-block {
    position: relative;
  }

  .code-block :global(.collapsible-body) {
    border-radius: 0;
    background: var(--surface-sunken);
  }

  .code-block-body {
    margin: 0;
    padding: 12px;
    padding-right: 56px;
  }

  .code-block-code {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    white-space: pre;
  }

  .code-block-code code {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: 0.875em;
    font-family: var(--font-mono);
    font-variant-ligatures: none;
    line-height: 1.5;
    display: block;
    white-space: pre;
  }

  .code-copy-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 1;
  }
</style>
