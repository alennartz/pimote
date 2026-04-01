<script lang="ts">
  import type { CommandInfo, AutocompleteResponseItem } from '@pimote/shared';
  import { fuzzyFilter } from '$lib/fuzzy.js';
  import { connection } from '$lib/stores/connection.svelte.js';

  interface Props {
    items: CommandInfo[];
    query: string;
    visible: boolean;
    mode: 'command' | 'args';
    sessionId: string;
    commandName: string;
    onselect: (item: { name: string; value?: string; label?: string; description?: string }) => void;
    ondismiss: () => void;
  }

  let { items, query, visible, mode, sessionId, commandName, onselect, ondismiss }: Props = $props();

  // Command mode: fuzzy-filtered items
  let filteredCommands = $derived.by(() => {
    if (mode !== 'command') return [];
    return fuzzyFilter(items, query, (item) => item.name).slice(0, 10);
  });

  // Args mode: server-fetched completion items
  let argsItems: AutocompleteResponseItem[] = $state([]);
  let argsDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let argsRequestSeq = 0;

  // Fetch arg completions on query change in args mode
  $effect(() => {
    if (mode !== 'args' || !visible) return;
    const currentQuery = query;
    const currentCommandName = commandName;
    const currentSessionId = sessionId;

    clearTimeout(argsDebounceTimer);
    argsDebounceTimer = setTimeout(async () => {
      const seq = ++argsRequestSeq;
      try {
        const res = await connection.send({
          type: 'complete_args',
          sessionId: currentSessionId,
          commandName: currentCommandName,
          prefix: currentQuery,
        });
        // Discard stale responses — a newer request has been sent
        if (seq !== argsRequestSeq) return;
        if (res.success && res.data) {
          const result = (res.data as { items: AutocompleteResponseItem[] | null }).items;
          argsItems = result ?? [];
        } else {
          argsItems = [];
        }
      } catch {
        if (seq !== argsRequestSeq) return;
        argsItems = [];
      }
    }, 200);

    return () => clearTimeout(argsDebounceTimer);
  });

  // The display list depends on the mode
  let displayItems = $derived.by(() => {
    if (mode === 'command') {
      return filteredCommands.map((c) => ({
        name: c.name,
        description: c.description,
      }));
    }
    return argsItems.map((a) => ({
      name: a.label,
      value: a.value,
      description: a.description,
    }));
  });

  // Highlight index, reset when list changes
  let highlightIndex = $state(0);
  $effect(() => {
    // Re-run whenever the display items change
    displayItems;
    highlightIndex = 0;
  });

  // Keep scrolled into view
  let listEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!listEl) return;
    const idx = highlightIndex;
    const el = listEl.children[idx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  });

  export function moveUp() {
    if (displayItems.length === 0) return;
    highlightIndex = highlightIndex <= 0 ? displayItems.length - 1 : highlightIndex - 1;
  }

  export function moveDown() {
    if (displayItems.length === 0) return;
    highlightIndex = highlightIndex >= displayItems.length - 1 ? 0 : highlightIndex + 1;
  }

  export function accept() {
    const item = displayItems[highlightIndex];
    if (item) {
      onselect(item);
    }
  }

  export function dismiss() {
    ondismiss();
  }
</script>

{#if visible && displayItems.length > 0}
  <div
    class="bg-popover text-popover-foreground border-border absolute right-0 bottom-full left-0 z-50 mb-1 max-h-64 overflow-y-auto rounded-lg border shadow-md"
    bind:this={listEl}
  >
    {#each displayItems as item, i (item.name + '-' + i)}
      <button
        class="flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm transition-colors {i === highlightIndex ? 'bg-accent' : 'hover:bg-accent/50'}"
        onpointerdown={(e) => e.preventDefault()}
        onclick={() => {
          highlightIndex = i;
          accept();
        }}
      >
        <span class="shrink-0 font-medium">{item.name}</span>
        {#if item.description}
          <span class="text-muted-foreground truncate text-xs">{item.description}</span>
        {/if}
      </button>
    {/each}
  </div>
{/if}
