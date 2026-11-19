<script lang="ts">
  import { connection } from '$lib/stores/connection.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { getRestoreModeLabel } from '$lib/restore-status.js';
  import { createDelayedIndicator } from '$lib/navigation-indicator.svelte.js';

  interface StatusChip {
    label: string;
    className: string;
  }

  const navigationIndicator = createDelayedIndicator(() => sessionRegistry.viewedConversation?.isNavigatingTree ?? false);

  $effect(() => {
    navigationIndicator.update();
    return () => navigationIndicator.stop();
  });

  let chips = $derived.by(() => {
    const next: StatusChip[] = [];
    const session = sessionRegistry.viewedConversation;

    if (session?.isCompacting) {
      next.push({
        label: 'Compacting…',
        className: 'border-warning/20 bg-warning/10 text-status-reconnecting',
      });
    }

    if (navigationIndicator.visible) {
      next.push({
        label: session?.treeNavigationSummarizing ? 'Summarizing…' : 'Navigating…',
        className: 'border-status-active/20 bg-status-active/10 text-status-active',
      });
    }

    if (connection.phase === 'syncing' && session?.isRestoring) {
      const restoreLabel = getRestoreModeLabel(session.restoreMode);
      if (restoreLabel) {
        next.push({
          label: restoreLabel,
          className: 'border-status-active/20 bg-status-active/10 text-status-active',
        });
      }
    } else if (connection.phase === 'connecting' || connection.phase === 'backoff') {
      next.push({
        label: connection.phaseLabel,
        className: 'border-warning/20 bg-warning/10 text-status-reconnecting',
      });
    } else if (connection.phase === 'idle') {
      next.push({
        label: 'Disconnected',
        className: 'border-status-error/20 bg-status-error/10 text-status-error',
      });
    }

    return next;
  });
</script>

{#if chips.length > 0}
  <div class="border-border bg-background/95 flex shrink-0 gap-2 overflow-x-auto border-b px-4 py-1.5 md:hidden">
    {#each chips as chip (chip.label)}
      <span class="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium {chip.className}">
        {chip.label}
      </span>
    {/each}
  </div>
{/if}
