<script lang="ts">
  import { onMount } from 'svelte';
  import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '$lib/components/ui/dropdown-menu/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import Download from '@lucide/svelte/icons/download';
  import { formatDownloadSize } from '$lib/download-presentation.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { downloadUi } from '$lib/stores/download-ui.svelte.js';

  let { variant = 'desktop' }: { variant?: 'desktop' | 'mobile' } = $props();

  let open = $state(false);
  let viewportActive = $state(false);
  let openForSessionId = $state<string | null>(null);

  let viewedSession = $derived(sessionRegistry.viewed);
  let viewedSessionId = $derived(viewedSession?.sessionId ?? null);
  let downloads = $derived(viewedSession?.downloads ?? []);

  onMount(() => {
    const query = window.matchMedia(variant === 'desktop' ? '(min-width: 768px)' : '(max-width: 767px)');
    const updateViewport = () => {
      viewportActive = query.matches;
      if (!viewportActive) open = false;
    };

    updateViewport();
    query.addEventListener('change', updateViewport);
    return () => query.removeEventListener('change', updateViewport);
  });

  // A notification request belongs to one session. Wait until that session is
  // actually viewed (and has a pending item) before the visible presenter
  // claims it; the hidden desktop/mobile counterpart cannot open a portal.
  $effect(() => {
    if (!viewportActive || !viewedSessionId || downloads.length === 0) return;
    if (downloadUi.takeDownloadInboxOpenRequest(viewedSessionId)) {
      open = true;
      openForSessionId = viewedSessionId;
    }
  });

  // Do not leave a previous session's dropdown open when the user switches.
  $effect(() => {
    if (openForSessionId && openForSessionId !== viewedSessionId) {
      open = false;
      openForSessionId = null;
    }
  });

  $effect(() => {
    if (!open) return;
    openForSessionId = viewedSessionId;
  });

  $effect(() => {
    if (downloads.length === 0) open = false;
  });

  function closeInbox(): void {
    open = false;
  }
</script>

{#if downloads.length > 0}
  <DropdownMenu bind:open>
    <DropdownMenuTrigger>
      {#if variant === 'desktop'}
        <Button
          variant="ghost"
          size="xs"
          class="text-muted-foreground hover:text-foreground gap-1"
          title={`Open ${downloads.length} pending download${downloads.length === 1 ? '' : 's'}`}
        >
          <Download class="size-3" />
          <span>Downloads</span>
          <span class="bg-primary text-primary-foreground min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-medium">{downloads.length}</span>
        </Button>
      {:else}
        <Button
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground hover:text-foreground relative"
          title={`Open ${downloads.length} pending download${downloads.length === 1 ? '' : 's'}`}
        >
          <Download class="size-4" />
          <span class="bg-primary text-primary-foreground absolute -top-1 -right-1 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-medium">
            {downloads.length}
          </span>
          <span class="sr-only">Open downloads</span>
        </Button>
      {/if}
    </DropdownMenuTrigger>

    <DropdownMenuContent align="end" class="w-72 max-w-[calc(100vw-1rem)]">
      <DropdownMenuLabel>Downloads ({downloads.length})</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <div class="max-h-64 overflow-y-auto">
        {#each downloads as item (item.id)}
          <!-- item.href targets the server's one-shot attachment route, not a SPA route. -->
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
          <a href={item.href} class="hover:bg-accent block px-2 py-2 transition-colors" onclick={closeInbox}>
            <span class="text-foreground block truncate text-sm font-medium">{item.filename}</span>
            <span class="text-muted-foreground block text-xs">{formatDownloadSize(item.sizeBytes)}</span>
          </a>
        {/each}
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
{/if}
