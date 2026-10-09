<script lang="ts">
  import { untrack } from 'svelte';
  import { createVirtualizer, type SvelteVirtualizer } from '@tanstack/svelte-virtual';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import type { FolderInfo, SessionInfo } from '@pimote/shared';
  import { folderStore } from '$lib/stores/folder-store.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { AGENT_INSTRUCTIONS_PATH, fileEditorStore } from '$lib/stores/file-editor.svelte.js';
  import SessionItem from './SessionItem.svelte';
  import Archive from '@lucide/svelte/icons/archive';
  import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
  import FilePen from '@lucide/svelte/icons/file-pen';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import Loader2 from '@lucide/svelte/icons/loader-2';
  import Network from '@lucide/svelte/icons/network';
  import Plus from '@lucide/svelte/icons/plus';
  import Star from '@lucide/svelte/icons/star';
  import Tag from '@lucide/svelte/icons/tag';
  import X from '@lucide/svelte/icons/x';
  import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '$lib/components/ui/context-menu/index.js';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuSeparator, DropdownMenuTrigger } from '$lib/components/ui/dropdown-menu/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  interface Props {
    /** Homepage search query — owned by the combined toolbar box at the top. */
    search?: string;
    scrollElement?: HTMLDivElement | null;
    onSessionSelect?: () => void;
  }

  let { search = '', scrollElement = null, onSessionSelect }: Props = $props();

  let openError = $state('');
  // Three-state folder expander: 'closed' (nothing), 'active' (half-open —
  // sessions open on this client plus sessions open but bound to another
  // client), 'all' (every session).
  // 'active' is the default. An active search overrides all of this so
  // session-level matches stay visible.
  type ExpandState = 'closed' | 'active' | 'all';
  let expandStates = new SvelteMap<string, ExpandState>();
  let expandedSessionLists = new SvelteSet<string>();

  // Folder row context menu (long-press on touch, right-click on desktop).
  // A long-press opens the menu while the finger is still down, so the release
  // would fire a click that toggles the row behind the menu — swallow it.
  let rowMenuPath = $state<string | null>(null);
  let suppressRowClick = false;
  let rowsEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    const el = rowsEl;
    if (!el) return;
    const swallow = (e: MouseEvent) => {
      if (!suppressRowClick) return;
      suppressRowClick = false;
      e.stopPropagation();
      e.preventDefault();
    };
    el.addEventListener('click', swallow, true);
    return () => el.removeEventListener('click', swallow, true);
  });

  function setRowMenu(path: string, open: boolean) {
    if (open) {
      rowMenuPath = path;
      suppressRowClick = true;
    } else if (rowMenuPath === path) {
      rowMenuPath = null;
      suppressRowClick = false;
    }
  }

  const MAX_SESSIONS_SHOWN = 6;

  /** Session ids open on this client — the local half of the half-open filter. */
  const activeSessionIds = $derived(new SvelteSet(sessionRegistry.activeSessions.map((s) => s.sessionId)));

  /** Half-open filter: a session is listed when it's open — held by this
   *  client (registry) or live in the server's memory. A live session bound
   *  to another client is open too, and the row's live badge counts it, so
   *  hiding it under the expander would contradict the header. */
  function isOpenSession(session: SessionInfo): boolean {
    return activeSessionIds.has(session.id) || session.liveStatus != null;
  }

  /** Row icon: nature × shortcut presence only. Shortcut-bearing rows get the
   *  hub variant even without hub registry membership — `repos` gates the
   *  membership chips and disband rights, never the icon. */
  function folderIconKind(folder: FolderInfo): 'code' | 'code-hub' | 'persona' | 'persona-hub' {
    const hub = folder.shortcutCount > 0;
    return folder.nature === 'persona' ? (hub ? 'persona-hub' : 'persona') : hub ? 'code-hub' : 'code';
  }

  /** Persona rows lead with the persona's display name; code rows keep the basename. */
  function displayName(folder: FolderInfo): string {
    return folder.persona?.name ?? folder.name;
  }

  /** Persona rows may carry a description as the row's subtitle line. */
  function subtitle(folder: FolderInfo): string | undefined {
    return folder.nature === 'persona' ? folder.persona?.description : undefined;
  }

  let showArchiveAllDialog = $state(false);

  // Create hub flow state
  let showHubDialog = $state(false);
  let hubName = $state('');
  let hubRoot = $state('');
  let hubMembers = new SvelteSet<string>();
  let hubError = $state('');
  let hubCreating = $state(false);

  // Disband confirmation state
  let disbandTarget = $state<FolderInfo | null>(null);

  // Add-tag dialog state
  let tagTarget = $state<FolderInfo | null>(null);
  let tagName = $state('');
  let tagError = $state('');

  function openTagDialog(folder: FolderInfo) {
    tagTarget = folder;
    tagName = '';
    tagError = '';
  }

  async function addTag() {
    const tag = tagName.trim();
    if (!tag || !tagTarget) return;
    const folder = tagTarget;
    tagTarget = null;
    await updateFolder(folder, { addTags: [tag] });
  }

  const displayFolders = $derived(folderStore.visibleFolders);
  const searching = $derived(search.trim().length > 0);
  let scrollMargin = $state(0);
  const requestedSessionLists = new SvelteSet<string>();
  const searchState = { query: untrack(() => folderStore.query) };
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => null,
    estimateSize: () => 76,
    overscan: 5,
    gap: 4,
  });
  const virtualItems = $derived($virtualizer.getVirtualItems());

  $effect(() => {
    const query = search.trim();
    if (query === searchState.query) return;
    searchState.query = query;
    untrack(() => void folderStore.search(query));
  });

  $effect(() => {
    const element = scrollElement;
    const folders = displayFolders;
    const margin = scrollMargin;
    untrack(() => {
      $virtualizer.setOptions({
        count: folders.length,
        getScrollElement: () => element,
        getItemKey: (index) => folders[index].path,
        scrollMargin: margin,
      });
    });
  });

  /** Observe the content above the list as well as viewport layout changes. */
  function observeListOffset(list: HTMLDivElement, scroller: HTMLDivElement) {
    const updateOffset = () => {
      scrollMargin = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop + scroller.scrollTop;
    };
    const observer = new ResizeObserver(updateOffset);
    observer.observe(list);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    updateOffset();
    return () => observer.disconnect();
  }

  $effect(() => {
    const list = rowsEl;
    const scroller = scrollElement;
    if (list && scroller) return observeListOffset(list, scroller);
  });

  /** TanStack's ResizeObserver measures expansion, tags, and subtitle changes. */
  function measureRow(node: HTMLDivElement, measurement: { instance: SvelteVirtualizer<HTMLDivElement, HTMLDivElement>; index: number }) {
    const instance = measurement.instance;
    instance.measureElement(node);
    return {
      update: () => instance.measureElement(node),
      destroy: () => instance.measureElement(null),
    };
  }

  function requestRenderedSessions(paths: readonly string[], includeArchived: boolean) {
    for (const path of paths) {
      const key = `${includeArchived}:${path}`;
      if (requestedSessionLists.has(key)) continue;
      requestedSessionLists.add(key);
      void folderStore.loadSessions(path);
    }
  }

  $effect(() => {
    if (connection.status !== 'connected') {
      untrack(() => requestedSessionLists.clear());
      return;
    }
    const paths = virtualItems
      .map((item) => displayFolders[item.index])
      .filter((folder) => folder && (searching || (expandStates.get(folder.path) ?? 'active') !== 'closed'))
      .map((folder) => folder.path);
    const includeArchived = folderStore.showArchived;
    untrack(() => requestRenderedSessions(paths, includeArchived));
  });

  $effect(() => {
    const lastItem = virtualItems.at(-1);
    if (connection.status === 'connected' && folderStore.more && lastItem && lastItem.index >= displayFolders.length - 10) {
      untrack(() => void folderStore.fetchNextWindow());
    }
  });

  function sessionsFor(folder: FolderInfo): SessionInfo[] {
    return folderStore.visibleSessions(folder.path);
  }
  const archivableCount = $derived(
    folderStore.folders.reduce((total, folder) => {
      const sessions = folderStore.sessions.get(folder.path) ?? [];
      return total + sessions.filter((s) => !s.archived && !s.liveStatus).length;
    }, 0),
  );
  const hubCandidateRepos = $derived(folderStore.repos.filter((repo) => !repo.missing));

  // Session/folder events are routed into the store at module scope
  // (folder-store.svelte.ts) for the app's lifetime, not per-mount.

  function toggleFolder(path: string) {
    // Cycle closed → active → all → closed… From closed, skip half-open when
    // nothing is open: half-open would render identical to closed, so the tap
    // would look dead.
    const current = expandStates.get(path) ?? 'active';
    if (current === 'active') {
      expandStates.set(path, 'all');
    } else if (current === 'all') {
      expandStates.set(path, 'closed');
    } else {
      const anyOpen = (folderStore.sessions.get(path) ?? []).some(isOpenSession);
      expandStates.set(path, anyOpen ? 'active' : 'all');
    }
  }

  function handleRowClick(folder: FolderInfo) {
    if (folder.missing) {
      void attemptOpen(folder.path);
      return;
    }
    toggleFolder(folder.path);
  }

  /** Row 2 (git status + tags) renders only when there's something to show. */
  function hasRepoInfo(folder: FolderInfo): boolean {
    if (folder.repos !== undefined) return folder.repos.length > 0;
    const repo = folder.repo;
    return !!repo && !repo.missing && !!repo.branch;
  }

  function toggleSessionList(path: string) {
    if (expandedSessionLists.has(path)) {
      expandedSessionLists.delete(path);
    } else {
      expandedSessionLists.add(path);
    }
  }

  function validateFolderName(name: string): string | null {
    if (!name.trim()) return 'Name is required';
    if (name.includes('/') || name.includes('\\')) return 'Name cannot contain path separators';
    if (name === '.' || name === '..') return 'Invalid name';
    return null;
  }

  /** Open attempt against a (possibly virtual) folder: the server awaits the
   *  source's onFolderOpen hooks before opening the session. */
  async function attemptOpen(folderPath: string) {
    openError = '';
    try {
      const response = await connection.send({ type: 'open_session', folderPath });
      if (!response.success) openError = response.error ?? 'Failed to open folder';
    } catch (e) {
      openError = e instanceof Error ? e.message : 'Failed to open folder';
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

  async function archiveAll() {
    showArchiveAllDialog = false;
    try {
      await Promise.all(
        folderStore.folders.map((folder) => {
          const sessions = folderStore.sessions.get(folder.path) ?? [];
          const ids = sessions.filter((s) => !s.archived && !s.liveStatus).map((s) => s.id);
          if (ids.length === 0) return;
          return connection.send({
            type: 'archive_session',
            folderPath: folder.path,
            sessionIds: ids,
            archived: true,
          });
        }),
      );
    } catch (e) {
      console.error('Failed to archive sessions:', e);
    }
  }

  /** Apply a curation patch; the store updates via the folders_changed broadcast. */
  async function updateFolder(folder: FolderInfo, patch: { favorite?: boolean; archived?: boolean; addTags?: string[]; removeTags?: string[] }) {
    try {
      await connection.send({ type: 'update_folder', folderPath: folder.path, ...patch });
    } catch (e) {
      console.error('Failed to update folder:', e);
    }
  }

  /** Disband attempt — like attemptOpen, a server rejection must surface. The
   *  dialog closes on send, but the response's failure is displayed, not
   *  swallowed (e.g. a source hub without persisted registry ownership). */
  async function disbandHub() {
    const target = disbandTarget;
    disbandTarget = null;
    if (!target) return;
    openError = '';
    try {
      const response = await connection.send({ type: 'disband_hub', folderPath: target.path });
      if (!response.success) openError = response.error ?? 'Failed to disband hub';
    } catch (e) {
      openError = e instanceof Error ? e.message : 'Failed to disband hub';
    }
  }

  function openHubDialog() {
    hubName = '';
    hubRoot = '';
    hubError = '';
    hubCreating = false;
    hubMembers.clear();
    showHubDialog = true;
    void folderStore.loadRepos();
  }

  function handleHubDialogOpenChange(open: boolean) {
    showHubDialog = open;
    if (!open) {
      hubName = '';
      hubRoot = '';
      hubError = '';
      hubCreating = false;
      hubMembers.clear();
    }
  }

  function toggleHubMember(path: string) {
    if (hubMembers.has(path)) {
      hubMembers.delete(path);
    } else {
      hubMembers.add(path);
    }
  }

  async function createHub() {
    const name = hubName.trim();
    const validationError = validateFolderName(name) ?? (!hubRoot ? 'Choose a root folder' : null) ?? (hubMembers.size === 0 ? 'Select at least one member repository' : null);
    if (validationError) {
      hubError = validationError;
      return;
    }

    hubCreating = true;
    hubError = '';

    try {
      const response = await connection.send({
        type: 'create_hub',
        name,
        root: hubRoot,
        memberPaths: [...hubMembers],
      });

      if (!response.success) {
        hubError = response.error ?? 'Failed to create hub';
        hubCreating = false;
        return;
      }

      handleHubDialogOpenChange(false);
    } catch (e) {
      hubError = e instanceof Error ? e.message : 'Failed to create hub';
      hubCreating = false;
    }
  }
</script>

<div class="flex flex-col gap-2 p-2 max-md:p-0">
  <!-- Section header + list actions. The former dashboard-side header lives here
       so the count and the ⋯ menu share one row. -->
  <div class="text-muted-foreground mb-1 -ml-2 flex items-center gap-2 max-md:ml-0">
    <h2 class="text-foreground text-xs font-semibold tracking-widest uppercase">Folders</h2>
    {#if folderStore.total > 0}
      <span class="text-xs">{folderStore.total}</span>
    {/if}
    <div class="ml-auto flex items-center gap-2">
      <Button
        variant="outline"
        size="icon-sm"
        class="text-muted-foreground shrink-0 max-md:size-11"
        title="Agent instructions"
        aria-label="Agent instructions"
        onclick={() => void fileEditorStore.openFile(AGENT_INSTRUCTIONS_PATH, 'Agent instructions')}
      >
        <FilePen class="size-4 max-md:size-5" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger>
          <Button variant="outline" size="icon-sm" class="text-muted-foreground shrink-0 max-md:size-11" title="More folder actions">
            <EllipsisVertical class="size-4 max-md:size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent class="w-52" align="end">
            <DropdownMenuItem class="gap-2" disabled={connection.status !== 'connected' || folderStore.roots.length === 0} onSelect={() => openHubDialog()}>
              <Network class="size-4" />
              Create hub…
            </DropdownMenuItem>
            <DropdownMenuItem class="gap-2" disabled={connection.status !== 'connected' || archivableCount === 0} onSelect={() => (showArchiveAllDialog = true)}>
              <Archive class="size-4" />
              Archive all inactive…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem class="gap-2" onSelect={() => folderStore.setShowArchived(!folderStore.showArchived)}>
              {#if folderStore.showArchived}
                <Undo2 class="size-4" />
                Hide archived
              {:else}
                <Archive class="size-4" />
                Show archived
              {/if}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>
    </div>
  </div>
  {#if folderStore.loading}
    <div class="text-muted-foreground flex items-center justify-center py-8">
      <Loader2 class="size-5 animate-spin" />
      <span class="ml-2 text-sm">Loading folders…</span>
    </div>
  {:else if folderStore.folders.length === 0}
    <div class="text-muted-foreground px-3 py-8 text-center text-sm">
      {#if connection.status !== 'connected'}
        Connecting to server…
      {:else}
        No folders configured
      {/if}
    </div>
  {:else}
    {#if openError}
      <p class="text-destructive px-1 text-xs">{openError}</p>
    {/if}

    {#if displayFolders.length === 0}
      <div class="text-muted-foreground px-3 py-8 text-center text-sm">
        {#if folderStore.showArchived}
          No folders.
        {:else}
          No folders yet. Archived folders are hidden.
        {/if}
      </div>
    {:else}
      <div class="relative w-full" style:height={`${$virtualizer.getTotalSize()}px`} bind:this={rowsEl}>
        {#each virtualItems as item (item.key)}
          {@const folder = displayFolders[item.index]}
          {@const expandState = searching ? 'all' : (expandStates.get(folder.path) ?? 'active')}
          {@const iconKind = folderIconKind(folder)}
          {@const hasTags = (folder.tags?.length ?? 0) > 0}
          {@const showAll = expandedSessionLists.has(folder.path)}
          {@const folderSessions = sessionsFor(folder)}
          {@const listedSessions = expandState === 'all' ? folderSessions : expandState === 'active' ? folderSessions.filter(isOpenSession) : []}
          {@const visibleSessions = showAll ? listedSessions : listedSessions.slice(0, MAX_SESSIONS_SHOWN)}
          {@const hiddenCount = Math.max(0, listedSessions.length - MAX_SESSIONS_SHOWN)}
          <!-- Half-open with nothing open renders no session block, so the row keeps
               its closed shape (bottom-rounded) instead of a dangling open corner. -->
          {@const showSessionBlock = expandState === 'all' || listedSessions.length > 0}

          <div
            class="border-border/60 absolute top-0 left-0 w-full rounded-lg"
            data-index={item.index}
            style:transform={`translateY(${item.start - scrollMargin}px)`}
            use:measureRow={{ instance: $virtualizer, index: item.index }}
          >
            <ContextMenu open={rowMenuPath === folder.path} onOpenChange={(open) => setRowMenu(folder.path, open)}>
              <!-- Whole-row expander: taps land here unless a control stops them.
                   Every control inside the trigger calls stopPropagation(). -->
              <ContextMenuTrigger
                class="group hover:bg-accent active:bg-accent/80 flex cursor-pointer flex-col transition-colors select-none {showSessionBlock ? 'rounded-t-lg' : 'rounded-lg'}"
                onclick={() => handleRowClick(folder)}
              >
                <div class="flex items-center gap-0.5">
                  <button
                    class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors max-md:min-h-12 max-md:gap-2 max-md:rounded-lg max-md:px-2 max-md:py-2"
                    title={folder.missing ? 'Open — its source will create this folder' : undefined}
                    aria-expanded={expandState !== 'closed'}
                  >
                    <!-- Four row icons: code / code-hub / persona / persona-hub,
                         selected only by nature × shortcutCount > 0. -->
                    {#if iconKind === 'code'}
                      <svg
                        class="text-muted-foreground size-4 shrink-0 max-md:size-5"
                        data-folder-icon="code"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="m8 6-5 6 5 6" />
                        <path d="m16 6 5 6-5 6" />
                        <path d="m13.5 4-3 16" />
                      </svg>
                    {:else if iconKind === 'code-hub'}
                      <svg
                        class="text-muted-foreground size-4 shrink-0 max-md:size-5"
                        data-folder-icon="code-hub"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <rect x="2.5" y="9" width="6" height="6" rx="1.5" />
                        <rect x="15.5" y="2.5" width="6" height="6" rx="1.5" />
                        <rect x="15.5" y="15.5" width="6" height="6" rx="1.5" />
                        <path d="M8.5 12h3.5v-6h3.5" />
                        <path d="M12 12v6h3.5" />
                      </svg>
                    {:else if iconKind === 'persona'}
                      <svg
                        class="text-muted-foreground size-4 shrink-0 max-md:size-5"
                        data-folder-icon="persona"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <circle cx="12" cy="8" r="3.5" />
                        <path d="M5 20a7 7 0 0 1 14 0" />
                      </svg>
                    {:else}
                      <svg
                        class="text-muted-foreground size-4 shrink-0 max-md:size-5"
                        data-folder-icon="persona-hub"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <circle cx="8" cy="7" r="3" />
                        <path d="M2 19.5a6 6 0 0 1 12 0" />
                        <circle cx="19.5" cy="5.5" r="1.75" />
                        <circle cx="19.5" cy="13.5" r="1.75" />
                        <path d="M11.2 6.2 17.7 5.3" />
                        <path d="M11.2 10.6 17.7 12.7" />
                      </svg>
                    {/if}
                    <span class="min-w-0 flex-1">
                      <span class="text-foreground block truncate text-[13px] font-medium max-md:text-base {folder.archived ? 'opacity-70' : ''}" data-folder-path={folder.path}
                        >{displayName(folder)}</span
                      >
                      {#if subtitle(folder)}
                        <span class="text-muted-foreground block truncate text-[11px]">{subtitle(folder)}</span>
                      {/if}
                    </span>
                    {#if folder.archived}
                      <span class="bg-muted text-muted-foreground shrink-0 rounded px-1 py-0.5 text-[10px] font-medium tracking-wide uppercase">Archived</span>
                    {/if}
                  </button>
                  <div class="ml-auto flex shrink-0 items-center gap-0.5">
                    <button
                      class="group/star flex shrink-0 items-center rounded p-1 transition-colors max-md:-m-1 max-md:p-2"
                      title={folder.favorite ? 'Unfavorite' : 'Favorite'}
                      aria-label={folder.favorite ? `Unfavorite ${displayName(folder)}` : `Favorite ${displayName(folder)}`}
                      onclick={(e) => {
                        e.stopPropagation();
                        void updateFolder(folder, { favorite: !folder.favorite });
                      }}
                    >
                      <Star
                        class="size-3 transition-colors max-md:size-4 {folder.favorite
                          ? 'fill-yellow-500 text-yellow-500'
                          : 'text-muted-foreground/40 group-hover/star:text-muted-foreground'}"
                      />
                    </button>
                    {#if folder.activeSessionCount > 0}
                      <span
                        class="flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-px text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400"
                        title={`${folder.activeSessionCount} open session${folder.activeSessionCount !== 1 ? 's' : ''}`}
                      >
                        <span class="bg-status-connected size-1.5 rounded-full"></span>
                        {folder.activeSessionCount}
                      </span>
                    {/if}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      class="text-muted-foreground hover:text-sidebar-foreground shrink-0 max-md:size-11"
                      title="New session in {displayName(folder)}"
                      disabled={connection.status !== 'connected'}
                      onclick={(e) => {
                        e.stopPropagation();
                        void newSession(folder.path);
                      }}
                    >
                      <Plus class="size-4 max-md:size-5" />
                    </Button>
                  </div>
                </div>
                {#if hasRepoInfo(folder) || hasTags}
                  <div class="chips flex flex-wrap items-center gap-1 pb-1 pl-1.5">
                    {#if folder.repos && folder.repos.length > 0}
                      {#each folder.repos as repo (repo.path)}
                        <span
                          class="bg-muted text-muted-foreground flex items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] {repo.missing
                            ? 'border border-yellow-500/20 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
                            : ''}"
                          title={repo.missing ? `${repo.name} is missing on disk` : repo.path}
                        >
                          {#if !repo.missing}
                            <span class="size-1.5 rounded-full {repo.dirty ? 'bg-yellow-500' : 'bg-muted-foreground/40'}" title={repo.dirty ? 'Uncommitted changes' : 'Clean'}
                            ></span>
                          {/if}
                          <span class="max-w-28 truncate">{repo.name}</span>
                          {#if repo.missing}
                            <span class="font-medium">missing</span>
                          {:else if repo.branch}
                            <span class="max-w-20 truncate opacity-70">{repo.branch}</span>
                          {/if}
                        </span>
                      {/each}
                    {:else}
                      {@const repo = folder.repo}
                      {#if repo && !repo.missing && repo.branch}
                        <span class="bg-muted text-muted-foreground flex items-center gap-1 rounded-full px-1.5 py-px text-[10.5px]" title={repo.path}>
                          <span class="size-1.5 rounded-full {repo.dirty ? 'bg-yellow-500' : 'bg-muted-foreground/40'}" title={repo.dirty ? 'Uncommitted changes' : 'Clean'}></span>
                          <span class="max-w-24 truncate">{repo.branch}</span>
                          {#if repo.ahead || repo.behind}
                            <span class="opacity-70">↑{repo.ahead}↓{repo.behind}</span>
                          {/if}
                        </span>
                      {/if}
                    {/if}
                    {#each folder.tags ?? [] as tag (tag)}
                      {@const removable = folder.userTags?.includes(tag) === true}
                      <span
                        class="flex items-center gap-0.5 rounded-full border px-1.5 py-px text-[10.5px] leading-none {removable
                          ? 'border-border bg-secondary text-secondary-foreground'
                          : 'border-border/60 bg-muted/60 text-muted-foreground'}"
                        title={removable ? `Tag: ${tag}` : `Tag from a folder source: ${tag}`}
                      >
                        {tag}
                        {#if removable}
                          <button
                            class="hover:text-destructive -mr-0.5 rounded-full p-px transition-colors"
                            aria-label="Remove tag {tag}"
                            onclick={(e) => {
                              e.stopPropagation();
                              void updateFolder(folder, { removeTags: [tag] });
                            }}
                          >
                            <X class="size-2.5" />
                          </button>
                        {/if}
                      </span>
                    {/each}
                    <button
                      class="border-border/60 text-muted-foreground hover:text-foreground hover:border-border hidden items-center gap-0.5 rounded-full border border-dashed px-1.5 py-px text-[10.5px] leading-none transition-colors group-hover:flex"
                      title="Add tag"
                      aria-label="Add tag to {displayName(folder)}"
                      onclick={(e) => {
                        e.stopPropagation();
                        openTagDialog(folder);
                      }}
                    >
                      <Plus class="size-2.5" />
                      tag
                    </button>
                  </div>
                {/if}
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  disabled={connection.status !== 'connected' || folder.missing}
                  onSelect={() => void fileEditorStore.openFolderInstructions(folder.path, displayName(folder))}
                >
                  <FilePen class="size-4" />
                  Edit AGENTS.md…
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => openTagDialog(folder)}>
                  <Tag class="size-4" />
                  Add tag…
                </ContextMenuItem>
                <!-- Registry/source hubs only: `repos` marks persisted hub
                     membership. A generic shortcut-bearing folder shows the hub
                     icon but gains no deletion rights. -->
                {#if folder.repos !== undefined}
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => (disbandTarget = folder)}>
                    <Trash2 class="size-4" />
                    Disband hub
                  </ContextMenuItem>
                {/if}
              </ContextMenuContent>
            </ContextMenu>

            {#if showSessionBlock}
              <div class="border-sidebar-border ml-4 flex flex-col gap-0.5 border-l pt-1 pl-2">
                {#each visibleSessions as session (session.id)}
                  <SessionItem {session} folderPath={folder.path} {onSessionSelect} />
                {/each}

                {#if folderSessions.length === 0}
                  <div class="text-muted-foreground px-3 py-1 text-xs">No sessions yet</div>
                {/if}

                {#if hiddenCount > 0 && !showAll}
                  <button
                    class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground rounded-md px-3 py-1.5 text-xs transition-colors max-md:min-h-11 max-md:text-[13px]"
                    onclick={() => toggleSessionList(folder.path)}
                  >
                    Show {hiddenCount} more session{hiddenCount !== 1 ? 's' : ''}
                  </button>
                {:else if showAll && hiddenCount > 0}
                  <button
                    class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground rounded-md px-3 py-1.5 text-xs transition-colors max-md:min-h-11 max-md:text-[13px]"
                    onclick={() => toggleSessionList(folder.path)}
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

<Dialog.Root
  open={tagTarget !== null}
  onOpenChange={(open) => {
    if (!open) tagTarget = null;
  }}
>
  <Dialog.Content class="sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title>Add tag</Dialog.Title>
      <Dialog.Description>Tag the folder <code class="bg-muted rounded px-1 py-0.5 text-xs">{tagTarget ? displayName(tagTarget) : ''}</code></Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-1.5">
      <Input
        bind:value={tagName}
        placeholder="Tag name"
        autofocus
        onkeydown={(e) => {
          if (e.key === 'Enter') void addTag();
        }}
      />
      {#if tagError}
        <p class="text-destructive text-sm">{tagError}</p>
      {/if}
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (tagTarget = null)}>Cancel</Button>
      <Button onclick={() => void addTag()} disabled={!tagName.trim()}>Add tag</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={showArchiveAllDialog}>
  <Dialog.Content showCloseButton={false}>
    <Dialog.Header>
      <Dialog.Title>Archive all inactive sessions</Dialog.Title>
      <Dialog.Description>
        This will archive {archivableCount} inactive session{archivableCount !== 1 ? 's' : ''} across all folders. Active sessions will not be affected.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (showArchiveAllDialog = false)}>Cancel</Button>
      <Button onclick={archiveAll}>Archive {archivableCount} session{archivableCount !== 1 ? 's' : ''}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={showHubDialog} onOpenChange={handleHubDialogOpenChange}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Create hub</Dialog.Title>
      <Dialog.Description>Creates a hub folder with symlinks to each member repository and an AGENTS.md naming the members.</Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-col gap-4">
      <Input
        bind:value={hubName}
        placeholder="Hub name"
        disabled={hubCreating}
        onkeydown={(e) => {
          if (e.key === 'Enter') void createHub();
        }}
      />

      <div class="flex flex-col gap-1.5">
        <div class="text-muted-foreground text-xs font-medium">Root folder</div>
        {#if folderStore.roots.length === 0}
          <div class="text-muted-foreground px-3 py-2 text-sm">No roots configured.</div>
        {:else}
          <div class="border-border max-h-36 overflow-y-auto rounded-md border">
            <div class="flex flex-col p-1">
              {#each folderStore.roots as root (root)}
                <button
                  class="hover:bg-accent hover:text-accent-foreground flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors {hubRoot === root
                    ? 'bg-accent text-accent-foreground'
                    : ''}"
                  disabled={hubCreating}
                  onclick={() => (hubRoot = root)}
                >
                  <FolderIcon class="text-muted-foreground size-4 shrink-0" />
                  <span class="min-w-0 flex-1 truncate">{root}</span>
                  {#if hubRoot === root}
                    <span class="text-primary size-2 shrink-0 rounded-full"></span>
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      <div class="flex flex-col gap-1.5">
        <div class="text-muted-foreground text-xs font-medium">Member repositories</div>
        {#if hubCandidateRepos.length === 0}
          <div class="text-muted-foreground px-3 py-2 text-sm">
            {#if folderStore.repos.length === 0}
              No repositories discovered yet.
            {:else}
              No available repositories — all discovered repos are missing on disk.
            {/if}
          </div>
        {:else}
          <div class="border-border max-h-60 overflow-y-auto rounded-md border">
            <div class="flex flex-col p-1">
              {#each hubCandidateRepos as repo (repo.path)}
                {@const selected = hubMembers.has(repo.path)}
                <button
                  class="hover:bg-accent hover:text-accent-foreground flex items-center gap-2 rounded-md px-3 py-2 text-left transition-colors {selected
                    ? 'bg-accent text-accent-foreground'
                    : ''}"
                  disabled={hubCreating}
                  onclick={() => toggleHubMember(repo.path)}
                >
                  <input type="checkbox" checked={selected} class="pointer-events-none" tabindex={-1} />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-medium">{repo.name}</div>
                    <div class="text-muted-foreground truncate text-xs">{repo.path}</div>
                  </div>
                  {#if repo.branch}
                    <span class="text-muted-foreground shrink-0 text-xs">{repo.branch}</span>
                  {/if}
                  <span class="size-1.5 shrink-0 rounded-full {repo.dirty ? 'bg-yellow-500' : 'bg-muted-foreground/40'}" title={repo.dirty ? 'Uncommitted changes' : 'Clean'}
                  ></span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      {#if hubError}
        <p class="text-destructive text-sm">{hubError}</p>
      {/if}

      <Dialog.Footer>
        <Button variant="outline" onclick={() => handleHubDialogOpenChange(false)} disabled={hubCreating}>Cancel</Button>
        <Button onclick={() => void createHub()} disabled={hubCreating || !hubName.trim() || !hubRoot || hubMembers.size === 0}>
          {#if hubCreating}
            <Loader2 class="size-4 animate-spin" />
            Creating…
          {:else}
            Create hub
          {/if}
        </Button>
      </Dialog.Footer>
    </div>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root
  open={disbandTarget !== null}
  onOpenChange={(open) => {
    if (!open) disbandTarget = null;
  }}
>
  <Dialog.Content showCloseButton={false}>
    <Dialog.Header>
      <Dialog.Title>Disband {disbandTarget ? displayName(disbandTarget) : ''}</Dialog.Title>
      <Dialog.Description>This deletes the hub folder and removes the hub from the list. Member repositories are not touched.</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (disbandTarget = null)}>Cancel</Button>
      <Button variant="destructive" onclick={disbandHub}>Disband</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
