<script lang="ts">
  import { connection } from '$lib/stores/connection.svelte.js';
  import { projectStore } from '$lib/stores/project-store.svelte.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import Loader2 from '@lucide/svelte/icons/loader-2';
  import Plus from '@lucide/svelte/icons/plus';

  /** Controlled open state — the homepage toolbar owns the trigger. */
  let { open = $bindable(false) }: { open?: boolean } = $props();

  type DialogMode = 'pick' | 'create-root' | 'create-name';
  let mode: DialogMode = $state('pick');
  let query = $state('');
  let createRoot: string = $state('');
  let createName: string = $state('');
  let createError: string = $state('');
  let creating: boolean = $state(false);

  function reset(): void {
    mode = 'pick';
    query = '';
    createRoot = '';
    createName = '';
    createError = '';
    creating = false;
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

  // Client-side picker over discovered projects — independent of the
  // homepage search so opening it never disturbs the list behind it.
  const pickerProjects = $derived(
    [...projectStore.projects]
      .filter((folder) => {
        const needle = query.trim().toLowerCase();
        if (!needle) return true;
        return folder.name.toLowerCase().includes(needle) || folder.path.toLowerCase().includes(needle);
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
  );

  function startCreateProject(): void {
    const roots = projectStore.roots;
    if (roots.length === 1) {
      createRoot = roots[0];
      mode = 'create-name';
    } else {
      mode = 'create-root';
    }
    createName = '';
    createError = '';
  }

  function selectRoot(root: string): void {
    createRoot = root;
    mode = 'create-name';
    createName = '';
    createError = '';
  }

  function backToPickMode(): void {
    mode = 'pick';
    createRoot = '';
    createName = '';
    createError = '';
  }

  function backToRootSelection(): void {
    mode = 'create-root';
    createName = '';
    createError = '';
  }

  function validateProjectName(name: string): string | null {
    if (!name.trim()) return 'Name is required';
    if (name.includes('/') || name.includes('\\')) return 'Name cannot contain path separators';
    if (name === '.' || name === '..') return 'Invalid name';
    return null;
  }

  async function createProject(): Promise<void> {
    const name = createName.trim();
    const validationError = validateProjectName(name);
    if (validationError) {
      createError = validationError;
      return;
    }

    creating = true;
    createError = '';

    try {
      const response = await connection.send({
        type: 'create_project',
        root: createRoot,
        name,
      });

      if (!response.success) {
        createError = response.error ?? 'Failed to create project';
        creating = false;
        return;
      }

      const folderPath = (response.data as { folderPath: string }).folderPath;
      // Refresh project list so the new project appears
      void projectStore.loadProjects();
      await connection.send({ type: 'open_session', folderPath });
      handleOpenChange(false);
    } catch (e) {
      createError = e instanceof Error ? e.message : 'Failed to create project';
      creating = false;
    }
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
    {#if mode === 'pick'}
      <Dialog.Header>
        <Dialog.Title>Start a new session</Dialog.Title>
        <Dialog.Description>Choose a project to start from. Search is client-side over discovered projects.</Dialog.Description>
      </Dialog.Header>

      <div class="flex flex-col gap-4">
        <Input bind:value={query} placeholder="Search projects" autofocus />

        <div class="border-border max-h-80 overflow-y-auto rounded-md border">
          {#if pickerProjects.length === 0}
            <div class="text-muted-foreground px-3 py-6 text-center text-sm">No matching projects.</div>
          {:else}
            <div class="flex flex-col p-1">
              {#each pickerProjects as folder (folder.path)}
                <button
                  class="hover:bg-accent hover:text-accent-foreground flex items-start gap-2 rounded-md px-3 py-2 text-left transition-colors"
                  disabled={connection.status !== 'connected'}
                  onclick={() => void newSession(folder.path)}
                >
                  <FolderIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-medium">{folder.name}</div>
                    <div class="text-muted-foreground truncate text-xs">{folder.path}</div>
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <Dialog.Footer class="flex gap-2">
          {#if projectStore.roots.length > 0}
            <Button variant="outline" onclick={startCreateProject}>
              <Plus class="size-4" />
              Create new project
            </Button>
          {/if}
          <div class="flex-1"></div>
          <Button variant="outline" type="button" onclick={() => handleOpenChange(false)}>Cancel</Button>
        </Dialog.Footer>
      </div>
    {:else if mode === 'create-root'}
      <Dialog.Header>
        <Dialog.Title>Create new project</Dialog.Title>
        <Dialog.Description>Choose where to create the project.</Dialog.Description>
      </Dialog.Header>

      <div class="flex flex-col gap-4">
        <div class="border-border max-h-80 overflow-y-auto rounded-md border">
          <div class="flex flex-col p-1">
            {#each projectStore.roots as root (root)}
              <button class="hover:bg-accent hover:text-accent-foreground flex items-start gap-2 rounded-md px-3 py-2 text-left transition-colors" onclick={() => selectRoot(root)}>
                <FolderIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium">{root}</div>
                </div>
              </button>
            {/each}
          </div>
        </div>

        <Dialog.Footer>
          <Button variant="outline" onclick={backToPickMode}>Back</Button>
        </Dialog.Footer>
      </div>
    {:else if mode === 'create-name'}
      <Dialog.Header>
        <Dialog.Title>Create new project</Dialog.Title>
        <Dialog.Description>New project in <code class="bg-muted rounded px-1 py-0.5 text-xs">{createRoot}</code></Dialog.Description>
      </Dialog.Header>

      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <Input
            bind:value={createName}
            placeholder="Project name"
            autofocus
            disabled={creating}
            onkeydown={(e) => {
              if (e.key === 'Enter') void createProject();
            }}
          />
          {#if createError}
            <p class="text-destructive text-sm">{createError}</p>
          {/if}
        </div>

        <Dialog.Footer>
          <Button variant="outline" onclick={projectStore.roots.length > 1 ? backToRootSelection : backToPickMode} disabled={creating}>Back</Button>
          <Button onclick={() => void createProject()} disabled={creating || !createName.trim()}>
            {#if creating}
              <Loader2 class="size-4 animate-spin" />
              Creating…
            {:else}
              Create
            {/if}
          </Button>
        </Dialog.Footer>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
