<script lang="ts">
  import { ansiToHtml, stripAnsi } from '$lib/ansi-to-html.js';
  import CollapsibleText from './CollapsibleText.svelte';
  import Copy from '@lucide/svelte/icons/copy';
  import Check from '@lucide/svelte/icons/check';

  let {
    text,
    streaming = false,
    maxCollapsedLines = 10,
    accent = 'default',
    bounded = false,
    renderAnsi = false,
    copyable = false,
  }: {
    text: string;
    streaming?: boolean;
    maxCollapsedLines?: number;
    accent?: 'default' | 'purple';
    /** Keep the view bounded, including below the line cutoff. */
    bounded?: boolean;
    /** Render ANSI color codes and escape the input text. */
    renderAnsi?: boolean;
    /** Show a corner copy button. Copies the full text, even when collapsed. */
    copyable?: boolean;
  } = $props();

  // Auto-expand while streaming so users can follow live output. The block
  // stays open afterwards and folds the first time it fully scrolls out of
  // view, matching the other streaming blocks.
  let expanded = $state(false);
  let contentEl: HTMLPreElement | undefined = $state();
  let bodyEl: HTMLElement | undefined = $state();

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
  let needsCollapse = $derived(!streaming && lineCount > maxCollapsedLines);
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

  // Auto-scroll to bottom while streaming
  $effect(() => {
    if (streaming && bodyEl) {
      // Track rendered content so the scroll follows the throttle cadence.
      void rendered;
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }
  });

  let copied = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => {
    if (resetTimer) clearTimeout(resetTimer);
  });

  // Copies the source text, never the clipped display: a collapsed or capped
  // view renders only the first lines. Styled output copies plain text.
  async function copy() {
    try {
      await navigator.clipboard.writeText(renderAnsi ? stripAnsi(text) : text);
      copied = true;
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => (copied = false), 1200);
    } catch {
      // Clipboard unavailable — leave button as-is.
    }
  }
</script>

<div class="bounded-output" class:accent-purple={accent === 'purple'} class:copyable>
  {#if copyable}
    <button type="button" class="copy-button output-copy-btn" class:copied aria-label={copied ? 'Copied' : 'Copy output'} title="Copy output" onclick={copy}>
      {#if copied}
        <Check size={14} />
      {:else}
        <Copy size={14} />
      {/if}
    </button>
  {/if}
  <!-- ansiToHtml escapes input text before creating fixed style spans. -->
  <CollapsibleText
    bind:expanded
    bind:bodyEl
    {needsCollapse}
    {lineCount}
    collapsedHeight="160px"
    alwaysCapped={bounded}
    detectOverflow={bounded && !streaming}
    autoExpand={streaming}
    autoCollapseOffscreen
  >
    {#snippet body()}
      <!-- eslint-disable svelte/no-at-html-tags -->
      <pre class="bounded-output-text" bind:this={contentEl}>{#if renderAnsi}{@html ansiToHtml(rendered ?? displayText)}{:else}{rendered ?? displayText}{/if}</pre>
      <!-- eslint-enable svelte/no-at-html-tags -->
    {/snippet}
  </CollapsibleText>
</div>

<style>
  .bounded-output {
    /* default accent color */
    --_accent: var(--muted-foreground);
  }

  .bounded-output.accent-purple {
    --_accent: var(--custom-accent);
  }

  .bounded-output.copyable {
    position: relative;
  }

  /* Reserve the corner strip so wrapped lines don't run under the button. */
  .bounded-output.copyable .bounded-output-text {
    padding-right: 56px;
  }

  .output-copy-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 1;
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

  .bounded-output :global(.collapsible-toggle) {
    color: var(--_accent);
  }

  .bounded-output :global(.collapsible-toggle:hover) {
    color: var(--foreground);
  }
</style>
