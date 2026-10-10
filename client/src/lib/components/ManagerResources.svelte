<script lang="ts">
  import type { PerSessionState } from '$lib/stores/session-registry.svelte.js';
  import { formatDownloadSize } from '$lib/download-presentation.js';
  import Download from '@lucide/svelte/icons/download';
  import CardList from './CardList.svelte';

  let { source }: { source: PerSessionState | null } = $props();
  let cards = $derived(source?.panelCards ?? []);
  let downloads = $derived(source?.downloads ?? []);
</script>

{#if cards.length > 0 || downloads.length > 0}
  <section aria-label="Manager resources" class="border-border bg-muted/20 max-h-60 shrink-0 overflow-y-auto border-t p-3">
    <div class="mx-auto flex max-w-3xl flex-col gap-2">
      {#if cards.length > 0}
        <CardList {cards} openInNewTab />
      {/if}
      {#each downloads as item (item.id)}
        <!-- One-shot attachment route, not a SPA route. No automatic download. -->
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
        <a href={item.href} download class="border-border text-foreground hover:bg-accent/50 flex items-center gap-2 rounded border p-2 transition-colors">
          <Download class="size-4 shrink-0" />
          <span class="min-w-0 flex-1 truncate text-sm font-medium">{item.filename}</span>
          <span class="text-muted-foreground shrink-0 text-xs">{formatDownloadSize(item.sizeBytes)}</span>
        </a>
      {/each}
    </div>
  </section>
{/if}
