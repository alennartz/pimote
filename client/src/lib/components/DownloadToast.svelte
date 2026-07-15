<script lang="ts">
  import Download from '@lucide/svelte/icons/download';
  import X from '@lucide/svelte/icons/x';
  import { downloadUi } from '$lib/stores/download-ui.svelte.js';

  let toast = $derived(downloadUi.currentToast);

  function dismissToast(): void {
    if (toast) {
      downloadUi.dismissDownloadToast(toast.item.id);
    }
  }
</script>

{#if toast}
  <div class="pointer-events-none fixed top-4 left-1/2 z-50 flex w-[min(calc(100vw-2rem),28rem)] -translate-x-1/2" aria-live="polite">
    <div class="border-border bg-background text-foreground pointer-events-auto flex w-full items-center gap-3 rounded-lg border px-3 py-3 shadow-lg">
      <Download class="text-primary size-5 shrink-0" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">File ready to download</p>
        <p class="text-muted-foreground truncate text-xs">{toast.filename} · {toast.sizeLabel}</p>
      </div>
      <!-- toast.href targets the server's one-shot attachment route, not a SPA route. -->
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
      <a href={toast.href} class="bg-primary text-primary-foreground hover:bg-primary/85 rounded-md px-2.5 py-1.5 text-xs font-medium" onclick={dismissToast}> Download </a>
      <button class="text-muted-foreground hover:text-foreground rounded-md p-1" type="button" title="Dismiss download notification" onclick={dismissToast}>
        <X class="size-4" />
        <span class="sr-only">Dismiss download notification</span>
      </button>
    </div>
  </div>
{/if}
