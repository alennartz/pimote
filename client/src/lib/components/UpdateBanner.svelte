<script lang="ts">
  import ArrowUpCircle from '@lucide/svelte/icons/arrow-up-circle';
  import X from '@lucide/svelte/icons/x';
  import { updateStore } from '$lib/stores/update.svelte.js';
</script>

{#if updateStore.showBanner}
  {@const status = updateStore.status}
  {#if status}
    <div class="border-border bg-muted/50 flex flex-col border-b">
      <div class="flex items-center gap-3 px-4 py-3">
        <ArrowUpCircle class="text-muted-foreground size-4 shrink-0" />
        <span class="text-foreground flex-1 text-sm">Update available: {status.currentVersion} → {status.latestVersion}</span>
        <!-- status.releaseUrl is a server-supplied external release URL, not a SPA route, so resolve() does not apply. -->
        <!-- eslint-disable svelte/no-navigation-without-resolve -->
        <a
          class="bg-primary text-primary-foreground hover:bg-primary/80 rounded-md px-3 py-1.5 text-xs font-medium"
          href={status.releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          View release
        </a>
        <!-- eslint-enable svelte/no-navigation-without-resolve -->
        <button class="text-muted-foreground hover:text-foreground rounded-md p-1" onclick={() => updateStore.dismiss()} aria-label="Dismiss update notification" title="Dismiss">
          <X class="size-4" />
        </button>
      </div>
    </div>
  {/if}
{/if}
