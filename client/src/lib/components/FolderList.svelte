<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { indexStore } from '$lib/stores/index-store.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { buildSessionProjectGroups } from '$lib/session-list-groups.js';
  import { formatRelativeTime } from '$lib/format-relative-time.js';
  import SessionItem from './SessionItem.svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import Loader2 from '@lucide/svelte/icons/loader-2';
  import Plus from '@lucide/svelte/icons/plus';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  interface Props {
    onSessionSelect?: () => void;
  }

  let { onSessionSelect }: Props = $props();

  let collapsedFolders = new SvelteSet<string>();
  let expandedSessionLists = new SvelteSet<string>();

  const MAX_SESSIONS_SHOWN = 6;

  let loadedFoldersForCurrentConnection = false;
  let showNewSessionDialog = $state(false);
  let projectSearch = $state('');

  const projectGroups = $derived(buildSessionProjectGroups(indexStore.folders, indexStore.sessions));
  const pickerProjects = $derived(
    [...indexStore.folders]
      .filter((folder) => {
        const query = projectSearch.trim().toLowerCase();
        if (!query) return true;
        return folder.name.toLowerCase().includes(query) || folder.path.toLowerCase().includes(query);
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
  );

  onMount(() => {
    const unsub = connection.onEvent((event) => {
      if (event.type === 'session_state_changed') {
        indexStore.applySessionStateChange(event, connection.clientId);
      } else if (event.type === 'session_deleted') {
        indexStore.applySessionDeleted(event);
      } else if (event.type === 'session_renamed') {
        indexStore.applySessionRenamed(event);
      } else if (event.type === 'session_archived') {
        indexStore.applySessionArchived(event);
      }
    });

    return unsub;
  });

  $effect(() => {
    const status = connection.status;

    if (status === 'connected') {
      if (!loadedFoldersForCurrentConnection) {
        loadedFoldersForCurrentConnection = true;
        untrack(() => {
          void indexStore.loadFolders();
        });
      }
      return;
    }

    loadedFoldersForCurrentConnection = false;
  });

  function toggleFolder(path: string) {
    if (collapsedFolders.has(path)) {
      collapsedFolders.delete(path);
    } else {
      collapsedFolders.add(path);
    }
  }

  function toggleSessionList(path: string) {
    if (expandedSessionLists.has(path)) {
      expandedSessionLists.delete(path);
    } else {
      expandedSessionLists.add(path);
    }
  }

  function openNewSessionDialog() {
    projectSearch = '';
    showNewSessionDialog = true;
  }

  function handleNewSessionDialogOpenChange(open: boolean) {
    showNewSessionDialog = open;
    if (!open) {
      projectSearch = '';
    }
  }

  async function newSession(folderPath: string) {
    try {
      showNewSessionDialog = false;
      projectSearch = '';
      onSessionSelect?.();
      await connection.send({
        type: 'open_session',
        folderPath,
      });
    } catch (e) {
      console.error('Failed to create new session:', e);
    }
  }
</script>

<div class="flex flex-col gap-2 p-2">
  {#if indexStore.loading}
    <div class="text-muted-foreground flex items-center justify-center py-8">
      <Loader2 class="size-5 animate-spin" />
      <span class="ml-2 text-sm">Loading sessions…</span>
    </div>
  {:else if indexStore.folders.length === 0}
    <div class="text-muted-foreground px-3 py-8 text-center text-sm">
      {#if connection.status !== 'connected'}
        Connecting to server…
      {:else}
        No folders configured
      {/if}
    </div>
  {:else}
    <div class="flex items-center gap-2 px-1">
      <Button class="flex-1 justify-center" onclick={openNewSessionDialog} disabled={connection.status !== 'connected'}>
        <Plus class="size-4" />
        New session
      </Button>
      <label class="text-muted-foreground hover:text-sidebar-foreground flex items-center gap-2 px-2 py-1 text-xs whitespace-nowrap">
        <input type="checkbox" checked={indexStore.showArchived} onchange={(e) => indexStore.setShowArchived((e.currentTarget as HTMLInputElement).checked)} />
        <span>Show archived</span>
      </label>
    </div>

    {#if projectGroups.length === 0}
      <div class="text-muted-foreground px-3 py-8 text-center text-sm">
        {#if indexStore.showArchived}
          No archived or active sessions yet.
        {:else}
          No sessions yet.
        {/if}
      </div>
    {:else}
      <div class="flex flex-col gap-1">
        {#each projectGroups as group (group.folder.path)}
          {@const expanded = !collapsedFolders.has(group.folder.path)}
          {@const showAll = expandedSessionLists.has(group.folder.path)}
          {@const visibleSessions = showAll ? group.sessions : group.sessions.slice(0, MAX_SESSIONS_SHOWN)}
          {@const hiddenCount = Math.max(0, group.sessions.length - MAX_SESSIONS_SHOWN)}

          <div class="rounded-lg">
            <div class="flex items-center gap-1">
              <button
                class="hover:bg-sidebar-accent active:bg-sidebar-accent/80 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors active:scale-[0.97]"
                onclick={() => toggleFolder(group.folder.path)}
              >
                <ChevronRight class="text-muted-foreground size-4 shrink-0 transition-transform {expanded ? 'rotate-90' : ''}" />
                <FolderIcon class="text-muted-foreground size-4 shrink-0" />
                <div class="min-w-0 flex-1">
                  <div class="text-sidebar-foreground flex items-center gap-2 truncate text-sm font-medium">
                    <span class="truncate">{group.folder.name}</span>
                    {#if group.folder.activeSessionCount > 0}
                      <span class="bg-status-connected size-2 shrink-0 rounded-full"></span>
                    {/if}
                  </div>
                  <div class="text-muted-foreground mt-0.5 truncate text-xs">
                    {group.sessions.length} session{group.sessions.length !== 1 ? 's' : ''} · updated {formatRelativeTime(group.lastModified)}
                  </div>
                </div>
              </button>

              <Button
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground hover:text-sidebar-foreground shrink-0"
                title="New session in {group.folder.name}"
                disabled={connection.status !== 'connected'}
                onclick={(e) => {
                  e.stopPropagation();
                  void newSession(group.folder.path);
                }}
              >
                <Plus class="size-4" />
              </Button>
            </div>

            {#if expanded}
              <div class="border-sidebar-border ml-4 flex flex-col gap-0.5 border-l pt-1 pl-2">
                {#each visibleSessions as session (session.id)}
                  <SessionItem {session} folderPath={group.folder.path} {onSessionSelect} />
                {/each}

                {#if hiddenCount > 0 && !showAll}
                  <button
                    class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground rounded-md px-3 py-1.5 text-xs transition-colors"
                    onclick={() => toggleSessionList(group.folder.path)}
                  >
                    Show {hiddenCount} more session{hiddenCount !== 1 ? 's' : ''}
                  </button>
                {:else if showAll && hiddenCount > 0}
                  <button
                    class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground rounded-md px-3 py-1.5 text-xs transition-colors"
                    onclick={() => toggleSessionList(group.folder.path)}
                  >
                    Show fewer sessions
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<Dialog.Root open={showNewSessionDialog} onOpenChange={handleNewSessionDialogOpenChange}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Start a new session</Dialog.Title>
      <Dialog.Description>Choose a project to start from. Search is client-side over discovered folders.</Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-col gap-4">
      <Input bind:value={projectSearch} placeholder="Search projects" autofocus />

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

      <Dialog.Footer>
        <Button variant="outline" type="button" onclick={() => handleNewSessionDialogOpenChange(false)}>Cancel</Button>
      </Dialog.Footer>
    </div>
  </Dialog.Content>
</Dialog.Root>
