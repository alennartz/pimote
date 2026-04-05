<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { indexStore } from '$lib/stores/index-store.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import SessionItem from './SessionItem.svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import Plus from '@lucide/svelte/icons/plus';
  import Loader2 from '@lucide/svelte/icons/loader-2';

  interface Props {
    onSessionSelect?: () => void;
  }

  let { onSessionSelect }: Props = $props();

  let expandedFolders = new SvelteSet<string>();
  let expandedSessionLists = new SvelteSet<string>();

  const MAX_SESSIONS_SHOWN = 6;

  let loadedFoldersForCurrentConnection = false;

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

  // Load folders once per connected period.
  // untrack prevents this effect from accidentally subscribing to IndexStore reads
  // inside loadFolders(), which can create a rerun loop.
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
    if (expandedFolders.has(path)) {
      expandedFolders.delete(path);
    } else {
      expandedFolders.add(path);
      // Load sessions for newly expanded folder
      indexStore.loadSessions(path);
    }
  }

  function toggleSessionList(path: string) {
    if (expandedSessionLists.has(path)) {
      expandedSessionLists.delete(path);
    } else {
      expandedSessionLists.add(path);
    }
  }

  async function newSession(folderPath: string) {
    try {
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

<div class="flex flex-col gap-1 p-2">
  <label class="text-muted-foreground hover:text-sidebar-foreground mb-1 flex items-center gap-2 px-2 py-1 text-xs">
    <input type="checkbox" checked={indexStore.showArchived} onchange={(e) => indexStore.setShowArchived((e.currentTarget as HTMLInputElement).checked)} />
    <span>Show archived</span>
  </label>
  {#if indexStore.loading}
    <div class="text-muted-foreground flex items-center justify-center py-8">
      <Loader2 class="size-5 animate-spin" />
      <span class="ml-2 text-sm">Loading folders…</span>
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
    {#each indexStore.folders as folder (folder.path)}
      {@const expanded = expandedFolders.has(folder.path)}
      {@const sessions = indexStore.sessions.get(folder.path) ?? []}

      <div class="rounded-lg">
        <!-- Folder header -->
        <button
          class="hover:bg-sidebar-accent active:bg-sidebar-accent/80 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors active:scale-[0.97]"
          onclick={() => toggleFolder(folder.path)}
        >
          <ChevronRight class="text-muted-foreground size-4 shrink-0 transition-transform {expanded ? 'rotate-90' : ''}" />
          <FolderIcon class="text-muted-foreground size-4 shrink-0" />
          <div class="min-w-0 flex-1">
            <div class="text-sidebar-foreground truncate text-sm font-medium">
              {folder.name}
            </div>
          </div>
          {#if folder.activeSessionCount > 0}
            <span class="bg-status-connected size-2 shrink-0 rounded-full"></span>
          {/if}
        </button>

        <!-- Expanded content: sessions -->
        {#if expanded}
          <div class="border-sidebar-border ml-4 flex flex-col gap-0.5 border-l pt-1 pl-2">
            <!-- New session button at top -->
            <button
              class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground active:bg-sidebar-accent/80 flex items-center gap-2 rounded-md px-3 py-1.5 text-xs transition-colors active:scale-[0.97]"
              onclick={() => newSession(folder.path)}
            >
              <Plus class="size-3.5" />
              New session
            </button>

            {#if sessions.length === 0}
              <div class="text-muted-foreground px-3 py-2 text-xs">No sessions</div>
            {:else}
              {@const showAll = expandedSessionLists.has(folder.path)}
              {@const visibleSessions = showAll ? sessions : sessions.slice(0, MAX_SESSIONS_SHOWN)}
              {@const hiddenCount = Math.max(0, sessions.length - MAX_SESSIONS_SHOWN)}

              {#each visibleSessions as session (session.id)}
                <SessionItem {session} folderPath={folder.path} {onSessionSelect} />
              {/each}

              {#if hiddenCount > 0 && !showAll}
                <button
                  class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground rounded-md px-3 py-1.5 text-xs transition-colors"
                  onclick={() => toggleSessionList(folder.path)}
                >
                  Show {hiddenCount} more session{hiddenCount !== 1 ? 's' : ''}
                </button>
              {:else if showAll && hiddenCount > 0}
                <button
                  class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground rounded-md px-3 py-1.5 text-xs transition-colors"
                  onclick={() => toggleSessionList(folder.path)}
                >
                  Show fewer sessions
                </button>
              {/if}
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>
