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

<button class="tool-btn" onclick={copy} {title} aria-label={title}>
  {#if copied}
    <Check size={14} />
  {:else}
    <Copy size={14} />
  {/if}
</button>

<style>
  .tool-btn {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: none;
    background: oklch(0.28 0.04 260);
    color: var(--foreground);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .tool-btn:active {
    background: oklch(0.35 0.04 260);
  }
</style>
