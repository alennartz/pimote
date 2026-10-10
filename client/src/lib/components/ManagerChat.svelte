<script lang="ts">
  import { connection } from '$lib/stores/connection.svelte.js';
  import { folderStore } from '$lib/stores/folder-store.svelte.js';
  import SessionItem from './SessionItem.svelte';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Bot from '@lucide/svelte/icons/bot';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Send from '@lucide/svelte/icons/send';
  import X from '@lucide/svelte/icons/x';

  /** Thin manager area on the dashboard: one composer plus the persisted
   *  manager sessions, hidden behind a click. No transcript here — manager
   *  conversations are ordinary sessions and open on the ordinary
   *  conversation surface. Closing the area closes UI only.
   *
   *  `panel`: desktop split view beside the folder column.
   *  `sheet`: mobile overlay behind the toolbar's manager affordance. */
  let {
    variant,
    managerDraft = $bindable(''),
    onSubmit,
    onDismiss,
  }: {
    variant: 'panel' | 'sheet';
    managerDraft?: string;
    onSubmit: (text: string) => void | Promise<void>;
    onDismiss: () => void;
  } = $props();

  let composerEl = $state<HTMLTextAreaElement | null>(null);
  let sessionsOpen = $state(false);

  /** Canonical manager root from connection state (never raw `~`). */
  const managerRoot = $derived(connection.managerRoot);
  /** Manager controls wait for a usable root fact and connected readiness. */
  const managerReady = $derived(connection.ready && managerRoot !== null);
  /** Persisted manager sessions from the path-keyed session cache — no
   *  discovered folder row required. */
  const sessions = $derived(managerRoot ? (folderStore.sessions.get(managerRoot) ?? []) : []);
  const canSend = $derived(managerReady && managerDraft.trim().length > 0);

  /** Old manager sessions load on demand, when their click reveals them. */
  $effect(() => {
    const root = managerRoot;
    if (!root || !sessionsOpen) return;
    void folderStore.loadSessions(root);
  });

  function submitDraft(): void {
    if (!managerReady) return;
    void onSubmit(managerDraft);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitDraft();
    }
  }

  /** Same grow-and-cap behaviour as the session InputBar's textarea; an empty
   *  field falls back to rows=1 so a wrapped placeholder can't inflate it. */
  function autosize(el: HTMLTextAreaElement | null): void {
    if (!el) return;
    if (!managerDraft) {
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
    const el = composerEl;
    void managerDraft;
    autosize(el);
  });
</script>

{#snippet composer()}
  <!-- Composer mirroring the session InputBar: same shell, inset send -->
  <div class="border-border bg-background relative shrink-0 border-t px-3 pt-2 pb-[max(env(safe-area-inset-bottom),8px)]">
    <div class="mx-auto flex max-w-3xl items-end gap-2">
      <div class="relative min-w-0 flex-1">
        <textarea
          bind:this={composerEl}
          bind:value={managerDraft}
          onkeydown={handleKeydown}
          rows={1}
          placeholder="Message the manager"
          autocapitalize="sentences"
          enterkeyhint="send"
          spellcheck={false}
          aria-label="Message the manager"
          disabled={!managerReady}
          class="border-border bg-secondary text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-ring block w-full resize-none overflow-hidden rounded-xl border py-3 pr-11 pl-4 text-sm transition-colors focus:ring-1 focus:outline-none disabled:opacity-50"
        ></textarea>
        <button
          class="absolute right-1.5 bottom-1.5 flex items-center justify-center rounded-lg p-1.5 transition-colors {canSend
            ? 'bg-primary text-primary-foreground hover:bg-primary/80 active:bg-primary/70'
            : 'text-muted-foreground cursor-not-allowed opacity-50'}"
          disabled={!canSend}
          onpointerdown={(e) => e.preventDefault()}
          onclick={submitDraft}
          title="Send"
        >
          <Send class="size-5" />
        </button>
      </div>
    </div>
  </div>
{/snippet}

{#snippet sessionList()}
  <!-- Persisted manager sessions, hidden behind a click: visible on demand for
       jump-back/resume. Each row opens an ordinary conversation. -->
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if managerRoot}
      <div class="mx-auto max-w-3xl px-3 pb-3">
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-8 w-full items-center gap-1.5 rounded-md pr-1 text-left text-xs font-semibold tracking-widest uppercase transition-colors focus-visible:ring-1 focus-visible:outline-none"
          aria-expanded={sessionsOpen}
          onclick={() => (sessionsOpen = !sessionsOpen)}
        >
          <ChevronRight class="size-3.5 shrink-0 transition-transform {sessionsOpen ? 'rotate-90' : ''}" />
          Previous sessions
          <span class="text-muted-foreground/80 ml-auto text-xs font-normal tracking-normal normal-case">{sessions.length}</span>
        </button>
        {#if sessionsOpen}
          <div class="mt-1 flex flex-col gap-1">
            {#each sessions as session (session.id)}
              <SessionItem {session} folderPath={managerRoot} />
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

{#if variant === 'panel'}
  <!-- Desktop: right-hand manager panel; status-bar-style header -->
  <div class="border-border bg-card flex min-h-0 min-w-0 flex-1 flex-col border-l">
    <div class="border-border bg-muted/30 text-muted-foreground flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
      <Bot class="size-3.5" />
      <span class="font-medium">Manager</span>
      <button
        class="hover:text-foreground ml-auto rounded p-1 transition-colors"
        title="Dismiss manager conversation"
        aria-label="Dismiss manager conversation"
        onclick={onDismiss}
      >
        <X class="size-4" />
      </button>
    </div>
    {@render sessionList()}
    {@render composer()}
  </div>
{:else}
  <!-- Mobile: sheet over the dashboard, header identical to the session page's -->
  <div class="bg-background fixed inset-0 z-40 flex flex-col md:hidden">
    <header class="border-border flex min-h-12 shrink-0 items-center gap-2 border-b px-3 pt-[max(env(safe-area-inset-top),0.25rem)]">
      <button
        class="text-muted-foreground hover:text-foreground -ml-1 flex size-8 shrink-0 items-center justify-center rounded-md transition-colors"
        title="Dismiss manager conversation"
        aria-label="Dismiss manager conversation"
        onclick={onDismiss}
      >
        <ArrowLeft class="size-5" />
      </button>
      <div class="min-w-0 flex-1">
        <div class="text-foreground truncate text-sm font-semibold">Manager</div>
      </div>
    </header>
    {@render sessionList()}
    {@render composer()}
  </div>
{/if}
