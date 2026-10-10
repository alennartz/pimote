<script lang="ts">
  import { connection } from '$lib/stores/connection.svelte.js';
  import { isMobileViewport } from '$lib/mobile-viewport.svelte.js';
  import { tick } from 'svelte';
  import NewSessionDialog from './NewSessionDialog.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import Plus from '@lucide/svelte/icons/plus';
  import Search from '@lucide/svelte/icons/search';
  import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { folderStore } from '$lib/stores/folder-store.svelte.js';
  import SessionItem from './SessionItem.svelte';

  /** One box, two modes. The leading control is a single toggle button showing
   *  both glyphs at once — 🔍 for search (default), ✨ for the manager (the
   *  icon conventionally read as "artificial intelligence"). The active glyph
   *  is pill-highlighted; clicking anywhere on the pair swaps modes. Manager
   *  mode is a box mode only: it points this box's input at the manager;
   *  sending opens the session. It does not open the manager area. */
  let {
    search = $bindable(''),
    compact = false,
    managerMode = $bindable(false),
    managerDraft = $bindable(''),
    managerReady = false,
    busy = false,
    onSubmitManager,
  }: {
    search?: string;
    compact?: boolean;
    /** Local UI state: manager mode on the box. */
    managerMode?: boolean;
    /** Draft shared by this box and the manager area's composer. */
    managerDraft?: string;
    /** True once a usable manager root fact and connected readiness exist. */
    managerReady?: boolean;
    /** True while a manager submit is in flight; disables the send affordance. */
    busy?: boolean;
    /** The manager area's one shared submit operation. */
    onSubmitManager?: (text: string) => void | Promise<void>;
  } = $props();

  const mode = $derived(managerMode ? 'manager' : 'search');
  const canSend = $derived(managerReady && !busy && managerDraft.trim().length > 0);
  let newSessionOpen = $state(false);

  let searchEl = $state<HTMLInputElement | null>(null);
  let managerEl = $state<HTMLTextAreaElement | null>(null);

  async function toggleMode(): Promise<void> {
    managerMode = !managerMode;
    // The swapped-in field replaces the old one in the DOM — focus it so
    // typing continues without a second tap.
    await tick();
    (managerMode ? managerEl : searchEl)?.focus();
  }

  /** Grow the field to its content so rows=1 never overflows — a fractional
   *  line-height mismatch would otherwise paint a hairline scrollbar. An empty
   *  field keeps the rows=1 height: measuring scrollHeight there would pick up
   *  the wrapped placeholder and inflate the box. */
  function autosize(el: HTMLTextAreaElement): void {
    if (!managerDraft) {
      el.style.height = '';
      el.style.overflow = '';
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  $effect(() => {
    const el = managerEl;
    if (!el) return;
    void managerDraft; // re-run on every keystroke, not just when the field mounts
    autosize(el);
  });

  /** Old manager sessions, surfaced as a dropdown just below the box in
   *  manager mode. Collapsed, the affordance is a near-zero-height strip;
   *  expanding opens a dropdown overlay, so nothing below is pushed down.
   *  The count is live because the path-keyed session cache loads while
   *  manager mode is on. */
  let sessionsOpen = $state(false);
  const managerRoot = $derived(connection.managerRoot);
  const managerSessions = $derived(managerRoot ? (folderStore.sessions.get(managerRoot) ?? []) : []);

  $effect(() => {
    const root = managerRoot;
    if (!root || !managerMode) return;
    void folderStore.loadSessions(root);
  });

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void onSubmitManager?.(managerDraft);
    }
  }
</script>

