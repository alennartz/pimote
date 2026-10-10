<script lang="ts">
  import { connection } from '$lib/stores/connection.svelte.js';
  import { folderStore } from '$lib/stores/folder-store.svelte.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import FolderCreatorWizard from './FolderCreatorWizard.svelte';

  /** Controlled open state — the homepage toolbar owns the trigger. */
  let { open = $bindable(false) }: { open?: boolean } = $props();

  let query = $state('');
  /** The wizard took over the dialog body — the picker hides until the dialog reopens. */
  let wizardActive = $state(false);

  function reset(): void {
    query = '';
    wizardActive = false;
  }

  // Every close path funnels through handleOpenChange and resets; this effect
  // covers a programmatic open so the picker always starts fresh regardless.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) reset();
    wasOpen = open;
  });

  function handleOpenChange(value: boolean): void {
    open = value;
    if (!value) reset();
  }

  // Client-side picker over discovered folders — independent of the
  // homepage search so opening it never disturbs the list behind it. Persona
  // folders match on their display name too.
  const pickerFolders = $derived(
    [...folderStore.folders]
      .filter((folder) => {
        const needle = query.trim().toLowerCase();
        if (!needle) return true;
        return folder.name.toLowerCase().includes(needle) || (folder.persona?.name ?? '').toLowerCase().includes(needle) || folder.path.toLowerCase().includes(needle);
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
  );

  /** Persona folders lead with the persona's display name; code folders keep the basename. */
  function pickerLabel(folder: { name: string; persona?: { name?: string } }): string {
    return folder.persona?.name ?? folder.name;
  }

  async function newSession(folderPath: string): Promise<void> {
    handleOpenChange(false);
    try {
      await connection.send({ type: 'open_session', folderPath });
    } catch (e) {
      console.error('Failed to create new session:', e);
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Start a new session</Dialog.Title>
      <Dialog.Description>Pick a folder, or create one above. Search is client-side over discovered folders.</Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-col gap-4">
      <FolderCreatorWizard onDone={() => handleOpenChange(false)} onActiveChange={(active) => (wizardActive = active)} />

      {#if !wizardActive}
        <Input bind:value={query} placeholder="Search folders" autofocus />

        <div class="border-border max-h-80 overflow-y-auto rounded-md border">
          {#if pickerFolders.length === 0}
            <div class="text-muted-foreground px-3 py-6 text-center text-sm">No matching folders.</div>
          {:else}
            <div class="flex flex-col p-1">
              {#each pickerFolders as folder (folder.path)}
                <button
                  class="hover:bg-accent hover:text-accent-foreground flex items-start gap-2 rounded-md px-3 py-2 text-left transition-colors"
                  disabled={connection.status !== 'connected'}
                  onclick={() => void newSession(folder.path)}
                >
                  <FolderIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-medium">{pickerLabel(folder)}</div>
                    <div class="text-muted-foreground truncate text-xs">{folder.path}</div>
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <Dialog.Footer class="flex gap-2">
        <div class="flex-1"></div>
        <Button variant="outline" type="button" onclick={() => handleOpenChange(false)}>Cancel</Button>
      </Dialog.Footer>
    </div>
  </Dialog.Content>
</Dialog.Root>
