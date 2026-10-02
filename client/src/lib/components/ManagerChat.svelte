<script lang="ts">
  import { managerStore } from '$lib/stores/manager-store.svelte.js';
  import MessageList from './MessageList.svelte';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Bot from '@lucide/svelte/icons/bot';
  import OctagonX from '@lucide/svelte/icons/octagon-x';
  import Send from '@lucide/svelte/icons/send';
  import X from '@lucide/svelte/icons/x';

  /** The manager conversation, presented like a session view — minus the
   *  session-only chrome (runtime status, session actions, model/command UI).
   *
   *  `panel`: desktop split view. The homepage keeps a narrow left rail; the
   *  transcript takes the right. The homepage box stays the composer.
   *  `fullscreen`: mobile chat. Mirrors the session page — same header (back,
   *  title, safe-area top), self-scrolling transcript, composer pinned to the
   *  bottom safe area exactly like the session InputBar. */
  let { variant }: { variant: 'panel' | 'fullscreen' } = $props();

  let composerEl = $state<HTMLTextAreaElement | null>(null);

  /** X (panel) / back (fullscreen): drop the transcript and the view together,
   *  returning the layout to the plain homepage. */
  function dismiss(): void {
    if (managerStore.status === 'working') void managerStore.abort();
    managerStore.reset();
    managerStore.draft = '';
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void managerStore.sendDraft();
    }
  }

  /** Same grow-and-cap behaviour as the session InputBar's textarea; an empty
   *  field falls back to rows=1 so a wrapped placeholder can't inflate it. */
  function autosize(el: HTMLTextAreaElement | null): void {
    if (!el) return;
    if (!managerStore.draft) {
      el.style.height = '';
      el.style.overflow = '';
      return;
    }
    el.style.height = 'auto';
    const capped = Math.min(el.scrollHeight, 200);
    el.style.height = `${capped}px`;
    el.style.overflow = el.scrollHeight > 200 ? 'auto' : 'hidden';
  }

  $effect(() => {
    if (variant !== 'fullscreen') return;
    const el = composerEl;
    void managerStore.draft;
    autosize(el);
  });
</script>

{#if variant === 'panel'}
  <!-- Desktop: right-hand transcript panel; status-bar-style header -->
  <div class="border-border bg-card flex min-h-0 min-w-0 flex-1 flex-col border-l">
    <div class="border-border bg-muted/30 text-muted-foreground flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
      <Bot class="size-3.5" />
      <span class="font-medium">Manager</span>
      {#if managerStore.status === 'working'}
        <span class="animate-pulse">working…</span>
      {/if}
      <button class="hover:text-foreground ml-auto rounded p-1 transition-colors" title="Dismiss manager conversation" aria-label="Dismiss manager conversation" onclick={dismiss}>
        <X class="size-4" />
      </button>
    </div>
    <MessageList source={managerStore.session} />
  </div>
{:else}
  <!-- Mobile: full screen chat under a header identical to the session page's -->
  <div class="bg-background fixed inset-0 z-40 flex flex-col md:hidden">
    <header class="border-border flex min-h-12 shrink-0 items-center gap-2 border-b px-3 pt-[max(env(safe-area-inset-top),0.25rem)]">
      <button
        class="text-muted-foreground hover:text-foreground -ml-1 flex size-8 shrink-0 items-center justify-center rounded-md transition-colors"
        title="Dismiss manager conversation"
        aria-label="Dismiss manager conversation"
        onclick={dismiss}
      >
        <ArrowLeft class="size-5" />
      </button>
      <div class="min-w-0 flex-1">
        <div class="text-foreground truncate text-sm font-semibold">Manager</div>
      </div>
      {#if managerStore.status === 'working'}
        <span class="text-muted-foreground animate-pulse text-xs">working…</span>
      {/if}
    </header>

    <MessageList source={managerStore.session} />

    <!-- Composer mirroring the session InputBar: same shell, inset send/abort -->
    <div class="border-border bg-background relative shrink-0 border-t px-3 pt-2 pb-[max(env(safe-area-inset-bottom),8px)]">
      <div class="mx-auto flex max-w-3xl items-end gap-2">
        <div class="relative min-w-0 flex-1">
          <textarea
            bind:this={composerEl}
            bind:value={managerStore.draft}
            onkeydown={handleKeydown}
            rows={1}
            placeholder="Message the manager"
            autocapitalize="sentences"
            enterkeyhint="send"
            spellcheck={false}
            aria-label="Message the manager"
            class="border-border bg-secondary text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-ring block w-full resize-none overflow-hidden rounded-xl border py-3 pr-11 pl-4 text-sm transition-colors focus:ring-1 focus:outline-none"
          ></textarea>
          {#if managerStore.status === 'working'}
            <button
              class="bg-destructive text-primary-foreground hover:bg-destructive/80 active:bg-destructive/70 absolute right-1.5 bottom-1.5 flex items-center justify-center rounded-lg p-1.5 transition-colors"
              onpointerdown={(e) => e.preventDefault()}
              onclick={() => void managerStore.abort()}
              title="Abort"
            >
              <OctagonX class="size-5" />
            </button>
          {:else}
            <button
              class="absolute right-1.5 bottom-1.5 flex items-center justify-center rounded-lg p-1.5 transition-colors {managerStore.canSend
                ? 'bg-primary text-primary-foreground hover:bg-primary/80 active:bg-primary/70'
                : 'text-muted-foreground cursor-not-allowed opacity-50'}"
              disabled={!managerStore.canSend}
              onpointerdown={(e) => e.preventDefault()}
              onclick={() => void managerStore.sendDraft()}
              title="Send"
            >
              <Send class="size-5" />
            </button>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}
