<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import BrainCircuit from '@lucide/svelte/icons/brain-circuit';

  let { text, streaming = false }: { text: string; streaming?: boolean } = $props();

  // Expanded when streaming, collapsed when finalized
  let expanded = $derived(streaming);
</script>

<div class="thinking-block">
  <button class="thinking-header" onclick={() => (expanded = !expanded)}>
    <ChevronRight class="shrink-0 transition-transform duration-150 {expanded ? 'rotate-90' : ''}" size={14} />
    <BrainCircuit size={14} class="shrink-0" />
    <span class="thinking-label">
      {streaming ? 'Thinking…' : 'Thought process'}
    </span>
    {#if streaming}
      <span class="streaming-dot"></span>
    {/if}
  </button>

  {#if expanded}
    <div class="thinking-content">
      <pre class="thinking-text">{text}</pre>
    </div>
  {/if}
</div>

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
    background: oklch(0.18 0.025 258);
    color: var(--muted-foreground);
    font-size: 0.8rem;
    cursor: pointer;
    border: none;
    text-align: left;
    transition: background-color 0.15s;
  }

  .thinking-header:hover {
    background: oklch(0.22 0.03 258);
  }

  .thinking-label {
    flex: 1;
    font-style: italic;
  }

  .streaming-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--status-streaming, oklch(0.623 0.169 149.2));
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
    background: oklch(0.15 0.02 258);
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
    font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  }
</style>
