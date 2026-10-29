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
