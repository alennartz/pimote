<script lang="ts">
  import { connection } from '$lib/stores/connection.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { getRestoreModeLabel } from '$lib/restore-status.js';

  interface StatusChip {
    label: string;
    className: string;
  }

  let chips = $derived.by(() => {
    const next: StatusChip[] = [];
    const session = sessionRegistry.viewed;

    if (session?.isCompacting) {
      next.push({
        label: 'Compacting…',
        className: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400',
      });
    }

    if (connection.phase === 'syncing' && session?.isRestoring) {
      const restoreLabel = getRestoreModeLabel(session.restoreMode);
      if (restoreLabel) {
        next.push({
          label: restoreLabel,
          className: 'border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-400',
        });
      }
    } else if (connection.phase === 'connecting' || connection.phase === 'backoff') {
      next.push({
        label: connection.phaseLabel,
        className: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400',
      });
    } else if (connection.phase === 'idle') {
      next.push({
        label: 'Disconnected',
        className: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400',
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
