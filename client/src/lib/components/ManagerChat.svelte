<script lang="ts">
  import { managerStore } from '$lib/stores/manager-store.svelte.js';
  import MessageList from './MessageList.svelte';
  import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
  import OctagonX from '@lucide/svelte/icons/octagon-x';

  let draft = $state('');

  let canSend = $derived(draft.trim().length > 0 && managerStore.status === 'idle');

  async function send(): Promise<void> {
    const text = draft;
    if (!text.trim() || managerStore.status === 'working') return;
    draft = '';
    await managerStore.send(text);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <MessageList source={managerStore.session} />

  <div class="border-border bg-background shrink-0 border-t px-3 pt-2 pb-[max(env(safe-area-inset-bottom),8px)]">
    <div class="mx-auto flex max-w-3xl items-end gap-2">
      <textarea
        bind:value={draft}
        onkeydown={handleKeydown}
        rows={1}
        placeholder="Ask the manager…"
        autocapitalize="sentences"
        spellcheck={true}
        aria-label="Message the manager"
        class="border-border bg-secondary text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-ring block w-full resize-none rounded-xl border px-4 py-3 text-sm transition-colors focus:ring-1 focus:outline-none"
      ></textarea>

      {#if managerStore.status === 'working'}
        <button
          class="bg-destructive text-primary-foreground hover:bg-destructive/80 active:bg-destructive/70 mb-1 flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors"
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => void managerStore.abort()}
          title="Abort"
        >
          <OctagonX class="size-4" />
          <span class="hidden sm:inline">Abort</span>
        </button>
      {:else}
        <button
          class="bg-primary text-primary-foreground hover:bg-primary/80 active:bg-primary/70 mb-1 flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canSend}
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => void send()}
          title="Send"
        >
          <SendHorizontal class="size-4" />
          <span class="hidden sm:inline">Send</span>
        </button>
      {/if}
    </div>
  </div>
</div>
