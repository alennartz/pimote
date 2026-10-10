<script lang="ts">
  import type { FolderInfo } from '@pimote/shared';
  import FolderNatureIcon, { folderIconKind } from './FolderNatureIcon.svelte';

  /**
   * Checkbox picker of candidate folders shared by the folder creation wizard
   * and the hub members dialog. The caller pre-filters current members and
   * owns the selection: rows reflect `selectedPaths` and report toggles by
   * folder path through `onToggle`.
   */
  let {
    candidates,
    selectedPaths,
    onToggle,
  }: {
    candidates: FolderInfo[];
    selectedPaths: string[];
    onToggle: (path: string) => void;
  } = $props();

  function displayName(folder: FolderInfo): string {
    return folder.persona?.name ?? folder.name;
  }
</script>

{#if candidates.length === 0}
  <div class="text-muted-foreground px-3 py-2 text-sm">No folders available.</div>
{:else}
  <div class="border-border max-h-60 overflow-y-auto rounded-md border">
    <div class="flex flex-col p-1">
      {#each candidates as candidate (candidate.path)}
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
