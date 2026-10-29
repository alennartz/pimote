<script lang="ts">
  import type { CommandInfo, AutocompleteResponseItem } from '@pimote/shared';
  import { fuzzyFilter } from '$lib/fuzzy.js';
  import { connection } from '$lib/stores/connection.svelte.js';

  interface Props {
    items: CommandInfo[];
    query: string;
    visible: boolean;
    mode: 'command' | 'args' | 'fileRefs';
    sessionId: string;
    commandName: string;
    onselect: (item: { name: string; value?: string; label?: string; description?: string }) => void;
    ondismiss: () => void;
  }

  let { items, query, visible, mode, sessionId, commandName, onselect, ondismiss }: Props = $props();

  let filteredCommands = $derived.by(() => {
    if (mode !== 'command') return [];
    return fuzzyFilter(items, query, (item) => item.name).slice(0, 10);
  });

  let serverItems: AutocompleteResponseItem[] = $state([]);
  let serverDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let serverRequestSeq = 0;

  $effect(() => {
    if ((mode !== 'args' && mode !== 'fileRefs') || !visible) return;
    const currentMode = mode;
    const currentQuery = query;
    const currentCommandName = commandName;
    const currentSessionId = sessionId;

    clearTimeout(serverDebounceTimer);
    serverDebounceTimer = setTimeout(async () => {
      const seq = ++serverRequestSeq;
      try {
        const res = await (currentMode === 'fileRefs'
          ? connection.send({
              type: 'complete_file_refs',
              sessionId: currentSessionId,
              prefix: currentQuery,
            })
          : connection.send({
              type: 'complete_args',
              sessionId: currentSessionId,
              commandName: currentCommandName,
              prefix: currentQuery,
            }));
        if (seq !== serverRequestSeq) return;
        if (res.success && res.data) {
          const result = (res.data as { items: AutocompleteResponseItem[] | null }).items;
          serverItems = result ?? [];
        } else {
          serverItems = [];
        }
      } catch {
        if (seq !== serverRequestSeq) return;
        serverItems = [];
      }
    }, 200);

    return () => clearTimeout(serverDebounceTimer);
  });

  let displayItems = $derived.by(() => {
    if (mode === 'command') {
      return filteredCommands.map((c) => ({
        name: c.name,
        description: c.description,
      }));
    }
    return serverItems.map((a) => ({
      name: a.label,
      value: a.value,
      description: a.description,
    }));
  });

  let highlightIndex = $state(0);
  $effect(() => {
    displayItems;
    highlightIndex = 0;
  });

  let listEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!listEl) return;
    const idx = highlightIndex;
    const el = listEl.children[idx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  });

  export function moveUp(): boolean {
    if (displayItems.length === 0) return false;
    highlightIndex = highlightIndex <= 0 ? displayItems.length - 1 : highlightIndex - 1;
    return true;
  }

  export function moveDown(): boolean {
    if (displayItems.length === 0) return false;
    highlightIndex = highlightIndex >= displayItems.length - 1 ? 0 : highlightIndex + 1;
    return true;
  }

  export function accept(): boolean {
    const item = displayItems[highlightIndex];
    if (!item) return false;
    onselect(item);
    return true;
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
