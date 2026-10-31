<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import Check from '@lucide/svelte/icons/check';

  let { text, title = 'Copy message' }: { text: string; title?: string } = $props();

  let copied = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => (copied = false), 1200);
    } catch {
      // Clipboard may be unavailable (insecure context, denied permission). Swallow silently.
    }
  }
</script>

<button type="button" class="copy-button" onclick={copy} {title} aria-label={copied ? 'Copied' : title}>
  {#if copied}
    <Check size={14} />
  {:else}
    <Copy size={14} />
  {/if}
</button>

<style>
  /* Matches TtsButton's .tool-btn so both render as identical 28px menu items. */
  .copy-button {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: none;
    background: var(--secondary);
    color: var(--foreground);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .copy-button:active {
    background: color-mix(in oklch, var(--secondary) 90%, white);
  }
</style>
