<script lang="ts">
  import { untrack } from 'svelte';
  import type { FolderInfo } from '@pimote/shared';
  import { Input } from '$lib/components/ui/input/index.js';
  import FolderNatureIcon, { folderIconKind } from './FolderNatureIcon.svelte';

  /**
   * Checkbox picker of candidate folders shared by the folder creation wizard
   * and the hub members dialog. The caller pre-filters candidates and owns
   * the selection: rows reflect `selectedPaths` and report toggles by folder
   * path through `onToggle`. With `search`, typing queries the server through
   * the caller (which pre-filters results like `candidates`), so any
   * discovered folder is pickable regardless of the fetched window.
   */
  let {
    candidates,
    selectedPaths,
    onToggle,
    search,
  }: {
    candidates: FolderInfo[];
    selectedPaths: string[];
    onToggle: (path: string) => void;
    search?: (query: string) => Promise<FolderInfo[]>;
  } = $props();

  let query = $state('');
  let results = $state<FolderInfo[]>([]);
  let searching = $state(false);
  let searchToken = 0;

  const active = $derived(search !== undefined && query.trim() !== '');
  const rows = $derived(active ? results : candidates);

  /** A query replaces the shown set with the caller-filtered server matches. */
  async function runSearch(): Promise<void> {
    const token = ++searchToken;
    if (!search || query.trim() === '') {
      results = [];
      searching = false;
      return;
    }
    searching = true;
    const found = await search(query);
    if (token !== searchToken) return;
    results = found;
    searching = false;
  }

  $effect(() => {
    query;
    untrack(() => void runSearch());
  });

  function displayName(folder: FolderInfo): string {
    return folder.persona?.name ?? folder.name;
  }
</script>

<div class="flex flex-col gap-2">
  {#if search}
    <Input bind:value={query} placeholder="Search folders" />
  {/if}

  {#if rows.length === 0}
    <div class="text-muted-foreground px-3 py-2 text-sm">{searching ? 'Searching…' : active ? 'No folders match.' : 'No folders available.'}</div>
  {:else}
    <div class="border-border max-h-60 overflow-y-auto rounded-md border">
      <div class="flex flex-col p-1">
        {#each rows as candidate (candidate.path)}
          <button
            type="button"
            class="hover:bg-accent hover:text-accent-foreground flex items-center gap-2 rounded-md px-3 py-2 text-left transition-colors {selectedPaths.includes(candidate.path)
              ? 'bg-accent text-accent-foreground'
              : ''}"
            onclick={() => onToggle(candidate.path)}
          >
            <input type="checkbox" checked={selectedPaths.includes(candidate.path)} class="pointer-events-none" tabindex={-1} />
            <FolderNatureIcon kind={folderIconKind(candidate)} class="text-muted-foreground size-4 shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium">{displayName(candidate)}</div>
              <div class="text-muted-foreground truncate text-xs">{candidate.path}</div>
            </div>
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>
