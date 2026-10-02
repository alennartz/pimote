<script lang="ts">
  import { managerStore } from '$lib/stores/manager-store.svelte.js';
  import MessageList from './MessageList.svelte';
  import Bot from '@lucide/svelte/icons/bot';
  import X from '@lucide/svelte/icons/x';

  /** The transcript half of the manager: the composer lives in HomeToolbar's
   *  combined box, so this card only appears once a conversation exists and
   *  renders inline on every viewport (no fullscreen sheet). */
  let hasConversation = $derived(managerStore.messages.length > 0);

  /** Drop the transcript — back to the idle box. */
  function dismiss(): void {
    if (managerStore.status === 'working') void managerStore.abort();
    managerStore.reset();
  }
</script>

{#if hasConversation}
  <div class="bg-card border-border ring-border/50 overflow-hidden rounded-2xl border shadow-sm ring-1">
    <div class="flex h-9 items-center gap-2 border-b px-3">
      <Bot class="text-muted-foreground size-3.5" />
      <span class="text-muted-foreground text-xs font-medium">Manager</span>
      {#if managerStore.status === 'working'}
        <span class="text-muted-foreground animate-pulse text-xs">working…</span>
      {/if}
      <button
        class="text-muted-foreground hover:text-foreground ml-auto rounded p-1 transition-colors"
        title="Dismiss manager conversation"
        aria-label="Dismiss manager conversation"
        onclick={dismiss}
      >
        <X class="size-4" />
      </button>
    </div>
    <div class="flex max-h-[45vh] min-h-0 flex-col">
      <MessageList source={managerStore.session} />
    </div>
  </div>
{/if}
