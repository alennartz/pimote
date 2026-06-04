<script lang="ts">
  /**
   * Renders a `write` tool's file body inside collapsible, copyable chrome, in
   * one of two modes:
   *
   *   - `code`     — syntax-highlighted `<pre><code>` via `code-highlight.ts`
   *                  (throttled while `streaming`, flushed when it ends).
   *   - `markdown` — rendered through `TextBlock` (which inherits incremental
   *                  fenced-code highlighting for free).
   *
   * Owns the collapse + copy chrome and the auto-expand-while-streaming /
   * auto-collapse-on-completion behavior for both modes. In both modes the
   * copy button copies `content` verbatim (raw source, never rendered text),
   * and a show-more/collapse wrapper bounds long files.
   */
  import { createIncrementalHighlighter } from '$lib/code-highlight.js';
  import TextBlock from './TextBlock.svelte';
  import '$lib/highlight-theme.css';

  let {
    content,
    mode,
    language,
    streaming = false,
  }: {
    /** File body (streaming or finalized). */
    content: string;
    /** Render strategy. */
    mode: 'code' | 'markdown';
    /** hljs language id used in 'code' mode. */
    language: string | null;
    /** Drives throttled highlight + auto-scroll while true. */
    streaming?: boolean;
  } = $props();

  const MAX_COLLAPSED_LINES = 20;

  let codeEl: HTMLElement | undefined = $state();
  let bodyEl: HTMLElement | undefined = $state();

  let lineCount = $derived(content.split('\n').length);
  let needsCollapse = $derived(lineCount > MAX_COLLAPSED_LINES);

  // Auto-expand while streaming, auto-collapse when it settles (ThinkingBlock /
  // ToolCall-edit pattern). Writable $derived: resets to `streaming` whenever it
  // changes, but stays put under manual toggles once streaming has stopped.
  let expanded = $derived(streaming);

  let clamped = $derived(needsCollapse && !expanded);
  let scrollable = $derived(needsCollapse && expanded);

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

  // Auto-scroll the code body to the bottom while streaming (StreamingCollapsible).
  $effect(() => {
    if (mode !== 'code' || !streaming || !scrollable || !bodyEl) return;
    void content;
    bodyEl.scrollTop = bodyEl.scrollHeight;
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

<div class="write-file-block" data-mode={mode}>
  <button type="button" class="code-copy-btn" class:copied aria-label="Copy file contents" title="Copy file contents" onclick={copy}>
    {copied ? 'Copied' : 'Copy'}
  </button>

  {#if mode === 'code'}
    <pre class="wfb-body wfb-code" class:clamped class:scrollable bind:this={bodyEl}><code class="hljs" bind:this={codeEl}></code></pre>
  {:else}
    <div class="wfb-body wfb-markdown" class:clamped class:scrollable bind:this={bodyEl}>
      <TextBlock text={content} {streaming} />
    </div>
  {/if}

  {#if needsCollapse}
    <button class="wfb-toggle" onclick={() => (expanded = !expanded)}>
      {expanded ? 'Show less' : `Show more… (${lineCount} lines)`}
    </button>
  {/if}
</div>

<style>
  .write-file-block {
    position: relative;
  }

  .wfb-body {
    margin: 0;
    border-radius: 8px;
    background: oklch(0.16 0.03 258);
    border: 1px solid var(--border);
    padding: 12px;
    padding-right: 56px;
  }

  .wfb-code {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    white-space: pre;
  }

  .wfb-code code {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: 0.875em;
    font-family: var(--font-mono);
    line-height: 1.5;
    display: block;
    white-space: pre;
  }

  .wfb-body.clamped {
    max-height: calc(20 * 1.5 * 0.875em + 24px);
    overflow: hidden;
  }

  .wfb-body.scrollable {
    max-height: 400px;
    overflow-y: auto;
  }

  /* The copy button mirrors the smd-renderer code copy button treatment. */
  .code-copy-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 1;
    padding: 3px 8px;
    font-size: 0.7rem;
    font-family: var(--font-mono, monospace);
    line-height: 1;
    color: var(--muted-foreground);
    background: oklch(0.22 0.03 258 / 0.85);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    opacity: 0.55;
    transition:
      opacity 0.15s,
      color 0.15s,
      background-color 0.15s;
  }

  .code-copy-btn:hover,
  .code-copy-btn:focus-visible,
  .code-copy-btn.copied {
    opacity: 1;
    color: var(--foreground);
    background: oklch(0.28 0.04 260);
  }

  .wfb-toggle {
    display: inline-block;
    margin-top: 4px;
    padding: 0;
    background: none;
    border: none;
    color: var(--muted-foreground);
    font-size: 0.75rem;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
    opacity: 0.8;
  }

  .wfb-toggle:hover {
    opacity: 1;
    color: var(--foreground);
  }
</style>
