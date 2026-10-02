<script lang="ts">
  import { managerStore } from '$lib/stores/manager-store.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { isMobileViewport } from '$lib/mobile-viewport.svelte.js';
  import { tick } from 'svelte';
  import NewSessionDialog from './NewSessionDialog.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import OctagonX from '@lucide/svelte/icons/octagon-x';
  import Plus from '@lucide/svelte/icons/plus';
  import Search from '@lucide/svelte/icons/search';
  import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
  import Sparkles from '@lucide/svelte/icons/sparkles';

  /** One box, two modes. The leading button swaps between them:
   *  search (default) filters the project list, the manager mode is the AI
   *  composer — signalled by the ✨ sparkles glyph, the icon conventionally
   *  read as "artificial intelligence". */
  let { search = $bindable('') }: { search?: string } = $props();

  let mode = $state<'search' | 'manager'>('search');
  let draft = $state('');
  let newSessionOpen = $state(false);

  let searchEl = $state<HTMLInputElement | null>(null);
  let managerEl = $state<HTMLTextAreaElement | null>(null);

  let canSend = $derived(draft.trim().length > 0 && managerStore.status === 'idle');

  async function toggleMode(): Promise<void> {
    mode = mode === 'search' ? 'manager' : 'search';
    // The swapped-in field replaces the old one in the DOM — focus it so
    // typing continues without a second tap.
    await tick();
    (mode === 'search' ? searchEl : managerEl)?.focus();
  }

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

<div class="flex items-center gap-2">
  <div
    class="border-border focus-within:ring-ring flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded-2xl border bg-[var(--surface-2,var(--secondary))] px-1.5 py-1 shadow-lg transition-colors focus-within:ring-1 focus-within:outline-none max-md:min-h-12 {mode ===
    'manager'
      ? 'border-ring/60 ring-ring/40 ring-1'
      : ''}"
  >
    <button
      type="button"
      class="hover:bg-accent active:bg-accent/80 focus-visible:ring-ring flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors focus-visible:ring-1 focus-visible:outline-none max-md:size-10 {mode ===
      'manager'
        ? 'text-primary'
        : 'text-muted-foreground'}"
      onclick={() => void toggleMode()}
      title={mode === 'search' ? 'Switch to the manager (AI)' : 'Switch to search'}
      aria-label={mode === 'search' ? 'Switch to the manager' : 'Switch to search'}
      aria-pressed={mode === 'manager'}
    >
      {#if mode === 'search'}
        <Search class="size-4 max-md:size-5" />
      {:else}
        <Sparkles class="size-4 max-md:size-5" />
      {/if}
    </button>

    {#if mode === 'search'}
      <input
        bind:this={searchEl}
        bind:value={search}
        placeholder="Search projects"
        aria-label="Search projects"
        class="text-foreground placeholder:text-muted-foreground w-full min-w-0 bg-transparent text-sm outline-none max-md:text-base"
      />
    {:else}
      <textarea
        bind:this={managerEl}
        bind:value={draft}
        onkeydown={handleKeydown}
        rows={1}
        placeholder="Ask the manager — start sessions, archive old ones, check status…"
        autocapitalize="sentences"
        enterkeyhint="send"
        spellcheck={!isMobileViewport()}
        aria-label="Message the manager"
        class="text-foreground placeholder:text-muted-foreground block w-full min-w-0 resize-none bg-transparent text-sm outline-none max-md:text-base"
      ></textarea>
      {#if managerStore.status === 'working'}
        <button
          class="text-destructive hover:bg-destructive/10 flex shrink-0 items-center rounded-lg p-1.5 transition-colors max-md:p-2.5"
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => void managerStore.abort()}
          title="Abort"
        >
          <OctagonX class="size-4 max-md:size-5" />
        </button>
      {:else if canSend}
        <button
          class="bg-primary text-primary-foreground hover:bg-primary/80 active:bg-primary/70 flex shrink-0 items-center rounded-lg p-1.5 transition-colors max-md:p-2.5"
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => void send()}
          title="Send"
        >
          <SendHorizontal class="size-4 max-md:size-5" />
        </button>
      {/if}
    {/if}
  </div>

  <Button size="sm" class="h-11 shrink-0 rounded-xl px-4 text-sm max-md:h-12" onclick={() => (newSessionOpen = true)} disabled={connection.status !== 'connected'}>
    <Plus class="size-3.5 max-md:size-4" />
    New session
  </Button>
</div>

<NewSessionDialog bind:open={newSessionOpen} />
