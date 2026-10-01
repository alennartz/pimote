<script lang="ts">
  import { managerStore } from '$lib/stores/manager-store.svelte.js';
  import { isMobileViewport } from '$lib/mobile-viewport.svelte.js';
  import MessageList from './MessageList.svelte';
  import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
  import OctagonX from '@lucide/svelte/icons/octagon-x';
  import Bot from '@lucide/svelte/icons/bot';
  import X from '@lucide/svelte/icons/x';

  /** `embed`: dashboard widget — idle spotlight that grows into a self-chromed
   *  card once the conversation starts (desktop).
   *  `expanded`: full-height chat with the input pinned to the bottom and no
   *  card chrome, for containers that bring their own header + close button
   *  (mobile fullscreen sheet). */
  let { variant = 'embed' }: { variant?: 'embed' | 'expanded' } = $props();

  let draft = $state('');

  let hasConversation = $derived(managerStore.messages.length > 0);
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

  /** Back to the idle spotlight — discards the ephemeral transcript. */
  function dismiss(): void {
    if (managerStore.status === 'working') void managerStore.abort();
    managerStore.reset();
    draft = '';
  }
</script>

{#snippet inputRow()}
  <div class="border-border border-t px-3 pt-2 {variant === 'expanded' ? 'pb-[max(env(safe-area-inset-bottom),8px)]' : 'pb-2'}">
    <div class="mx-auto flex max-w-3xl items-end gap-2">
      <textarea
        bind:value={draft}
        onkeydown={handleKeydown}
        rows={1}
        placeholder="Reply…"
        autocapitalize="sentences"
        spellcheck={!isMobileViewport()}
        aria-label="Message the manager"
        class="border-border bg-secondary text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-ring block w-full resize-none rounded-xl border px-3 py-2 text-sm transition-colors focus:ring-1 focus:outline-none max-md:text-base"
      ></textarea>
      {#if managerStore.status === 'working'}
        <button
          class="bg-destructive text-primary-foreground hover:bg-destructive/80 active:bg-destructive/70 mb-0.5 flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors max-md:min-h-11 max-md:px-4"
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => void managerStore.abort()}
          title="Abort"
        >
          <OctagonX class="size-4 max-md:size-5" />
        </button>
      {:else}
        <button
          class="bg-primary text-primary-foreground hover:bg-primary/80 active:bg-primary/70 mb-0.5 flex shrink-0 items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11 max-md:px-4"
          disabled={!canSend}
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => void send()}
          title="Send"
        >
          <SendHorizontal class="size-4 max-md:size-5" />
        </button>
      {/if}
    </div>
  </div>
{/snippet}

{#if variant === 'expanded'}
  <!-- Expanded: the transcript fills the height, input stays at the bottom.
       All chrome (header + close) belongs to the container. -->
  <div class="flex h-full min-h-0 flex-col">
    <MessageList source={managerStore.session} />
    {@render inputRow()}
  </div>
{:else if hasConversation}
  <!-- In use: the conversation grows in place, still centered -->
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
    {@render inputRow()}
  </div>
{:else}
  <!-- Idle: a single spotlight input, nothing else of the manager is visible -->
  <div
    class="border-border focus-within:ring-ring mx-auto flex w-full items-center gap-2.5 rounded-2xl border bg-[var(--surface-2,var(--secondary))] px-4 py-3 shadow-lg transition-colors focus-within:ring-1 focus-within:outline-none"
  >
    <Bot class="text-muted-foreground size-4 shrink-0" />
    <textarea
      bind:value={draft}
      onkeydown={handleKeydown}
      rows={1}
      placeholder="Ask the manager — start sessions, archive old ones, check status…"
      autocapitalize="sentences"
      spellcheck={!isMobileViewport()}
      aria-label="Message the manager"
      class="text-foreground placeholder:text-muted-foreground block w-full resize-none bg-transparent text-sm outline-none"
    ></textarea>
    {#if managerStore.status === 'working'}
      <button
        class="text-destructive hover:bg-destructive/10 flex shrink-0 items-center rounded-lg p-1.5 transition-colors"
        onpointerdown={(e) => e.preventDefault()}
        onclick={() => void managerStore.abort()}
        title="Abort"
      >
        <OctagonX class="size-4" />
      </button>
    {:else if canSend}
      <button
        class="bg-primary text-primary-foreground hover:bg-primary/80 active:bg-primary/70 flex shrink-0 items-center rounded-lg p-1.5 transition-colors"
        onpointerdown={(e) => e.preventDefault()}
        onclick={() => void send()}
        title="Send"
      >
        <SendHorizontal class="size-4" />
      </button>
    {/if}
  </div>
{/if}