<div class="flex items-center gap-2">
  <div class="relative min-w-0 flex-1">
    <div
      class="border-border focus-within:ring-ring flex min-h-11 w-full items-center gap-1 rounded-2xl border bg-[var(--surface-2,var(--secondary))] px-1.5 py-1 shadow-lg transition-colors focus-within:ring-1 focus-within:outline-none max-md:min-h-12 {mode ===
      'manager'
        ? 'border-ring/60 ring-ring/40 ring-1'
        : ''}"
    >
      <button
        type="button"
        class="hover:bg-accent/50 focus-visible:ring-ring flex shrink-0 items-center gap-0.5 rounded-xl transition-colors focus-visible:ring-1 focus-visible:outline-none"
        data-mode={mode}
        onclick={() => void toggleMode()}
        title={mode === 'search' ? 'Switch to the manager (AI)' : 'Switch to search'}
        aria-label={mode === 'search' ? 'Switch to the manager' : 'Switch to search'}
      >
        <span
          class="flex size-9 items-center justify-center rounded-[11px] transition-colors max-md:size-10 {mode === 'search'
            ? 'bg-primary/15 text-foreground'
            : 'text-muted-foreground'}"
        >
          <Search class="size-4 max-md:size-5" />
        </span>
        <span
          class="flex size-9 items-center justify-center rounded-[11px] transition-colors max-md:size-10 {mode === 'manager'
            ? 'bg-sidebar-primary text-sidebar-primary-foreground'
            : 'text-muted-foreground'}"
        >
          <Sparkles class="size-4 max-md:size-5" />
        </span>
      </button>

      {#if mode === 'search'}
        <input
          bind:this={searchEl}
          bind:value={search}
          placeholder="Search folders"
          aria-label="Search folders"
          class="text-foreground placeholder:text-muted-foreground w-full min-w-0 bg-transparent text-sm outline-none max-md:text-base"
        />
      {:else}
        <textarea
          bind:this={managerEl}
          bind:value={managerDraft}
          onkeydown={handleKeydown}
          rows={1}
          placeholder="Ask the manager — start sessions, archive old ones, check status…"
          autocapitalize="sentences"
          enterkeyhint="send"
          spellcheck={!isMobileViewport()}
          aria-label="Message the manager"
          disabled={!managerReady}
          class="text-foreground placeholder:text-muted-foreground block max-h-40 w-full min-w-0 resize-none overflow-y-auto bg-transparent text-sm outline-none disabled:opacity-50 max-md:text-base"
        ></textarea>
        {#if canSend}
          <button
            class="bg-primary text-primary-foreground hover:bg-primary/80 active:bg-primary/70 flex shrink-0 items-center rounded-lg p-1.5 transition-colors max-md:p-2.5"
            onpointerdown={(e) => e.preventDefault()}
            onclick={() => void onSubmitManager?.(managerDraft)}
            title="Send"
          >
            <SendHorizontal class="size-4 max-md:size-5" />
          </button>
        {/if}
      {/if}
    </div>

    {#if mode === 'manager' && managerRoot}
      <!-- Old manager sessions: the collapsed strip takes near no vertical
           space; expanding opens a dropdown overlay below the box. -->
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground focus-visible:ring-ring mx-auto flex h-4 w-full items-center justify-center gap-1 text-[10px] tracking-widest uppercase transition-colors focus-visible:ring-1 focus-visible:outline-none"
        aria-expanded={sessionsOpen}
        onclick={() => (sessionsOpen = !sessionsOpen)}
      >
        <ChevronDown class="size-3 transition-transform {sessionsOpen ? 'rotate-180' : ''}" />
        Previous sessions
        <span class="normal-case tabular-nums">{managerSessions.length}</span>
      </button>
      {#if sessionsOpen}
        <div class="border-border bg-card absolute top-full right-0 left-0 z-30 mt-1 flex max-h-64 flex-col gap-1 overflow-y-auto rounded-xl border p-1 shadow-lg">
          {#each managerSessions as session (session.id)}
            <SessionItem {session} folderPath={managerRoot} />
          {/each}
        </div>
      {/if}
    {/if}
  </div>

  <Button
    size="sm"
    class="h-11 shrink-0 rounded-xl text-sm {compact ? 'w-12 px-0' : 'px-4 max-md:w-12 max-md:px-0'}"
    title="New session"
    aria-label="New session"
    onclick={() => (newSessionOpen = true)}
    disabled={connection.status !== 'connected'}
  >
    <Plus class={compact ? 'size-4' : 'size-3.5 max-md:size-5'} />
    <span class="max-md:hidden" class:hidden={compact}>New session</span>
  </Button>
</div>

<NewSessionDialog bind:open={newSessionOpen} />
